/* global topojson */
/**
 * Unified County/State/City Coverage Explorer
 */

import { swupReady } from "../../core/navigation.js";
import * as CoverageAPI from "../../county-map/api.js";
import { MAP_CONFIG } from "../../county-map/constants.js";
import {
  cleanupInteractions,
  setupInteractions,
} from "../../county-map/interactions.js";
import {
  applyCityVisitFeatureState,
  applyCountyVisitFeatureState,
  applyStateVisitFeatureState,
  getMapStyle,
  renderLevelLayers,
  updateStopLayerVisibility,
} from "../../county-map/map-layers.js";
import * as CountyMapState from "../../county-map/state.js";
import {
  clearStoredRecalcState,
  getStoredRecalcState,
  storeRecalcState,
} from "../../county-map/storage.js";
import {
  hideLoading,
  renderCityRows,
  renderStateStatsList,
  setupPanelToggle,
  showRecalculatePrompt,
  updateLastUpdated,
  updateLevelUi,
  updateLoadingText,
  updateRecalculateUi,
  updateStats,
} from "../../county-map/ui.js";
import { createMap } from "../../map-core.js";
import notificationManager from "../../ui/notifications.js";

const MAX_CONTEXT_RECOVERY_ATTEMPTS = 2;
const CONTEXT_RECOVERY_COOLDOWN_MS = 30_000;

let pageSignal = null;
let inFlightRequestController = null;
let levelRequestController = null;
let levelRenderToken = 0;
let citySearchDebounceTimer = null;

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

