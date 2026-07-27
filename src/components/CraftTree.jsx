import { useEffect, useRef } from 'react';
import { ROOT_PATH } from '../lib/tree.js';
import { TreeNode } from './TreeNode.jsx';
import { TreeRows } from './TreeRows.jsx';

// Crafting-tree render (PLAN.md §5). The tree is built once by the caller
// (App, via useMemo on [selectedId, qty]) and shared with RawSummary, so this
// only picks a layout: 'diagram' (default) is the top-down infographic
// layout; 'compact' is indented rows, whose width stays bounded however many
// leaves a recipe has.
export function CraftTree({ tree, view = 'diagram', zoom = 1, collapsed, onToggle }) {
  const scrollerRef = useRef(null);

  // The diagram centres the root over the whole tree, so a tree wider than
  // the viewport would otherwise open scrolled hard left with the root off
  // screen. Start centred on it instead — including after a zoom change, so
  // zooming keeps the root in view rather than drifting off.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [tree, view, zoom, collapsed]);

  if (view === 'compact') {
    return <TreeRows tree={tree} collapsed={collapsed} onToggle={onToggle} />;
  }

  return (
    <div ref={scrollerRef} className="overflow-x-auto">
      {/* `zoom` rather than `transform: scale()` so the scroll container's
          own dimensions shrink with the tree — a transform would leave the
          scrollbar sized for the unscaled layout. */}
      <ul className="tree min-w-fit px-8 pb-4" style={{ zoom }}>
        <TreeNode node={tree} path={ROOT_PATH} collapsed={collapsed} onToggle={onToggle} />
      </ul>
    </div>
  );
}
