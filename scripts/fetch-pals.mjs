#!/usr/bin/env node
// CraftPal pal habitat + drops data pipeline: scrapes https://paldb.cc for the
// full pal roster's drop tables and day/night spawn-point clouds, and
// downloads pal icons. See PLAN.md §8.
//
// Usage:
//   node scripts/fetch-pals.mjs [--limit=N] [--only=index,detail,habitat,icon] [--verbose]
//
// --limit=N   caps the number of NEW network requests (page/habitat/icon
//             fetches) issued in this invocation. Already-cached responses
//             don't count. Re-run to resume — everything is cached under
//             scripts/.cache/ so a re-run only fetches what's missing.
// --only=...  restricts which phases are allowed to issue NEW network
//             requests (comma list of index,detail,habitat,icon). A phase
//             not listed still uses its cache if present, but won't fetch.
//             Useful for iterating on one parser without re-hitting the site.
//
// Design:
//   1. Discover the pal roster from the server-rendered card grid at
//      /en/Pals: display name + page-slug href (`a.itemname`) and the
//      internal pal "code" recovered from the icon CDN filename pattern
//      T_<Code>_icon_normal.webp. The code, lowercased, is the join key for
//      both the habitat endpoint below and palworld.gg (crosscheck script).
//   2. Fetch each pal detail page /en/<href> (throttled, cached) and parse
//      its "Possible Drops" table (item name + drop-rate + qty range).
//   3. Fetch each pal's habitat point cloud from the stable per-pal endpoint
//      /paldex/<code-lowercased>.json (day/night Locations + Radius, no
//      hashed filename — unlike palworld.gg's map chunk).
//   4. Resolve every drop name to a CraftPal item id by normalized-name
//      match against src/data/palworld/items.json (falls back to
//      src/data/items.json if the multigame restructure hasn't moved it
//      yet). Unmatched drops are still emitted with item: null.
//   5. Download every pal icon once (throttled + cached, skip existing).
//   6. Emit src/data/palworld/pals.json (small static-importable index, no
//      coordinates), one public/games/palworld/data/habitats/<code>.json
//      per pal (lazy-loaded, compact flat-triple arrays), and a run report.

import * as cheerio from 'cheerio'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const CACHE_DIR = path.join(ROOT, 'scripts', '.cache')
const PAL_PAGES_DIR = path.join(CACHE_DIR, 'pal-pages')
const PAL_HABITATS_CACHE_DIR = path.join(CACHE_DIR, 'pal-habitats')
const PAL_ICONS_CACHE_DIR = path.join(CACHE_DIR, 'pal-icons')

const PALS_OUT = path.join(ROOT, 'src', 'data', 'palworld', 'pals.json')
const PUBLIC_HABITATS_DIR = path.join(ROOT, 'public', 'games', 'palworld', 'data', 'habitats')
const PUBLIC_PAL_ICONS_DIR = path.join(ROOT, 'public', 'games', 'palworld', 'icons', 'pals')
const REPORT_OUT = path.join(CACHE_DIR, 'fetch-pals-report.json')

// The multigame refactor (a parallel worktree effort, PLAN.md §9) may or may
// not have moved items.json under src/data/palworld/ yet — handle both.
const ITEMS_PATH_PREFERRED = path.join(ROOT, 'src', 'data', 'palworld', 'items.json')
const ITEMS_PATH_FALLBACK = path.join(ROOT, 'src', 'data', 'items.json')

