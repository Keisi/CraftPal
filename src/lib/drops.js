// Reverse index: item -> which pals drop it (PLAN.md §8: "item -> which pals
// drop it -> where they live", the whole reason the map feature exists — a
// raw material you can't craft should answer "where do I farm this?"). Pure,
// no React, no Vite-specific imports — must run standalone under plain Node
// (see drops.test.mjs), same convention as tree.js/filter.js.

/**
 * Build item -> pals-that-drop-it, from the loaded game's pals map
 * (src/data/<game>/pals.json `.pals`, keyed by pal code). A game with no
 * pals dataset at all just passes `{}` (or undefined) and gets an empty
 * index back — every consumer degrades to "nothing dropped this" rather
 * than throwing.
 *
 * @param {object} [pals] - `{ [code]: { name, icon, drops: [{item, name, rate, qty}], hasHabitat } }`.
 * @returns {Map<string, Array<{code: string, name: string, icon: string, rate: string, qty: string, hasHabitat: boolean}>>}
 */
export function buildDropIndex(pals) {
  const index = new Map();
  for (const [code, pal] of Object.entries(pals ?? {})) {
    for (const drop of pal?.drops ?? []) {
      if (!drop?.item) continue;
      const list = index.get(drop.item) ?? [];
      list.push({
        code,
        name: pal.name ?? code,
        icon: pal.icon,
        rate: drop.rate,
        qty: drop.qty,
        hasHabitat: Boolean(pal.hasHabitat),
      });
      index.set(drop.item, list);
    }
  }
  return index;
}

/**
 * Pals dropping a given item id, or [] if none/unknown — never throws on a
 * missing index entry.
 *
 * @param {Map<string, Array>} dropIndex - output of buildDropIndex().
 * @param {string} itemId
 * @returns {Array}
 */
export function palsForItem(dropIndex, itemId) {
  return dropIndex?.get(itemId) ?? [];
}
