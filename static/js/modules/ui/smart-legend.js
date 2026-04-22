import { swupReady } from "../core/navigation.js";

const COLLAPSED_KEY = "everystreet:smart-legend-collapsed";

function wire(legend) {
  if (!legend || legend.dataset.wired === "true") {
    return;
  }
  const toggle = legend.querySelector(".map-smart-legend__toggle");
  if (!toggle) {
    return;
  }

  const storedCollapsed = (() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  })();

  const apply = (collapsed) => {
    legend.dataset.collapsed = collapsed ? "true" : "false";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  apply(storedCollapsed);

  toggle.addEventListener("click", () => {
    const next = legend.dataset.collapsed !== "true";
    apply(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "true" : "false");
    } catch {
      /* storage unavailable — non-fatal */
    }
  });

  legend.dataset.wired = "true";
}

function init() {
  document.querySelectorAll("#map-smart-legend").forEach(wire);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

swupReady
  .then((swup) => {
    swup.hooks.on("page:view", () => {
      requestAnimationFrame(init);
    });
  })
  .catch(() => {});

export default { init };
