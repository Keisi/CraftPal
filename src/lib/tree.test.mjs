import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildTree, aggregateRaw, collapsiblePaths, childPath, ROOT_PATH } from './tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('buildTree', () => {
  test('raw material (no recipes) produces a leaf node', () => {
    const items = {
      wood: { name: 'Wood' },
    };
    const node = buildTree(items, 'wood', 5);
    assert.deepEqual(node, {
      itemId: 'wood',
      qty: 5,
      crafts: 0,
      stations: null,
      yields: null,
      children: [],
    });
  });

  test('a present-but-empty recipes array is treated as a leaf (defensive — validate-data.mjs hard-errors on this, never trusted blindly)', () => {
    const items = { ghost_recipe: { recipes: [] } };
    const node = buildTree(items, 'ghost_recipe', 3);
    assert.equal(node.crafts, 0);
    assert.equal(node.stations, null);
    assert.deepEqual(node.children, []);
  });

  test('single-level recipe computes crafts and scaled ingredient qty', () => {
    const items = {
      widget: {
        recipes: [
          {
            stations: ['bench'],
            yields: 1,
            ingredients: [{ item: 'ore', qty: 3 }],
          },
        ],
      },
      ore: {},
    };
    const node = buildTree(items, 'widget', 2);
    assert.equal(node.crafts, 2);
    assert.deepEqual(node.stations, ['bench']);
    assert.equal(node.yields, 1);
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].itemId, 'ore');
    assert.equal(node.children[0].qty, 6); // 3 * 2 crafts
    assert.equal(node.children[0].crafts, 0);
    assert.equal(node.children[0].stations, null);
    assert.deepEqual(node.children[0].children, []);
  });

  test('yields > 1: recipe yields 3, need 4 -> crafts = 2, ingredients scale by crafts', () => {
    const items = {
      batch_item: {
        recipes: [
          {
            stations: ['bench'],
            yields: 3,
            ingredients: [{ item: 'raw', qty: 5 }],
          },
        ],
      },
      raw: {},
    };
    const node = buildTree(items, 'batch_item', 4);
    assert.equal(node.crafts, 2); // ceil(4/3) = 2
    assert.equal(node.yields, 3);
    assert.equal(node.children[0].qty, 10); // 5 * 2
  });

  test('multi-level nesting multiplies quantities correctly down the chain', () => {
    const items = {
      top: {
        recipes: [
          {
            stations: ['s1'],
            yields: 1,
            ingredients: [{ item: 'mid', qty: 2 }],
          },
        ],
      },
      mid: {
        recipes: [
          {
            stations: ['s2'],
            yields: 1,
            ingredients: [{ item: 'bottom', qty: 3 }],
          },
        ],
      },
      bottom: {},
    };
    const node = buildTree(items, 'top', 5);
    assert.equal(node.crafts, 5); // ceil(5/1)
    const mid = node.children[0];
    assert.equal(mid.qty, 10); // 2 * 5
    assert.equal(mid.crafts, 10); // ceil(10/1)
    const bottom = mid.children[0];
    assert.equal(bottom.qty, 30); // 3 * 10
    assert.equal(bottom.crafts, 0);
    assert.deepEqual(bottom.children, []);
  });

  test('cycle in data terminates and the cycle node becomes a leaf', () => {
    const items = {
      a: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'b', qty: 1 }],
          },
        ],
      },
      b: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'a', qty: 1 }],
          },
        ],
      },
    };
    const node = buildTree(items, 'a', 1);
    // a -> b -> a(cycle, leaf)
    const b = node.children[0];
    assert.equal(b.itemId, 'b');
    assert.equal(b.children.length, 1);
    const cycleA = b.children[0];
    assert.deepEqual(cycleA, {
      itemId: 'a',
      qty: 1,
      crafts: 0,
      stations: null,
      yields: null,
      children: [],
    });
  });

  test('unknown ingredient id resolves to a leaf without throwing', () => {
    const items = {
      thing: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'nonexistent', qty: 4 }],
          },
        ],
      },
    };
    assert.doesNotThrow(() => buildTree(items, 'thing', 1));
    const node = buildTree(items, 'thing', 1);
    const child = node.children[0];
    assert.deepEqual(child, {
      itemId: 'nonexistent',
      qty: 4,
      crafts: 0,
      stations: null,
      yields: null,
      children: [],
    });
  });

  test('unknown top-level itemId resolves to a leaf without throwing', () => {
    const items = { known: {} };
    assert.doesNotThrow(() => buildTree(items, 'ghost', 7));
    const node = buildTree(items, 'ghost', 7);
    assert.deepEqual(node, {
      itemId: 'ghost',
      qty: 7,
      crafts: 0,
      stations: null,
      yields: null,
      children: [],
    });
  });

  test('Object.hasOwn lookup avoids prototype-chain false hits', () => {
    const items = { real: {} };
    // "toString"/"constructor" exist on Object.prototype but not as own props.
    const node = buildTree(items, 'toString', 1);
    assert.equal(node.crafts, 0);
    assert.equal(node.stations, null);
    assert.deepEqual(node.children, []);
  });
});

