// Pure marker-layer bookkeeping for MapView (PLAN.md §8). No React, no
// canvas/DOM APIs — must run standalone under plain Node (see
// mapMarkers.test.mjs), same convention as tree.js/filter.js. MapView.jsx
// keeps the actual rendering (DOM nodes vs a <canvas>); this module only
// decides *which* markers go where and answers "what's near this click".

/**
 * Group map.json's `types` (the legend) by their `category` field, each
 * group's types sorted by marker count descending (busiest layer first) —
 * the shape the layer-toggle panel renders directly.
 *
 * @param {Array<{id: string, label: string, category: string, icon: string}>} types
 * @param {Map<string, number>} countsByType
 * @returns {Array<{category: string, types: Array<{id, label, icon, count}>}>} sorted by category name.
 */
export function groupTypesByCategory(types, countsByType) {
  const byCategory = new Map();
  for (const type of types) {
    const category = type.category || 'Other';
    const list = byCategory.get(category) ?? [];
    list.push({ id: type.id, label: type.label, icon: type.icon, count: countsByType.get(type.id) ?? 0 });
    byCategory.set(category, list);
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({ category, types: [...list].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * How many markers exist per type id — the "real count" the layer toggle
 * panel shows next to each type's icon.
 *
 * @param {Array<{type: string}>} markers
 * @returns {Map<string, number>}
 */
export function countMarkersByType(markers) {
  const counts = new Map();
  for (const marker of markers) {
    counts.set(marker.type, (counts.get(marker.type) ?? 0) + 1);
  }
  return counts;
}

/**
 * Split the enabled markers into a DOM-friendly set and a canvas-friendly
 * set. A handful of enabled types (Fast Travel, Tower, ...) is fine as real
 * DOM nodes; a huge one (Ore 1463, Salvage Rank2 ~2000) would jank the page
 * as DOM, so it's routed to canvas instead even though the user enabled it
 * like any other layer.
 *
 * @param {Array<object>} markers - map.json's markers.
 * @param {Set<string>} enabledTypes - type ids currently toggled on.
 * @param {Map<string, number>} countsByType
 * @param {number} [canvasThreshold=300] - a type with more markers than this renders on canvas.
 * @returns {{dom: Array<object>, canvas: Array<object>}}
 */
export function partitionMarkersForRender(markers, enabledTypes, countsByType, canvasThreshold = 300) {
  const dom = [];
  const canvas = [];
  for (const marker of markers) {
    if (!enabledTypes.has(marker.type)) continue;
    const count = countsByType.get(marker.type) ?? 0;
    (count > canvasThreshold ? canvas : dom).push(marker);
  }
  return { dom, canvas };
}

/**
 * Nearest positioned marker to a click point, within `maxDistance` pixels —
 * canvas-rendered markers have no DOM node to receive a click, so hit-testing
 * a click against their pixel positions is how they stay clickable.
 *
 * @param {Array<{marker: object, x: number, y: number}>} positioned - markers with precomputed pixel positions.
 * @param {{x: number, y: number}} point - click position in the same pixel space.
 * @param {number} [maxDistance=8]
 * @returns {object|null} the nearest marker, or null if none is within range.
 */
export function nearestMarker(positioned, point, maxDistance = 8) {
  let best = null;
  let bestDistSq = maxDistance * maxDistance;
  for (const { marker, x, y } of positioned) {
    const dx = x - point.x;
    const dy = y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      best = marker;
      bestDistSq = distSq;
    }
  }
  return best;
}
