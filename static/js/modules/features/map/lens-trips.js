/**
 * Trips lens — the journal.
 *
 * Renders the current date range as a day-grouped trip log fed by the
 * trip map bundle, keeps it in sync with map selection, and hosts the
 * paths/heat render-mode control plus the matched-trips toggle.
 */

import store from "../../core/store.js";
import layerManager from "../../layer-manager.js";
import mapManager from "../../map-manager.js";
import { escapeHtml, formatCurrency } from "../../utils.js";
import {
  getTripLayerHeatmapPreference,
  setTripLayerHeatmapPreference,
  TRIP_LAYER_RENDER_MODE_EVENT,
} from "./trip-layer-render-mode.js";

const MAX_JOURNAL_ROWS = 200;
const SELECTION_SYNC_MS = 400;

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function formatDurationShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(1, minutes)}m`;
}

function tripDetailRows(trip) {
  const rows = [];
  if (trip.start_location) {
    rows.push(["From", trip.start_location]);
  }
  if (trip.duration_seconds != null) {
    rows.push(["Duration", formatDurationShort(trip.duration_seconds)]);
  }
  if (trip.avg_speed != null) {
    rows.push(["Avg speed", `${Math.round(trip.avg_speed)} mph`]);
  }
  if (trip.max_speed != null) {
    rows.push(["Max speed", `${Math.round(trip.max_speed)} mph`]);
  }
  if (trip.estimated_cost != null) {
    rows.push(["Est. cost", formatCurrency(trip.estimated_cost)]);
  }
  return rows;
}

export default function createTripsLens({ registerCleanup }) {
  const journal = document.getElementById("trip-journal");
  const emptyNote = document.getElementById("trip-journal-empty");
  const pathsBtn = document.getElementById("trip-render-paths");
  const heatBtn = document.getElementById("trip-render-heat");
  const matchedToggle = document.getElementById("matched-trips-toggle");

  let trips = [];
  let selectedTripId = null;
  let syncTimer = null;

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  // ---- Render mode segmented control -------------------------------
  const syncRenderMode = () => {
    const heat = getTripLayerHeatmapPreference();
    pathsBtn?.setAttribute("aria-pressed", String(!heat));
    heatBtn?.setAttribute("aria-pressed", String(heat));
  };

  if (pathsBtn && heatBtn) {
    on(pathsBtn, "click", () => setTripLayerHeatmapPreference(false));
    on(heatBtn, "click", () => setTripLayerHeatmapPreference(true));
    on(document, TRIP_LAYER_RENDER_MODE_EVENT, syncRenderMode);
    syncRenderMode();
  }

  // ---- Matched trips toggle -----------------------------------------
  if (matchedToggle) {
    const syncMatchedToggle = () => {
      matchedToggle.checked = Boolean(store.mapLayers?.matchedTrips?.visible);
    };
    syncMatchedToggle();
    on(matchedToggle, "change", async () => {
      await layerManager.toggleLayer("matchedTrips", matchedToggle.checked);
    });
    // Visibility can change elsewhere (restored settings, style reloads).
    on(document, "es:layers-change", syncMatchedToggle);
  }

  // ---- Journal --------------------------------------------------------
  const findRow = (tripId) =>
    journal?.querySelector(`[data-trip-id="${CSS.escape(String(tripId))}"]`);

  const collapseRow = (row) => {
    row.classList.remove("is-selected");
    row.querySelector(".journal-details")?.remove();
  };

  const expandRow = (row, trip) => {
    if (row.querySelector(".journal-details")) {
      return;
    }
    const dl = document.createElement("dl");
    dl.className = "journal-details";
    dl.innerHTML = tripDetailRows(trip)
      .map(
        ([label, value]) =>
          `<div class="journal-detail"><dt>${escapeHtml(label)}</dt>` +
          `<dd title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</dd></div>`
      )
      .join("");
    row.appendChild(dl);
    row.classList.add("is-selected");
  };

  const applySelection = (tripId, { scroll = false } = {}) => {
    if (String(tripId || "") === String(selectedTripId || "")) {
      return;
    }
    if (selectedTripId) {
      const previous = findRow(selectedTripId);
      if (previous) {
        collapseRow(previous);
      }
    }
    selectedTripId = tripId || null;
    if (!selectedTripId) {
      return;
    }
    const row = findRow(selectedTripId);
    const trip = trips.find((t) => String(t.id) === String(selectedTripId));
    if (row && trip) {
      expandRow(row, trip);
      if (scroll) {
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  };

  const renderJournal = () => {
    if (!journal) {
      return;
    }

    journal.replaceChildren();
    if (emptyNote) {
      emptyNote.hidden = trips.length > 0;
    }
    if (!trips.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let currentDayKey = null;
    const visibleTrips = trips.slice(0, MAX_JOURNAL_ROWS);

    for (const trip of visibleTrips) {
      const started = new Date(trip.start_time);
      if (Number.isNaN(started.getTime())) {
        continue;
      }

      const dayKey = started.toDateString();
      if (dayKey !== currentDayKey) {
        currentDayKey = dayKey;
        const heading = document.createElement("li");
        heading.className = "journal-day";
        heading.textContent = dayFmt.format(started);
        fragment.appendChild(heading);
      }

      const li = document.createElement("li");
      li.className = "journal-row";
      li.dataset.tripId = String(trip.id);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "journal-row-main";
      const distance =
        trip.distance_miles != null ? `${trip.distance_miles.toFixed(1)} mi` : "—";
      button.innerHTML =
        `<span class="journal-time">${escapeHtml(timeFmt.format(started))}</span>` +
        `<span class="journal-dest">${escapeHtml(trip.destination || "Unknown destination")}</span>` +
        `<span class="journal-metric">${escapeHtml(distance)}</span>`;
      button.addEventListener("click", () => {
        if (String(selectedTripId) === String(trip.id)) {
          applySelection(null);
          store.selectedTripId = null;
          return;
        }
        applySelection(trip.id);
        mapManager.zoomToTrip(trip.id);
      });

      li.appendChild(button);
      fragment.appendChild(li);
    }

    if (trips.length > MAX_JOURNAL_ROWS) {
      const note = document.createElement("li");
      note.className = "lens-hint";
      note.textContent = `Showing the latest ${MAX_JOURNAL_ROWS} of ${trips.length} trips. Narrow the date range for the full journal.`;
      fragment.appendChild(note);
    }

    journal.appendChild(fragment);

    if (selectedTripId) {
      const row = findRow(selectedTripId);
      const trip = trips.find((t) => String(t.id) === String(selectedTripId));
      if (row && trip) {
        expandRow(row, trip);
      }
    }
  };

  const handleTripsLoaded = (event) => {
    const bundle = event?.detail?.bundle;
    if (!bundle || !Array.isArray(bundle.trips)) {
      return;
    }
    ({ trips } = bundle);
    renderJournal();
  };

  on(document, "tripsDataLoaded", handleTripsLoaded);

  // The initial load's tripsDataLoaded fires before this module exists;
  // seed the journal from the bundle the renderer kept.
  const initialBundle = store.mapLayers?.trips?.layer?.bundle;
  if (Array.isArray(initialBundle?.trips)) {
    ({ trips } = initialBundle);
    renderJournal();
  }

  // Keep journal selection in step with map-side selection (map clicks).
  syncTimer = window.setInterval(() => {
    const storeSelection = store.selectedTripId ? String(store.selectedTripId) : null;
    if (storeSelection !== (selectedTripId ? String(selectedTripId) : null)) {
      applySelection(storeSelection, { scroll: true });
    }
  }, SELECTION_SYNC_MS);
  registerCleanup(() => {
    if (syncTimer) {
      window.clearInterval(syncTimer);
      syncTimer = null;
    }
  });

  return {
    id: "trips",
    activate() {
      if (store.mapLayers?.trips && !store.mapLayers.trips.visible) {
        layerManager.toggleLayer("trips", true);
      }
    },
    deactivate() {
      // Trips remain the base layer for other lenses; nothing to undo.
    },
  };
}
