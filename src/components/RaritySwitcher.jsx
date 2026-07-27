import { familyVariants } from '../lib/filter.js';
import { rarityBadgeClass } from '../lib/rarity.js';

// Rarity switcher on the tree view (PLAN.md §5): when the selected item has a
// `family`, show one color-coded tab per existing variant; clicking a tab
// swaps the whole tree to that variant's recipe. Qty is preserved because the
// caller (App) only changes `selectedId`, never `qty`, in its onSelect.
export function RaritySwitcher({ items, currentId, onSelect }) {
  const current = items[currentId];
  if (!current?.family) return null;

  const variants = familyVariants(items, current.family);
  if (variants.length <= 1) return null;

  return (
    <div role="tablist" aria-label="Rarity variant" className="flex flex-wrap items-center gap-1.5">
      {variants.map(({ id, item }) => {
        const active = id === currentId;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(id)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-opacity ${rarityBadgeClass(item.rarity)} ${
              active ? 'opacity-100 ring-2 ring-zinc-100 ring-offset-1 ring-offset-zinc-950' : 'opacity-50 hover:opacity-90'
            }`}
          >
            {item.rarity}
          </button>
        );
      })}
    </div>
  );
}
