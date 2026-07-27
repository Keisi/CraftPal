// Pure, unit-testable browse/filter/sort logic for ItemBrowser (PLAN.md §5,
// Phase 4). No React, no Vite-specific imports — must run standalone under
// plain Node (see filter.test.mjs), same convention as tree.js.
//
// Everything here operates on "entries" of shape
//   { id, item, family, isFamily, variants: [{ id, item }, ...] }
// produced by groupFamilies() — a plain (non-family) item is just an entry
// whose `variants` array holds only itself. Filtering/sorting a single shape
// like this means the browser grid never has to special-case families.

import { RARITIES } from './rarity.js';

// Rarity order lives on RARITIES (rarity.js) so there is exactly one source
// of truth for tier ordering across badges, borders, dots, and sorting.
// Unknown/missing rarities sort after every known tier.
function rarityIndex(rarity) {
  const idx = RARITIES.indexOf(rarity);
  return idx === -1 ? RARITIES.length : idx;
}

// --- Family grouping ---------------------------------------------------

/**
 * Group items sharing a `family` id into one entry exposing the full variant
 * list (sorted rarity-ascending), keyed by the lowest-rarity ("base")
 * variant. Items with no `family` become single-variant entries so callers
 * can treat every entry uniformly.
 *
 * @param {object} items - items map (src/data/items.json `.items`).
 * @returns {Array<{id: string, item: object, family: string|null, isFamily: boolean, variants: Array<{id: string, item: object}>}>}
 */
export function groupFamilies(items) {
  const entries = [];
  const byFamily = new Map();

  for (const [id, item] of Object.entries(items)) {
    if (!item.family) {
      entries.push({ id, item, family: null, isFamily: false, variants: [{ id, item }] });
      continue;
    }

    let group = byFamily.get(item.family);
    if (!group) {
      group = { id, item, family: item.family, isFamily: false, variants: [] };
      byFamily.set(item.family, group);
      entries.push(group);
    }
    group.variants.push({ id, item });
  }

  for (const group of byFamily.values()) {
    group.variants.sort((a, b) => rarityIndex(a.item.rarity) - rarityIndex(b.item.rarity));
    const base = group.variants[0];
    group.id = base.id;
    group.item = base.item;
    // A `family` id with only one surviving member isn't really a group —
    // treat it like a plain item (no dots, no switcher) rather than a
    // family of one.
    group.isFamily = group.variants.length > 1;
  }

  return entries;
}

/**
 * All items sharing `familyId`, sorted rarity-ascending. Used by the tree
 * view's rarity switcher (PLAN.md §5) to build its tabs.
 *
 * @param {object} items
 * @param {string} familyId
 * @returns {Array<{id: string, item: object}>}
 */
export function familyVariants(items, familyId) {
  return Object.entries(items)
    .filter(([, item]) => item.family === familyId)
    .map(([id, item]) => ({ id, item }))
    .sort((a, b) => rarityIndex(a.item.rarity) - rarityIndex(b.item.rarity));
}

// --- Text search ---------------------------------------------------------

/**
 * Case-insensitive substring match against an item's name.
 */
export function matchesSearch(item, query) {
  if (!query || !query.trim()) return true;
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

// --- Filters ---------------------------------------------------------
// Each returns a predicate over an entry (see groupFamilies shape). A family
// entry matches a filter if ANY of its variants matches (PLAN.md §5 /
// task spec item 2).

export function textFilter(query) {
  if (!query || !query.trim()) return () => true;
  return (entry) => entry.variants.some(({ item }) => matchesSearch(item, query));
}

export function categoryFilter(category) {
  if (!category) return () => true;
  return (entry) => entry.variants.some(({ item }) => item.category === category);
}

export function rarityFilter(rarity) {
  if (!rarity) return () => true;
  return (entry) => entry.variants.some(({ item }) => item.rarity === rarity);
}

export function craftableFilter(craftableOnly) {
  if (!craftableOnly) return () => true;
  return (entry) => entry.variants.some(({ item }) => Boolean(item.recipe));
}

export function stationFilter(stationId) {
  if (!stationId) return () => true;
  return (entry) => entry.variants.some(({ item }) => item.recipe?.stations?.includes(stationId));
}

/**
 * Combine every filter above into one pass. Any option left falsy/omitted is
 * a no-op, so callers can pass a partial filter state.
 *
 * @param {Array} entries - output of groupFamilies().
 * @param {{search?: string, category?: string, rarity?: string, craftableOnly?: boolean, station?: string}} [filters]
 */
export function filterEntries(entries, filters = {}) {
  const { search, category, rarity, craftableOnly, station } = filters;
  const predicates = [
    textFilter(search),
    categoryFilter(category),
    rarityFilter(rarity),
    craftableFilter(craftableOnly),
    stationFilter(station),
  ];
  return entries.filter((entry) => predicates.every((predicate) => predicate(entry)));
}

// --- Sort comparators ---------------------------------------------------
// All operate on entries (family-collapsed cards sort by their base/display
// item, matching what the card actually shows).

export function compareByName(a, b) {
  return a.item.name.localeCompare(b.item.name);
}

export function compareByCategory(a, b) {
  return (a.item.category ?? '').localeCompare(b.item.category ?? '') || compareByName(a, b);
}

export function compareByRarity(a, b) {
  return rarityIndex(a.item.rarity) - rarityIndex(b.item.rarity) || compareByName(a, b);
}

// Missing techLevel sorts last, regardless of direction.
export function compareByTechLevel(a, b) {
  const at = a.item.techLevel;
  const bt = b.item.techLevel;
  if (at == null && bt == null) return compareByName(a, b);
  if (at == null) return 1;
  if (bt == null) return -1;
  return at - bt || compareByName(a, b);
}

export const SORTS = {
  name: { label: 'Name', compare: compareByName },
  category: { label: 'Category', compare: compareByCategory },
  rarity: { label: 'Rarity', compare: compareByRarity },
  techLevel: { label: 'Tech level', compare: compareByTechLevel },
};

// --- Derived filter-option lists ---------------------------------------
// The browser's chip/dropdown option lists must reflect whatever dataset is
// actually loaded (16-item sample today, ~600+ full scrape later) — never a
// hardcoded list of categories/rarities/stations.

/**
 * Distinct categories present in the data, alphabetical.
 */
export function deriveCategories(items) {
  const present = new Set(Object.values(items).map((item) => item.category).filter(Boolean));
  return [...present].sort();
}

/**
 * Rarities present in the data, in canonical tier order (not alphabetical).
 */
export function deriveRarities(items) {
  const present = new Set(Object.values(items).map((item) => item.rarity).filter(Boolean));
  return RARITIES.filter((rarity) => present.has(rarity));
}

/**
 * Stations actually referenced by at least one recipe, sorted by tech level
 * (unknown-tech stations last) then name.
 */
export function deriveStations(items, stations) {
  const used = new Set();
  for (const item of Object.values(items)) {
    for (const stationId of item.recipe?.stations ?? []) {
      used.add(stationId);
    }
  }
  return [...used]
    .map((id) => ({ id, name: stations[id]?.name ?? id, techLevel: stations[id]?.techLevel }))
    .sort((a, b) => {
      const at = a.techLevel ?? Infinity;
      const bt = b.techLevel ?? Infinity;
      return at - bt || a.name.localeCompare(b.name);
    });
}
