import { useMemo } from 'react';
import { useGame } from '../lib/GameContext.js';
import { buildDropIndex, palsForItem } from '../lib/drops.js';
import { ItemIcon } from './ItemIcon.jsx';

// "Dropped by" panel (PLAN.md §8's whole reason the map feature exists: a
// raw material you can't craft should answer "where do I farm this?").
// Reverse-indexes the loaded pals.json's drops (src/lib/drops.js) and shows
// every pal that drops this item, each with a jump straight to that pal's
// habitat on the map — but only when the loaded game actually has map +
// habitat data (manifest.datasets, PLAN.md §9: a game with no map dataset
// must show no dead "View on map" button, not a disabled one).
//
// Renders nothing at all when nothing drops this item — including for a game
// with no pals dataset (useGame().pals is then undefined, buildDropIndex
// degrades to an empty index) — same "optional feature disappears cleanly"
// discipline as the tier chips/station chip/variant switcher.
export function DroppedBy({ itemId, onShowOnMap }) {
  const { pals } = useGame();
  const dropIndex = useMemo(() => buildDropIndex(pals), [pals]);
  const drops = palsForItem(dropIndex, itemId);

  if (drops.length === 0) return null;

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/30 px-6 py-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Dropped by</div>
      <div className="flex flex-wrap gap-2">
        {drops.map((pal) => (
          <div
            key={pal.code}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/60 py-1.5 pl-1.5 pr-2.5"
          >
            <ItemIcon src={pal.icon} alt={pal.name} className="h-8 w-8" />
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-medium text-zinc-100">{pal.name}</span>
              <span className="text-[11px] text-zinc-400">
                {pal.rate}
                {pal.qty ? ` ×${pal.qty}` : ''}
              </span>
            </div>
            {onShowOnMap && pal.hasHabitat && (
              <button
                type="button"
                onClick={() => onShowOnMap(pal.code)}
                title={`Show ${pal.name}'s habitat on the map`}
                className="ml-1 rounded-md border border-emerald-600/60 bg-emerald-600/10 px-2 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:border-emerald-500 hover:bg-emerald-600/20 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-zinc-500"
              >
                View on map
              </button>
            )}
            {!pal.hasHabitat && <span className="ml-1 text-[11px] text-zinc-500">no known habitat</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
