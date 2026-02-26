/* global topojson, mapboxgl */
/**
 * County Map Main Module
 * Main entry point for the county map feature
 */

import { swupReady } from "../../core/navigation.js";
import * as CountyMapAPI from "../../county-map/api.js";
import { getStateName, MAP_CONFIG } from "../../county-map/constants.js";
import { setupInteractions } from "../../county-map/interactions.js";
import {
  addMapLayers,
  applyCountyVisitFeatureState,
  getMapStyle,
  updateStopLayerVisibility,
} from "../../county-map/map-layers.js";
import * as CountyMapState from "../../county-map/state.js";
import { setupStateStatsToggle } from "../../county-map/state-stats.js";
import {
  clearStoredRecalcState,
  getStoredRecalcState,
  storeRecalcState,
} from "../../county-map/storage.js";
import {
  hideLoading,
  setupPanelToggle,
  showRecalculatePrompt,
  updateLastUpdated,
  updateLoadingText,
  updateRecalculateUi,
  updateStats,
} from "../../county-map/ui.js";
import { getMapboxToken } from "../../mapbox-token.js";
import { createMap } from "../../map-core.js";
import notificationManager from "../../ui/notifications.js";

const MAX_CONTEXT_RECOVERY_ATTEMPTS = 2;
const CONTEXT_RECOVERY_COOLDOWN_MS = 30_000;

let pageSignal = null;
let inFlightRequestController = null;
let contextRecoveryAttempts = 0;
let contextRecoveryLastAttemptAtMs = 0;
let contextRecoveryInProgress = false;

