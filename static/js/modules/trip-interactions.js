/* global mapboxgl */

import mapManager from "./map-manager.js";
import metricsManager from "./metrics-manager.js";
import state from "./core/store.js";
import confirmationDialog from "./ui/confirmation-dialog.js";
import notificationManager from "./ui/notifications.js";
import { utils } from "./utils.js";

const tripInteractions = {
  handleTripClick(e, feature, layerName = null) {
    if (!feature?.properties) {
      return;
    }

    const tripId
      = feature.properties.transactionId
      || feature.properties.id
      || feature.properties.tripId;

    if (tripId) {
      state.selectedTripId = tripId;
      state.selectedTripLayer
        = layerName || this.resolveTripLayerName(feature?.layer?.id);
      mapManager.refreshTripStyles();
    }

    const popup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "400px",
      anchor: "bottom",
    })
      .setLngLat(e.lngLat)
      .setHTML(this.createPopupContent(feature))
      .addTo(state.map);
    // Attach listeners immediately; Mapbox GL's 'open' can fire before handler registration
    this.setupPopupEventListeners(popup);
  },

  resolveTripLayerName(layerId = "") {
    if (!layerId || typeof layerId !== "string") {
      return null;
    }
    if (layerId.startsWith("matchedTrips")) {
      return "matchedTrips";
    }
    if (layerId.startsWith("trips")) {
      return "trips";
    }
    return null;
  },

  createPopupContent(feature) {
    const props = feature.properties || {};

    const formatValue = (value, formatter) =>
      value != null ? formatter(value) : "N/A";
    const formatNumber = (value, digits = 1) =>
      formatValue(value, (v) => parseFloat(v).toFixed(digits));
    const formatTime = (value) =>
      formatValue(value, (v) =>
        new Date(v).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      );

    let duration = props.duration || props.drivingTime;
    if (!duration && props.startTime && props.endTime) {
      const start = new Date(props.startTime);
      const end = new Date(props.endTime);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        duration = (end - start) / 1000;
      }
    }

    return `
        <div class="coverage-popup-content">
          <div class="popup-title">Trip Details</div>
          <div class="popup-detail">
            <span class="popup-label">Start:</span>
            <span>${formatTime(props.startTime)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">End:</span>
            <span>${formatTime(props.endTime)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Distance:</span>
            <span>${formatNumber(props.distance)} mi</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Duration:</span>
            <span>${metricsManager.formatDuration(duration)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Avg Speed:</span>
            <span>${formatNumber(props.averageSpeed || props.avgSpeed)} mph</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Max Speed:</span>
            <span>${formatNumber(props.maxSpeed)} mph</span>
          </div>
          ${this.createActionButtons(feature)}
        </div>
      `;
  },

  createActionButtons(feature) {
    const props = feature.properties || {};
    const isMatched
      = props.source === "matched"
      || props.mapMatchingStatus === "success"
      || feature.source?.includes("matched");
    const tripId = props.transactionId || props.id || props.tripId;

    if (!tripId) {
      return "";
    }

    return `
        <div class="popup-actions mt-3 d-flex gap-2 flex-wrap">
          <button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-eye"></i> View
          </button>
          ${
            isMatched
              ? `
            <button class="btn btn-sm btn-warning rematch-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-redo"></i> Rematch
            </button>
            <button class="btn btn-sm btn-danger delete-matched-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-trash"></i> Delete Matched
            </button>
          `
              : `
            <button class="btn btn-sm btn-info map-match-btn" data-trip-id="${tripId}">
              <i class="fas fa-route"></i> Map Match
            </button>
            <button class="btn btn-sm btn-danger delete-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-trash"></i> Delete
            </button>
          `
          }
        </div>
      `;
  },

  setupPopupEventListeners(popup, attempt = 0) {
    const popupElement = popup.getElement();
    if (!popupElement) {
      if (attempt < 5) {
        setTimeout(() => this.setupPopupEventListeners(popup, attempt + 1), 50);
      }
      return;
    }

    popupElement.addEventListener("click", async (e) => {
      const button = e.target.closest("button");
      if (!button) {
        return;
      }

      const { tripId } = button.dataset;
      if (!tripId) {
        return;
      }

      button.disabled = true;
      button.classList.add("btn-loading");

      try {
        if (button.classList.contains("view-trip-btn")) {
          window.open(`/trips/${tripId}`, "_blank");
        } else if (button.classList.contains("delete-matched-trip-btn")) {
          await this.deleteMatchedTrip(tripId, popup);
        } else if (button.classList.contains("delete-trip-btn")) {
          await this.deleteTrip(tripId, popup);
        } else if (
          button.classList.contains("rematch-trip-btn")
          || button.classList.contains("map-match-btn")
        ) {
          await this.rematchTrip(tripId, popup);
        }
      } catch (error) {
        console.error("Error handling popup action:", error);
        notificationManager.show("Error performing action", "danger");
      } finally {
        button.disabled = false;
        button.classList.remove("btn-loading");
      }
    });
  },

  async deleteMatchedTrip(tripId, popup) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Matched Trip",
      message: "Are you sure you want to delete this matched trip?",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) {
      return;
    }

    try {
      const response = await utils.fetchWithRetry(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (response) {
        popup.remove();
        notificationManager.show("Matched trip deleted successfully", "success");
        const dataManager = (await import("./data-manager.js")).default;
        await dataManager.updateMap();
      }
    } catch (error) {
      console.error("Error deleting matched trip:", error);
      notificationManager.show(error.message, "danger");
    }
  },

  async deleteTrip(tripId, popup) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message:
        "Are you sure you want to delete this trip? This action cannot be undone.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) {
      return;
    }

    try {
      const response = await utils.fetchWithRetry(`/api/trips/${tripId}`, {
        method: "DELETE",
      });
      if (response) {
        popup.remove();
        notificationManager.show("Trip deleted successfully", "success");
        const dataManager = (await import("./data-manager.js")).default;
        await dataManager.updateMap();
      }
    } catch (error) {
      console.error("Error deleting trip:", error);
      notificationManager.show(error.message, "danger");
    }
  },

  async rematchTrip(tripId, popup) {
    try {
      notificationManager.show("Starting map matching...", "info");
      const response = await utils.fetchWithRetry(`/api/process_trip/${tripId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ map_match: true }),
      });
      if (response) {
        popup.remove();
        notificationManager.show("Trip map matching completed", "success");

        // Clear API cache for matched trips to ensure fresh data
        if (utils._apiCache) {
          // Clear all cached entries for matched trips
          for (const [key] of utils._apiCache) {
            if (key.includes("/api/matched_trips")) {
              utils._apiCache.delete(key);
            }
          }
        }

        const dataManager = (await import("./data-manager.js")).default;

        // Ensure matched trips layer is visible so user can see the newly matched trip
        const wasVisible = state.mapLayers.matchedTrips.visible;
        if (!wasVisible) {
          state.mapLayers.matchedTrips.visible = true;
          const toggle = document.getElementById("matchedTrips-toggle");
          if (toggle) {
            toggle.checked = true;
          }
        }

        // Force refresh matched trips layer (fetchMatchedTrips now works regardless of visibility)
        await dataManager.fetchMatchedTrips();

        // Also refresh trips layer in case the original trip was updated
        if (state.mapLayers.trips.visible) {
          await dataManager.fetchTrips();
        }

        // Apply visibility and refresh styles
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            if (state.map?.getLayer("matchedTrips-layer")) {
              state.map.setLayoutProperty(
                "matchedTrips-layer",
                "visibility",
                "visible"
              );
            }
            mapManager.refreshTripStyles();
            resolve();
          });
        });
      }
    } catch (error) {
      console.error("Error remapping trip:", error);
      notificationManager.show(error.message, "danger");
    }
  },
};

export default tripInteractions;
