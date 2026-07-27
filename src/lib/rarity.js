// Shared rarity color language (PLAN.md §5) — single source of truth so the
// item-grid badges (App.jsx) and the crafting-tree node borders (TreeNode.jsx)
// never drift out of sync. Palworld convention: common=gray, uncommon=green,
// rare=blue, epic=purple, legendary=amber.

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// Small chip styles (background/text/border) — used for the badge next to an
// item name.
const BADGE_STYLES = {
  common: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
  uncommon: 'bg-green-500/20 text-green-300 border-green-500/40',
  rare: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  epic: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  legendary: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
};

// Heavier full-card border styles for tree nodes — same color family as the
// badges, just a stronger border weight/opacity since it outlines the whole
// card instead of a small pill.
const BORDER_STYLES = {
  common: 'border-gray-500/70',
  uncommon: 'border-green-500/70',
  rare: 'border-blue-500/70',
  epic: 'border-purple-500/70',
  legendary: 'border-amber-500/70',
};

export function rarityBadgeClass(rarity) {
  return BADGE_STYLES[rarity] ?? BADGE_STYLES.common;
}

export function rarityBorderClass(rarity) {
  return BORDER_STYLES[rarity] ?? BORDER_STYLES.common;
}
