import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { aggregateRequirements, craftPlan } from './plan.js';
import { aggregateRaw, buildTree } from './tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stepIndex(steps, itemId) {
  return steps.findIndex((step) => step.itemId === itemId);
}

describe('aggregateRequirements', () => {
  test('empty targets -> empty map, no throw', () => {
    const totals = aggregateRequirements({ wood: {} }, []);
    assert.equal(totals.size, 0);
  });

  test('sums every node (not just leaves) for a single target', () => {
    const items = {
      top: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'mid', qty: 2 }] },
      },
      mid: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'raw', qty: 3 }] },
      },
      raw: {},
    };
    const totals = aggregateRequirements(items, [{ itemId: 'top', qty: 5 }]);
    // top: qty 5. mid: 2*5=10. raw: 3*10=30. Every node counted, not just raw.
    assert.equal(totals.get('top'), 5);
    assert.equal(totals.get('mid'), 10);
    assert.equal(totals.get('raw'), 30);
  });

  test('merges a shared intermediate across two different targets', () => {
    const items = {
      arrow: {
        recipe: { stations: ['s'], yields: 10, ingredients: [{ item: 'shared', qty: 2 }] },
      },
      bow: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'shared', qty: 40 }] },
      },
      shared: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'raw', qty: 1 }] },
      },
      raw: {},
    };
    const totals = aggregateRequirements(items, [
      { itemId: 'arrow', qty: 1 },
      { itemId: 'bow', qty: 1 },
    ]);
    // arrow qty1 -> crafts ceil(1/10)=1 -> shared 2. bow qty1 -> crafts 1 -> shared 40.
    // Merged total: 42, in ONE map entry.
    assert.equal(totals.get('shared'), 42);
  });
});

describe('craftPlan', () => {
  test('empty targets -> empty steps/raw, no throw', () => {
    const plan = craftPlan({ wood: {} }, []);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.raw, []);
    assert.deepEqual(plan.targets, []);
  });

  test('unknown itemId is skipped safely (no throw, no phantom step/raw entry)', () => {
    assert.doesNotThrow(() => craftPlan({ known: {} }, [{ itemId: 'ghost', qty: 3 }]));
    const plan = craftPlan({ known: {} }, [{ itemId: 'ghost', qty: 3 }]);
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.raw, []);
  });

  test('unknown ingredient inside a real recipe is skipped safely', () => {
    const items = {
      thing: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'nonexistent', qty: 4 }] },
      },
    };
    assert.doesNotThrow(() => craftPlan(items, [{ itemId: 'thing', qty: 1 }]));
    const plan = craftPlan(items, [{ itemId: 'thing', qty: 1 }]);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].itemId, 'thing');
    assert.deepEqual(plan.raw, []); // nonexistent isn't a known item -> not shown
  });

  test('dependency ordering: an ingredient always appears before its dependent', () => {
    const items = {
      top: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'mid', qty: 1 }] },
      },
      mid: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'raw', qty: 1 }] },
      },
      raw: {},
    };
    const plan = craftPlan(items, [{ itemId: 'top', qty: 1 }]);
    const midIndex = stepIndex(plan.steps, 'mid');
    const topIndex = stepIndex(plan.steps, 'top');
    assert.ok(midIndex >= 0 && topIndex >= 0);
    assert.ok(midIndex < topIndex, 'mid (ingredient) must come before top (dependent)');
    // raw material never becomes a step
    assert.equal(stepIndex(plan.steps, 'raw'), -1);
  });

  test('shared intermediate across two targets collapses into ONE step with summed qty', () => {
    const items = {
      arrow: {
        recipe: { stations: ['s'], yields: 10, ingredients: [{ item: 'shared', qty: 2 }] },
      },
      bow: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'shared', qty: 40 }] },
      },
      shared: {
        recipe: { stations: ['bench'], yields: 1, ingredients: [{ item: 'raw', qty: 1 }] },
      },
      raw: {},
    };
    const plan = craftPlan(items, [
      { itemId: 'arrow', qty: 1 },
      { itemId: 'bow', qty: 1 },
    ]);
    const sharedSteps = plan.steps.filter((s) => s.itemId === 'shared');
    assert.equal(sharedSteps.length, 1, 'shared intermediate must appear exactly once');
    assert.equal(sharedSteps[0].qty, 42);
    assert.equal(sharedSteps[0].crafts, 42); // yields 1 -> crafts == qty

    // Both targets must come after the shared intermediate they depend on.
    const sharedIndex = stepIndex(plan.steps, 'shared');
    assert.ok(sharedIndex < stepIndex(plan.steps, 'arrow'));
    assert.ok(sharedIndex < stepIndex(plan.steps, 'bow'));
  });

  test('yields > 1 uses ceil for crafts (yields 10, need 15 -> 2 crafts)', () => {
    const items = {
      arrow: {
        recipe: { stations: ['s'], yields: 10, ingredients: [{ item: 'stick', qty: 1 }] },
      },
      stick: {},
    };
    const plan = craftPlan(items, [{ itemId: 'arrow', qty: 15 }]);
    const arrowStep = plan.steps.find((s) => s.itemId === 'arrow');
    assert.equal(arrowStep.qty, 15);
    assert.equal(arrowStep.crafts, 2); // ceil(15/10)
  });

  test('raw list excludes every craftable item', () => {
    const items = {
      top: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'mid', qty: 1 }] },
      },
      mid: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'raw', qty: 1 }] },
      },
      raw: {},
    };
    const plan = craftPlan(items, [{ itemId: 'top', qty: 1 }]);
    const rawIds = plan.raw.map((r) => r.itemId);
    assert.ok(!rawIds.includes('top'));
    assert.ok(!rawIds.includes('mid'));
    assert.ok(rawIds.includes('raw'));
  });

  test('raw list sorts qty descending', () => {
    const items = {
      top: {
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [
            { item: 'small', qty: 1 },
            { item: 'big', qty: 100 },
          ],
        },
      },
      small: {},
      big: {},
    };
    const plan = craftPlan(items, [{ itemId: 'top', qty: 1 }]);
    assert.deepEqual(
      plan.raw.map((r) => r.itemId),
      ['big', 'small'],
    );
  });

  test('cycle in data terminates and never produces a duplicate/infinite step', () => {
    const items = {
      a: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'b', qty: 1 }] },
      },
      b: {
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'a', qty: 1 }] },
      },
    };
    assert.doesNotThrow(() => craftPlan(items, [{ itemId: 'a', qty: 1 }]));
    const plan = craftPlan(items, [{ itemId: 'a', qty: 1 }]);
    // Each of a/b appears at most once as a step.
    assert.ok(plan.steps.filter((s) => s.itemId === 'a').length <= 1);
    assert.ok(plan.steps.filter((s) => s.itemId === 'b').length <= 1);
  });
});

