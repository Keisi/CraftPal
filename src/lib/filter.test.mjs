import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  groupVariants,
  variantGroupMembers,
  matchesSearch,
  textFilter,
  categoryFilter,
  tierFilter,
  craftableFilter,
  stationFilter,
  filterEntries,
  compareByName,
  compareByCategory,
  compareByTier,
  compareByProgression,
  deriveCategories,
  deriveTiers,
  deriveStations,
  deriveSorts,
} from './filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Palworld's 5-tier ladder, expressed the way a real manifest (game.json)
// would — this test file exercises the general (tiers-as-data) API, not a
// hardcoded ladder.
const TIERS = [
  { id: 'common', label: 'Common', color: 'gray' },
  { id: 'uncommon', label: 'Uncommon', color: 'green' },
  { id: 'rare', label: 'Rare', color: 'blue' },
  { id: 'epic', label: 'Epic', color: 'purple' },
  { id: 'legendary', label: 'Legendary', color: 'amber' },
];

// A small synthetic dataset covering: a multi-variant group, a single-member
// "group" (edge case), and plain non-grouped items across categories/tiers/
// stations/progressions (including a missing progression).
function sampleItems() {
  return {
    sword: {
      name: 'Sword',
      category: 'weapon',
      tier: 'common',
      variantGroup: 'sword',
      progression: 10,
      recipes: [{ stations: ['bench'], yields: 1, ingredients: [{ item: 'wood', qty: 2 }] }],
    },
    sword_legendary: {
      name: 'Sword (Legendary)',
      category: 'weapon',
      tier: 'legendary',
      variantGroup: 'sword',
      recipes: [{ stations: ['forge'], yields: 1, ingredients: [{ item: 'wood', qty: 8 }] }],
    },
    sword_rare: {
      name: 'Sword (Rare)',
      category: 'weapon',
      tier: 'rare',
      variantGroup: 'sword',
      recipes: [{ stations: ['bench', 'forge'], yields: 1, ingredients: [{ item: 'wood', qty: 4 }] }],
    },
    lonely_variant: {
      name: 'Lonely Variant',
      category: 'armor',
      tier: 'uncommon',
      variantGroup: 'lonely', // only member of this group — should NOT be treated as a group
    },
    wood: { name: 'Wood', category: 'material', tier: 'common' },
    shield: {
      name: 'Shield',
      category: 'armor',
      tier: 'epic',
      progression: 25,
      recipes: [{ stations: ['forge'], yields: 1, ingredients: [{ item: 'wood', qty: 3 }] }],
    },
    potion: { name: 'Potion', category: 'consumable', tier: 'uncommon' }, // no progression, not craftable
  };
}

describe('groupVariants', () => {
  test('groups same-variantGroup items into one entry keyed by the lowest-tier variant', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    const swordGroup = entries.find((e) => e.variantGroup === 'sword');

    assert.ok(swordGroup);
    assert.equal(swordGroup.id, 'sword'); // common is lowest tier
    assert.equal(swordGroup.isVariantGroup, true);
    assert.deepEqual(
      swordGroup.variants.map((v) => v.id),
      ['sword', 'sword_rare', 'sword_legendary'], // tier-ascending
    );
  });

  test('a variantGroup with a single surviving member is not treated as a group', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    const lonely = entries.find((e) => e.id === 'lonely_variant');

    assert.ok(lonely);
    assert.equal(lonely.isVariantGroup, false);
    assert.equal(lonely.variants.length, 1);
  });

  test('plain non-grouped items become single-variant entries', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    const wood = entries.find((e) => e.id === 'wood');

    assert.equal(wood.variantGroup, null);
    assert.equal(wood.isVariantGroup, false);
    assert.deepEqual(wood.variants, [{ id: 'wood', item: sampleItems().wood }]);
  });

  test('total entry count collapses each group to one entry', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    // 7 raw items -> sword group (3->1) + lonely (1->1) + wood + shield + potion = 5 entries
    assert.equal(entries.length, 5);
  });

  test('an empty/omitted tiers list still groups (order falls back to insertion order)', () => {
    const entries = groupVariants(sampleItems());
    const swordGroup = entries.find((e) => e.variantGroup === 'sword');
    assert.ok(swordGroup);
    assert.equal(swordGroup.variants.length, 3);
  });
});