function abortLevelRequests() {
  if (levelRequestController) {
    levelRequestController.abort();
    levelRequestController = null;
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

function beginLevelRequestCycle() {
  abortLevelRequests();
  const controller = new AbortController();
  levelRequestController = controller;

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

function createCoverageMap(camera) {
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

    feature.properties = feature.properties || {};
    feature.properties.fips = fips;
    feature.properties.stateFips = stateFips;

    countyToState[fips] = {
      stateFips,
      stateName: feature.properties.stateName || "Unknown",
    };

    if (!stateTotals[stateFips]) {
      stateTotals[stateFips] = {
        name: feature.properties.stateName || "Unknown",
        total: 0,
      };
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

function getPreferredStateFips() {
  const existing = CountyMapState.getSelectedStateFips();
  if (existing) {
    return existing;
  }

  const rollups = CountyMapState.getStateRollups();
  if (!rollups.length) {
    return null;
  }

  const sorted = [...rollups].sort((a, b) => {
    const cityVisitedDiff =
      Number(b?.city?.visited || 0) - Number(a?.city?.visited || 0);
    if (cityVisitedDiff !== 0) {
      return cityVisitedDiff;
    }
    return String(a.stateName || "").localeCompare(String(b.stateName || ""));
  });

  const first =
    sorted.find((entry) => Number(entry?.city?.total || 0) > 0) || sorted[0];
  return first?.stateFips || null;
}

function updateStateSelector() {
  const select = document.getElementById("city-state-select");
  if (!select) {
    return;
  }

  const states = CountyMapState.getStateRollups().filter(
    (entry) => Number(entry?.city?.total || 0) > 0
  );

  select.innerHTML = states
    .map((entry) => {
      const label = `${entry.stateName} (${entry.city?.visited || 0}/${entry.city?.total || 0})`;
      return `<option value="${entry.stateFips}">${label}</option>`;
    })
    .join("");

  const selected = getPreferredStateFips();
  if (selected) {
    select.value = selected;
    CountyMapState.setSelectedStateFips(selected);
  }
}

function fitToState(stateFips) {
  const map = CountyMapState.getMap();
  const stateBounds = CountyMapState.getStateBounds();
  const bounds = stateBounds[stateFips];
  if (!map || !Array.isArray(bounds) || bounds.length !== 2) {
    return;
  }
  map.fitBounds(bounds, { padding: 40, maxZoom: 8 });
}

function bindStateList(sortBy = null) {
  const sortSelect = document.getElementById("state-sort");
  const resolvedSort = sortBy || sortSelect?.value || "name";

  renderStateStatsList({
    sortBy: resolvedSort,
    onSelectState: async (stateFips) => {
      CountyMapState.setSelectedStateFips(stateFips);
      updateStateSelector();
      fitToState(stateFips);

      if (CountyMapState.getActiveLevel() === "city") {
        const token = ++levelRenderToken;
        await renderCityMode(token);
      }
    },
  });
}

function applySummary(summary) {
  CountyMapState.setSummary(summary);
  CountyMapState.setStateRollups(summary?.states || []);
  updateStats();
  updateLastUpdated(summary?.lastUpdated);
  bindStateList();
  updateStateSelector();
}

async function loadBaseData(signal) {
  updateLoadingText("Loading coverage summary...");
  const [summary, countyTopologyPayload, countyVisitsPayload, stateTopologyPayload] =
    await Promise.all([
      CoverageAPI.fetchSummary({ signal }),
      CoverageAPI.fetchCountyTopology({ signal }),
      CoverageAPI.fetchVisitedCounties({ signal }),
      CoverageAPI.fetchStateTopology({ signal }),
    ]);

  if (signal?.aborted || pageSignal?.aborted) {
    return;
  }

  const countyData = topojson.feature(
    countyTopologyPayload,
    countyTopologyPayload.objects.counties
  );
  const statesData = topojson.feature(
    countyTopologyPayload,
    countyTopologyPayload.objects.states
  );
  const { countyToState, stateTotals, stateBounds } = buildCountyIndexes(
    countyData.features
  );

  CountyMapState.setCountyData(countyData);
  CountyMapState.setStatesData(statesData);
  CountyMapState.setCountyToState(countyToState);
  CountyMapState.setStateTotals(stateTotals);
  CountyMapState.setStateBounds(stateBounds);
  CountyMapState.setTotalCounties(countyData.features.length);

  CountyMapState.setCountyVisits(countyVisitsPayload.visits || {});
  CountyMapState.setCountyStops(countyVisitsPayload.stopped || {});

  CountyMapState.setStateFeatureCollection(
    stateTopologyPayload.featureCollection || null
  );

  applySummary(summary);
}

function attachStateClickHandler(map) {
  map.off("click", "states-fill", handleStateClickFromMap);
  map.on("click", "states-fill", handleStateClickFromMap);
}

function detachStateClickHandler(map) {
  map.off("click", "states-fill", handleStateClickFromMap);
}

function handleStateClickFromMap(event) {
  const feature = event?.features?.[0];
  if (!feature) {
    return;
  }

  const stateFips = String(feature.properties?.stateFips || feature.id || "").padStart(
    2,
    "0"
  );
  if (!stateFips) {
    return;
  }

  CountyMapState.setSelectedStateFips(stateFips);
  updateStateSelector();
  fitToState(stateFips);

  if (CountyMapState.getActiveLevel() === "city") {
    const token = ++levelRenderToken;
    void renderCityMode(token);
  }
}

async function loadCityAssetsForState(stateFips, signal) {
  if (!stateFips) {
    return;
  }

  let cityFeatureCollection = CountyMapState.getCityFeatureCollection(stateFips);
  if (!cityFeatureCollection) {
    const topologyResponse = await CoverageAPI.fetchCityTopology(stateFips, { signal });
    if (signal?.aborted || pageSignal?.aborted) {
      return;
    }
    cityFeatureCollection = topologyResponse.featureCollection;
    CountyMapState.setCityFeatureCollection(stateFips, cityFeatureCollection);
  }

  const cityVisits = await CoverageAPI.fetchCityVisits(stateFips, { signal });
  if (signal?.aborted || pageSignal?.aborted) {
    return;
  }
  CountyMapState.setCityVisitsForState(stateFips, cityVisits.visits || {});
}

function bindCityPaginationHandlers(stateFips, currentPage, totalPages) {
  const prevBtn = document.getElementById("city-page-prev");
  const nextBtn = document.getElementById("city-page-next");

  prevBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      void loadCityList(stateFips, currentPage - 1);
    }
  });

  nextBtn?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      void loadCityList(stateFips, currentPage + 1);
    }
  });
}

function bindCityRowHandlers(cities) {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  document.querySelectorAll(".city-stat-item").forEach((item) => {
    item.addEventListener("click", () => {
      const { cityId } = item.dataset;
      const city = cities.find((row) => row.cityId === cityId);
      if (!city || !Array.isArray(city.bbox) || city.bbox.length !== 4) {
        return;
      }

      const [west, south, east, north] = city.bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 40, maxZoom: 10 }
      );
    });
  });
}

