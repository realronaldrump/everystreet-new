export function resolveMapTypeHint({
  storageKey,
  normalizeStyleType,
  selectId = "map-type-select",
} = {}) {
  if (typeof normalizeStyleType !== "function") {
    return "";
  }

  if (typeof document !== "undefined") {
    const select = document.getElementById(selectId);
    if (select?.value) {
      return normalizeStyleType(select.value);
    }
  }

  if (typeof localStorage === "undefined") {
    return "";
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) {
      return "";
    }
    try {
      return normalizeStyleType(JSON.parse(raw));
    } catch {
      return normalizeStyleType(raw);
    }
  } catch {
    return "";
  }
}

export default resolveMapTypeHint;