describe('variantGroupMembers', () => {
  test('returns every member of a group, tier-ascending', () => {
    const variants = variantGroupMembers(sampleItems(), 'sword', TIERS);
    assert.deepEqual(
      variants.map((v) => v.id),
      ['sword', 'sword_rare', 'sword_legendary'],
    );
  });

  test('unknown group id returns an empty list', () => {
    assert.deepEqual(variantGroupMembers(sampleItems(), 'nonexistent', TIERS), []);
  });
});

describe('matchesSearch', () => {
  test('is case-insensitive and substring-based', () => {
    assert.equal(matchesSearch({ name: 'Assault Rifle' }, 'assault'), true);
    assert.equal(matchesSearch({ name: 'Assault Rifle' }, 'RIFLE'), true);
    assert.equal(matchesSearch({ name: 'Assault Rifle' }, 'sword'), false);
  });

  test('empty/whitespace query matches everything', () => {
    assert.equal(matchesSearch({ name: 'Anything' }, ''), true);
    assert.equal(matchesSearch({ name: 'Anything' }, '   '), true);
    assert.equal(matchesSearch({ name: 'Anything' }, undefined), true);
  });
});

describe('filters (entry-level, group matches if ANY variant matches)', () => {
  const entries = groupVariants(sampleItems(), TIERS);

  test('textFilter matches a group by a non-base variant name', () => {
    const filtered = entries.filter(textFilter('legendary'));
    assert.deepEqual(filtered.map((e) => e.id), ['sword']); // group keyed by base id
  });

  test('categoryFilter', () => {
    const filtered = entries.filter(categoryFilter('armor'));
    assert.deepEqual(new Set(filtered.map((e) => e.id)), new Set(['lonely_variant', 'shield']));
  });

  test('tierFilter matches a group when only a non-base variant has that tier', () => {
    const filtered = entries.filter(tierFilter('legendary'));
    assert.deepEqual(filtered.map((e) => e.id), ['sword']);
  });

  test('craftableFilter excludes items with no recipe', () => {
    const filtered = entries.filter(craftableFilter(true));
    const ids = filtered.map((e) => e.id);
    assert.ok(ids.includes('sword'));
    assert.ok(ids.includes('shield'));
    assert.ok(!ids.includes('wood'));
    assert.ok(!ids.includes('potion'));
  });

  test('craftableFilter(false) is a no-op', () => {
    assert.equal(entries.filter(craftableFilter(false)).length, entries.length);
  });

  test('stationFilter matches a group via a variant craftable at a different station', () => {
    // sword (common) only lists "bench"; sword_legendary only lists "forge".
    const filtered = entries.filter(stationFilter('forge'));
    const ids = filtered.map((e) => e.id);
    assert.ok(ids.includes('sword')); // via sword_legendary/sword_rare
    assert.ok(ids.includes('shield'));
    assert.ok(!ids.includes('wood'));
  });

  test('falsy filter value is a no-op', () => {
    assert.equal(entries.filter(categoryFilter(undefined)).length, entries.length);
    assert.equal(entries.filter(stationFilter('')).length, entries.length);
  });
});

describe('schema v3 axis 2: recipes[] (multi-recipe items)', () => {
  function multiRecipeItems() {
    return {
      // Two complete recipes for the same item, at two different stations —
      // the Minecraft "crafting table OR stonecutter" shape.
      slab: {
        name: 'Slab',
        category: 'block',
        recipes: [
          { stations: ['crafting_table'], yields: 6, ingredients: [{ item: 'stone', qty: 3 }] },
          { stations: ['stonecutter'], yields: 2, ingredients: [{ item: 'stone', qty: 1 }] },
        ],
      },
      stone: { name: 'Stone', category: 'material' },
    };
  }

  test('craftableFilter counts an item with any recipes[] entry', () => {
    const entries = groupVariants(multiRecipeItems());
    const filtered = entries.filter(craftableFilter(true));
    assert.deepEqual(filtered.map((e) => e.id).sort(), ['slab']);
  });

  test('stationFilter matches via a NON-primary recipe (recipes[1]), not just recipes[0]', () => {
    const entries = groupVariants(multiRecipeItems());
    const viaStonecutter = entries.filter(stationFilter('stonecutter'));
    assert.deepEqual(viaStonecutter.map((e) => e.id), ['slab']);
    const viaCraftingTable = entries.filter(stationFilter('crafting_table'));
    assert.deepEqual(viaCraftingTable.map((e) => e.id), ['slab']);
  });

  test('deriveStations lists stations from EVERY recipe of a multi-recipe item, not just the primary', () => {
    const stations = {
      crafting_table: { name: 'Crafting Table' },
      stonecutter: { name: 'Stonecutter' },
    };
    const derived = deriveStations(multiRecipeItems(), stations);
    assert.deepEqual(
      derived.map((s) => s.id).sort(),
      ['crafting_table', 'stonecutter'],
    );
  });
});