const BASE = 'https://paldb.cc'
const PALS_INDEX_URL = `${BASE}/en/Pals`
const VERSION_URL = `${BASE}/en/version`
const REFERER = 'https://paldb.cc/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MIN_INTERVAL_MS = 500
const FALLBACK_GAME_VERSION = '0.6.x'
const VALID_PHASES = new Set(['index', 'detail', 'habitat', 'icon'])

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
let LIMIT = Infinity
let VERBOSE = false
let ONLY = null // null == all phases allowed
for (const arg of args) {
  const limitMatch = arg.match(/^--limit=(\d+)$/)
  if (limitMatch) LIMIT = Number(limitMatch[1])
  if (arg === '--verbose') VERBOSE = true
  const onlyMatch = arg.match(/^--only=(.+)$/)
  if (onlyMatch) ONLY = new Set(onlyMatch[1].split(',').map((s) => s.trim()).filter(Boolean))
}
if (ONLY) {
  for (const phase of ONLY) {
    if (!VALID_PHASES.has(phase)) {
      console.error(`fetch-pals: unknown --only phase "${phase}" (valid: index,detail,habitat,icon)`)
      process.exit(1)
    }
  }
}
function phaseAllowed(name) {
  return ONLY === null || ONLY.has(name)
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function log(...a) {
  console.log(...a)
}
function vlog(...a) {
  if (VERBOSE) console.log(...a)
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}
function cacheKeyFor(segment) {
  return segment.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** Lowercase + strip everything but [a-z0-9] — comparison key for fuzzy name matching. */
function normalizeForMatch(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

// ---------------------------------------------------------------------------
// Throttled, cached, resumable HTTP (mirrors scripts/fetch-data.mjs's style,
// generalized over a caller-supplied cache dir/extension and gated by --only)
// ---------------------------------------------------------------------------
let lastRequestAt = 0
let newFetchCount = 0
let limitReached = false

async function throttle() {
  const now = Date.now()
  const wait = lastRequestAt + MIN_INTERVAL_MS - now
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

async function rawFetch(url, { binary = false } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, status: res.status }
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text()
    return { ok: true, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, error: err.message }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch `url`, using `<cacheDir>/<cacheKey>.<ext>` as a resumable cache.
 * Gated by --only (phaseName) and --limit; retries once on 403/429/network
 * error. Returns the cached/fetched body (string, or Buffer if binary), or
 * null if unavailable this run (logged into `report`).
 */
async function fetchCached({ url, cacheDir, cacheKey, ext, phaseName, binary = false, report }) {
  ensureDir(cacheDir)
  const file = path.join(cacheDir, `${cacheKeyFor(cacheKey)}.${ext}`)
  if (existsSync(file)) {
    vlog(`  [cache] ${cacheKey}`)
    return binary ? readFileSync(file) : readFileSync(file, 'utf8')
  }
  if (!phaseAllowed(phaseName)) {
    report.skippedByOnlyFilter.push({ phase: phaseName, url })
    return null
  }
  if (newFetchCount >= LIMIT) {
    limitReached = true
    return null
  }
  await throttle()
  newFetchCount++
  vlog(`  [fetch:${phaseName}] ${url}`)
  let result = await rawFetch(url, { binary })
  if (!result.ok && (result.status === 403 || result.status === 429 || result.status === 0)) {
    await sleep(3000)
    result = await rawFetch(url, { binary })
  }
  if (!result.ok) {
    report.failedFetches.push({ phase: phaseName, url, status: result.status, error: result.error })
    return null
  }
  if (binary) writeFileSync(file, result.body)
  else writeFileSync(file, result.body, 'utf8')
  return result.body
}

// ---------------------------------------------------------------------------
// Game version (same endpoint/parse as fetch-data.mjs, own cache namespace)
// ---------------------------------------------------------------------------
async function discoverGameVersion(report) {
  const html = await fetchCached({
    url: VERSION_URL,
    cacheDir: PAL_PAGES_DIR,
    cacheKey: '_version',
    ext: 'html',
    phaseName: 'index',
    report,
  })
  if (!html) return FALLBACK_GAME_VERSION
  const $ = cheerio.load(html)
  const text = $('.card-body h1').first().text().trim()
  const m = text.match(/Version\s+v?(\d+\.\d+(?:\.\d+)?)/i)
  return m ? m[1] : FALLBACK_GAME_VERSION
}

// ---------------------------------------------------------------------------
// Discovery: /en/Pals -> code -> { name, href, iconUrl }
// ---------------------------------------------------------------------------
async function discoverPals(report) {
  const html = await fetchCached({
    url: PALS_INDEX_URL,
    cacheDir: PAL_PAGES_DIR,
    cacheKey: '_pals_index',
    ext: 'html',
    phaseName: 'index',
    report,
  })
  if (!html) {
    throw new Error(
      'could not fetch /en/Pals — cannot discover pal roster (check --only includes "index", or that ' +
        'scripts/.cache/pal-pages/_pals_index.html exists from a previous run)'
    )
  }
  const $ = cheerio.load(html)
  const pals = new Map() // code (lowercased) -> { code, name, href, iconUrl }
  $('.row.row-cols-1.row-cols-lg-4 .col[data-filters]').each((_, el) => {
    const $el = $(el)
    const img = $el.find('.flex-shrink-0 a img').first()
    const src = img.attr('src') || ''
    const codeMatch = src.match(/T_(.+)_icon_normal\.webp/)
    const nameA = $el.find('a.itemname').first()
    const name = nameA.text().trim()
    const href = nameA.attr('href')
    if (!codeMatch || !name || !href) {
      report.unparseableRosterCards.push({ src, name, href })
      return
    }
    const code = codeMatch[1]
    const codeLower = code.toLowerCase()
    if (pals.has(codeLower)) {
      report.duplicateCodes.push({ code, name, href, firstClaimedBy: pals.get(codeLower) })
      return
    }
    pals.set(codeLower, { code, name, href, iconUrl: src })
  })
  return pals
}

// ---------------------------------------------------------------------------
// Detail page: "Possible Drops" table
// ---------------------------------------------------------------------------
function parseDropsTable($, href, report) {
  const dropsCard = $('.card')
    .toArray()
    .find((c) => {
      const title = $(c).find('> .card-body > h5.card-title').first()
      return (
        title.length > 0 &&
        (title.attr('data-i18n') === 'paldex_drop_item_title' || title.text().trim() === 'Possible Drops')
      )
    })
  if (!dropsCard) return [] // legitimately no drops table for some pals (e.g. debug/NPC-only entries)

  const $card = $(dropsCard)
  const drops = []
  $card.find('table tbody tr').each((_, tr) => {
    const $tr = $(tr)
    const tds = $tr.children('td')
    if (tds.length < 2) return
    const nameA = tds.eq(0).find('a.itemname').first()
    const name = nameA.text().trim()
    const dropHref = nameA.attr('href')
    const qty = tds.eq(0).find('small.itemQuantity').first().text().trim() || undefined
    const rate = tds.eq(1).text().trim()
    if (!name) {
      report.unparseableDropRows.push({ href })
      return
    }
    drops.push({ name, href: dropHref, qty, rate })
  })
  return drops
}

// ---------------------------------------------------------------------------
// Habitat endpoint: /paldex/<code>.json
// ---------------------------------------------------------------------------
async function fetchHabitat(codeLower, report) {
  const url = `${BASE}/paldex/${codeLower}.json`
  const text = await fetchCached({
    url,
    cacheDir: PAL_HABITATS_CACHE_DIR,
    cacheKey: codeLower,
    ext: 'json',
    phaseName: 'habitat',
    report,
  })
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    report.unparseableHabitats.push({ code: codeLower, reason: `invalid JSON: ${err.message}` })
    return null
  }
  const day = parsed.dayTimeLocations?.Locations ?? []
  const night = parsed.nightTimeLocations?.Locations ?? []
  return {
    name: parsed.Name,
    day,
    night,
    dayRadius: parsed.dayTimeLocations?.Radius ?? null,
    nightRadius: parsed.nightTimeLocations?.Radius ?? null,
  }
}

/** [{X,Y,lv?}, ...] -> flat [x,y,lv, x,y,lv, ...] triples, coords rounded, lv 0 when absent. */
function toFlatTriples(locations) {
  const flat = []
  for (const p of locations) {
    flat.push(Math.round(p.X), Math.round(p.Y), Number.isFinite(p.lv) ? Math.round(p.lv) : 0)
  }
  return flat
}

/** Min/max spawn level across one or more Locations arrays (points lacking `lv` don't count). */
function levelRange(...locationArrays) {
  let min = Infinity
  let max = -Infinity
  let any = false
  for (const arr of locationArrays) {
    for (const p of arr) {
      if (Number.isFinite(p.lv)) {
        any = true
        if (p.lv < min) min = p.lv
        if (p.lv > max) max = p.lv
      }
    }
  }
  return any ? { levelMin: min, levelMax: max } : { levelMin: null, levelMax: null }
}

// ---------------------------------------------------------------------------
// CraftPal item-id resolution for drops
// ---------------------------------------------------------------------------
function loadItemNameIndex(report) {
  let itemsPath = null
  if (existsSync(ITEMS_PATH_PREFERRED)) itemsPath = ITEMS_PATH_PREFERRED
  else if (existsSync(ITEMS_PATH_FALLBACK)) itemsPath = ITEMS_PATH_FALLBACK
  if (!itemsPath) {
    report.itemsSource = null
    return new Map()
  }
  report.itemsSource = path.relative(ROOT, itemsPath).replace(/\\/g, '/')
  const doc = JSON.parse(readFileSync(itemsPath, 'utf8'))
  const items = doc.items ?? {}
  const index = new Map() // normalized name -> item id
  for (const [id, item] of Object.entries(items)) {
    const key = normalizeForMatch(item.name)
    if (!index.has(key)) index.set(key, id)
  }
  return index
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR)
  ensureDir(PAL_PAGES_DIR)
  ensureDir(PAL_HABITATS_CACHE_DIR)
  ensureDir(PAL_ICONS_CACHE_DIR)
  ensureDir(path.dirname(PALS_OUT))
  ensureDir(PUBLIC_HABITATS_DIR)
  ensureDir(PUBLIC_PAL_ICONS_DIR)

  const report = {
    startedAt: new Date().toISOString(),
    limit: LIMIT === Infinity ? null : LIMIT,
    only: ONLY ? [...ONLY] : null,
    itemsSource: undefined,
    failedFetches: [],
    skippedByOnlyFilter: [],
    unparseableRosterCards: [],
    duplicateCodes: [],
    unparseableDropRows: [],
    unparseableHabitats: [],
    unmatchedDropNames: new Set(),
    counts: {},
    partial: false,
  }

  log('fetch-pals: discovering pal roster from /en/Pals...')
  const gameVersion = await discoverGameVersion(report)
  const pals = await discoverPals(report)
  const codes = [...pals.keys()].sort((a, b) => a.localeCompare(b))
  log(`fetch-pals: discovered ${codes.length} pals, gameVersion=${gameVersion}`)

  // --- Phase: detail pages (drops) -----------------------------------------
  const detailByCode = new Map()
  const newFetchCountBeforeDetail = newFetchCount
  for (const codeLower of codes) {
    const { href } = pals.get(codeLower)
    const url = `${BASE}/en/${href}`
    const html = await fetchCached({
      url,
      cacheDir: PAL_PAGES_DIR,
      cacheKey: href,
      ext: 'html',
      phaseName: 'detail',
      report,
    })
    if (html != null) detailByCode.set(codeLower, html)
    const fetchedSoFar = newFetchCount - newFetchCountBeforeDetail
    if (fetchedSoFar > 0 && fetchedSoFar % 50 === 0) log(`  ...fetched ${fetchedSoFar} new detail pages so far`)
    if (limitReached) break
  }
  const detailNewlyFetched = newFetchCount - newFetchCountBeforeDetail
  log(`fetch-pals: ${detailByCode.size}/${codes.length} detail pages available (${detailNewlyFetched} newly fetched)`)

  // --- Phase: habitat endpoints ---------------------------------------------
  const habitatByCode = new Map()
  const newFetchCountBeforeHabitat = newFetchCount
  for (const codeLower of codes) {
    const habitat = await fetchHabitat(codeLower, report)
    if (habitat) habitatByCode.set(codeLower, habitat)
    const fetchedSoFar = newFetchCount - newFetchCountBeforeHabitat
    if (fetchedSoFar > 0 && fetchedSoFar % 50 === 0) log(`  ...fetched ${fetchedSoFar} new habitat files so far`)
    if (limitReached) break
  }
  const habitatNewlyFetched = newFetchCount - newFetchCountBeforeHabitat
  log(`fetch-pals: ${habitatByCode.size}/${codes.length} habitats available (${habitatNewlyFetched} newly fetched)`)

  // --- Phase: icons -----------------------------------------------------------
  let iconsPresent = 0
  let iconsWritten = 0
  let iconsMissing = 0
  for (const codeLower of codes) {
    const { iconUrl } = pals.get(codeLower)
    const publicPath = path.join(PUBLIC_PAL_ICONS_DIR, `${codeLower}.webp`)
    if (existsSync(publicPath)) {
      iconsPresent++
      continue
    }
    const bytes = await fetchCached({
      url: iconUrl,
      cacheDir: PAL_ICONS_CACHE_DIR,
      cacheKey: codeLower,
      ext: 'webp',
      phaseName: 'icon',
      binary: true,
      report,
    })
    if (bytes) {
      writeFileSync(publicPath, bytes)
      iconsWritten++
    } else {
      iconsMissing++
    }
  }
  log(`fetch-pals: icons ${iconsPresent} present, ${iconsWritten} written, ${iconsMissing} missing`)

  if (limitReached) {
    report.partial = true
    log('fetch-pals: --limit reached; run again to continue')
  }

  // --- Resolve drops against CraftPal item ids -------------------------------
  const itemIndex = loadItemNameIndex(report)
  log(
    itemIndex.size > 0
      ? `fetch-pals: matching drops against ${report.itemsSource} (${itemIndex.size} items)`
      : 'fetch-pals: WARNING — no items.json found (neither src/data/palworld/items.json nor src/data/items.json); all drops will be unmatched'
  )

  let totalDropRows = 0
  let dropsMatched = 0
  const finalPals = {}
  let habitatsWithData = 0

  for (const codeLower of codes) {
    const { code, name } = pals.get(codeLower)
    const detailHtml = detailByCode.get(codeLower)
    let drops = []
    if (detailHtml) {
      const $ = cheerio.load(detailHtml)
      const rawDrops = parseDropsTable($, codeLower, report)
      drops = rawDrops.map((d) => {
        totalDropRows++
        const matchedId = itemIndex.get(normalizeForMatch(d.name)) ?? null
        if (matchedId) dropsMatched++
        else report.unmatchedDropNames.add(d.name)
        const entry = { item: matchedId, name: d.name, rate: d.rate }
        if (d.qty) entry.qty = d.qty
        return entry
      })
    }

    const habitat = habitatByCode.get(codeLower)
    const entry = {
      name,
      code,
      icon: `icons/pals/${codeLower}.webp`,
      drops,
      hasHabitat: !!habitat,
    }

    if (habitat) {
      habitatsWithData++
      const dayFlat = toFlatTriples(habitat.day)
      const nightFlat = toFlatTriples(habitat.night)
      const { levelMin, levelMax } = levelRange(habitat.day, habitat.night)
      const radius = habitat.dayRadius ?? habitat.nightRadius ?? null
      entry.habitat = {
        day: habitat.day.length,
        night: habitat.night.length,
        levelMin,
        levelMax,
        radius,
      }
      const habitatFile = path.join(PUBLIC_HABITATS_DIR, `${codeLower}.json`)
      const habitatDoc = {
        code: codeLower,
        name: habitat.name ?? name,
        radius: { day: habitat.dayRadius, night: habitat.nightRadius },
        day: dayFlat,
        night: nightFlat,
      }
      writeFileSync(habitatFile, JSON.stringify(habitatDoc), 'utf8') // compact, no pretty-print
    }

    finalPals[codeLower] = entry
  }

  const palsDoc = { schemaVersion: 1, gameVersion, pals: finalPals }
  writeFileSync(PALS_OUT, JSON.stringify(palsDoc, null, 2) + '\n', 'utf8')

  report.finishedAt = new Date().toISOString()
  report.gameVersion = gameVersion
  report.counts = {
    pals: codes.length,
    detailPagesAvailable: detailByCode.size,
    detailPagesNewlyFetched: detailNewlyFetched,
    habitatsAvailable: habitatByCode.size,
    habitatsNewlyFetched: habitatNewlyFetched,
    habitatsWithData,
    habitatsMissing: codes.length - habitatsWithData,
    iconsPresent,
    iconsWritten,
    iconsMissing,
    totalDropRows,
    dropsMatched,
    dropsUnmatched: totalDropRows - dropsMatched,
  }
  report.unmatchedDropNames = [...report.unmatchedDropNames].sort()
  report.partial =
    report.partial || limitReached || detailByCode.size < codes.length || habitatByCode.size < codes.length

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')

  const matchRate = totalDropRows > 0 ? ((dropsMatched / totalDropRows) * 100).toFixed(1) : 'n/a'
  log('')
  log(`fetch-pals: ${report.partial ? 'PARTIAL' : 'COMPLETE'} run summary`)
  log(`  pals: ${report.counts.pals}`)
  log(`  detail pages: ${report.counts.detailPagesAvailable}/${report.counts.pals} (${detailNewlyFetched} new)`)
  log(
    `  habitats: ${report.counts.habitatsWithData}/${report.counts.pals} with data (${habitatNewlyFetched} new fetches)`
  )
  log(`  icons: ${iconsPresent} present, ${iconsWritten} written, ${iconsMissing} missing`)
  log(`  drops: ${totalDropRows} rows, ${dropsMatched} matched (${matchRate}%), ${totalDropRows - dropsMatched} unmatched`)
  log(`  items source used for matching: ${report.itemsSource ?? '(none found)'}`)
  if (report.unmatchedDropNames.length > 0) {
    log(`  sample unmatched names: ${report.unmatchedDropNames.slice(0, 15).join(', ')}`)
  }
  log(`  failed fetches: ${report.failedFetches.length}`)
  log(`  report written to ${REPORT_OUT}`)
}

main().catch((err) => {
  console.error('fetch-pals: FATAL', err)
  process.exit(1)
})
