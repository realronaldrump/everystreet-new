import bootstrapPage from "/static/js/modules/core/page-bootstrap.js";
import { acquireExplorationMap } from "/static/js/modules/core/exploration-map.js";

export function mount(path) {
  bootstrapPage(({ signal, cleanup }) => {
    window.mounts[path] = (window.mounts[path] || 0) + 1;
    const detail = path === "/trips/1" || path.endsWith("/journal");
    const button = document.getElementById(detail ? "detail-counter" : "counter");
    button?.addEventListener(
      "click",
      () => {
        window.count++;
      },
      { signal }
    );
    let map;
    if (["/coverage-management", "/coverage-route-planner"].includes(path))
      map = acquireExplorationMap("coverage-map");
    cleanup(() => {
      window.unmounts[path] = (window.unmounts[path] || 0) + 1;
      map?.remove();
    });
  }, path);
}
