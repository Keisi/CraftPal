import { items } from '../lib/data.js';
import { ItemIcon } from './ItemIcon.jsx';
import { StationChip } from './StationChip.jsx';
import { RarityBadge } from './ItemBrowser.jsx';
import { RawMaterialsStrip } from './RawSummary.jsx';

// One queued target: icon, name, editable qty, remove button.
function TargetRow({ task, onQtyChange, onRemove }) {
  const item = items[task.itemId];
  const name = item?.name ?? task.itemId;

  return (
    <li className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 shadow-sm">
      <ItemIcon src={item?.icon} alt={name} className="h-10 w-10" />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium text-zinc-100">{name}</span>
        <RarityBadge rarity={item?.rarity} />
      </div>

      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        Qty
        <input
          type="number"
          min={1}
          step={1}
          value={task.qty}
          onChange={(event) => {
            const next = Math.floor(Number(event.target.value));
            onQtyChange(task.itemId, Number.isFinite(next) && next >= 1 ? next : 1);
          }}
          className="w-16 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
      </label>

      <button
        type="button"
        onClick={() => onRemove(task.itemId)}
        title={`Remove ${name}`}
        aria-label={`Remove ${name}`}
        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-red-500/60 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-zinc-500"
      >
        ✕
      </button>
    </li>
  );
}

function TargetList({ tasks, onQtyChange, onRemove, onClearAll }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Targets ({tasks.length})
        </h3>
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-zinc-400 underline-offset-2 transition-colors hover:text-zinc-100 hover:underline"
        >
          Clear all
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TargetRow key={task.itemId} task={task} onQtyChange={onQtyChange} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}

// One craft step: number badge, checkbox, icon, "Craft N× Name".
//
// Batch recipes (yields > 1) need the batch spelled out: an Advanced Arrow
// craft produces 10, so asking for 1 vs 3 costs identical materials. Without
// saying so, raising the target quantity looks like it silently did nothing.
// Ticked steps are visibly de-emphasised (dimmed + strikethrough) but stay in
// place — the order doesn't change on tick.
function PlanStep({ index, step, done, onToggle }) {
  const item = items[step.itemId];
  const name = item?.name ?? step.itemId;
  const yieldsPerCraft = step.yields ?? 1;
  const isBatch = yieldsPerCraft > 1;
  const produced = step.crafts * yieldsPerCraft;
  const surplus = produced - step.qty;

  return (
    <li
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
        done ? 'border-zinc-800/60 bg-zinc-900/30' : 'border-zinc-800 bg-zinc-900'
      }`}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-xs font-semibold text-zinc-300">
        {index + 1}
      </span>

      <input
        type="checkbox"
        checked={done}
        onChange={() => onToggle(step.itemId)}
        aria-label={`Mark "Craft ${step.qty}x ${name}" done`}
        className="h-4 w-4 shrink-0 rounded border-zinc-600 bg-zinc-900 text-zinc-100 focus:ring-2 focus:ring-zinc-500"
      />

      <ItemIcon src={item?.icon} alt={name} className={`h-10 w-10 ${done ? 'opacity-40' : ''}`} />

      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={`truncate text-sm font-medium ${done ? 'text-zinc-500 line-through' : 'text-zinc-100'}`}
        >
          Craft {step.qty.toLocaleString()}× {name}
        </span>
        {isBatch && (
          <span className={`text-xs ${done ? 'text-zinc-600' : 'text-zinc-500'}`}>
            {step.crafts.toLocaleString()} craft{step.crafts === 1 ? '' : 's'} ×{' '}
            {yieldsPerCraft.toLocaleString()} per batch = {produced.toLocaleString()} made
            {surplus > 0 && `, ${surplus.toLocaleString()} spare`}
          </span>
        )}
      </div>

      <div className={done ? 'opacity-40' : ''}>
        <StationChip stationIds={step.stations} compact />
      </div>
    </li>
  );
}

function PlanSteps({ steps, progress, onToggleStep }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Step-by-step plan
      </h3>

      {steps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center text-sm text-zinc-500">
          Nothing to craft — every target is a raw material. See the list below to gather it.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <PlanStep
              key={step.itemId}
              index={index}
              step={step}
              done={Boolean(progress[step.itemId])}
              onToggle={onToggleStep}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-16 text-center text-sm text-zinc-500">
      <p className="mb-1 text-zinc-300">No crafting tasks queued yet.</p>
      <p>
        Click the <span className="rounded-full border border-zinc-700 bg-zinc-800 px-1.5 text-zinc-300">+</span>{' '}
        on any item card while browsing, or open an item's crafting tree and use{' '}
        <span className="text-zinc-300">"Add to tasks"</span> — it'll show up here with a full,
        dependency-ordered step-by-step plan.
      </p>
    </div>
  );
}

// Tasks page (crafting-tasks feature): the queued target list, the ordered
// craft plan derived from it (App computes `plan` via craftPlan() so this
// component stays presentational), and the raw-materials shopping list.
// Sticky/wrapping toolbar header mirrors ItemBrowser's; the raw strip reuses
// RawMaterialsStrip (same component RawSummary uses on the tree view) rather
// than duplicating that card look.
export function TasksView({ tasks, plan, progress, onQtyChange, onRemove, onClearAll, onToggleStep, onBack }) {
  const hasTasks = tasks.length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        >
          ← Back
        </button>

        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-zinc-100">Crafting tasks</h2>
          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-zinc-100 px-1 text-[11px] font-semibold text-zinc-900">
            {tasks.length}
          </span>
        </div>
      </header>

      <main className="flex-1 px-6 py-6">
        {hasTasks ? (
          <div className="flex flex-col gap-8">
            <TargetList tasks={tasks} onQtyChange={onQtyChange} onRemove={onRemove} onClearAll={onClearAll} />
            <PlanSteps steps={plan.steps} progress={progress} onToggleStep={onToggleStep} />
          </div>
        ) : (
          <EmptyState />
        )}
      </main>

      {hasTasks && <RawMaterialsStrip entries={plan.raw} title="Raw materials to gather" />}
    </div>
  );
}
