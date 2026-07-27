import { useCallback, useEffect, useMemo, useState } from 'react'
import { useGame } from './lib/GameContext.js'
import { buildTree, collapsiblePaths } from './lib/tree.js'
import { craftPlan } from './lib/plan.js'
import { loadJSON, saveJSON } from './lib/storage.js'
import { CraftTree } from './components/CraftTree.jsx'
import { RawSummary } from './components/RawSummary.jsx'
import { ItemBrowser, TierBadge } from './components/ItemBrowser.jsx'
import { VariantSwitcher } from './components/VariantSwitcher.jsx'
import { TasksView } from './components/TasksView.jsx'

// Diagram first — it's the default view, and the toggle order mirrors that.
const VIEWS = [
  { id: 'diagram', label: 'Diagram' },
  { id: 'compact', label: 'Compact' },
]

// Diagram zoom: a wide recipe outgrows any viewport, so let it be scaled
// down rather than shrinking the cards for everyone.
const ZOOM_MIN = 0.25
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.1
const clampZoom = (value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10))

// Browse filters live here, not inside ItemBrowser: selecting an item
// unmounts the browser, and the filters must survive the round trip back.
const DEFAULT_BROWSE_FILTERS = {
  search: '',
  category: null,
  tier: null,
  craftableOnly: false,
  station: '',
  sortKey: 'name',
}

// Crafting-tasks persistence (localStorage). Every read is sanitized rather
// than trusted — a hand-edited or stale-schema value must never white-screen
// the app, so anything that doesn't look like a valid task/progress entry is
// silently dropped instead of thrown.
const TASKS_KEY = 'craftpal.tasks'
const PROGRESS_KEY = 'craftpal.taskProgress'

// A batch recipe can only be run whole — the game has no way to craft a
// single round of ammo when a craft yields 50 — so a target quantity is
// always rounded up to a whole number of crafts.
function wholeBatches(items, itemId, qty) {
  const yieldsPerCraft = items[itemId]?.recipe?.yields ?? 1
  if (yieldsPerCraft <= 1) return qty
  return Math.ceil(qty / yieldsPerCraft) * yieldsPerCraft
}

function sanitizeTasks(items, value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (!entry || typeof entry.itemId !== 'string' || !Object.hasOwn(items, entry.itemId)) continue
    const qty = Number.isFinite(entry.qty) && entry.qty >= 1 ? Math.floor(entry.qty) : 1
    out.push({ itemId: entry.itemId, qty })
  }
  return out
}

function sanitizeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'boolean') out[key] = val
  }
  return out
}

// Small "Tasks" nav button with a queued-count badge (crafting-tasks
// feature) — shared by the browse header and the tree header so both reach
// the Tasks view the same way.
function TasksNavButton({ count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="View crafting tasks"
      className="flex items-center gap-2 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
    >
      Tasks
      {count > 0 && (
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-zinc-100 px-1 text-[11px] font-semibold text-zinc-900">
          {count}
        </span>
      )}
    </button>
  )
}

