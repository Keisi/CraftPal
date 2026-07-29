#!/usr/bin/env node
// CraftPal's Minecraft data pipeline — PLAN.md §9's real second-game test.
// Pulls vanilla Minecraft's OWN datamined recipe/tag/lang/registry summary
// from misode/mcmeta (a mirror of the game's own data files, not a wiki
// scrape) and emits src/data/minecraft/{game,items,stations}.json plus
// public/games/minecraft/icons/<id>.png. This is the per-game adapter
// (PLAN.md §9: "the scraper is the per-game adapter") — Palworld's
// scripts/fetch-data.mjs is the house style this mirrors (throttled, cached,
// resumable, --limit=N, --verbose, tripwires, a final report).
//
// Usage:
//   node scripts/fetch-minecraft.mjs [--limit=N] [--verbose]
//
// --limit=N caps the number of NEW icon fetches issued in this invocation
//   (already-cached icons don't count). The 4 structured sources (recipes,
//   tags, lang, registries — one request each) are always fetched in full
//   regardless of --limit; only per-item icon downloads are throttled/capped,
//   mirroring fetch-map.mjs's tile-phase convention. Re-run to resume —
//   everything is cached in scripts/.cache/minecraft/.
//
// Sources (all misode/mcmeta, verified live before this script was written):
//   recipes    https://raw.githubusercontent.com/misode/mcmeta/summary/data/recipe/data.min.json
//              1,978 recipes as of 2026-07-27 (see EXPECTED_RECIPE_COUNT below).
//   tags       https://raw.githubusercontent.com/misode/mcmeta/summary/data/tag/item/data.min.json
//   lang       https://raw.githubusercontent.com/misode/mcmeta/assets-json/assets/minecraft/lang/en_us.json
//   registries https://raw.githubusercontent.com/misode/mcmeta/summary/registries/data.min.json
//   version    https://raw.githubusercontent.com/misode/mcmeta/summary/version.json
//   icons      https://raw.githubusercontent.com/misode/mcmeta/assets/assets/minecraft/textures/{item,block}/<id>[_front|_top|_side].png
//
// ---------------------------------------------------------------------------
// Recipe-type decisions (fixed, verified against real data before writing
// this parser — see the counts logged at the end of a run):
//
//   type -> station (PLAN.md §9's Minecraft-adapter decisions):
//     crafting_shaped / crafting_shapeless / crafting_transmute /
//       crafting_dye                -> crafting_table
//     smelting                      -> furnace
//     blasting                      -> blast_furnace
//     smoking                       -> smoker
//     campfire_cooking              -> campfire
//     stonecutting                  -> stonecutter
//     smithing_transform            -> smithing_table
//     brewing                       -> brewing_stand
//
//   SKIPPED entirely (code-driven, no static ingredient list — emitting one
//   would be fiction): every crafting_special_*, crafting_decorated_pot,
//   crafting_imbue, and smithing_trim. Counted and reported below.
//
//   Ingredient quantities: a crafting_shaped recipe's pattern repeats a key
//   symbol — count occurrences across all pattern rows (ignoring the ' '
//   filler) to get qty. crafting_shapeless lists ingredients individually —
//   duplicates aggregate into a qty. Both funnel through the same
//   ingredientsMap-aggregation helper.
//
//   Tags (#minecraft:foo) resolve to their member item ids, recursively
//   (tags can reference other tags), with a cycle guard. A raw JSON array in
//   an ingredient/key/ingredient-field position (e.g. smelting's `ingredient`
//   is sometimes an array of alternative items, not a tag) is resolved by
//   the exact same rule, since it's the same "one of several acceptable
//   items" shape a tag is — this is an extension of the tag rule to a second
//   real shape found in the data, not a separate invention.
//   Single-member -> use it. Multi-member -> pick the item with the LOWEST
//   index in the registries.item array (i.e. first in the authoritative item
//   registry's own order) as the deterministic representative; every other
//   member is logged as a dropped alternate in the run report (mirrors
//   PLAN.md §1's existing "log every alternate it drops" convention for
//   Palworld's multi-recipe items). A #tag string is never emitted as an
//   item id — only resolved, concrete item ids reach items.json.
//
//   Schema v3 axis 1 ("any of a set" — PLAN.md §1 decision 3, CLAUDE.md
//   "Known schema limit"): the multi-member case above no longer just picks a
//   representative and drops the rest silently. Every ingredient resolved
//   from 2+ candidates ALSO carries `anyOf` (every id that was in play,
//   deterministically sorted) on top of `item` (still the sole representative
//   tree.js/plan.js math follows — this is purely additive, no schemaVersion
//   bump). When the slot came from a NAMED tag it also carries `anyOfLabel`
//   (deriveTagLabel() below); a bare alternatives array has no name to derive
//   one from, so it ships with no label and the UI falls back to a count.
//

