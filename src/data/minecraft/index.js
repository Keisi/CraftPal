// Minecraft's per-game data entry (PLAN.md §9) — the counterpart to
// src/data/palworld/index.js. No pals dataset for this game; `pals` is left
// undefined, and every consumer (useGame() callers, src/lib/drops.js,
// DroppedBy.jsx) already degrades cleanly when it's absent.
import minecraftGame from './game.json';
import minecraftItemsDoc from './items.json';
import minecraftStationsDoc from './stations.json';

export const manifest = minecraftGame;
export const items = minecraftItemsDoc.items;
export const stations = minecraftStationsDoc;
export const pals = undefined;
