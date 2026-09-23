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

/**
 * Mapbox GL and deck.gl parse only the comma form of rgb(); tokens use the
 * modern space-separated one. Hex and named colours pass through.
 */
export function toMapColor(value) {
  const match = String(value).match(
    /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/
  );
  if (!match) {
    return value;
  }
  const [, r, g, b, alpha = "1", percent] = match;
  const a = percent ? Number(alpha) / 100 : Number(alpha);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A token as a colour a map paint property can take. */
export function readMapColor(name) {
  return toMapColor(readToken(name));
}

/**
 * An "r g b" channel token (such as --manual-ink-rgb) at the given opacity,
 * as a map-ready rgba() colour.
 */
export function readMapColorAlpha(rgbName, alpha) {
  const channels = readToken(rgbName).split(/\s+/).filter(Boolean);
  if (channels.length !== 3) {
    return "";
  }
  return `rgba(${channels.join(", ")}, ${alpha})`;
}

/** An "r g b" channel token as three numbers, or null when unset. */
export function readTokenChannels(rgbName) {
  const channels = readToken(rgbName).split(/\s+/).filter(Boolean).map(Number);
  return channels.length === 3 && channels.every(Number.isFinite) ? channels : null;
}
