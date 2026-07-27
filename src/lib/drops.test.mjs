import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDropIndex, palsForItem } from './drops.js';

// Deliberately synthetic (not the real, concurrently-regenerated
// src/data/palworld/pals.json) so these tests stay deterministic — same
// reasoning as tree.test.mjs's hand-built item fixtures.
function fixturePals() {
  return {
    alpaca: {
      name: 'Melpaca',
      icon: 'icons/pals/alpaca.webp',
      drops: [
        { item: 'wool', name: 'Wool', rate: '100%', qty: '2-5' },
        { item: 'leather', name: 'Leather', rate: '100%', qty: '1' },
      ],
      hasHabitat: true,
    },
    direhowl: {
      name: 'Direhowl',
      icon: 'icons/pals/direhowl.webp',
      drops: [{ item: 'leather', name: 'Leather', rate: '100%', qty: '2-3' }],
      hasHabitat: true,
    },
    blackcentaur: {
      name: 'Necromus',
      icon: 'icons/pals/blackcentaur.webp',
      drops: [{ item: 'hexolite', name: 'Hexolite', rate: '100%', qty: '10' }],
      hasHabitat: false,
    },
    noDrops: {
      name: 'Nothing Pal',
      icon: 'icons/pals/nothing.webp',
      drops: [],
      hasHabitat: true,
    },
  };
}

describe('buildDropIndex', () => {
  test('two pals dropping the same item both show up, in insertion order', () => {
    const index = buildDropIndex(fixturePals());
    const leatherPals = palsForItem(index, 'leather');
    assert.equal(leatherPals.length, 2);
    assert.deepEqual(
      leatherPals.map((p) => p.code),
      ['alpaca', 'direhowl'],
    );
  });

  test('an item dropped by only one pal returns a single-entry list with full shape', () => {
    const index = buildDropIndex(fixturePals());
    const woolPals = palsForItem(index, 'wool');
    assert.deepEqual(woolPals, [
      { code: 'alpaca', name: 'Melpaca', icon: 'icons/pals/alpaca.webp', rate: '100%', qty: '2-5', hasHabitat: true },
    ]);
  });

  test('hasHabitat is carried through per pal (a pal with no habitat data still lists its drops)', () => {
    const index = buildDropIndex(fixturePals());
    const hexolitePals = palsForItem(index, 'hexolite');
    assert.equal(hexolitePals.length, 1);
    assert.equal(hexolitePals[0].hasHabitat, false);
  });

  test('a pal with an empty drops array contributes nothing', () => {
    const index = buildDropIndex(fixturePals());
    for (const list of index.values()) {
      assert.ok(!list.some((p) => p.code === 'noDrops'));
    }
  });

  test('an item nothing drops returns [] (not undefined, not a throw)', () => {
    const index = buildDropIndex(fixturePals());
    assert.deepEqual(palsForItem(index, 'ancient_civilization_parts'), []);
  });

  test('undefined/empty pals map (a game with no pals dataset) degrades to an empty index', () => {
    assert.deepEqual(palsForItem(buildDropIndex(undefined), 'wool'), []);
    assert.deepEqual(palsForItem(buildDropIndex({}), 'wool'), []);
  });

  test('a drop entry missing its item id is skipped rather than corrupting the index', () => {
    const pals = { ghost: { name: 'Ghost', drops: [{ name: 'Mystery', rate: '100%', qty: '1' }] } };
    const index = buildDropIndex(pals);
    assert.equal(index.size, 0);
  });
});

describe('palsForItem', () => {
  test('a null/undefined dropIndex never throws', () => {
    assert.deepEqual(palsForItem(undefined, 'wool'), []);
    assert.deepEqual(palsForItem(null, 'wool'), []);
  });
});
