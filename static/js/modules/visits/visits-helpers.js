/* global DateUtils, $ */

import notificationManager from "../ui/notifications.js";
import { DateUtils as DateUtilsModule } from "../utils.js";

const DateUtilsRef = typeof DateUtils !== "undefined" ? DateUtils : DateUtilsModule;

/**
 * Visits Helpers Module
 * Static utility functions for visits functionality
 */

const VisitsHelpers = {
  /**
   * Get the current theme from the document
   * @returns {string} "light" or "dark"
   */
  getCurrentTheme() {
    return document.documentElement.getAttribute("data-bs-theme") || "dark";
  },

  /**
   * Show initial loading overlay
   */
  showInitialLoading() {
    const loadingOverlay = document.getElementById("map-loading");
    if (loadingOverlay) {
      loadingOverlay.style.display = "flex";
      loadingOverlay.style.opacity = "1";
      loadingOverlay.style.pointerEvents = "all";
    }
  },

  /**
   * Hide initial loading overlay with animation
   */
  hideInitialLoading() {
    const loadingOverlay = document.getElementById("map-loading");
    if (loadingOverlay) {
      loadingOverlay.style.pointerEvents = "none";
      setTimeout(() => {
        loadingOverlay.style.transition = "opacity 0.3s ease";
        loadingOverlay.style.opacity = "0";
        setTimeout(() => {
          loadingOverlay.style.display = "none";
        }, 300);
      }, 500);
    }
  },

  /**
   * Show error state in the map container
   */
  showErrorState() {
    const mapContainer = document.getElementById("map");
    if (mapContainer) {
      mapContainer.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-exclamation-triangle"></i>
            <h5>Unable to Load Map</h5>
            <p>Please refresh the page to try again</p>
          </div>
        `;
    }
  },

  /**
   * Set up custom duration sorting for DataTables
   */
  setupDurationSorting() {
    if (window.$ && $.fn.dataTable) {
      $.fn.dataTable.ext.type.order["duration-pre"] = (data) =>
        DateUtilsRef.convertDurationToSeconds(data);
    }
  },

  /**
   * Extract trip geometry from various possible sources in trip data
   * @param {Object} trip - Trip object to extract geometry from
   */
  extractTripGeometry(trip) {
    // Check gps field first - may be GeoJSON object
    if (
      trip.gps
      && typeof trip.gps === "object"
      && trip.gps.type === "LineString"
      && trip.gps.coordinates
      && trip.gps.coordinates.length > 0
    ) {
      trip.geometry = trip.gps;
      return;
    }

    // Already has valid geometry
    if (trip.geometry?.coordinates?.length > 0) {
      return;
    }

    // Try matchedGps field
    if (trip.matchedGps?.coordinates && trip.matchedGps.coordinates.length > 0) {
      trip.geometry = trip.matchedGps;
      return;
    }

    // Try parsing gps as JSON string
    if (typeof trip.gps === "string" && trip.gps) {
      try {
        const gpsData = JSON.parse(trip.gps);
        if (gpsData?.coordinates?.length > 0) {
          trip.geometry = gpsData;
          return;
        }
      } catch (e) {
        console.error("Failed to parse gps JSON", e);
        notificationManager?.show("Failed to parse gps JSON.", "danger");
      }
    }

    // Fall back to creating line from start/destination points
    if (trip.startGeoPoint?.coordinates && trip.destinationGeoPoint?.coordinates) {
      trip.geometry = {
        type: "LineString",
        coordinates: [
          trip.startGeoPoint.coordinates,
          trip.destinationGeoPoint.coordinates,
        ],
      };
    }
  },
  /**
   * Show inline error on a form input and toast a warning message.
   * @param {HTMLElement|null} input - Input element to highlight
   * @param {string} message - Message to show
   */
  showInputError(input, message) {
    if (input) {
      input.classList.add("is-invalid");
      input.focus();
      input.addEventListener("input", () => input.classList.remove("is-invalid"), {
        once: true,
      });
    }
    notificationManager?.show(message, "warning");
  },
};

export { VisitsHelpers };
export default VisitsHelpers;
