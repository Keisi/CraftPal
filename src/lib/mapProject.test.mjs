import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { worldToPixel, pixelToWorld, formatIngameCoord, mapSizeAtZoom, TILE_SIZE, MIN_ZOOM, MAX_ZOOM } from './mapProject.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real world bounds from the generated dataset (PLAN.md §8) — same numbers
// paldb.cc's own config.landScapeRealPositionMin/Max carries, independently
// corroborated by palworld.gg's projection maths (PLAN.md §8 "Coordinate
// systems agree across both sites").
const BOUNDS = { minX: -1099400, minY: -724400, maxX: 349400, maxY: 724400 };

describe('mapSizeAtZoom', () => {
  test('doubles per zoom level, tileSize at zoom 0', () => {
    assert.equal(mapSizeAtZoom(0), TILE_SIZE);
    assert.equal(mapSizeAtZoom(1), TILE_SIZE * 2);
    assert.equal(mapSizeAtZoom(3), TILE_SIZE * 8);
  });
});

describe('worldToPixel: world-bounds corners map to the expected pixel-space corners', () => {
  // Ported from paldb-map.js projTpos: pixel.x = scaleY * SIZE (column),
  // pixel.y = (1 - scaleX) * SIZE (row) — an axis swap (world Y -> column)
  // plus a flip (world X inverted -> row). Verified against real biome
  // placement + an outside source, see mapProject.js's docblock.
  const zoom = 2;
  const size = mapSizeAtZoom(zoom);

  test('(minX, minY) -> bottom-left (0, size)', () => {
    const p = worldToPixel({ x: BOUNDS.minX, y: BOUNDS.minY }, BOUNDS, zoom);
    assert.equal(p.x, 0);
    assert.equal(p.y, size);
  });

  test('(maxX, minY) -> top-left (0, 0)', () => {
    const p = worldToPixel({ x: BOUNDS.maxX, y: BOUNDS.minY }, BOUNDS, zoom);
    assert.equal(p.x, 0);
    assert.equal(p.y, 0);
  });

  test('(minX, maxY) -> bottom-right (size, size)', () => {
    const p = worldToPixel({ x: BOUNDS.minX, y: BOUNDS.maxY }, BOUNDS, zoom);
    assert.equal(p.x, size);
    assert.equal(p.y, size);
  });

  test('(maxX, maxY) -> top-right (size, 0)', () => {
    const p = worldToPixel({ x: BOUNDS.maxX, y: BOUNDS.maxY }, BOUNDS, zoom);
    assert.equal(p.x, size);
    assert.equal(p.y, 0);
  });

  test('bbox center -> pixel-space center', () => {
    const center = { x: (BOUNDS.minX + BOUNDS.maxX) / 2, y: (BOUNDS.minY + BOUNDS.maxY) / 2 };
    const p = worldToPixel(center, BOUNDS, zoom);
    assert.ok(Math.abs(p.x - size / 2) < 1e-6);
    assert.ok(Math.abs(p.y - size / 2) < 1e-6);
  });
});

describe('round trip: world -> pixel -> world', () => {
  test('recovers the original world coordinate within floating-point tolerance', () => {
    const zoom = 3;
    const samples = [
      { x: -867561, y: -441338 }, // real "Faleris Aqua" Alpha Pal marker
      { x: 0, y: 0 },
      { x: -1099400, y: -724400 }, // exact bounds corner
      { x: 349400, y: 724400 },
      { x: -346618, y: 191707 }, // real "Small Settlement" marker
    ];
    for (const world of samples) {
      const pixel = worldToPixel(world, BOUNDS, zoom);
      const back = pixelToWorld(pixel, BOUNDS, zoom);
      assert.ok(Math.abs(back.x - world.x) < 1e-6, `x round-trip drifted for ${JSON.stringify(world)}: got ${back.x}`);
      assert.ok(Math.abs(back.y - world.y) < 1e-6, `y round-trip drifted for ${JSON.stringify(world)}: got ${back.y}`);
    }
  });

  test('every mirrored zoom level (0..3) round-trips consistently', () => {
    const world = { x: -108667, y: 79120 }; // "Deserted Islet" fast travel marker
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) {
      const back = pixelToWorld(worldToPixel(world, BOUNDS, zoom), BOUNDS, zoom);
      assert.ok(Math.abs(back.x - world.x) < 1e-6);
      assert.ok(Math.abs(back.y - world.y) < 1e-6);
    }
  });
});

describe('formatIngameCoord', () => {
  test('formats "X, Y" from a marker\'s own ix/iy — never recomputes', () => {
    assert.equal(formatIngameCoord({ ix: -172, iy: 33 }), '-172, 33');
  });

  test('null when ix/iy are absent (never renders "undefined, undefined")', () => {
    assert.equal(formatIngameCoord({}), null);
    assert.equal(formatIngameCoord({ ix: 5 }), null);
  });
});

