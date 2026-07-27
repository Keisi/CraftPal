// Pure, unit-testable browse/filter/sort logic for ItemBrowser (PLAN.md §5,
// §9 Phase 4). No React, no Vite-specific imports — must run standalone under
// plain Node (see filter.test.mjs), same convention as tree.js.
//
// Everything here operates on "entries" of shape
//   { id, item, variantGroup, isVariantGroup, variants: [{ id, item }, ...] }
// produced by groupVariants() — a plain (non-grouped) item is just an entry
// whose `variants` array holds only itself. Filtering/sorting a single shape
// like this means the browser grid never has to special-case variant groups.
//
// Tier order is never hardcoded — every function that needs it takes the
// loaded game's manifest `tiers` list (`[{id, label, color}, ...]`, see
// src/lib/tier.js) as a parameter. A dataset with no tiers at all just passes
// an empty array and every tier-ordering call degrades to a stable no-op.

// Index of a tier id within a manifest's ordered `tiers` list. Unknown/
// missing tiers (including "no tiers at all") sort after every known one.
function tierIndex(tiers, tierId) {
  const idx = tiers.findIndex((tier) => tier.id === tierId);
  return idx === -1 ? tiers.length : idx;
}

const capitalize = (word) => {
  const str = String(word ?? '');
  return str ? str[0].toUpperCase() + str.slice(1) : str;
};

// --- Variant-group grouping ---------------------------------------------

/**
 * Group items sharing a `variantGroup` id into one entry exposing the full
 * variant list (sorted tier-ascending), keyed by the lowest-tier ("base")
 * variant. Items with no `variantGroup` become single-variant entries so
 * callers can treat every entry uniformly.
 *
 * @param {object} items - items map (src/data/<game>/items.json `.items`).
 * @param {Array<{id: string, label: string, color: string}>} [tiers] - the
 *   loaded game's manifest tier order (empty/omitted if the game has none).
 * @returns {Array<{id: string, item: object, variantGroup: string|null, isVariantGroup: boolean, variants: Array<{id: string, item: object}>}>}
 */
export function groupVariants(items, tiers = []) {
  const entries = [];
  const byGroup = new Map();

  for (const [id, item] of Object.entries(items)) {
    if (!item.variantGroup) {
      entries.push({ id, item, variantGroup: null, isVariantGroup: false, variants: [{ id, item }] });
      continue;
    }

    let group = byGroup.get(item.variantGroup);
    if (!group) {
      group = { id, item, variantGroup: item.variantGroup, isVariantGroup: false, variants: [] };
      byGroup.set(item.variantGroup, group);
      entries.push(group);
    }
    group.variants.push({ id, item });
  }

  for (const group of byGroup.values()) {
    group.variants.sort((a, b) => tierIndex(tiers, a.item.tier) - tierIndex(tiers, b.item.tier));
    const base = group.variants[0];
    group.id = base.id;
    group.item = base.item;
    // A `variantGroup` id with only one surviving member isn't really a
    // group — treat it like a plain item (no dots, no switcher) rather than
    // a group of one.
    group.isVariantGroup = group.variants.length > 1;
  }

  return entries;
}

/**
 * All items sharing `groupId`, sorted tier-ascending. Used by the tree view's
 * variant switcher (PLAN.md §5/§9) to build its tabs.
 *
 * @param {object} items
 * @param {string} groupId
 * @param {Array<{id: string, label: string, color: string}>} [tiers]
 * @returns {Array<{id: string, item: object}>}
 */
