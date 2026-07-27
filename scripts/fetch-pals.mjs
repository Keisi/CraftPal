#!/usr/bin/env node
// CraftPal pal habitat + drops data pipeline: scrapes https://paldb.cc for the
// full pal roster's drop tables and day/night spawn-point clouds, and
// downloads pal icons. See PLAN.md §8.
//
// Usage:
//   node scripts/fetch-pals.mjs [--limit=N] [--only=index,datatable,detail,habitat,icon] [--verbose]
//
// --limit=N   caps the number of NEW network requests (page/datatable/habitat/
//             icon fetches) issued in this invocation. Already-cached
//             responses don't count. Re-run to resume — everything is cached
//             under scripts/.cache/ so a re-run only fetches what's missing.
// --only=...  restricts which phases are allowed to issue NEW network
//             requests (comma list of index,datatable,detail,habitat,icon). A
//             phase not listed still uses its cache if present, but won't
//             fetch. Useful for iterating on one parser without re-hitting
//             the site.
//
// Design:
//   1. Discover the pal roster from the server-rendered card grid at
//      /en/Pals: display name + page-slug href (`a.itemname`) and the
//      internal pal "code" recovered from the icon CDN filename pattern
//      T_<Code>_icon_normal.webp. The code, lowercased, is the join key for
//      both the habitat endpoint below and palworld.gg (crosscheck script).
//   1a. UNION that roster with the raw game DataTable
//      (/DataTable/UI/DT_PaldexDistributionData.json, ~18.7 MB, one big
//      fetch): /en/Pals is narrower than the data paldb actually serves — it
//      silently omitted PlantSlime_Flower (24 day / 24 night real spawns)
//      even though /paldex/plantslime_flower.json returns them (found via
//      palworld.gg cross-check 2026-07-27). We parse the DataTable exactly
//      once and keep only its row KEYS (never its Locations — the per-pal
//      /paldex/<code>.json endpoint stays the habitat source of truth, since
//      it carries `lv` and the DataTable does not), excluding two classes of
//      row that are not roster gaps: `BOSS_*`/`Boss_*` alpha/boss variants
//      (fixed spawns already covered by map.json's Alpha Pal layer) and the
//      literal `RowName` sentinel (a DataTable template artifact carrying
//      fake 18/18 locations, not a pal). Every surviving code absent from
//      the index roster is a genuine gap: its display name/href/icon aren't
//      known from HTML, so they're resolved from /paldex/<code>.json's
//      `Name` field and the CDN icon-filename pattern instead, and flagged
//      `discoveredVia: "datatable"` in the output so it's visible in the
//      data which pals didn't come from the index page.
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
//      A DataTable-only pal's icon URL is derived rather than scraped, so it
//      can genuinely 404; when it does, fall back to its base species' icon
//      (paldb's <Base>_<Suffix> variant convention — the same one CLAUDE.md
//      already documents for item icons) before recording icon: null.
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
const PAL_DATATABLE_CACHE_DIR = path.join(CACHE_DIR, 'pal-datatable')

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
const DATATABLE_URL = `${BASE}/DataTable/UI/DT_PaldexDistributionData.json`
const PAL_ICON_CDN = 'https://cdn.paldb.cc/image/Pal/Texture/PalIcon/Normal'
const REFERER = 'https://paldb.cc/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MIN_INTERVAL_MS = 500
const FALLBACK_GAME_VERSION = '0.6.x'
const VALID_PHASES = new Set(['index', 'detail', 'habitat', 'icon', 'datatable'])

// DataTable row-key exclusion rules (see discoverDataTableCodes()) — each
// with its own rationale so a future reader doesn't have to re-derive it:
//   - alpha/boss variants: fixed spawns already covered by map.json's Alpha
//     Pal layer (PLAN.md §8), so they are not a roster gap. Observed casings
//     are inconsistent (`BOSS_*`, `Boss_*`) hence case-insensitive.
const BOSS_ROW_PREFIX_RE = /^boss_/i
//   - the literal row key "RowName": a DataTable template/sentinel artifact,
//     not a pal (it even carries fake 18/18 "locations").
const DATATABLE_SENTINEL_KEY = 'RowName'

