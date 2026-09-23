/**
 * The open area's street map: viewport street loading, layer inks, hover
 * and selection, the street detail panel, and marking a segment driven,
 * undriven, or undriveable.
 */

import { acquireExplorationMap } from "../../core/exploration-map.js";
import { readToken } from "../../core/theme-tokens.js";
import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml } from "../../utils.js";
import {
  getNextActiveMapFilters,
  getStatusFiltersForMapFilters,
  isAllMapFilterActive,
  normalizeMapFilter,
} from "./map-filter.js";
import { formatMiles } from "./stats.js";
import { apiGet, apiPatch, state } from "./context.js";
import {
  formatHighwayType,
  formatPopupDate,
  formatStatus,
  getStreetDisplayName,
} from "./street-format.js";
import { refreshDashboardStats } from "./area-dashboard.js";

const STREET_LAYERS = ["streets-undriven", "streets-driven", "streets-undriveable"];
export const HIGHLIGHT_LAYER_ID = "streets-highlight";
const HOVER_LAYER_ID = "streets-hover";

/** Street layers print in the map inks the legend names. */
const STREET_LAYER_INKS = {
  "streets-undriven": "--map-undriven",
  "streets-driven": "--map-driven",
  "streets-undriveable": "--map-undriveable",
  [HOVER_LAYER_ID]: "--basemap-halo",
  [HIGHLIGHT_LAYER_ID]: "--map-route",
};

export function inkStreetLayers() {
  const { map } = state;
  if (!map) {
    return;
  }
  for (const [layerId, token] of Object.entries(STREET_LAYER_INKS)) {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, "line-color", readToken(token));
    }
  }
}

// =============================================================================
// Map
// =============================================================================

export async function initOrUpdateMap(areaId, bbox, areaSyncToken = null) {
  if (!state.map) {
    // Remove loading spinner
    const loadingEl = document.getElementById("map-loading-state");
    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
    let accessToken;
    if (isMapboxStyleUrl(styleUrl)) {
      accessToken = await waitForMapboxToken({ timeoutMs: 5000 });
    }

    state.map = acquireExplorationMap("coverage-map", {
      style: styleUrl,
      accessToken,
      bounds: [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      fitBoundsOptions: { padding: 50 },
      attributionControl: false,
    });

    state.map.on(
      "moveend",
      debounce(() => loadStreets(state.currentAreaId, state.currentAreaSyncToken), 150)
    );
    state.map.on("load", () => {
      if (state.currentAreaId) {
        loadStreets(state.currentAreaId, state.currentAreaSyncToken);
      }
      state.map.resize();
    });
  } else {
    state.map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 50 }
    );
    loadStreets(areaId, areaSyncToken);
    setTimeout(() => state.map.resize(), 100);
  }
}

function buildStreetsCacheKey(areaId, syncToken) {
  return `${areaId}:${syncToken || "unsynced"}`;
}

