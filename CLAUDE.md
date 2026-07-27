# Paltree

Personal-use static site: pick a Palworld item → recursive crafting tree with
amounts, stations, icons, and a raw-materials summary. **`PLAN.md` is the source
of truth — read it before working.** Phase status lives in its §7.

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
  - From Phase 3 on, this JSON is **generated** by `scripts/fetch-data.mjs`
    (paldb.cc scrape) — regenerate, don't hand-edit. Until then it's a
    hand-written sample.
- **Icons:** local files only, `public/icons/<id>.webp` — never hotlink.
- **Verify:** `npm run build` must pass before any commit.
