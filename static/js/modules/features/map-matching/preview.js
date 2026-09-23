/**
 * The matched-trips preview: its map, the trip table beside it, the
 * focused trip, and the bulk selection.
 */

import { CONFIG } from "../../core/config.js";
import { createMap } from "../../map-core.js";
import { clearInlineStatus, setInlineStatus } from "../settings/status-utils.js";
import { elements } from "./context.js";
import { buildBoundsFromGeojson, formatTripDate } from "./labels.js";

let matchedPreviewMap = null;
let matchedPreviewMapReady = false;
let matchedPreviewPendingGeojson = null;
let matchedPreviewFeaturesById = new Map();
let matchedPreviewSelectedId = null;
export let matchedSelection = new Set();

// ========================================
// Core Functions
// ========================================

/** Drop the focused trip from the preview map and its table row. */
export function clearFocusedTrip() {
  matchedPreviewSelectedId = null;
  setFocusedTripUI(null);
}

/** Start a fresh bulk selection of matched trips. */
export function resetMatchedSelection() {
  matchedSelection = new Set();
}

export function destroyPreviewMap() {
  if (matchedPreviewMap) {
    try {
      matchedPreviewMap.remove();
    } catch {
      // Ignore cleanup errors.
    }
  }
  matchedPreviewMap = null;
  matchedPreviewMapReady = false;
  matchedPreviewPendingGeojson = null;
  matchedPreviewFeaturesById = new Map();
  matchedPreviewSelectedId = null;
}

function getMatchedPreviewColor() {
  if (!elements.previewMap) {
    return CONFIG.LAYER_DEFAULTS.matchedTrips.color;
  }
  const container = elements.previewMap.closest(".mm-results-map-container");
  if (!container) {
    return CONFIG.LAYER_DEFAULTS.matchedTrips.color;
  }
  const color = getComputedStyle(container).getPropertyValue("--matched-preview-color");
  return color?.trim() || CONFIG.LAYER_DEFAULTS.matchedTrips.color;
}

function ensureMatchedPreviewMap() {
  if (!elements.previewMap) {
    return null;
  }
  if (matchedPreviewMap) {
    return matchedPreviewMap;
  }
  try {
    matchedPreviewMap = createMap("map-match-preview-map", {
      center: [-96.5, 37.5],
      zoom: 3.4,
      interactive: true,
    });
  } catch (error) {
    const message =
      error?.message || "Map preview could not be initialized for this map provider.";
    setInlineStatus(elements.previewMapStatus, message, "danger");
    return null;
  }

  matchedPreviewMap.scrollZoom?.disable?.();
  matchedPreviewMap.boxZoom?.disable?.();
  matchedPreviewMap.dragRotate?.disable?.();
  matchedPreviewMap.keyboard?.disable?.();
  matchedPreviewMap.doubleClickZoom?.disable?.();
  matchedPreviewMap.touchZoomRotate?.disableRotation?.();

  matchedPreviewMap.on("load", () => {
    matchedPreviewMapReady = true;
    if (matchedPreviewPendingGeojson) {
      updateMatchedPreviewMap(matchedPreviewPendingGeojson);
      matchedPreviewPendingGeojson = null;
    }
  });

  return matchedPreviewMap;
}

export function updateMatchedPreviewEmptyState(message) {
  if (!elements.previewMapEmpty) {
    return;
  }
  if (message) {
    const content = elements.previewMapEmpty.querySelector(
      ".mm-empty-map-content span, .empty-map-content span"
    );
    if (content) {
      content.textContent = message;
    }
    elements.previewMapEmpty.classList.remove("d-none");
  } else {
    elements.previewMapEmpty.classList.add("d-none");
  }
}

