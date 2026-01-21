/* global topojson, mapboxgl */
/**
 * County Map Main Module
 * Main entry point for the county map feature
 */

import notificationManager from "../ui/notifications.js";
import { onPageLoad } from "../utils.js";
import * as CountyMapAPI from "./api.js";
import { getStateName, MAP_CONFIG } from "./constants.js";
import { setupInteractions } from "./interactions.js";
import { addMapLayers, getMapStyle, updateStopLayerVisibility } from "./map-layers.js";
import * as CountyMapState from "./state.js";
import { setupStateStatsToggle } from "./state-stats.js";
import {
  clearStoredRecalcState,
  getStoredRecalcState,
  storeRecalcState,
} from "./storage.js";
import {
  hideLoading,
  setupPanelToggle,
  showRecalculatePrompt,
  updateLastUpdated,
  updateLoadingText,
  updateRecalculateUi,
  updateStats,
} from "./ui.js";

/**
 * Initialize the county map
 */
export function init({ cleanup } = {}) {
  updateLoadingText("Initializing map...");

  // Create map with standard projection (not Albers - TopoJSON is unprojected)
  mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

  const map = new mapboxgl.Map({
    container: "county-map",
    style: getMapStyle(),
    center: MAP_CONFIG.center,
    zoom: MAP_CONFIG.zoom,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    attributionControl: false,
  });

  CountyMapState.setMap(map);
  if (typeof cleanup === "function") {
    cleanup(() => {
      const activeMap = CountyMapState.getMap();
      if (activeMap) {
        try {
          activeMap.remove();
        } catch {
          // Ignore map cleanup errors.
        }
      }
      CountyMapState.resetState?.();
    });
  }

  // Add navigation controls
  map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

  // Wait for map to load
  map.on("load", async () => {
    try {
      updateLoadingText("Loading county boundaries...");
      await loadCountyData();

      updateLoadingText("Loading visited counties...");
      await loadVisitedCounties();

      updateLoadingText("Rendering map...");
      addMapLayers();
      updateStopLayerVisibility();

      hideLoading();
      setupInteractions();
      updateStats();
    } catch (error) {
      updateLoadingText(`Error: ${error.message}`);
    }
  });

  // Setup panel toggle and recalculate button
  setupPanelToggle();
  setupRecalculateButton();
  setupStateStatsToggle();
  setupStopToggle();
  resumeRecalculateIfNeeded();
}

/**
 * Load TopoJSON county data
 */
async function loadCountyData() {
  const topology = await CountyMapAPI.fetchCountyTopology();

  // Convert TopoJSON to GeoJSON using topojson-client library
  const countyData = topojson.feature(topology, topology.objects.counties);
  const statesData = topojson.feature(topology, topology.objects.states);

  // Add state FIPS and names to each county
  countyData.features.forEach((feature) => {
    const fips = String(feature.id).padStart(5, "0");
    const stateFips = fips.substring(0, 2);
    feature.properties = feature.properties || {};
    feature.properties.fips = fips;
    feature.properties.stateFips = stateFips;
    feature.properties.stateName = getStateName(stateFips);
    feature.properties.visited = false;
    feature.properties.stopped = false;
  });

  CountyMapState.setCountyData(countyData);
  CountyMapState.setStatesData(statesData);
}

/**
 * Load visited counties from API (cached)
 */
