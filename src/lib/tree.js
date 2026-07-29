// Pure crafting-tree logic (PLAN.md §4). No React, no Vite-specific imports —
// must run standalone under plain Node (see tree.test.mjs).

// schema v3 axis 2 (PLAN.md §1 decision 1 / CLAUDE.md "one recipe per item"):
// `item.recipe` (single object) is now `item.recipes` (array, sorted cheapest-
// in-raw-resources first). `recipes[0]` is the primary and every consumer
// defaults to it. The leaf test everywhere is "no recipes, or an empty
// recipes array" — absent beats empty (a raw material has no `recipes` key
// at all; scripts/validate-data.mjs hard-errors on a present-but-empty one).

export const ROOT_PATH = 'r';

/**
 * Stable identity for a node's position in the tree. Collapse state (and, as
 * of axis 2, the per-node recipe-switcher choice) is keyed by position, not
 * itemId — the same ingredient can appear at several places in one tree (Coal
 * under both Refined Ingot and Carbon Fiber), and folding/switching one must
 * not affect the others.
 *
 * @param {string} parentPath
 * @param {number} index - child index within the parent.
 * @returns {string}
 */
export function childPath(parentPath, index) {
  return `${parentPath}.${index}`;
}

/**
 * Recursively build the crafting tree for `itemId` needing `qty` total units.
 *
 * @param {object} items - the loaded items map (src/data/items.json `.items`).
 * @param {string} itemId - id of the item to expand.
 * @param {number} [qty=1] - total amount of this item needed.
 * @param {Set<string>} [visited=new Set()] - ancestor chain, for cycle guarding.
 * @param {string} [path=ROOT_PATH] - this node's position, for recipeChoices lookup.
 * @param {Map<string, number>} [recipeChoices=new Map()] - per-node recipe
 *   switcher state (App, keyed by node path exactly like collapse state):
 *   path -> index into that node's `recipes` array. A missing/out-of-range
 *   entry defaults to 0 (the primary/cheapest recipe) — decision 1's "the app
 *   defaults to recipes[0] everywhere".
 * @returns {{itemId: string, qty: number, crafts: number, stations: string[]|null, yields: number|null, children: object[]}}
 */
export function buildTree(items, itemId, qty = 1, visited = new Set(), path = ROOT_PATH, recipeChoices = new Map()) {
  const exists = Object.hasOwn(items, itemId);
  const item = exists ? items[itemId] : undefined;
  const recipes = item?.recipes;

  // Leaf cases: unknown id, raw material (no recipes, or an empty array —
  // shouldn't happen per validate-data.mjs, but never trusted blindly), or
  // cycle detected.
  if (!exists || !recipes || recipes.length === 0 || visited.has(itemId)) {
    return { itemId, qty, crafts: 0, stations: null, yields: null, children: [] };
  }

  // Per-node override (the recipe switcher, PLAN.md §1 decision 4): clamp so
  // a stale choice (e.g. left over after the underlying data changed) never
  // indexes out of bounds — falls back to the primary rather than throwing.
  const requested = recipeChoices.get(path) ?? 0;
  const recipeIndex = requested >= 0 && requested < recipes.length ? requested : 0;
  const recipe = recipes[recipeIndex];

  const yields = recipe.yields ?? 1;
  const crafts = Math.ceil(qty / yields);

  // Cycle guard: copy the visited set per branch (siblings share this copy,
  // deeper recursion copies again from here) — exactly PLAN.md §4.
  const next = new Set(visited).add(itemId);

  // schema v3 axis 1 ("any of a set" ingredients, PLAN.md §1 decision 3):
  // `anyOf`/`anyOfLabel` live on the INGREDIENT SLOT (this parent's use of
  // this child), not on the item itself, so they're attached to the returned
  // child node after recursion — never read by buildTree's own math. `item`
  // stays the sole representative that expansion and quantities follow;
  // this is purely additive UI truth about substitutability layered on top.
  const children = recipe.ingredients.map((ingredient, index) => {
    const child = buildTree(
      items,
      ingredient.item,
      ingredient.qty * crafts,
      next,
      childPath(path, index),
      recipeChoices,
    );
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
    yields,
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