export function updateMatchedSelectionUI() {
  const total = elements.resultsTrips
    ? elements.resultsTrips.querySelectorAll(".result-trip-select input").length
    : 0;
  const selectedCount = matchedSelection.size;

  if (elements.previewSelectionCount) {
    elements.previewSelectionCount.textContent = `${selectedCount} selected`;
  }

  // Show/hide bulk actions
  if (elements.bulkActions) {
    elements.bulkActions.classList.toggle("d-none", selectedCount === 0);
  }

  if (elements.previewSelectAll) {
    const allSelected = total > 0 && selectedCount === total;
    elements.previewSelectAll.checked = allSelected;
    elements.previewSelectAll.indeterminate = selectedCount > 0 && !allSelected;
    elements.previewSelectAll.disabled = total === 0;
  }

  const disableActions = selectedCount === 0;
  if (elements.previewClearSelection) {
    elements.previewClearSelection.disabled = disableActions;
  }
  if (elements.previewUnmatchSelected) {
    elements.previewUnmatchSelected.disabled = disableActions;
  }
  if (elements.previewDeleteSelected) {
    elements.previewDeleteSelected.disabled = disableActions;
  }
}

function syncSelectionStyles() {
  if (elements.resultsTrips) {
    elements.resultsTrips.querySelectorAll(".result-trip").forEach((card) => {
      const tripId = String(card.dataset.tripId || "");
      const isSelected = matchedSelection.has(tripId);
      card.classList.toggle("is-selected", isSelected);
      const checkbox = card.querySelector(".result-trip-select input");
      if (checkbox) {
        checkbox.checked = isSelected;
      }
    });
  }
}

function setFocusedTripUI(tripId) {
  const normalized = tripId ? String(tripId) : null;
  if (elements.resultsTrips) {
    elements.resultsTrips.querySelectorAll(".result-trip").forEach((card) => {
      const cardId = String(card.dataset.tripId || "");
      const isFocused = normalized !== null && cardId === normalized;
      card.classList.toggle("is-focused", isFocused);
    });
  }
}

function syncSelectionWithRows(tripIds) {
  const allowed = new Set(tripIds.filter(Boolean).map(String));
  matchedSelection = new Set(
    Array.from(matchedSelection).filter((id) => allowed.has(id))
  );
  updateMatchedSelectionUI();
}

export function setSelection(tripId, checked) {
  if (!tripId) {
    return;
  }
  const normalized = String(tripId);
  if (checked) {
    matchedSelection.add(normalized);
  } else {
    matchedSelection.delete(normalized);
  }
  clearInlineStatus(elements.previewActionsStatus);
  syncSelectionStyles();
  updateMatchedSelectionUI();
}

export function clearSelection() {
  matchedSelection = new Set();
  syncSelectionStyles();
  clearInlineStatus(elements.previewActionsStatus);
  updateMatchedSelectionUI();
}

export function selectAllVisible(checked) {
  matchedSelection = new Set();
  if (checked && elements.resultsTrips) {
    elements.resultsTrips
      .querySelectorAll(".result-trip-select input")
      .forEach((checkbox) => {
        const tripId = String(checkbox.dataset.tripId || "");
        if (tripId) {
          matchedSelection.add(tripId);
        }
      });
  }
  syncSelectionStyles();
  clearInlineStatus(elements.previewActionsStatus);
  updateMatchedSelectionUI();
}

