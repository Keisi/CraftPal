import { useCallback, useMemo, useState } from 'react'
import { items, stations } from './lib/data.js'
import { buildTree, collapsiblePaths } from './lib/tree.js'
import { CraftTree } from './components/CraftTree.jsx'
import { RawSummary } from './components/RawSummary.jsx'
import { ItemBrowser, RarityBadge } from './components/ItemBrowser.jsx'
import { RaritySwitcher } from './components/RaritySwitcher.jsx'

const VIEWS = [
  { id: 'compact', label: 'Compact' },
  { id: 'diagram', label: 'Diagram' },
]

function ToolbarButton({ children, onClick, active = false, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 ${
        active
          ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
          : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}

function TreeHeader({
  item,
  itemId,
  qty,
  onQtyChange,
  onBack,
  onSelectVariant,
  view,
  onViewChange,
  onCollapseAll,
  onExpandAll,
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
      >
        ← All items
      </button>

      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">{item.name}</h2>
        <RarityBadge rarity={item.rarity} />
      </div>

      <RaritySwitcher items={items} currentId={itemId} onSelect={onSelectVariant} />

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          {VIEWS.map((option) => (
            <ToolbarButton
              key={option.id}
              active={view === option.id}
              onClick={() => onViewChange(option.id)}
              title={
                option.id === 'compact'
                  ? 'Indented rows — bounded width'
                  : 'Wide top-down diagram'
              }
            >
              {option.label}
            </ToolbarButton>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <ToolbarButton onClick={onCollapseAll} title="Fold every ingredient">
            Collapse all
          </ToolbarButton>
          <ToolbarButton onClick={onExpandAll} title="Unfold every ingredient">
            Expand all
          </ToolbarButton>
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Qty
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(event) => {
              const next = Math.floor(Number(event.target.value))
              onQtyChange(Number.isFinite(next) && next >= 1 ? next : 1)
            }}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          />
        </label>
      </div>
    </header>
  )
}

function App() {
  const [selectedId, setSelectedId] = useState(null)
  const [qty, setQty] = useState(1)
  const [view, setView] = useState('compact')
  // Collapse state lives here, keyed by node path, so it survives a view
  // switch and can be driven wholesale by collapse/expand-all.
  const [collapsed, setCollapsed] = useState(() => new Set())

  const selectedItem = selectedId ? items[selectedId] : null

  // Deferred refactor (Phase 2 review, PLAN.md §5/§6): build the tree ONCE
  // here and hand the same tree object to both CraftTree (renders it) and
  // RawSummary (aggregates it) instead of each recomputing buildTree itself.
  const tree = useMemo(
    () => (selectedId ? buildTree(items, selectedId, qty) : null),
    [selectedId, qty],
  )

  const toggleCollapsed = useCallback((path) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  function handleSelect(id) {
    setSelectedId(id)
    setQty(1)
    setCollapsed(new Set())
  }

  // Rarity switcher (PLAN.md §5): swap the selected variant but deliberately
  // leave qty untouched. Paths are position-based, so a different variant's
  // recipe would fold the wrong rows — reset.
  function handleSelectVariant(id) {
    setSelectedId(id)
    setCollapsed(new Set())
  }

  if (selectedItem && tree) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
        <TreeHeader
          item={selectedItem}
          itemId={selectedId}
          qty={qty}
          onQtyChange={setQty}
          onBack={() => setSelectedId(null)}
          onSelectVariant={handleSelectVariant}
          view={view}
          onViewChange={setView}
          onCollapseAll={() => setCollapsed(new Set(collapsiblePaths(tree)))}
          onExpandAll={() => setCollapsed(new Set())}
        />

        <main className="flex-1 px-6 py-6">
          <CraftTree tree={tree} view={view} collapsed={collapsed} onToggle={toggleCollapsed} />
        </main>

        <RawSummary tree={tree} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">CraftPal</h1>
        <p className="text-sm text-zinc-400">Palworld crafting-tree explorer</p>
      </header>

      <ItemBrowser items={items} stations={stations} onSelect={handleSelect} />
    </div>
  )
}

export default App
