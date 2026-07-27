# Paltree — Palworld Crafting Tree Explorer (Plan)

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

## Sources

- paldb.cc — datamined items/recipes/icons: https://paldb.cc/en/Items ,
  example multi-rarity detail page: https://paldb.cc/en/Assault_Rifle ,
  icon CDN: `https://cdn.paldb.cc/image/Others/InventoryItemIcon/Texture/`
- palworld.gg items (cross-check source): https://palworld.gg/items
- Community recipe JSON precedent: https://github.com/danaildichev/PalWorldResourceCalculator/
