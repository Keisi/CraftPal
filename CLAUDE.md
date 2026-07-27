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
- **The app is a game-agnostic crafting-tree engine; a game is just a JSON
  bundle** (PLAN.md §9). Nothing in `src/components/` may hardcode a
  Palworld-specific concept. Per-game layout:
  - `src/data/<game>/{game,items,stations,pals}.json` — small, **static-imported**
    and bundled.
  - `public/games/<game>/…` — everything else: `icons/<id>.webp`,
    `icons/pals/`, `icons/markers/`, `tiles/`, and `data/` for the heavy
    datasets.
  - `game.json` is the **manifest**: `assetBase`, `labels` (the user-facing
    words: "rarity", "Tech level", "station"), `tiers`, `sorts`, `attribution`.
  - **Tier colors in the manifest are TOKENS** (`"blue"`), never Tailwind class
    strings — data must not be able to inject classes, and Tailwind cannot see
    dynamically-built class names. `src/lib/tier.js` maps token → classes.
  - **Game-neutral field names:** `tier` (not rarity), `progression` (not
    techLevel), `variantGroup` (not family). `items.json` is `schemaVersion: 2`.
    The *labels* still read "rarity"/"Tech level" — that's the manifest's job.
  - **Game selection is `VITE_GAME`** (default `palworld`), resolved in
    `src/lib/data.js`. That module is imported in **exactly one place**
    (`src/GameProvider.jsx`); every component reads `{items, stations,
    manifest}` via `useGame()`. Never re-introduce a direct data-singleton
    import into a component — that's what makes a second game possible.
  - **Optional fields degrade to no UI.** A dataset with no tiers /
    progression / stations must render with those controls *absent*, not empty
    (`derive*` in `src/lib/filter.js`).
- **Data:** load-bearing rules (schema in PLAN.md §1):
  - Raw material = **no `recipe` key** (that's the leaf test everywhere).
  - `recipe.stations` is always an **array** (recipes accept multiple station tiers).
  - Tiers of one weapon are **separate items** with their own recipes, linked by
    a shared `variantGroup` id.
  - Ids are stable kebab-case derived from paldb.cc internal codes — never key
    by display name.
  - This JSON is **generated** — regenerate after a game patch, don't hand-edit.
    Scraping needs a browser `User-Agent` + `Referer` header; the station-icon
    CDN path 403s bare requests.
- **Generated datasets and their scripts** (all throttled, cached under
  `scripts/.cache/`, resumable, `--limit=N`):
  | Script | npm | Output |
  |---|---|---|
  | `fetch-data.mjs` | `fetch-data` | items + stations + item icons (~1993 items) |
  | `fetch-map.mjs` | `fetch-map` | `data/map.json` (13,944 POI markers), tiles, marker icons |
  | `fetch-pals.mjs` | `fetch-pals` | `pals.json` index + `data/habitats/<code>.json` + pal icons |
  | `crosscheck-palworldgg.mjs` | `crosscheck` | **report only, ships no data** |
- **Source hierarchy: paldb.cc is primary, palworld.gg is a cross-check.**
  paldb.cc serves stable unhashed URLs (`/js/map_data_en.js`,
  `/paldex/<code>.json`) with day/night *and* per-point levels. palworld.gg
  bakes its data into a **content-hashed** `/_nuxt/*.js` chunk — usable, but only
  as an independent second extraction to disagree with us. Never hardcode that
  chunk filename; resolve it by content anchor. Details: PLAN.md §8.
- **A scraper that silently returns less is worse than one that dies.** Every
  fetch script hard-errors when its upstream shape changes (missing `var`,
  marker count below a floor). Keep those tripwires.
- **Heavy datasets are lazy-fetched from `public/`, never static-imported.**
  `map.json` (~1.8 MB) and the per-pal `habitats/<code>.json` files must not
  enter the JS bundle. Habitat coords are **flat `[x,y,lv,…]` integer triples**
  and per-pal files deliberately — so opening the map doesn't download every
  pal's point cloud. Don't "improve" them into arrays of objects.
- **Icons:** local files only, `public/games/<game>/icons/…` — never hotlink,
  including map tiles and marker icons. The browse grid renders ~1600 cards, so
  `<img>` must stay `loading="lazy"` (eager loading pulls the whole ~14 MB icon
  set on first paint).
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
