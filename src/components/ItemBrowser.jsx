import { useMemo, useState } from 'react';
import { ItemIcon } from './ItemIcon.jsx';
import { rarityBadgeClass, rarityDotClass } from '../lib/rarity.js';
import {
  groupFamilies,
  filterEntries,
  SORTS,
  deriveCategories,
  deriveRarities,
  deriveStations,
} from '../lib/filter.js';

export function RarityBadge({ rarity }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${rarityBadgeClass(rarity)}`}>
      {rarity}
    </span>
  );
}

export function CategoryBadge({ category }) {
  return (
    <span className="rounded-full border border-zinc-600/60 bg-zinc-700/40 px-2 py-0.5 text-xs font-medium capitalize text-zinc-300">
      {category}
    </span>
  );
}

// Small rarity dots on a collapsed family card (PLAN.md §5) — one dot per
// variant that actually exists in the data, in rarity order.
function VariantDots({ variants }) {
  return (
    <div className="flex items-center gap-1" aria-label="Available rarities">
      {variants.map(({ id, item }) => (
        <span
          key={id}
          title={`${item.name} (${item.rarity})`}
          className={`h-2.5 w-2.5 rounded-full ${rarityDotClass(item.rarity)}`}
        />
      ))}
    </div>
  );
}

// One card per browser entry. Family-collapsed entries show the base
// (lowest-rarity) variant plus rarity dots for the rest; clicking always
// opens the entry's `id`, which for a family is the base variant (PLAN.md
// §5: "clicking it opens the tree of the base (common) variant").
//
// The "+" button (crafting-tasks feature) adds that same base variant to the
// task list at qty 1. It sits on top of the card's own click-to-open handler,
// so both the click AND the Enter/Space keyboard-activation path must stop
// propagation — otherwise activating "+" would also fire the card's onSelect
// and jump straight to the tree view.
function ItemCard({ entry, onSelect, onAddTask }) {
  const { id, item, isFamily, variants } = entry;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(id);
        }
      }}
      className="relative flex cursor-pointer flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-sm transition-colors hover:border-zinc-600 hover:ring-1 hover:ring-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-500"
    >
      {onAddTask && (
        <button
          type="button"
          title={`Add ${item.name} to tasks`}
          aria-label={`Add ${item.name} to tasks`}
          onClick={(event) => {
            event.stopPropagation();
            onAddTask(id);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/90 text-sm font-semibold leading-none text-zinc-300 shadow-sm transition-colors hover:border-emerald-500/60 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        >
          +
        </button>
      )}

      <div className="flex items-center gap-3">
        <ItemIcon src={item.icon} alt={item.name} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-zinc-100">{item.name}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryBadge category={item.category} />
            <RarityBadge rarity={item.rarity} />
          </div>
          {isFamily && <VariantDots variants={variants} />}
        </div>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
        active
          ? 'border-zinc-400 bg-zinc-700 text-zinc-100'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

function RarityChip({ rarity, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-opacity ${rarityBadgeClass(rarity)} ${
        active ? 'opacity-100 ring-2 ring-zinc-100 ring-offset-1 ring-offset-zinc-950' : 'opacity-50 hover:opacity-90'
      }`}
    >
      {rarity}
    </button>
  );
}

// Searchable, sortable, filterable item browser (PLAN.md §5 / Phase 4).
// Every option list (categories, rarities, stations) is derived from the
// loaded `items`/`stations` at render time via src/lib/filter.js — never
// hardcoded — so this works identically against the 16-item sample and the
// eventual ~600+-item scrape. Family variants (PLAN.md §1) collapse to one
// card with rarity dots.
export function ItemBrowser({ items, stations, onSelect, onAddTask }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(null);
  const [rarity, setRarity] = useState(null);
  const [craftableOnly, setCraftableOnly] = useState(false);
  const [station, setStation] = useState('');
  const [sortKey, setSortKey] = useState('name');

  const categories = useMemo(() => deriveCategories(items), [items]);
  const rarities = useMemo(() => deriveRarities(items), [items]);
  const stationOptions = useMemo(() => deriveStations(items, stations), [items, stations]);

  const entries = useMemo(() => groupFamilies(items), [items]);

  const filtered = useMemo(
    () => filterEntries(entries, { search, category, rarity, craftableOnly, station }),
    [entries, search, category, rarity, craftableOnly, station],
  );

  const sorted = useMemo(() => {
    const compare = SORTS[sortKey]?.compare ?? SORTS.name.compare;
    return [...filtered].sort(compare);
  }, [filtered, sortKey]);

  function toggleCategory(value) {
    setCategory((current) => (current === value ? null : value));
  }

  function toggleRarity(value) {
    setRarity((current) => (current === value ? null : value));
  }

  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items…"
            aria-label="Search items"
            className="w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          />

          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="checkbox"
              checked={craftableOnly}
              onChange={(event) => setCraftableOnly(event.target.checked)}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-zinc-100 focus:ring-2 focus:ring-zinc-500"
            />
            Craftable only
          </label>

          <label className="flex items-center gap-2 text-sm text-zinc-400">
            Station
            <select
              value={station}
              onChange={(event) => setStation(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            >
              <option value="">Any station</option>
              {stationOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="sm:ml-auto flex items-center gap-2 text-sm text-zinc-400">
            Sort
            <select
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            >
              {Object.entries(SORTS).map(([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Category
            </span>
            {categories.map((c) => (
              <Chip key={c} active={category === c} onClick={() => toggleCategory(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}

        {rarities.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Rarity
            </span>
            {rarities.map((r) => (
              <RarityChip key={r} rarity={r} active={rarity === r} onClick={() => toggleRarity(r)} />
            ))}
          </div>
        )}
      </div>

      <div className="px-6 py-4">
        <div className="mb-3 text-sm text-zinc-400">
          {sorted.length} item{sorted.length === 1 ? '' : 's'}
        </div>

        {sorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center text-sm text-zinc-500">
            No items match your filters.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {sorted.map((entry) => (
              <ItemCard key={entry.id} entry={entry} onSelect={onSelect} onAddTask={onAddTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
