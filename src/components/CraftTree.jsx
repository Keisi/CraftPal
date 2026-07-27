import { TreeNode } from './TreeNode.jsx';

// Top-level crafting-tree render (PLAN.md §5). The tree is now built once by
// the caller (App, via useMemo on [selectedId, qty] — Phase 4 deferred
// refactor) and shared with RawSummary, so CraftTree just renders it.
export function CraftTree({ tree }) {
  return (
    <div className="overflow-x-auto">
      <ul className="tree min-w-fit px-8 pb-4">
        <TreeNode node={tree} />
      </ul>
    </div>
  );
}
