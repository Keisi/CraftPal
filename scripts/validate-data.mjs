#!/usr/bin/env node
// Validates every game directory under src/data/*/ for internal consistency
// (PLAN.md §9): every ingredient/station reference resolves, every icon path
// resolves to an existing file under public/<manifest.assetBase>, and every
// item's tier (if any) is one the game's own manifest declares. Manifest-
// driven, not a hardcoded Palworld ladder — a future game directory is
// validated the same way with zero changes here. Node, no deps.
//
// Also validates the three generated per-game datasets from PLAN.md §8, each
// of which a game may legitimately omit (skipped, not failed, when absent —
// the OK line says which datasets were skipped):
//   - src/data/<game>/pals.json — pal roster, drop->item references, and
//     habitat summary fields cross-checked against the habitat files below.
//   - public/games/<game>/data/habitats/*.json — per-pal flat [x,y,lv,...]
//     day/night point clouds.
//   - public/games/<game>/data/map.json — POI markers + marker-type legend.
//
// Usage: node scripts/validate-data.mjs
// Exits 0 on success, 1 with a clear message on the first class of failure
// (all errors of each kind are counted; the printed list is capped so a
// pervasive failure can't spew thousands of lines).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DATA_DIR = path.join(ROOT, 'src', 'data')
const PUBLIC_DIR = path.join(ROOT, 'public')

const MAX_PRINTED_ERRORS = 50

function fail(errors) {
  console.error(`\nvalidate-data: FAILED (${errors.length} error${errors.length === 1 ? '' : 's'})\n`)
  for (const e of errors.slice(0, MAX_PRINTED_ERRORS)) console.error(`  - ${e}`)
  if (errors.length > MAX_PRINTED_ERRORS) {
    console.error(`  ... and ${errors.length - MAX_PRINTED_ERRORS} more error(s) not shown`)
  }
  console.error('')
  process.exit(1)
}

function loadJson(p, label, errors) {
  if (!existsSync(p)) {
    errors.push(`${label} not found at ${p}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${err.message}`)
    return null
  }
}

function discoverGameDirs() {
  if (!existsSync(DATA_DIR)) return []
  return readdirSync(DATA_DIR).filter((name) => statSync(path.join(DATA_DIR, name)).isDirectory())
}

/** Resolve an icon path against a game's public asset folder
 * (public/<assetBase>/<icon>), the same resolution ItemIcon.jsx does at
 * runtime (minus BASE_URL, which is a deploy-time prefix, not a filesystem
 * path). */
function checkIcon(errors, kind, gameId, publicAssetDir, id, icon) {
  if (!icon) {
    errors.push(`[${gameId}] ${kind} "${id}": missing icon path`)
    return
  }
  const relPath = icon.startsWith('/') ? icon.slice(1) : icon
  const abs = path.join(publicAssetDir, relPath)
  if (!existsSync(abs)) {
    errors.push(`[${gameId}] ${kind} "${id}": icon "${icon}" does not resolve to an existing file (expected ${abs})`)
  }
}

/** Validate one habitat point-cloud array ('day' or 'night' from a
 * habitats/<code>.json file): must be a flat array of [x, y, lv, ...]
 * integer triples, lv >= 0 (0 is the documented "no level data" sentinel,
 * legal here — unlike the pal-level levelMin/levelMax summary, which must
 * never be 0). Returns the real point count (arr.length / 3, rounded down if
 * malformed) for cross-checking against pals.json's habitat.day/night counts. */
function validateHabitatArray(errors, gameId, fileLabel, arrayLabel, arr) {
  if (!Array.isArray(arr)) {
    errors.push(`[${gameId}] habitat file "${fileLabel}": "${arrayLabel}" is not an array`)
    return 0
  }
  if (arr.length % 3 !== 0) {
    errors.push(
      `[${gameId}] habitat file "${fileLabel}": "${arrayLabel}" has length ${arr.length}, not divisible by 3`,
    )
  }
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const x = arr[i]
    const y = arr[i + 1]
    const lv = arr[i + 2]
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      errors.push(
        `[${gameId}] habitat file "${fileLabel}": "${arrayLabel}" point at index ${i} has non-integer coords (${x}, ${y})`,
      )
    }
    if (!Number.isInteger(lv) || lv < 0) {
      errors.push(
        `[${gameId}] habitat file "${fileLabel}": "${arrayLabel}" point at index ${i} has invalid lv "${lv}" (must be an integer >= 0)`,
      )
    }
  }
  return Math.floor(arr.length / 3)
}