export function canAttemptRecovery({
  attempts,
  lastAttemptAtMs,
  nowMs = Date.now(),
  maxAttempts = MAX_CONTEXT_RECOVERY_ATTEMPTS,
  cooldownMs = CONTEXT_RECOVERY_COOLDOWN_MS,
}) {
  if (attempts >= maxAttempts) {
    return false;
  }
  if (!lastAttemptAtMs) {
    return true;
  }
  return nowMs - lastAttemptAtMs >= cooldownMs;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function abortInFlightRequests() {
  if (inFlightRequestController) {
    inFlightRequestController.abort();
    inFlightRequestController = null;
  }
}

function beginRequestCycle() {
  abortInFlightRequests();
  const controller = new AbortController();
  inFlightRequestController = controller;

  if (pageSignal) {
    if (pageSignal.aborted) {
      controller.abort();
    } else {
      pageSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  return controller.signal;
}

function getCameraState(map) {
  if (!map) {
    return null;
  }
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

function createCountyMap(camera) {
  return createMap("county-map", {
    style: getMapStyle(),
    center: camera?.center || MAP_CONFIG.center,
    zoom: Number.isFinite(camera?.zoom) ? camera.zoom : MAP_CONFIG.zoom,
    bearing: Number.isFinite(camera?.bearing) ? camera.bearing : 0,
    pitch: Number.isFinite(camera?.pitch) ? camera.pitch : 0,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    renderWorldCopies: false,
  });
}

function forEachCoordinate(geometry, callback) {
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return;
  }

  const stack = [geometry.coordinates];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!Array.isArray(current) || current.length === 0) {
      continue;
    }
    if (typeof current[0] === "number") {
      const lng = Number(current[0]);
      const lat = Number(current[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        callback(lng, lat);
      }
      continue;
    }
    for (let i = 0; i < current.length; i += 1) {
      stack.push(current[i]);
    }
  }
}

function buildCountyIndexes(features) {
  const countyToState = {};
  const stateTotals = {};
  const stateBoundsAccumulator = {};

  features.forEach((feature) => {
    const fips = String(feature.id).padStart(5, "0");
    const stateFips = fips.substring(0, 2);
    const stateName = getStateName(stateFips);

    feature.properties = feature.properties || {};
    feature.properties.fips = fips;
    feature.properties.stateFips = stateFips;
    feature.properties.stateName = stateName;

    countyToState[fips] = { stateFips, stateName };

    if (!stateTotals[stateFips]) {
      stateTotals[stateFips] = { name: stateName, total: 0 };
    }
    stateTotals[stateFips].total += 1;

    if (!stateBoundsAccumulator[stateFips]) {
      stateBoundsAccumulator[stateFips] = {
        minLng: Infinity,
        minLat: Infinity,
        maxLng: -Infinity,
        maxLat: -Infinity,
      };
    }

    const bounds = stateBoundsAccumulator[stateFips];
    forEachCoordinate(feature.geometry, (lng, lat) => {
      if (lng < bounds.minLng) {
        bounds.minLng = lng;
      }
      if (lng > bounds.maxLng) {
        bounds.maxLng = lng;
      }
      if (lat < bounds.minLat) {
        bounds.minLat = lat;
      }
      if (lat > bounds.maxLat) {
        bounds.maxLat = lat;
      }
    });
  });

  const stateBounds = {};
  Object.entries(stateBoundsAccumulator).forEach(([stateFips, bounds]) => {
    if (
      Number.isFinite(bounds.minLng) &&
      Number.isFinite(bounds.minLat) &&
      Number.isFinite(bounds.maxLng) &&
      Number.isFinite(bounds.maxLat)
    ) {
      stateBounds[stateFips] = [
        [bounds.minLng, bounds.minLat],
        [bounds.maxLng, bounds.maxLat],
      ];
    }
  });

  return {
    countyToState,
    stateTotals,
    stateBounds,
  };
}

function applyCurrentFeatureState(map) {
  applyCountyVisitFeatureState(
    map,
    CountyMapState.getCountyVisits(),
    CountyMapState.getCountyStops()
  );
}

async function loadCountyData(signal) {
  const topology = await CountyMapAPI.fetchCountyTopology({ signal });
  if (signal?.aborted || pageSignal?.aborted) {
    return;
  }

  const countyData = topojson.feature(topology, topology.objects.counties);
  const statesData = topojson.feature(topology, topology.objects.states);
  const { countyToState, stateTotals, stateBounds } = buildCountyIndexes(
    countyData.features
  );

  CountyMapState.setCountyData(countyData);
  CountyMapState.setStatesData(statesData);
  CountyMapState.setCountyToState(countyToState);
  CountyMapState.setStateTotals(stateTotals);
  CountyMapState.setStateBounds(stateBounds);
  CountyMapState.setTotalCounties(countyData.features.length);
}

async function loadVisitedCounties(signal) {
  const data = await CountyMapAPI.fetchVisitedCounties({ signal });
  if (signal?.aborted || pageSignal?.aborted) {
    return;
  }

  const recalcState = getStoredRecalcState();
  const countyVisits = data.counties || {};
  const countyStops = data.stoppedCounties || {};
  const hasVisits = Object.keys(countyVisits).length > 0;
  const hasStops = Object.keys(countyStops).length > 0;

  if (data.success) {
    CountyMapState.setCountyVisits(countyVisits);
    CountyMapState.setCountyStops(countyStops);

    if (data.lastUpdated) {
      const lastUpdated = new Date(data.lastUpdated);
      updateLastUpdated(data.lastUpdated);
      if (
        recalcState &&
        lastUpdated > recalcState.startedAt &&
        CountyMapState.getIsRecalculating()
      ) {
        clearRecalcState();
      }
    }

    if (!data.cached && !hasVisits && !hasStops) {
      showRecalculatePrompt(triggerRecalculate);
      if (recalcState) {
        updateRecalculateUi(true, "Recalculating county data...");
      }
    }
  } else if (!data.cached) {
    showRecalculatePrompt(triggerRecalculate);
    if (recalcState) {
      updateRecalculateUi(true, "Recalculating county data...");
    }
  }

  if (recalcState && CountyMapState.getIsRecalculating()) {
    startRecalculatePolling(recalcState.startedAt);
  }
}

async function loadAndRenderCountyMap(map, { recovery = false } = {}) {
  const requestSignal = beginRequestCycle();
  try {
    updateLoadingText("Loading county boundaries...");
    await loadCountyData(requestSignal);
    if (
      requestSignal.aborted ||
      pageSignal?.aborted ||
      map !== CountyMapState.getMap()
    ) {
      return;
    }

    updateLoadingText("Loading visited counties...");
    await loadVisitedCounties(requestSignal);
    if (
      requestSignal.aborted ||
      pageSignal?.aborted ||
      map !== CountyMapState.getMap()
    ) {
      return;
    }

    updateLoadingText("Rendering map...");
    addMapLayers();
    applyCurrentFeatureState(map);
    updateStopLayerVisibility();
    setupInteractions();
    updateStats();
    hideLoading();
  } catch (error) {
    if (isAbortError(error) || requestSignal.aborted || pageSignal?.aborted) {
      return;
    }
    updateLoadingText(`Error: ${error.message}`);
  } finally {
    if (inFlightRequestController?.signal === requestSignal) {
      inFlightRequestController = null;
    }
    if (recovery) {
      contextRecoveryInProgress = false;
    }
  }
}

function recoverFromContextLoss() {
  if (pageSignal?.aborted || contextRecoveryInProgress) {
    return;
  }

  const now = Date.now();
  if (
    !canAttemptRecovery({
      attempts: contextRecoveryAttempts,
      lastAttemptAtMs: contextRecoveryLastAttemptAtMs,
      nowMs: now,
    })
  ) {
    notificationManager.show(
      "Map rendering failed repeatedly. Please refresh the page.",
      "warning"
    );
    return;
  }

  contextRecoveryInProgress = true;
  contextRecoveryAttempts += 1;
  contextRecoveryLastAttemptAtMs = now;

  const currentMap = CountyMapState.getMap();
  const camera = getCameraState(currentMap);
  const showStoppedCounties = CountyMapState.getShowStoppedCounties();
  updateLoadingText("Recovering map rendering...");

  abortInFlightRequests();

  if (currentMap) {
    try {
      currentMap.remove();
    } catch {
      // Ignore teardown errors during context recovery.
    }
  }

  try {
    const replacementMap = createCountyMap(camera);
    CountyMapState.setMap(replacementMap);
    CountyMapState.setShowStoppedCounties(showStoppedCounties);
    bindMapLifecycle(replacementMap, { recovery: true });
  } catch (error) {
    contextRecoveryInProgress = false;
    updateLoadingText(`Error: ${error.message}`);
  }
}

function bindMapLifecycle(map, { recovery = false } = {}) {
  map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

  map.on("webglcontextlost", (event) => {
    if (map !== CountyMapState.getMap()) {
      return;
    }
    event.preventDefault();
    recoverFromContextLoss();
  });

  map.on("webglcontextrestored", () => {
    if (map !== CountyMapState.getMap() || pageSignal?.aborted) {
      return;
    }
    applyCurrentFeatureState(map);
    updateStopLayerVisibility();
  });

  map.on("load", () => {
    loadAndRenderCountyMap(map, { recovery });
  });
}

/**
 * Initialize the county map
 */
export default function initCountyMapPage({ cleanup, signal } = {}) {
  pageSignal = signal || null;
  contextRecoveryAttempts = 0;
  contextRecoveryLastAttemptAtMs = 0;
  contextRecoveryInProgress = false;
  updateLoadingText("Initializing map...");

  const map = createCountyMap();
  CountyMapState.setMap(map);
  bindMapLifecycle(map);

  const teardown = () => {
    pageSignal = null;
    abortInFlightRequests();
    contextRecoveryInProgress = false;
    const activeMap = CountyMapState.getMap();
    if (activeMap) {
      try {
        activeMap.remove();
      } catch {
        // Ignore map cleanup errors.
      }
    }
    CountyMapState.resetState?.();
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  setupPanelToggle();
  setupRecalculateButton(pageSignal);
  setupStateStatsToggle();
  setupStopToggle(pageSignal);
  resumeRecalculateIfNeeded();

  return teardown;
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
    const data = await CountyMapAPI.triggerRecalculation({ signal: pageSignal });
    if (data.success) {
      setTimeout(() => startRecalculatePolling(startedAt), 3000);
    } else {
      notificationManager.show(`Error starting calculation: ${data.error}`, "danger");
      clearRecalcState();
    }
  } catch (error) {
    if (!isAbortError(error)) {
      clearRecalcState();
    }
  }
}

/**
 * Start polling for recalculation completion
 * @param {Date} startedAt - When recalculation started
 */
function startRecalculatePolling(startedAt) {
  if (pageSignal?.aborted) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }
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
  if (pageSignal?.aborted) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }
  if (!CountyMapState.getIsRecalculating()) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }

  try {
    const data = await CountyMapAPI.fetchCacheStatus({ signal: pageSignal });
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    const isUpdated =
      data.cached &&
      (startedAt
        ? lastUpdated && lastUpdated > startedAt
        : data.totalVisited > 0 || data.totalStopped > 0);

    if (isUpdated) {
      clearRecalcState();
      swupReady.then((swup) => {
        swup.navigate(window.location.href, {
          cache: { read: false, write: true },
          history: "replace",
        });
      });
      return;
    }

    if (!pageSignal?.aborted) {
      setTimeout(() => checkAndRefresh(startedAt), 2000);
    }
  } catch (error) {
    if (!isAbortError(error) && !pageSignal?.aborted) {
      setTimeout(() => checkAndRefresh(startedAt), 3000);
    }
  }
}

/**
 * Setup recalculate button event listener
 */
function setupRecalculateButton(signal) {
  const eventOptions = signal ? { signal } : false;
  const btn = document.getElementById("recalculate-btn");
  if (btn) {
    btn.addEventListener("click", triggerRecalculate, eventOptions);
  }
}

/**
 * Setup stop toggle functionality
 */
function setupStopToggle(signal) {
  const eventOptions = signal ? { signal } : false;
  const toggle = document.getElementById("toggle-stops");
  if (!toggle) {
    return;
  }

  CountyMapState.setShowStoppedCounties(toggle.checked);
  toggle.addEventListener(
    "change",
    () => {
      CountyMapState.setShowStoppedCounties(toggle.checked);
      updateStopLayerVisibility();
    },
    eventOptions
  );
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