export async function loadStreets(areaId, areaSyncToken = null, retry = true) {
  if (!state.map || !areaId) {
    return;
  }

  const requestId = ++state.streetsLoadRequestId;
  const bounds = state.map.getBounds();
  const params = new URLSearchParams({
    min_lon: Math.max(-180, bounds.getWest()).toFixed(6),
    min_lat: Math.max(-90, bounds.getSouth()).toFixed(6),
    max_lon: Math.min(180, bounds.getEast()).toFixed(6),
    max_lat: Math.min(90, bounds.getNorth()).toFixed(6),
    revision: String(areaSyncToken),
  });
  const cacheKey = buildStreetsCacheKey(areaId, `${areaSyncToken}:${params}`);

  // Already rendered this version
  if (cacheKey === state.renderedStreetsCacheKey && state.map.getSource("streets")) {
    return;
  }

  state.viewportAbort?.abort();
  state.viewportAbort = new AbortController();
  try {
    let data = state.streetsCacheKey === cacheKey ? state.streetsCacheGeojson : null;
    if (!data) {
      data = await apiGet(`/areas/${areaId}/streets/geojson?${params}`, {
        signal: state.viewportAbort.signal,
        cache: false,
      });
    }

    if (
      requestId !== state.streetsLoadRequestId ||
      areaId !== state.currentAreaId ||
      !state.map
    ) {
      return;
    }

    state.streetsCacheKey = cacheKey;
    state.streetsCacheGeojson = data;
    let notice = document.getElementById("coverage-viewport-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "coverage-viewport-notice";
      notice.className = "coverage-viewport-notice";
      notice.setAttribute("role", "status");
      document.querySelector(".coverage-map-wrapper")?.appendChild(notice);
    }
    notice.hidden = !data.truncated;
    notice.textContent = "Zoom in to see all streets in this view.";
    if (state.map.getSource("streets")) {
      state.map.getSource("streets").setData(data);
      state.renderedStreetsCacheKey = cacheKey;
    } else {
      state.map.addSource("streets", { type: "geojson", data });
      state.renderedStreetsCacheKey = cacheKey;

      // Undriven streets
      state.map.addLayer({
        id: "streets-undriven",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "undriven"],
        paint: { "line-width": 4, "line-opacity": 0.85 },
      });

      // Driven streets
      state.map.addLayer({
        id: "streets-driven",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "driven"],
        paint: { "line-width": 4, "line-opacity": 0.85 },
      });

      // Undriveable streets (dashed)
      state.map.addLayer({
        id: "streets-undriveable",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "undriveable"],
        paint: {
          "line-width": 2,
          "line-opacity": 0.5,
          "line-dasharray": [2, 2],
        },
      });

      // Hover layer (a paper halo, no pointer events — driven by JS filter)
      state.map.addLayer({
        id: HOVER_LAYER_ID,
        type: "line",
        source: "streets",
        filter: ["==", ["get", "segment_id"], ""],
        paint: { "line-width": 7, "line-opacity": 0.5 },
      });

      // Highlight layer (selected segment, on top)
      state.map.addLayer({
        id: HIGHLIGHT_LAYER_ID,
        type: "line",
        source: "streets",
        filter: ["==", ["get", "segment_id"], ""],
        paint: { "line-width": 6, "line-opacity": 0.95 },
      });

      inkStreetLayers();
      setupStreetInteractivity();
    }
  } catch (error) {
    if (error.status === 409 && retry && areaId === state.currentAreaId) {
      await refreshDashboardStats(areaId);
      return loadStreets(areaId, state.currentAreaSyncToken, false);
    }
    if (error.name !== "AbortError")
      notificationManager.show(`Street map unavailable: ${error.message}`, "warning");
  }
}

function setupStreetInteractivity() {
  if (!state.map || state.streetInteractivityReady) {
    return;
  }
  state.streetInteractivityReady = true;

  // Create a lightweight hover popup (no close button, no pointer events)
  state.hoverPopup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: "coverage-hover-popup",
    offset: 8,
  });

  // Click → open detail panel
  STREET_LAYERS.forEach((layerId) => {
    if (!state.map.getLayer(layerId)) {
      return;
    }
    state.map.on("click", layerId, handleStreetClick);
    state.map.on("mousemove", layerId, handleStreetMouseMove);
    state.map.on("mouseleave", layerId, handleStreetMouseLeave);
  });

  // Click on empty map → close detail panel
  state.map.on("click", (e) => {
    const features = state.map.queryRenderedFeatures(e.point, {
      layers: STREET_LAYERS,
    });
    if (!features.length) {
      closeStreetDetailPanel();
    }
  });
}

function handleStreetMouseMove(e) {
  if (!state.map) {
    return;
  }
  const feature = e.features?.[0];
  if (!feature) {
    return;
  }

  const sid = feature.properties?.segment_id;
  if (sid !== state.hoveredSegmentId) {
    state.hoveredSegmentId = sid;
    state.map.setFilter(HOVER_LAYER_ID, ["==", ["get", "segment_id"], sid || ""]);
    state.map.getCanvas().style.cursor = "pointer";

    // Show lightweight name tooltip
    const name = getStreetDisplayName(feature.properties?.street_name, sid);
    state.hoverPopup
      .setLngLat(e.lngLat)
      .setHTML(`<span>${escapeHtml(name)}</span>`)
      .addTo(state.map);
  } else {
    state.hoverPopup.setLngLat(e.lngLat);
  }
}

function handleStreetMouseLeave() {
  if (!state.map) {
    return;
  }
  state.hoveredSegmentId = null;
  state.map.setFilter(HOVER_LAYER_ID, ["==", ["get", "segment_id"], ""]);
  state.map.getCanvas().style.cursor = "";
  state.hoverPopup?.remove();
}

