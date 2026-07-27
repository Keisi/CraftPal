#!/usr/bin/env node
// CraftPal's Palworld data pipeline (the per-game adapter, PLAN.md §9):
// scrapes https://paldb.cc for the full item + station dataset and downloads
// all referenced icons. See PLAN.md §1/§2.
//
// Usage:
//   node scripts/fetch-data.mjs [--limit=N] [--only=item,station,icon] [--verbose]
//
// --limit=N   caps the number of NEW network requests (page or icon fetches)
//             issued in this invocation. Already-cached responses don't count.
//             Omit for a full run. Re-run the script to resume — everything is
//             cached in scripts/.cache/ so a re-run only fetches what's missing.
//
// Design (PLAN.md §2):
//   1. Discover item family pages from /en/Items (server-rendered listing).
//   2. Fetch each family page (throttled ~1 req/sec, browser UA + Referer,
//      cached to scripts/.cache/pages/).
//   3. Parse every rarity variant on each family page (name, category, rarity,
//      techLevel, recipe alternates, icon URL) with cheerio.
//   4. Discover + fetch + parse station pages referenced by recipes.
//   5. Resolve multi-recipe items to a single cheapest-in-raw-resources
//      primary recipe; log dropped alternates.
//   6. Assign stable kebab-case ids from display names, resolving collisions
//      with the paldb internal code.
//   7. Download every referenced icon (throttled + cached), write
//      src/data/palworld/items.json + stations.json, and emit a run report.

import * as cheerio from 'cheerio';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');
const PAGES_DIR = path.join(CACHE_DIR, 'pages');
const ICONS_CACHE_DIR = path.join(CACHE_DIR, 'icons');
// Per-game layout (PLAN.md §9): this scraper is the Palworld adapter, writing
// into src/data/palworld/ + public/games/palworld/icons/ — a future game gets
// its own scripts/fetch-<game>.mjs writing the analogous src/data/<game>/.
const GAME_DATA_DIR = path.join(ROOT, 'src', 'data', 'palworld');
const PUBLIC_ICONS_DIR = path.join(ROOT, 'public', 'games', 'palworld', 'icons');
const ITEMS_OUT = path.join(GAME_DATA_DIR, 'items.json');
const STATIONS_OUT = path.join(GAME_DATA_DIR, 'stations.json');
const REPORT_OUT = path.join(CACHE_DIR, 'fetch-report.json');

const BASE = 'https://paldb.cc';
const ITEMS_INDEX_URL = `${BASE}/en/Items`;
const VERSION_URL = `${BASE}/en/version`;
const REFERER = 'https://paldb.cc/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIN_INTERVAL_MS = 500;
const FALLBACK_GAME_VERSION = '0.6.x';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let LIMIT = Infinity;
let VERBOSE = false;
for (const arg of args) {
  const m = arg.match(/^--limit=(\d+)$/);
  if (m) LIMIT = Number(m[1]);
  if (arg === '--verbose') VERBOSE = true;
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

const ROMAN_TO_NUM = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5',
  vi: '6', vii: '7', viii: '8', ix: '9', x: '10',
};

/** Kebab-case an English display name into a stable id (PLAN.md §1 convention). */
function slugify(name) {
  const tokens = String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((tok) => ROMAN_TO_NUM[tok] ?? tok);
  return tokens.join('_');
}