describe('buildTree: recipes[] (schema v3 axis 2, PLAN.md §1 decisions 1/4)', () => {
  test('recipes[0] is used by default with no recipeChoices override', () => {
    const items = {
      carbon_fiber: {
        recipes: [
          { stations: ['s'], yields: 1, ingredients: [{ item: 'coal', qty: 2 }, { item: 'flame_organ', qty: 1 }] },
          { stations: ['s'], yields: 1, ingredients: [{ item: 'charcoal', qty: 5 }, { item: 'flame_organ', qty: 1 }] },
        ],
      },
      coal: {},
      charcoal: {},
      flame_organ: {},
    };
    const node = buildTree(items, 'carbon_fiber', 1);
    assert.deepEqual(
      node.children.map((c) => c.itemId),
      ['coal', 'flame_organ'],
    );
  });

  test('recipeChoices selects a non-default recipe by node path', () => {
    const items = {
      carbon_fiber: {
        recipes: [
          { stations: ['s'], yields: 1, ingredients: [{ item: 'coal', qty: 2 }, { item: 'flame_organ', qty: 1 }] },
          { stations: ['s'], yields: 1, ingredients: [{ item: 'charcoal', qty: 5 }, { item: 'flame_organ', qty: 1 }] },
        ],
      },
      coal: {},
      charcoal: {},
      flame_organ: {},
    };
    const recipeChoices = new Map([[ROOT_PATH, 1]]);
    const node = buildTree(items, 'carbon_fiber', 1, new Set(), ROOT_PATH, recipeChoices);
    assert.deepEqual(
      node.children.map((c) => c.itemId),
      ['charcoal', 'flame_organ'],
    );
  });

  test('an out-of-range recipeChoices entry falls back to recipes[0] rather than throwing', () => {
    const items = {
      widget: {
        recipes: [{ stations: ['s'], yields: 1, ingredients: [{ item: 'ore', qty: 1 }] }],
      },
      ore: {},
    };
    const recipeChoices = new Map([[ROOT_PATH, 99]]);
    assert.doesNotThrow(() => buildTree(items, 'widget', 1, new Set(), ROOT_PATH, recipeChoices));
    const node = buildTree(items, 'widget', 1, new Set(), ROOT_PATH, recipeChoices);
    assert.equal(node.children[0].itemId, 'ore');
  });

  test('two occurrences of the SAME item switch independently, keyed by path', () => {
    // top needs 1x shared (twice, at different positions) — one branch's
    // choice must not affect the other's.
    const items = {
      top: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [
              { item: 'shared', qty: 1 },
              { item: 'shared', qty: 1 },
            ],
          },
        ],
      },
      shared: {
        recipes: [
          { stations: ['s'], yields: 1, ingredients: [{ item: 'a', qty: 1 }] },
          { stations: ['s'], yields: 1, ingredients: [{ item: 'b', qty: 1 }] },
        ],
      },
      a: {},
      b: {},
    };
    // Switch only the SECOND occurrence (path r.1) to recipe index 1.
    const recipeChoices = new Map([[childPath(ROOT_PATH, 1), 1]]);
    const node = buildTree(items, 'top', 1, new Set(), ROOT_PATH, recipeChoices);
    assert.equal(node.children[0].children[0].itemId, 'a'); // first occurrence: default recipes[0]
    assert.equal(node.children[1].children[0].itemId, 'b'); // second occurrence: switched
  });

  test('recipe yields differ per alternate: crafts recompute for whichever recipe is active', () => {
    const items = {
      batch_item: {
        recipes: [
          { stations: ['s'], yields: 1, ingredients: [{ item: 'raw', qty: 1 }] },
          { stations: ['s'], yields: 5, ingredients: [{ item: 'raw', qty: 1 }] },
        ],
      },
      raw: {},
    };
    const defaultNode = buildTree(items, 'batch_item', 12);
    assert.equal(defaultNode.crafts, 12); // yields 1 -> crafts == qty
    assert.equal(defaultNode.yields, 1);

    const switched = buildTree(items, 'batch_item', 12, new Set(), ROOT_PATH, new Map([[ROOT_PATH, 1]]));
    assert.equal(switched.crafts, 3); // ceil(12/5)
    assert.equal(switched.yields, 5);
  });

  test('REGRESSION GUARD (decision 1): a single-recipe item\'s tree is unaffected by recipeChoices/path plumbing existing at all', () => {
    const items = {
      widget: {
        recipes: [{ stations: ['bench'], yields: 2, ingredients: [{ item: 'ore', qty: 3 }] }],
      },
      ore: {},
    };
    const plain = buildTree(items, 'widget', 5);
    const withEmptyChoices = buildTree(items, 'widget', 5, new Set(), ROOT_PATH, new Map());
    const withUnrelatedChoice = buildTree(items, 'widget', 5, new Set(), ROOT_PATH, new Map([['some.other.path', 3]]));
    assert.deepEqual(plain, withEmptyChoices);
    assert.deepEqual(plain, withUnrelatedChoice);
  });
});

