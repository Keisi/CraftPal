import { items } from '../lib/data.js';
import { childPath } from '../lib/tree.js';
import { ItemIcon } from './ItemIcon.jsx';
import { StationChip } from './StationChip.jsx';
import { rarityBorderClass } from '../lib/rarity.js';

// Per-node collapse (Phase 4, PLAN.md §5): clicking a node card that has
// children folds/unfolds its subtree. View-only — the qty badge is always
// computed from the full tree regardless of fold state, so re-expanding
// never has to recompute anything. Collapse state is owned by App (keyed by
// node path) so collapse/expand-all and the view toggle share it.
function NodeCard({ node, hasChildren, collapsed, onToggle }) {
  const item = items[node.itemId];
  const name = item?.name ?? node.itemId;
  const rarity = item?.rarity ?? 'common';
  const isCrafted = node.stations !== null;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        role={hasChildren ? 'button' : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onClick={hasChildren ? onToggle : undefined}
        onKeyDown={
          hasChildren
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        title={hasChildren ? (collapsed ? 'Expand ingredients' : 'Collapse ingredients') : undefined}
        className={`relative flex w-36 flex-col items-center gap-2 rounded-lg border-2 bg-zinc-900 p-3 shadow-sm ${rarityBorderClass(rarity)} ${
          hasChildren
            ? 'cursor-pointer hover:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-500'
            : ''
        }`}
      >
        {hasChildren && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 text-xs leading-none text-zinc-400"
          >
            {collapsed ? '▸' : '▾'}
          </span>
        )}

        <div className="relative">
          <ItemIcon src={item?.icon} alt={name} className="h-14 w-14" />
          <span className="absolute -bottom-1.5 -right-1.5 rounded-full border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-zinc-100">
            ×{node.qty.toLocaleString()}
          </span>
        </div>

        <span className="line-clamp-2 text-center text-xs font-medium leading-snug text-zinc-100">
          {name}
        </span>

        {hasChildren && collapsed && (
          <span className="text-[10px] text-zinc-500">
            +{node.children.length} ingredient{node.children.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isCrafted && <StationChip stationIds={node.stations} />}
    </div>
  );
}

// Recursive crafting-tree node (PLAN.md §5). Renders as a plain <li> — the
// caller (CraftTree, or a parent TreeNode) is responsible for the wrapping
// <ul>; connector lines are drawn by plain CSS in src/index.css against the
// resulting ul/li nesting.
export function TreeNode({ node, path, collapsed, onToggle }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(path);

  return (
    <li>
      <NodeCard
        node={node}
        hasChildren={hasChildren}
        collapsed={isCollapsed}
        onToggle={() => onToggle(path)}
      />
      {hasChildren && !isCollapsed && (
        <ul>
          {node.children.map((child, index) => (
            <TreeNode
              key={`${child.itemId}-${index}`}
              node={child}
              path={childPath(path, index)}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