export function variantGroupMembers(items, groupId, tiers = []) {
  return Object.entries(items)
    .filter(([, item]) => item.variantGroup === groupId)
    .map(([id, item]) => ({ id, item }))
    .sort((a, b) => tierIndex(tiers, a.item.tier) - tierIndex(tiers, b.item.tier));
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
// Each returns a predicate over an entry (see groupVariants shape). A group
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

export function tierFilter(tierId) {
  if (!tierId) return () => true;
  return (entry) => entry.variants.some(({ item }) => item.tier === tierId);
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
 * @param {Array} entries - output of groupVariants().
 * @param {{search?: string, category?: string, tier?: string, craftableOnly?: boolean, station?: string}} [filters]
 */
export function filterEntries(entries, filters = {}) {
  const { search, category, tier, craftableOnly, station } = filters;
  const predicates = [
    textFilter(search),
    categoryFilter(category),
    tierFilter(tier),
    craftableFilter(craftableOnly),
    stationFilter(station),
  ];
  return entries.filter((entry) => predicates.every((predicate) => predicate(entry)));
}

// --- Sort comparators ---------------------------------------------------
// All operate on entries (variant-group-collapsed cards sort by their
// base/display item, matching what the card actually shows).

export function compareByName(a, b) {
  return a.item.name.localeCompare(b.item.name);
}

export function compareByCategory(a, b) {
  return (a.item.category ?? '').localeCompare(b.item.category ?? '') || compareByName(a, b);
}

/** Curried: needs the manifest's tier order, so it's built per game/render
 * rather than exported as a plain comparator. */
export function compareByTier(tiers = []) {
  return (a, b) => tierIndex(tiers, a.item.tier) - tierIndex(tiers, b.item.tier) || compareByName(a, b);
}

// Missing progression sorts last, regardless of direction.
export function compareByProgression(a, b) {
  const ap = a.item.progression;
  const bp = b.item.progression;
  if (ap == null && bp == null) return compareByName(a, b);
  if (ap == null) return 1;
  if (bp == null) return -1;
  return ap - bp || compareByName(a, b);
}

// --- Derived filter/sort-option lists ------------------------------------
// The browser's chip/dropdown option lists must reflect whatever dataset is
// actually loaded (16-item sample today, ~2000-item full scrape later, or a
// fixture game with none of this at all) — never a hardcoded list of
// categories/tiers/stations/sorts. This is what lets the tier chips, the
// progression sort, the variant switcher, and the station dropdown each
// disappear cleanly when the loaded data has none of that concept.

/**
 * Distinct categories present in the data, alphabetical.
 */
export function deriveCategories(items) {
  const present = new Set(Object.values(items).map((item) => item.category).filter(Boolean));
  return [...present].sort();
}

/**
 * Tier definitions actually present in the data, in the manifest's canonical
 * order (not alphabetical). Returns full `{id, label, color}` defs (not just
 * ids) since every caller needs them for rendering a chip/badge.
 *
 * @param {object} items
 * @param {Array<{id: string, label: string, color: string}>} [tiers] - the
 *   game's manifest tier list.
 */
export function deriveTiers(items, tiers = []) {
  const present = new Set(Object.values(items).map((item) => item.tier).filter(Boolean));
  return tiers.filter((tier) => present.has(tier.id));
}

/**
 * Stations actually referenced by at least one recipe, sorted by progression
 * (unknown-progression stations last) then name.
 */
export function deriveStations(items, stations) {
  const used = new Set();
  for (const item of Object.values(items)) {
    for (const stationId of item.recipe?.stations ?? []) {
      used.add(stationId);
    }
  }
  return [...used]
    .map((id) => ({ id, name: stations[id]?.name ?? id, progression: stations[id]?.progression }))
    .sort((a, b) => {
      const at = a.progression ?? Infinity;
      const bt = b.progression ?? Infinity;
      return at - bt || a.name.localeCompare(b.name);
    });
}

/**
 * Build the ordered sort-option map for ItemBrowser: `{ key: { label, compare } }`.
 * `manifest.sorts` (an ordered candidate list, e.g. `['name','category','tier','progression']`)
 * declares which sorts this GAME cares about; a sort is only actually offered
 * if the loaded DATA has something to sort by (no dead "sort by rarity" on a
 * dataset with no tiers). `name` is always included even if a manifest
 * omits it, since it's the only sort guaranteed to make sense for any data.
 *
 * @param {object} items
 * @param {{labels?: object, tiers?: Array, sorts?: string[]}} [manifest]
 */
export function deriveSorts(items, manifest = {}) {
  const labels = manifest.labels ?? {};
  const tiers = manifest.tiers ?? [];
  const wanted = manifest.sorts ?? ['name', 'category', 'tier', 'progression'];

  const hasTiers = deriveTiers(items, tiers).length > 0;
  const hasProgression = Object.values(items).some((item) => item.progression != null);

  const available = {
    name: { label: 'Name', compare: compareByName },
    category: { label: 'Category', compare: compareByCategory },
    tier: hasTiers ? { label: capitalize(labels.tier ?? 'tier'), compare: compareByTier(tiers) } : null,
    progression: hasProgression
      ? { label: labels.progression ?? 'Progression', compare: compareByProgression }
      : null,
  };

  const sorts = {};
  for (const key of wanted) {
    if (available[key]) sorts[key] = available[key];
  }
  if (!sorts.name) sorts.name = available.name;
  return sorts;
}
