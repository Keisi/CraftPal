// Palworld's per-game data entry (PLAN.md §9). This file's ONLY job is to
// import this game's own JSON and normalize its on-disk quirks (items.json
// nests its map under `.items`; stations.json/pals.json are already flat) —
// see src/lib/data.js and vite.config.js for why this is a separate file
// rather than inline in data.js.
import palworldGame from './game.json';
import palworldItemsDoc from './items.json';
import palworldStationsDoc from './stations.json';
import palworldPalsDoc from './pals.json';

export const manifest = palworldGame;
export const items = palworldItemsDoc.items;
export const stations = palworldStationsDoc;
// Small, bundled per-pal index (name/icon/drops/habitat summary) — the
// "Dropped by" reverse index (src/lib/drops.js) is built from this. The
// *heavy* per-pal point clouds and map.json stay lazy-fetched
// (src/lib/mapData.js), never static-imported like this.
export const pals = palworldPalsDoc.pals;