describe('buildTree: anyOf/anyOfLabel (schema v3 axis 1, PLAN.md §1 decision 3)', () => {
  test('anyOf/anyOfLabel are attached to the CHILD node, not read by the parent\'s math', () => {
    const items = {
      campfire: {
        recipes: [
          {
            stations: ['crafting_table'],
            yields: 1,
            ingredients: [
              {
                item: 'acacia_log',
                qty: 3,
                anyOf: ['acacia_log', 'oak_log', 'spruce_log'],
                anyOfLabel: 'Log',
              },
            ],
          },
        ],
      },
      acacia_log: {},
    };
    const node = buildTree(items, 'campfire', 2);
    const child = node.children[0];
    assert.equal(child.itemId, 'acacia_log');
    assert.equal(child.qty, 6); // 3 * 2 crafts — anyOf must not affect qty math
    assert.deepEqual(child.anyOf, ['acacia_log', 'oak_log', 'spruce_log']);
    assert.equal(child.anyOfLabel, 'Log');
  });

  test('anyOf with no anyOfLabel: the field is simply absent on the node (not null/undefined-but-present)', () => {
    const items = {
      thing: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'a', qty: 1, anyOf: ['a', 'b'] }],
          },
        ],
      },
      a: {},
    };
    const node = buildTree(items, 'thing', 1);
    assert.deepEqual(node.children[0].anyOf, ['a', 'b']);
    assert.ok(!Object.hasOwn(node.children[0], 'anyOfLabel'));
  });

  test('an ingredient with no anyOf produces a node with no anyOf/anyOfLabel keys at all', () => {
    const items = {
      thing: {
        recipes: [{ stations: ['s'], yields: 1, ingredients: [{ item: 'a', qty: 1 }] }],
      },
      a: {},
    };
    const node = buildTree(items, 'thing', 1);
    assert.ok(!Object.hasOwn(node.children[0], 'anyOf'));
    assert.ok(!Object.hasOwn(node.children[0], 'anyOfLabel'));
  });

  test('REGRESSION GUARD (decision 1): a tree built from a recipe WITH anyOf is byte-identical to the same recipe WITHOUT it, once anyOf/anyOfLabel are stripped', () => {
    // Same shape as the real campfire/charcoal case: a multi-level recipe
    // where one ingredient slot is anyOf-flagged. Quantities, crafts,
    // stations, and structure must be completely unaffected by anyOf's
    // presence — it is purely additive UI truth layered on top of `item`.
    const withAnyOf = {
      campfire: {
        recipes: [
          {
            stations: ['crafting_table'],
            yields: 1,
            ingredients: [
              { item: 'stick', qty: 3 },
              { item: 'charcoal', qty: 1, anyOf: ['charcoal', 'coal'], anyOfLabel: 'Coals' },
              { item: 'acacia_log', qty: 3, anyOf: ['acacia_log', 'oak_log', 'spruce_log'], anyOfLabel: 'Log' },
            ],
          },
        ],
      },
      charcoal: {
        recipes: [
          {
            stations: ['furnace'],
            yields: 1,
            ingredients: [{ item: 'acacia_log', qty: 1, anyOf: ['acacia_log', 'oak_log'], anyOfLabel: 'Log' }],
          },
        ],
      },
      stick: {},
      acacia_log: {},
    };
    const withoutAnyOf = {
      campfire: {
        recipes: [
          {
            stations: ['crafting_table'],
            yields: 1,
            ingredients: [
              { item: 'stick', qty: 3 },
              { item: 'charcoal', qty: 1 },
              { item: 'acacia_log', qty: 3 },
            ],
          },
        ],
      },
      charcoal: {
        recipes: [{ stations: ['furnace'], yields: 1, ingredients: [{ item: 'acacia_log', qty: 1 }] }],
      },
      stick: {},
      acacia_log: {},
    };

    function stripAnyOf(node) {
      const { anyOf: _anyOf, anyOfLabel: _anyOfLabel, ...rest } = node;
      return { ...rest, children: node.children.map(stripAnyOf) };
    }

    const treeWith = buildTree(withAnyOf, 'campfire', 5);
    const treeWithout = buildTree(withoutAnyOf, 'campfire', 5);
    assert.deepEqual(stripAnyOf(treeWith), treeWithout);

    // And the raw-materials aggregation (which only ever reads itemId/qty)
    // is identical too, regardless of anyOf.
    assert.deepEqual([...aggregateRaw(treeWith).entries()], [...aggregateRaw(treeWithout).entries()]);
  });
});

