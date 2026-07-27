// Pure crafting-tree logic (PLAN.md §4). No React, no Vite-specific imports —
// must run standalone under plain Node (see tree.test.mjs).

/**
 * Recursively build the crafting tree for `itemId` needing `qty` total units.
 *
 * @param {object} items - the loaded items map (src/data/items.json `.items`).
 * @param {string} itemId - id of the item to expand.
 * @param {number} [qty=1] - total amount of this item needed.
 * @param {Set<string>} [visited=new Set()] - ancestor chain, for cycle guarding.
 * @returns {{itemId: string, qty: number, crafts: number, stations: string[]|null, children: object[]}}
 */
export function buildTree(items, itemId, qty = 1, visited = new Set()) {
  const exists = Object.hasOwn(items, itemId);
  const item = exists ? items[itemId] : undefined;

  // Leaf cases: unknown id, raw material (no recipe), or cycle detected.
  if (!exists || !item.recipe || visited.has(itemId)) {
    return { itemId, qty, crafts: 0, stations: null, children: [] };
  }

  const { recipe } = item;
  const crafts = Math.ceil(qty / (recipe.yields ?? 1));

  // Cycle guard: copy the visited set per branch (siblings share this copy,
  // deeper recursion copies again from here) — exactly PLAN.md §4.
  const next = new Set(visited).add(itemId);

  const children = recipe.ingredients.map((ingredient) =>
    buildTree(items, ingredient.item, ingredient.qty * crafts, next)
  );

  return {
    itemId,
    qty,
    crafts,
    stations: recipe.stations,
    children,
  };
}

/**
 * Walk a tree built by buildTree() and sum the qty of every leaf node
 * (children.length === 0) per itemId — the "RAW MATERIALS" totals strip.
 *
 * @param {object} node - a buildTree() node.
 * @param {Map<string, number>} [totals=new Map()] - accumulator (mutated + returned).
 * @returns {Map<string, number>}
 */
export function aggregateRaw(node, totals = new Map()) {
  if (node.children.length === 0) {
    totals.set(node.itemId, (totals.get(node.itemId) ?? 0) + node.qty);
  }
  node.children.forEach((child) => aggregateRaw(child, totals));
  return totals;
}
