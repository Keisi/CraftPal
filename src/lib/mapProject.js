// World (raw game) coordinates -> tile-pixel coordinates (PLAN.md §8). No
// React, no Vite-specific imports, no map library (Leaflet et al.) — must run
// standalone under plain Node (see mapProject.test.mjs), same convention as
// tree.js/filter.js.
//
// PORTED, not reinvented, from paldb.cc's own Leaflet map client
// (scratchpad/paldb-map.js — PalMap.rposToScale / .projTpos, and
// paldb-map.html's `options` block for the in-game-coordinate constants).
// paldb draws the mapping through Leaflet's CRS.Simple + unproject(), which
// folds in a pile of Leaflet-only zoom bookkeeping: their initMap() even
// *mutates* config.minMapTextureBlockSize (by 2**0, then by 2**4) before
// using it, converting their native-zoom-4 texture size into the pixel space
// of the zoom-8 view Leaflet actually renders, because every call site does
// `map.unproject(pos, map.getMaxZoom())` with getMaxZoom() = 8. None of that
// is meaningful once you don't have a Leaflet map object. What's actually
// load-bearing, and what this module ports, is the linear relationship their
// code computes underneath it:
//
//   scale.X = (world.x - minX) / (maxX - minX)   // 0..1 across the world bbox
//   scale.Y = (world.y - minY) / (maxY - minY)
//   pixel.x = scale.Y * SIZE                       // column ("screen right")
//   pixel.y = (1 - scale.X) * SIZE                  // row ("screen down")
//
// where SIZE is the pixel width/height of the *whole* map image at a given
// zoom. For our own XYZ tile pyramid (tileSize 512, standard doubling per
// zoom level) SIZE = 512 * 2**zoom — the ratio above is identical at every
// zoom, since SIZE simply scales by a power of two between pyramid levels,
// exactly like paldb's own zoom-4-vs-zoom-8 rescale. That's `rposToScale` +
// `projTpos` from paldb-map.js with Leaflet's zoom-8 indirection stripped out.
//
// Orientation (world Y -> screen column; world X, inverted -> screen row) is
// NOT a guess — see the map-feature build report for the full evidence trail:
// (1) paldb's own in-game-coordinate formula (perPixel=459 plus the
// ingame_x/y_start offsets from paldb-map.html) independently re-derives the
// exact ix/iy already stored on every real marker in map.json, to the
// integer, from that marker's world x/y — see mapProject.test.mjs's
// "in-game coordinate cross-check"; (2) an outside source (web search, not
// this codebase) independently reports Small Settlement at in-game coords
// (75, -479), matching our data's (75, -480); (3) plotting named markers
// (Small Settlement / Mount Obsidian / Duneshelter / Frostbound Mountains)
// through this exact formula onto the real z0 tile image lands each one on
// the correctly-colored biome patch (grassland / volcanic-purple /
// desert-tan / snow-white respectively) — visually confirmed by reading the
// tile file directly.

// Pixel width/height of one tile image, matching the downloaded pyramid
// (public/games/palworld/tiles/z{z}x{x}y{y}.webp) and paldb's own
// `tileSize: 512` Leaflet option.
export const TILE_SIZE = 512;

// Zoom range actually mirrored under public/games/palworld/tiles/ (z0 = one
// 512px tile, z3 = 8x8 tiles = 4096px square — 85 files total, see the map
// build report). A future non-Palworld port would need this sourced from
// whatever tile pyramid that game ships instead of hardcoded here.
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 3;

/** Pixel width/height of the whole map image at `zoom` (square). */
export function mapSizeAtZoom(zoom) {
  return TILE_SIZE * 2 ** zoom;
}

/**
 * World (raw game) coordinates -> pixel coordinates in the full map image at
 * `zoom`. Ported 1:1 from paldb.cc's rposToScale + projTpos (see module
 * docblock) — the axis swap (world Y -> pixel column) and the flip (world X
 * inverted -> pixel row) are both load-bearing, not incidental.
 *
 * @param {{x: number, y: number}} world
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds - map.json's `world`.
 * @param {number} zoom
 * @returns {{x: number, y: number}} pixel position (column, row), each in [0, mapSizeAtZoom(zoom)].
 */
export function worldToPixel(world, bounds, zoom) {
  const { minX, minY, maxX, maxY } = bounds;
  const scaleX = (world.x - minX) / (maxX - minX);
  const scaleY = (world.y - minY) / (maxY - minY);
  const size = mapSizeAtZoom(zoom);
  return { x: scaleY * size, y: (1 - scaleX) * size };
}

/**
 * Inverse of worldToPixel: a pixel position in the full map image at `zoom`
 * back to world (raw game) coordinates.
 *
 * @param {{x: number, y: number}} pixel
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} bounds
 * @param {number} zoom
 * @returns {{x: number, y: number}}
 */
export function pixelToWorld(pixel, bounds, zoom) {
  const { minX, minY, maxX, maxY } = bounds;
  const size = mapSizeAtZoom(zoom);
  const scaleY = pixel.x / size;
  const scaleX = 1 - pixel.y / size;
  return { x: minX + scaleX * (maxX - minX), y: minY + scaleY * (maxY - minY) };
}

/**
 * The in-game coordinate label a player reads off their in-game compass/map.
 * Every marker in map.json already carries `ix`/`iy` (paldb's own ipos,
 * computed once at fetch time) — this only *formats* them, it deliberately
 * never recomputes from world x/y (that would risk drifting from the value
 * actually shown elsewhere for the same marker).
 *
 * @param {{ix?: number, iy?: number}} marker
 * @returns {string|null} "X, Y", or null if the marker has no ipos.
 */
export function formatIngameCoord(marker) {
  if (marker?.ix == null || marker?.iy == null) return null;
  return `${marker.ix}, ${marker.iy}`;
}
