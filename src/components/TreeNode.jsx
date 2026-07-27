import data from '../data/items.json';
import stationsData from '../data/stations.json';
import { ItemIcon } from './ItemIcon.jsx';
import { rarityBorderClass } from '../lib/rarity.js';

const items = data.items;

// Lowest-techLevel station among a recipe's accepted stations (PLAN.md §5:
// "UI shows the lowest-tech one by default").
function lowestTechStationId(stationIds) {
  if (!stationIds || stationIds.length === 0) return null;
  return stationIds.reduce((lowestId, id) => {
    const station = stationsData[id];
    if (!station) return lowestId;
    const lowest = lowestId ? stationsData[lowestId] : null;
    if (!lowest || station.techLevel < lowest.techLevel) return id;
    return lowestId;
  }, null);
}

function StationChip({ stationIds }) {
  const lowestId = lowestTechStationId(stationIds);
  if (!lowestId) return null;
  const lowest = stationsData[lowestId];

  const title = stationIds
    .map((id) => stationsData[id])
    .filter(Boolean)
    .sort((a, b) => a.techLevel - b.techLevel)
    .map((s) => `${s.name} (Tech ${s.techLevel})`)
    .join('\n');

  return (
    <div
      title={title}
      className="flex max-w-[9rem] items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-300 shadow-sm"
    >
      <ItemIcon src={lowest.icon} alt={lowest.name} className="h-4 w-4" />
      <span className="truncate">{lowest.name}</span>
    </div>
  );
}

function NodeCard({ node }) {
  const item = items[node.itemId];
  const name = item?.name ?? node.itemId;
  const rarity = item?.rarity ?? 'common';
  const isCrafted = node.stations !== null;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`flex w-36 flex-col items-center gap-2 rounded-lg border-2 bg-zinc-900 p-3 shadow-sm ${rarityBorderClass(rarity)}`}
      >
        <div className="relative">
          <ItemIcon src={item?.icon} alt={name} className="h-14 w-14" />
          <span className="absolute -bottom-1.5 -right-1.5 rounded-full border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-zinc-100">
            ×{node.qty.toLocaleString()}
          </span>
        </div>
        <span className="line-clamp-2 text-center text-xs font-medium leading-snug text-zinc-100">
          {name}
        </span>
      </div>

      {isCrafted && <StationChip stationIds={node.stations} />}
    </div>
  );
}

// Recursive crafting-tree node (PLAN.md §5). Renders as a plain <li> — the
// caller (CraftTree, or a parent TreeNode) is responsible for the wrapping
// <ul>; connector lines are drawn by plain CSS in src/index.css against the
// resulting ul/li nesting.
export function TreeNode({ node }) {
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <NodeCard node={node} />
      {hasChildren && (
        <ul>
          {node.children.map((child, index) => (
            <TreeNode key={`${child.itemId}-${index}`} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
