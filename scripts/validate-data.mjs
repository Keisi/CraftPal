#!/usr/bin/env node
// Validates every game directory under src/data/*/ for internal consistency
// (PLAN.md §9): every ingredient/station reference resolves, every icon path
// resolves to an existing file under public/<manifest.assetBase>, and every
// item's tier (if any) is one the game's own manifest declares. Manifest-
// driven, not a hardcoded Palworld ladder — a future game directory is
// validated the same way with zero changes here. Node, no deps.
//
// Also validates the four generated per-game datasets from PLAN.md §8, each
// of which a game may legitimately omit (skipped, not failed, when absent —
// the OK line says which datasets were skipped):
//   - src/data/<game>/pals.json — pal roster, drop->item references, and
//     habitat summary fields cross-checked against the habitat files below.
//   - public/games/<game>/data/habitats/*.json — per-pal flat [x,y,lv,...]
//     day/night point clouds.
//   - public/games/<game>/data/map.json — POI markers + marker-type legend +
//     the "Contains one of: ..." egg-marker `contains` item references.
//   - public/games/<game>/tiles/ — the base-map tile PYRAMID must be
//     COMPLETE for every zoom level actually present on disk (z tiles =
//     z{z}x{x}y{y}.webp for x,y in [0, 2**z)); a partial tile download is a
//     hard error, not a quietly-shipped map full of holes.
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

// Icon-coverage floor default for a game whose game.json doesn't declare its
// own `minIconCoverage` (see the check in validateGame). Real per-game values
// as of 2026-07-28: Palworld ~100%, Minecraft ~73% (1,182/1,618 items+
// stations — the rest structurally have no representative texture).
const DEFAULT_MIN_ICON_COVERAGE = 0.95

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
 * path).
 *
 * `optional` (Minecraft-driven addition, PLAN.md §9): when true, a genuinely
 * ABSENT icon is not an error, only counted (via the `missingIconCounter`
 * callback) — it degrades exactly the way ItemIcon.jsx already renders it at
 * runtime (a "no icon" placeholder box), so the validator was stricter than
 * the app itself. Minecraft's real scrape has ~60 items (entity-rendered
 * blocks — chests, beds, campfire, banners, ... — whose real textures live
 * in bespoke per-part atlases under textures/entity/, not a single
 * representative file fetch-minecraft.mjs chases) with no resolvable icon at
 * all; Palworld's own item/station icons are still effectively 100%
 * complete in practice, so this only relaxes a case that was previously
 * unreachable for it. An icon path that IS present but points at a file that
 * doesn't exist remains a hard error unconditionally — that's a real broken
 * reference, never legitimate for either game. */
