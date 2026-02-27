/* global Chart, MapboxDraw, bootstrap, mapboxgl, $ */

import VisitsPageController from "./visits-controller.js";

let visitsPage;

function repairModalUiState() {
  const hasVisibleModal = Boolean(
    document.querySelector(
      '.modal.show, .modal[aria-modal="true"], .modal[style*="display: block"]'
    )
  );
  if (hasVisibleModal) {
    return;
  }

  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.remove());
  document.body.classList.remove("modal-open");
  document.body.style.removeProperty("padding-right");
  document.body.style.removeProperty("overflow");
}

export default function initVisitsPage({ cleanup } = {}) {
  const noopTeardown = () => {};
  const mapProvider = String(window.MAP_PROVIDER || "self_hosted").toLowerCase();
  const usingGoogleProvider = mapProvider === "google";
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
  if (!usingGoogleProvider && typeof mapboxgl === "undefined") {
    missingLibraries.push("Mapbox GL JS");
  }
  if (!usingGoogleProvider && typeof MapboxDraw === "undefined") {
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
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  // Initialize new visits page controller
  repairModalUiState();
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
    visitsPage?.destroy?.();
    visitsPage?.clearPlacePreviewMaps?.();
    visitsPage?.clearSuggestionPreviewMaps?.();
    visitsPage?.visitsManager?.destroy?.();
    repairModalUiState();
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

  return teardown;
}
