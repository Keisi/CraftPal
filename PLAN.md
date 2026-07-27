# CraftPal — Palworld Crafting Tree Explorer (Plan)

> Renamed from "Paltree" 2026-07-27. Repo: https://github.com/Keisi/CraftPal,
> hosted on GitHub Pages (https://keisi.github.io/CraftPal/).

Personal-use static site: pick a Palworld item → see the full recursive tree of
ingredients (with amounts), the crafting station each step requires, item icons,
and an aggregated raw-materials summary. Visual reference: the No Man's Sky
crafting-tree infographics (top-down tree of icon cards with connector lines and
a "RAW MATERIALS" totals strip).

## 1. Data storage — JSON, no database

**Decision: JSON.** Rationale over XML / anything else:

- The browser parses it natively (`fetch` + `res.json()`); XML needs `DOMParser`
  and verbose traversal for zero benefit.
- Recipes are naturally nested objects/arrays — JSON is the direct notation.
- Trivially hand-editable when a patch changes a recipe, and diffs cleanly in git.
- Whole dataset (~634 items, ~178 with recipes per paldb.cc — more once rarity
  variants are counted as entries) is well under 1 MB pretty-printed — one
  static file, loaded once. No DB needed.

**Store recipes flat (one level deep), derive the tree at runtime.** Each item
lists only its *direct* ingredients; the recursive tree and quantity math are
computed in JS. Storing pre-expanded trees would duplicate data and rot on every
balance patch.

**Rarity variants are separate items.** In-game, the Uncommon/Rare/Epic/Legendary
tiers of a weapon (unlocked via schematics) are distinct items with distinct,
more expensive recipes (verified on paldb.cc: Common Assault Rifle = 40 Refined
Ingot + 10 Polymer + 10 Carbon Fiber; Legendary = 80 + 20 + 20 + 4 Ancient
Civilization Parts). So each variant gets its own entry with its own `recipe`,
a `rarity` field, and a shared `family` id linking the tiers together for the UI.

### Schema

`src/data/items.json`:

```json
{
  "schemaVersion": 1,
  "gameVersion": "0.6.x",
  "items": {
    "assault_rifle": {
      "name": "Assault Rifle",
      "icon": "icons/assault_rifle.webp",
      "category": "weapon",
      "rarity": "common",
      "family": "assault_rifle",
      "techLevel": 45,
      "recipe": {
        "stations": ["weapon_assembly_line", "weapon_assembly_line_2", "advanced_weapon_assembly_line"],
        "yields": 1,
        "ingredients": [
          { "item": "refined_ingot", "qty": 40 },
          { "item": "polymer", "qty": 10 },
          { "item": "carbon_fiber", "qty": 10 }
        ]
      }
    },
    "assault_rifle_legendary": {
      "name": "Assault Rifle (Legendary)",
      "icon": "icons/assault_rifle.webp",
      "category": "weapon",
      "rarity": "legendary",
      "family": "assault_rifle",
      "recipe": {
        "stations": ["weapon_assembly_line", "weapon_assembly_line_2", "advanced_weapon_assembly_line"],
        "yields": 1,
        "ingredients": [
          { "item": "refined_ingot", "qty": 80 },
          { "item": "polymer", "qty": 20 },
          { "item": "carbon_fiber", "qty": 20 },
          { "item": "ancient_civilization_parts", "qty": 4 }
        ]
      }
    },
    "wood": { "name": "Wood", "icon": "icons/wood.webp", "category": "material", "rarity": "common" }
  }
}
```

`src/data/stations.json`:

```json
{
  "weapon_assembly_line": {
    "name": "Weapon Assembly Line",
    "icon": "icons/station_weapon_assembly_line.webp",
    "techLevel": 30
  }
}
```

Rules:

- **Key = stable kebab-case id** derived from paldb.cc's internal codes
  (e.g. `AssaultRifle_Default1..5` → `assault_rifle`,
  `assault_rifle_uncommon`, … `assault_rifle_legendary`). Never key by
  display name.
- **Raw material = no `recipe` key.** That's the leaf test.
- **`rarity`** on every item: `common | uncommon | rare | epic | legendary`.
- **`family`** groups rarity variants of the same base item (omit for items
  with no variants); the UI uses it for a rarity switcher and picker grouping.
- **`stations` is an array** — a recipe can be crafted at any listed station
  (game tiers them, e.g. Weapon Assembly Line I/II/Advanced). UI shows the
  lowest-tech one by default.
- `yields` covers batch recipes (output > 1 per craft): crafts needed =
  `ceil(qty / yields)`, ingredient amounts scale by crafts, not qty.
- `recipe` stays a single object, but **multi-recipe items are confirmed to
  exist** (Carbon Fiber, verified on paldb.cc 2026-07-27: Coal×2 + Flame
  Organ×1 OR Charcoal×5 + Flame Organ×1, same stations/tech). Convention until
  the schema grows a `recipes` array: store the cheapest-in-raw-resources
  recipe as primary, and the Phase 3 scraper must log every alternate it
  drops (bump `schemaVersion` when migrating to an array).
- `techLevel` = tech tree unlock level (also used for sorting/filtering).
- Icons are **local files** under `public/icons/`, named by item id — no
  hotlinking, works offline. Variants of a family may share one icon file.

## 2. Data acquisition — scrape paldb.cc (primary), palworld.gg (cross-check)

Both sites verified server-rendered (2026-07-27) — plain `fetch` + an HTML
parser (cheerio) is enough, no headless browser.

- **Primary: paldb.cc.** Canonical datamine of the game files. One detail page
  per item family (e.g. `/en/Assault_Rifle`) carries **all rarity variants with
  their distinct recipes**, stations, tech level, and internal codes
  (`AssaultRifle_Default1..5`) — perfect for the schema above. Icons come from
  a clean CDN pattern:
  `https://cdn.paldb.cc/image/Others/InventoryItemIcon/Texture/T_itemicon_*.webp`.
- **Cross-check/fallback: palworld.gg/items.** Also server-rendered; its list
  view exposes name, category, rarity, level, price, and recipe inline — useful
  to spot-check the paldb scrape or fill gaps.

`scripts/fetch-data.mjs` (Node, no deps beyond cheerio):

1. Fetch the item index (`/en/Items`) → collect detail-page URLs.
2. Fetch each detail page **throttled (~1 req/sec)**; cache raw HTML in
   `scripts/.cache/` so re-runs and parser iterations don't re-hit the site.
   **Send a browser `User-Agent` + `Referer: https://paldb.cc/...` on every
   request** — the CDN's `BuildObject` path (station icons) intermittently
   403s bare curl-style requests (observed 2026-07-27); item-icon and page
   fetches worked bare but should send the headers anyway.
3. Parse name, category, rarity variants + recipes, stations, tech level,
   icon URL per entry → emit `items.json` + `stations.json`.
4. Download each icon once into `public/icons/<id>.webp`.
5. Emit a report of unparseable pages / missing ingredients (an ingredient id
   referenced by a recipe but absent from `items` = hard error).

Run manually per game patch; commit the regenerated JSON + any new icons.

## 3. Stack — Vite + React, fully static

- **Vite + React 19 + Tailwind 4.** Recursive tree = recursive component;
  no backend, no DB — `npm run dev` locally, `npm run build` → static `dist/`
  (host on Cloudflare Pages later if ever wanted). Svelte 5 would be an equally
  good fit — React chosen only to pick one.
- Data loads via **static `import` of the JSON** (Vite bundles it) — simpler
  than a runtime fetch and identical in effect at this scale; everything else
  is pure client-side computation.
- Data integrity is checked by `scripts/validate-data.mjs`
  (`npm run validate`): every ingredient/station reference resolves and every
  icon path maps to a real file under `public/`. Run it whenever the data or
  icons change.

## 4. Core logic (`src/lib/tree.js`)

```js
function buildTree(itemId, qty, visited = new Set()) {
  const item = items[itemId];
  if (!item.recipe || visited.has(itemId)) return { itemId, qty, children: [] };
  const crafts = Math.ceil(qty / (item.recipe.yields ?? 1));
  const next = new Set(visited).add(itemId);            // cycle guard
  return {
    itemId, qty, stations: item.recipe.stations,
    children: item.recipe.ingredients.map(i => buildTree(i.item, i.qty * crafts, next))
  };
}

function aggregateRaw(node, totals = new Map()) {       // RAW MATERIALS strip
  if (!node.children.length) totals.set(node.itemId, (totals.get(node.itemId) ?? 0) + node.qty);
  node.children.forEach(c => aggregateRaw(c, totals));
  return totals;
}
```

Palworld recipes are acyclic, but the visited-set guard costs nothing and
prevents a bad data edit from hanging the page.

## 5. UI

Components:

- **`ItemBrowser`** (picker) — searchable, **sortable and filterable** item
  grid/list:
  - **Filters:** category (weapon / armor / material / ammo / consumable /
    sphere / accessory / …), rarity (color-coded chips), craftable-only
    toggle, station (show items craftable at X).
  - **Sorting:** name, category, rarity, tech level.
  - Filter/sort state is plain derived-array computation over the loaded JSON —
    no library needed. Families collapse to one card with rarity dots; clicking
    expands the variants.
- **Quantity input** — "craft N", default 1; multiplies the whole tree.
- **`CraftTree` / `TreeNode`** — recursive top-down layout: node card
  (icon, amount badge, name, **rarity-colored border** — gray/green/blue/
  purple/orange matching game colors) with a **station chip** (icon + name of
  the lowest-tier valid station; tooltip lists the rest) on crafted nodes;
  children in a flex row beneath. Connectors via the classic CSS-borders tree
  technique (`ul/li` with `::before/::after` half-borders) — no layout library.
  The tree lives in an `overflow-x: auto` container; deep chains scroll
  horizontally.
- **Rarity switcher** on the tree header — when the selected item has a
  `family`, show tabs for each rarity tier to flip the whole tree between
  variant recipes.
- **Per-node collapse toggle** — click a node to fold its subtree (amount badge
  stays correct since math is computed on the full tree).
- **`RawSummary`** — sticky strip of aggregated leaf totals, mirroring the
  reference image's RAW MATERIALS panel.
- Dark theme by default (matches game-tool aesthetics and the reference).

Stretch (later, only if wanted):

- "Treat as raw" toggle per intermediate item (you have ingots stockpiled →
  stop expanding, count them in the summary).
- Subtract-what-I-have inventory inputs on the summary.
- Shareable URL state (`?item=assault_rifle_legendary&qty=3`).

## 6. Project structure

```
Paltree/
  PLAN.md
  index.html
  package.json
  public/
    icons/                  # one .webp per item/station id
  src/
    data/items.json
    data/stations.json
    lib/tree.js             # buildTree, aggregateRaw (pure, unit-testable)
    lib/filter.js           # category/rarity/craftable filters + sort comparators
    components/
      ItemBrowser.jsx       # search + filters + sort
      CraftTree.jsx
      TreeNode.jsx
      RaritySwitcher.jsx
      RawSummary.jsx
    App.jsx
    main.jsx
  scripts/
    fetch-data.mjs          # paldb.cc scraper → JSON + icons (throttled, cached)
    .cache/                 # raw HTML cache (gitignored)
```

## 7. Implementation phases

**Status (2026-07-27): phases 1–4 all shipped** and live at
https://keisi.github.io/CraftPal/. Post-phase work: compact indented tree
view (default) + Compact/Diagram toggle + collapse/expand-all, lazy-loaded
icons, and a crafting-tasks build list. The per-phase notes below are kept
as the original plan of record.

1. **Scaffold** — Vite + React + Tailwind; hand-written sample `items.json`
     covering one full multi-rarity weapon chain (Assault Rifle Common +
     Legendary → refined ingot → polymer → carbon fiber → raws) so the schema's
     rarity/family/stations features are exercised from day one; first commit
     on `main`.
2. **Tree core** — `tree.js` + recursive render + connectors + station chips +
     rarity styling + raw summary. Site is already useful for the sample items.
3. **Full data** — `fetch-data.mjs` against paldb.cc (cache → parse → emit →
     icons); cross-check ~5 known recipes against palworld.gg/the game,
     including one legendary schematic recipe.
4. **Browse & polish** — ItemBrowser with search, category/rarity filters,
     sorting, rarity switcher, collapse, dark styling pass.

Each phase is a natural commit/stopping point.

## 8. Future — pal habitats / spawn locations (feasibility done 2026-07-27)

**Verdict: portable, and better than first thought.** The original feasibility
pass (below) treated palworld.gg as the source and concluded we'd have to
snapshot a minified build artifact. Deeper recon on 2026-07-27 found that
**paldb.cc — the datamine we already scrape for items — serves the same data
from stable, unhashed JSON endpoints, with day/night *and* per-point levels.**
So paldb.cc is the primary source and palworld.gg is demoted to a cross-check.

### Source hierarchy (implemented)

| Data | Source | Why |
|---|---|---|
| POI markers | `https://paldb.cc/js/map_data_en.js` | Stable URL. **13,944 markers / 71 types** — fast travel (137), towers (8), dungeons (170), alpha pals (83), effigies, eggs, ore/coal/sulfur/quartz nodes, fishing spots, NPCs, merchants, bounties, regions. Richer than palworld.gg's set. |
| Pal habitats | `https://paldb.cc/paldex/<code>.json` | **Day/night separated**, `lv` on each point, plus a spawn `Radius`. Lamball = 351 day + 351 night. |
| All habitats in bulk | `https://paldb.cc/DataTable/UI/DT_PaldexDistributionData.json` | The raw game DataTable — **365 pals in one 18.7 MB fetch**, but no `lv`. Completeness cross-check only. |
| Pal name / icon / drops | paldb.cc `/en/Pals` + per-pal pages | "Possible Drops" table gives the item→pal link the crafting app actually needs. |
| Map tiles | `https://cdn.paldb.cc/image/map8/z{z}x{x}y{y}.webp` | 512px webp, maxNativeZoom 4. |
| Cross-check | palworld.gg `/_nuxt/*.js` chunk | Independent extraction of the same game data — a real disagreement signal. Ships no data. |

`map_data_en.js` declares 6 vars (`iconLookup`, `extrasIngame`, `extras`,
`config`, `fixedDungeon`, `regionData`); `fixedDungeon` is the 2.1 MB marker
array. It is JS, not JSON — slice each `var X =` literal by bracket matching and
`JSON.parse` it. **Never `eval` it.**

**Coordinate systems agree across both sites**, which is the strongest evidence
either extraction is right: paldb's `config.landScapeRealPosition{Min,Max}` is
exactly the `x ∈ [-1099400, 349400], y ∈ [-724400, 724400]` box derived
independently from palworld.gg's projection maths. paldb additionally gives the
player-facing in-game coordinate readout (`perPixel = 459` plus the
`ingame_{x,y}_start` offsets), so we can label points the way the game does.

### Original palworld.gg findings (kept — still true, now the fallback)

Findings from probing https://palworld.gg/map:

- It's a **Nuxt SSR app with no data API**. `/map/_payload.json` returns 69
  bytes (empty), `__NUXT_DATA__` is i18n/site-config only, and
  `/data/pals/en.json` 404s — that path is a build-time import, not a route.
- **All map data is baked into one content-hashed client chunk** —
  `/_nuxt/Ce88gNM6.js`, 1.46 MB on 2026-07-27.
- **Habitat data shape:** one master object literal maps a pal's internal code
  to a minified variable holding a flat point cloud, `[[x, y], ...]`. Verified
  extraction: **239 pals, 54,811 points, 0 unresolved**, ~1.1 MB of JSON, using
  a ~60-line parser (find the `wolf_dark:`-style anchor → walk the balanced
  braces → resolve each `VAR=[...]` or `VAR=JSON.parse("...")` by bracket
  matching). Some pals legitimately share an identical array (co-located
  spawners), so duplicate point clouds are not a parser bug.
- **Other marker sets in the same chunk** (same technique): `fastTravel`,
  `tower`, `dungeon`, `note`, `effigy`, `egg`, `skillFruit`, plus an alpha-pal
  array of `{x, y, pal, lv: [min, max]}`.
- **Coordinate space:** raw world units. Observed extent
  x ∈ [-1045845, 214637], y ∈ [-635335, 593451]. The site projects with
  `l = (x + 1099400) / 1448800`, `k = (y + 724400) / 1448800` →
  `[-256 + 256l, 256k]`, then a MapLibre Mercator unproject — i.e. the world is
  a 1448800-unit square over x ∈ [-1099400, 349400], y ∈ [-724400, 724400].
  That transform is all we need; we do not need MapLibre.
- **What .gg does *not* have: day/night.** Its dataset is a single cloud per
  pal — the gap that demoted it to cross-check once paldb's `/paldex/` endpoint
  turned up with day/night *and* levels.
- **Legal/politeness:** `robots.txt` is `Disallow:` (empty — nothing
  disallowed) and there is no `/terms` page (404). The underlying facts are
  Pocketpair's game data; the point clouds are each site's extraction of it.
  Attribute both sources in the UI, fetch once per game patch, never at runtime.
- **Fragility.** The chunk filename is content-hashed, so it changes on every
  deploy. Do **not** hardcode it: fetch `/map`, enumerate the `/_nuxt/*.js` it
  references, and pick the chunk containing the anchor. (paldb.cc needs no such
  resolver — its URLs are stable, which is the other reason it won.)

### Pipeline

1. `scripts/fetch-map.mjs` → `public/games/palworld/data/map.json` + the tile
   pyramid. Hard-errors if any of the 6 vars is missing or the marker count
   collapses — the tripwire for an upstream format change.
2. `scripts/fetch-pals.mjs` → `src/data/palworld/pals.json` (small, bundled
   index: name, icon, drops, counts) + one lazy
   `public/games/palworld/data/habitats/<code>.json` per pal holding flat
   `[x,y,lv, ...]` integer triples for day and night. Per-pal files so opening
   the map never downloads every pal's cloud.
3. `scripts/crosscheck-palworldgg.mjs` → report only, no shipped data.
4. The feature this all exists for: **item → which pals drop it → where they
   live**, which closes the "where do I farm this ingredient" loop for
   non-crafted materials.
5. UI (next phase): canvas/SVG point overlay on the tile pyramid, day/night
   toggle, level labels.

Model it as a **generic `sources.json`** (see §9), not a Palworld-shaped table —
"this item comes from mob X / node Y / biome Z" is exactly the same question in
Minecraft and No Man's Sky.

## 9. Future — make it game-agnostic (port to NMS / Minecraft / …)

Goal: the app is a **crafting-tree engine**; a game is *just* a JSON bundle.

**Current state — better than expected.** The core is already data-driven:
`tree.js`/`plan.js` only know `recipe.{ingredients,stations,yields}`, and every
filter option list is derived from the loaded data at render time
(`deriveCategories`/`deriveRarities`/`deriveStations`, `filter.js:180-211`) —
no hardcoded item, category, or station lists anywhere. ~2.3k LOC of `src/`,
most of it generic. The port is a refactor, not a rewrite.

**The actual couplings, all of them:**

| # | Coupling | Where |
|---|---|---|
| 1 | 5-tier Palworld rarity ladder + Tailwind class maps | `src/lib/rarity.js:6` (+3 style maps) |
| 2 | `techLevel` as a named concept — sort label "Tech level", station ordering | `src/lib/filter.js:156-169,197-211`, `src/components/StationChip.jsx:6` |
| 3 | `family` = "rarity variants of one weapon" | `src/lib/filter.js:32-78`, `RaritySwitcher.jsx` |
| 4 | "station" as user-facing vocabulary ("Any station") | `src/components/ItemBrowser.jsx:205` |
| 5 | Branding: title, `CraftPal` / "Palworld crafting-tree explorer", pkg name, `/CraftPal/` base | `index.html:7`, `src/App.jsx:376-377`, `package.json`, `vite.config.js` |
| 6 | **One dataset bound at build time** — `data.js` static-imports the two JSONs and 6 components import that singleton directly | `src/lib/data.js:8-12`; `App.jsx:2`, `RawSummary.jsx:2`, `StationChip.jsx:1`, `TasksView.jsx:1`, `TreeNode.jsx:1`, `TreeRows.jsx:1` |
| 7 | Scraper is paldb.cc end-to-end, writing fixed paths | `scripts/fetch-data.mjs:43-46,80-115` |
| 8 | Icons share one flat namespace | `public/icons/<id>.webp` |

(7) is fine and should stay that way — **the scraper is the per-game adapter**.
Every game gets its own `scripts/fetch-<game>.mjs` emitting the common schema.

**Target design:**

- **`game.json` manifest per game** — id, display name, tagline, source
  attribution, and the vocabulary/tier definitions:
  `{ tiers: [{id, label, color}], labels: {station, tier, progression},
  sorts: [...] }`. Colors are **tokens the app maps to classes**, never raw
  Tailwind strings from data (data must not be able to inject classes).
- **Rename to game-neutral domain terms:** `rarity` → `tier`,
  `techLevel` → `progression` (generic ordered unlock number),
  `family` → `variantGroup`, station label from the manifest
  (Palworld "station", NMS "refiner", Minecraft "crafting block").
- **Every game-specific field is optional, and its UI disappears when absent.**
  Already the pattern for categories/rarities/stations — extend it to the
  tier chips, the progression sort, and the variant switcher so a Minecraft
  dataset (no tiers, no tech level) renders a clean UI with no dead controls.
- **Layout:** `src/data/<game>/{game.json,items.json,stations.json,sources.json}`
  and `public/icons/<game>/`.
- **One selection point.** `src/lib/data.js` becomes the loader: `VITE_GAME`
  build-time env (one Pages deploy per game, keeps the static-import bundling
  and tree-shaking we have today) — or a lazy `import()` per game if we ever
  want a single site with a game switcher. Prerequisite either way:
  **stop importing the data singleton inside components** (coupling 6) — thread
  `items`/`stations` through props or a context, or a runtime switch is
  impossible.
- **Schema v2 while we're in there:** `recipes[]` array instead of a single
  `recipe` (Minecraft/NMS have far more alternates than Palworld — see §1's
  Carbon Fiber note), plus the optional `sources` from §8.
- **Validator becomes manifest-driven** — tier ids checked against the
  manifest instead of a hardcoded ladder.
- **Prove it with a fixture game.** Add a tiny synthetic non-Palworld dataset
  and run the existing pure-logic suites against it; that's what stops
  Palworld assumptions creeping back in.

Sequence: manifest + renames → decouple components from `data.js` → loader +
`VITE_GAME` → per-game icon namespace → fixture-game tests → second real game.

### Result of the second-game test (Minecraft, 2026-07-27)

Ported Minecraft (1,610 items, 1,076 craftable, 8 stations, from vanilla's own
data via misode/mcmeta) on the local-only `feat/minecraft-game` branch — never
merged, because Pages serves Palworld. Deliberately chosen because Minecraft has
**no rarity tiers, no tech levels and no map**, which is what §9 claims to
support.

**§9's component contract held.** Zero files under `src/components/` changed.
Confirmed live: no tier chips, sorts are exactly Name/Category, no Map tab. Real
cycles terminate (`wheat ↔ hay_block`, `cobblestone ↔ stone`,
`raw_iron ↔ raw_iron_block` are genuine single-recipe cycles) with the guard
firing mid-recursion, not just at the root.

**Two gaps the test exposed — the reason it was worth doing:**

1. **§9's loader design was wrong.** A `REGISTRY` object statically importing
   every game inflated the default Palworld bundle by **+25%** (1,022 → 1,275 kB):
   Rollup can't drop an object property read only as `REGISTRY[key]`. The switch
   must happen at Vite **config load time** — alias `virtual:game-data` to just
   the selected game's `src/data/<game>/index.js` — so the unselected game is
   provably absent from the module graph. Palworld then returns to 1,021.91 kB and
   Minecraft builds at 490.97 kB, each verified to contain none of the other's
   data. See CLAUDE.md → "Adding another game".
2. **§1's schema can't express "any of a set."** 93 Minecraft recipes key on a
   multi-member tag (`#minecraft:logs` = 48 members), so one representative
   stands in for many and the tree reads "Campfire needs Oak Log ×3" instead of
   "any log". Same failure shape as the egg-"Contains" trap in §8: a
   representative presented as fact. Needs an optional `anyOf` on an ingredient
   plus UI support — **schema v3**, not yet done.

## Sources

- paldb.cc — datamined items/recipes/icons: https://paldb.cc/en/Items ,
  example multi-rarity detail page: https://paldb.cc/en/Assault_Rifle ,
  icon CDN: `https://cdn.paldb.cc/image/Others/InventoryItemIcon/Texture/`
- palworld.gg items (cross-check source): https://palworld.gg/items
- **paldb.cc map + habitat endpoints (primary, §8)** — all stable URLs:
  markers `https://paldb.cc/js/map_data_en.js` ,
  per-pal day/night spawns `https://paldb.cc/paldex/<code>.json` ,
  bulk game DataTable `https://paldb.cc/DataTable/UI/DT_PaldexDistributionData.json` ,
  map page `https://paldb.cc/en/Palpagos_Islands` ,
  tiles `https://cdn.paldb.cc/image/map8/z{z}x{x}y{y}.webp` ,
  pal detail page `https://paldb.cc/en/Lamball`
- palworld.gg interactive map (cross-check only, §8):
  https://palworld.gg/map — data lives in a hashed `/_nuxt/*.js` chunk, tiles at
  `/images/tiles/{z}/{x}/{y}.png`
- Community recipe JSON precedent: https://github.com/danaildichev/PalWorldResourceCalculator/
