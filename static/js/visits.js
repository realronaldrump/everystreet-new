/* global Chart, DateUtils, bootstrap */

(() => {
  document.addEventListener("DOMContentLoaded", () => {
    if (
      typeof Chart !== "undefined" &&
      typeof $ !== "undefined" &&
      typeof bootstrap !== "undefined" &&
      typeof DateUtils !== "undefined" &&
      typeof window.mapBase !== "undefined" &&
      typeof window.mapBase.createMap === "function" &&
      typeof window.VisitsManager !== "undefined" // Ensure VisitsManager class is loaded
    ) {
      window.visitsManager = new window.VisitsManager();

      const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === "data-bs-theme") {
            const newTheme =
              document.documentElement.getAttribute("data-bs-theme");
            window.visitsManager?.updateMapTheme(newTheme);
          }
        });
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });
    } else {
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
      if (typeof DateUtils === "undefined") {
        missingLibraries.push("DateUtils");
      }
      if (typeof window.mapBase === "undefined") {
        missingLibraries.push("mapBase (window.mapBase)");
      } else if (typeof window.mapBase.createMap !== "function") {
        missingLibraries.push("mapBase.createMap (function missing)");
      }
      if (typeof window.VisitsManager === "undefined") {
        missingLibraries.push("VisitsManager class (modules not loaded?)");
      }

      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle me-2"></i>
        <strong>Error:</strong> Could not load necessary components for Visits page.
        Please refresh page.
      `;
      document.body.prepend(errorDiv);
    }
  });
})();