// Tripwires — same rationale + style as fetch-map.mjs's MIN_MARKERS_TRIPWIRE:
// a scraper that silently returns less is worse than one that dies (PLAN.md).
// If paldb.cc changes /en/Pals' markup, the cheerio selectors in
// discoverPals() would match few/no cards and this script would otherwise
// happily write a near-empty pals.json while reporting "success" — the exact
// failure mode fetch-map.mjs already guards against for map markers.
//
// MIN_PAL_ROSTER_TRIPWIRE is checked right after discovery (index roster +
// DataTable union). The index-page portion (/en/Pals) is a single page,
// fetched or served from cache in full regardless of --limit/--only, so it
// alone already clears this floor with room to spare — a short roster here
// is never a legitimate partial run, it can only mean a page didn't parse as
// expected. (The DataTable-union addition on top of it CAN legitimately be
// incomplete under --only/--limit — see the DataTable-union log line — but
// that never brings the total below the index-only count, so the floor
// stays a valid hard-error signal either way.)
const MIN_PAL_ROSTER_TRIPWIRE = 250 // real roster on 2026-07-27 is 300 pals (299 from /en/Pals + 1 added by the DataTable union: PlantSlime_Flower)

// MIN_HABITATS_TRIPWIRE is only asserted when this run actually had a chance
// to observe habitat availability across the WHOLE roster (see
// habitatFloorApplies in main()) — otherwise a --limit'd or --only-restricted
// incremental invocation would false-fire constantly during development.
const MIN_HABITATS_TRIPWIRE = 200 // real count on 2026-07-27 is 279/300 (21 are genuine upstream 404s for unique/boss pals; the +1 over the old 278/299 is PlantSlime_Flower, which does have real habitat data)

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
      console.error(`fetch-pals: unknown --only phase "${phase}" (valid: index,datatable,detail,habitat,icon)`)
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
// DataTable union: /DataTable/UI/DT_PaldexDistributionData.json -> row keys
// ---------------------------------------------------------------------------
/**
 * Fetch the raw game DataTable (~18.7 MB) and return just its row KEYS,
 * split into eligible pal codes vs. the two excluded classes (see the
 * BOSS_ROW_PREFIX_RE / DATATABLE_SENTINEL_KEY comments above). We do not need
 * Locations here — the per-pal /paldex/<code>.json endpoint remains the
 * habitat source of truth (it carries `lv`; this DataTable does not) — so
 * the parsed document is scoped to this function and dropped the moment the
 * keys are extracted, never duplicated or held onto alongside the raw text.
 */
