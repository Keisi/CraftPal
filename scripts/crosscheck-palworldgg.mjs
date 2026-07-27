#!/usr/bin/env node
// Independent verification pass for PLAN.md §8's pal-habitat data. Resolves +
// extracts palworld.gg's baked-in map-data chunk (a content-hashed Nuxt SSR
// `/_nuxt/*.js` file — palworld.gg has no data API, see PLAN.md §8) and
// compares its per-pal spawn-point counts against our own paldb.cc-derived
// src/data/palworld/pals.json (written by scripts/fetch-pals.mjs).
//
// Ships NO data — this is a report-only cross-check. Writes
// scripts/.cache/crosscheck-report.json and prints a console summary.
//
// Usage: node scripts/crosscheck-palworldgg.mjs [--verbose]
//
// What this DOES prove: whether the two independently-scraped sources
// roughly agree on (a) which pals exist, and (b) how many spawn points each
// has — a sanity check that our paldb.cc scrape isn't badly broken or
// missing a chunk of the roster.
//
// What this does NOT prove: which source is "correct" if they disagree.
// palworld.gg's dataset is a SINGLE point cloud per pal with no day/night
// split (PLAN.md §8); paldb.cc splits day/night and tags many points with a
// spawn level. So `.gg total` vs `paldb day+night` disagreeing by a lot is
// not automatically a bug in either scraper — it may just mean one site's
// datamine is stale relative to the other, or that .gg's cloud already
// happens to be day-only (or night-only, or de-duplicated). This script
// reports the numbers; it does not adjudicate them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const CACHE_DIR = path.join(ROOT, 'scripts', '.cache')
const GG_PAGES_DIR = path.join(CACHE_DIR, 'palworldgg-pages')
const GG_CHUNKS_DIR = path.join(CACHE_DIR, 'palworldgg-chunks')
const REPORT_OUT = path.join(CACHE_DIR, 'crosscheck-report.json')
const PALS_JSON = path.join(ROOT, 'src', 'data', 'palworld', 'pals.json')

const GG_BASE = 'https://palworld.gg'
const MAP_URL = `${GG_BASE}/map`
const ANCHOR = 'wolf_dark:' // a stable pal key known to appear in the master map literal
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MIN_INTERVAL_MS = 500

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const VERBOSE = process.argv.includes('--verbose')
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

// ---------------------------------------------------------------------------
// Throttled, cached, retrying HTTP (same house style as fetch-data.mjs /
// fetch-pals.mjs, no --limit here — this script only ever issues a handful
// of requests: the /map page + however many /_nuxt/*.js chunks it lists)
// ---------------------------------------------------------------------------
let lastRequestAt = 0

