import { useMemo } from 'react';
import data from '../data/items.json';
import { buildTree } from '../lib/tree.js';
import { TreeNode } from './TreeNode.jsx';

const items = data.items;

// Top-level crafting-tree render (PLAN.md §5). Builds the tree from
// (itemId, qty) via the Phase 2 core logic and renders it inside an
// overflow-x-auto container so deep chains scroll horizontally instead of
// squeezing the page; the root node itself stays centered (see the `.tree`
// flex rules in src/index.css).
export function CraftTree({ itemId, qty }) {
  const tree = useMemo(() => buildTree(items, itemId, qty), [itemId, qty]);

  return (
    <div className="overflow-x-auto">
      <ul className="tree min-w-fit px-8 pb-4">
        <TreeNode node={tree} />
      </ul>
    </div>
  );
}