function handleStreetClick(event) {
  const feature = event.features?.[0];
  if (!feature || !state.map) {
    return;
  }
  state.hoverPopup?.remove();
  openStreetDetailPanel(feature);
}

export function applyMapFilter(filter) {
  state.currentMapFilters = getNextActiveMapFilters(state.currentMapFilters, filter);
  const activeStatusFilters = new Set(
    getStatusFiltersForMapFilters(state.currentMapFilters)
  );
  const showingAllFilters = isAllMapFilterActive(state.currentMapFilters);

  // Update filter chip UI
  document.querySelectorAll(".map-filter-chip").forEach((chip) => {
    const chipFilter = normalizeMapFilter(chip.dataset.filter || "all");
    const active =
      chipFilter === "all"
        ? showingAllFilters
        : !showingAllFilters && activeStatusFilters.has(chipFilter);
    chip.classList.toggle("map-filter-chip--active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  });

  // Update layer visibility
  if (!state.map) {
    return;
  }
  STREET_LAYERS.forEach((layerId) => {
    if (!state.map.getLayer(layerId)) {
      return;
    }
    let visible = "visible";
    if (layerId === "streets-driven" && !activeStatusFilters.has("driven")) {
      visible = "none";
    }
    if (layerId === "streets-undriven" && !activeStatusFilters.has("undriven")) {
      visible = "none";
    }
    if (layerId === "streets-undriveable" && !showingAllFilters) {
      visible = "none";
    }
    state.map.setLayoutProperty(layerId, "visibility", visible);
  });

  updateHighlightFilter();
}

function setHighlightedSegment(segmentId) {
  if (!state.map || !state.map.getLayer(HIGHLIGHT_LAYER_ID)) {
    return;
  }

  if (!segmentId) {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, ["==", ["get", "segment_id"], ""]);
    return;
  }

  const baseFilter = ["==", ["get", "segment_id"], segmentId];

  const activeStatusFilters = getStatusFiltersForMapFilters(state.currentMapFilters);
  if (isAllMapFilterActive(state.currentMapFilters)) {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, baseFilter);
    return;
  }

  if (activeStatusFilters.length === 1) {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      ["==", ["get", "status"], activeStatusFilters[0]],
    ]);
  } else {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      [
        "any",
        ["==", ["get", "status"], "driven"],
        ["==", ["get", "status"], "undriven"],
      ],
    ]);
  }
}

function updateHighlightFilter() {
  setHighlightedSegment(state.selectedSegment?.segmentId || null);
}

// =============================================================================
// Street Detail Panel
// =============================================================================

function openStreetDetailPanel(feature) {
  const props = feature.properties || {};
  const segmentId = props.segment_id;
  const status =
    typeof props.status === "string"
      ? (props.segment_status || props.status).toLowerCase()
      : "unknown";

  state.selectedSegment = { segmentId, properties: props };

  // Populate panel fields
  const nameEl = document.getElementById("street-detail-name");
  if (nameEl) {
    nameEl.textContent = getStreetDisplayName(props.street_name, segmentId);
  }

  const statusChipEl = document.getElementById("street-detail-status-chip");
  if (statusChipEl) {
    statusChipEl.textContent =
      props.coverage_fraction > 0 && props.coverage_fraction < 1
        ? `Partly covered · ${(props.coverage_fraction * 100).toFixed(0)}%`
        : formatStatus(status);
    statusChipEl.className = `street-status-chip status-${status}`;
  }

  const typeEl = document.getElementById("street-detail-type");
  if (typeEl) {
    typeEl.textContent = formatHighwayType(props.highway_type);
  }

  const lengthEl = document.getElementById("street-detail-length");
  if (lengthEl) {
    lengthEl.textContent = formatMiles(props.length_miles);
  }

  const firstEl = document.getElementById("street-detail-first");
  if (firstEl) {
    firstEl.textContent = formatPopupDate(props.first_driven_at, status);
  }

  const lastEl = document.getElementById("street-detail-last");
  if (lastEl) {
    lastEl.textContent = formatPopupDate(props.last_driven_at, status);
  }

  // Show/hide action buttons based on current status
  const drivenBtn = document.getElementById("street-mark-driven-btn");
  const undriveableBtn = document.getElementById("street-mark-undriveable-btn");
  const undrivenBtn = document.getElementById("street-mark-undriven-btn");

  if (drivenBtn) {
    drivenBtn.classList.toggle("d-none", status === "driven");
  }
  if (undriveableBtn) {
    undriveableBtn.classList.toggle("d-none", status === "undriveable");
  }
  if (undrivenBtn) {
    undrivenBtn.classList.toggle("d-none", status === "undriven");
  }

  document.getElementById("street-detail-covered").textContent = formatMiles(
    props.covered_length_miles
  );
  document.getElementById("street-detail-remaining").textContent = formatMiles(
    props.remaining_length_miles
  );
  document.getElementById("street-detail-source").textContent = props.manually_marked
    ? "Your correction"
    : props.trip_count
      ? `${props.trip_count} historical drive${props.trip_count === 1 ? "" : "s"}`
      : "No drive evidence";
  document
    .getElementById("street-restore-automatic-btn")
    .classList.toggle("d-none", !props.manually_marked);
  void loadStreetEvidence(state.currentAreaId, segmentId);

  // Highlight segment on map
  setHighlightedSegment(segmentId);

  // Open panel
  const panel = document.getElementById("street-detail-panel");
  if (panel) {
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
  }
}

