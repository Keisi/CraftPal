import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildTree, aggregateRaw, collapsiblePaths, childPath, ROOT_PATH } from './tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('buildTree', () => {
  test('raw material (no recipe) produces a leaf node', () => {
    const items = {
      wood: { name: 'Wood' },
    };
    const node = buildTree(items, 'wood', 5);
    assert.deepEqual(node, {
      itemId: 'wood',
      qty: 5,
      crafts: 0,
      stations: null,
      children: [],
    });
  });

  test('single-level recipe computes crafts and scaled ingredient qty', () => {
    const items = {
      widget: {
        recipe: {
          stations: ['bench'],
          yields: 1,
          ingredients: [{ item: 'ore', qty: 3 }],
        },
      },
      ore: {},
    };
    const node = buildTree(items, 'widget', 2);
    assert.equal(node.crafts, 2);
    assert.deepEqual(node.stations, ['bench']);
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
        recipe: {
          stations: ['bench'],
          yields: 3,
          ingredients: [{ item: 'raw', qty: 5 }],
        },
      },
      raw: {},
    };
    const node = buildTree(items, 'batch_item', 4);
    assert.equal(node.crafts, 2); // ceil(4/3) = 2
    assert.equal(node.children[0].qty, 10); // 5 * 2
  });

  test('multi-level nesting multiplies quantities correctly down the chain', () => {
    const items = {
      top: {
        recipe: {
          stations: ['s1'],
          yields: 1,
          ingredients: [{ item: 'mid', qty: 2 }],
        },
      },
      mid: {
        recipe: {
          stations: ['s2'],
          yields: 1,
          ingredients: [{ item: 'bottom', qty: 3 }],
        },
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
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'b', qty: 1 }],
        },
      },
      b: {
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'a', qty: 1 }],
        },
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
      children: [],
    });
  });

  test('unknown ingredient id resolves to a leaf without throwing', () => {
    const items = {
      thing: {
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'nonexistent', qty: 4 }],
        },
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

describe('buildTree: anyOf/anyOfLabel (schema v3 axis 1, PLAN.md §1 decision 3)', () => {
  test('anyOf/anyOfLabel are attached to the CHILD node, not read by the parent\'s math', () => {
    const items = {
      campfire: {
        recipe: {
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
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'a', qty: 1, anyOf: ['a', 'b'] }],
        },
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
        recipe: { stations: ['s'], yields: 1, ingredients: [{ item: 'a', qty: 1 }] },
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
        recipe: {
          stations: ['crafting_table'],
          yields: 1,
          ingredients: [
            { item: 'stick', qty: 3 },
            { item: 'charcoal', qty: 1, anyOf: ['charcoal', 'coal'], anyOfLabel: 'Coals' },
            { item: 'acacia_log', qty: 3, anyOf: ['acacia_log', 'oak_log', 'spruce_log'], anyOfLabel: 'Log' },
          ],
        },
      },
      charcoal: {
        recipe: {
          stations: ['furnace'],
          yields: 1,
          ingredients: [{ item: 'acacia_log', qty: 1, anyOf: ['acacia_log', 'oak_log'], anyOfLabel: 'Log' }],
        },
      },
      stick: {},
      acacia_log: {},
    };
    const withoutAnyOf = {
      campfire: {
        recipe: {
          stations: ['crafting_table'],
          yields: 1,
          ingredients: [
            { item: 'stick', qty: 3 },
            { item: 'charcoal', qty: 1 },
            { item: 'acacia_log', qty: 3 },
          ],
        },
      },
      charcoal: {
        recipe: { stations: ['furnace'], yields: 1, ingredients: [{ item: 'acacia_log', qty: 1 }] },
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
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [
            { item: 'branchA', qty: 1 },
            { item: 'branchB', qty: 1 },
          ],
        },
      },
      branchA: {
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'raw', qty: 2 }],
        },
      },
      branchB: {
        recipe: {
          stations: ['s'],
          yields: 1,
          ingredients: [{ item: 'raw', qty: 3 }],
        },
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

describe('collapsiblePaths / childPath', () => {
  const items = {
    top: { name: 'Top', recipe: { stations: ['s'], ingredients: [{ item: 'mid', qty: 2 }, { item: 'raw', qty: 1 }] } },
    mid: { name: 'Mid', recipe: { stations: ['s'], ingredients: [{ item: 'raw', qty: 3 }] } },
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
