import { useEffect, useRef } from 'react';
import { ROOT_PATH } from '../lib/tree.js';
import { TreeNode } from './TreeNode.jsx';
import { TreeRows } from './TreeRows.jsx';

// Crafting-tree render (PLAN.md §5). The tree is built once by the caller
// (App, via useMemo on [selectedId, qty]) and shared with RawSummary, so this
// only picks a layout: 'diagram' (default) is the top-down infographic
// layout; 'compact' is indented rows, whose width stays bounded however many
// leaves a recipe has.
export function CraftTree({ tree, view = 'diagram', collapsed, onToggle }) {
  const scrollerRef = useRef(null);

  // The diagram centres the root over the whole tree, so a tree wider than
  // the viewport would otherwise open scrolled hard left with the root off
  // screen. Start centred on it instead.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [tree, view, collapsed]);

  if (view === 'compact') {
    return <TreeRows tree={tree} collapsed={collapsed} onToggle={onToggle} />;
  }

  return (
    <div ref={scrollerRef} className="overflow-x-auto">
      <ul className="tree min-w-fit px-8 pb-4">
        <TreeNode node={tree} path={ROOT_PATH} collapsed={collapsed} onToggle={onToggle} />
      </ul>
    </div>
  );
}