//   yields = result.count ?? 1 (brewing/smithing_transform/crafting_dye/
//   crafting_transmute never carry a result count in practice -> yields 1).
//
//   Multiple DISTINCT RECIPES can target the same result item (e.g. iron
//   ingot: 3 ores × {smelting, blasting}, an "uncraft 1 iron_block -> 9
//   iron_ingot" recipe, and a "combine 9 iron_nugget" recipe) — schema v3
//   axis 2 (PLAN.md §1 decision 1/2) keeps EVERY one of them as an entry in
//   that result's `recipes[]`, ordered cheapest-total-raw-ingredient-cost
//   first (recursive, memoized, a cycle scores Infinity so it never sorts
//   ahead of a real alternative), computed only when an item has 2+
//   candidate recipes (a single candidate is used as-is, no cost
//   computation, exactly like Palworld). `recipes[0]` is exactly the same
//   primary a pre-axis-2 scrape would have chosen as its single `recipe` —
//   ties (including ties at Infinity) keep whichever candidate was
//   encountered FIRST when iterating the fetched recipes.json in its own
//   (file) key order, via a stable sort — deterministic given a fixed input
//   file, documented here rather than re-derived. This is what an item
//   craftable at BOTH a crafting table and a stonecutter now looks like:
//   two `recipes[]` entries, each with its own single-station `stations`.
//
//   Ids: strip the "minecraft:" namespace, keep native snake_case
//   (diamond_pickaxe) — these are the stable ids for this game, unlike
//   Palworld's kebab-case-from-paldb-code convention.
//
//   Names: item.minecraft.<id>, falling back to block.minecraft.<id> (many
//   block-items, e.g. TNT/crafting_table/furnace, are ONLY under the block
//   key). Anything resolving under neither falls back to a title-cased id
//   and is reported (never left blank).
//
//   Icons: try textures/item/<id>.png, then textures/block/<id>.png (per the
//   task decision) — BUT most of Minecraft's "furniture" blocks (crafting
//   table, furnace, blast furnace, smoker, stonecutter, smithing table — 6 of
//   this game's 8 stations) have NO flat block texture at all; they're
//   assembled from separate _top/_front/_side face textures with no single
//   representative file. Verified live (2026-07-27): block/crafting_table.png
//   and block/furnace.png both 404, while block/crafting_table_front.png and
//   block/furnace_front.png are real. So this scraper adds two more fallback
//   tiers beyond the task's literal 2-tier instruction — block/<id>_front.png,
//   then block/<id>_top.png, then block/<id>_side.png — a small, disclosed
//   deviation (see the run report / task write-up), not a silent one. Even
//   with all 5 tiers, a handful of items have NO representative texture at
//   all (entity-rendered blocks like chests/beds/campfire, whose real
//   textures live under textures/entity/... in bespoke per-part atlases this
//   script does not chase) — those ship with no `icon` field, reported by
//   name/count at the end of the run, exactly as the task asks.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CACHE_DIR = path.join(ROOT, 'scripts', '.cache', 'minecraft');
const ICONS_CACHE_DIR = path.join(CACHE_DIR, 'icons');
const GAME_DATA_DIR = path.join(ROOT, 'src', 'data', 'minecraft');
const PUBLIC_ICONS_DIR = path.join(ROOT, 'public', 'games', 'minecraft', 'icons');
const ITEMS_OUT = path.join(GAME_DATA_DIR, 'items.json');
const STATIONS_OUT = path.join(GAME_DATA_DIR, 'stations.json');
const REPORT_OUT = path.join(CACHE_DIR, 'fetch-minecraft-report.json');
// Persisted NEGATIVE icon-resolution cache — ids CONFIRMED (all 5 tiers
// exhausted, in a non-partial run) to have no representative texture at all.
// Never written to for an id --limit merely left unattempted (see the icon
// section below); only real, fully-checked misses land here, so trusting it
// on a later run can never mask an id that just wasn't tried yet.
const NO_ICON_CACHE_FILE = path.join(CACHE_DIR, 'no-icon.json');

const RAW_BASE = 'https://raw.githubusercontent.com/misode/mcmeta';
const RECIPES_URL = `${RAW_BASE}/summary/data/recipe/data.min.json`;
const TAGS_URL = `${RAW_BASE}/summary/data/tag/item/data.min.json`;
const LANG_URL = `${RAW_BASE}/assets-json/assets/minecraft/lang/en_us.json`;
const REGISTRIES_URL = `${RAW_BASE}/summary/registries/data.min.json`;
const VERSION_URL = `${RAW_BASE}/summary/version.json`;
const ITEM_TEX_BASE = `${RAW_BASE}/assets/assets/minecraft/textures/item`;
const BLOCK_TEX_BASE = `${RAW_BASE}/assets/assets/minecraft/textures/block`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// GitHub's raw-content CDN is far more tolerant than paldb.cc (no observed
// 403s on bare requests) — a lighter throttle than the paldb scrapers'
// 300-500ms is deliberate, not an oversight.
const MIN_INTERVAL_MS = 120;

// Tripwire: hard-error if the fetched recipe count collapses relative to the
// real value observed 2026-07-27 (1,978) — catches a truncated fetch or an
// upstream format change rather than silently shipping a partial dataset.
const EXPECTED_RECIPE_COUNT = 1978;
const MIN_RECIPE_COUNT = Math.floor(EXPECTED_RECIPE_COUNT * 0.9);

// Tripwire: hard-error if icon coverage collapses relative to the real value
// observed 2026-07-28 (1,182/1,610 items resolve an icon; the rest are the
// documented ~27% with no representative texture at all). Added after a real
// regression: a --limit run in a worktree with a cold scripts/.cache/ but a
// fully-populated public/ dir dropped this to 11 and validate-data.mjs's
// `optional` icon flag didn't catch it (see the icon-resolution section for
// the full story and the fix). Only asserted when the run had a genuine
// chance to observe the whole registry — see `iconFloorApplies` below.
const EXPECTED_ICON_COUNT = 1182;
const MIN_ICON_COUNT = Math.floor(EXPECTED_ICON_COUNT * 0.9);

