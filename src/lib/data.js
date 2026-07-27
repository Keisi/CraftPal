// Per-game loader (PLAN.md §9). Re-exports whichever game's data
// vite.config.js aliased `virtual:game-data` to, based on the VITE_GAME
// build-time env (default "palworld") — so Vite still bundles + tree-shakes
// per-game builds. Adding a second game means adding
// src/data/<game>/index.js (its own small normalizer for on-disk shape
// quirks — items.json nests its map under `.items`, etc.) plus one line in
// vite.config.js's alias map; this file itself never changes.
//
// Why the game switch lives in vite.config.js rather than as an object
// literal here (`REGISTRY = { palworld: {...}, minecraft: {...} }` with
// every game's JSON statically imported unconditionally): measured directly
// — that shape grew the DEFAULT Palworld build by +253 KB (+25%) the moment
// a second game was registered, because bundlers don't eliminate an object
// property just because nothing reads it via a dynamic `REGISTRY[key]`
// lookup (that needs whole-module reachability, not property-level
// analysis). Aliasing to only the selected game's index.js means the other
// game's JSON is never even in the resolved module graph for a given
// build — provably, not "hopefully tree-shaken."
//
// This module is imported in exactly ONE place — src/GameProvider.jsx —
// which threads the result through React context (src/lib/GameContext.js) so
// no component imports a dataset singleton directly (coupling #6).

export { manifest, items, stations, pals } from 'virtual:game-data';
