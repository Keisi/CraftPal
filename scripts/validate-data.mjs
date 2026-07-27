#!/usr/bin/env node
// Validates every game directory under src/data/*/ for internal consistency
// (PLAN.md §9): every ingredient/station reference resolves, every icon path
// resolves to an existing file under public/<manifest.assetBase>, and every
// item's tier (if any) is one the game's own manifest declares. Manifest-
// driven, not a hardcoded Palworld ladder — a future game directory is
// validated the same way with zero changes here. Node, no deps.
//
// Usage: node scripts/validate-data.mjs
// Exits 0 on success, 1 with a clear message on the first class of failure
// (all errors of each kind are reported together, not just the first one).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DATA_DIR = path.join(ROOT, 'src', 'data')
const PUBLIC_DIR = path.join(ROOT, 'public')

function fail(errors) {
  console.error(`\nvalidate-data: FAILED (${errors.length} error${errors.length === 1 ? '' : 's'})\n`)
  for (const e of errors) console.error(`  - ${e}`)
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

function validateGame(gameId, errors) {
  const gameDir = path.join(DATA_DIR, gameId)
  const manifestPath = path.join(gameDir, 'game.json')
  const itemsPath = path.join(gameDir, 'items.json')
  const stationsPath = path.join(gameDir, 'stations.json')

  const manifest = loadJson(manifestPath, `[${gameId}] game.json`, errors)
  const itemsDoc = loadJson(itemsPath, `[${gameId}] items.json`, errors)
  if (!manifest || !itemsDoc) return { itemCount: 0, stationCount: 0 }

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

  return { itemCount: Object.keys(items).length, stationCount: Object.keys(stations).length }
}

const gameDirs = discoverGameDirs()
if (gameDirs.length === 0) {
  fail(['no game data directories found under src/data/*/'])
}

const errors = []
let totalItems = 0
let totalStations = 0

for (const gameId of gameDirs) {
  const { itemCount, stationCount } = validateGame(gameId, errors)
  totalItems += itemCount
  totalStations += stationCount
}

if (errors.length > 0) {
  fail(errors)
}

console.log(
  `validate-data: OK — ${gameDirs.length} game${gameDirs.length === 1 ? '' : 's'} (${gameDirs.join(', ')}), ` +
    `${totalItems} items, ${totalStations} stations, all references + icons resolve.`,
)