describe('filterEntries', () => {
  test('combines all filters (AND) over a partial filter-state object', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    const result = filterEntries(entries, { category: 'weapon', craftableOnly: true });
    assert.deepEqual(result.map((e) => e.id), ['sword']);
  });

  test('empty filter object returns every entry unchanged', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    assert.equal(filterEntries(entries, {}).length, entries.length);
    assert.equal(filterEntries(entries).length, entries.length);
  });

  test('no matches yields an empty array', () => {
    const entries = groupVariants(sampleItems(), TIERS);
    const result = filterEntries(entries, { search: 'nonexistent-item-xyz' });
    assert.deepEqual(result, []);
  });
});

describe('sort comparators', () => {
  const entries = groupVariants(sampleItems(), TIERS);

  test('compareByName sorts alphabetically', () => {
    const names = [...entries].sort(compareByName).map((e) => e.item.name);
    const expected = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, expected);
  });

  test('compareByCategory groups categories together, name as tiebreaker', () => {
    const sorted = [...entries].sort(compareByCategory);
    const categories = sorted.map((e) => e.item.category);
    const expectedOrder = [...categories].sort();
    assert.deepEqual(categories, expectedOrder);
  });

  test('compareByTier(tiers) orders common < uncommon < rare < epic < legendary', () => {
    const sorted = [...entries].sort(compareByTier(TIERS)).map((e) => e.item.tier);
    const rank = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(rank[sorted[i - 1]] <= rank[sorted[i]], `${sorted[i - 1]} should sort before ${sorted[i]}`);
    }
  });

  test('compareByTier with an empty tiers list falls back to name order (no crash)', () => {
    assert.doesNotThrow(() => [...entries].sort(compareByTier([])));
    assert.doesNotThrow(() => [...entries].sort(compareByTier()));
  });

  test('compareByProgression sorts ascending with missing progression last', () => {
    const sorted = [...entries].sort(compareByProgression);
    const levels = sorted.map((e) => e.item.progression);
    const definedLevels = levels.filter((l) => l != null);
    const expectedDefined = [...definedLevels].sort((a, b) => a - b);
    assert.deepEqual(definedLevels, expectedDefined);
    // All undefined/missing progressions trail the defined ones.
    const firstMissingIndex = levels.findIndex((l) => l == null);
    if (firstMissingIndex !== -1) {
      assert.ok(levels.slice(firstMissingIndex).every((l) => l == null));
    }
  });
});

describe('derive* option lists (must reflect the loaded data, never hardcoded)', () => {
  test('deriveCategories returns only categories present, alphabetical', () => {
    assert.deepEqual(deriveCategories(sampleItems()), ['armor', 'consumable', 'material', 'weapon']);
  });

  test('deriveTiers returns only tier DEFS present, in manifest order', () => {
    // sample has common, uncommon, rare, epic, legendary all present
    assert.deepEqual(
      deriveTiers(sampleItems(), TIERS).map((t) => t.id),
      ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    );
  });

  test('deriveTiers omits tiers absent from the data', () => {
    const items = { a: { name: 'A', tier: 'common' }, b: { name: 'B', tier: 'epic' } };
    assert.deepEqual(
      deriveTiers(items, TIERS).map((t) => t.id),
      ['common', 'epic'],
    );
  });

  test('deriveTiers returns [] for a dataset/manifest with no tiers at all', () => {
    const items = { a: { name: 'A' }, b: { name: 'B' } };
    assert.deepEqual(deriveTiers(items, []), []);
    assert.deepEqual(deriveTiers(items), []);
  });

  test('deriveStations lists only stations referenced by a recipe, sorted by progression', () => {
    const stations = {
      bench: { name: 'Bench', progression: 5 },
      forge: { name: 'Forge', progression: 15 },
      unused_station: { name: 'Unused', progression: 1 },
    };
    const derived = deriveStations(sampleItems(), stations);
    assert.deepEqual(derived.map((s) => s.id), ['bench', 'forge']);
    assert.ok(derived.every((s, i) => i === 0 || s.progression >= derived[i - 1].progression));
  });

  test('deriveStations falls back to the id and undefined progression for an unresolvable station', () => {
    const items = {
      x: { name: 'X', recipes: [{ stations: ['ghost_station'], yields: 1, ingredients: [] }] },
    };
    const derived = deriveStations(items, {});
    assert.deepEqual(derived, [{ id: 'ghost_station', name: 'ghost_station', progression: undefined }]);
  });

  test('deriveStations returns [] for a dataset with no recipes/stations at all', () => {
    const items = { a: { name: 'A' }, b: { name: 'B' } };
    assert.deepEqual(deriveStations(items, {}), []);
  });
});

