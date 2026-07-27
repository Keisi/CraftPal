import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  groupFamilies,
  familyVariants,
  matchesSearch,
  textFilter,
  categoryFilter,
  rarityFilter,
  craftableFilter,
  stationFilter,
  filterEntries,
  compareByName,
  compareByCategory,
  compareByRarity,
  compareByTechLevel,
  deriveCategories,
  deriveRarities,
  deriveStations,
} from './filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A small synthetic dataset covering: a multi-variant family, a single-member
// "family" (edge case), and plain non-family items across categories/rarities/
// stations/techLevels (including a missing techLevel).
function sampleItems() {
  return {
    sword: {
      name: 'Sword',
      category: 'weapon',
      rarity: 'common',
      family: 'sword',
      techLevel: 10,
      recipe: { stations: ['bench'], yields: 1, ingredients: [{ item: 'wood', qty: 2 }] },
    },
    sword_legendary: {
      name: 'Sword (Legendary)',
      category: 'weapon',
      rarity: 'legendary',
      family: 'sword',
      recipe: { stations: ['forge'], yields: 1, ingredients: [{ item: 'wood', qty: 8 }] },
    },
    sword_rare: {
      name: 'Sword (Rare)',
      category: 'weapon',
      rarity: 'rare',
      family: 'sword',
      recipe: { stations: ['bench', 'forge'], yields: 1, ingredients: [{ item: 'wood', qty: 4 }] },
    },
    lonely_variant: {
      name: 'Lonely Variant',
      category: 'armor',
      rarity: 'uncommon',
      family: 'lonely', // only member of this family — should NOT be treated as a group
    },
    wood: { name: 'Wood', category: 'material', rarity: 'common' },
    shield: {
      name: 'Shield',
      category: 'armor',
      rarity: 'epic',
      techLevel: 25,
      recipe: { stations: ['forge'], yields: 1, ingredients: [{ item: 'wood', qty: 3 }] },
    },
    potion: { name: 'Potion', category: 'consumable', rarity: 'uncommon' }, // no techLevel, not craftable
  };
}

describe('groupFamilies', () => {
  test('groups same-family items into one entry keyed by the lowest-rarity variant', () => {
    const entries = groupFamilies(sampleItems());
    const swordGroup = entries.find((e) => e.family === 'sword');

    assert.ok(swordGroup);
    assert.equal(swordGroup.id, 'sword'); // common is lowest rarity
    assert.equal(swordGroup.isFamily, true);
    assert.deepEqual(
      swordGroup.variants.map((v) => v.id),
      ['sword', 'sword_rare', 'sword_legendary'], // rarity-ascending
    );
  });

  test('a family with a single surviving member is not treated as a group', () => {
    const entries = groupFamilies(sampleItems());
    const lonely = entries.find((e) => e.id === 'lonely_variant');

    assert.ok(lonely);
    assert.equal(lonely.isFamily, false);
    assert.equal(lonely.variants.length, 1);
  });

  test('plain non-family items become single-variant entries', () => {
    const entries = groupFamilies(sampleItems());
    const wood = entries.find((e) => e.id === 'wood');

    assert.equal(wood.family, null);
    assert.equal(wood.isFamily, false);
    assert.deepEqual(wood.variants, [{ id: 'wood', item: sampleItems().wood }]);
  });

  test('total entry count collapses each family to one entry', () => {
    const entries = groupFamilies(sampleItems());
    // 7 raw items -> sword family (3->1) + lonely (1->1) + wood + shield + potion = 5 entries
    assert.equal(entries.length, 5);
  });
});

