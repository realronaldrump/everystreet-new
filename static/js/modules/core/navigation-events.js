// The app lifecycle is independent of whether enhanced navigation is available.
const listeners = new Map();

export function onNavigation(name, callback) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(callback);
  return () => listeners.get(name)?.delete(callback);
}

export function emitNavigation(name, visit = {}) {
  for (const callback of [...(listeners.get(name) || [])]) {
    try {
      callback(visit);
    } catch (error) {
      console.error(`Navigation ${name} handler failed`, error);
    }
  }
}

export function pathnameFromSwupUrl(value) {
  if (!value) return null;
  try {
    return new URL(
      typeof value === "string" ? value : value.href || value.pathname,
      globalThis.window?.location?.origin || "https://www.everystreet.me"
    ).pathname;
  } catch {
    return null;
  }
}
