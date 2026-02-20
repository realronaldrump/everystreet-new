import { CONFIG } from "./config.js";

const DEFAULT_STYLE_TYPE = "dark";
const MAPBOX_STYLE_PREFIX = "mapbox://styles/";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const normalizeTheme = (theme) => (theme === "light" ? "light" : DEFAULT_STYLE_TYPE);

export function getCurrentTheme() {
  if (typeof document === "undefined") {
    return DEFAULT_STYLE_TYPE;
  }
  const theme = document.documentElement?.getAttribute("data-bs-theme");
  return normalizeTheme(theme);
}

export function resolveMapStyle({ requestedType, theme } = {}) {
  const styles = CONFIG?.MAP?.styles || {};
  const normalizedTheme = normalizeTheme(theme || getCurrentTheme());
  const requested = typeof requestedType === "string" ? requestedType.trim() : "";

  let styleType = "";
  if (requested && hasOwn(styles, requested)) {
    styleType = requested;
  } else if (hasOwn(styles, normalizedTheme)) {
    styleType = normalizedTheme;
  } else if (hasOwn(styles, DEFAULT_STYLE_TYPE)) {
    styleType = DEFAULT_STYLE_TYPE;
  } else {
    [styleType] = Object.keys(styles);
  }

  const styleUrl =
    styles[styleType] ||
    styles[DEFAULT_STYLE_TYPE] ||
    "mapbox://styles/mapbox/dark-v11";

  return {
    styleType: styleType || DEFAULT_STYLE_TYPE,
    styleUrl,
    theme: normalizedTheme,
  };
}

function parseMapboxStyleUrl(styleUrl) {
  if (typeof styleUrl !== "string") {
    return null;
  }
  const trimmed = styleUrl.trim();
  if (!trimmed.startsWith(MAPBOX_STYLE_PREFIX)) {
    return null;
  }
  const stylePath = trimmed.slice(MAPBOX_STYLE_PREFIX.length).replace(/^\/+/, "");
  const [owner, styleIdWithQuery] = stylePath.split("/");
  const styleId = String(styleIdWithQuery || "").split("?")[0];
  if (!owner || !styleId) {
    return null;
  }
  return { owner, styleId };
}

export function buildMapboxRasterTileUrl({ styleUrl, token, tileSize = 256 } = {}) {
  const parsed = parseMapboxStyleUrl(styleUrl);
  if (!parsed) {
    throw new Error(`Invalid Mapbox style URL for raster tiles: ${String(styleUrl || "")}`);
  }
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    throw new Error("Mapbox access token not configured");
  }

  const { owner, styleId } = parsed;
  return (
    `https://api.mapbox.com/styles/v1/${owner}/${styleId}/tiles/${tileSize}/{z}/{x}/{y}@2x` +
    `?access_token=${encodeURIComponent(normalizedToken)}`
  );
}

