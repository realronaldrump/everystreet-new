// Keep Swup's history URL aligned with the browser URL when a feature changes
// only query/hash state. Copying the old history record verbatim keeps a stale URL.
export function updateUrlHistory(url, { push = false, source = "es-store" } = {}) {
  const href = new URL(String(url), window.location.href).href;
  const state = { ...window.history.state, source, url: href };
  window.history[push ? "pushState" : "replaceState"](state, "", String(url));
}
