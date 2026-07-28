// Pure crafting-tasks logic (crafting-tasks feature). No React, no
// Vite-specific imports — must run standalone under plain Node (see
// plan.test.mjs), same convention as tree.js/filter.js.
//
// A "task list" is `[{ itemId, qty }]` — items the user wants to end up with
// (e.g. "5x Advanced Arrow"). aggregateRequirements() merges the full
// ingredient trees of every target (every node, not just leaves) into one
// Map<itemId, totalQty>, which is what lets two targets that both need Carbon
// Fiber collapse into a single combined total. craftPlan() turns that into an
// ordered, dependency-safe list of craft steps plus a raw-materials shopping
// list — the "1. craft 5x Carbon Fiber, 2. craft 2x Plasteel" the user asked
// for.
//
// schema v3 axis 1 ("any of a set" ingredients, PLAN.md §1 decision 3):
// deliberately NOT surfaced here. `anyOf`/`anyOfLabel` live on one ingredient
// SLOT — one parent's specific use of one child — but both `steps` and `raw`
// aggregate a single itemId's qty across the WHOLE task list, merging every
// slot that ever needed it. The same raw material can be reached through two
// different anyOf sets in one plan (e.g. a Campfire's direct log slot pulls
// from the 48-member `logs` tag, while its Charcoal ingredient's own log slot
// pulls from the 40-member `logs_that_burn` tag — both currently resolve to
// the same representative id) — there is no single honest anyOf to attach to
// the merged total without misrepresenting one of those sets as the other.
// buildTree()/tree.js keep anyOf at the per-occurrence node level, where it's
// unambiguous; aggregateRequirements()/craftPlan() only ever read `.item`/
// `.qty` off a recipe's ingredients, so `anyOf`'s presence has zero effect on
// any number here (see plan.test.mjs's regression guard).

import { buildTree } from './tree.js';

function sumNode(node, totals) {
  totals.set(node.itemId, (totals.get(node.itemId) ?? 0) + node.qty);
  node.children.forEach((child) => sumNode(child, totals));
  return totals;
}

/**
 * Sum every node's qty (not just leaves) across every target's buildTree,
 * keyed by itemId. This merges shared intermediates both across targets
 * (two different targets needing Carbon Fiber) and across branches of the
 * same target (an ingredient needed by two different sub-recipes).
 *
 * @param {object} items - the loaded items map (src/data/items.json `.items`).
 * @param {Array<{itemId: string, qty: number}>} targets
 * @returns {Map<string, number>} total qty needed of each itemId, across the
 *   whole task list (includes craftable intermediates AND raw leaves AND the
 *   targets themselves).
 */
export function aggregateRequirements(items, targets) {
  const totals = new Map();
  for (const { itemId, qty } of targets) {
    sumNode(buildTree(items, itemId, qty), totals);
  }
  return totals;
}

/**
 * Build an ordered, deduplicated craft plan for a task list.
 *
 * `steps` is a DFS post-order walk over the recipe graph, rooted at each
 * target in turn, sharing one visited set across all targets — the same
 * cycle-safe discipline as buildTree. Every craftable ingredient a step needs
 * is pushed to `steps` before the step itself, so working the list
 * top-to-bottom never asks you to craft something before its ingredients
 * exist. The shared visited set also means a shared intermediate (e.g. Carbon
 * Fiber needed by two different targets) is pushed exactly once, carrying its
 * combined qty from aggregateRequirements.
 *
 * Design note: dependency order is the strict guarantee — an item is always
 * pushed after every craftable ingredient it needs, full stop. "Targets come
 * last" (PLAN ask) falls out of that naturally in the normal case (a target
 * is never itself a required ingredient of another target's chain): each
 * target's own dependencies get pushed while its subtree is walked, so the
 * target itself always lands after them. If a target ever *is* consumed
 * inside another target's tree (unusual, but not disallowed by the data),
 * correct crafting order still wins over the cosmetic tail position.
 *
 * @param {object} items - the loaded items map (src/data/items.json `.items`).
 * @param {Array<{itemId: string, qty: number}>} targets
 * @returns {{
 *   steps: Array<{itemId: string, qty: number, crafts: number, yields: number, stations: string[]}>,
 *   raw: Array<{itemId: string, qty: number}>,
 *   targets: Array<{itemId: string, qty: number}>,
 * }}
 */
export function craftPlan(items, targets) {
  const totals = aggregateRequirements(items, targets);
  const steps = [];
  const visited = new Set();

  function visit(itemId) {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const exists = Object.hasOwn(items, itemId);
    const item = exists ? items[itemId] : undefined;

    // Raw material or unknown id: not a craft step, and not something we can
    // walk further into — leave it for the raw shopping list (or drop it
    // silently if it's not even a known item).
    if (!exists || !item.recipe) return;

    item.recipe.ingredients.forEach((ingredient) => visit(ingredient.item));

    const yields = item.recipe.yields ?? 1;
    const qty = totals.get(itemId) ?? 0;
    steps.push({
      itemId,
      qty,
      crafts: Math.ceil(qty / yields),
      yields,
      stations: item.recipe.stations,
    });
  }

  targets.forEach(({ itemId }) => visit(itemId));

  // Shopping list: every total that's a genuine raw material (known item,
  // no recipe) — craftables are already covered by `steps`, and completely
  // unknown ids are skipped rather than shown as a mystery card.
  const raw = [...totals.entries()]
    .filter(([itemId]) => Object.hasOwn(items, itemId) && !items[itemId].recipe)
    .map(([itemId, qty]) => ({ itemId, qty }))
    .sort((a, b) => b.qty - a.qty);

  return { steps, raw, targets };
}
