import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupTypesByCategory, countMarkersByType, partitionMarkersForRender, nearestMarker } from './mapMarkers.js';

const TYPES = [
  { id: 'Fast Travel', label: 'Fast Travel', category: 'Locations', icon: 'a.webp' },
  { id: 'Dungeon', label: 'Dungeon', category: 'Locations', icon: 'b.webp' },
  { id: 'Alpha Pal', label: 'Alpha Pal', category: 'Enemies', icon: 'c.webp' },
  { id: 'Ore', label: 'Ore', category: 'Mine', icon: 'd.webp' },
];

const MARKERS = [
  { type: 'Fast Travel', name: 'A' },
  { type: 'Fast Travel', name: 'B' },
  { type: 'Dungeon', name: 'C' },
  { type: 'Alpha Pal', name: 'D' },
  ...Array.from({ length: 400 }, (_, i) => ({ type: 'Ore', name: `Ore ${i}` })),
];

describe('countMarkersByType', () => {
  test('counts markers per type id', () => {
    const counts = countMarkersByType(MARKERS);
    assert.equal(counts.get('Fast Travel'), 2);
    assert.equal(counts.get('Dungeon'), 1);
    assert.equal(counts.get('Ore'), 400);
    assert.equal(counts.get('Nonexistent'), undefined);
  });
});

describe('groupTypesByCategory', () => {
  test('groups by category, categories alphabetical, types within a category by count desc', () => {
    const counts = countMarkersByType(MARKERS);
    const groups = groupTypesByCategory(TYPES, counts);
    assert.deepEqual(
      groups.map((g) => g.category),
      ['Enemies', 'Locations', 'Mine'],
    );
    const locations = groups.find((g) => g.category === 'Locations');
    assert.deepEqual(
      locations.types.map((t) => t.id),
      ['Fast Travel', 'Dungeon'], // 2 > 1
    );
  });

  test('a type with no category falls back to "Other"', () => {
    const groups = groupTypesByCategory([{ id: 'x', label: 'X', category: '', icon: 'x.webp' }], new Map());
    assert.equal(groups[0].category, 'Other');
  });

  test('every type carries its real count, including zero', () => {
    const groups = groupTypesByCategory(TYPES, countMarkersByType(MARKERS));
    const alpha = groups.find((g) => g.category === 'Enemies').types[0];
    assert.equal(alpha.count, 1);
  });
});

describe('partitionMarkersForRender', () => {
  test('a small enabled type goes to dom, a huge one goes to canvas even when both are enabled', () => {
    const counts = countMarkersByType(MARKERS);
    const enabled = new Set(['Fast Travel', 'Ore']);
    const { dom, canvas } = partitionMarkersForRender(MARKERS, enabled, counts, 300);
    assert.equal(dom.length, 2); // the 2 Fast Travel markers
    assert.equal(canvas.length, 400); // the 400 Ore markers
    assert.ok(dom.every((m) => m.type === 'Fast Travel'));
    assert.ok(canvas.every((m) => m.type === 'Ore'));
  });

  test('a disabled type contributes to neither bucket', () => {
    const counts = countMarkersByType(MARKERS);
    const enabled = new Set(['Fast Travel']);
    const { dom, canvas } = partitionMarkersForRender(MARKERS, enabled, counts, 300);
    assert.equal(dom.length, 2);
    assert.equal(canvas.length, 0);
  });

  test('empty enabled set renders nothing', () => {
    const counts = countMarkersByType(MARKERS);
    const { dom, canvas } = partitionMarkersForRender(MARKERS, new Set(), counts, 300);
    assert.equal(dom.length, 0);
    assert.equal(canvas.length, 0);
  });
});

describe('nearestMarker', () => {
  const positioned = [
    { marker: { name: 'near' }, x: 10, y: 10 },
    { marker: { name: 'far' }, x: 500, y: 500 },
  ];

  test('finds the closest marker within range', () => {
    const found = nearestMarker(positioned, { x: 12, y: 11 }, 8);
    assert.equal(found.name, 'near');
  });

  test('returns null when nothing is within maxDistance', () => {
    assert.equal(nearestMarker(positioned, { x: 100, y: 100 }, 8), null);
  });

  test('empty positioned list returns null, never throws', () => {
    assert.equal(nearestMarker([], { x: 0, y: 0 }), null);
  });
});
