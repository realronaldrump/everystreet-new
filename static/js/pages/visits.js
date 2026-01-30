/* global Chart, MapboxDraw, bootstrap, mapboxgl, $ */

import { onPageLoad } from "../modules/utils.js";
import VisitsPageController from "./visits-new.js";

let visitsPage;

onPageLoad(
  ({ cleanup } = {}) => {
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

    if (typeof cleanup === "function") {
      cleanup(() => {
        themeObserver.disconnect();
        visitsPage?.visitsManager?.destroy?.();
      });
    }
  },
  { route: "/visits" }
);

// Export for global access
window.visitsPage = visitsPage;
