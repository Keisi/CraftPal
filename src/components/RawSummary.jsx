import { useMemo } from 'react';
import { items } from '../lib/data.js';
import { aggregateRaw } from '../lib/tree.js';
import { ItemIcon } from './ItemIcon.jsx';

// Sticky bottom "RAW MATERIALS" strip (PLAN.md §5), mirroring the reference
// NMS-style infographic's totals panel. The tree is built once by the caller
// (App, Phase 4 deferred refactor) and shared with CraftTree; RawSummary just
// aggregates it.
export function RawSummary({ tree }) {
  const totals = useMemo(() => {
    const raw = aggregateRaw(tree);
    return [...raw.entries()].sort((a, b) => b[1] - a[1]);
  }, [tree]);

  if (totals.length === 0) return null;

  return (
    <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-900/95 px-6 py-3 backdrop-blur">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        Raw materials
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {totals.map(([id, totalQty]) => {
          const item = items[id];
          return (
            <div
              key={id}
              className="flex shrink-0 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5"
            >
              <ItemIcon src={item?.icon} alt={item?.name ?? id} className="h-8 w-8" />
              <div className="flex flex-col leading-tight">
                <span className="whitespace-nowrap text-xs font-medium text-zinc-100">
                  {item?.name ?? id}
                </span>
                <span className="text-[11px] text-zinc-400">×{totalQty.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
