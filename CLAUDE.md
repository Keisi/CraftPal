# CraftPal

Personal-use static site: pick a Palworld item → recursive crafting tree with
amounts, stations, icons, and a raw-materials summary. **`PLAN.md` is the source
of truth — read it before working.** Phase status lives in its §7.

Renamed from "Paltree" to **CraftPal** (2026-07-27); the local folder may still
be called `Paltree`. Remote: https://github.com/Keisi/CraftPal — hosted on
**GitHub Pages** at https://keisi.github.io/CraftPal/ (deployed by
`.github/workflows/deploy.yml` on every push to `main`).

## Conventions

- **Stack:** Vite + React 19 + Tailwind **4 (CSS-first)** — the Tailwind plugin is
  registered in `vite.config.js` and `src/index.css` starts with
  `@import "tailwindcss";`. Do **not** add a `tailwind.config.js`.
- **Data:** `src/data/items.json` + `src/data/stations.json` follow the schema in
  PLAN.md §1. Load-bearing rules:
  - Raw material = **no `recipe` key** (that's the leaf test everywhere).
  - `recipe.stations` is always an **array** (recipes accept multiple station tiers).
  - Rarity tiers of one weapon are **separate items** with their own recipes,
    linked by a shared `family` id.
  - Ids are stable kebab-case derived from paldb.cc internal codes — never key
    by display name.
  - This JSON is **generated** by `scripts/fetch-data.mjs` (`npm run fetch-data`,
    paldb.cc scrape, ~1993 items) — regenerate after a game patch, don't
    hand-edit. Scraping needs a browser `User-Agent` + `Referer` header; the
    station-icon CDN path 403s bare requests.
- **Icons:** local files only, `public/icons/<id>.webp` — never hotlink. The
  browse grid renders ~1600 cards, so `<img>` must stay `loading="lazy"`
  (eager loading pulls the whole ~14 MB icon set on first paint).
- **Batch recipes are counted in CRAFTS, not pieces.** A recipe with
  `yields > 1` can only be run whole — the game will not craft one round of
  ammo when a craft makes 50 — so task quantities snap to a whole number of
  crafts (`wholeBatches()` in `App.jsx`) and the Tasks row edits *crafts*.
  Anything that surfaces a quantity for a `yields > 1` item must say what one
  craft produces, or raising a target appears to change nothing and reads as
  broken arithmetic. `plan.js`/`tree.js` still work in units internally —
  `crafts = ceil(qty / yields)`.
- **UI state that must survive navigation lives in `App`, not the component.**
  Opening an item unmounts `ItemBrowser`, so browse filters
  (`DEFAULT_BROWSE_FILTERS`) are owned by `App` and passed down controlled.
  Same reason tree collapse state is lifted (below).
- **Tree collapse state** lives in `App` keyed by node **path**
  (`tree.js`: `ROOT_PATH`/`childPath`/`collapsiblePaths`), never by itemId —
  the same ingredient appears at several positions in one tree and must fold
  independently. Both tree views share that state.
- **Component files export only components** (oxlint `react(only-export-components)`
  — keep helpers module-local or move them to `src/lib/`). Diagram zoom uses
  CSS `zoom`, not `transform: scale()`, so the scroll container sizes to the
  scaled tree.
- **Git identity:** this is Kevin's *personal* project — commits must be
  authored `Keisi <ls.azuelo@gmail.com>` (set in the repo's local git config),
  never the work address. Pushes authenticate as the personal GitHub account.
- **GitHub Pages base path:** production builds serve from `/CraftPal/`
  (`vite.config.js` sets `base` on build). Any runtime-constructed asset URL
  must be prefixed with `import.meta.env.BASE_URL` (see `ItemIcon.jsx`) —
  never a hardcoded leading `/`.
- **Verify:** `npm run build`, `npm test`, and `npm run validate` must pass
  before any commit.
- **Pages ordering gotcha:** if the repo is ever recreated, enable Pages
  (`POST /repos/.../pages` `{"build_type":"workflow"}`) **before** the first
  push — a workflow run that starts before Pages exists fails at
  `actions/configure-pages` and skips the deploy. Re-running the run fixes it.