describe('aggregateRaw', () => {
  test('sums a shared ingredient across branches', () => {
    // top needs 1x branchA (-> 2x raw) and 1x branchB (-> 3x raw): raw totals 5.
    const items = {
      top: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [
              { item: 'branchA', qty: 1 },
              { item: 'branchB', qty: 1 },
            ],
          },
        ],
      },
      branchA: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'raw', qty: 2 }],
          },
        ],
      },
      branchB: {
        recipes: [
          {
            stations: ['s'],
            yields: 1,
            ingredients: [{ item: 'raw', qty: 3 }],
          },
        ],
      },
      raw: {},
    };
    const node = buildTree(items, 'top', 1);
    const totals = aggregateRaw(node);
    assert.equal(totals.get('raw'), 5);
  });

  test('leaf-only tree aggregates itself', () => {
    const node = buildTree({ wood: {} }, 'wood', 9);
    const totals = aggregateRaw(node);
    assert.deepEqual([...totals.entries()], [['wood', 9]]);
  });
});

describe('real data: assault_rifle (common)', () => {
  const dataPath = path.join(__dirname, '..', 'data', 'palworld', 'items.json');
  const { items } = JSON.parse(readFileSync(dataPath, 'utf8'));

  test('aggregates raw materials to the hand-derived expected totals', () => {
    // Derivation (PLAN.md sample data, qty 1):
    //   assault_rifle: 40 refined_ingot + 10 polymer + 10 carbon_fiber
    //   40 refined_ingot -> 80 ore + 80 coal
    //   10 carbon_fiber  -> 20 coal + 10 flame_organ
    //   10 polymer       -> 20 high_quality_pal_oil + 10 sulfur
    // Totals: ore 80, coal 100 (80+20), high_quality_pal_oil 20, sulfur 10,
    // flame_organ 10.
    const node = buildTree(items, 'assault_rifle', 1);
    const totals = aggregateRaw(node);

    assert.equal(totals.get('ore'), 80);
    assert.equal(totals.get('coal'), 100);
    assert.equal(totals.get('high_quality_pal_oil'), 20);
    assert.equal(totals.get('sulfur'), 10);
    assert.equal(totals.get('flame_organ'), 10);

    // No stray raw materials beyond these 5.
    assert.equal(totals.size, 5);
  });
});

