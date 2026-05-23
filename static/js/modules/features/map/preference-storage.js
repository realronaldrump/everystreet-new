export function readStoredBoolean(key) {
  if (!key || typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    if (raw !== null) {
      return Boolean(JSON.parse(raw));
    }
  } catch {
    // Ignore storage parsing issues.
  }

  return null;
}

export function writeStoredBoolean(key, value) {
  if (!key || typeof value !== "boolean" || typeof localStorage === "undefined") {
    return false;
  }

  try {
    localStorage.setItem(key, value ? "true" : "false");
    return true;
  } catch {
    return false;
  }
}
