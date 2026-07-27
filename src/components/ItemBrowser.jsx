import { useMemo } from 'react';
import { ItemIcon } from './ItemIcon.jsx';
import { findTier, tierBadgeClass, tierDotClass } from '../lib/tier.js';
import {
  groupVariants,
  filterEntries,
  deriveCategories,
  deriveTiers,
  deriveStations,
  deriveSorts,
} from '../lib/filter.js';

// Capitalizes a manifest label word ("station" -> "Station"). Manifest
// labels read lowercase inline ("Any station"), but a heading/standalone
// <label> needs the leading capital.
const capitalize = (word) => {
  const str = String(word ?? '');
  return str ? str[0].toUpperCase() + str.slice(1) : str;
};

// The tier badge/chip is the one dead control that must vanish per-ITEM (not
// just per-dataset): an item with no `tier` at all renders nothing, rather
// than a meaningless "undefined" pill.
export function TierBadge({ tierId, tiers }) {
  if (!tierId) return null;
  const tier = findTier(tiers, tierId);
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${tierBadgeClass(tier?.color)}`}>
      {tier?.label ?? tierId}
    </span>
  );
}

// Category ids are snake_case ('special_weapon'); show them as words. Kept
// unexported so this file only exports components (fast-refresh safe).
const humanizeCategory = (category) => String(category ?? '').replace(/_/g, ' ');

export function CategoryBadge({ category }) {
  return (
    <span className="rounded-full border border-zinc-600/60 bg-zinc-700/40 px-2 py-0.5 text-xs font-medium capitalize text-zinc-300">
      {humanizeCategory(category)}
    </span>
  );
}

// Small tier dots on a collapsed variant-group card (PLAN.md §5) — one dot
// per variant that actually exists in the data, in tier order.
function VariantDots({ variants, tiers }) {
  return (
    <div className="flex items-center gap-1" aria-label="Available variants">
      {variants.map(({ id, item }) => {
        const tier = findTier(tiers, item.tier);
        return (
          <span
            key={id}
            title={tier ? `${item.name} (${tier.label})` : item.name}
            className={`h-2.5 w-2.5 rounded-full ${tierDotClass(tier?.color)}`}
          />
        );
      })}
    </div>
  );
}

// One card per browser entry. Variant-group entries show the base
// (lowest-tier) variant plus tier dots for the rest; clicking always opens
// the entry's `id`, which for a group is the base variant (PLAN.md §5:
// "clicking it opens the tree of the base (common) variant").
//
// The "+" button (crafting-tasks feature) adds that same base variant to the
// task list at qty 1. It sits on top of the card's own click-to-open handler,
// so both the click AND the Enter/Space keyboard-activation path must stop
// propagation — otherwise activating "+" would also fire the card's onSelect
// and jump straight to the tree view.
function ItemCard({ entry, tiers, onSelect, onAddTask }) {
  const { id, item, isVariantGroup, variants } = entry;

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
            <TierBadge tierId={item.tier} tiers={tiers} />
          </div>
          {isVariantGroup && <VariantDots variants={variants} tiers={tiers} />}
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

function TierChip({ tier, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-opacity ${tierBadgeClass(tier.color)} ${
        active ? 'opacity-100 ring-2 ring-zinc-100 ring-offset-1 ring-offset-zinc-950' : 'opacity-50 hover:opacity-90'
      }`}
    >
      {tier.label}
    </button>
  );
}

// Searchable, sortable, filterable item browser (PLAN.md §5 / §9, Phase 4).
// Every option list (categories, tiers, stations, sorts) is derived from the
// loaded `items`/`stations`/`manifest` at render time via src/lib/filter.js —
// never hardcoded — so this works identically against the 16-item sample,
// the full ~2000-item Palworld scrape, and a hypothetical game with no tiers/
// progression/stations at all (every optional control below simply doesn't
// render). Variant groups (PLAN.md §1/§9) collapse to one card with tier dots.
// Filter/sort state is owned by App (see DEFAULT_BROWSE_FILTERS) rather than
// held locally: opening an item unmounts the browser, and losing the filters
// on every back-navigation made browsing a 1600-card grid painful.
export function ItemBrowser({ items, stations, manifest, onSelect, onAddTask, filters, onFiltersChange }) {
  const { search, category, tier, craftableOnly, station, sortKey } = filters;
  const setField = (key, value) => onFiltersChange({ ...filters, [key]: value });

  const labels = manifest.labels ?? {};
  // `?? []` would otherwise build a fresh array every render whenever
  // manifest.tiers is absent, defeating the useMemo below it depends on.
  const tierDefs = useMemo(() => manifest.tiers ?? [], [manifest]);

  const categories = useMemo(() => deriveCategories(items), [items]);
  const tiers = useMemo(() => deriveTiers(items, tierDefs), [items, tierDefs]);
  const stationOptions = useMemo(() => deriveStations(items, stations), [items, stations]);
  const sorts = useMemo(() => deriveSorts(items, manifest), [items, manifest]);

  const entries = useMemo(() => groupVariants(items, tierDefs), [items, tierDefs]);

  const filtered = useMemo(
    () => filterEntries(entries, { search, category, tier, craftableOnly, station }),
    [entries, search, category, tier, craftableOnly, station],
  );

  const sorted = useMemo(() => {
    const compare = sorts[sortKey]?.compare ?? sorts.name.compare;
    return [...filtered].sort(compare);
  }, [filtered, sorts, sortKey]);

  function toggleCategory(value) {
    setField('category', category === value ? null : value);
  }

  function toggleTier(value) {
    setField('tier', tier === value ? null : value);
  }

  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setField('search', event.target.value)}
            placeholder="Search items…"
            aria-label="Search items"
            className="w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          />

          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="checkbox"
              checked={craftableOnly}
              onChange={(event) => setField('craftableOnly', event.target.checked)}
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-zinc-100 focus:ring-2 focus:ring-zinc-500"
            />
            Craftable only
          </label>

          {stationOptions.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              {capitalize(labels.station ?? 'station')}
              <select
                value={station}
                onChange={(event) => setField('station', event.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
              >
                <option value="">Any {labels.station ?? 'station'}</option>
                {stationOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {Object.keys(sorts).length > 1 && (
            <label className="sm:ml-auto flex items-center gap-2 text-sm text-zinc-400">
              Sort
              <select
                value={sortKey}
                onChange={(event) => setField('sortKey', event.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
              >
                {Object.entries(sorts).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Category
            </span>
            {categories.map((c) => (
              <Chip key={c} active={category === c} onClick={() => toggleCategory(c)}>
                {humanizeCategory(c)}
              </Chip>
            ))}
          </div>
        )}

        {tiers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              {capitalize(labels.tier ?? 'tier')}
            </span>
            {tiers.map((t) => (
              <TierChip key={t.id} tier={t} active={tier === t.id} onClick={() => toggleTier(t.id)} />
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
              <ItemCard key={entry.id} entry={entry} tiers={tierDefs} onSelect={onSelect} onAddTask={onAddTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
