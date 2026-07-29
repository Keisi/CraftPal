import { useGame } from '../lib/GameContext.js';
import { childPath } from '../lib/tree.js';
import { ItemIcon } from './ItemIcon.jsx';
import { StationChip } from './StationChip.jsx';
import { AnyOfChip } from './AnyOfChip.jsx';
import { RecipeSwitcher } from './RecipeSwitcher.jsx';
import { tierBorderClass, tierColor } from '../lib/tier.js';

// Per-node collapse (Phase 4, PLAN.md §5): clicking a node card that has
// children folds/unfolds its subtree. View-only — the qty badge is always
// computed from the full tree regardless of fold state, so re-expanding
// never has to recompute anything. Collapse state is owned by App (keyed by
// node path) so collapse/expand-all and the view toggle share it.
function NodeCard({ node, path, hasChildren, collapsed, onToggle, recipeChoices, onSelectRecipe }) {
  const { items, manifest } = useGame();
  const item = items[node.itemId];
  const name = item?.name ?? node.itemId;
  const color = tierColor(manifest.tiers, item?.tier);
  const isCrafted = node.stations !== null;
  // The node's OWN yields (schema v3 axis 2) — computed by buildTree from
  // whichever recipe is actually active for this node (recipes[0] by default,
  // or the recipe switcher's per-path override), never re-derived from
  // item.recipes[0] here, which would go stale the moment a switch happens.
  const yieldsPerCraft = node.yields ?? 1;

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
        className={`relative flex w-36 flex-col items-center gap-2 rounded-lg border-2 bg-zinc-900 p-3 shadow-sm ${tierBorderClass(color)} ${
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

        {/* Batch recipes: state what one craft actually produces, so a node
            asking for 50 ammo reads as one craft rather than fifty. */}
        {yieldsPerCraft > 1 && (
          <span className="text-center text-[10px] leading-tight text-zinc-500">
            {node.crafts.toLocaleString()} craft{node.crafts === 1 ? '' : 's'} ×{' '}
            {yieldsPerCraft.toLocaleString()}
          </span>
        )}

        {hasChildren && collapsed && (
          <span className="text-[10px] text-zinc-500">
            +{node.children.length} ingredient{node.children.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {node.anyOf && <AnyOfChip anyOf={node.anyOf} anyOfLabel={node.anyOfLabel} />}
      {isCrafted && <StationChip stationIds={node.stations} />}
      {item?.recipes?.length > 1 && (
        <RecipeSwitcher
          recipes={item.recipes}
          activeIndex={recipeChoices.get(path) ?? 0}
          onSelect={(index) => onSelectRecipe(path, index)}
        />
      )}
    </div>
  );
}

// Recursive crafting-tree node (PLAN.md §5). Renders as a plain <li> — the
// caller (CraftTree, or a parent TreeNode) is responsible for the wrapping
// <ul>; connector lines are drawn by plain CSS in src/index.css against the
// resulting ul/li nesting.
export function TreeNode({ node, path, collapsed, onToggle, recipeChoices, onSelectRecipe }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(path);

  return (
    <li>
      <NodeCard
        node={node}
        path={path}
        hasChildren={hasChildren}
        collapsed={isCollapsed}
        onToggle={() => onToggle(path)}
        recipeChoices={recipeChoices}
        onSelectRecipe={onSelectRecipe}
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
              recipeChoices={recipeChoices}
              onSelectRecipe={onSelectRecipe}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