/** Validate every public/games/<game>/data/habitats/*.json file (§8 B). Absent
 * directory is legal (skip, not fail) — a game may have no habitat data at
 * all. Returns the file count plus a code -> {day, night} map of REAL point
 * counts, used by validatePals() to cross-check pals.json's summary fields
 * without re-parsing every file. */
function validateHabitatFiles(gameId, habitatsDir, errors) {
  if (!existsSync(habitatsDir)) return { fileCount: 0, pointCounts: new Map() }
  const files = readdirSync(habitatsDir).filter((f) => f.endsWith('.json'))
  const pointCounts = new Map()
  for (const file of files) {
    const code = file.slice(0, -'.json'.length)
    const abs = path.join(habitatsDir, file)
    let doc
    try {
      doc = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (err) {
      errors.push(`[${gameId}] habitat file "${file}" is not valid JSON: ${err.message}`)
      continue
    }
    const day = validateHabitatArray(errors, gameId, file, 'day', doc.day)
    const night = validateHabitatArray(errors, gameId, file, 'night', doc.night)
    pointCounts.set(code, { day, night })
  }
  return { fileCount: files.length, pointCounts }
}

/** Validate src/data/<game>/pals.json (§8 A). Absent file is legal (skip, not
 * fail). Cross-checks drop->item references against `items` (a dangling
 * reference is a HARD ERROR, exactly like a dangling ingredient reference),
 * hasHabitat against real habitat-file presence, habitat.day/night against
 * real point counts from `habitatPointCounts`, and the levelMin/levelMax
 * invariant (both null, or both integers >= 1 — 0 is the habitat files'
 * "absent" sentinel and must never appear as a real level here). */
function validatePals(gameId, palsPath, publicAssetDir, habitatsDir, habitatPointCounts, items, errors) {
  if (!existsSync(palsPath)) return { present: false, palCount: 0 }
  const palsDoc = loadJson(palsPath, `[${gameId}] pals.json`, errors)
  if (!palsDoc) return { present: true, palCount: 0 }

  const pals = palsDoc.pals ?? {}
  for (const [id, pal] of Object.entries(pals)) {
    if (!pal.name) errors.push(`[${gameId}] pal "${id}": missing non-empty name`)
    if (!pal.code) errors.push(`[${gameId}] pal "${id}": missing non-empty code`)
    // A pal discovered only via the DataTable union (fetch-pals.mjs,
    // PLAN.md §8) has a *derived* icon URL, not one scraped from a working
    // <img> tag on /en/Pals — it can genuinely 404 upstream. fetch-pals.mjs
    // tries the derived URL, then falls back to its base species' icon
    // (paldb's <Base>_<Suffix> variant convention) before giving up, so in
    // practice this only bites when BOTH 404 — kept as a safety net for that
    // case, recording icon: null rather than inventing a path. Every other
    // pal (discoveredVia absent) must still resolve to a real file.
    if (pal.icon != null || pal.discoveredVia !== 'datatable') {
      checkIcon(errors, 'pal', gameId, publicAssetDir, id, pal.icon)
    }

    for (const [i, drop] of (pal.drops ?? []).entries()) {
      if (!drop.name) errors.push(`[${gameId}] pal "${id}": drop[${i}] missing non-empty name`)
      if (drop.item != null && !(drop.item in items)) {
        errors.push(`[${gameId}] pal "${id}": drop[${i}] references unknown item "${drop.item}"`)
      }
    }

    const habitatFile = path.join(habitatsDir, `${id}.json`)
    const fileExists = existsSync(habitatFile)
    if (Boolean(pal.hasHabitat) !== fileExists) {
      errors.push(
        `[${gameId}] pal "${id}": hasHabitat=${pal.hasHabitat} but habitat file ${fileExists ? 'exists' : 'does not exist'} (${habitatFile})`,
      )
    }
    if (fileExists) {
      const real = habitatPointCounts.get(id)
      if (real) {
        if (pal.habitat?.day !== real.day) {
          errors.push(
            `[${gameId}] pal "${id}": habitat.day=${pal.habitat?.day} but habitat file has ${real.day} day points`,
          )
        }
        if (pal.habitat?.night !== real.night) {
          errors.push(
            `[${gameId}] pal "${id}": habitat.night=${pal.habitat?.night} but habitat file has ${real.night} night points`,
          )
        }
      }
    }

    const levelMin = pal.habitat?.levelMin ?? null
    const levelMax = pal.habitat?.levelMax ?? null
    const bothNull = levelMin === null && levelMax === null
    const bothValid = Number.isInteger(levelMin) && Number.isInteger(levelMax) && levelMin >= 1 && levelMax >= 1
    if (!bothNull && !bothValid) {
      errors.push(
        `[${gameId}] pal "${id}": levelMin/levelMax must be both null or both integers >= 1 (got ${levelMin}, ${levelMax})`,
      )
    }
  }

  return { present: true, palCount: Object.keys(pals).length }
}

/** Validate public/games/<game>/data/map.json (§8 C). Absent file is legal
 * (skip, not fail). Marker-type icon paths are stored PUBLIC-root-relative
 * (e.g. "games/palworld/icons/markers/x.webp"), unlike item/station/pal icons
 * which are assetBase-relative — hence resolving against PUBLIC_DIR, not
 * publicAssetDir. */
function validateMap(gameId, mapPath, errors) {
  if (!existsSync(mapPath)) return { present: false, markerCount: 0 }
  const doc = loadJson(mapPath, `[${gameId}] map.json`, errors)
  if (!doc) return { present: true, markerCount: 0 }

  const markers = Array.isArray(doc.markers) ? doc.markers : []
  const types = Array.isArray(doc.types) ? doc.types : []
  if (markers.length === 0) {
    errors.push(`[${gameId}] map.json: markers is empty`)
  }

  const typeIds = new Set(types.map((t) => t.id))
  const reportedBadTypes = new Set() // dedupe: one error per distinct undeclared type, not per marker
  for (const [i, m] of markers.entries()) {
    if (!m.type) {
      errors.push(`[${gameId}] map.json: marker[${i}] missing type`)
    } else if (!typeIds.has(m.type) && !reportedBadTypes.has(m.type)) {
      reportedBadTypes.add(m.type)
      errors.push(`[${gameId}] map.json: marker type "${m.type}" is not declared in the types legend`)
    }
    for (const coord of ['x', 'y', 'ix', 'iy']) {
      if (typeof m[coord] !== 'number' || !Number.isFinite(m[coord])) {
        errors.push(`[${gameId}] map.json: marker[${i}] (type "${m.type}") has non-finite ${coord} "${m[coord]}"`)
      }
    }
    if (typeof m.name === 'string' && m.name.includes('<')) {
      errors.push(`[${gameId}] map.json: marker[${i}] name contains unstripped HTML: "${m.name}"`)
    }
    if (m.onlyTime !== undefined && m.onlyTime !== 'day' && m.onlyTime !== 'night') {
      errors.push(`[${gameId}] map.json: marker[${i}] has invalid onlyTime "${m.onlyTime}" (expected "day" or "night")`)
    }
  }

  for (const t of types) {
    checkIcon(errors, 'marker type', gameId, PUBLIC_DIR, t.id, t.icon)
  }

  return { present: true, markerCount: markers.length }
}

function validateGame(gameId, errors) {
  const gameDir = path.join(DATA_DIR, gameId)
  const manifestPath = path.join(gameDir, 'game.json')
  const itemsPath = path.join(gameDir, 'items.json')
  const stationsPath = path.join(gameDir, 'stations.json')

  const manifest = loadJson(manifestPath, `[${gameId}] game.json`, errors)
  const itemsDoc = loadJson(itemsPath, `[${gameId}] items.json`, errors)
  if (!manifest || !itemsDoc) {
    return { itemCount: 0, stationCount: 0, palCount: 0, habitatFileCount: 0, markerCount: 0, skipped: [] }
  }

  // stations.json is optional — a game with no crafting-station concept can
  // omit it entirely and every station-shaped check below just sees {}.
  const stationsDoc = existsSync(stationsPath) ? loadJson(stationsPath, `[${gameId}] stations.json`, errors) : {}

  const items = itemsDoc.items ?? {}
  const stations = stationsDoc ?? {}
  const tierIds = new Set((manifest.tiers ?? []).map((t) => t.id))
  const assetBase = manifest.assetBase ?? ''
  const publicAssetDir = path.join(PUBLIC_DIR, ...assetBase.split('/').filter(Boolean))

  // 1. Every recipe.ingredients[].item must exist in items.
  // 2. Every recipe.stations[] must exist in stations.
  // 3. If the manifest declares tiers, every item.tier (if set) must be one of them.
  for (const [id, item] of Object.entries(items)) {
    if (tierIds.size > 0 && item.tier != null && !tierIds.has(item.tier)) {
      errors.push(`[${gameId}] item "${id}": tier "${item.tier}" is not declared in game.json's tiers`)
    }

    if (!item.recipe) continue

    if (!Array.isArray(item.recipe.stations)) {
      errors.push(`[${gameId}] item "${id}": recipe.stations must be an array`)
    } else {
      for (const stationId of item.recipe.stations) {
        if (!(stationId in stations)) {
          errors.push(`[${gameId}] item "${id}": recipe references unknown station "${stationId}"`)
        }
      }
    }

    if (!Array.isArray(item.recipe.ingredients)) {
      errors.push(`[${gameId}] item "${id}": recipe.ingredients must be an array`)
    } else {
      for (const ing of item.recipe.ingredients) {
        if (!(ing.item in items)) {
          errors.push(`[${gameId}] item "${id}": recipe references unknown ingredient item "${ing.item}"`)
        }
      }
    }
  }

  // 4. Every item/station icon path must resolve under public/<assetBase>/.
  for (const [id, item] of Object.entries(items)) {
    checkIcon(errors, 'item', gameId, publicAssetDir, id, item.icon)
  }
  for (const [id, station] of Object.entries(stations)) {
    checkIcon(errors, 'station', gameId, publicAssetDir, id, station.icon)
  }

  // 5. Generated datasets (§8) — each optional per game; absent = skip, not fail.
  const palsPath = path.join(gameDir, 'pals.json')
  const habitatsDir = path.join(publicAssetDir, 'data', 'habitats')
  const mapPath = path.join(publicAssetDir, 'data', 'map.json')

  const skipped = []
  const { fileCount: habitatFileCount, pointCounts: habitatPointCounts } = validateHabitatFiles(
    gameId,
    habitatsDir,
    errors,
  )
  if (!existsSync(habitatsDir)) skipped.push('habitats/')

  const { present: palsPresent, palCount } = validatePals(
    gameId,
    palsPath,
    publicAssetDir,
    habitatsDir,
    habitatPointCounts,
    items,
    errors,
  )
  if (!palsPresent) skipped.push('pals.json')

  const { present: mapPresent, markerCount } = validateMap(gameId, mapPath, errors)
  if (!mapPresent) skipped.push('map.json')

  return { itemCount: Object.keys(items).length, stationCount: Object.keys(stations).length, palCount, habitatFileCount, markerCount, skipped }
}

const gameDirs = discoverGameDirs()
if (gameDirs.length === 0) {
  fail(['no game data directories found under src/data/*/'])
}

const errors = []
let totalItems = 0
let totalStations = 0
let totalPals = 0
let totalHabitatFiles = 0
let totalMarkers = 0
const skippedByGame = [] // "<gameId>: <dataset>, <dataset>"

for (const gameId of gameDirs) {
  const { itemCount, stationCount, palCount, habitatFileCount, markerCount, skipped } = validateGame(gameId, errors)
  totalItems += itemCount
  totalStations += stationCount
  totalPals += palCount
  totalHabitatFiles += habitatFileCount
  totalMarkers += markerCount
  if (skipped.length > 0) skippedByGame.push(`${gameId}: ${skipped.join(', ')}`)
}

if (errors.length > 0) {
  fail(errors)
}

const skippedNote =
  skippedByGame.length > 0 ? ` Skipped (not present): ${skippedByGame.join('; ')}.` : ' No datasets skipped.'

console.log(
  `validate-data: OK — ${gameDirs.length} game${gameDirs.length === 1 ? '' : 's'} (${gameDirs.join(', ')}), ` +
    `${totalItems} items, ${totalStations} stations, ${totalPals} pals, ${totalHabitatFiles} habitat files, ` +
    `${totalMarkers} map markers, all references + icons resolve.${skippedNote}`,
)
