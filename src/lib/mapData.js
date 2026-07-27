// Lazy, memoized loaders for the *heavy* map datasets (PLAN.md §8/§9,
// CLAUDE.md "Heavy datasets are lazy-fetched from public/, never statically
// imported"). map.json alone is ~1.9 MB and there are 278+ per-pal habitat
// files — none of that may ever become a Vite-bundled import, so this module
// deliberately uses runtime `fetch`, not `import`.
//
// Each URL is fetched at most once per page load (module-level cache, keyed
// by URL) and memoized as a Promise so concurrent callers share one in-flight
// request. A failed fetch is NOT memoized (so a later retry can succeed) and
// rejects the returned promise — callers must treat that as a visible error
// state, never a silently-empty map (a 404 must not look like "0 markers").

const cache = new Map();

function fetchJSONOnce(url) {
  if (!cache.has(url)) {
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        cache.delete(url); // don't memoize a failure — let a later call retry
        throw err;
      });
    cache.set(url, promise);
  }
  return cache.get(url);
}

/**
 * Load the current game's map.json (POI markers + legend `types` + `world`
 * bounds). Resolves the URL from the manifest's `assetBase`, same pattern as
 * ItemIcon — BASE_URL handles the GitHub Pages `/CraftPal/` prefix.
 *
 * @param {{assetBase: string}} manifest
 * @returns {Promise<{schemaVersion: number, source: string, world: object, types: Array, markers: Array}>}
 */
export function loadMapData(manifest) {
  return fetchJSONOnce(`${import.meta.env.BASE_URL}${manifest.assetBase}data/map.json`);
}

/**
 * Load one pal's habitat point-cloud file, lazily — opening the map must
 * never download every pal's cloud, only the one the user actually picks.
 *
 * @param {{assetBase: string}} manifest
 * @param {string} code - pal code (public/.../data/habitats/<code>.json).
 * @returns {Promise<{code: string, name: string, radius: {day: number, night: number}, day: number[], night: number[]}>}
 */
export function loadHabitat(manifest, code) {
  return fetchJSONOnce(`${import.meta.env.BASE_URL}${manifest.assetBase}data/habitats/${code}.json`);
}
