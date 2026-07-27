# CraftPal

Personal-use Palworld crafting-tree explorer: pick an item, see the full
recursive tree of ingredients (amounts, crafting stations, icons) and an
aggregated raw-materials summary — in the style of the classic No Man's Sky
crafting infographics.

**Live site:** https://keisi.github.io/CraftPal/

## Features

- Item browser with search, category/rarity filters, craftable-only and
  by-station filters, and sorting (name / category / rarity / tech level)
- Rarity variants (Common → Legendary) modeled as separate recipes, grouped
  into one card with a rarity switcher on the tree view
- Recursive crafting tree with per-node collapse, quantity multiplier, and
  station chips (lowest-tech station shown, all listed on hover)
- Raw-materials totals strip, computed from the live tree
- Item/recipe data scraped from [paldb.cc](https://paldb.cc) (datamined from
  the game files) by `scripts/fetch-data.mjs`; icons served locally

## Development

```bash
npm install
npm run dev        # dev server (hot reload)
npm test           # node:test suites (tree math, filters)
npm run validate   # data integrity: refs + icon files resolve
npm run build      # production build (base=/CraftPal/)
npm run fetch-data # regenerate src/data/*.json + icons from paldb.cc
```

Data conventions and architecture live in `PLAN.md` (source of truth) and
`CLAUDE.md`. Deploys to GitHub Pages via `.github/workflows/deploy.yml` on
every push to `main`.