function checkIcon(errors, kind, gameId, publicAssetDir, id, icon, { optional = false, missingIconCounter } = {}) {
  if (!icon) {
    if (optional) {
      missingIconCounter?.()
      return
    }
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
 * publicAssetDir.
 *
 * No marker carries a resolved single `item` today — fetch-map.mjs
 * deliberately does NOT try to resolve egg markers' `itemId` to one CraftPal
 * item, because an egg spawner rolls a loot table of several egg types
 * rather than containing exactly one (see the NOTE in fetch-map.mjs for the
 * evidence). That `item` check below is a no-op against the current dataset,
 * kept for the future/no other game: IF a marker's `item` ever gets
 * populated (a real per-region table, a different game's map data, ...), a
 * dangling reference is a hard error, exactly like a dangling ingredient or
 * pal-drop reference — not silently ignored.
 *
 * `contains` (plural — the honest "Contains one of: ..." set, fetch-map.mjs
 * resolveEggSpawnerGroups()) is real on the current dataset: every id inside
 * every marker's `contains` array must resolve in `items`, same tier/dedupe
 * strategy as the `item` check (one error per distinct unresolved id, not
 * per marker — an egg spawner group can have hundreds of markers). */
function validateMap(gameId, mapPath, items, errors) {
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
  const reportedBadItems = new Set() // dedupe: one error per distinct unresolved item id, not per marker (a bad id can repeat hundreds of times, e.g. every egg spawner of that type)
  const reportedBadContains = new Set() // same dedupe, keyed on the unresolved id itself (a bad id can repeat across many markers sharing one spawner-group href)
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
    if (m.item != null && !(m.item in items) && !reportedBadItems.has(m.item)) {
      reportedBadItems.add(m.item)
      errors.push(`[${gameId}] map.json: marker references unknown item "${m.item}" (e.g. marker[${i}])`)
    }
    if (m.contains !== undefined) {
      if (!Array.isArray(m.contains) || m.contains.length === 0) {
        errors.push(`[${gameId}] map.json: marker[${i}] (type "${m.type}") has a non-array or empty "contains" (must be absent, not empty-array-pretending-to-be-known, when nothing is known)`)
      } else {
        for (const id of m.contains) {
          if (!(id in items) && !reportedBadContains.has(id)) {
            reportedBadContains.add(id)
            errors.push(`[${gameId}] map.json: marker "contains" references unknown item "${id}" (e.g. marker[${i}])`)
          }
        }
      }
    }
  }

  for (const t of types) {
    checkIcon(errors, 'marker type', gameId, PUBLIC_DIR, t.id, t.icon)
  }

  return { present: true, markerCount: markers.length }
}

// Tile filenames are z{z}x{x}y{y}.webp (fetch-map.mjs's runTilesPhase: x,y in
// [0, 2**z)). Anchored so a filename like "z10x3y4.webp" still parses z=10,
// not z=1.
const TILE_FILE_RE = /^z(\d+)x(\d+)y(\d+)\.webp$/
const MAX_LISTED_MISSING_TILES = 30

/** Validate public/games/<game>/tiles/ — the base-map tile pyramid.
 * Absent directory is legal (skip, not fail): a game may ship no map at all.
 * For every zoom level actually present on disk, the pyramid must be
 * COMPLETE: every z{z}x{x}y{y}.webp for x,y in [0, 2**z). The set of zoom
 * levels to check is DERIVED from the filenames present (never hardcoded to
 * "z0..z3"), so a future deeper pyramid (z4, z5, ...) is validated the same
 * way with zero changes here — this is the same "don't hardcode what should
 * be discovered" discipline as fetch-map.mjs's egg-spawner-href discovery.
 * A HARD ERROR lists the missing tiles (capped) so a partial tile download
 * doesn't silently ship as a map full of holes. Returns the real per-zoom
 * {present, expected} counts for the OK line. */
function validateTiles(gameId, tilesDir, errors) {
  if (!existsSync(tilesDir)) return { present: false, zoomCounts: {} }

  const files = readdirSync(tilesDir).filter((f) => f.endsWith('.webp'))
  const presentCoords = new Set() // "z,x,y"
  const zoomsSeen = new Set()
  for (const file of files) {
    const m = file.match(TILE_FILE_RE)
    if (!m) {
      errors.push(`[${gameId}] tiles/: "${file}" does not match the expected z{z}x{x}y{y}.webp naming`)
      continue
    }
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    zoomsSeen.add(z)
    presentCoords.add(`${z},${x},${y}`)
  }

  const zoomCounts = {}
  const missing = []
  for (const z of [...zoomsSeen].sort((a, b) => a - b)) {
    const tilesPerSide = 2 ** z
    const expected = tilesPerSide * tilesPerSide
    let presentCount = 0
    for (let x = 0; x < tilesPerSide; x++) {
      for (let y = 0; y < tilesPerSide; y++) {
        if (presentCoords.has(`${z},${x},${y}`)) presentCount++
        else missing.push(`z${z}x${x}y${y}.webp`)
      }
    }
    zoomCounts[z] = { present: presentCount, expected }
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_LISTED_MISSING_TILES)
    const zoomList = [...zoomsSeen].sort((a, b) => a - b).join(', ')
    errors.push(
      `[${gameId}] tiles/: pyramid incomplete — ${missing.length} missing tile(s) across zoom level(s) ${zoomList}: ` +
        `${shown.join(', ')}${missing.length > shown.length ? `, ... and ${missing.length - shown.length} more` : ''}`,
    )
  }

  return { present: true, zoomCounts }
}

function validateGame(gameId, errors) {
  const gameDir = path.join(DATA_DIR, gameId)
  const manifestPath = path.join(gameDir, 'game.json')
  const itemsPath = path.join(gameDir, 'items.json')
  const stationsPath = path.join(gameDir, 'stations.json')

  const manifest = loadJson(manifestPath, `[${gameId}] game.json`, errors)
  const itemsDoc = loadJson(itemsPath, `[${gameId}] items.json`, errors)
  if (!manifest || !itemsDoc) {
    return {
      itemCount: 0,
      stationCount: 0,
      palCount: 0,
      habitatFileCount: 0,
      markerCount: 0,
      tileZoomCounts: null,
      skipped: [],
      itemsMissingIcon: 0,
      stationsMissingIcon: 0,
      anyOfCount: 0,
      multiRecipeCount: 0,
    }
  }

  // stations.json is optional — a game with no crafting-station concept can
  // omit it entirely and every station-shaped check below just sees {}.
  // AUDITED as part of item 3 (manifest-driven dataset presence): unlike
  // map/habitats/pals/tiles (PLAN.md §8, generated add-ons a game may or may
  // not ship), stations.json is core §1 schema alongside items.json — but it
  // is NOT added to the manifest.datasets hard-error gate below, and that is
  // deliberate, not an oversight: if a game genuinely HAS stations and this
  // file went missing, every recipe.stations[] reference would already fail
  // as an "unknown station" error the moment any item's recipe is checked
  // (below) — the existing reference-integrity checks already make that
  // regression loud. Only a game with truly no station concept (there isn't
  // one yet, but §9 anticipates it) would have zero recipes referencing any
  // station, and for THAT game an absent stations.json is legitimately inert,
  // not a hidden collapse. So this one stays a plain optional load.
  const stationsDoc = existsSync(stationsPath) ? loadJson(stationsPath, `[${gameId}] stations.json`, errors) : {}

  const items = itemsDoc.items ?? {}
  const stations = stationsDoc ?? {}
  const tierIds = new Set((manifest.tiers ?? []).map((t) => t.id))
  const assetBase = manifest.assetBase ?? ''
  const publicAssetDir = path.join(PUBLIC_DIR, ...assetBase.split('/').filter(Boolean))

  let anyOfCount = 0
  let multiRecipeCount = 0 // items with 2+ entries in recipes[] (schema v3 axis 2)
  const reportedBadAnyOfIds = new Set() // dedupe: one error per distinct (item, ingredient, bad-alt) triple

  // 1. Every recipe.ingredients[].item must exist in items.
  // 2. Every recipe.stations[] must exist in stations.
  // 3. If the manifest declares tiers, every item.tier (if set) must be one of them.
  // schema v3 axis 2 (PLAN.md §1 decision 1/2): `item.recipe` (single object)
  // is now `item.recipes` (array, sorted cheapest-first) — a CLEAN BREAK, no
  // back-compat. A lingering legacy `recipe` key or a present-but-empty
  // `recipes` array are both hard errors (absent beats empty: a raw material
  // omits `recipes` entirely).
  for (const [id, item] of Object.entries(items)) {
    if (tierIds.size > 0 && item.tier != null && !tierIds.has(item.tier)) {
      errors.push(`[${gameId}] item "${id}": tier "${item.tier}" is not declared in game.json's tiers`)
    }

    if (Object.hasOwn(item, 'recipe')) {
      errors.push(
        `[${gameId}] item "${id}": still has a legacy "recipe" key — schema v3 requires "recipes" (an array); migrate it and remove "recipe"`,
      )
    }

    if (item.recipes === undefined) continue

    if (!Array.isArray(item.recipes)) {
      errors.push(`[${gameId}] item "${id}": "recipes" must be an array`)
      continue
    }
    if (item.recipes.length === 0) {
      errors.push(
        `[${gameId}] item "${id}": "recipes" is present but empty — a raw material must omit "recipes" entirely (absent beats empty)`,
      )
      continue
    }
    if (item.recipes.length > 1) multiRecipeCount++

    item.recipes.forEach((recipe, recipeIdx) => {
      const recipeLabel = item.recipes.length > 1 ? `recipes[${recipeIdx}]` : 'recipe'

      if (!Array.isArray(recipe.stations)) {
        errors.push(`[${gameId}] item "${id}": ${recipeLabel}.stations must be an array`)
      } else {
        for (const stationId of recipe.stations) {
          if (!(stationId in stations)) {
            errors.push(`[${gameId}] item "${id}": ${recipeLabel} references unknown station "${stationId}"`)
          }
        }
      }

      if (!Array.isArray(recipe.ingredients)) {
        errors.push(`[${gameId}] item "${id}": ${recipeLabel}.ingredients must be an array`)
        return
      }

      for (const ing of recipe.ingredients) {
        if (!(ing.item in items)) {
          errors.push(`[${gameId}] item "${id}": ${recipeLabel} references unknown ingredient item "${ing.item}"`)
        }

        // schema v3 axis 1 ("any of a set" ingredients, PLAN.md §1 decision 3 /
        // CLAUDE.md "Known schema limit"): `anyOf` is optional and purely
        // additive — `item` stays the sole representative tree.js/plan.js
        // maths follow, so these checks are hard errors at the same tier as a
        // dangling ingredient reference above, not a softer warning tier.
        if (ing.anyOf !== undefined) {
          anyOfCount++
          if (!Array.isArray(ing.anyOf)) {
            errors.push(`[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has a non-array anyOf`)
          } else {
            if (ing.anyOf.length < 2) {
              errors.push(
                `[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has anyOf with ${ing.anyOf.length} entr${ing.anyOf.length === 1 ? 'y' : 'ies'} — anyOf must have at least 2 (a single option is "no choice" and must omit anyOf entirely)`,
              )
            }
            // The invariant that keeps the tree maths honest: expansion and
            // quantities always follow `item`, so `item` must itself be one
            // of the acceptable substitutes anyOf lists — otherwise anyOf
            // would describe a different, disconnected set of options.
            if (!ing.anyOf.includes(ing.item)) {
              errors.push(
                `[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has anyOf that does not include "${ing.item}" itself — anyOf must contain the ingredient's own item, since tree.js/plan.js quantities always follow item, not anyOf`,
              )
            }
            for (const alt of ing.anyOf) {
              if (!(alt in items) && !reportedBadAnyOfIds.has(`${id} ${recipeIdx} ${ing.item} ${alt}`)) {
                reportedBadAnyOfIds.add(`${id} ${recipeIdx} ${ing.item} ${alt}`)
                errors.push(
                  `[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has anyOf referencing unknown item "${alt}"`,
                )
              }
            }
          }
        }

        if (ing.anyOfLabel !== undefined) {
          if (typeof ing.anyOfLabel !== 'string' || ing.anyOfLabel.length === 0) {
            errors.push(
              `[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has anyOfLabel that is not a non-empty string`,
            )
          }
          if (ing.anyOf === undefined) {
            errors.push(
              `[${gameId}] item "${id}": ${recipeLabel} ingredient "${ing.item}" has anyOfLabel but no anyOf — a label with no set makes no sense`,
            )
          }
        }
      }
    })
  }

  // 4. Every item/station icon path must resolve under public/<assetBase>/.
  // A genuinely absent icon is legal (not an error) here — see checkIcon's
  // doc comment — but still counted so it's visible in the OK summary line.
  let itemsMissingIcon = 0
  let stationsMissingIcon = 0
  for (const [id, item] of Object.entries(items)) {
    checkIcon(errors, 'item', gameId, publicAssetDir, id, item.icon, {
      optional: true,
      missingIconCounter: () => itemsMissingIcon++,
    })
  }
  for (const [id, station] of Object.entries(stations)) {
    checkIcon(errors, 'station', gameId, publicAssetDir, id, station.icon, {
      optional: true,
      missingIconCounter: () => stationsMissingIcon++,
    })
  }

  // 4b. Icon-COVERAGE floor: a missing icon is legal per-item (4, above), but
  // an unbounded COUNT of them is not — that flag exists for a genuinely
  // small, documented set (Minecraft's own ~27% with no representative
  // texture at all: slabs/stairs/etc. reusing a parent material via a model,
  // entity-rendered blocks), not as an escape hatch that lets a real
  // collapse "pass". Real regression this closes (2026-07-28): a
  // fetch-minecraft.mjs re-run in a cold-cache worktree aborted its icon loop
  // early and abandoned every remaining item — INCLUDING ones whose icon
  // file already existed on disk — dropping items-with-an-icon from 1,182 to
  // 11 while validate-data.mjs still printed "OK" because `optional: true`
  // has no ceiling. `minIconCoverage` is manifest-declared (fraction of
  // items+stations that must resolve an icon) because the legitimate floor
  // genuinely differs by game; a game that doesn't declare one gets a
  // conservative default, since near-complete coverage is the norm and an
  // undeclared game silently regressing should still be caught.
  const totalIconable = Object.keys(items).length + Object.keys(stations).length
  const totalResolvedIcon = totalIconable - itemsMissingIcon - stationsMissingIcon
  const minIconCoverage = manifest.minIconCoverage ?? DEFAULT_MIN_ICON_COVERAGE
  if (totalIconable > 0 && totalResolvedIcon / totalIconable < minIconCoverage) {
    errors.push(
      `[${gameId}] icon coverage collapsed: only ${totalResolvedIcon}/${totalIconable} items+stations resolve an ` +
        `icon (${((totalResolvedIcon / totalIconable) * 100).toFixed(1)}%), below this game's minIconCoverage floor ` +
        `of ${(minIconCoverage * 100).toFixed(0)}% (game.json "minIconCoverage", default ${DEFAULT_MIN_ICON_COVERAGE} when undeclared) — ` +
        `a real icon-set regression, not a documented per-item gap. Do not raise the floor to silence this; fix the ` +
        `data (or the scraper) instead.`,
    )
  }

  // 5. Generated datasets (§8) — presence is MANIFEST-DRIVEN (item 3
  // hardening), not "absent is always legal". A dataset a game never had
  // (Minecraft: `"datasets": []`) is a legitimate skip, exactly as before.
  // But a dataset NAMED in this game's own game.json `datasets` array is now
  // a HARD ERROR when missing or empty — that is precisely the escape-hatch
  // shape that would let a real regression (a deleted map.json, a wiped
  // habitats/ dir, an emptied pals.json) print "skipped (not present)" and
  // exit 0. The manifest is the discriminator: it already had to be checked,
  // never assumed (see game.json audits for both games alongside this fix).
  const palsPath = path.join(gameDir, 'pals.json')
  const habitatsDir = path.join(publicAssetDir, 'data', 'habitats')
  const mapPath = path.join(publicAssetDir, 'data', 'map.json')
  const tilesDir = path.join(publicAssetDir, 'tiles')
  const declaredDatasets = new Set(manifest.datasets ?? [])

  /** A declared dataset that is absent, OR present-but-empty, is a hard
   * error. An undeclared dataset is never checked here — its presence/
   * absence is exactly as legitimate as it always was. */
  function checkDeclaredDataset(name, present, isEmpty, whatMissing) {
    if (!declaredDatasets.has(name)) return
    if (!present) {
      errors.push(
        `[${gameId}] game.json declares dataset "${name}" but ${whatMissing} is absent — either regenerate it or ` +
          `remove "${name}" from game.json's "datasets" if this game genuinely no longer ships it.`,
      )
    } else if (isEmpty) {
      errors.push(`[${gameId}] game.json declares dataset "${name}" but ${whatMissing} is empty (0 entries).`)
    }
  }

  const skipped = []
  const { fileCount: habitatFileCount, pointCounts: habitatPointCounts } = validateHabitatFiles(
    gameId,
    habitatsDir,
    errors,
  )
  const habitatsPresent = existsSync(habitatsDir)
  if (!habitatsPresent) skipped.push('habitats/')
  checkDeclaredDataset('habitats', habitatsPresent, habitatFileCount === 0, 'public/.../data/habitats/')

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
  checkDeclaredDataset('pals', palsPresent, palCount === 0, 'src/data/.../pals.json')

  const { present: mapPresent, markerCount } = validateMap(gameId, mapPath, items, errors)
  if (!mapPresent) skipped.push('map.json')
  // markerCount === 0 while mapPresent is already a hard error inside
  // validateMap() itself ("markers is empty") — checkDeclaredDataset still
  // asserts it here too (a second, dataset-labelled error for the same
  // root cause is harmless and makes the "declared dataset" angle explicit).
  checkDeclaredDataset('map', mapPresent, markerCount === 0, 'public/.../data/map.json')

  const { present: tilesPresent, zoomCounts: tileZoomCounts } = validateTiles(gameId, tilesDir, errors)
  if (!tilesPresent) skipped.push('tiles/')
  checkDeclaredDataset('tiles', tilesPresent, tilesPresent && Object.keys(tileZoomCounts ?? {}).length === 0, 'public/.../tiles/')

  return {
    itemCount: Object.keys(items).length,
    stationCount: Object.keys(stations).length,
    palCount,
    habitatFileCount,
    markerCount,
    tileZoomCounts: tilesPresent ? tileZoomCounts : null,
    skipped,
    itemsMissingIcon,
    stationsMissingIcon,
    anyOfCount,
    multiRecipeCount,
  }
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
let totalItemsMissingIcon = 0
let totalStationsMissingIcon = 0
let totalAnyOf = 0
let totalMultiRecipe = 0
const multiRecipeByGame = [] // "<gameId>: N"
const skippedByGame = [] // "<gameId>: <dataset>, <dataset>"
const tileSummaryByGame = [] // "<gameId>: z0 1/1, z1 4/4, ..."

for (const gameId of gameDirs) {
  const {
    itemCount,
    stationCount,
    palCount,
    habitatFileCount,
    markerCount,
    tileZoomCounts,
    skipped,
    itemsMissingIcon,
    stationsMissingIcon,
    anyOfCount,
    multiRecipeCount,
  } = validateGame(gameId, errors)
  totalItems += itemCount
  totalStations += stationCount
  totalPals += palCount
  totalHabitatFiles += habitatFileCount
  totalMarkers += markerCount
  totalItemsMissingIcon += itemsMissingIcon
  totalStationsMissingIcon += stationsMissingIcon
  totalAnyOf += anyOfCount
  totalMultiRecipe += multiRecipeCount
  if (multiRecipeCount > 0) multiRecipeByGame.push(`${gameId}: ${multiRecipeCount}`)
  if (skipped.length > 0) skippedByGame.push(`${gameId}: ${skipped.join(', ')}`)
  if (tileZoomCounts) {
    const perZoom = Object.entries(tileZoomCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([z, c]) => `z${z} ${c.present}/${c.expected}`)
      .join(', ')
    tileSummaryByGame.push(`${gameId}: ${perZoom}`)
  }
}

if (errors.length > 0) {
  fail(errors)
}

const skippedNote =
  skippedByGame.length > 0 ? ` Skipped (not present): ${skippedByGame.join('; ')}.` : ' No datasets skipped.'
const tilesNote = tileSummaryByGame.length > 0 ? ` Tiles: ${tileSummaryByGame.join('; ')}.` : ''
const totalMissingIcon = totalItemsMissingIcon + totalStationsMissingIcon
const missingIconNote =
  totalMissingIcon > 0
    ? ` ${totalMissingIcon} item/station icon(s) legitimately absent (${totalItemsMissingIcon} items, ${totalStationsMissingIcon} stations) — allowed, not an error (see checkIcon).`
    : ''
const multiRecipeNote =
  multiRecipeByGame.length > 0 ? ` Multi-recipe items (2+ recipes[]): ${multiRecipeByGame.join(', ')}.` : ''

console.log(
  `validate-data: OK — ${gameDirs.length} game${gameDirs.length === 1 ? '' : 's'} (${gameDirs.join(', ')}), ` +
    `${totalItems} items, ${totalStations} stations, ${totalPals} pals, ${totalHabitatFiles} habitat files, ` +
    `${totalMarkers} map markers, ${totalAnyOf} anyOf ingredient(s), ${totalMultiRecipe} item(s) with 2+ recipes, ` +
    `all references resolve and every present icon resolves to a real file.` +
    `${missingIconNote}${tilesNote}${skippedNote}${multiRecipeNote}`,
)
