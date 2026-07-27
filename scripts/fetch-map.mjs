#!/usr/bin/env node
// CraftPal map/POI data pipeline: scrapes paldb.cc's Palworld interactive-map
// data file for every marker (resource nodes, bosses, fast travel, dungeons,
// ...), the map's tile pyramid, and the per-marker-type legend icons. See
// PLAN.md §8.
//
// Usage:
//   node scripts/fetch-map.mjs [--limit=N] [--only=map,tiles] [--verbose]
//
// --limit=N   caps the number of NEW network requests (map data / icon / tile
//             fetches) issued in this invocation. Already-cached responses
//             don't count. Omit for a full run. Re-run to resume — everything
//             is cached in scripts/.cache/map/ so a re-run only fetches
//             what's missing.
// --only=map,tiles   restrict which phase(s) run. "map" = fetch+parse
//             map_data_en.js, emit public/games/palworld/data/map.json, and
//             download the marker-type legend icons. "tiles" = download the
//             z0..z3 base-map tile pyramid. Both run by default.
//
// Design:
//   1. Fetch https://paldb.cc/js/map_data_en.js (cached; NOT eval'd — the 6
//      top-level `var`s are located textually and their JSON literal is
//      sliced out with a balanced brace/bracket scanner, then JSON.parse'd).
//   2. Hard-error if any of the 6 vars is missing, or if `fixedDungeon` has
//      fewer than 10,000 entries (tripwire: upstream format changed).
//   3. Normalize every marker (fixedDungeon + extras + extrasIngame +
//      regionData) into one flat array, deriving whichever of
//      {raw world pos, in-game pos} is missing via the ported paldb
//      rowIposFill/transformRposToIpos math (see comment above
//      rposToIpos()). Optional passthrough fields, present only when the
//      upstream entry has them: lv, href, comment, cooldown, spawn, id,
//      onlyTime ("day"/"night" — a day/night spawn restriction, e.g. some
//      Alpha Pal field bosses), boss (tower boss-type flag), itemId (spawn
//      table item id, mostly eggs).
//   4. Emit public/games/palworld/data/map.json (compact, no pretty-print —
//      it ships to the browser).
//   5. Download the ~83 iconLookup marker-type icons into
//      public/games/palworld/icons/markers/<slug>.webp (house rule: no
//      hotlinked runtime assets).
//   6. Download the z0..z3 tile pyramid (85 tiles) into
//      public/games/palworld/tiles/z{z}x{x}y{y}.webp.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CACHE_DIR = path.join(ROOT, 'scripts', '.cache', 'map');
const ICONS_CACHE_DIR = path.join(CACHE_DIR, 'icons');
const TILES_CACHE_DIR = path.join(CACHE_DIR, 'tiles');
const MAP_DATA_CACHE_FILE = path.join(CACHE_DIR, 'map_data_en.js');
const REPORT_OUT = path.join(CACHE_DIR, 'fetch-map-report.json');

const PALWORLD_DIR = path.join(ROOT, 'public', 'games', 'palworld');
const MAP_JSON_OUT = path.join(PALWORLD_DIR, 'data', 'map.json');
const PUBLIC_MARKER_ICONS_DIR = path.join(PALWORLD_DIR, 'icons', 'markers');
const PUBLIC_TILES_DIR = path.join(PALWORLD_DIR, 'tiles');

// NOTE: don't try to resolve egg markers' `itemId` (e.g. "PalEgg_Dragon_01")
// to a single CraftPal item and surface it as "Contains: X" — it looks like
// a contained-item id but isn't one. An egg spawner rolls a LOOT TABLE of
// several egg types, and different regions reuse the same itemId for
// unrelated tables: the Feybreak marker (itemId PalEgg_Water_01) and the
// Sakura marker (itemId PalEgg_Dragon_01) both point at spawner groups whose
// real per-region tables were confirmed by fetching the spawner pages behind
// their `href` codes — https://paldb.cc/en/tenraku_grade_01 (Feybreak) lists
// Rocky/Frozen/Verdant/Dragon/Common/Damp/Scorching Egg, and
// https://paldb.cc/en/grass_grade_01 (Grass) lists Common/Verdant/Frozen/
// Scorching/Damp/Rocky Egg. So `itemId` is only the icon paldb chose for
// that marker, not its contents — asserting one specific egg on all 1,786
// egg markers would be confidently wrong, worse than showing nothing. A
// genuinely honest "Contains one of: ..." would need scraping the ~7
// spawner-group pages for their real tables — a real feature, but a
// separate decision from this scraper pass.

