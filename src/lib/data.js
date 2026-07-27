// Per-game loader + registry (PLAN.md §9). Selects a game's manifest +
// dataset at build time from VITE_GAME (default "palworld") via static
// imports, so Vite still bundles + tree-shakes per-game builds — adding a
// second game means adding a registry entry here, not touching any
// component. On-disk shape quirks (items.json nests its map under `.items`;
// stations.json is already a flat map) are insulated in this one place.
//
// This module is imported in exactly ONE place — src/GameProvider.jsx —
// which threads the result through React context (src/lib/GameContext.js) so
// no component imports a dataset singleton directly (coupling #6).

import palworldGame from '../data/palworld/game.json';
import palworldItemsDoc from '../data/palworld/items.json';
import palworldStationsDoc from '../data/palworld/stations.json';

const REGISTRY = {
  palworld: {
    manifest: palworldGame,
    items: palworldItemsDoc.items,
    stations: palworldStationsDoc,
  },
};

const DEFAULT_GAME = 'palworld';
const requestedGame = import.meta.env.VITE_GAME || DEFAULT_GAME;
const selected = REGISTRY[requestedGame] ?? REGISTRY[DEFAULT_GAME];

export const manifest = selected.manifest;
export const items = selected.items;
export const stations = selected.stations;
