/**
 * Read a design token (a CSS custom property on the root element).
 *
 * Map layers, charts, and canvases can't use var() directly, so they read
 * the current value here. Falls back when there is no document (tests,
 * workers) or the token is unset.
 */
export function readToken(name, fallback = "") {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}
