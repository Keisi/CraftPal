import { useGame } from '../lib/GameContext.js';
import { ItemIcon } from './ItemIcon.jsx';

// Per-node recipe switcher (schema v3 axis 2 payoff, PLAN.md §1 decisions 1/4/5):
// an item can now carry SEVERAL complete recipes (`item.recipes`, sorted
// cheapest-in-raw-resources first) instead of silently keeping only the
// primary — this is what makes every alternate actually reachable. Modeled on
// VariantSwitcher.jsx's tab pattern, but a details/summary disclosure (like
// AnyOfChip) rather than a row of pills: a tight w-36 node card has no room
// for a dozen pills side by side, and some real items have that many
// alternates (Palworld's Paldium Fragment: 13, once every dropped alternate
// is kept rather than logged-and-discarded).
//
// Keyed by node PATH (App, exactly like collapse state and tree.js's
// `recipeChoices`) — never by itemId — because the same item can appear at
// several tree positions and each must switch independently (decision 4).
// An item with only ONE recipe renders nothing at all — same "no dead
// controls" rule as tiers/progression/the variant switcher (decision 5).
export function RecipeSwitcher({ recipes, activeIndex, onSelect, compact = false }) {
  const { items, stations } = useGame();

  if (!Array.isArray(recipes) || recipes.length < 2) return null;

  const active = activeIndex >= 0 && activeIndex < recipes.length ? activeIndex : 0;

  const summarize = (recipe) =>
    recipe.ingredients
      .map((ing) => `${ing.qty}x ${items[ing.item]?.name ?? ing.item}`)
      .join(' + ');

  const stationNames = (recipe) =>
    (recipe.stations ?? []).map((id) => stations[id]?.name ?? id).join(' / ') || 'No station';

  return (
    <details
      className="group relative"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary
        title="This item has more than one known recipe — click to choose which one to build"
        className={`inline-flex cursor-pointer list-none items-center gap-1 rounded-full border border-dashed border-emerald-700/60 bg-emerald-900/20 text-emerald-300 transition-colors hover:border-emerald-500 hover:text-emerald-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 [&::-webkit-details-marker]:hidden ${
          compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
        }`}
      >
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        {recipes.length} recipes
      </summary>

      <div
        role="tablist"
        aria-label="Recipe"
        className="absolute left-0 top-full z-10 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-1.5 text-left shadow-lg"
      >
        <ul className="flex flex-col gap-1">
          {recipes.map((recipe, index) => {
            const isActive = index === active;
            return (
              <li key={index}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelect(index)}
                  className={`flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? 'border-emerald-500 bg-emerald-900/30 text-emerald-100'
                      : 'border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1 font-medium">
                    Recipe {index + 1}
                    {isActive && <span className="text-[10px] font-normal text-emerald-400">(active)</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-1 text-[11px] text-zinc-400">
                    {recipe.ingredients.map((ing) => (
                      <span key={ing.item} className="inline-flex items-center gap-0.5">
                        <ItemIcon src={items[ing.item]?.icon} alt="" className="h-3.5 w-3.5" />
                        {ing.qty}× {items[ing.item]?.name ?? ing.item}
                      </span>
                    ))}
                  </span>
                  <span className="text-[10px] text-zinc-500" title={summarize(recipe)}>
                    {stationNames(recipe)}
                    {recipe.yields > 1 && ` · yields ${recipe.yields}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
