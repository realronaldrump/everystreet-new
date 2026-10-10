
import state from "./core/store.js";
import mapManager from "./map-manager.js";
import confirmationDialog from "./ui/confirmation-dialog.js";
import notificationManager from "./ui/notifications.js";
import { utils } from "./utils.js";

const tripInteractions = {
  handleTripClick(e, feature, layerName = null, options = {}) {
    if (!feature?.properties) {
      return;
    }

    const tripId =
      feature.properties.transactionId ||
      feature.properties.id ||
      feature.properties.tripId;

    if (tripId) {
      state.selectedTripId = tripId;
      state.selectedTripLayer =
        layerName || this.resolveTripLayerName(feature?.layer?.id);
      mapManager.refreshTripStyles();
    }

    const popup = new mapboxgl.Popup({
      className: "trip-popup",
      closeButton: true,
      closeOnClick: options.closeOnClick !== false,
      maxWidth: "400px",
      anchor: "bottom",
    })
      .setLngLat(e.lngLat)
      .setHTML(this.createPopupContent(feature))
      .addTo(state.map);
    // Attach listeners immediately; Mapbox GL's 'open' can fire before handler registration
    this.setupPopupEventListeners(popup);
    if (options.closeOnClick === false) {
      this.setupDeferredMapClickClose(popup);
    }
  },

  setupDeferredMapClickClose(popup) {
    if (!popup || !state.map?.on || !state.map?.off) {
      return;
    }

    let armed = false;
    const closeOnMapClick = () => {
      if (!armed) {
        return;
      }
      popup.remove();
    };
    const cleanup = () => {
      state.map?.off?.("click", closeOnMapClick);
    };

    popup.on?.("close", cleanup);
    setTimeout(() => {
      armed = true;
      state.map?.on?.("click", closeOnMapClick);
    }, 80);
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

    const toDate = (value) => {
      if (value == null) {
        return null;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        return new Date(ms);
      }
      return new Date(value);
    };

    const isValidDate = (date) => date instanceof Date && !Number.isNaN(date.getTime());
    const formatMetric = (value, digits = 1) => {
      if (value == null) {
        return "N/A";
      }
      const formatted = utils.formatNumber(Number(value), digits);
      return formatted === "--" ? "N/A" : formatted;
    };
    const normalizeDurationSeconds = (value) => {
      if (value == null || value === "") {
        return null;
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        return null;
      }
      return numeric;
    };
    const formatDurationValue = (value) =>
      value == null ? "N/A" : utils.formatDuration(value);
    const normalizeCurrencyAmount = (value) => {
      if (value == null || value === "") {
        return null;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    };
    const formatClock = (date) =>
      date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    const start = toDate(props.startTime);
    const end = toDate(props.endTime);
    const hasStart = isValidDate(start);
    const hasEnd = isValidDate(end);

    let duration = normalizeDurationSeconds(props.duration ?? props.drivingTime);
    if (duration == null && hasStart && hasEnd) {
      duration = (end - start) / 1000;
    }

    const dayLabel = hasStart
      ? start.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Date unknown";
    // A trip past midnight names the day it ended on.
    let endLabel = hasEnd ? formatClock(end) : "N/A";
    if (hasStart && hasEnd && start.toDateString() !== end.toDateString()) {
      endLabel = end.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
    const timeLabel = `${hasStart ? formatClock(start) : "N/A"} – ${endLabel}`;

    const detail = (label, value) => `
            <div class="trip-popup-detail">
              <dt class="figure-label">${label}</dt>
              <dd class="trip-popup-value data-num">${value}</dd>
            </div>`;

    const cost = normalizeCurrencyAmount(props.estimated_cost);

    return `
        <div class="trip-popup-content">
          <header class="trip-popup-head">
            <p class="pm-eyebrow">Trip</p>
            <p class="trip-popup-title">${dayLabel}</p>
            <p class="trip-popup-time data-num">${timeLabel}</p>
          </header>
          <dl class="trip-popup-details">
            ${detail("Distance", `${formatMetric(props.distance)} mi`)}
            ${detail("Duration", formatDurationValue(duration))}
            ${detail("Avg speed", `${formatMetric(props.avgSpeed)} mph`)}
            ${detail("Max speed", `${formatMetric(props.maxSpeed)} mph`)}
            ${cost == null ? "" : detail("Est. cost", utils.formatCurrency(cost))}
          </dl>
          ${this.createActionButtons(feature)}
        </div>
      `;
  },

  createActionButtons(feature) {
    const props = feature.properties || {};
    const isMatched =
      props.source === "matched" ||
      props.mapMatchingStatus === "success" ||
      feature.source?.includes("matched");
    const tripId = props.transactionId || props.id || props.tripId;

    if (!tripId) {
      return "";
    }

    return `
        <div class="trip-popup-actions">
          <a class="btn btn-sm btn-primary view-trip-btn" href="/trips/${encodeURIComponent(tripId)}">
            <i class="fas fa-eye"></i> View
          </a>
          <button class="btn btn-sm btn-secondary rematch-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-route"></i> Rematch
          </button>
          ${
            isMatched
              ? `
            <button class="btn btn-sm btn-outline-danger delete-matched-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-eraser"></i> Clear
            </button>
          `
              : `
            <button class="btn btn-sm btn-outline-danger delete-trip-btn" data-trip-id="${tripId}">
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
        if (button.classList.contains("rematch-trip-btn")) {
          await this.rematchTrip(tripId, popup);
        } else if (button.classList.contains("delete-matched-trip-btn")) {
          await this.deleteMatchedTrip(tripId, popup);
        } else if (button.classList.contains("delete-trip-btn")) {
          await this.deleteTrip(tripId, popup);
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

  async rematchTrip(tripId, popup) {
    const confirmed = await confirmationDialog.show({
      title: "Rematch trip",
      message:
        "This will re-run map matching for this trip, replacing the current matched route with fresh data.",
      confirmText: "Rematch",
      confirmButtonClass: "btn-warning",
    });
    if (!confirmed) {
      return;
    }

    try {
      notificationManager.show("Rematching trip…", "info");
      const response = await utils.fetchWithRetry(`/api/trips/${tripId}/rematch`, {
        method: "POST",
      });
      if (response) {
        popup.remove();
        notificationManager.show("Trip rematched successfully", "success");
        const dataManager = (await import("./data-manager.js")).default;
        await dataManager.updateMap();
      }
    } catch (error) {
      console.error("Error rematching trip:", error);
      notificationManager.show(error.message || "Rematch failed", "danger");
    }
  },

  async deleteMatchedTrip(tripId, popup) {
    const confirmed = await confirmationDialog.show({
      title: "Clear matched route",
      message:
        "This keeps the trip but removes the snapped route. You can rematch it later.",
      confirmText: "Clear match",
      confirmButtonClass: "btn-primary",
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
        notificationManager.show("Matched route cleared", "success");
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
};

export default tripInteractions;