export function updateMatchedPreviewMap(geojson) {
  const map = ensureMatchedPreviewMap();
  if (!map || !geojson) {
    return;
  }
  matchedPreviewFeaturesById = new Map();
  (geojson.features || []).forEach((feature) => {
    const tripId = feature?.properties?.transactionId;
    if (tripId) {
      matchedPreviewFeaturesById.set(String(tripId), feature);
    }
  });
  if (!matchedPreviewMapReady) {
    matchedPreviewPendingGeojson = geojson;
    return;
  }

  const sourceId = "matched-preview-source";
  const layerId = "matched-preview-layer";
  const highlightId = "matched-preview-highlight";
  const color = getMatchedPreviewColor();
  const { highlightColor } = CONFIG.LAYER_DEFAULTS.matchedTrips;

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, {
      type: "geojson",
      data: geojson,
      promoteId: "transactionId",
    });
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": color,
        "line-opacity": 0.8,
        "line-width": 3,
      },
    });
    map.addLayer({
      id: highlightId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": highlightColor || "#8aa7df",
        "line-opacity": 0.95,
        "line-width": 6,
      },
      filter: ["==", ["get", "transactionId"], ""],
    });
  }

  if (map.getLayer(highlightId)) {
    map.setFilter(
      highlightId,
      matchedPreviewSelectedId
        ? ["==", ["get", "transactionId"], matchedPreviewSelectedId]
        : ["==", ["get", "transactionId"], ""]
    );
  }

  const bounds = buildBoundsFromGeojson(geojson);
  if (bounds) {
    map.fitBounds(bounds, { padding: 40, duration: 600 });
    updateMatchedPreviewEmptyState(null);
  } else {
    updateMatchedPreviewEmptyState("No routes to display");
  }
}

export function updateMatchedPreviewTable(data) {
  const total = data?.total || 0;
  const sample = data?.sample || [];

  // Update summary
  if (elements.previewMapSummary) {
    if (total > 0) {
      elements.previewMapSummary.textContent = `${total} matched trip${total !== 1 ? "s" : ""}`;
    } else {
      elements.previewMapSummary.textContent = "No matched trips yet";
    }
  }

  // Update results count
  if (elements.resultsCount) {
    elements.resultsCount.textContent =
      total > 0 ? `${total} trip${total !== 1 ? "s" : ""}` : "No trips yet";
  }

  if (!total) {
    updateMatchedPreviewEmptyState("No matched trips yet");
  }

  matchedPreviewFeaturesById = new Map();

  // Render as cards in new UI
  if (elements.resultsTrips) {
    elements.resultsTrips.innerHTML = sample
      .map((trip) => {
        const tripId = trip.transactionId || "";
        const dateStr = formatTripDate(trip.startTime);
        let distance = "";
        if (trip.distance != null && !Number.isNaN(Number(trip.distance))) {
          distance = `${Number(trip.distance).toFixed(1)} mi`;
        }
        const isSelected = matchedSelection.has(String(tripId));
        return `
          <div class="result-trip ${isSelected ? "is-selected" : ""}" data-trip-id="${tripId}">
            <div class="result-trip-select">
              <input type="checkbox" class="form-check-input" data-trip-id="${tripId}" ${isSelected ? "checked" : ""} />
            </div>
            <div class="result-trip-info">
              <div class="result-trip-date">${dateStr}</div>
              <div class="result-trip-details">${distance}</div>
            </div>
            <div class="result-trip-actions">
              <button class="btn btn-ghost btn-sm" data-action="unmatch" data-trip-id="${tripId}" title="Remove match" aria-label="Remove trip match">
                <i class="fas fa-undo"></i>
              </button>
              <button class="btn btn-ghost btn-sm text-danger" data-action="delete" data-trip-id="${tripId}" title="Delete trip" aria-label="Delete trip">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  syncSelectionWithRows(sample.map((trip) => String(trip.transactionId || "")));
}

export function focusMatchedPreviewTrip(tripId) {
  if (!tripId) {
    return;
  }
  matchedPreviewSelectedId = String(tripId);
  setFocusedTripUI(matchedPreviewSelectedId);
  const map = ensureMatchedPreviewMap();
  if (map?.getLayer("matched-preview-highlight")) {
    map.setFilter("matched-preview-highlight", [
      "==",
      ["get", "transactionId"],
      matchedPreviewSelectedId,
    ]);
  }
  const feature = matchedPreviewFeaturesById.get(matchedPreviewSelectedId);
  if (feature) {
    const bounds = buildBoundsFromGeojson({
      type: "FeatureCollection",
      features: [feature],
    });
    if (bounds) {
      map.fitBounds(bounds, { padding: 60, duration: 500 });
    }
  }
}