const RECIPE_TYPE_STATION = {
  'minecraft:crafting_shaped': 'crafting_table',
  'minecraft:crafting_shapeless': 'crafting_table',
  'minecraft:crafting_transmute': 'crafting_table',
  'minecraft:crafting_dye': 'crafting_table',
  'minecraft:smelting': 'furnace',
  'minecraft:blasting': 'blast_furnace',
  'minecraft:smoking': 'smoker',
  'minecraft:campfire_cooking': 'campfire',
  'minecraft:stonecutting': 'stonecutter',
  'minecraft:smithing_transform': 'smithing_table',
  'minecraft:brewing': 'brewing_stand',
};
const STATION_IDS = [...new Set(Object.values(RECIPE_TYPE_STATION))];

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
function stripNs(id) {
  return String(id).replace(/^minecraft:/, '');
}
function titleCase(id) {
  return String(id)
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
function capitalizeWord(w) {
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
}

// ---------------------------------------------------------------------------
// schema v3 axis 1 ("any of a set" ingredients — PLAN.md §1 decision 3, CLAUDE.md
// "Known schema limit"). A recipe slot keyed on a multi-member tag or a raw
// alternatives array no longer collapses silently to its representative: the
// representative stays authoritative (tree.js/plan.js math is untouched — see
// decision 1) but the slot also carries `anyOf` (every id that was in play,
// deterministically sorted) and, when the slot came from a NAMED tag,
// `anyOfLabel` (a human label derived from the tag — a bare alternatives array
// has no name to derive one from, so it gets no label, only a count in the UI).
// ---------------------------------------------------------------------------

// Naive plural -> singular for one ASCII snake_case tag segment. Deliberately
// simple (no inflection library) — every result is VALIDATED against a real
// resolved item's own display name before use (see deriveTagLabel), so a wrong
// guess here just fails validation and falls back to the tag's verbatim word
// instead of shipping something wrong.
function naiveSingularize(word) {
  if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith('xes') || word.endsWith('ses') || word.endsWith('ches') || word.endsWith('shes')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Derive anyOfLabel from a resolved tag's own name plus the display name of
 * the representative item chosen for it (decision 3: "#minecraft:logs" ->
 * "Log", "#minecraft:planks" -> "Planks" — both from this ONE code path, no
 * per-tag special-casing). Tag names are almost always the plural of the
 * concept they group, but Minecraft's own item names are sometimes ALREADY
 * plural with no singular counterpart ("Planks" is the item name — there is
 * no "Plank" item) — so a blind singularization rule gets "planks" wrong.
 * Instead: try the naive singular of the tag's last underscore segment, and
 * only use it if it actually matches the last word of a REAL resolved item's
 * display name; otherwise keep the tag's own word verbatim. Grounding the
 * choice in real data (rather than trusting either inflection blindly) is
 * what makes both examples above come out right from the same code.
 * Always returns a non-empty string.
 */
function deriveTagLabel(tagName, representativeName) {
  const words = tagName.split('_').filter(Boolean);
  const last = words[words.length - 1] ?? tagName;
  const prefix = words.slice(0, -1);
  const repWords = String(representativeName).trim().split(/\s+/).filter(Boolean);
  const repLastWord = repWords[repWords.length - 1] ?? '';
  const singularLast = naiveSingularize(last);
  const finalLast =
    singularLast.toLowerCase() === repLastWord.toLowerCase() ? capitalizeWord(singularLast) : capitalizeWord(last);
  return [...prefix.map(capitalizeWord), finalLast].join(' ');
}

/**
 * Merge one ingredient occurrence into a recipe's ingredientsMap (itemId ->
 * {qty, anyOf, anyOfLabel}). If the same itemId is hit twice within one
 * recipe (e.g. two pattern symbols resolving to the same representative), qty
 * accumulates and the FIRST occurrence's anyOf/anyOfLabel wins — deterministic
 * given the fixed key-iteration order already used everywhere else in this
 * file, and a rare case (two different tags collapsing onto the same
 * representative within a single recipe).
 */
function addIngredient(ingredientsMap, itemId, qtyDelta, resolved) {
  const existing = ingredientsMap.get(itemId);
  if (existing) {
    existing.qty += qtyDelta;
    return;
  }
  ingredientsMap.set(itemId, { qty: qtyDelta, anyOf: resolved?.anyOf, anyOfLabel: resolved?.anyOfLabel });
}

// ---------------------------------------------------------------------------
// Throttled, cached HTTP (mirrors fetch-data.mjs/fetch-map.mjs house style)
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
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch a structured JSON source, cached, NOT subject to --limit (only icon
 * downloads are throttled/capped — these 5 requests are the backbone of the
 * whole run and always fetched in full). */
async function fetchJsonSource(url, cacheFile, label, report) {
  if (existsSync(cacheFile)) {
    vlog(`  [cache] ${label}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }
  await throttle();
  newFetchCount++;
  vlog(`  [fetch] ${label}: ${url}`);
  let result = await rawFetch(url);
  if (!result.ok && (result.status === 403 || result.status === 429 || result.status === 0)) {
    await sleep(2000);
    result = await rawFetch(url);
  }
  if (!result.ok) {
    report.failedSources.push({ label, url, status: result.status, error: result.error });
    return null;
  }
  ensureDir(path.dirname(cacheFile));
  writeFileSync(cacheFile, result.body, 'utf8');
  return JSON.parse(result.body);
}

/** Fetch one icon candidate (binary), cached under scripts/.cache/minecraft/icons/,
 * subject to --limit. Returns bytes or null (miss/limit — caller tries the
 * next fallback tier). */
async function fetchIconCandidate(url, cacheFile, report) {
  if (existsSync(cacheFile)) {
    vlog(`  [cache-icon] ${path.basename(cacheFile)}`);
    return readFileSync(cacheFile);
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
    await sleep(1500);
    result = await rawFetch(url, { binary: true });
  }
  if (!result.ok) {
    if (result.status !== 404) report.iconFetchErrors.push({ url, status: result.status, error: result.error });
    return null;
  }
  ensureDir(path.dirname(cacheFile));
  writeFileSync(cacheFile, result.body);
  return result.body;
}

// ---------------------------------------------------------------------------
// Tag resolution (recursive, cycle-guarded) + the shared "pick a deterministic
// representative among several acceptable items" rule used for BOTH tag
// members and raw ingredient-alternative arrays.
// ---------------------------------------------------------------------------
function makeResolver(tagsDoc, registryOrder, report, resolveName) {
  const registryIndex = new Map(registryOrder.map((id, i) => [id, i]));
  const tagMemberCache = new Map(); // tagName -> Set<itemId>

  function resolveTagMembers(tagName, visiting) {
    if (tagMemberCache.has(tagName)) return tagMemberCache.get(tagName);
    if (visiting.has(tagName)) {
      report.tagCycles.push([...visiting, tagName].join(' -> '));
      return new Set();
    }
    const def = tagsDoc[tagName];
    if (!def) {
      report.unknownTags.push(tagName);
      tagMemberCache.set(tagName, new Set());
      return new Set();
    }
    visiting.add(tagName);
    const members = new Set();
    for (const value of def.values ?? []) {
      if (typeof value === 'string' && value.startsWith('#')) {
        for (const m of resolveTagMembers(stripNs(value.slice(1)), visiting)) members.add(m);
      } else {
        members.add(stripNs(value));
      }
    }
    visiting.delete(tagName);
    tagMemberCache.set(tagName, members);
    return members;
  }

  function candidatesForSingle(ref) {
    if (typeof ref !== 'string') return [];
    if (ref.startsWith('#')) return [...resolveTagMembers(stripNs(ref.slice(1)), new Set())];
    return [stripNs(ref)];
  }

  /**
   * Resolve a recipe-side reference — a plain item string, a "#tag" string,
   * or a raw array of alternative item/tag strings — to one deterministic
   * item id plus every alternate that was in play (chosen first).
   * Multi-candidate resolutions are logged to report.multiMemberResolutions,
   * and now (schema v3 axis 1) also carry `anyOf` (every id in play,
   * deterministically sorted — independent of the registry-order sort above
   * that only decides the representative) and, when the ref was a NAMED tag
   * (not a bare array), `anyOfLabel`.
   */
  function resolveRef(ref, context) {
    if (ref === undefined || ref === null) return { chosen: null, alternates: [], anyOf: undefined, anyOfLabel: undefined };
    let tagName = null;
    let raw;
    if (Array.isArray(ref)) {
      raw = ref.flatMap(candidatesForSingle);
    } else if (typeof ref === 'string' && ref.startsWith('#')) {
      tagName = stripNs(ref.slice(1));
      raw = candidatesForSingle(ref);
    } else {
      raw = candidatesForSingle(ref);
    }
    const distinct = [...new Set(raw)];
    distinct.sort((a, b) => {
      const ai = registryIndex.get(a) ?? Infinity;
      const bi = registryIndex.get(b) ?? Infinity;
      return ai - bi || a.localeCompare(b);
    });
    const chosen = distinct[0] ?? null;
    let anyOf;
    let anyOfLabel;
    if (distinct.length > 1) {
      // Plain lexicographic — the UI-facing anyOf list, not the pick order.
      anyOf = [...distinct].sort((a, b) => a.localeCompare(b));
      if (tagName && chosen) {
        anyOfLabel = deriveTagLabel(tagName, resolveName(chosen) ?? titleCase(chosen));
      }
      report.multiMemberResolutions.push({ context, tagName, chosen, dropped: distinct.slice(1), anyOfLabel });
    }
    return { chosen, alternates: distinct, anyOf, anyOfLabel };
  }

  return { resolveRef };
}

// ---------------------------------------------------------------------------
// Per-recipe-type ingredient extraction. Returns
// { ingredientsMap: Map<itemId, qty>, yields, category, resultId } or null
// (unparseable/unresolved — logged to report.unresolvedRecipes and the whole
// recipe is skipped rather than guessed at).
// ---------------------------------------------------------------------------
function extractRecipe(recipeId, r, resolveRef, report) {
  const type = r.type;

  function fail(reason) {
    report.unresolvedRecipes.push({ recipeId, type, reason });
    return null;
  }

  if (type === 'minecraft:crafting_shaped') {
    const counts = new Map();
    for (const row of r.pattern ?? []) {
      for (const ch of row) {
        if (ch === ' ') continue;
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const ingredientsMap = new Map();
    for (const [symbol, count] of counts) {
      const ref = r.key?.[symbol];
      if (ref === undefined) return fail(`pattern symbol "${symbol}" missing from key`);
      const resolved = resolveRef(ref, `${recipeId}.key.${symbol}`);
      if (!resolved.chosen) return fail(`key symbol "${symbol}" (${JSON.stringify(ref)}) did not resolve`);
      addIngredient(ingredientsMap, resolved.chosen, count, resolved);
    }
    if (ingredientsMap.size === 0) return fail('no ingredients parsed');
    return { ingredientsMap, yields: r.result?.count ?? 1, category: r.category, resultId: stripNs(r.result.id) };
  }

  if (type === 'minecraft:crafting_shapeless') {
    const ingredientsMap = new Map();
    for (const ing of r.ingredients ?? []) {
      const resolved = resolveRef(ing, `${recipeId}.ingredients[]`);
      if (!resolved.chosen) return fail(`ingredient (${JSON.stringify(ing)}) did not resolve`);
      addIngredient(ingredientsMap, resolved.chosen, 1, resolved);
    }
    if (ingredientsMap.size === 0) return fail('no ingredients parsed');
    return { ingredientsMap, yields: r.result?.count ?? 1, category: r.category, resultId: stripNs(r.result.id) };
  }

  if (
    type === 'minecraft:stonecutting' ||
    type === 'minecraft:smelting' ||
    type === 'minecraft:blasting' ||
    type === 'minecraft:smoking' ||
    type === 'minecraft:campfire_cooking'
  ) {
    const resolved = resolveRef(r.ingredient, `${recipeId}.ingredient`);
    if (!resolved.chosen) return fail(`ingredient (${JSON.stringify(r.ingredient)}) did not resolve`);
    const ingredientsMap = new Map();
    addIngredient(ingredientsMap, resolved.chosen, 1, resolved);
    return {
      ingredientsMap,
      yields: r.result?.count ?? 1,
      category: r.category,
      resultId: stripNs(r.result.id),
    };
  }

  if (type === 'minecraft:smithing_transform') {
    const ingredientsMap = new Map();
    for (const [field, ref] of [
      ['base', r.base],
      ['addition', r.addition],
      ['template', r.template],
    ]) {
      const resolved = resolveRef(ref, `${recipeId}.${field}`);
      if (!resolved.chosen) return fail(`${field} (${JSON.stringify(ref)}) did not resolve`);
      addIngredient(ingredientsMap, resolved.chosen, 1, resolved);
    }
    return { ingredientsMap, yields: 1, category: undefined, resultId: stripNs(r.result.id) };
  }

  if (type === 'minecraft:crafting_transmute') {
    const ingredientsMap = new Map();
    const input = resolveRef(r.input, `${recipeId}.input`);
    if (!input.chosen) return fail(`input (${JSON.stringify(r.input)}) did not resolve`);
    addIngredient(ingredientsMap, input.chosen, 1, input);
    const material = resolveRef(r.material, `${recipeId}.material`);
    if (!material.chosen) return fail(`material (${JSON.stringify(r.material)}) did not resolve`);
    // material_count is a {min,max} RANGE on exactly one recipe (map_cloning,
    // "add up to 8 empty maps") — our static schema has no room for a range,
    // so it collapses to the minimum (a documented simplification, not a bug).
    const materialQty = r.material_count?.min ?? 1;
    addIngredient(ingredientsMap, material.chosen, materialQty, material);
    return { ingredientsMap, yields: r.result?.count ?? 1, category: r.category, resultId: stripNs(r.result.id) };
  }

  if (type === 'minecraft:crafting_dye') {
    const ingredientsMap = new Map();
    const dye = resolveRef(r.dye, `${recipeId}.dye`);
    if (!dye.chosen) return fail(`dye (${JSON.stringify(r.dye)}) did not resolve`);
    addIngredient(ingredientsMap, dye.chosen, 1, dye);
    const target = resolveRef(r.target, `${recipeId}.target`);
    if (!target.chosen) return fail(`target (${JSON.stringify(r.target)}) did not resolve`);
    addIngredient(ingredientsMap, target.chosen, 1, target);
    return { ingredientsMap, yields: 1, category: undefined, resultId: stripNs(r.result.id) };
  }

  if (type === 'minecraft:brewing') {
    // Brewing has no `result` field — its target is `output.id`, and its
    // `input`/`reagent` are always plain (never tag/array) item refs. NOTE:
    // this game's flat item-id schema can't represent potion *effects*
    // (component data, e.g. "awkward" vs "strength") — every potion/
    // splash_potion/lingering_potion brewing recipe therefore has an `input`
    // that is THE SAME item id as its own result (only the untracked potion
    // effect differs). That makes ~189/279 brewing recipes literally
    // self-referential in this schema. This is disclosed, not hidden: it
    // means a Potion node's tree includes a "Potion" child that
    // tree.js's existing cycle guard immediately terminates as a leaf — safe
    // (proven not to hang), if not a meaningful ingredient breakdown. See the
    // task write-up for the live-verified example.
    if (typeof r.input?.item !== 'string' || typeof r.reagent?.item !== 'string' || !r.output?.id) {
      return fail('unexpected brewing recipe shape');
    }
    const inputId = stripNs(r.input.item);
    const reagentId = stripNs(r.reagent.item);
    const ingredientsMap = new Map();
    addIngredient(ingredientsMap, inputId, 1, null); // never a tag/array -> never anyOf
    addIngredient(ingredientsMap, reagentId, 1, null);
    return { ingredientsMap, yields: 1, category: undefined, resultId: stripNs(r.output.id) };
  }

  return fail(`unhandled kept type "${type}" (should be unreachable — every kept type has a branch above)`);
}

// ---------------------------------------------------------------------------
// Primary-recipe selection among 2+ candidates targeting the same result item
// — mirrors fetch-data.mjs's computeRawCost exactly (cheapest total raw cost,
// memoized, a cycle scores Infinity so a real alternative always wins over
// an "uncraft this block back into its ingredients" loop when one exists).
// ---------------------------------------------------------------------------
function computeRawCost(itemId, candidatesByResult, memo, visiting) {
  if (memo.has(itemId)) return memo.get(itemId);
  if (visiting.has(itemId)) return Infinity;
  const candidates = candidatesByResult.get(itemId);
  if (!candidates || candidates.length === 0) {
    memo.set(itemId, 1); // raw material / unknown-as-craftable leaf
    return 1;
  }
  visiting.add(itemId);
  let best = Infinity;
  for (const cand of candidates) {
    let cost = 0;
    for (const [ingId, { qty }] of cand.ingredientsMap) {
      cost += qty * computeRawCost(ingId, candidatesByResult, memo, visiting);
    }
    if (cost < best) best = cost;
  }
  visiting.delete(itemId);
  memo.set(itemId, best);
  return best;
}

// ---------------------------------------------------------------------------
// Icon resolution: try item texture, then block texture, then the two extra
// disclosed fallback tiers for multi-face "furniture" blocks (see the module
// comment). Returns { bytes, tier } or null.
// ---------------------------------------------------------------------------
async function resolveIconBytes(id, report) {
  const attempts = [
    [`${ITEM_TEX_BASE}/${id}.png`, 'item'],
    [`${BLOCK_TEX_BASE}/${id}.png`, 'block'],
    [`${BLOCK_TEX_BASE}/${id}_front.png`, 'block_front'],
    [`${BLOCK_TEX_BASE}/${id}_top.png`, 'block_top'],
    [`${BLOCK_TEX_BASE}/${id}_side.png`, 'block_side'],
  ];
  const cacheFile = path.join(ICONS_CACHE_DIR, `${id}.png`);
  for (const [url, tier] of attempts) {
    const bytes = await fetchIconCandidate(url, cacheFile, report);
    if (bytes) return { bytes, tier };
    if (limitReached) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  ensureDir(CACHE_DIR);
  ensureDir(ICONS_CACHE_DIR);
  ensureDir(GAME_DATA_DIR);
  ensureDir(PUBLIC_ICONS_DIR);

  const report = {
    startedAt: new Date().toISOString(),
    limit: LIMIT === Infinity ? null : LIMIT,
    failedSources: [],
    iconFetchErrors: [],
    tagCycles: [],
    unknownTags: [],
    multiMemberResolutions: [],
    unresolvedRecipes: [],
    // schema v3 axis 2: nothing is dropped anymore (every candidate ships as
    // a recipes[] entry) — this now lists result items that GAINED
    // visibility into 2+ recipes, for visibility into what changed vs. a
    // pre-axis-2 scrape.
    multiRecipeItems: [],
    itemsNoName: [],
    itemsNoIcon: [],
    counts: {},
    partial: false,
  };

  log('fetch-minecraft: fetching structured sources (recipes, tags, lang, registries, version)...');
  const recipesDoc = await fetchJsonSource(RECIPES_URL, path.join(CACHE_DIR, 'recipes.json'), 'recipes', report);
  const tagsDoc = await fetchJsonSource(TAGS_URL, path.join(CACHE_DIR, 'tags.json'), 'tags', report);
  const langDoc = await fetchJsonSource(LANG_URL, path.join(CACHE_DIR, 'lang.json'), 'lang', report);
  const registriesDoc = await fetchJsonSource(
    REGISTRIES_URL,
    path.join(CACHE_DIR, 'registries.json'),
    'registries',
    report,
  );
  const versionDoc = await fetchJsonSource(VERSION_URL, path.join(CACHE_DIR, 'version.json'), 'version', report);

  if (!recipesDoc) throw new Error('HARD ERROR: could not fetch recipes.json — see report.failedSources');
  if (!tagsDoc) throw new Error('HARD ERROR: could not fetch tags.json — see report.failedSources');
  if (!langDoc) throw new Error('HARD ERROR: could not fetch lang (en_us.json) — see report.failedSources');
  if (!registriesDoc?.item) {
    throw new Error('HARD ERROR: registries.json missing or has no "item" registry — see report.failedSources');
  }

  const recipeCount = Object.keys(recipesDoc).length;
  if (recipeCount < MIN_RECIPE_COUNT) {
    throw new Error(
      `HARD ERROR: fetched ${recipeCount} recipes, expected at least ${MIN_RECIPE_COUNT} ` +
        `(${(MIN_RECIPE_COUNT / EXPECTED_RECIPE_COUNT) * 100}% of the ${EXPECTED_RECIPE_COUNT} observed 2026-07-27) — ` +
        `upstream format likely changed or the fetch was truncated.`,
    );
  }
  log(`fetch-minecraft: ${recipeCount} recipes, ${Object.keys(tagsDoc).length} tags, ` +
    `${Object.keys(langDoc).length} lang keys, ${registriesDoc.item.length} registered items`);

  const registryOrder = registriesDoc.item; // authoritative item list + its own order
  // resolveName is declared further down but hoisted (function declaration) —
  // available here already, and langDoc it closes over is populated by now.
  const { resolveRef } = makeResolver(tagsDoc, registryOrder, report, resolveName);

  // --- Group kept recipes by result item, skipping code-driven types --------
  const typeCounts = {};
  const skippedTypeCounts = {};
  const candidatesByResult = new Map(); // resultId -> [{recipeId, type, ingredientsMap, yields, category}]

  const sortedRecipeIds = Object.keys(recipesDoc); // fixed file/key order — the tie-break basis, documented above
  for (const recipeId of sortedRecipeIds) {
    const r = recipesDoc[recipeId];
    typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;

    const isSkipped =
      r.type === 'minecraft:smithing_trim' ||
      r.type === 'minecraft:crafting_decorated_pot' ||
      r.type === 'minecraft:crafting_imbue' ||
      r.type.startsWith('minecraft:crafting_special_');
    if (isSkipped) {
      skippedTypeCounts[r.type] = (skippedTypeCounts[r.type] ?? 0) + 1;
      continue;
    }
    if (!(r.type in RECIPE_TYPE_STATION)) {
      // Should be unreachable given the real type census this script was
      // written against — but a future recipe type upstream must not be
      // silently mis-stationed, so treat it the same as skip + report.
      skippedTypeCounts[`${r.type} (UNRECOGNIZED)`] = (skippedTypeCounts[`${r.type} (UNRECOGNIZED)`] ?? 0) + 1;
      continue;
    }

    const parsed = extractRecipe(recipeId, r, resolveRef, report);
    if (!parsed) continue; // logged to report.unresolvedRecipes already

    const stationId = RECIPE_TYPE_STATION[r.type];
    const list = candidatesByResult.get(parsed.resultId) ?? [];
    list.push({ recipeId, type: r.type, stationId, ...parsed });
    candidatesByResult.set(parsed.resultId, list);
  }

  const keptRecipeCount = Object.values(typeCounts).reduce((a, b) => a + b, 0) - Object.values(skippedTypeCounts).reduce((a, b) => a + b, 0);
  log(`fetch-minecraft: ${keptRecipeCount} kept, ${Object.values(skippedTypeCounts).reduce((a, b) => a + b, 0)} skipped by type`);
  vlog('  type census:', JSON.stringify(typeCounts));
  vlog('  skipped:', JSON.stringify(skippedTypeCounts));
  if (report.unresolvedRecipes.length > 0) {
    log(`fetch-minecraft: ${report.unresolvedRecipes.length} recipe(s) could not be parsed (unresolved refs) — see report`);
  }

  // --- Order every candidate recipe per result item, cheapest raw cost first
  // schema v3 axis 2 (PLAN.md §1 decision 1/2): every candidate becomes a
  // recipes[] entry now — nothing is dropped. recipesByResult[0] is exactly
  // the same primary a pre-axis-2 scrape would have chosen as its single
  // `recipe` (same cost function + stable-sort tie-break), which keeps this
  // migration behaviour-preserving for every result with only one candidate.
  const memo = new Map();
  const recipesByResult = new Map(); // resultId -> candidates, ordered cheapest-first
  for (const [resultId, candidates] of candidatesByResult) {
    if (candidates.length === 1) {
      recipesByResult.set(resultId, candidates);
      continue;
    }
    const costs = candidates.map((cand) => {
      let total = 0;
      for (const [ingId, { qty }] of cand.ingredientsMap) {
        total += qty * computeRawCost(ingId, candidatesByResult, memo, new Set([resultId]));
      }
      return total;
    });
    // Stable sort: ties keep their original (file key) order, matching the
    // old "first index to strictly beat every earlier one" bestIdx rule.
    const order = candidates.map((_, i) => i).sort((a, b) => costs[a] - costs[b]);
    recipesByResult.set(resultId, order.map((i) => candidates[i]));
    report.multiRecipeItems.push({
      resultId,
      count: candidates.length,
      recipes: order.map((i) => `${candidates[i].recipeId} (station ${candidates[i].stationId}, cost ${costs[i]})`),
    });
  }

  // --- Build the item roster from the authoritative registry ----------------
  function resolveName(id) {
    return langDoc[`item.minecraft.${id}`] ?? langDoc[`block.minecraft.${id}`] ?? null;
  }

  const finalItems = {};
  let craftableCount = 0;
  for (const id of registryOrder) {
    let name = resolveName(id);
    if (name == null) {
      report.itemsNoName.push(id);
      name = titleCase(id);
    }
    const entry = { name };

    // schema v3 axis 2: `recipe` (single object) -> `recipes` (array,
    // ordered cheapest-first by recipesByResult). `category` still comes
    // from the PRIMARY (recipes[0]) candidate only, unchanged from before —
    // it's item-level metadata, not per-recipe.
    const candidates = recipesByResult.get(id);
    if (candidates && candidates.length > 0) {
      const primary = candidates[0];
      if (primary.category) entry.category = primary.category;
      entry.recipes = candidates.map((cand) => ({
        stations: [cand.stationId],
        yields: cand.yields ?? 1,
        // schema v3 axis 1 (PLAN.md §1 decision 3): `item` stays the sole
        // authoritative representative — tree.js/plan.js math is untouched —
        // `anyOf`/`anyOfLabel` are purely additive UI truth about
        // substitutability, only present when the slot had 2+ real
        // candidates.
        ingredients: [...cand.ingredientsMap].map(([item, info]) => {
          const out = { item, qty: info.qty };
          if (info.anyOf && info.anyOf.length > 1) {
            out.anyOf = info.anyOf;
            if (info.anyOfLabel) out.anyOfLabel = info.anyOfLabel;
          }
          return out;
        }),
      }));
      craftableCount++;
    }

    finalItems[id] = entry; // icon attached in the icon-download pass below
  }

  // A recipe can reference an ingredient that isn't itself in the item
  // registry (shouldn't happen given registries.item is authoritative, but
  // checked rather than assumed) — report, don't silently drop, so a dangling
  // reference is visible instead of surfacing later as a validate-data.mjs
  // failure with no context.
  const unknownIngredientRefs = [];
  const unknownAnyOfRefs = [];
  for (const [id, item] of Object.entries(finalItems)) {
    if (!item.recipes) continue;
    for (const recipe of item.recipes) {
      for (const ing of recipe.ingredients) {
        if (!(ing.item in finalItems)) unknownIngredientRefs.push({ item: id, ingredient: ing.item });
        for (const alt of ing.anyOf ?? []) {
          if (!(alt in finalItems)) unknownAnyOfRefs.push({ item: id, ingredient: ing.item, anyOfMember: alt });
        }
      }
    }
  }
  if (unknownAnyOfRefs.length > 0) {
    report.unknownAnyOfRefs = unknownAnyOfRefs;
    log(`fetch-minecraft: WARNING ${unknownAnyOfRefs.length} anyOf member(s) fall outside the item registry — see report.unknownAnyOfRefs`);
  }
  if (unknownIngredientRefs.length > 0) {
    report.unknownIngredientRefs = unknownIngredientRefs;
    log(`fetch-minecraft: WARNING ${unknownIngredientRefs.length} ingredient ref(s) fall outside the item registry — see report.unknownIngredientRefs`);
  }

  // --- Stations ---------------------------------------------------------------
  const finalStations = {};
  for (const stationId of STATION_IDS) {
    let name = resolveName(stationId);
    if (name == null) {
      report.itemsNoName.push(`station:${stationId}`);
      name = titleCase(stationId);
    }
    finalStations[stationId] = { name }; // icon attached below; no `progression` (Minecraft has no such concept)
  }

  // --- Icon resolution: cache-independent & idempotent ------------------------
  // FIXED 2026-07-28 after a real regression: in a worktree with a COLD
  // scripts/.cache/ (gitignored — every fresh worktree starts this way) but a
  // FULLY-POPULATED public/games/minecraft/icons/ (1,182 files already on
  // disk from a prior scrape), a --limit run collapsed items-with-an-icon
  // from 1,182 to 11. Root cause: the old single-pass loop called
  // attachIcon() (which DOES check the filesystem first) but then did
  // `if (limitReached) break;` — so the INSTANT the network-fetch cap was
  // hit on any one item, every item after it in registryOrder was skipped
  // entirely, INCLUDING ones whose icon file already sat on disk and needed
  // zero network to attach. `npm run validate` didn't catch it because the
  // `optional` icon flag (added for a genuinely small ~428-item set) just
  // counted the extra 1,171 as "legitimately absent" with no ceiling.
  //
  // Two passes now, deliberately decoupled:
  //
  //   Pass 1 (filesystem only, NEVER subject to --limit, always runs to
  //   completion over the WHOLE registry): any id whose icon file already
  //   exists under public/ is attached here, unconditionally. A re-run with
  //   a cold scripts/.cache/ but a fully-populated public/ reproduces the
  //   exact same icon coverage as any prior run, downloading nothing.
  //
  //   Pass 2 (network, subject to --limit): only ids Pass 1 left
  //   unresolved. Checked against a persisted NEGATIVE-result cache
  //   (NO_ICON_CACHE_FILE) first — an id CONFIRMED missing in a prior run
  //   that was allowed to fully try it (all 5 tiers, not cut short by
  //   --limit) is never re-attempted, which is what makes a second full run
  //   fast and network-free too. An id merely UNREACHED because --limit cut
  //   the run short is NOT written to that cache (its real status is
  //   unknown) and is NOT counted as confirmed-missing — see
  //   `iconsUnattempted` below, kept separate from `iconsMissing`.
  let iconsWritten = 0;
  let iconsPresent = 0; // Pass 1: resolved from an existing file on disk
  let iconsMissing = 0; // Pass 2: CONFIRMED no representative texture (all tiers tried)
  let iconsUnattempted = 0; // Pass 2: never tried this run — --limit cut it short
  const tierCounts = {};

  const noIconCache = existsSync(NO_ICON_CACHE_FILE)
    ? new Set(JSON.parse(readFileSync(NO_ICON_CACHE_FILE, 'utf8')))
    : new Set();
  const confirmedMissingThisRun = new Set(); // merged into the persisted cache at the end

  function attachFromDisk(id, entry) {
    const publicPath = path.join(PUBLIC_ICONS_DIR, `${id}.png`);
    if (!existsSync(publicPath)) return false;
    entry.icon = `icons/${id}.png`;
    iconsPresent++;
    return true;
  }

  async function attachFromNetwork(id, entry) {
    if (noIconCache.has(id)) {
      // Confirmed missing in a prior full run — no need to hit the network
      // again, and doesn't count against --limit at all.
      iconsMissing++;
      report.itemsNoIcon.push(id);
      return;
    }
    const result = await resolveIconBytes(id, report);
    if (result) {
      writeFileSync(path.join(PUBLIC_ICONS_DIR, `${id}.png`), result.bytes);
      entry.icon = `icons/${id}.png`;
      iconsWritten++;
      tierCounts[result.tier] = (tierCounts[result.tier] ?? 0) + 1;
      return;
    }
    // null can mean two different things: genuinely exhausted all 5 tiers
    // (a real, confirmable miss), or cut short mid-attempt because --limit
    // was hit on THIS call or an earlier one (limitReached is now true when
    // it wasn't before, or already was). Only the former is trustworthy
    // enough to persist as a negative result.
    if (limitReached) {
      iconsUnattempted++;
      return;
    }
    iconsMissing++;
    report.itemsNoIcon.push(id);
    confirmedMissingThisRun.add(id);
  }

  log(`fetch-minecraft: resolving icons for ${registryOrder.length} items + ${STATION_IDS.length} stations...`);

  // Pass 1: filesystem only, whole registry, unconditionally.
  const unresolvedItems = [];
  for (const id of registryOrder) {
    if (!attachFromDisk(id, finalItems[id])) unresolvedItems.push(id);
  }
  const unresolvedStations = [];
  for (const stationId of STATION_IDS) {
    if (!attachFromDisk(stationId, finalStations[stationId])) unresolvedStations.push(stationId);
  }
  vlog(
    `  pass 1 (filesystem): ${iconsPresent} already on disk, ${unresolvedItems.length + unresolvedStations.length} still unresolved`,
  );

  // Pass 2: network, subject to --limit, only over what Pass 1 couldn't
  // resolve. Items before stations, matching the original priority.
  let processed = 0;
  for (const id of unresolvedItems) {
    await attachFromNetwork(id, finalItems[id]);
    processed++;
    if (processed % 200 === 0) vlog(`  ...${processed}/${unresolvedItems.length} unresolved items processed`);
  }
  for (const stationId of unresolvedStations) {
    await attachFromNetwork(stationId, finalStations[stationId]);
  }

  // Persist newly-confirmed misses so a FUTURE full run doesn't re-attempt
  // known-dead URLs. Never removes an id (upstream textures don't come back
  // by themselves; if one ever does, deleting scripts/.cache/minecraft/no-icon.json
  // forces a full recheck).
  if (confirmedMissingThisRun.size > 0) {
    for (const id of confirmedMissingThisRun) noIconCache.add(id);
    writeFileSync(NO_ICON_CACHE_FILE, JSON.stringify([...noIconCache].sort(), null, 2) + '\n', 'utf8');
  }

  // --- Icon-coverage tripwire --------------------------------------------------
  // Real value observed 2026-07-28 after the fix above: 1,182/1,610 items and
  // 8/8 stations resolve an icon (the rest are the documented ~27% with no
  // representative texture at all — buttons/fences/slabs/stairs/etc. that
  // reuse their parent material via a model, plus entity-rendered blocks).
  // Only asserted when this run had a genuine opportunity to observe the
  // WHOLE registry — i.e. Pass 2 was never cut short by --limit — exactly
  // like fetch-pals.mjs's MIN_HABITATS_TRIPWIRE. A deliberately partial
  // --limit run is not a signal that upstream's texture set collapsed.
  const iconFloorApplies = !limitReached;
  if (iconFloorApplies && iconsPresent + iconsWritten < MIN_ICON_COUNT) {
    throw new Error(
      `HARD ERROR: only ${iconsPresent + iconsWritten} items/stations resolved an icon, expected at least ` +
        `${MIN_ICON_COUNT} (${(MIN_ICON_COUNT / EXPECTED_ICON_COUNT) * 100}% of the ${EXPECTED_ICON_COUNT} observed ` +
        `2026-07-28) — a full (non-'--limit'-cut) run should never collapse this far below the known-good count. ` +
        `If public/games/minecraft/icons/ was deleted or scripts/.cache/minecraft/no-icon.json is stale/wrong, ` +
        `fix that; do not raise this floor to silence a real regression.`,
    );
  }
  // Stations get a STRICT floor (all 8, no headroom) — unlike items, every
  // station has always resolved an icon; any drop at all is worth a hard
  // stop, not a percentage-based tolerance.
  if (iconFloorApplies) {
    const resolvedStationIcons = STATION_IDS.filter((id) => finalStations[id].icon).length;
    if (resolvedStationIcons < STATION_IDS.length) {
      throw new Error(
        `HARD ERROR: only ${resolvedStationIcons}/${STATION_IDS.length} stations resolved an icon (expected all ` +
          `${STATION_IDS.length} — every station has always had one) — see report.itemsNoIcon for which.`,
      );
    }
  }

  // --- schema v3 axis 1 stats: walk the FINAL shipped ingredients (not the
  // intermediate resolutions log) so this counts exactly what ships. ---------
  let anyOfIngredientCount = 0;
  let anyOfRecipeCount = 0;
  let anyOfNoLabelCount = 0;
  const setSizeBuckets = { '2': 0, '3-9': 0, '10+': 0 };
  let maxAnyOfSize = 0;
  let multiRecipeItemCount = 0; // schema v3 axis 2: items with 2+ recipes[] entries
  for (const item of Object.values(finalItems)) {
    if (!item.recipes) continue;
    if (item.recipes.length > 1) multiRecipeItemCount++;
    for (const recipe of item.recipes) {
      let recipeHasAnyOf = false;
      for (const ing of recipe.ingredients) {
        if (!ing.anyOf) continue;
        anyOfIngredientCount++;
        recipeHasAnyOf = true;
        if (!ing.anyOfLabel) anyOfNoLabelCount++;
        const size = ing.anyOf.length;
        if (size > maxAnyOfSize) maxAnyOfSize = size;
        if (size === 2) setSizeBuckets['2']++;
        else if (size <= 9) setSizeBuckets['3-9']++;
        else setSizeBuckets['10+']++;
      }
      if (recipeHasAnyOf) anyOfRecipeCount++;
    }
  }

  // --- Write outputs -----------------------------------------------------------
  // schema v3 (PLAN.md §1 decision 2): bumped from 2 -> 3 for the recipe ->
  // recipes[] breaking change (clean break, no legacy `recipe` key emitted).
  const gameVersion = versionDoc?.id ?? 'unknown (misode/mcmeta summary/version.json unreachable)';
  const itemsDoc = { schemaVersion: 3, gameVersion, items: finalItems };
  writeFileSync(ITEMS_OUT, JSON.stringify(itemsDoc, null, 2) + '\n', 'utf8');
  writeFileSync(STATIONS_OUT, JSON.stringify(finalStations, null, 2) + '\n', 'utf8');

  report.finishedAt = new Date().toISOString();
  report.gameVersion = gameVersion;
  report.partial = limitReached;
  report.counts = {
    recipesTotal: recipeCount,
    recipesKept: keptRecipeCount,
    recipesSkippedByType: skippedTypeCounts,
    recipeTypeCensus: typeCounts,
    items: registryOrder.length,
    craftable: craftableCount,
    raw: registryOrder.length - craftableCount,
    stations: STATION_IDS.length,
    icons: {
      written: iconsWritten,
      present: iconsPresent,
      missing: iconsMissing,
      unattempted: iconsUnattempted,
      byFallbackTier: tierCounts,
    },
    namesFallenBack: report.itemsNoName.length,
    multiMemberResolutions: report.multiMemberResolutions.length,
    multiRecipeItems: multiRecipeItemCount,
    unresolvedRecipes: report.unresolvedRecipes.length,
    anyOf: {
      ingredientsWithAnyOf: anyOfIngredientCount,
      recipesWithAnyOf: anyOfRecipeCount,
      setSizeDistribution: setSizeBuckets,
      maxSetSize: maxAnyOfSize,
      lackingLabel: anyOfNoLabelCount,
    },
  };
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  log('');
  log(`fetch-minecraft: ${report.partial ? 'PARTIAL' : 'COMPLETE'} run summary`);
  log(`  recipes: ${recipeCount} total, ${keptRecipeCount} kept, ${JSON.stringify(skippedTypeCounts)} skipped`);
  log(`  items: ${registryOrder.length} (craftable ${craftableCount}, multi-recipe ${multiRecipeItemCount}, raw ${registryOrder.length - craftableCount})`);
  log(`  stations: ${STATION_IDS.length}`);
  log(`  icons: ${iconsWritten} written, ${iconsPresent} already present, ${iconsMissing} confirmed missing, ${iconsUnattempted} unattempted (--limit) (fallback tiers used: ${JSON.stringify(tierCounts)})`);
  log(`  names fallen back to title-case: ${report.itemsNoName.length}`);
  log(`  multi-member tag/array resolutions: ${report.multiMemberResolutions.length}`);
  log(`  items with 2+ recipes: ${report.multiRecipeItems.length}`);
  log(`  unresolved/unparseable recipes: ${report.unresolvedRecipes.length}`);
  log(`  tag cycles encountered: ${report.tagCycles.length}, unknown tags referenced: ${report.unknownTags.length}`);
  log(
    `  anyOf: ${anyOfIngredientCount} ingredient(s) across ${anyOfRecipeCount} recipe(s) gained anyOf ` +
      `(set sizes: 2=${setSizeBuckets['2']}, 3-9=${setSizeBuckets['3-9']}, 10+=${setSizeBuckets['10+']}, max=${maxAnyOfSize}), ` +
      `${anyOfNoLabelCount} lacked a label (bare alternatives array, no tag name)`,
  );
  if (limitReached) log('  --limit reached; run again to continue (icons only).');
  log(`  report written to ${REPORT_OUT}`);

  if (report.itemsNoIcon.length > 0) {
    log(`  items with NO icon at all (all fallback tiers exhausted): ${report.itemsNoIcon.length}`);
    log(`    sample: ${report.itemsNoIcon.slice(0, 20).join(', ')}${report.itemsNoIcon.length > 20 ? ', ...' : ''}`);
  }
}

main().catch((err) => {
  console.error('fetch-minecraft: FATAL', err);
  process.exit(1);
});
