export function normalizeStyleType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isGoogleProvider() {
  return normalizeStyleType(globalThis?.window?.MAP_PROVIDER) === "google";
}

export function readMapStyle(map) {
  if (!map || typeof map.getStyle !== "function") {
    return null;
  }

  try {
    const style = map.getStyle();
    if (style && typeof style === "object") {
      return style;
    }
  } catch {
    // Style might not be ready yet.
  }

  return null;
}
