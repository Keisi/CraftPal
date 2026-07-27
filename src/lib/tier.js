// Generic tier (rarity-equivalent) color language (PLAN.md §9). A game's
// manifest (`src/data/<game>/game.json`) declares an ordered `tiers` list of
// `{id, label, color}` — `color` is a TOKEN, never a raw Tailwind class
// string, because data must not be able to inject arbitrary classes and
// Tailwind's build-time scanner cannot see dynamically-assembled class names
// anyway. This module is the ONLY place a color token becomes an actual
// Tailwind class; every consumer (item-grid badges, tree-node borders,
// variant-switcher tabs) goes through here instead of hardcoding colors.
//
// Palworld's 5-tier ladder (common/uncommon/rare/epic/legendary ->
// gray/green/blue/purple/amber) is just data now — see
// src/data/palworld/game.json `tiers`. A game with no rarity concept simply
// omits `tiers`, and every consumer here degrades to the gray fallback (or,
// for the visible tier badge/chip, doesn't render at all — see
// TierBadge/TierChip in ItemBrowser.jsx).

const FALLBACK_COLOR = 'gray';

// Small chip styles (background/text/border) — used for the badge next to an
// item name.
const BADGE_STYLES = {
  gray: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
  green: 'bg-green-500/20 text-green-300 border-green-500/40',
  blue: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  purple: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  amber: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
};

// Heavier full-card border styles for tree nodes — same color family as the
// badges, just a stronger border weight/opacity since it outlines the whole
// card instead of a small pill.
const BORDER_STYLES = {
  gray: 'border-gray-500/70',
  green: 'border-green-500/70',
  blue: 'border-blue-500/70',
  purple: 'border-purple-500/70',
  amber: 'border-amber-500/70',
};

// Tiny solid dots (Phase 4, PLAN.md §5) — used on a collapsed variant-group
// card to show which tiers exist without spelling each one out.
const DOT_STYLES = {
  gray: 'bg-gray-400',
  green: 'bg-green-400',
  blue: 'bg-blue-400',
  purple: 'bg-purple-400',
  amber: 'bg-amber-400',
};

/**
 * Full tier definition for a tier id, looked up in a manifest's `tiers` list.
 * Returns null when there's no tier data at all (game has no rarity concept)
 * or the id isn't one of the declared tiers — callers use that to hide a
 * dead control rather than render a meaningless badge.
 *
 * @param {Array<{id: string, label: string, color: string}>} [tiers]
 * @param {string} [tierId]
 */
export function findTier(tiers, tierId) {
  if (!tierId || !Array.isArray(tiers) || tiers.length === 0) return null;
  return tiers.find((tier) => tier.id === tierId) ?? null;
}

/** Convenience: just the color token for a tier id (null if unknown/absent). */
export function tierColor(tiers, tierId) {
  return findTier(tiers, tierId)?.color ?? null;
}

export function tierBadgeClass(color) {
  return BADGE_STYLES[color] ?? BADGE_STYLES[FALLBACK_COLOR];
}

export function tierBorderClass(color) {
  return BORDER_STYLES[color] ?? BORDER_STYLES[FALLBACK_COLOR];
}

export function tierDotClass(color) {
  return DOT_STYLES[color] ?? DOT_STYLES[FALLBACK_COLOR];
}