describe('deriveSorts', () => {
  test('offers name/category/tier/progression, in the manifest sorts order, when the data has all of them', () => {
    const manifest = { sorts: ['name', 'category', 'tier', 'progression'], tiers: TIERS, labels: { tier: 'rarity', progression: 'Tech level' } };
    const sorts = deriveSorts(sampleItems(), manifest);
    assert.deepEqual(Object.keys(sorts), ['name', 'category', 'tier', 'progression']);
    assert.equal(sorts.tier.label, 'Rarity');
    assert.equal(sorts.progression.label, 'Tech level');
  });

  test('drops the tier sort when the data has no tiers', () => {
    const items = { a: { name: 'A', category: 'x' }, b: { name: 'B', category: 'y' } };
    const manifest = { sorts: ['name', 'category', 'tier', 'progression'], tiers: TIERS };
    const sorts = deriveSorts(items, manifest);
    assert.deepEqual(Object.keys(sorts), ['name', 'category']);
  });

  test('drops the progression sort when no item has a progression number', () => {
    const items = { a: { name: 'A', tier: 'common' }, b: { name: 'B', tier: 'epic' } };
    const manifest = { sorts: ['name', 'tier', 'progression'], tiers: TIERS };
    const sorts = deriveSorts(items, manifest);
    assert.deepEqual(Object.keys(sorts), ['name', 'tier']);
  });

  test('a manifest with no sorts/tiers at all still offers name + category', () => {
    const items = { a: { name: 'A', category: 'x' }, b: { name: 'B', category: 'y' } };
    const sorts = deriveSorts(items, {});
    assert.deepEqual(Object.keys(sorts), ['name', 'category']);
  });

  test('name is always present even if a manifest omits it from `sorts`', () => {
    const items = { a: { name: 'A' } };
    const sorts = deriveSorts(items, { sorts: ['category'] });
    assert.ok(sorts.name);
  });
});

describe('real data: assault_rifle variant group (Palworld dataset)', () => {
  const dataPath = path.join(__dirname, '..', 'data', 'palworld', 'items.json');
  const { items } = JSON.parse(readFileSync(dataPath, 'utf8'));
  const { tiers } = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'palworld', 'game.json'), 'utf8'));

  test('groupVariants collapses the 5 assault_rifle tier variants into one entry', () => {
    const entries = groupVariants(items, tiers);
    const rifle = entries.find((e) => e.variantGroup === 'assault_rifle');
    assert.ok(rifle);
    assert.equal(rifle.id, 'assault_rifle'); // common is the base variant
    assert.deepEqual(
      rifle.variants.map((v) => v.item.tier),
      ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    );
  });

  test('tier filter on "legendary" still surfaces the assault_rifle group', () => {
    const entries = groupVariants(items, tiers);
    const filtered = filterEntries(entries, { tier: 'legendary' });
    assert.ok(filtered.some((e) => e.id === 'assault_rifle'));
  });

  test('deriveCategories/deriveTiers/deriveStations resolve against the real Palworld data', () => {
    const categories = deriveCategories(items);
    assert.ok(categories.includes('weapon'));
    assert.ok(categories.includes('material'));

    const derivedTiers = deriveTiers(items, tiers);
    assert.deepEqual(
      derivedTiers.map((t) => t.id),
      ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    );
  });
});
