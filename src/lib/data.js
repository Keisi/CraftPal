// Single import point for the loaded dataset (PLAN.md §6, Phase 4 refactor).
// Every component imports items/stations from here instead of reaching into
// src/data/*.json directly, so the on-disk shape (items.json nests its map
// under `.items`; stations.json is already a flat map) is insulated in one
// place — the data-generation agent can grow either file to the full ~600+
// item scrape without any consuming component changing.

import itemsDoc from '../data/items.json';
import stationsDoc from '../data/stations.json';

export const items = itemsDoc.items;
export const stations = stationsDoc;