async function throttle() {
  const now = Date.now()
  const wait = lastRequestAt + MIN_INTERVAL_MS - now
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

async function rawFetch(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) return { ok: false, status: res.status }
    const body = await res.text()
    return { ok: true, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, error: err.message }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchTextCached(url, cacheDir, cacheKey, report) {
  ensureDir(cacheDir)
  const file = path.join(cacheDir, `${cacheKeyFor(cacheKey)}.js`)
  if (existsSync(file)) {
    vlog(`  [cache] ${cacheKey}`)
    return readFileSync(file, 'utf8')
  }
  await throttle()
  vlog(`  [fetch] ${url}`)
  let result = await rawFetch(url)
  if (!result.ok) {
    await sleep(2000)
    result = await rawFetch(url)
  }
  if (!result.ok) {
    report.failedFetches.push({ url, status: result.status, error: result.error })
    return null
  }
  writeFileSync(file, result.body, 'utf8')
  return result.body
}

// ---------------------------------------------------------------------------
// Resolver: GET /map, enumerate the /_nuxt/*.js chunks it references, fetch
// each, and pick the one containing the anchor. This indirection is the
// whole point — the chunk filename is content-hashed and changes on every
// palworld.gg deploy (PLAN.md §8's "Fragility" note), so it can never be
// hardcoded.
// ---------------------------------------------------------------------------
async function resolveMapChunk(report) {
  const mapHtml = await fetchTextCached(MAP_URL, GG_PAGES_DIR, '_map_page', report)
  if (!mapHtml) throw new Error('could not fetch https://palworld.gg/map — cannot resolve the data chunk')

  const chunkRefs = [...new Set([...mapHtml.matchAll(/\/_nuxt\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))]
  log(`crosscheck: /map references ${chunkRefs.length} /_nuxt/*.js chunks`)
  if (chunkRefs.length === 0) throw new Error('no /_nuxt/*.js references found on /map — page shape may have changed')

  for (const ref of chunkRefs) {
    const url = `${GG_BASE}${ref}`
    const cacheKey = ref.replace(/^\/_nuxt\//, '').replace(/\.js$/, '')
    const source = await fetchTextCached(url, GG_CHUNKS_DIR, cacheKey, report)
    if (source && source.includes(ANCHOR)) {
      log(`crosscheck: anchor "${ANCHOR}" found in ${ref} (${source.length} bytes)`)
      return { ref, source }
    }
  }
  throw new Error(
    `anchor "${ANCHOR}" not found in any of ${chunkRefs.length} chunks — palworld.gg's chunk layout may have ` +
      'changed; the resolver needs a new anchor (PLAN.md §8)'
  )
}

// ---------------------------------------------------------------------------
// Extractor — port of the recon spike's extract.mjs bracket-matching parser.
// 1. Locate the master `{ pal_code: minifiedVar, ... }` object literal by
//    anchoring on a known key, then balanced-brace-matching to its end.
// 2. For each `code: VAR` pair, resolve VAR's value by finding `VAR=` and
//    either bracket-matching a `[...]` literal or unwrapping a
//    `JSON.parse("...")` call (with escape-aware quote scanning).
// ---------------------------------------------------------------------------
function extractPalPointClouds(source, report) {
  const anchorIdx = source.indexOf(ANCHOR)
  if (anchorIdx === -1) throw new Error(`extractor: anchor "${ANCHOR}" unexpectedly missing from chosen chunk`)
  const start = source.lastIndexOf('{', anchorIdx)
  let depth = 0
  let end = -1
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (start === -1 || end === -1) throw new Error('extractor: could not balanced-brace-match the master map literal')

  const mapSrc = source.slice(start + 1, end)
  const pairs = [...mapSrc.matchAll(/([A-Za-z0-9_]+):([A-Za-z0-9_$]+)/g)].map((m) => [m[1], m[2]])
  vlog(`extractor: ${pairs.length} pal entries in master map`)

  function readVar(varName) {
    const re = new RegExp('[,;{=(\\s]' + varName.replace(/\$/g, '\\$') + '\\s*=\\s*')
    const m = re.exec(source)
    if (!m) return null
    const i = m.index + m[0].length
    if (source.startsWith('JSON.parse(', i)) {
      const q = source.indexOf('"', i)
      let j = q + 1
      while (j < source.length) {
        if (source[j] === '\\') j += 2
        else if (source[j] === '"') break
        else j++
      }
      return JSON.parse(JSON.parse(source.slice(q, j + 1)))
    }
    if (source[i] !== '[') return null
    let d = 0
    let k = i
    for (; k < source.length; k++) {
      if (source[k] === '[') d++
      else if (source[k] === ']') {
        d--
        if (d === 0) break
      }
    }
    return JSON.parse(source.slice(i, k + 1))
  }

  const out = {}
  const failed = []
  let totalPoints = 0
  for (const [code, varName] of pairs) {
    const arr = readVar(varName)
    if (!arr) {
      failed.push(`${code}=${varName}`)
      continue
    }
    out[code] = arr
    totalPoints += arr.length
  }
  report.extraction = { palEntriesInMasterMap: pairs.length, resolved: Object.keys(out).length, failed, totalPoints }
  return out
}

// ---------------------------------------------------------------------------
// Comparison against src/data/palworld/pals.json
// ---------------------------------------------------------------------------
function loadPaldbPals() {
  if (!existsSync(PALS_JSON)) {
    throw new Error(
      `${path.relative(ROOT, PALS_JSON)} not found — run scripts/fetch-pals.mjs first, then re-run this crosscheck`
    )
  }
  const doc = JSON.parse(readFileSync(PALS_JSON, 'utf8'))
  return doc.pals ?? {}
}

function compare(ggClouds, paldbPals) {
  const ggCodes = new Set(Object.keys(ggClouds))
  const paldbCodesWithHabitat = new Set(
    Object.entries(paldbPals)
      .filter(([, p]) => p.hasHabitat)
      .map(([code]) => code)
  )

  const onlyInGg = [...ggCodes].filter((c) => !paldbCodesWithHabitat.has(c)).sort()
  const onlyInPaldb = [...paldbCodesWithHabitat].filter((c) => !ggCodes.has(c)).sort()

  const both = [...ggCodes].filter((c) => paldbCodesWithHabitat.has(c)).sort()
  const perPal = both.map((code) => {
    const ggCount = ggClouds[code].length
    const p = paldbPals[code]
    const paldbDayNight = p.habitat.day + p.habitat.night
    const paldbDayOnly = p.habitat.day
    return {
      code,
      name: p.name,
      ggCount,
      paldbDay: p.habitat.day,
      paldbNight: p.habitat.night,
      paldbDayNight,
      deltaVsDayNight: ggCount - paldbDayNight,
      deltaVsDayOnly: ggCount - paldbDayOnly,
    }
  })

  const worstByDayNight = [...perPal].sort((a, b) => Math.abs(b.deltaVsDayNight) - Math.abs(a.deltaVsDayNight))
  const worstByDayOnly = [...perPal].sort((a, b) => Math.abs(b.deltaVsDayOnly) - Math.abs(a.deltaVsDayOnly))

  return {
    ggPalCount: ggCodes.size,
    paldbPalCountWithHabitat: paldbCodesWithHabitat.size,
    comparedPalCount: both.length,
    onlyInGg,
    onlyInPaldb,
    worstOffendersVsDayNight: worstByDayNight.slice(0, 20),
    worstOffendersVsDayOnly: worstByDayOnly.slice(0, 20),
    perPal,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR)
  ensureDir(GG_PAGES_DIR)
  ensureDir(GG_CHUNKS_DIR)

  const report = {
    startedAt: new Date().toISOString(),
    failedFetches: [],
    whatThisProves:
      'Whether paldb.cc (our primary source) and palworld.gg (independent scrape) roughly agree on the pal ' +
      'roster and spawn-point counts — a sanity check on our own scraper, not a ground-truth oracle.',
    whatThisDoesNotProve:
      'Which source is numerically "correct" when they disagree. palworld.gg has no day/night split (a single ' +
      'point cloud per pal) while paldb.cc splits day/night and tags spawn levels on most points, so a ' +
      '.gg-vs-paldb count mismatch is expected in general, not proof of a bug in either scraper.',
  }

  log('crosscheck: resolving palworld.gg map data chunk...')
  const { ref, source } = await resolveMapChunk(report)
  report.resolvedChunk = ref

  log('crosscheck: extracting pal point clouds...')
  const ggClouds = extractPalPointClouds(source, report)
  log(
    `crosscheck: extracted ${report.extraction.resolved}/${report.extraction.palEntriesInMasterMap} pals, ` +
      `${report.extraction.totalPoints} total points, ${report.extraction.failed.length} unresolved`
  )

  log('crosscheck: loading src/data/palworld/pals.json for comparison...')
  const paldbPals = loadPaldbPals()

  const result = compare(ggClouds, paldbPals)
  report.result = result
  report.finishedAt = new Date().toISOString()

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')

  log('')
  log('crosscheck: SUMMARY (see full report at ' + path.relative(ROOT, REPORT_OUT) + ')')
  log(`  palworld.gg pals extracted: ${result.ggPalCount}`)
  log(`  paldb.cc pals with habitat data: ${result.paldbPalCountWithHabitat}`)
  log(`  present in both: ${result.comparedPalCount}`)
  log(`  only in .gg (missing/no habitat in paldb): ${result.onlyInGg.length}`)
  if (result.onlyInGg.length > 0) log(`    ${result.onlyInGg.slice(0, 15).join(', ')}${result.onlyInGg.length > 15 ? ', ...' : ''}`)
  log(`  only in paldb (not found in .gg extraction): ${result.onlyInPaldb.length}`)
  if (result.onlyInPaldb.length > 0)
    log(`    ${result.onlyInPaldb.slice(0, 15).join(', ')}${result.onlyInPaldb.length > 15 ? ', ...' : ''}`)
  log('  worst offenders (.gg total vs paldb day+night):')
  for (const p of result.worstOffendersVsDayNight.slice(0, 10)) {
    log(`    ${p.code} (${p.name}): .gg=${p.ggCount} paldb(day+night)=${p.paldbDayNight} delta=${p.deltaVsDayNight}`)
  }
  log(`  report written to ${REPORT_OUT}`)
}

main().catch((err) => {
  console.error('crosscheck-palworldgg: FATAL', err.message)
  process.exit(1)
})