async function loadCityList(stateFips, page = 1) {
  if (!stateFips || CountyMapState.getActiveLevel() !== "city") {
    return;
  }

  const searchValue = document.getElementById("city-search")?.value?.trim() || "";
  const statusValue = document.getElementById("city-status")?.value || "all";
  const sortValue = document.getElementById("city-sort")?.value || "name";

  const signal = beginLevelRequestCycle();
  const currentToken = levelRenderToken;

  const payload = await CoverageAPI.fetchCities({
    stateFips,
    status: statusValue,
    q: searchValue,
    sort: sortValue,
    page,
    pageSize: 75,
    signal,
  });

  if (
    signal?.aborted ||
    pageSignal?.aborted ||
    currentToken !== levelRenderToken ||
    CountyMapState.getActiveLevel() !== "city"
  ) {
    return;
  }

  CountyMapState.setCityListForState(stateFips, payload);
  renderCityRows(payload);

  const pagination = payload?.pagination || {};
  bindCityPaginationHandlers(
    stateFips,
    Number(pagination.page || 1),
    Number(pagination.totalPages || 1)
  );

  bindCityRowHandlers(payload.cities || []);
}

function renderCountyMode() {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  renderLevelLayers("county", {
    countyData: CountyMapState.getCountyData(),
    statesData: CountyMapState.getStatesData(),
    showStoppedCounties: CountyMapState.getShowStoppedCounties(),
  });
  applyCountyVisitFeatureState(
    map,
    CountyMapState.getCountyVisits(),
    CountyMapState.getCountyStops()
  );
  updateStopLayerVisibility();
  detachStateClickHandler(map);
  setupInteractions();
}

function renderStateMode() {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  renderLevelLayers("state", {
    stateFeatureCollection: CountyMapState.getStateFeatureCollection(),
  });
  applyStateVisitFeatureState(map, CountyMapState.getStateRollups());
  attachStateClickHandler(map);
  setupInteractions();
}

async function renderCityMode(token) {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  const stateFips = getPreferredStateFips();
  if (!stateFips) {
    renderCityRows({ cities: [], pagination: { page: 1, totalPages: 1 } });
    return;
  }
  CountyMapState.setSelectedStateFips(stateFips);

  const signal = beginLevelRequestCycle();
  await loadCityAssetsForState(stateFips, signal);

  if (
    signal?.aborted ||
    pageSignal?.aborted ||
    token !== levelRenderToken ||
    CountyMapState.getActiveLevel() !== "city"
  ) {
    return;
  }

  const cityFeatureCollection = CountyMapState.getCityFeatureCollection(stateFips);
  renderLevelLayers("city", {
    cityFeatureCollection,
  });

  const cityVisits = CountyMapState.getCityVisitsForState(stateFips);
  applyCityVisitFeatureState(map, cityVisits);
  detachStateClickHandler(map);
  setupInteractions();

  await loadCityList(stateFips, 1);
}

async function renderActiveLevel() {
  const level = CountyMapState.getActiveLevel();
  const token = ++levelRenderToken;

  updateLevelUi(level);

  if (level === "county") {
    await renderCountyMode();
    return;
  }

  if (level === "state") {
    await renderStateMode();
    return;
  }

  await renderCityMode(token);
}

async function loadAndRenderCoverage(map, { recovery = false } = {}) {
  const requestSignal = beginRequestCycle();
  try {
    updateLoadingText("Loading boundaries and stats...");
    await loadBaseData(requestSignal);
    if (
      requestSignal.aborted ||
      pageSignal?.aborted ||
      map !== CountyMapState.getMap()
    ) {
      return;
    }

    await renderActiveLevel();
    hideLoading();

    const countyVisits = CountyMapState.getCountyVisits();
    const countyStops = CountyMapState.getCountyStops();
    const hasVisits = Object.keys(countyVisits).length > 0;
    const hasStops = Object.keys(countyStops).length > 0;

    if (!hasVisits && !hasStops) {
      showRecalculatePrompt(triggerRecalculate);
    }
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
  updateLoadingText("Recovering map rendering...");

  abortInFlightRequests();
  abortLevelRequests();

  if (currentMap) {
    try {
      currentMap.remove();
    } catch {
      // Ignore teardown errors during context recovery.
    }
  }

  try {
    const replacementMap = createCoverageMap(camera);
    CountyMapState.setMap(replacementMap);
    bindMapLifecycle(replacementMap, { recovery: true });
  } catch (error) {
    contextRecoveryInProgress = false;
    updateLoadingText(`Error: ${error.message}`);
  }
}

function bindMapLifecycle(map, { recovery = false } = {}) {
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
    void renderActiveLevel();
  });

  map.on("load", () => {
    void loadAndRenderCoverage(map, { recovery });
  });
}