/** CamelCase -> snake_case (for paldb "TypeA"/"Code" values used in ids/category). */
function camelToSnake(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

const CATEGORY_OVERRIDES = {
  Consume: 'consumable',
};

function normalizeCategory(typeA, badgeText) {
  const raw = typeA || badgeText || 'unknown';
  if (CATEGORY_OVERRIDES[raw]) return CATEGORY_OVERRIDES[raw];
  return camelToSnake(raw);
}

const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
function rarityRank(r) {
  return RARITY_RANK[r] ?? 50;
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Sanitize an arbitrary string (e.g. a URL-encoded href) into an id-safe suffix. */
function sanitizeIdSuffix(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// Throttled, cached HTTP
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

/** Sanitize an arbitrary path segment into a filesystem-safe cache filename. */
function cacheKeyFor(segment) {
  return segment.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function rawFetch(url, { binary = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch a page's HTML, using scripts/.cache/pages/<key>.html as a resumable cache. */
async function fetchPageCached(url, cacheKey, report) {
  ensureDir(PAGES_DIR);
  const file = path.join(PAGES_DIR, `${cacheKeyFor(cacheKey)}.html`);
  if (existsSync(file)) {
    vlog(`  [cache] ${cacheKey}`);
    return readFileSync(file, 'utf8');
  }
  if (newFetchCount >= LIMIT) {
    limitReached = true;
    return null;
  }
  await throttle();
  newFetchCount++;
  vlog(`  [fetch] ${url}`);
  let result = await rawFetch(url);
  if (!result.ok && (result.status === 403 || result.status === 429 || result.status === 0)) {
    await sleep(3000);
    result = await rawFetch(url);
  }
  if (!result.ok) {
    report.failedPages.push({ url, status: result.status, error: result.error });
    return null;
  }
  writeFileSync(file, result.body, 'utf8');
  return result.body;
}

/** Fetch an icon's bytes, using scripts/.cache/icons/<basename> as a resumable cache. */
async function fetchIconCached(url, report) {
  ensureDir(ICONS_CACHE_DIR);
  const basename = cacheKeyFor(decodeURIComponent(url.split('/').pop()));
  const file = path.join(ICONS_CACHE_DIR, basename);
  if (existsSync(file)) {
    vlog(`  [cache-icon] ${basename}`);
    return file;
  }
  if (newFetchCount >= LIMIT) {
    limitReached = true;
    return null;
  }
  await throttle();
  newFetchCount++;
  vlog(`  [fetch-icon] ${url}`);
  let result = await rawFetch(url, { binary: true });
  if (!result.ok && (result.status === 403 || result.status === 429 || result.status === 0)) {
    await sleep(3000);
    result = await rawFetch(url, { binary: true });
  }
  if (!result.ok) {
    report.failedIcons.push({ url, status: result.status, error: result.error });
    return null;
  }
  writeFileSync(file, result.body);
  return file;
}

// ---------------------------------------------------------------------------
// Discovery: /en/Items -> unique family hrefs
// ---------------------------------------------------------------------------
async function discoverItemHrefs(report) {
  const html = await fetchPageCached(ITEMS_INDEX_URL, '_index', report);
  if (!html) throw new Error('could not fetch /en/Items — cannot discover items');
  const $ = cheerio.load(html);
  const seen = new Map(); // href -> display name
  $('.flex-grow-1.mx-2 > a.itemname[href]').each((_, el) => {
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    if (!href || href.startsWith('http') || href.startsWith('#')) return;
    // "-" is a literal placeholder entry for an unnamed/unavailable internal
    // item (observed: internal code "Gasoline", flagged "Not available") —
    // slugify("-") would otherwise produce an empty-string id.
    if (href === '-' || name === '-' || !name) return;
    if (!seen.has(href)) seen.set(href, name);
  });
  return seen;
}

async function discoverGameVersion(report) {
  const html = await fetchPageCached(VERSION_URL, '_version', report);
  if (!html) return FALLBACK_GAME_VERSION;
  const $ = cheerio.load(html);
  const text = $('.card-body h1').first().text().trim();
  const m = text.match(/Version\s+v?(\d+\.\d+(?:\.\d+)?)/i);
  return m ? m[1] : FALLBACK_GAME_VERSION;
}

// ---------------------------------------------------------------------------
// Parsing a single item-family page: one or more rarity-variant "rows"
// ---------------------------------------------------------------------------

/** Extract label->value pairs from the Stats/Others cards inside a .col-lg-4. */
function extractKeyValues($, col4) {
  const kv = {};
  col4.find('.card.mt-3 .d-flex.justify-content-between').each((_, el) => {
    const divs = $(el).children('div');
    if (divs.length >= 2) {
      const label = $(divs[0]).text().trim();
      const value = $(divs[divs.length - 1]).text().trim();
      if (label) kv[label] = value;
    }
  });
  return kv;
}

/** Extract the "Production" card's station list + recipe-alternate rows from a .col-lg-8. */
function extractProduction($, col8) {
  if (!col8 || col8.length === 0) return null;
  const prodCard = col8
    .find('.card')
    .toArray()
    .find((c) => $(c).find('> .card-body > h5.card-title').text().includes('Production'));
  if (!prodCard) return null;
  const $prod = $(prodCard);

  const stations = [];
  $prod.find('.row.row-cols-1 a.itemname').each((_, a) => {
    const href = $(a).attr('href');
    const name = $(a).text().trim();
    if (href && name) stations.push({ href, name });
  });

  const alternates = [];
  $prod.find('table.table tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.find('th').length > 0) return; // header row
    const tds = $tr.children('td');
    if (tds.length < 3) return;
    const [td0, td1, td2] = [tds.eq(0), tds.eq(1), tds.eq(2)];

    const ingredients = [];
    td0.find('span').each((_, span) => {
      const $span = $(span);
      const a = $span.find('a.itemname').first();
      if (a.length === 0) return; // e.g. the crafting-time clock span
      const name = a.text().trim();
      const href = a.attr('href');
      const qtyText = $span.find('small.itemQuantity').first().text().trim();
      const qty = parseInt(qtyText, 10);
      if (name && Number.isFinite(qty)) ingredients.push({ name, href, qty });
    });
    if (ingredients.length === 0) return;

    const yieldsText = td1.find('small.itemQuantity').first().text().trim();
    const yields = yieldsText ? parseInt(yieldsText, 10) || 1 : 1;

    const techText = td2.text();
    const techMatch = techText.match(/Technology\s*Lv\.?\s*(\d+)/i);
    const techLevel = techMatch ? Number(techMatch[1]) : undefined;
    const schematic = td2.find('a.itemname').first().text().trim() || undefined;

    alternates.push({ ingredients, yields, techLevel, schematic });
  });

  if (alternates.length === 0) return null;
  return { stations, alternates };
}

/**
 * Parse one family page's HTML into a list of variant records:
 * { familyName, rarity, category, icon, techLevel(unused-top), code, isDebug,
 *   stations, alternates }
 */
function parseFamilyPage(html, slugHint, report) {
  const $ = cheerio.load(html);
  const variants = [];
  const debugVariants = []; // same shape, kept in case a live recipe still needs one by name
  let hadNonItemRow = false;
  let hadDebugRow = false;

  $('.row.g-2[data-tabname]').each((_, rowEl) => {
    const $row = $(rowEl);
    const familyName = ($row.attr('data-tabname') || '').trim();
    const $popup = $row.find('.card.itemPopup').first();
    if ($popup.length === 0) return; // pseudo-tab (loot table etc.), not a real item variant

    const isDebug = $popup.find('.fa-sack-xmark').length > 0;

    const rarityEl = $popup.find('.hover_banner [class*="hover_text_rarity"]').first();
    const rarity = rarityEl.text().trim().toLowerCase();
    const categoryBadge = $popup.find('.hover_banner span.me-auto').first().text().trim();
    const iconUrl = $popup.find('.hover_icon_bg img').first().attr('src');

    // Some pages bundle an unrelated wiki entry (MapObject, Pal, ...) that
    // happens to share the display name (e.g. a mineable "Coal" MapObject on
    // the "Coal" item page, or the "Pal" summoned by "Summoning Altar") —
    // every genuine item variant carries a rarity badge, so its absence is a
    // reliable "not actually an item" signal regardless of the category text.
    if (!rarity) {
      hadNonItemRow = true;
      return;
    }

    const col4 = $popup.closest('.col-lg-4');
    const kv = extractKeyValues($, col4);
    const code = kv['Code'];
    const category = normalizeCategory(kv['TypeA'], categoryBadge);
    const col8 = $row.find('.col-lg-8').first();
    const production = extractProduction($, col8);
    const record = {
      familyName,
      rarity,
      category,
      iconUrl,
      code,
      stations: production ? production.stations : [],
      alternates: production ? production.alternates : [],
    };

    if ((code && /debug/i.test(code)) || isDebug) {
      report.skippedDebugVariants.push({ slugHint, familyName, code: code || '(no code)' });
      hadDebugRow = true;
      // Still keep it, unlisted, in case some *live* recipe names it as an
      // ingredient (observed: unreleased "(Ultra)" superboss fragments) —
      // better to include a flagged-unavailable material than silently drop
      // a real item's ingredient.
      debugVariants.push(record);
      return;
    }

    if (!familyName || !rarity) {
      report.unparseablePages.push({ slugHint, reason: 'missing name or rarity on an unexpected variant row' });
      return;
    }

    variants.push(record);
  });

  if (variants.length === 0 && !hadNonItemRow && !hadDebugRow) {
    report.unparseablePages.push({ slugHint, reason: 'no .itemPopup variants found on page' });
  }
  return { variants, debugVariants };
}

// ---------------------------------------------------------------------------
// Station pages
// ---------------------------------------------------------------------------
function parseStationPage(html, slugHint, report) {
  const $ = cheerio.load(html);
  const $popup = $('.card.itemPopup').first();
  if ($popup.length === 0) {
    report.unparseablePages.push({ slugHint, reason: 'no .itemPopup found on station page' });
    return null;
  }
  const name = $popup.find('.hover_banner .align-self-center a.itemname').first().text().trim();
  const iconUrl = $popup.find('.hover_icon_bg img').first().attr('src');
  let techLevel;
  $popup.find('.hover_icon_bg .d-inline-block').each((_, el) => {
    const $el = $(el);
    const label = $el.children('span').first().text();
    if (/Technology/i.test(label)) {
      const val = $el.children('span').eq(1).text().trim();
      const n = Number(val);
      if (Number.isFinite(n)) techLevel = n;
    }
  });
  if (!name || !iconUrl) {
    report.unparseablePages.push({ slugHint, reason: 'station page missing name or icon' });
    return null;
  }
  return { name, iconUrl, techLevel };
}

// ---------------------------------------------------------------------------
// Raw-resource cost (for choosing the primary recipe among alternates)
// ---------------------------------------------------------------------------
function computeRawCost(itemId, itemsById, memo, visiting) {
  if (memo.has(itemId)) return memo.get(itemId);
  if (visiting.has(itemId)) return Infinity; // cycle guard (shouldn't happen — Palworld is acyclic)
  const item = itemsById.get(itemId);
  if (!item || !item.alternates || item.alternates.length === 0) {
    memo.set(itemId, 1);
    return 1;
  }
  visiting.add(itemId);
  let best = Infinity;
  for (const alt of item.alternates) {
    let cost = 0;
    for (const ing of alt.ingredients) {
      if (!ing.resolvedId) {
        cost = Infinity;
        break;
      }
      cost += ing.qty * computeRawCost(ing.resolvedId, itemsById, memo, visiting);
    }
    if (cost < best) best = cost;
  }
  visiting.delete(itemId);
  memo.set(itemId, best);
  return best;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR);
  ensureDir(PAGES_DIR);
  ensureDir(ICONS_CACHE_DIR);
  ensureDir(PUBLIC_ICONS_DIR);
  ensureDir(GAME_DATA_DIR);

  const report = {
    startedAt: new Date().toISOString(),
    limit: LIMIT === Infinity ? null : LIMIT,
    failedPages: [],
    failedIcons: [],
    unparseablePages: [],
    skippedDebugVariants: [],
    droppedAlternates: [],
    collisions: [],
    unresolvedIngredients: [],
    categoryValues: {},
    counts: {},
    partial: false,
  };

  log(`fetch-data: discovering item index...`);
  const gameVersion = await discoverGameVersion(report);
  const discovered = await discoverItemHrefs(report);
  const hrefs = [...discovered.keys()].sort((a, b) => a.localeCompare(b));
  log(`fetch-data: discovered ${hrefs.length} unique item family pages, gameVersion=${gameVersion}`);

  // --- Phase B: fetch item pages (resumable, throttled) -------------------
  const pageHtmlByHref = new Map();
  const newFetchCountBeforePages = newFetchCount;
  for (const href of hrefs) {
    const url = `${BASE}/en/${href}`;
    const html = await fetchPageCached(url, href, report);
    if (html == null) {
      if (limitReached) break;
      continue; // fetch failed after retry; logged in report.failedPages
    }
    pageHtmlByHref.set(href, html);
    const fetchedSoFar = newFetchCount - newFetchCountBeforePages;
    if (fetchedSoFar > 0 && fetchedSoFar % 50 === 0) log(`  ...fetched ${fetchedSoFar} new item pages so far`);
  }
  // include everything already-cached from previous runs too, for parsing
  for (const href of hrefs) {
    if (!pageHtmlByHref.has(href)) {
      const file = path.join(PAGES_DIR, `${cacheKeyFor(href)}.html`);
      if (existsSync(file)) pageHtmlByHref.set(href, readFileSync(file, 'utf8'));
    }
  }
  const pagesNewlyFetched = newFetchCount - newFetchCountBeforePages;
  log(`fetch-data: ${pageHtmlByHref.size}/${hrefs.length} item pages available (${pagesNewlyFetched} newly fetched this run)`);
  if (limitReached) {
    report.partial = true;
    log(`fetch-data: --limit reached; run again to continue (item pages remaining: ${hrefs.length - pageHtmlByHref.size})`);
  }

  // --- Phase C: parse item pages -------------------------------------------
  // rawVariants: one entry per family href, each with a list of variant rows
  const rawFamilies = new Map(); // href -> variants[]
  // Debug/"not available" variants, kept aside in case a *live* item's recipe
  // still names one as an ingredient (observed: unreleased superboss
  // "(Ultra)" fragments) — familyName -> { href, record }.
  const debugVariantsByName = new Map();
  function rememberDebugVariants(href, debugVariants) {
    for (const record of debugVariants) {
      if (!debugVariantsByName.has(record.familyName)) {
        debugVariantsByName.set(record.familyName, { href, record });
      }
    }
  }
  for (const [href, html] of pageHtmlByHref) {
    const { variants, debugVariants } = parseFamilyPage(html, href, report);
    rememberDebugVariants(href, debugVariants);
    if (variants.length > 0) rawFamilies.set(href, variants);
  }

  // --- Assign ids per family (base = lowest rarity; others get rarity suffix)
  // itemsById: id -> { name, category, rarity, family, techLevel(from chosen alt),
  //                      iconUrl, code, stations, alternates (raw; .resolvedId is
  //                      assigned in the later ingredient-resolution pass) }
  const itemsById = new Map();
  const nameToId = new Map(); // family display name -> base id (post-collision)
  const idOrigin = new Map(); // naive id -> { href, code } of first claimant (collision tracking)

  function claimId(naiveId, href, code) {
    if (!idOrigin.has(naiveId)) {
      idOrigin.set(naiveId, { href, code });
      return naiveId;
    }
    const origin = idOrigin.get(naiveId);
    if (origin.href === href) return naiveId; // same family, not a real collision
    // Collision between different items sharing a display name: disambiguate
    // this (later, alphabetically-sorted) one with its internal code.
    const suffix = code ? camelToSnake(code).replace(/[^a-z0-9_]/g, '') : sanitizeIdSuffix(href);
    const disambiguated = `${naiveId}_${suffix}`;
    report.collisions.push({ naiveId, href, code, resolvedTo: disambiguated, firstClaimedBy: origin });
    return disambiguated;
  }

  /** Assign ids for every variant of one family page and register it in itemsById. */
  function registerFamily(href, variants) {
    const sorted = [...variants].sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity));
    const baseVariant = sorted[0];
    const baseNaiveId = slugify(baseVariant.familyName);
    if (!baseNaiveId) {
      report.unparseablePages.push({ slugHint: href, reason: `slugify produced an empty id for name "${baseVariant.familyName}"` });
      return;
    }
    const baseId = claimId(baseNaiveId, href, baseVariant.code);
    const hasFamily = sorted.length > 1;
    nameToId.set(baseVariant.familyName, baseId);

    sorted.forEach((v, idx) => {
      const isBase = idx === 0;
      const naiveId = isBase ? baseNaiveId : `${baseNaiveId}_${v.rarity}`;
      const id = isBase ? baseId : claimId(naiveId, href, v.code);
      const displayName = isBase ? v.familyName : `${v.familyName} (${capitalize(v.rarity)})`;

      itemsById.set(id, {
        id,
        name: displayName,
        category: v.category,
        rarity: v.rarity,
        family: hasFamily ? baseId : undefined,
        iconUrl: v.iconUrl,
        code: v.code,
        stations: v.stations,
        alternates: v.alternates, // resolved below
        familyHref: href,
      });

      report.categoryValues[v.category] = (report.categoryValues[v.category] ?? 0) + 1;
    });
  }

  for (const [href, variants] of rawFamilies) {
    registerFamily(href, variants);
  }

  /** Pull a previously-skipped debug/"not available" variant into itemsById —
   * a real item's recipe still needs it (observed: unreleased "(Ultra)"
   * superboss fragments), so silently dropping the ingredient would be worse
   * than including a flagged-unavailable material. */
  function materializeDebugVariant(name) {
    const entry = debugVariantsByName.get(name);
    if (!entry) return undefined;
    const { href, record } = entry;
    debugVariantsByName.delete(name);
    const existingBaseId = nameToId.get(record.familyName);
    if (existingBaseId) {
      // This family already has real variant(s) registered; add this one as
      // a rarity-suffixed sibling rather than re-deriving a fresh base id.
      const naiveId = `${slugify(record.familyName)}_${record.rarity}`;
      const id = claimId(naiveId, href, record.code);
      itemsById.set(id, {
        id,
        name: `${record.familyName} (${capitalize(record.rarity)})`,
        category: record.category,
        rarity: record.rarity,
        family: existingBaseId,
        iconUrl: record.iconUrl,
        code: record.code,
        stations: record.stations,
        alternates: record.alternates,
        familyHref: href,
      });
      report.categoryValues[record.category] = (report.categoryValues[record.category] ?? 0) + 1;
      return id;
    }
    registerFamily(href, [record]);
    return nameToId.get(record.familyName);
  }

  /** Resolve one ingredient reference to a final item id, trying (in order):
   * the family name map, a direct slugify of its own name, and finally the
   * debug-variant registry. */
  function resolveIngredientId(ing) {
    let resolvedId = nameToId.get(ing.name);
    if (!resolvedId) {
      const candidate = slugify(ing.name);
      if (itemsById.has(candidate)) resolvedId = candidate;
    }
    if (!resolvedId) resolvedId = materializeDebugVariant(ing.name);
    return resolvedId;
  }

  // --- Resolve ingredient name -> id references -----------------------------
  for (const item of itemsById.values()) {
    for (const alt of item.alternates) {
      for (const ing of alt.ingredients) {
        ing.resolvedId = resolveIngredientId(ing);
        if (!ing.resolvedId) {
          report.unresolvedIngredients.push({ item: item.id, ingredient: ing.name, href: ing.href });
        }
      }
    }
  }

  // --- Closure pass: try to fetch any missing ingredient family pages -------
  const missingHrefs = new Set();
  for (const entry of report.unresolvedIngredients) {
    if (entry.href && !rawFamilies.has(entry.href)) missingHrefs.add(entry.href);
  }
  if (missingHrefs.size > 0 && !limitReached) {
    log(`fetch-data: closure pass — fetching ${missingHrefs.size} ingredient pages missed by discovery...`);
    for (const href of missingHrefs) {
      const url = `${BASE}/en/${href}`;
      const html = await fetchPageCached(url, href, report);
      if (!html) continue;
      const { variants, debugVariants } = parseFamilyPage(html, href, report);
      rememberDebugVariants(href, debugVariants);
      if (variants.length === 0) continue;
      rawFamilies.set(href, variants);
      registerFamily(href, variants);
    }
    // re-resolve
    report.unresolvedIngredients = [];
    for (const item of itemsById.values()) {
      for (const alt of item.alternates) {
        for (const ing of alt.ingredients) {
          if (ing.resolvedId && itemsById.has(ing.resolvedId)) continue;
          ing.resolvedId = resolveIngredientId(ing);
          if (!ing.resolvedId) {
            report.unresolvedIngredients.push({ item: item.id, ingredient: ing.name, href: ing.href });
          }
        }
      }
    }
  }

  // --- Phase D/E: stations ---------------------------------------------------
  const stationHrefSet = new Map(); // href -> display name (from recipe links)
  for (const item of itemsById.values()) {
    for (const s of item.stations) stationHrefSet.set(s.href, s.name);
  }
  const stationHrefs = [...stationHrefSet.keys()].sort((a, b) => a.localeCompare(b));
  const stationPageByHref = new Map();
  for (const href of stationHrefs) {
    const url = `${BASE}/en/${href}`;
    const html = await fetchPageCached(url, `station__${href}`, report);
    if (html) stationPageByHref.set(href, html);
    else if (limitReached) break;
  }
  for (const href of stationHrefs) {
    if (!stationPageByHref.has(href)) {
      const file = path.join(PAGES_DIR, `${cacheKeyFor(`station__${href}`)}.html`);
      if (existsSync(file)) stationPageByHref.set(href, readFileSync(file, 'utf8'));
    }
  }
  log(`fetch-data: ${stationPageByHref.size}/${stationHrefs.length} station pages available`);

  const stationsById = new Map();
  const stationNameToId = new Map();
  const stationIdOrigin = new Map();
  function claimStationId(naiveId, href) {
    if (!stationIdOrigin.has(naiveId)) {
      stationIdOrigin.set(naiveId, href);
      return naiveId;
    }
    const origin = stationIdOrigin.get(naiveId);
    if (origin === href) return naiveId;
    const disambiguated = `${naiveId}_${sanitizeIdSuffix(href)}`;
    report.collisions.push({ naiveId, href, resolvedTo: disambiguated, kind: 'station' });
    return disambiguated;
  }
  for (const [href, html] of stationPageByHref) {
    const parsed = parseStationPage(html, `station__${href}`, report);
    if (!parsed) continue;
    const naiveId = slugify(parsed.name);
    const id = claimStationId(naiveId, href);
    stationsById.set(id, { id, name: parsed.name, iconUrl: parsed.iconUrl, techLevel: parsed.techLevel });
    stationNameToId.set(href, id);
  }
  // remap each item's station hrefs -> station ids
  for (const item of itemsById.values()) {
    item.stationIds = item.stations.map((s) => stationNameToId.get(s.href)).filter(Boolean);
  }

  // --- Resolve multi-recipe alternates to a single primary ------------------
  const memo = new Map();
  for (const item of itemsById.values()) {
    if (item.alternates.length <= 1) continue;
    const costs = item.alternates.map((alt) => {
      let cost = 0;
      for (const ing of alt.ingredients) {
        if (!ing.resolvedId) return Infinity;
        cost += ing.qty * computeRawCost(ing.resolvedId, itemsById, memo, new Set([item.id]));
      }
      return cost;
    });
    let bestIdx = 0;
    for (let i = 1; i < costs.length; i++) if (costs[i] < costs[bestIdx]) bestIdx = i;
    item.alternates.forEach((alt, i) => {
      if (i === bestIdx) return;
      report.droppedAlternates.push({
        item: item.id,
        name: item.name,
        kept: item.alternates[bestIdx].ingredients.map((x) => `${x.qty}x ${x.name}`).join(' + '),
        dropped: alt.ingredients.map((x) => `${x.qty}x ${x.name}`).join(' + '),
        keptRawCost: costs[bestIdx],
        droppedRawCost: costs[i],
      });
    });
    item.primaryAlternateIdx = bestIdx;
  }
  for (const item of itemsById.values()) {
    if (item.primaryAlternateIdx === undefined) item.primaryAlternateIdx = 0;
  }

  // --- Icon filename assignment (dedupe within a family) --------------------
  // familyHref -> { url, filename }
  const familyIconAssignment = new Map();
  for (const item of itemsById.values()) {
    if (!item.iconUrl) continue;
    const key = item.family ?? item.id;
    if (!familyIconAssignment.has(key)) {
      familyIconAssignment.set(key, { url: item.iconUrl, filename: `${key}.webp` });
    }
    const assignment = familyIconAssignment.get(key);
    item.iconFilename = assignment.url === item.iconUrl ? assignment.filename : `${item.id}.webp`;
  }
  for (const station of stationsById.values()) {
    station.iconFilename = `station_${station.id}.webp`;
  }

  // --- Build final items.json / stations.json shape -------------------------
  // Field names are the game-neutral schema v2 (PLAN.md §9): rarity -> tier,
  // techLevel -> progression, family -> variantGroup. Palworld's own
  // vocabulary (rarity/techLevel/family) stays as the internal variable names
  // above since that's paldb.cc's own domain language for the scrape — only
  // the emitted JSON shape is renamed here.
  const finalItems = {};
  for (const item of itemsById.values()) {
    const entry = {
      name: item.name,
      icon: `icons/${item.iconFilename ?? `${item.id}.webp`}`,
      category: item.category,
      tier: item.rarity,
    };
    if (item.family) entry.variantGroup = item.family;
    const primary = item.alternates[item.primaryAlternateIdx];
    if (primary && primary.techLevel !== undefined) entry.progression = primary.techLevel;
    if (primary && primary.ingredients.length > 0) {
      entry.recipe = {
        stations: item.stationIds ?? [],
        yields: primary.yields ?? 1,
        ingredients: primary.ingredients
          .filter((ing) => ing.resolvedId)
          .map((ing) => ({ item: ing.resolvedId, qty: ing.qty })),
      };
    }
    finalItems[item.id] = entry;
  }

  const finalStations = {};
  for (const station of stationsById.values()) {
    const entry = { name: station.name, icon: `icons/${station.iconFilename}` };
    if (station.techLevel !== undefined) entry.progression = station.techLevel;
    finalStations[station.id] = entry;
  }

  // --- Internal validation (mirrors scripts/validate-data.mjs) --------------
  const validationErrors = [];
  for (const [id, item] of Object.entries(finalItems)) {
    if (!item.recipe) continue;
    for (const stationId of item.recipe.stations) {
      if (!(stationId in finalStations)) {
        validationErrors.push(`item "${id}": recipe references unknown station "${stationId}"`);
      }
    }
    for (const ing of item.recipe.ingredients) {
      if (!(ing.item in finalItems)) {
        validationErrors.push(`item "${id}": recipe references unknown ingredient "${ing.item}"`);
      }
    }
  }

  // --- Icon downloads ---------------------------------------------------------
  const urlToLocalName = new Map(); // icon URL -> already-downloaded cache path
  // Returns 'present' (already existed), 'written' (fetched/copied this run), or false (failed).
  async function ensureIconDownloaded(url, publicFilename) {
    const publicPath = path.join(PUBLIC_ICONS_DIR, publicFilename);
    if (existsSync(publicPath)) return 'present';
    let cachePath = urlToLocalName.get(url);
    if (!cachePath) {
      cachePath = await fetchIconCached(url, report);
      if (cachePath) urlToLocalName.set(url, cachePath);
    }
    if (!cachePath) return false;
    writeFileSync(publicPath, readFileSync(cachePath));
    return 'written';
  }

  let iconsPresent = 0;
  let iconsWritten = 0;
  let iconsMissing = 0;
  const seenPublicFilenames = new Set();
  for (const item of itemsById.values()) {
    if (!item.iconUrl) continue;
    const filename = item.iconFilename ?? `${item.id}.webp`;
    if (seenPublicFilenames.has(filename)) continue;
    seenPublicFilenames.add(filename);
    const result = await ensureIconDownloaded(item.iconUrl, filename);
    if (result === 'present') iconsPresent++;
    else if (result === 'written') iconsWritten++;
    else iconsMissing++;
  }
  for (const station of stationsById.values()) {
    if (!station.iconUrl) continue;
    const filename = station.iconFilename;
    if (seenPublicFilenames.has(filename)) continue;
    seenPublicFilenames.add(filename);
    const result = await ensureIconDownloaded(station.iconUrl, filename);
    if (result === 'present') iconsPresent++;
    else if (result === 'written') iconsWritten++;
    else iconsMissing++;
  }

  // --- Write outputs -----------------------------------------------------------
  const itemsDoc = { schemaVersion: 2, gameVersion, items: finalItems };
  writeFileSync(ITEMS_OUT, JSON.stringify(itemsDoc, null, 2) + '\n', 'utf8');
  writeFileSync(STATIONS_OUT, JSON.stringify(finalStations, null, 2) + '\n', 'utf8');

  const craftableCount = Object.values(finalItems).filter((i) => i.recipe).length;
  const variantCount = Object.values(finalItems).filter((i) => i.variantGroup).length;

  report.finishedAt = new Date().toISOString();
  report.gameVersion = gameVersion;
  report.counts = {
    discoveredFamilies: hrefs.length,
    familiesParsed: rawFamilies.size,
    items: Object.keys(finalItems).length,
    craftable: craftableCount,
    variants: variantCount,
    stations: Object.keys(finalStations).length,
    icons: iconsPresent + iconsWritten,
    iconsWrittenThisRun: iconsWritten,
    iconsAlreadyPresent: iconsPresent,
    iconsMissing,
  };
  report.validationErrors = validationErrors;
  report.partial = report.partial || limitReached || pageHtmlByHref.size < hrefs.length || stationPageByHref.size < stationHrefs.length;
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  log('');
  log(`fetch-data: ${report.partial ? 'PARTIAL' : 'COMPLETE'} run summary`);
  log(`  items: ${report.counts.items} (craftable ${craftableCount}, variants ${variantCount})`);
  log(`  stations: ${report.counts.stations}`);
  log(`  icons: ${report.counts.icons} total (${iconsWritten} written this run, ${iconsPresent} already present), missing: ${iconsMissing}`);
  log(`  category values: ${JSON.stringify(report.categoryValues)}`);
  log(`  dropped alternate recipes: ${report.droppedAlternates.length}`);
  log(`  id collisions resolved: ${report.collisions.length}`);
  log(`  unparseable pages: ${report.unparseablePages.length}`);
  log(`  unresolved ingredient refs: ${report.unresolvedIngredients.length}`);
  log(`  failed page fetches: ${report.failedPages.length}, failed icon fetches: ${report.failedIcons.length}`);
  if (validationErrors.length > 0) {
    log(`  VALIDATION ERRORS: ${validationErrors.length} (see ${REPORT_OUT})`);
    if (!report.partial) {
      log('  Hard error: complete run produced unresolved references. See report.');
      process.exitCode = 1;
    }
  }
  log(`  report written to ${REPORT_OUT}`);
}

main().catch((err) => {
  console.error('fetch-data: FATAL', err);
  process.exit(1);
});
