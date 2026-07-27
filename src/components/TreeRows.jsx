import { items } from '../lib/data.js';
import { childPath, ROOT_PATH } from '../lib/tree.js';
import { ItemIcon } from './ItemIcon.jsx';
import { StationChip } from './StationChip.jsx';
import { rarityBorderClass } from '../lib/rarity.js';

// Compact crafting-tree view: one row per node, depth shown by indentation
// instead of horizontal spread. The diagram view's width grows with the
// number of leaves (a deep recipe sprawls past the viewport and forces
// horizontal scrolling); rows grow downward instead, which costs nothing.
// Same tree object, same collapse state — only the layout differs.
//
// Collapse is controlled by the caller (App) so "collapse/expand all" and the
// view toggle can drive it; `collapsed` is a Set of node paths.
function TreeRow({ node, path, depth, collapsed, onToggle }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(path);
  const item = items[node.itemId];
  const name = item?.name ?? node.itemId;
  const rarity = item?.rarity ?? 'common';

  return (
    <li>
      <div
        role={hasChildren ? 'button' : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onClick={hasChildren ? () => onToggle(path) : undefined}
        onKeyDown={
          hasChildren
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggle(path);
                }
              }
            : undefined
        }
        title={hasChildren ? (isCollapsed ? 'Expand ingredients' : 'Collapse ingredients') : undefined}
        className={`flex items-center gap-2 rounded-md border-l-2 bg-zinc-900/60 py-1 pl-2 pr-3 ${rarityBorderClass(
          rarity,
        )} ${
          hasChildren
            ? 'cursor-pointer hover:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-500'
            : ''
        }`}
      >
        <span
          aria-hidden="true"
          className={`w-3 shrink-0 text-[10px] leading-none ${
            hasChildren ? 'text-zinc-400' : 'text-transparent'
          }`}
        >
          {hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}
        </span>

        <ItemIcon src={item?.icon} alt={name} className="h-7 w-7" />

        <span className="w-14 shrink-0 text-right text-xs font-semibold tabular-nums text-zinc-100">
          ×{node.qty.toLocaleString()}
        </span>

        <span
          className={`truncate text-sm ${depth === 0 ? 'font-semibold text-zinc-50' : 'text-zinc-200'}`}
        >
          {name}
        </span>

        {node.stations !== null && <StationChip stationIds={node.stations} compact />}

        {hasChildren && isCollapsed && (
          <span className="shrink-0 text-[10px] text-zinc-500">
            +{node.children.length} ingredient{node.children.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {hasChildren && !isCollapsed && (
        <ul>
          {node.children.map((child, index) => (
            <TreeRow
              key={`${child.itemId}-${index}`}
              node={child}
              path={childPath(path, index)}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TreeRows({ tree, collapsed, onToggle }) {
  return (
    <ul className="tree-rows max-w-3xl">
      <TreeRow node={tree} path={ROOT_PATH} depth={0} collapsed={collapsed} onToggle={onToggle} />
    </ul>
  );
}