function setupLevelControls(signal) {
  const eventOptions = signal ? { signal } : false;

  document.querySelectorAll("[data-level]").forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        const { level } = button.dataset;
        if (!level || level === CountyMapState.getActiveLevel()) {
          return;
        }
        CountyMapState.setActiveLevel(level);
        void renderActiveLevel();
      },
      eventOptions
    );
  });

  const stateSort = document.getElementById("state-sort");
  stateSort?.addEventListener(
    "change",
    () => {
      bindStateList(stateSort.value);
    },
    eventOptions
  );

  const cityStateSelect = document.getElementById("city-state-select");
  cityStateSelect?.addEventListener(
    "change",
    () => {
      CountyMapState.setSelectedStateFips(cityStateSelect.value || null);
      fitToState(cityStateSelect.value);
      if (CountyMapState.getActiveLevel() === "city") {
        void renderActiveLevel();
      }
    },
    eventOptions
  );

  const cityStatus = document.getElementById("city-status");
  cityStatus?.addEventListener(
    "change",
    () => {
      const stateFips = CountyMapState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    },
    eventOptions
  );

  const citySort = document.getElementById("city-sort");
  citySort?.addEventListener(
    "change",
    () => {
      const stateFips = CountyMapState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    },
    eventOptions
  );

  const citySearch = document.getElementById("city-search");
  citySearch?.addEventListener(
    "input",
    () => {
      if (citySearchDebounceTimer) {
        clearTimeout(citySearchDebounceTimer);
      }
      citySearchDebounceTimer = setTimeout(() => {
        const stateFips = CountyMapState.getSelectedStateFips();
        if (stateFips) {
          void loadCityList(stateFips, 1);
        }
      }, 250);
    },
    eventOptions
  );

  const cityRefresh = document.getElementById("city-refresh");
  cityRefresh?.addEventListener(
    "click",
    () => {
      const stateFips = CountyMapState.getSelectedStateFips();
      if (stateFips) {
        void renderActiveLevel();
      }
    },
    eventOptions
  );
}

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
      if (CountyMapState.getActiveLevel() === "county") {
        updateStopLayerVisibility();
      }
    },
    eventOptions
  );
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
 * Trigger recalculation of geo data
 */
async function triggerRecalculate() {
  if (CountyMapState.getIsRecalculating()) {
    return;
  }

  const startedAt = new Date();
  CountyMapState.setIsRecalculating(true);
  storeRecalcState(startedAt);
  updateRecalculateUi(true, "Recalculating coverage data...");

  try {
    const data = await CoverageAPI.triggerRecalculation({ signal: pageSignal });
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
    const data = await CoverageAPI.fetchCacheStatus({ signal: pageSignal });
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    const updatedAfterStart =
      lastUpdated && startedAt ? lastUpdated > startedAt : false;

    if (data.cached && updatedAfterStart) {
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

function setupRecalculateButton(signal) {
  const eventOptions = signal ? { signal } : false;
  const btn = document.getElementById("recalculate-btn");
  if (btn) {
    btn.addEventListener("click", triggerRecalculate, eventOptions);
  }
}

function resumeRecalculateIfNeeded() {
  const recalcState = getStoredRecalcState();
  if (!recalcState) {
    return;
  }
  CountyMapState.setIsRecalculating(true);
  updateRecalculateUi(true, "Recalculating coverage data...");
  startRecalculatePolling(recalcState.startedAt);
}

/**
 * Initialize the county map page.
 */
export default function initCountyMapPage({ cleanup, signal } = {}) {
  pageSignal = signal || null;
  contextRecoveryAttempts = 0;
  contextRecoveryLastAttemptAtMs = 0;
  contextRecoveryInProgress = false;

  updateLoadingText("Initializing map...");

  const map = createCoverageMap();
  CountyMapState.setMap(map);
  bindMapLifecycle(map);

  setupPanelToggle();
  setupLevelControls(pageSignal);
  setupRecalculateButton(pageSignal);
  setupStopToggle(pageSignal);
  resumeRecalculateIfNeeded();

  const teardown = () => {
    pageSignal = null;
    abortInFlightRequests();
    abortLevelRequests();
    cleanupInteractions();
    contextRecoveryInProgress = false;
    if (citySearchDebounceTimer) {
      clearTimeout(citySearchDebounceTimer);
      citySearchDebounceTimer = null;
    }
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

  return teardown;
}
