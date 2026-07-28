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

  // schema v3 axis 1 ("any of a set" ingredients, PLAN.md §1 decision 3):
  // `anyOf`/`anyOfLabel` live on the INGREDIENT SLOT (this parent's use of
  // this child), not on the item itself, so they're attached to the returned
  // child node after recursion — never read by buildTree's own math. `item`
  // stays the sole representative that expansion and quantities follow;
  // this is purely additive UI truth about substitutability layered on top.
  const children = recipe.ingredients.map((ingredient) => {
    const child = buildTree(items, ingredient.item, ingredient.qty * crafts, next);
    if (ingredient.anyOf) {
      child.anyOf = ingredient.anyOf;
      if (ingredient.anyOfLabel) child.anyOfLabel = ingredient.anyOfLabel;
    }
    return child;
  });

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

/**
 * Stable identity for a node's position in the tree. Collapse state is keyed
 * by position, not itemId — the same ingredient can appear at several places
 * in one tree (Coal under both Refined Ingot and Carbon Fiber), and folding
 * one must not fold the others.
 *
 * @param {string} parentPath
 * @param {number} index - child index within the parent.
 * @returns {string}
 */
export function childPath(parentPath, index) {
  return `${parentPath}.${index}`;
}

export const ROOT_PATH = 'r';

/**
 * Every node path that can be folded (i.e. has children), for "collapse all".
 *
 * @param {object} node - a buildTree() node.
 * @param {string} [path=ROOT_PATH]
 * @param {string[]} [out=[]] - accumulator (mutated + returned).
 * @returns {string[]}
 */
export function collapsiblePaths(node, path = ROOT_PATH, out = []) {
  if (node.children.length === 0) return out;
  out.push(path);
  node.children.forEach((child, index) => collapsiblePaths(child, childPath(path, index), out));
  return out;
}
