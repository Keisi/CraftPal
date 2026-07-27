import { useGame } from '../lib/GameContext.js';
import { ItemIcon } from './ItemIcon.jsx';

// Lowest-progression station among a recipe's accepted stations (PLAN.md §5:
// "UI shows the lowest-tech one by default"). Shared by both tree views.
// Missing progression numbers (a game with no such concept) degrade to "first
// listed station wins" rather than crashing or picking inconsistently.
function lowestProgressionStationId(stations, stationIds) {
  if (!stationIds || stationIds.length === 0) return null;
  return stationIds.reduce((lowestId, id) => {
    const station = stations[id];
    if (!station) return lowestId;
    const lowest = lowestId ? stations[lowestId] : null;
    if (!lowest) return id;
    const stationRank = station.progression ?? Infinity;
    const lowestRank = lowest.progression ?? Infinity;
    return stationRank < lowestRank ? id : lowestId;
  }, null);
}

// Every accepted station, cheapest progression first — the chip's hover text.
// A station with no progression number just shows its name (no "(Tech
// undefined)").
function stationTitle(stations, stationIds) {
  return stationIds
    .map((id) => stations[id])
    .filter(Boolean)
    .sort((a, b) => (a.progression ?? Infinity) - (b.progression ?? Infinity))
    .map((s) => (s.progression != null ? `${s.name} (Tech ${s.progression})` : s.name))
    .join('\n');
}

export function StationChip({ stationIds, compact = false }) {
  const { stations } = useGame();
  const lowestId = lowestProgressionStationId(stations, stationIds);
  if (!lowestId) return null;
  const lowest = stations[lowestId];

  return (
    <div
      title={stationTitle(stations, stationIds)}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 text-zinc-400 shadow-sm ${
        compact ? 'max-w-[11rem] px-1.5 py-0.5 text-[10px]' : 'max-w-[9rem] px-2 py-1 text-[11px]'
      }`}
    >
      <ItemIcon src={lowest.icon} alt={lowest.name} className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      <span className="truncate">{lowest.name}</span>
    </div>
  );
}
