import { variantGroupMembers } from '../lib/filter.js';
import { findTier, tierBadgeClass } from '../lib/tier.js';

// Variant switcher on the tree view (PLAN.md §5/§9): when the selected item
// has a `variantGroup`, show one color-coded tab per existing variant
// (Palworld's variant groups happen to be rarity tiers, e.g. Common ->
// Legendary versions of one weapon; a different game's variant groups need
// not be tier-based at all — this only uses tier styling when the variant
// actually has a tier). Clicking a tab swaps the whole tree to that variant's
// recipe. Qty is preserved because the caller (App) only changes
// `selectedId`, never `qty`, in its onSelect.
export function VariantSwitcher({ items, tiers, currentId, onSelect }) {
  const current = items[currentId];
  if (!current?.variantGroup) return null;

  const variants = variantGroupMembers(items, current.variantGroup, tiers);
  if (variants.length <= 1) return null;

  return (
    <div role="tablist" aria-label="Variant" className="flex flex-wrap items-center gap-1.5">
      {variants.map(({ id, item }) => {
        const active = id === currentId;
        const tier = findTier(tiers, item.tier);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(id)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-opacity ${tierBadgeClass(tier?.color)} ${
              active ? 'opacity-100 ring-2 ring-zinc-100 ring-offset-1 ring-offset-zinc-950' : 'opacity-50 hover:opacity-90'
            }`}
          >
            {tier?.label ?? item.tier ?? id}
          </button>
        );
      })}
    </div>
  );
}
