// Fixture-game regression guard (PLAN.md §9): a tiny synthetic dataset for a
// hypothetical non-Palworld game with NO tiers, NO progression numbers, and
// NO crafting stations at all — the exact shape a Minecraft/NMS port would
// start from. Every pure-logic module in src/lib/ must handle it cleanly:
// no crash, and every "optional feature" (tier chips, progression sort,
// variant switcher, station chip) resolves to its empty/hidden case rather
// than showing a broken or meaningless control.
//
// This is deliberately NOT real game data under src/data/ — it's a fixture
// that exists only to prove the engine has no Palworld-shaped assumptions
// baked in, per the task spec ("put fixtures in a test file, not in
// src/data/").

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildTree, aggregateRaw, collapsiblePaths } from './tree.js';
import { craftPlan } from './plan.js';
import {
  groupVariants,
  variantGroupMembers,
  filterEntries,
  deriveCategories,
  deriveTiers,
  deriveStations,
  deriveSorts,
} from './filter.js';
import { findTier, tierColor, tierBadgeClass, tierBorderClass } from './tier.js';

// A minimal manifest for this fixture game: no `tiers`, no `sorts` beyond the
// universal name/category — modeling a game with literally no rarity concept
// and no progression-gated unlocks (a bare crafting list).
const FIXTURE_MANIFEST = {
  id: 'fixture',
  name: 'Fixture Game',
  tagline: 'A minimal crafting game with no tiers, progression, or stations',
  assetBase: 'games/fixture/',
  labels: { station: 'station', stationPlural: 'stations', tier: 'tier', progression: 'progression' },
  // No `tiers` key at all.
  sorts: ['name', 'category', 'tier', 'progression'],
};

// A handful of items: two craftable, two raw. No `tier`, no `progression`,
// no `recipe.stations` (empty array — "no crafting station" concept), no
// `variantGroup`.
function fixtureItems() {
  return {
    plank: {
      name: 'Plank',
      category: 'material',
      recipe: { stations: [], yields: 4, ingredients: [{ item: 'log', qty: 1 }] },
    },
    stick: {
      name: 'Stick',
      category: 'material',
      recipe: { stations: [], yields: 2, ingredients: [{ item: 'plank', qty: 1 }] },
    },
    log: { name: 'Log', category: 'raw' },
    pebble: { name: 'Pebble', category: 'raw' },
  };
}

describe('fixture game: tree.js', () => {
  test('buildTree works with no tier/progression/variantGroup/stations fields anywhere', () => {
    const items = fixtureItems();
    assert.doesNotThrow(() => buildTree(items, 'stick', 3));
    const node = buildTree(items, 'stick', 3);
    // yields 2, need 3 -> 2 crafts
    assert.equal(node.crafts, 2);
    assert.deepEqual(node.stations, []); // "no stations" recipe still degrades to an array, not null
    assert.equal(node.children[0].itemId, 'plank');
  });

  test('aggregateRaw / collapsiblePaths still work end to end', () => {
    const items = fixtureItems();
    const tree = buildTree(items, 'stick', 3);
    const totals = aggregateRaw(tree);
    assert.ok(totals.get('log') > 0);
    assert.doesNotThrow(() => collapsiblePaths(tree));
  });
});

describe('fixture game: plan.js', () => {
  test('craftPlan produces steps + a raw shopping list with no tier/progression data', () => {
    const items = fixtureItems();
    const plan = craftPlan(items, [{ itemId: 'stick', qty: 5 }]);
    const stepIds = plan.steps.map((s) => s.itemId);
    assert.ok(stepIds.includes('plank'));
    assert.ok(stepIds.includes('stick'));
    assert.ok(plan.raw.some((r) => r.itemId === 'log'));
  });
});

describe('fixture game: filter.js derive* — every optional control disappears', () => {
  const items = fixtureItems();

  test('deriveTiers returns [] — the tier chip row has nothing to render', () => {
    assert.deepEqual(deriveTiers(items, FIXTURE_MANIFEST.tiers ?? []), []);
  });

  test('deriveStations returns [] — the station dropdown has nothing to render', () => {
    const stations = {}; // fixture game ships no stations.json at all
    assert.deepEqual(deriveStations(items, stations), []);
  });

  test('deriveSorts drops both tier and progression — only name/category remain', () => {
    const sorts = deriveSorts(items, FIXTURE_MANIFEST);
    assert.deepEqual(Object.keys(sorts), ['name', 'category']);
  });

  test('deriveCategories still works normally (categories are not an optional concept)', () => {
    assert.deepEqual(deriveCategories(items), ['material', 'raw']);
  });

  test('groupVariants: every item is its own single-variant entry (no variantGroup anywhere)', () => {
    const entries = groupVariants(items, FIXTURE_MANIFEST.tiers ?? []);
    assert.equal(entries.length, Object.keys(items).length);
    assert.ok(entries.every((e) => e.isVariantGroup === false));
  });

  test('variantGroupMembers on a group id nothing belongs to returns nothing to switch between', () => {
    assert.deepEqual(variantGroupMembers(items, 'nonexistent-group', []), []);
  });

  test('filterEntries with a tier filter set is a safe no-op match (no item has any tier)', () => {
    const entries = groupVariants(items, []);
    const filtered = filterEntries(entries, { tier: 'anything' });
    assert.deepEqual(filtered, []); // correctly excludes everything — no item has that tier
    assert.deepEqual(filterEntries(entries, {}), entries); // omitted filter is a no-op
  });
});

describe('fixture game: tier.js — color/border helpers never throw on absent tier data', () => {
  test('findTier / tierColor return null when the manifest has no tiers', () => {
    assert.equal(findTier(undefined, 'common'), null);
    assert.equal(findTier([], 'common'), null);
    assert.equal(tierColor([], undefined), null);
  });

  test('tierBadgeClass/tierBorderClass fall back to the gray default instead of throwing', () => {
    assert.doesNotThrow(() => tierBadgeClass(null));
    assert.doesNotThrow(() => tierBorderClass(undefined));
    assert.equal(tierBadgeClass(null), tierBadgeClass('gray'));
  });
});
