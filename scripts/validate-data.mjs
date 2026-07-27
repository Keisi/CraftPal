#!/usr/bin/env node
// Validates src/data/items.json + src/data/stations.json for internal
// consistency: every ingredient/station reference resolves, and every icon
// path resolves to an existing file under public/. Node, no deps.
//
// Usage: node scripts/validate-data.mjs
// Exits 0 on success, 1 with a clear message on the first class of failure
// (all errors of each kind are reported together, not just the first one).

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const ITEMS_PATH = path.join(ROOT, 'src', 'data', 'items.json')
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json')
const PUBLIC_DIR = path.join(ROOT, 'public')

function loadJson(p, label) {
  if (!existsSync(p)) {
    fail([`${label} not found at ${p}`])
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    fail([`${label} is not valid JSON: ${err.message}`])
  }
}

function fail(errors) {
  console.error(`\nvalidate-data: FAILED (${errors.length} error${errors.length === 1 ? '' : 's'})\n`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error('')
  process.exit(1)
}

const itemsDoc = loadJson(ITEMS_PATH, 'src/data/items.json')
const stationsDoc = loadJson(STATIONS_PATH, 'src/data/stations.json')

const items = itemsDoc.items ?? {}
const stations = stationsDoc

const errors = []

// 1. Every recipe.ingredients[].item must exist in items.
// 2. Every recipe.stations[] must exist in stations.
for (const [id, item] of Object.entries(items)) {
  if (!item.recipe) continue

  if (!Array.isArray(item.recipe.stations)) {
    errors.push(`item "${id}": recipe.stations must be an array`)
  } else {
    for (const stationId of item.recipe.stations) {
      if (!(stationId in stations)) {
        errors.push(`item "${id}": recipe references unknown station "${stationId}"`)
      }
    }
  }

  if (!Array.isArray(item.recipe.ingredients)) {
    errors.push(`item "${id}": recipe.ingredients must be an array`)
  } else {
    for (const ing of item.recipe.ingredients) {
      if (!(ing.item in items)) {
        errors.push(`item "${id}": recipe references unknown ingredient item "${ing.item}"`)
      }
    }
  }
}

// 3. Every item/station icon path must resolve to an existing file under public/.
function checkIcon(kind, id, icon) {
  if (!icon) {
    errors.push(`${kind} "${id}": missing icon path`)
    return
  }
  const relPath = icon.startsWith('/') ? icon.slice(1) : icon
  const abs = path.join(PUBLIC_DIR, relPath)
  if (!existsSync(abs)) {
    errors.push(`${kind} "${id}": icon "${icon}" does not resolve to an existing file (expected ${abs})`)
  }
}

for (const [id, item] of Object.entries(items)) {
  checkIcon('item', id, item.icon)
}
for (const [id, station] of Object.entries(stations)) {
  checkIcon('station', id, station.icon)
}

if (errors.length > 0) {
  fail(errors)
}

const itemCount = Object.keys(items).length
const stationCount = Object.keys(stations).length
console.log(`validate-data: OK — ${itemCount} items, ${stationCount} stations, all references + icons resolve.`)