// --- Real-data checks against the generated dataset ------------------------
// map.json is fetched at runtime (never statically imported, PLAN.md §8/§9),
// but reading it here with plain fs is fine — this is a Node test, not
// something that ends up in the Vite bundle.
describe('real markers from map.json', () => {
  const mapPath = path.join(__dirname, '..', '..', 'public', 'games', 'palworld', 'data', 'map.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));

  test('world bounds in the generated dataset match the corners this module was verified against', () => {
    assert.equal(map.world.minX, BOUNDS.minX);
    assert.equal(map.world.minY, BOUNDS.minY);
    assert.equal(map.world.maxX, BOUNDS.maxX);
    assert.equal(map.world.maxY, BOUNDS.maxY);
  });

  test('at least 3 real markers of different types land inside the pixel bounds at every mirrored zoom', () => {
    const byType = new Map();
    for (const marker of map.markers) {
      if (!byType.has(marker.type)) byType.set(marker.type, marker);
      if (byType.size >= 5) break;
    }
    assert.ok(byType.size >= 3, 'expected at least 3 distinct marker types in the fixture data');

    for (const marker of byType.values()) {
      for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) {
        const size = mapSizeAtZoom(zoom);
        const p = worldToPixel({ x: marker.x, y: marker.y }, map.world, zoom);
        assert.ok(p.x >= 0 && p.x <= size, `${marker.type} "${marker.name}" x=${p.x} out of [0,${size}] at zoom ${zoom}`);
        assert.ok(p.y >= 0 && p.y <= size, `${marker.type} "${marker.name}" y=${p.y} out of [0,${size}] at zoom ${zoom}`);
      }
    }
  });

  // Independent-ish consistency check (PLAN.md §8 / task spec): every marker
  // carries BOTH its raw world x/y and the in-game ix/iy a player reads off
  // their compass. paldb.cc computes ix/iy from x/y via a *different*
  // formula (perPixel=459 plus fixed ingame_x/y_start offsets, ported in
  // scripts/fetch-map.mjs's rposToIpos) than the one this module ports for
  // tile pixels (rposToScale/projTpos) — both ultimately derive from the same
  // world bounds, so this isn't a fully independent *source*, but it is an
  // independent *formula*, and it is exactly the check the task asked for:
  // do our own world x/y and the ix/iy already sitting on the marker agree?
  test('in-game coordinate cross-check: ix/iy re-derived from world x/y matches the stored values', () => {
    const PER_PIXEL = 459;
    const IPOS_X_REF = 301000;
    const IPOS_Y_REF = 582888;
    const rposToIpos = (x, y) => ({
      ix: Math.round((y + IPOS_X_REF) / PER_PIXEL) - 1000,
      iy: Math.round((x + IPOS_Y_REF) / PER_PIXEL) - 1000,
    });

    const withIpos = map.markers.filter((m) => m.ix != null && m.iy != null && m.x != null && m.y != null);
    assert.ok(withIpos.length > 100, 'expected plenty of markers with both world and in-game coords');

    // Sample a spread of markers (not just the first N, which are all one type).
    const sample = [];
    const step = Math.max(1, Math.floor(withIpos.length / 25));
    for (let i = 0; i < withIpos.length; i += step) sample.push(withIpos[i]);

    let maxResidual = 0;
    let sumResidual = 0;
    for (const marker of sample) {
      const derived = rposToIpos(marker.x, marker.y);
      const residual = Math.max(Math.abs(derived.ix - marker.ix), Math.abs(derived.iy - marker.iy));
      maxResidual = Math.max(maxResidual, residual);
      sumResidual += residual;
      assert.ok(
        residual <= 1,
        `"${marker.name}" (${marker.type}): world (${marker.x},${marker.y}) -> derived ipos ` +
          `(${derived.ix},${derived.iy}) vs stored (${marker.ix},${marker.iy}), residual ${residual}`,
      );
    }
    // eslint-disable-next-line no-console -- deliberate: the task asks to report the residual, not just assert on it.
    console.log(
      `    in-game coord cross-check over ${sample.length} sampled markers: ` +
        `max residual ${maxResidual}, mean residual ${(sumResidual / sample.length).toFixed(3)} (in-game units)`,
    );
  });

  // Small Settlement's in-game coordinates were independently reported by a
  // web search (not derived from this codebase) as approximately (75, -479)
  // — see mapProject.js's docblock. This is the one check in this file whose
  // expected value did NOT come from our own pipeline.
  test('Small Settlement matches an outside-reported in-game coordinate', () => {
    // Two markers share this name (a "Fast Travel" waypoint and a "Region"
    // zone label a few hundred world units apart) — use the Region one,
    // which is the region-centroid a wiki/search result would describe.
    const marker = map.markers.find((m) => m.name === 'Small Settlement' && m.type === 'Region');
    assert.ok(marker, 'expected a "Small Settlement" Region marker in the dataset');
    assert.ok(Math.abs(marker.ix - 75) <= 2, `ix=${marker.ix}`);
    assert.ok(Math.abs(marker.iy - -479) <= 2, `iy=${marker.iy}`);
  });
});