async function loadVisitedCounties() {
  try {
    const data = await CountyMapAPI.fetchVisitedCounties();
    const recalcState = getStoredRecalcState();
    const countyData = CountyMapState.getCountyData();

    const hasVisits = data.counties && Object.keys(data.counties).length > 0;
    const hasStops
      = data.stoppedCounties && Object.keys(data.stoppedCounties).length > 0;

    if (data.success && (hasVisits || hasStops)) {
      // Store county visits data (includes dates)
      const countyVisits = data.counties || {};
      const countyStops = data.stoppedCounties || {};

      CountyMapState.setCountyVisits(countyVisits);
      CountyMapState.setCountyStops(countyStops);

      // Mark counties as visited
      countyData.features.forEach((feature) => {
        const { fips } = feature.properties;
        if (countyVisits[fips]) {
          feature.properties.visited = true;
        }
        if (countyStops[fips]) {
          feature.properties.stopped = true;
        }
      });

      // Show last updated time if available
      if (data.lastUpdated) {
        const lastUpdated = new Date(data.lastUpdated);
        updateLastUpdated(data.lastUpdated);

        if (
          recalcState
          && lastUpdated > recalcState.startedAt
          && CountyMapState.getIsRecalculating()
        ) {
          clearRecalcState();
        }
      }
    } else if (!data.cached) {
      // No cache - prompt user to calculate
      showRecalculatePrompt(triggerRecalculate);
      if (recalcState) {
        updateRecalculateUi(true, "Recalculating county data...");
      }
    }

    if (recalcState && CountyMapState.getIsRecalculating()) {
      startRecalculatePolling(recalcState.startedAt);
    }
  } catch (error) {
    console.warn("Failed to load visited counties", error);
  }
}

/**
 * Clear recalculation state
 */
function clearRecalcState() {
  clearStoredRecalcState();
  CountyMapState.setIsRecalculating(false);
  CountyMapState.setRecalcPollerActive(false);
  updateRecalculateUi(false);
}

/**
 * Trigger recalculation of county data
 */
async function triggerRecalculate() {
  if (CountyMapState.getIsRecalculating()) {
    return;
  }

  const startedAt = new Date();
  CountyMapState.setIsRecalculating(true);
  storeRecalcState(startedAt);
  updateRecalculateUi(true, "Recalculating county data...");

  try {
    const data = await CountyMapAPI.triggerRecalculation();

    if (data.success) {
      // Poll for completion
      setTimeout(() => startRecalculatePolling(startedAt), 3000);
    } else {
      notificationManager.show(
        `Error starting calculation: ${data.error}`,
        "danger"
      );
      clearRecalcState();
    }
  } catch {
    clearRecalcState();
  }
}

/**
 * Start polling for recalculation completion
 * @param {Date} startedAt - When recalculation started
 */
function startRecalculatePolling(startedAt) {
  if (CountyMapState.getRecalcPollerActive()) {
    return;
  }
  CountyMapState.setRecalcPollerActive(true);
  setTimeout(() => checkAndRefresh(startedAt), 2000);
}

/**
 * Check if calculation is done and refresh
 * @param {Date} startedAt - When recalculation started
 */
async function checkAndRefresh(startedAt) {
  if (!CountyMapState.getIsRecalculating()) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }

  try {
    const data = await CountyMapAPI.fetchCacheStatus();

    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    const isUpdated
      = data.cached
      && (startedAt
        ? lastUpdated && lastUpdated > startedAt
        : data.totalVisited > 0 || data.totalStopped > 0);

    if (isUpdated) {
      clearRecalcState();
      window.location.reload();
      return;
    }

    setTimeout(() => checkAndRefresh(startedAt), 2000);
  } catch {
    setTimeout(() => checkAndRefresh(startedAt), 3000);
  }
}

/**
 * Setup recalculate button event listener
 */
function setupRecalculateButton() {
  const btn = document.getElementById("recalculate-btn");
  if (btn) {
    btn.addEventListener("click", triggerRecalculate);
  }
}

/**
 * Setup stop toggle functionality
 */
function setupStopToggle() {
  const toggle = document.getElementById("toggle-stops");
  if (!toggle) {
    return;
  }

  CountyMapState.setShowStoppedCounties(toggle.checked);
  toggle.addEventListener("change", () => {
    CountyMapState.setShowStoppedCounties(toggle.checked);
    updateStopLayerVisibility();
  });
}

/**
 * Resume recalculation if it was in progress
 */
function resumeRecalculateIfNeeded() {
  const recalcState = getStoredRecalcState();
  if (!recalcState) {
    return;
  }
  CountyMapState.setIsRecalculating(true);
  updateRecalculateUi(true, "Recalculating county data...");
}

// Initialize on page load
onPageLoad(init, { route: "/county-map" });
