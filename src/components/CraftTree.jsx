import { ROOT_PATH } from '../lib/tree.js';
import { TreeNode } from './TreeNode.jsx';
import { TreeRows } from './TreeRows.jsx';

// Crafting-tree render (PLAN.md §5). The tree is built once by the caller
// (App, via useMemo on [selectedId, qty]) and shared with RawSummary, so this
// only picks a layout: 'compact' indented rows (default — bounded width) or
// 'diagram', the wide top-down infographic layout.
export function CraftTree({ tree, view = 'compact', collapsed, onToggle }) {
  if (view === 'compact') {
    return <TreeRows tree={tree} collapsed={collapsed} onToggle={onToggle} />;
  }

  return (
    <div className="overflow-x-auto">
      <ul className="tree min-w-fit px-8 pb-4">
        <TreeNode node={tree} path={ROOT_PATH} collapsed={collapsed} onToggle={onToggle} />
      </ul>
    </div>
  );
}