describe('familyVariants', () => {
  test('returns every member of a family, rarity-ascending', () => {
    const variants = familyVariants(sampleItems(), 'sword');
    assert.deepEqual(
      variants.map((v) => v.id),
      ['sword', 'sword_rare', 'sword_legendary'],
    );
  });

  test('unknown family id returns an empty list', () => {
    assert.deepEqual(familyVariants(sampleItems(), 'nonexistent'), []);
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

describe('filters (entry-level, family matches if ANY variant matches)', () => {
  const entries = groupFamilies(sampleItems());

  test('textFilter matches a family by a non-base variant name', () => {
    const filtered = entries.filter(textFilter('legendary'));
    assert.deepEqual(filtered.map((e) => e.id), ['sword']); // group keyed by base id
  });

  test('categoryFilter', () => {
    const filtered = entries.filter(categoryFilter('armor'));
    assert.deepEqual(new Set(filtered.map((e) => e.id)), new Set(['lonely_variant', 'shield']));
  });

  test('rarityFilter matches a family group when only a non-base variant has that rarity', () => {
    const filtered = entries.filter(rarityFilter('legendary'));
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

  test('stationFilter matches a family group via a variant craftable at a different station', () => {
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

describe('filterEntries', () => {
  test('combines all filters (AND) over a partial filter-state object', () => {
    const entries = groupFamilies(sampleItems());
    const result = filterEntries(entries, { category: 'weapon', craftableOnly: true });
    assert.deepEqual(result.map((e) => e.id), ['sword']);
  });

  test('empty filter object returns every entry unchanged', () => {
    const entries = groupFamilies(sampleItems());
    assert.equal(filterEntries(entries, {}).length, entries.length);
    assert.equal(filterEntries(entries).length, entries.length);
  });

  test('no matches yields an empty array', () => {
    const entries = groupFamilies(sampleItems());
    const result = filterEntries(entries, { search: 'nonexistent-item-xyz' });
    assert.deepEqual(result, []);
  });
});

describe('sort comparators', () => {
  const entries = groupFamilies(sampleItems());

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

  test('compareByRarity orders common < uncommon < rare < epic < legendary', () => {
    const sorted = [...entries].sort(compareByRarity).map((e) => e.item.rarity);
    const rank = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(rank[sorted[i - 1]] <= rank[sorted[i]], `${sorted[i - 1]} should sort before ${sorted[i]}`);
    }
  });

  test('compareByTechLevel sorts ascending with missing techLevel last', () => {
    const sorted = [...entries].sort(compareByTechLevel);
    const levels = sorted.map((e) => e.item.techLevel);
    const definedLevels = levels.filter((l) => l != null);
    const expectedDefined = [...definedLevels].sort((a, b) => a - b);
    assert.deepEqual(definedLevels, expectedDefined);
    // All undefined/missing techLevels trail the defined ones.
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

  test('deriveRarities returns only rarities present, in canonical tier order', () => {
    // sample has common, uncommon, rare, epic, legendary all present
    assert.deepEqual(deriveRarities(sampleItems()), ['common', 'uncommon', 'rare', 'epic', 'legendary']);
  });

  test('deriveRarities omits tiers absent from the data', () => {
    const items = { a: { name: 'A', rarity: 'common' }, b: { name: 'B', rarity: 'epic' } };
    assert.deepEqual(deriveRarities(items), ['common', 'epic']);
  });

  test('deriveStations lists only stations referenced by a recipe, sorted by tech level', () => {
    const stations = {
      bench: { name: 'Bench', techLevel: 5 },
      forge: { name: 'Forge', techLevel: 15 },
      unused_station: { name: 'Unused', techLevel: 1 },
    };
    const derived = deriveStations(sampleItems(), stations);
    assert.deepEqual(derived.map((s) => s.id), ['bench', 'forge']);
    assert.ok(derived.every((s, i) => i === 0 || s.techLevel >= derived[i - 1].techLevel));
  });

  test('deriveStations falls back to the id and undefined techLevel for an unresolvable station', () => {
    const items = {
      x: { name: 'X', recipe: { stations: ['ghost_station'], yields: 1, ingredients: [] } },
    };
    const derived = deriveStations(items, {});
    assert.deepEqual(derived, [{ id: 'ghost_station', name: 'ghost_station', techLevel: undefined }]);
  });
});

describe('real data: assault_rifle family (sample dataset)', () => {
  const dataPath = path.join(__dirname, '..', 'data', 'items.json');
  const { items } = JSON.parse(readFileSync(dataPath, 'utf8'));

  test('groupFamilies collapses the 5 assault_rifle rarity variants into one entry', () => {
    const entries = groupFamilies(items);
    const rifle = entries.find((e) => e.family === 'assault_rifle');
    assert.ok(rifle);
    assert.equal(rifle.id, 'assault_rifle'); // common is the base variant
    assert.deepEqual(
      rifle.variants.map((v) => v.item.rarity),
      ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    );
  });

  test('rarity filter on "legendary" still surfaces the assault_rifle group', () => {
    const entries = groupFamilies(items);
    const filtered = filterEntries(entries, { rarity: 'legendary' });
    assert.ok(filtered.some((e) => e.id === 'assault_rifle'));
  });

  test('deriveCategories/deriveRarities/deriveStations resolve against the real sample data', () => {
    const categories = deriveCategories(items);
    assert.ok(categories.includes('weapon'));
    assert.ok(categories.includes('material'));

    const rarities = deriveRarities(items);
    assert.deepEqual(rarities, ['common', 'uncommon', 'rare', 'epic', 'legendary']);
  });
});