async function discoverDataTableCodes(report) {
  const text = await fetchCached({
    url: DATATABLE_URL,
    cacheDir: PAL_DATATABLE_CACHE_DIR,
    cacheKey: '_dt_paldex_distribution',
    ext: 'json',
    phaseName: 'datatable',
    report,
  })
  if (!text) return { codes: [], totalRows: 0, excludedBoss: 0, excludedSentinel: 0, unavailable: true }

  let allKeys
  {
    // Parse exactly once; only Object.keys(Rows) survives this block — the
    // 18.7 MB parsed doc (with every pal's Locations) is eligible for GC as
    // soon as this block exits.
    const doc = JSON.parse(text)
    allKeys = Object.keys(doc[0]?.Rows ?? {})
  }

  let excludedBoss = 0
  let excludedSentinel = 0
  const codes = []
  for (const key of allKeys) {
    if (BOSS_ROW_PREFIX_RE.test(key)) {
      excludedBoss++ // alpha/boss variant — covered by map.json's Alpha Pal layer, not a roster gap
      continue
    }
    if (key === DATATABLE_SENTINEL_KEY) {
      excludedSentinel++ // DataTable template/sentinel artifact, not a pal
      continue
    }
    codes.push(key)
  }
  return { codes, totalRows: allKeys.length, excludedBoss, excludedSentinel, unavailable: false }
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
  ensureDir(PAL_DATATABLE_CACHE_DIR)
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
  const indexPalCount = pals.size
  log(`fetch-pals: ${indexPalCount} pals from /en/Pals`)

  // --- DataTable union: catch pals the index page silently omits ----------
  log('fetch-pals: cross-checking against the raw DataTable (DT_PaldexDistributionData.json)...')
  const dt = await discoverDataTableCodes(report)
  log(
    `fetch-pals: DataTable has ${dt.totalRows} rows (excluded ${dt.excludedBoss} boss/alpha variant(s), ` +
      `${dt.excludedSentinel} sentinel row) -> ${dt.codes.length} eligible pal code(s)`,
  )

  const addedByDataTable = []
  const unresolvedDataTableCodes = []
  for (const rawCode of dt.codes) {
    const codeLower = rawCode.toLowerCase()
    if (pals.has(codeLower)) continue // already known from /en/Pals — not a gap

    // Name/href/icon aren't known from HTML for a DataTable-only pal, so
    // resolve them: /paldex/<code>.json's `Name` field gives the display
    // name (also the habitat source of truth, per the module comment); the
    // detail-page href is derived from that name (paldb slugs use
    // underscores for spaces); the icon URL is derived from the CDN's stable
    // filename pattern. fetchHabitat() is cached/throttled/--limit-gated
    // exactly like every other request here, so calling it this early (the
    // "habitat" phase loop below will simply hit its cache for this code).
    const habitat = await fetchHabitat(codeLower, report)
    if (!habitat?.name) {
      unresolvedDataTableCodes.push(rawCode) // offline this run, or a genuine upstream gap — retry next run
      continue
    }
    const href = habitat.name.trim().replace(/\s+/g, '_')
    const iconUrl = `${PAL_ICON_CDN}/T_${rawCode}_icon_normal.webp`
    pals.set(codeLower, { code: rawCode, name: habitat.name, href, iconUrl, discoveredVia: 'datatable' })
    addedByDataTable.push(codeLower)
  }
  report.dataTableUnavailable = dt.unavailable
  report.dataTableExcludedBoss = dt.excludedBoss
  report.dataTableExcludedSentinel = dt.excludedSentinel
  report.dataTableAdded = addedByDataTable.sort()
  report.dataTableUnresolved = unresolvedDataTableCodes.sort()
  log(
    `fetch-pals: roster union — ${indexPalCount} from /en/Pals + ${addedByDataTable.length} added by the ` +
      `DataTable${unresolvedDataTableCodes.length > 0 ? ` (${unresolvedDataTableCodes.length} DataTable-only code(s) unresolved this run)` : ''}`,
  )

  const codes = [...pals.keys()].sort((a, b) => a.localeCompare(b))
  log(`fetch-pals: discovered ${codes.length} pals total, gameVersion=${gameVersion}`)

  if (codes.length < MIN_PAL_ROSTER_TRIPWIRE) {
    throw new Error(
      `HARD ERROR: /en/Pals parsed to only ${codes.length} pals, expected at least ${MIN_PAL_ROSTER_TRIPWIRE} — ` +
        'upstream format likely changed.',
    )
  }

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

  // The habitat floor only applies when this run had a genuine opportunity to
  // observe habitat availability across the whole roster: the habitat phase
  // must be enabled this run (not excluded via --only), and --limit must not
  // have cut the habitat loop above short (limitReached, snapshotted right
  // here — before the icon phase can raise it for unrelated reasons). Either
  // condition means this was a deliberate partial/incremental invocation, not
  // a signal that paldb.cc's habitat endpoint shape changed.
  const habitatFloorApplies = phaseAllowed('habitat') && !limitReached
  if (habitatFloorApplies && habitatByCode.size < MIN_HABITATS_TRIPWIRE) {
    throw new Error(
      `HARD ERROR: only ${habitatByCode.size}/${codes.length} pals resolved habitat data, expected at least ` +
        `${MIN_HABITATS_TRIPWIRE} — upstream format likely changed.`,
    )
  }

  // --- Phase: icons -----------------------------------------------------------
  let iconsPresent = 0
  let iconsWritten = 0
  let iconsFallback = 0 // DataTable-only variant reused/fetched its base species' icon
  let iconsMissing = 0
  // codeLower -> "icons/pals/<baseCodeLower>.webp" for entries that ended up
  // pointing at a base pal's icon file instead of their own (populated below,
  // consumed when building each pal's final `icon` field further down).
  const iconFallbackPathByCode = new Map()
  for (const codeLower of codes) {
    const { iconUrl, code, discoveredVia } = pals.get(codeLower)
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
      continue
    }

    // A DataTable-only pal's own derived icon URL 404ing doesn't mean paldb
    // has no icon for it: paldb's <Base>_<Suffix> variant-code convention
    // (the same one CLAUDE.md documents for item icons — "variants of a
    // family may share one icon file") often means the BASE species' icon is
    // the one actually rendered for this variant. Try that before giving up:
    // reuse the base pal's file if it's already on disk — `codes` is sorted
    // alphabetically, so a base code like "plantslime" always precedes its
    // "plantslime_flower" variant in this very loop, meaning the base file
    // normally already exists by the time we get here — else fetch the base
    // code's own CDN URL. Only if BOTH fail do we fall through to icon: null
    // (never invent a path to a file that isn't actually there).
    let usedFallback = false
    if (discoveredVia === 'datatable' && code.includes('_')) {
      const baseCode = code.slice(0, code.lastIndexOf('_'))
      const baseCodeLower = baseCode.toLowerCase()
      const basePublicPath = path.join(PUBLIC_PAL_ICONS_DIR, `${baseCodeLower}.webp`)
      if (existsSync(basePublicPath)) {
        usedFallback = true
      } else {
        const baseBytes = await fetchCached({
          url: `${PAL_ICON_CDN}/T_${baseCode}_icon_normal.webp`,
          cacheDir: PAL_ICONS_CACHE_DIR,
          cacheKey: baseCodeLower,
          ext: 'webp',
          phaseName: 'icon',
          binary: true,
          report,
        })
        if (baseBytes) {
          writeFileSync(basePublicPath, baseBytes)
          usedFallback = true
        }
      }
      if (usedFallback) iconFallbackPathByCode.set(codeLower, `icons/pals/${baseCodeLower}.webp`)
    }
    if (usedFallback) iconsFallback++
    else iconsMissing++
  }
  log(
    `fetch-pals: icons ${iconsPresent} present, ${iconsWritten} written, ${iconsFallback} via base-code fallback, ${iconsMissing} missing`,
  )

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
    const { code, name, discoveredVia } = pals.get(codeLower)
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
    // Icon presence is checked against the real file on disk rather than
    // assumed — a scraped index-page pal's icon has never failed to date,
    // but a DataTable-only pal's icon URL is *derived* (not scraped from a
    // working <img> tag) and can genuinely 404 (see the icon phase above,
    // including the base-code fallback it tries before giving up).
    const iconOnDisk = existsSync(path.join(PUBLIC_PAL_ICONS_DIR, `${codeLower}.webp`))
    const icon = iconOnDisk ? `icons/pals/${codeLower}.webp` : (iconFallbackPathByCode.get(codeLower) ?? null)
    const entry = {
      name,
      code,
      icon,
      drops,
      hasHabitat: !!habitat,
    }
    if (discoveredVia) entry.discoveredVia = discoveredVia

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

  // DataTable-only pals get an explicit health check of their own: their
  // icon/drops are both *derived* rather than scraped straight from a known
  // href, so either one can legitimately come up empty (§ the module
  // comment) — surface that in the report/console rather than let it hide
  // inside the aggregate counts. A fallback-icon entry is real (a file exists
  // on disk, just under the base pal's code) — distinguished from iconless
  // (no file at all) by comparing the final icon path to "own code" shape.
  const dataTableOnlyIds = codes.filter((c) => pals.get(c).discoveredVia === 'datatable')
  const dataTableOnlyIconFallback = dataTableOnlyIds.filter(
    (c) => finalPals[c].icon && finalPals[c].icon !== `icons/pals/${c}.webp`,
  )
  const dataTableOnlyIconless = dataTableOnlyIds.filter((c) => !finalPals[c].icon)
  const dataTableOnlyDropless = dataTableOnlyIds.filter((c) => finalPals[c].drops.length === 0)

  report.finishedAt = new Date().toISOString()
  report.gameVersion = gameVersion
  report.counts = {
    pals: codes.length,
    indexPals: indexPalCount,
    dataTableTotalRows: dt.totalRows,
    dataTableExcludedBoss: dt.excludedBoss,
    dataTableExcludedSentinel: dt.excludedSentinel,
    dataTableAdded: addedByDataTable.length,
    dataTableUnresolved: unresolvedDataTableCodes.length,
    detailPagesAvailable: detailByCode.size,
    detailPagesNewlyFetched: detailNewlyFetched,
    habitatsAvailable: habitatByCode.size,
    habitatsNewlyFetched: habitatNewlyFetched,
    habitatsWithData,
    habitatsMissing: codes.length - habitatsWithData,
    iconsPresent,
    iconsWritten,
    iconsFallback,
    iconsMissing,
    totalDropRows,
    dropsMatched,
    dropsUnmatched: totalDropRows - dropsMatched,
  }
  report.unmatchedDropNames = [...report.unmatchedDropNames].sort()
  report.dataTableOnlyPals = {
    count: dataTableOnlyIds.length,
    ids: dataTableOnlyIds,
    iconFallback: dataTableOnlyIconFallback,
    iconless: dataTableOnlyIconless,
    dropless: dataTableOnlyDropless,
  }
  report.partial =
    report.partial ||
    limitReached ||
    detailByCode.size < codes.length ||
    habitatByCode.size < codes.length ||
    unresolvedDataTableCodes.length > 0

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')

  const matchRate = totalDropRows > 0 ? ((dropsMatched / totalDropRows) * 100).toFixed(1) : 'n/a'
  log('')
  log(`fetch-pals: ${report.partial ? 'PARTIAL' : 'COMPLETE'} run summary`)
  log(`  pals: ${report.counts.pals} (${report.counts.indexPals} from /en/Pals + ${report.counts.dataTableAdded} added by the DataTable union)`)
  log(
    `  DataTable: ${report.counts.dataTableTotalRows} rows, excluded ${report.counts.dataTableExcludedBoss} boss/alpha variant(s) + ${report.counts.dataTableExcludedSentinel} sentinel row` +
      (report.counts.dataTableUnresolved > 0 ? `, ${report.counts.dataTableUnresolved} unresolved this run` : ''),
  )
  if (dataTableOnlyIds.length > 0) {
    log(`  DataTable-only pals (${dataTableOnlyIds.length}): ${dataTableOnlyIds.join(', ')}`)
    if (dataTableOnlyIconFallback.length > 0) log(`    icon via base-code fallback: ${dataTableOnlyIconFallback.join(', ')}`)
    if (dataTableOnlyIconless.length > 0) log(`    WARNING: icon-less (own + base-code CDN URLs both 404'd): ${dataTableOnlyIconless.join(', ')}`)
    if (dataTableOnlyDropless.length > 0) log(`    WARNING: drop-less (derived detail page 404'd or had no Possible Drops): ${dataTableOnlyDropless.join(', ')}`)
  }
  log(`  detail pages: ${report.counts.detailPagesAvailable}/${report.counts.pals} (${detailNewlyFetched} new)`)
  log(
    `  habitats: ${report.counts.habitatsWithData}/${report.counts.pals} with data (${habitatNewlyFetched} new fetches)`
  )
  log(`  icons: ${iconsPresent} present, ${iconsWritten} written, ${iconsFallback} via base-code fallback, ${iconsMissing} missing`)
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
