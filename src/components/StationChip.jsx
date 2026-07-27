import { stations } from '../lib/data.js';
import { ItemIcon } from './ItemIcon.jsx';

// Lowest-techLevel station among a recipe's accepted stations (PLAN.md §5:
// "UI shows the lowest-tech one by default"). Shared by both tree views.
function lowestTechStationId(stationIds) {
  if (!stationIds || stationIds.length === 0) return null;
  return stationIds.reduce((lowestId, id) => {
    const station = stations[id];
    if (!station) return lowestId;
    const lowest = lowestId ? stations[lowestId] : null;
    if (!lowest || station.techLevel < lowest.techLevel) return id;
    return lowestId;
  }, null);
}

export function StationChip({ stationIds, compact = false }) {
  const lowestId = lowestTechStationId(stationIds);
  if (!lowestId) return null;
  const lowest = stations[lowestId];

  const title = stationIds
    .map((id) => stations[id])
    .filter(Boolean)
    .sort((a, b) => a.techLevel - b.techLevel)
    .map((s) => `${s.name} (Tech ${s.techLevel})`)
    .join('\n');

  return (
    <div
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 text-zinc-400 shadow-sm ${
        compact ? 'max-w-[11rem] px-1.5 py-0.5 text-[10px]' : 'max-w-[9rem] px-2 py-1 text-[11px]'
      }`}
    >
      <ItemIcon src={lowest.icon} alt={lowest.name} className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      <span className="truncate">{lowest.name}</span>
    </div>
  );
}
