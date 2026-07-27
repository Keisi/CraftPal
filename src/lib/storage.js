// Tiny localStorage read/write helpers (crafting-tasks feature). Every call
// is guarded — a disabled/private-mode localStorage, a quota error, or a
// hand-edited/corrupt value must never throw past this module and white-
// screen the app; callers just get `fallback` back.

function hasLocalStorage() {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

/**
 * Read + JSON.parse a localStorage key, falling back safely on any failure
 * (missing key, disabled storage, or invalid JSON).
 *
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
export function loadJSON(key, fallback) {
  if (!hasLocalStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * JSON.stringify + write a localStorage key. Failures (quota exceeded,
 * storage disabled) are swallowed — losing persistence is better than
 * crashing the app.
 *
 * @param {string} key
 * @param {*} value
 */
export function saveJSON(key, value) {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore — quota exceeded / storage disabled
  }
}
