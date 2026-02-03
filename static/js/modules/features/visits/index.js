/* global Chart, MapboxDraw, bootstrap, mapboxgl, $ */

import VisitsPageController from "./visits-controller.js";

let visitsPage;

export default function initVisitsPage({ cleanup } = {}) {
  const missingLibraries = [];

  if (typeof Chart === "undefined") {
    missingLibraries.push("Chart.js");
  }
  if (typeof $ === "undefined") {
    missingLibraries.push("jQuery");
  }
  if (typeof bootstrap === "undefined") {
    missingLibraries.push("Bootstrap");
  }
  if (typeof mapboxgl === "undefined") {
    missingLibraries.push("Mapbox GL JS");
  }
  if (typeof MapboxDraw === "undefined") {
    missingLibraries.push("Mapbox Draw");
  }

  if (missingLibraries.length > 0) {
    const errorDiv = document.createElement("div");
    errorDiv.className = "alert alert-danger m-4";
    errorDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle me-2"></i>
        <strong>Error:</strong> Missing required libraries: ${missingLibraries.join(", ")}.
      `;
    document.body.prepend(errorDiv);
    return;
  }

  // Initialize new visits page controller
  visitsPage = new VisitsPageController();
  window.visitsPage = visitsPage; // Expose specifically for inline onclick handlers

  const themeObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === "data-bs-theme") {
        const newTheme = document.documentElement.getAttribute("data-bs-theme");
        visitsPage?.visitsManager?.updateMapTheme?.(newTheme);
      }
    });
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bs-theme"],
  });

  const teardown = () => {
    themeObserver.disconnect();
    visitsPage?.clearSuggestionPreviewMaps?.();
    visitsPage?.visitsManager?.destroy?.();
    if (window.visitsPage === visitsPage) {
      window.visitsPage = undefined;
    }
    visitsPage = null;
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
}