describe('MIGRATION PARITY (schema v3 axis 2, PLAN.md §1 decision 1): recipe -> recipes[] must be behaviour-preserving', () => {
  // The guard for decision 1: "for every item that had exactly one recipe
  // before, every tree ... must be BYTE-IDENTICAL to before. This migration
  // is behaviour-preserving by default; only items that actually gained an
  // alternate can change, and even they default to the same primary."
  const dataPath = path.join(__dirname, '..', 'data', 'palworld', 'items.json');
  const { items } = JSON.parse(readFileSync(dataPath, 'utf8'));

  test('single-recipe real items (refined_ingot, polymer) produce the known-good totals unchanged', () => {
    // refined_ingot: 2x ore + 2x coal per craft (yields 1).
    const ingot = buildTree(items, 'refined_ingot', 40);
    const ingotRaw = aggregateRaw(ingot);
    assert.equal(ingot.crafts, 40);
    assert.equal(ingotRaw.get('ore'), 80);
    assert.equal(ingotRaw.get('coal'), 80);

    // polymer: 2x high_quality_pal_oil + 1x sulfur per craft (yields 1).
    const polymer = buildTree(items, 'polymer', 10);
    const polymerRaw = aggregateRaw(polymer);
    assert.equal(polymerRaw.get('high_quality_pal_oil'), 20);
    assert.equal(polymerRaw.get('sulfur'), 10);
  });

  test('a genuinely multi-recipe item (carbon_fiber, now 2 recipes) still defaults to the SAME primary as the old single-recipe scrape', () => {
    const item = items['carbon_fiber'];
    assert.ok(item.recipes.length > 1, 'carbon_fiber must have gained an alternate for this guard to mean anything');

    const node = buildTree(items, 'carbon_fiber', 1);
    // Old pre-axis-2 primary (PLAN.md §1, verified on paldb.cc): 2x Coal + 1x
    // Flame Organ — NOT the 5x Charcoal alternate.
    assert.deepEqual(
      node.children.map((c) => ({ itemId: c.itemId, qty: c.qty })),
      [
        { itemId: 'coal', qty: 2 },
        { itemId: 'flame_organ', qty: 1 },
      ],
    );
    const totals = aggregateRaw(node);
    assert.equal(totals.get('coal'), 2);
    assert.equal(totals.get('flame_organ'), 1);
    assert.ok(!totals.has('charcoal'), 'the non-default alternate must not silently leak into the default tree');
  });

  test('the most extreme multi-recipe item (paldium_fragment, 1 -> 13 recipes) still defaults to the SAME primary', () => {
    const item = items['paldium_fragment'];
    assert.equal(item.recipes.length, 13);

    const node = buildTree(items, 'paldium_fragment', 1);
    // Old pre-axis-2 primary: 1x Meteorite Fragment, yields 3 (cheapest raw
    // cost) — not the 5x Stone / 2x Ore / any sphere-based alternate.
    assert.equal(node.crafts, 1); // ceil(1/3)
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].itemId, 'meteorite_fragment');
    assert.equal(node.children[0].qty, 1);
  });

  test('every item with recipes.length === 1 round-trips through the leaf test identically to the old !item.recipe check', () => {
    const singleRecipeIds = Object.entries(items)
      .filter(([, item]) => item.recipes?.length === 1)
      .map(([id]) => id)
      .slice(0, 25); // a sample is enough — this is a shape guard, not a full-catalog walk
    assert.ok(singleRecipeIds.length > 0);
    for (const id of singleRecipeIds) {
      const node = buildTree(items, id, 1);
      assert.notEqual(node.stations, null, `${id}: a real recipe must not be treated as a leaf`);
      assert.ok(node.children.length > 0 || items[id].recipes[0].ingredients.length === 0);
    }
  });
});

describe('collapsiblePaths / childPath', () => {
  const items = {
    top: {
      name: 'Top',
      recipes: [{ stations: ['s'], ingredients: [{ item: 'mid', qty: 2 }, { item: 'raw', qty: 1 }] }],
    },
    mid: { name: 'Mid', recipes: [{ stations: ['s'], ingredients: [{ item: 'raw', qty: 3 }] }] },
    raw: { name: 'Raw' },
  };

  test('lists only nodes that have children, root first', () => {
    const paths = collapsiblePaths(buildTree(items, 'top', 1));
    assert.deepEqual(paths, [ROOT_PATH, childPath(ROOT_PATH, 0)]);
  });

  test('a leaf-only tree has nothing to collapse', () => {
    assert.deepEqual(collapsiblePaths(buildTree(items, 'raw', 1)), []);
  });

  test('paths are position-based so a repeated item folds independently', () => {
    // 'raw' appears under both 'mid' and 'top'; neither is collapsible, but
    // their paths must differ so collapse state never aliases between them.
    assert.notEqual(childPath(ROOT_PATH, 1), childPath(childPath(ROOT_PATH, 0), 0));
  });

  test('real data: every collapsible path in the assault_rifle tree is unique', () => {
    const items = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'palworld', 'items.json'), 'utf8')).items;
    const paths = collapsiblePaths(buildTree(items, 'assault_rifle', 1));
    assert.equal(new Set(paths).size, paths.length);
    assert.ok(paths.includes(ROOT_PATH));
  });
});