async function loadStreetEvidence(areaId, segmentId) {
  try {
    const data = await apiGet(`/areas/${areaId}/streets/${segmentId}`, {
      cache: false,
    });
    if (state.selectedSegment?.segmentId !== segmentId) return;
    const element = document.getElementById("street-detail-evidence");
    element.replaceChildren();
    for (const evidence of data.evidence || []) {
      const link = document.createElement("a");
      link.href = `/trips/${encodeURIComponent(evidence.trip_id)}`;
      link.textContent = `${evidence.source === "matchedGps" ? "Map-matched" : "GPS"} drive · ${new Date(evidence.driven_at).toLocaleDateString()}`;
      const item = document.createElement("li");
      item.append(link);
      element.append(item);
    }
  } catch (error) {
    if (state.selectedSegment?.segmentId === segmentId)
      document.getElementById("street-detail-evidence").textContent =
        `Evidence unavailable: ${error.message}`;
  }
}

export function closeStreetDetailPanel() {
  state.selectedSegment = null;
  setHighlightedSegment(null);

  const panel = document.getElementById("street-detail-panel");
  if (panel) {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
  }
}

// =============================================================================
// Mark Segment Actions
// =============================================================================

export async function applyStreetDecision(areaId, segmentId, status) {
  if (!segmentId) return;
  const buttons = [...document.querySelectorAll("#street-detail-actions button")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await apiPatch(`/areas/${areaId}/streets/${segmentId}`, { status });
    if (state.currentAreaId !== areaId) return;
    const updated = result.states?.[segmentId];
    if (updated) updateStreetStatus(segmentId, updated);
    state.currentAreaData = { ...state.currentAreaData, ...result };
    state.currentAreaSyncToken = `${state.currentAreaData.area_version}:${result.coverage_revision}`;
    await refreshDashboardStats(areaId);
    await loadStreets(areaId, state.currentAreaSyncToken);
    const feature = state.streetsCacheGeojson?.features?.find(
      (item) => item.properties.segment_id === segmentId
    );
    if (feature) openStreetDetailPanel(feature);
    notificationManager.show(
      status === "automatic"
        ? "Automatic coverage restored"
        : "Street correction saved",
      "success"
    );
  } catch (error) {
    notificationManager.show(error.message, "danger");
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
export async function markSegmentDriven(areaId, segmentId) {
  return applyStreetDecision(areaId, segmentId, "driven");
}
export async function markSegmentUndriveable(areaId, segmentId) {
  return applyStreetDecision(areaId, segmentId, "undriveable");
}
export async function markSegmentUndriven(areaId, segmentId) {
  return applyStreetDecision(areaId, segmentId, "undriven");
}

/**
 * Mutates the cached GeoJSON in-place and pushes updated data to the map source.
 * This gives instant visual feedback without a full reload.
 */
function updateStreetStatus(segmentId, serverState) {
  const feature = state.streetsCacheGeojson?.features?.find(
    (item) => item.properties?.segment_id === segmentId
  );
  if (feature)
    Object.assign(feature.properties, serverState, {
      segment_status: serverState.status,
    });
  state.map?.getSource("streets")?.setData(state.streetsCacheGeojson);
  state.renderedStreetsCacheKey = null;
}