const BASE = 'https://paldb.cc';
const MAP_DATA_URL = `${BASE}/js/map_data_en.js`;
const CDN = 'https://cdn.paldb.cc';
const TILE_URL_TEMPLATE = `${CDN}/image/map8/z{z}x{x}y{y}.webp`;
// Bare requests 403 on the CDN; both the JS asset and the CDN need a page
// referer, per PLAN.md §8 recon.
const REFERER = 'https://paldb.cc/en/Palpagos_Islands';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIN_INTERVAL_MS = 300;

const MIN_ZOOM = 0;
const MAX_NATIVE_ZOOM = 4; // exclusive upper bound we download (z0..z3)
const PER_PIXEL = 459; // world units per in-game display unit (paldb-map.js `const perPixel = 459`)
const MIN_MARKERS_TRIPWIRE = 10_000;
const LOUD_TILE_BYTES_WARNING = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let LIMIT = Infinity;
let VERBOSE = false;
let ONLY = new Set(['map', 'tiles']);
for (const arg of args) {
  const limitMatch = arg.match(/^--limit=(\d+)$/);
  if (limitMatch) LIMIT = Number(limitMatch[1]);
  if (arg === '--verbose') VERBOSE = true;
  const onlyMatch = arg.match(/^--only=(.+)$/);
  if (onlyMatch) ONLY = new Set(onlyMatch[1].split(',').map((s) => s.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function log(...a) {
  console.log(...a);
}
function vlog(...a) {
  if (VERBOSE) console.log(...a);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Strip embedded HTML (some `item` values carry inline <img> tooltips for
 * element icons, e.g. Tower boss names) and collapse resulting whitespace. */
function stripHtml(str) {
  return String(str).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Throttled, cached HTTP (mirrors scripts/fetch-data.mjs's house style)
// ---------------------------------------------------------------------------
let lastRequestAt = 0;
let newFetchCount = 0;
let limitReached = false;

async function throttle() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function rawFetch(url, { binary = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch (cached, throttled, retried once on 403/429/network error) into a
 * fixed cache file path. Returns the body (string or Buffer) or null if the
 * limit was reached or the fetch ultimately failed (recorded on `report`). */
async function fetchCached(url, cacheFile, report, failureBucket, { binary = false } = {}) {
  if (existsSync(cacheFile)) {
    vlog(`  [cache] ${cacheFile}`);
    return binary ? readFileSync(cacheFile) : readFileSync(cacheFile, 'utf8');
  }
  if (newFetchCount >= LIMIT) {
    limitReached = true;
    return null;
  }
  await throttle();
  newFetchCount++;
  vlog(`  [fetch] ${url}`);
  let result = await rawFetch(url, { binary });
  if (!result.ok && (result.status === 403 || result.status === 429 || result.status === 0)) {
    await sleep(3000);
    result = await rawFetch(url, { binary });
  }
  if (!result.ok) {
    report[failureBucket].push({ url, status: result.status, error: result.error });
    return null;
  }
  ensureDir(path.dirname(cacheFile));
  writeFileSync(cacheFile, result.body);
  return result.body;
}

// ---------------------------------------------------------------------------
// Balanced brace/bracket extraction of `var <name> = <json literal>;`
//
// map_data_en.js is emitted as one very long line, so a line-based parser
// won't work — this walks the source char-by-char from the first `{`/`[`
// after `var <name> =`, tracking string literals (with escape handling) so
// braces inside quoted item HTML don't throw off the depth count, until the
// matching close bracket returns depth to 0. The slice is JSON.parse'd —
// this file is NEVER eval'd.
// ---------------------------------------------------------------------------
function extractVar(src, name) {
  const needle = `var ${name} =`;
  let searchFrom = 0;
  let idx = -1;
  // Guard against matching inside a longer identifier (e.g. "var extras ="
  // must not be satisfied by text ending in "...Extras =" or similar) by
  // requiring the character before "var" to be a statement boundary.
  for (;;) {
    idx = src.indexOf(needle, searchFrom);
    if (idx === -1) return undefined;
    const before = src[idx - 1];
    if (idx === 0 || before === ';' || before === '\n' || before === ' ') break;
    searchFrom = idx + needle.length;
  }
  let i = idx + needle.length;
  while (/\s/.test(src[i])) i++;
  const open = src[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) throw new Error(`extractVar(${name}): unexpected literal start "${open}"`);
  let depth = 0;
  let inStr = false;
  let strCh = null;
  let esc = false;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = true;
      strCh = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const literal = src.slice(start, i);
  return JSON.parse(literal);
}

// ---------------------------------------------------------------------------
// Coordinate transform — ported verbatim from paldb's minified Leaflet map
// client (paldb-map.js). The relevant chain, as actually written there:
//
//   rposToScale(pos) = {
//     X: (pos.X - minX) / (maxX - minX),
//     Y: (pos.Y - minY) / (maxY - minY),
//   }
//   projIpos(scale) = [
//     round(scale.Y * transform_y_pixel - ingame_y_start),
//     round(scale.X * transform_x_pixel - ingame_x_start),
//   ]
//   transformRposToIpos(pos) = projIpos(rposToScale(pos))
//   rowIposFill(marker): if marker.pos && !marker.ipos, the array above
//     becomes { ipos: { X: result[0], Y: result[1] } }  -- note the X/Y swap
//     versus the raw pos axes; this is intentional (verified against real
//     landmarks below), not a transcription bug.
//
// transform_x_pixel/transform_y_pixel/ingame_x_start/ingame_y_start (from
// paldb-map.html's `options` block) are themselves linear in minX/maxX and
// minY/maxY with the constants below, so the whole chain collapses to the
// closed form used here — algebraically simplified but numerically IDENTICAL
// to the stepwise version (verified for every Tower/Fast-Travel/Alpha-Pal
// marker in the real dataset before trusting this).
// ---------------------------------------------------------------------------
// The closed form (see derivation in the module comment above): given the
// verified constants -582888 (X reference) / -301000 (Y reference) baked
// into paldb-map.html's `options` block alongside perPixel=459.
const IPOS_X_REF = 301000;
const IPOS_Y_REF = 582888;

function rposToIpos(pos, perPixel) {
  return {
    X: Math.round((pos.Y + IPOS_X_REF) / perPixel) - 1000,
    Y: Math.round((pos.X + IPOS_Y_REF) / perPixel) - 1000,
  };
}

function iposToRpos(ipos, perPixel) {
  return {
    X: Math.round((ipos.Y + 1000) * perPixel - IPOS_Y_REF),
    Y: Math.round((ipos.X + 1000) * perPixel - IPOS_X_REF),
  };
}

// ---------------------------------------------------------------------------
// Marker normalization
// ---------------------------------------------------------------------------
function normalizeMarker(raw, perPixel) {
  const marker = {
    type: raw.type,
    name: stripHtml(raw.item ?? ''),
  };

  if (raw.pos) {
    marker.x = Math.round(raw.pos.X);
    marker.y = Math.round(raw.pos.Y);
    if (raw.pos.Z !== undefined) marker.z = Math.round(raw.pos.Z);
    const ipos = rposToIpos(raw.pos, perPixel);
    marker.ix = ipos.X;
    marker.iy = ipos.Y;
  } else if (raw.ipos) {
    marker.ix = Math.round(raw.ipos.X);
    marker.iy = Math.round(raw.ipos.Y);
    const pos = iposToRpos(raw.ipos, perPixel);
    marker.x = pos.X;
    marker.y = pos.Y;
  } else {
    return null; // no positional data at all — shouldn't happen (see tripwire), drop defensively
  }

  if (raw.lv !== undefined) marker.lv = raw.lv;
  if (raw.href) marker.href = raw.href;
  if (raw.comment) marker.comment = raw.comment;
  if (raw.cooldown) marker.cooldown = raw.cooldown;
  if (raw.Spawn) marker.spawn = raw.Spawn;
  if (raw.id) marker.id = raw.id;
  // Day/night restriction on some Alpha Pal field-boss spawns. Raw values
  // observed so far are only ever "Night" (never "Day") — lowercased rather
  // than hardcoded to a 2-value enum in case upstream ever adds the other case.
  if (raw.onlyTime) marker.onlyTime = String(raw.onlyTime).toLowerCase();
  // Tower boss flag, e.g. "EPalBossType::ForestBoss" — passed through verbatim.
  if (raw.boss) marker.boss = raw.boss;
  // Internal spawn-table item id (mostly egg spawners, e.g. "PalEgg_Dragon_01").
  // Passed through verbatim, unresolved — see the NOTE above the icon-related
  // constants: it's the icon paldb picked for this marker, not its contents.
  if (raw.itemId) marker.itemId = raw.itemId;

  return marker;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Phase: map data (fetch map_data_en.js, parse, normalize, emit map.json,
// download marker-type legend icons)
// ---------------------------------------------------------------------------
async function runMapPhase(report) {
  ensureDir(CACHE_DIR);
  log('fetch-map: fetching map_data_en.js...');
  const src = await fetchCached(MAP_DATA_URL, MAP_DATA_CACHE_FILE, report, 'failedFetches');
  if (src == null) {
    if (limitReached) {
      log('fetch-map: --limit reached before map_data_en.js could be fetched; run again to continue');
      report.partial = true;
      return;
    }
    throw new Error('could not fetch map_data_en.js — see report.failedFetches');
  }

  const varNames = ['iconLookup', 'extrasIngame', 'extras', 'config', 'fixedDungeon', 'regionData'];
  const vars = {};
  const missing = [];
  for (const name of varNames) {
    const value = extractVar(src, name);
    if (value === undefined) missing.push(name);
    else vars[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `HARD ERROR: map_data_en.js is missing expected top-level var(s): ${missing.join(', ')} — upstream format likely changed.`,
    );
  }
  if (!Array.isArray(vars.fixedDungeon) || vars.fixedDungeon.length < MIN_MARKERS_TRIPWIRE) {
    throw new Error(
      `HARD ERROR: fixedDungeon has ${Array.isArray(vars.fixedDungeon) ? vars.fixedDungeon.length : 'n/a'} entries, ` +
        `expected at least ${MIN_MARKERS_TRIPWIRE} — upstream format likely changed.`,
    );
  }
  log(
    `fetch-map: parsed 6 vars OK (fixedDungeon=${vars.fixedDungeon.length}, extras=${vars.extras.length}, ` +
      `extrasIngame=${vars.extrasIngame.length}, regionData=${vars.regionData.length}, ` +
      `iconLookup=${Object.keys(vars.iconLookup).length} types)`,
  );

  const world = {
    minX: vars.config.landScapeRealPositionMin.X,
    minY: vars.config.landScapeRealPositionMin.Y,
    maxX: vars.config.landScapeRealPositionMax.X,
    maxY: vars.config.landScapeRealPositionMax.Y,
    perPixel: PER_PIXEL,
  };

  // --- normalize markers -----------------------------------------------------
  const markers = [];
  let droppedNoPosition = 0;
  for (const rawArr of [vars.fixedDungeon, vars.extras, vars.extrasIngame, vars.regionData]) {
    for (const raw of rawArr) {
      const marker = normalizeMarker(raw, world.perPixel);
      if (marker) markers.push(marker);
      else droppedNoPosition++;
    }
  }
  if (droppedNoPosition > 0) {
    log(`fetch-map: WARNING dropped ${droppedNoPosition} raw entries with neither pos nor ipos`);
  }

  const typeCounts = new Map();
  for (const m of markers) typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1);

  // --- marker-type legend icons ------------------------------------------------
  ensureDir(PUBLIC_MARKER_ICONS_DIR);
  const types = [];
  let iconsWritten = 0;
  let iconsPresent = 0;
  let iconsMissing = 0;
  for (const [id, def] of Object.entries(vars.iconLookup)) {
    const slug = slugify(id);
    const publicRelPath = `games/palworld/icons/markers/${slug}.webp`;
    const publicPath = path.join(ROOT, 'public', publicRelPath);
    let iconResult = 'present';
    if (!existsSync(publicPath)) {
      const cacheFile = path.join(ICONS_CACHE_DIR, `${slug}.webp`);
      const bytes = await fetchCached(def.fixed_icon, cacheFile, report, 'failedIcons', { binary: true });
      if (bytes == null) {
        iconResult = limitReached ? 'skipped' : 'failed';
      } else {
        writeFileSync(publicPath, bytes);
        iconResult = 'written';
      }
    }
    if (iconResult === 'present') iconsPresent++;
    else if (iconResult === 'written') iconsWritten++;
    else iconsMissing++;
    types.push({ id, label: def.label ?? id, category: def.category ?? 'unknown', icon: publicRelPath });
  }

  // --- write map.json (compact — ships to the browser) ------------------------
  ensureDir(path.dirname(MAP_JSON_OUT));
  const doc = {
    schemaVersion: 1,
    source: 'paldb.cc',
    generatedFrom: MAP_DATA_URL,
    world,
    types,
    markers,
  };
  writeFileSync(MAP_JSON_OUT, JSON.stringify(doc), 'utf8');

  report.counts.markers = markers.length;
  report.counts.distinctTypes = typeCounts.size;
  report.counts.typeBreakdown = Object.fromEntries(typeCounts);
  report.counts.markerIconsWritten = iconsWritten;
  report.counts.markerIconsPresent = iconsPresent;
  report.counts.markerIconsMissing = iconsMissing;
  report.counts.mapJsonBytes = statSync(MAP_JSON_OUT).size;

  log(`fetch-map: map.json written (${markers.length} markers, ${typeCounts.size} distinct types, ${report.counts.mapJsonBytes} bytes)`);
  log(`fetch-map: marker-type icons: ${iconsWritten} written, ${iconsPresent} already present, ${iconsMissing} missing`);
}

// ---------------------------------------------------------------------------
// Phase: tile pyramid (z0..z3, fully determined by z/x/y — no dependency on
// map_data_en.js)
// ---------------------------------------------------------------------------
async function runTilesPhase(report) {
  ensureDir(PUBLIC_TILES_DIR);
  ensureDir(TILES_CACHE_DIR);

  let written = 0;
  let present = 0;
  let missing = 0;
  let totalBytes = 0;

  for (let z = MIN_ZOOM; z < MAX_NATIVE_ZOOM; z++) {
    const tilesPerSide = 2 ** z;
    for (let x = 0; x < tilesPerSide; x++) {
      for (let y = 0; y < tilesPerSide; y++) {
        const filename = `z${z}x${x}y${y}.webp`;
        const publicPath = path.join(PUBLIC_TILES_DIR, filename);
        if (existsSync(publicPath)) {
          present++;
          totalBytes += statSync(publicPath).size;
          continue;
        }
        const url = TILE_URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const cacheFile = path.join(TILES_CACHE_DIR, filename);
        const bytes = await fetchCached(url, cacheFile, report, 'failedTiles', { binary: true });
        if (bytes == null) {
          missing++;
          if (limitReached) {
            report.partial = true;
          }
          continue;
        }
        writeFileSync(publicPath, bytes);
        written++;
        totalBytes += bytes.length;
      }
    }
  }

  report.counts.tilesWritten = written;
  report.counts.tilesPresent = present;
  report.counts.tilesMissing = missing;
  report.counts.tilesTotalBytes = totalBytes;

  log(`fetch-map: tiles: ${written} written, ${present} already present, ${missing} missing, total ${totalBytes} bytes on disk`);
  if (totalBytes > LOUD_TILE_BYTES_WARNING) {
    log(
      `fetch-map: *** TILE PYRAMID IS ${(totalBytes / (1024 * 1024)).toFixed(1)} MB, over the ~12 MB expectation — ` +
        `check public/games/palworld/tiles/ before committing. ***`,
    );
    report.tileSizeWarning = true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR);
  const report = {
    startedAt: new Date().toISOString(),
    limit: LIMIT === Infinity ? null : LIMIT,
    only: [...ONLY],
    failedFetches: [],
    failedIcons: [],
    failedTiles: [],
    counts: {},
    partial: false,
    tileSizeWarning: false,
  };

  if (ONLY.has('map')) await runMapPhase(report);
  if (ONLY.has('tiles')) await runTilesPhase(report);

  report.finishedAt = new Date().toISOString();
  report.partial = report.partial || limitReached;
  ensureDir(CACHE_DIR);
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  log('');
  log(`fetch-map: ${report.partial ? 'PARTIAL' : 'COMPLETE'} run summary`);
  if (report.counts.markers !== undefined) {
    log(`  markers: ${report.counts.markers} (${report.counts.distinctTypes} distinct types)`);
    log(`  marker icons: ${report.counts.markerIconsWritten} written, ${report.counts.markerIconsPresent} present, ${report.counts.markerIconsMissing} missing`);
    log(`  map.json: ${report.counts.mapJsonBytes} bytes`);
  }
  if (report.counts.tilesWritten !== undefined) {
    log(`  tiles: ${report.counts.tilesWritten} written, ${report.counts.tilesPresent} present, ${report.counts.tilesMissing} missing, ${report.counts.tilesTotalBytes} bytes total`);
  }
  log(`  failed fetches: ${report.failedFetches.length}, failed icons: ${report.failedIcons.length}, failed tiles: ${report.failedTiles.length}`);
  if (limitReached) log('  --limit reached; run again to continue.');
  log(`  report written to ${REPORT_OUT}`);

  if (
    (report.counts.markerIconsMissing ?? 0) > 0 ||
    (report.counts.tilesMissing ?? 0) > 0 ||
    report.failedFetches.length > 0
  ) {
    if (!report.partial) {
      log('  Hard error: complete run still has missing assets. See report.');
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('fetch-map: FATAL', err);
  process.exit(1);
});
