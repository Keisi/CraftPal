import { useMemo } from 'react';
import { useGame } from '../lib/GameContext.js';
import { aggregateRaw } from '../lib/tree.js';
import { ItemIcon } from './ItemIcon.jsx';

// Presentational sticky-bottom "RAW MATERIALS" strip (PLAN.md §5), mirroring
// the reference NMS-style infographic's totals panel. Shared by RawSummary
// (aggregates a crafting tree) and TasksView's "raw materials to gather"
// section (aggregates a craftPlan()'s `raw` list) — same look, two different
// sources for the `entries`.
//
// @param {{itemId: string, qty: number}[]} entries - already sorted by caller.
// @param {string} [title]
export function RawMaterialsStrip({ entries, title = 'Raw materials' }) {
  const { items } = useGame();
  if (entries.length === 0) return null;

  return (
    <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-900/95 px-6 py-3 backdrop-blur">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {entries.map(({ itemId, qty }) => {
          const item = items[itemId];
          return (
            <div
              key={itemId}
              className="flex shrink-0 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5"
            >
              <ItemIcon src={item?.icon} alt={item?.name ?? itemId} className="h-8 w-8" />
              <div className="flex flex-col leading-tight">
                <span className="whitespace-nowrap text-xs font-medium text-zinc-100">
                  {item?.name ?? itemId}
                </span>
                <span className="text-[11px] text-zinc-400">×{qty.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The tree is built once by the caller (App, Phase 4 deferred refactor) and
// shared with CraftTree; RawSummary just aggregates it into entries and hands
// off to RawMaterialsStrip for the actual render.
export function RawSummary({ tree }) {
  const entries = useMemo(() => {
    const raw = aggregateRaw(tree);
    return [...raw.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([itemId, qty]) => ({ itemId, qty }));
  }, [tree]);

  return <RawMaterialsStrip entries={entries} />;
}