function ToolbarButton({ children, onClick, active = false, title, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-700 ${
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
  items,
  manifest,
  qty,
  onQtyChange,
  onBack,
  onSelectVariant,
  view,
  onViewChange,
  onCollapseAll,
  onExpandAll,
  zoom,
  onZoomBy,
  onZoomReset,
  taskCount,
  onAddToTasks,
  onShowTasks,
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
        <TierBadge tierId={item.tier} tiers={manifest.tiers} />
      </div>

      <VariantSwitcher items={items} tiers={manifest.tiers} currentId={itemId} onSelect={onSelectVariant} />

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

        {view === 'diagram' && (
          <div className="flex items-center gap-1">
            <ToolbarButton
              onClick={() => onZoomBy(-ZOOM_STEP)}
              title="Zoom out"
              disabled={zoom <= ZOOM_MIN}
            >
              −
            </ToolbarButton>
            <button
              type="button"
              onClick={onZoomReset}
              title="Reset zoom to 100%"
              className="w-14 rounded-md border border-zinc-700 px-1 py-1 text-center text-xs tabular-nums text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            >
              {Math.round(zoom * 100)}%
            </button>
            <ToolbarButton
              onClick={() => onZoomBy(ZOOM_STEP)}
              title="Zoom in"
              disabled={zoom >= ZOOM_MAX}
            >
              +
            </ToolbarButton>
          </div>
        )}

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

        <button
          type="button"
          onClick={onAddToTasks}
          title={`Add ${qty}× ${item.name} to tasks`}
          className="rounded-md border border-emerald-600/60 bg-emerald-600/10 px-3 py-1.5 text-sm font-medium text-emerald-300 transition-colors hover:border-emerald-500 hover:bg-emerald-600/20 hover:text-emerald-200 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        >
          + Add to tasks
        </button>

        <TasksNavButton count={taskCount} onClick={onShowTasks} />
      </div>
    </header>
  )
}

function App() {
  const { items, stations, manifest } = useGame()
  const [selectedId, setSelectedId] = useState(null)
  const [qty, setQty] = useState(1)
  const [view, setView] = useState('diagram')
  const [zoom, setZoom] = useState(1)
  const [browseFilters, setBrowseFilters] = useState(DEFAULT_BROWSE_FILTERS)
  // Collapse state lives here, keyed by node path, so it survives a view
  // switch and can be driven wholesale by collapse/expand-all.
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [showTasks, setShowTasks] = useState(false)

  // Crafting tasks: a persistent build list of {itemId, qty} targets, plus a
  // per-step "done" tick keyed by step itemId — both loaded once (lazily, so
  // this only ever reads localStorage on first mount) and sanitized so a
  // corrupt/hand-edited value resets instead of throwing.
  const [tasks, setTasks] = useState(() => sanitizeTasks(items, loadJSON(TASKS_KEY, [])))
  const [progress, setProgress] = useState(() => sanitizeProgress(loadJSON(PROGRESS_KEY, {})))

  useEffect(() => {
    saveJSON(TASKS_KEY, tasks)
  }, [tasks])

  useEffect(() => {
    saveJSON(PROGRESS_KEY, progress)
  }, [progress])

  // Adding an item already queued ADDS to its quantity rather than
  // duplicating the row (task spec).
  const addTask = useCallback((itemId, addQty = 1) => {
    if (!Object.hasOwn(items, itemId)) return
    const amount = Number.isFinite(addQty) && addQty >= 1 ? Math.floor(addQty) : 1
    setTasks((current) => {
      const index = current.findIndex((task) => task.itemId === itemId)
      if (index === -1) return [...current, { itemId, qty: wholeBatches(items, itemId, amount) }]
      const next = [...current]
      next[index] = { ...next[index], qty: wholeBatches(items, itemId, next[index].qty + amount) }
      return next
    })
  }, [items])

  const updateTaskQty = useCallback((itemId, newQty) => {
    const amount = Number.isFinite(newQty) && newQty >= 1 ? Math.floor(newQty) : 1
    setTasks((current) =>
      current.map((task) =>
        task.itemId === itemId ? { ...task, qty: wholeBatches(items, itemId, amount) } : task,
      ),
    )
  }, [items])

  const removeTask = useCallback((itemId) => {
    setTasks((current) => current.filter((task) => task.itemId !== itemId))
  }, [])

  const clearTasks = useCallback(() => setTasks([]), [])

  const toggleStepDone = useCallback((itemId) => {
    setProgress((current) => ({ ...current, [itemId]: !current[itemId] }))
  }, [])

  // Ordered, dependency-safe craft plan for the whole task list (src/lib/plan.js).
  const plan = useMemo(() => craftPlan(items, tasks), [items, tasks])

  const selectedItem = selectedId ? items[selectedId] : null

  // Deferred refactor (Phase 2 review, PLAN.md §5/§6): build the tree ONCE
  // here and hand the same tree object to both CraftTree (renders it) and
  // RawSummary (aggregates it) instead of each recomputing buildTree itself.
  const tree = useMemo(
    () => (selectedId ? buildTree(items, selectedId, qty) : null),
    [items, selectedId, qty],
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
    setShowTasks(false)
  }

  // Variant switcher (PLAN.md §5/§9): swap the selected variant but
  // deliberately leave qty untouched. Paths are position-based, so a
  // different variant's recipe would fold the wrong rows — reset.
  function handleSelectVariant(id) {
    setSelectedId(id)
    setCollapsed(new Set())
  }

  if (showTasks) {
    return (
      <TasksView
        tasks={tasks}
        plan={plan}
        progress={progress}
        onQtyChange={updateTaskQty}
        onRemove={removeTask}
        onClearAll={clearTasks}
        onToggleStep={toggleStepDone}
        onBack={() => setShowTasks(false)}
      />
    )
  }

  if (selectedItem && tree) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
        <TreeHeader
          item={selectedItem}
          itemId={selectedId}
          items={items}
          manifest={manifest}
          qty={qty}
          onQtyChange={setQty}
          onBack={() => setSelectedId(null)}
          onSelectVariant={handleSelectVariant}
          view={view}
          onViewChange={setView}
          zoom={zoom}
          onZoomBy={(delta) => setZoom((current) => clampZoom(current + delta))}
          onZoomReset={() => setZoom(1)}
          onCollapseAll={() => setCollapsed(new Set(collapsiblePaths(tree)))}
          onExpandAll={() => setCollapsed(new Set())}
          taskCount={tasks.length}
          onAddToTasks={() => addTask(selectedId, qty)}
          onShowTasks={() => setShowTasks(true)}
        />

        <main className="flex-1 px-6 py-6">
          <CraftTree tree={tree} view={view} zoom={zoom} collapsed={collapsed} onToggle={toggleCollapsed} />
        </main>

        <RawSummary tree={tree} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{manifest.name}</h1>
          <p className="text-sm text-zinc-400">{manifest.tagline}</p>
        </div>

        <div className="ml-auto">
          <TasksNavButton count={tasks.length} onClick={() => setShowTasks(true)} />
        </div>
      </header>

      <ItemBrowser
        items={items}
        stations={stations}
        manifest={manifest}
        onSelect={handleSelect}
        onAddTask={(id) => addTask(id, 1)}
        filters={browseFilters}
        onFiltersChange={setBrowseFilters}
      />
    </div>
  )
}

export default App