describe('real data: Advanced Arrow (the user\'s own example)', () => {
  const dataPath = path.join(__dirname, '..', 'data', 'items.json');
  const { items } = JSON.parse(readFileSync(dataPath, 'utf8'));

  // Hand derivation from src/data/items.json (2026-07-27 scrape):
  //   advanced_arrow: yields 10, needs 2x plasteel + 5x carbon_fiber per craft.
  //   qty 1 -> crafts ceil(1/10) = 1 -> plasteel 2, carbon_fiber 5.
  //   plasteel: yields 1, needs 2x crude_oil + 5x ore per craft.
  //     qty 2 -> crafts 2 -> crude_oil 4, ore 10.
  //   carbon_fiber: yields 1, needs 2x coal + 1x flame_organ per craft.
  //     qty 5 -> crafts 5 -> coal 10, flame_organ 5.
  test('single target: exact step order and quantities', () => {
    const plan = craftPlan(items, [{ itemId: 'advanced_arrow', qty: 1 }]);

    assert.deepEqual(
      plan.steps.map((s) => s.itemId),
      ['plasteel', 'carbon_fiber', 'advanced_arrow'],
      'plasteel and carbon_fiber (ingredients) must both precede advanced_arrow (dependent)',
    );

    const [plasteelStep, carbonFiberStep, arrowStep] = plan.steps;
    assert.equal(plasteelStep.qty, 2);
    assert.equal(plasteelStep.crafts, 2);
    assert.equal(carbonFiberStep.qty, 5);
    assert.equal(carbonFiberStep.crafts, 5);
    assert.equal(arrowStep.qty, 1);
    assert.equal(arrowStep.crafts, 1);
    assert.equal(arrowStep.yields, 10);

    // Matches the user's own example verbatim: "1. craft 5x carbon fiber
    // 2. craft 2x plasteel" (order between the two independent siblings is
    // not semantically constrained — both are verified present with the
    // right qty, and both precede advanced_arrow).
    assert.equal(plan.steps.find((s) => s.itemId === 'carbon_fiber').qty, 5);
    assert.equal(plan.steps.find((s) => s.itemId === 'plasteel').qty, 2);

    const rawIds = plan.raw.map((r) => r.itemId).sort();
    assert.deepEqual(rawIds, ['coal', 'crude_oil', 'flame_organ', 'ore'].sort());
    assert.equal(plan.raw.find((r) => r.itemId === 'crude_oil').qty, 4);
    assert.equal(plan.raw.find((r) => r.itemId === 'ore').qty, 10);
    assert.equal(plan.raw.find((r) => r.itemId === 'coal').qty, 10);
    assert.equal(plan.raw.find((r) => r.itemId === 'flame_organ').qty, 5);

    // Sanity cross-check against the already-trusted tree.aggregateRaw for a
    // single target: raw totals must agree exactly with the leaf sums of the
    // plain buildTree.
    const crossCheck = aggregateRaw(buildTree(items, 'advanced_arrow', 1));
    for (const { itemId, qty } of plan.raw) {
      assert.equal(crossCheck.get(itemId), qty, `${itemId} raw total must match aggregateRaw`);
    }
  });

  test('yields > 1 with real data: 15x Advanced Arrow needs 2 crafts', () => {
    const plan = craftPlan(items, [{ itemId: 'advanced_arrow', qty: 15 }]);
    const arrowStep = plan.steps.find((s) => s.itemId === 'advanced_arrow');
    assert.equal(arrowStep.qty, 15);
    assert.equal(arrowStep.crafts, 2); // ceil(15/10)
    // Ingredients scale with crafts (2), not qty (15): plasteel 2*2=4, carbon_fiber 5*2=10.
    assert.equal(plan.steps.find((s) => s.itemId === 'plasteel').qty, 4);
    assert.equal(plan.steps.find((s) => s.itemId === 'carbon_fiber').qty, 10);
  });

  test('two targets sharing intermediates: Advanced Arrow + Advanced Bow merge plasteel/carbon_fiber', () => {
    // advanced_bow: yields 1, needs 40x plasteel + 25x carbon_fiber + 20x nightstar_sand.
    // Combined with advanced_arrow (qty 1, above):
    //   plasteel:     2 (arrow)  + 40 (bow) = 42
    //   carbon_fiber: 5 (arrow)  + 25 (bow) = 30
    const plan = craftPlan(items, [
      { itemId: 'advanced_arrow', qty: 1 },
      { itemId: 'advanced_bow', qty: 1 },
    ]);

    const plasteelSteps = plan.steps.filter((s) => s.itemId === 'plasteel');
    const carbonFiberSteps = plan.steps.filter((s) => s.itemId === 'carbon_fiber');
    assert.equal(plasteelSteps.length, 1, 'plasteel must be a single merged step');
    assert.equal(carbonFiberSteps.length, 1, 'carbon_fiber must be a single merged step');
    assert.equal(plasteelSteps[0].qty, 42);
    assert.equal(carbonFiberSteps[0].qty, 30);

    // Dependency order: both shared intermediates before both targets.
    const plasteelIdx = stepIndex(plan.steps, 'plasteel');
    const carbonFiberIdx = stepIndex(plan.steps, 'carbon_fiber');
    const arrowIdx = stepIndex(plan.steps, 'advanced_arrow');
    const bowIdx = stepIndex(plan.steps, 'advanced_bow');
    assert.ok(plasteelIdx < arrowIdx && plasteelIdx < bowIdx);
    assert.ok(carbonFiberIdx < arrowIdx && carbonFiberIdx < bowIdx);

    // Exact full order, hand-verified: shared intermediates first (plasteel,
    // carbon_fiber — dedup'd, so nightstar_sand for the bow contributes no
    // extra step since it's a raw material), then both targets.
    assert.deepEqual(plan.steps.map((s) => s.itemId), [
      'plasteel',
      'carbon_fiber',
      'advanced_arrow',
      'advanced_bow',
    ]);

    const rawIds = plan.raw.map((r) => r.itemId);
    assert.deepEqual(rawIds, ['ore', 'crude_oil', 'coal', 'flame_organ', 'nightstar_sand']);
    assert.equal(plan.raw.find((r) => r.itemId === 'ore').qty, 210);
    assert.equal(plan.raw.find((r) => r.itemId === 'crude_oil').qty, 84);
    assert.equal(plan.raw.find((r) => r.itemId === 'coal').qty, 60);
    assert.equal(plan.raw.find((r) => r.itemId === 'flame_organ').qty, 30);
    assert.equal(plan.raw.find((r) => r.itemId === 'nightstar_sand').qty, 20);
  });
});
