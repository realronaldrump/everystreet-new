/* global topojson */
/**
 * Unified Region Explorer
 */

import { coverageBoundingBoxToMapBounds } from "../../core/coverage-bounds.js";
import { createMap } from "../../map-core.js";
import * as RegionalCoverageExplorerAPI from "../../regional-coverage-explorer/api.js";
import {
  getStateName,
  MAP_CONFIG,
} from "../../regional-coverage-explorer/constants.js";
import {
  cleanupInteractions,
  setupInteractions,
} from "../../regional-coverage-explorer/interactions.js";
import {
  applyCityVisitFeatureState,
  applyCountyVisitFeatureState,
  applyStateVisitFeatureState,
  getMapStyle,
  renderLevelLayers,
  setSelectionHighlight,
  updateStopLayerVisibility,
} from "../../regional-coverage-explorer/map-layers.js";
import * as RegionalCoverageExplorerState from "../../regional-coverage-explorer/state.js";
import {
  hideLoading,
  renderCityRows,
  renderStateStatsList,
  setupPanelToggle,
  showRecalculatePrompt,
  updateLastUpdated,
  updateLevelUi,
  updateLoadingText,
  updateSummaryBar,
} from "../../regional-coverage-explorer/ui.js";
import { isAbortError } from "../../utils.js";

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
  return createMap("regional-coverage-explorer-map", {
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
  const stateBoundsAccumulator = {};

  features.forEach((feature) => {
    const fips = String(feature.id).padStart(5, "0");
    const stateFips = fips.substring(0, 2);
    const fallbackStateName = getStateName(stateFips);

    feature.properties = feature.properties || {};
    feature.properties.fips = fips;
    feature.properties.stateFips = stateFips;
    feature.properties.stateName =
      feature.properties.stateName ||
      feature.properties.state ||
      fallbackStateName ||
      "Unknown State";

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
    stateBounds,
  };
}

export function getCountyActivityStateFips({
  countyVisits = {},
  countyStops = {},
} = {}) {
  const stateFipsWithActivity = new Set();

  [countyVisits, countyStops].forEach((records) => {
    Object.keys(records || {}).forEach((countyFips) => {
      const normalizedCountyFips = String(countyFips).padStart(5, "0");
      const stateFips = normalizedCountyFips.substring(0, 2);
      if (stateFips) {
        stateFipsWithActivity.add(stateFips);
      }
    });
  });

  return stateFipsWithActivity;
}

export function getCityTabStateRollups(
  stateRollups = RegionalCoverageExplorerState.getStateRollups(),
  activityStateFips = null
) {
  const rollups = Array.isArray(stateRollups) ? stateRollups : [];
  const activeSet =
    activityStateFips ||
    getCountyActivityStateFips({
      countyVisits: RegionalCoverageExplorerState.getCountyVisits(),
      countyStops: RegionalCoverageExplorerState.getCountyStops(),
    });
  return rollups.filter(
    (entry) =>
      Number(entry?.city?.total || 0) > 0 &&
      activeSet.has(String(entry?.stateFips || "").padStart(2, "0"))
  );
}

function getPreferredStateFips(
  stateRollups = RegionalCoverageExplorerState.getStateRollups()
) {
  const rollups = Array.isArray(stateRollups) ? stateRollups : [];
  const existing = RegionalCoverageExplorerState.getSelectedStateFips();
  if (existing && rollups.some((entry) => String(entry?.stateFips) === existing)) {
    return existing;
  }

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

  const states = getCityTabStateRollups();

  select.innerHTML = states
    .map((entry) => {
      const label = `${entry.stateName} (${entry.city?.visited || 0}/${entry.city?.total || 0})`;
      return `<option value="${entry.stateFips}">${label}</option>`;
    })
    .join("");

  const selected = getPreferredStateFips(states);
  if (!selected) {
    RegionalCoverageExplorerState.setSelectedStateFips(null);
    return;
  }
  select.value = selected;
  RegionalCoverageExplorerState.setSelectedStateFips(selected);
}

function fitToState(stateFips) {
  const map = RegionalCoverageExplorerState.getMap();
  const stateBounds = RegionalCoverageExplorerState.getStateBounds();
  const bounds = stateBounds[stateFips];
  if (!map || !Array.isArray(bounds) || bounds.length !== 2) {
    return;
  }
  map.fitBounds(bounds, { padding: 40, maxZoom: 8 });
}

function getGeometryBounds(geometry) {
  if (!geometry) {
    return null;
  }

  const bounds = {
    minLng: Infinity,
    minLat: Infinity,
    maxLng: -Infinity,
    maxLat: -Infinity,
  };

  forEachCoordinate(geometry, (lng, lat) => {
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

  if (
    !Number.isFinite(bounds.minLng) ||
    !Number.isFinite(bounds.minLat) ||
    !Number.isFinite(bounds.maxLng) ||
    !Number.isFinite(bounds.maxLat)
  ) {
    return null;
  }

  return [
    [bounds.minLng, bounds.minLat],
    [bounds.maxLng, bounds.maxLat],
  ];
}

function fitToFeatureGeometry(feature, { padding = 40, maxZoom = 10 } = {}) {
  const map = RegionalCoverageExplorerState.getMap();
  const geometryBounds = getGeometryBounds(feature?.geometry);
  if (!map || !Array.isArray(geometryBounds) || geometryBounds.length !== 2) {
    return;
  }

  map.fitBounds(geometryBounds, { padding, maxZoom });
}

function bindStateList(sortBy = null) {
  const sortSelect = document.getElementById("state-sort");
  const resolvedSort = sortBy || sortSelect?.value || "name";
  const countyActivityStateFips = getCountyActivityStateFips({
    countyVisits: RegionalCoverageExplorerState.getCountyVisits(),
    countyStops: RegionalCoverageExplorerState.getCountyStops(),
  });

  renderStateStatsList({
    sortBy: resolvedSort,
    includeState: (entry) =>
      countyActivityStateFips.has(String(entry?.stateFips || "").padStart(2, "0")),
    onSelectState: async (stateFips) => {
      RegionalCoverageExplorerState.setSelectedStateFips(stateFips);
      setSelectionHighlight(stateFips, "state");
      updateStateSelector();
      fitToState(stateFips);

      if (RegionalCoverageExplorerState.getActiveLevel() !== "city") {
        bindStateList(resolvedSort);
      }

      if (RegionalCoverageExplorerState.getActiveLevel() === "city") {
        const token = ++levelRenderToken;
        await renderCityMode(token);
      }
    },
  });
}

function applySummary(summary) {
  RegionalCoverageExplorerState.setSummary(summary);
  RegionalCoverageExplorerState.setStateRollups(summary?.states || []);
  updateSummaryBar();
  updateLastUpdated(summary?.lastUpdated);
}

async function loadBaseData(signal) {
  updateLoadingText("Loading coverage summary...");
  const [summary, countyTopologyPayload, countyVisitsPayload, stateTopologyPayload] =
    await Promise.all([
      RegionalCoverageExplorerAPI.fetchSummary({ signal }),
      RegionalCoverageExplorerAPI.fetchCountyTopology({ signal }),
      RegionalCoverageExplorerAPI.fetchVisitedCounties({ signal }),
      RegionalCoverageExplorerAPI.fetchStateTopology({ signal }),
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
  const { stateBounds } = buildCountyIndexes(countyData.features);

  RegionalCoverageExplorerState.setCountyData(countyData);
  RegionalCoverageExplorerState.setStatesData(statesData);
  RegionalCoverageExplorerState.setStateBounds(stateBounds);

  RegionalCoverageExplorerState.setCountyVisits(countyVisitsPayload.visits || {});
  RegionalCoverageExplorerState.setCountyStops(countyVisitsPayload.stopped || {});

  RegionalCoverageExplorerState.setStateFeatureCollection(
    stateTopologyPayload.featureCollection || null
  );

  applySummary(summary);
}

function attachStateClickHandler(map) {
  map.off("click", "states-fill", handleStateClickFromMap);
  map.on("click", "states-fill", handleStateClickFromMap);
}

function attachCountyClickHandler(map) {
  map.off("click", "counties-fill", handleCountyClickFromMap);
  map.on("click", "counties-fill", handleCountyClickFromMap);
}

function attachCityClickHandler(map) {
  map.off("click", "cities-fill", handleCityClickFromMap);
  map.on("click", "cities-fill", handleCityClickFromMap);
}

function detachStateClickHandler(map) {
  map.off("click", "states-fill", handleStateClickFromMap);
}

function detachCountyClickHandler(map) {
  map.off("click", "counties-fill", handleCountyClickFromMap);
}

function detachCityClickHandler(map) {
  map.off("click", "cities-fill", handleCityClickFromMap);
}

function detachLevelClickHandlers(map) {
  detachCountyClickHandler(map);
  detachStateClickHandler(map);
  detachCityClickHandler(map);
}

function handleCountyClickFromMap(event) {
  const feature = event?.features?.[0];
  if (!feature) {
    return;
  }

  const countyFips = String(feature.properties?.fips || feature.id || "").padStart(
    5,
    "0"
  );
  if (!countyFips) {
    return;
  }

  RegionalCoverageExplorerState.setSelectedCountyFips(countyFips);
  setSelectionHighlight(countyFips, "county");
  fitToFeatureGeometry(feature, { maxZoom: 9 });
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

  RegionalCoverageExplorerState.setSelectedStateFips(stateFips);
  setSelectionHighlight(stateFips, "state");
  updateStateSelector();
  fitToState(stateFips);
  bindStateList(document.getElementById("state-sort")?.value || null);

  if (RegionalCoverageExplorerState.getActiveLevel() === "city") {
    const token = ++levelRenderToken;
    void renderCityMode(token);
  }
}

function handleCityClickFromMap(event) {
  const feature = event?.features?.[0];
  if (!feature) {
    return;
  }

  const cityId = String(feature.properties?.cityId || feature.id || "");
  if (!cityId) {
    return;
  }

  RegionalCoverageExplorerState.setSelectedCityId(cityId);
  setSelectionHighlight(cityId, "city");
  fitToFeatureGeometry(feature, { maxZoom: 10 });
  syncSelectedCityRow(cityId);
}

async function loadCityAssetsForState(stateFips, signal) {
  if (!stateFips) {
    return;
  }

  let cityFeatureCollection =
    RegionalCoverageExplorerState.getCityFeatureCollection(stateFips);
  if (!cityFeatureCollection) {
    const topologyResponse = await RegionalCoverageExplorerAPI.fetchCityTopology(
      stateFips,
      { signal }
    );
    if (signal?.aborted || pageSignal?.aborted) {
      return;
    }
    cityFeatureCollection = topologyResponse.featureCollection;
    RegionalCoverageExplorerState.setCityFeatureCollection(
      stateFips,
      cityFeatureCollection
    );
  }

  const cityVisits = await RegionalCoverageExplorerAPI.fetchCityVisits(stateFips, {
    signal,
  });
  if (signal?.aborted || pageSignal?.aborted) {
    return;
  }
  RegionalCoverageExplorerState.setCityVisitsForState(
    stateFips,
    cityVisits.visits || {}
  );
  RegionalCoverageExplorerState.setCityStopsForState(
    stateFips,
    cityVisits.stopped || {}
  );
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

function syncSelectedCityRow(cityId) {
  const selectedCityId = String(cityId || "");
  document.querySelectorAll(".city-stat-item").forEach((row) => {
    const rowCityId = String(row.dataset.cityId || "");
    const isSelected = rowCityId === selectedCityId;
    row.classList.toggle("city-stat-item--selected", isSelected);
    row.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
}

function bindCityRowHandlers(cities) {
  const map = RegionalCoverageExplorerState.getMap();
  if (!map) {
    return;
  }

  document.querySelectorAll(".city-stat-item").forEach((item) => {
    item.addEventListener("click", () => {
      const { cityId } = item.dataset;
      if (!cityId) {
        return;
      }

      RegionalCoverageExplorerState.setSelectedCityId(cityId);
      setSelectionHighlight(cityId, "city");
      syncSelectedCityRow(cityId);

      const city = cities.find((row) => String(row.cityId) === String(cityId));
      if (!city || !Array.isArray(city.bbox) || city.bbox.length !== 4) {
        return;
      }

      const bounds = coverageBoundingBoxToMapBounds(city.bbox);
      if (!bounds) {
        return;
      }

      map.fitBounds(bounds, { padding: 40, maxZoom: 10 });
    });
  });
}

async function loadCityList(stateFips, page = 1) {
  if (!stateFips || RegionalCoverageExplorerState.getActiveLevel() !== "city") {
    return;
  }

  const searchValue = document.getElementById("city-search")?.value?.trim() || "";
  const statusValue = document.getElementById("city-status")?.value || "all";
  const sortValue = document.getElementById("city-sort")?.value || "name";

  const signal = beginLevelRequestCycle();
  const currentToken = levelRenderToken;

  const payload = await RegionalCoverageExplorerAPI.fetchCities({
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
    RegionalCoverageExplorerState.getActiveLevel() !== "city"
  ) {
    return;
  }

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
  const map = RegionalCoverageExplorerState.getMap();
  if (!map) {
    return;
  }

  renderLevelLayers("county", {
    countyData: RegionalCoverageExplorerState.getCountyData(),
    statesData: RegionalCoverageExplorerState.getStatesData(),
    showStoppedCounties: RegionalCoverageExplorerState.getShowStoppedCounties(),
  });
  applyCountyVisitFeatureState(
    map,
    RegionalCoverageExplorerState.getCountyVisits(),
    RegionalCoverageExplorerState.getCountyStops()
  );
  setSelectionHighlight(
    RegionalCoverageExplorerState.getSelectedCountyFips(),
    "county"
  );
  updateStopLayerVisibility();
  detachLevelClickHandlers(map);
  attachCountyClickHandler(map);
  setupInteractions();
}

function renderStateMode() {
  const map = RegionalCoverageExplorerState.getMap();
  if (!map) {
    return;
  }

  renderLevelLayers("state", {
    stateFeatureCollection: RegionalCoverageExplorerState.getStateFeatureCollection(),
  });
  applyStateVisitFeatureState(map, RegionalCoverageExplorerState.getStateRollups());
  setSelectionHighlight(RegionalCoverageExplorerState.getSelectedStateFips(), "state");
  detachLevelClickHandlers(map);
  attachStateClickHandler(map);
  setupInteractions();
}

async function renderCityMode(token) {
  const map = RegionalCoverageExplorerState.getMap();
  if (!map) {
    return;
  }

  const stateFips = getPreferredStateFips(getCityTabStateRollups());
  if (!stateFips) {
    RegionalCoverageExplorerState.setSelectedStateFips(null);
    RegionalCoverageExplorerState.setSelectedCityId(null);
    renderLevelLayers("city", {
      cityFeatureCollection: {
        type: "FeatureCollection",
        features: [],
      },
      showStoppedCities: RegionalCoverageExplorerState.getShowStoppedCities(),
    });
    applyCityVisitFeatureState(map, {}, {});
    setSelectionHighlight("", "city");
    detachLevelClickHandlers(map);
    attachCityClickHandler(map);
    setupInteractions();
    renderCityRows({ cities: [], pagination: { page: 1, totalPages: 1 } });
    return;
  }
  RegionalCoverageExplorerState.setSelectedStateFips(stateFips);

  const signal = beginLevelRequestCycle();
  await loadCityAssetsForState(stateFips, signal);

  if (
    signal?.aborted ||
    pageSignal?.aborted ||
    token !== levelRenderToken ||
    RegionalCoverageExplorerState.getActiveLevel() !== "city"
  ) {
    return;
  }

  const cityFeatureCollection =
    RegionalCoverageExplorerState.getCityFeatureCollection(stateFips);
  renderLevelLayers("city", {
    cityFeatureCollection,
    showStoppedCities: RegionalCoverageExplorerState.getShowStoppedCities(),
  });

  const cityVisits = RegionalCoverageExplorerState.getCityVisitsForState(stateFips);
  const cityStops = RegionalCoverageExplorerState.getCityStopsForState(stateFips);
  applyCityVisitFeatureState(map, cityVisits, cityStops);
  setSelectionHighlight(RegionalCoverageExplorerState.getSelectedCityId(), "city");
  updateStopLayerVisibility();
  detachLevelClickHandlers(map);
  attachCityClickHandler(map);
  setupInteractions();

  await loadCityList(stateFips, 1);
}

async function renderActiveLevel() {
  const level = RegionalCoverageExplorerState.getActiveLevel();
  const token = ++levelRenderToken;

  updateLevelUi(level);
  bindLevelControls();

  if (level === "county") {
    bindStateList();
    await renderCountyMode();
    return;
  }

  if (level === "state") {
    bindStateList();
    await renderStateMode();
    return;
  }

  updateStateSelector();
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
      map !== RegionalCoverageExplorerState.getMap()
    ) {
      return;
    }

    await renderActiveLevel();
    hideLoading();

    const countyVisits = RegionalCoverageExplorerState.getCountyVisits();
    const countyStops = RegionalCoverageExplorerState.getCountyStops();
    const hasVisits = Object.keys(countyVisits).length > 0;
    const hasStops = Object.keys(countyStops).length > 0;

    if (!hasVisits && !hasStops) {
      showRecalculatePrompt();
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

  const currentMap = RegionalCoverageExplorerState.getMap();
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
    RegionalCoverageExplorerState.setMap(replacementMap);
    bindMapLifecycle(replacementMap, { recovery: true });
  } catch (error) {
    contextRecoveryInProgress = false;
    updateLoadingText(`Error: ${error.message}`);
  }
}

function bindMapLifecycle(map, { recovery = false } = {}) {
  map.on("webglcontextlost", (event) => {
    if (map !== RegionalCoverageExplorerState.getMap()) {
      return;
    }
    event.preventDefault();
    recoverFromContextLoss();
  });

  map.on("webglcontextrestored", () => {
    if (map !== RegionalCoverageExplorerState.getMap() || pageSignal?.aborted) {
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

  // One-time binding: tab buttons and summary pills switch levels
  document
    .querySelectorAll(".coverage-level-btn[data-level], .summary-pill[data-level]")
    .forEach((el) => {
      el.addEventListener(
        "click",
        () => {
          const { level } = el.dataset;
          if (!level || level === RegionalCoverageExplorerState.getActiveLevel()) {
            return;
          }
          RegionalCoverageExplorerState.setActiveLevel(level);
          void renderActiveLevel();
        },
        eventOptions
      );
    });
}

/**
 * Bind event listeners for dynamically-rendered level controls.
 * Called after each level switch since innerHTML replaces the DOM.
 */
function bindLevelControls() {
  const level = RegionalCoverageExplorerState.getActiveLevel();

  // County: stop toggle
  if (level === "county") {
    const toggle = document.getElementById("toggle-stops");
    if (toggle) {
      toggle.checked = RegionalCoverageExplorerState.getShowStoppedCounties();
      toggle.addEventListener("change", () => {
        RegionalCoverageExplorerState.setShowStoppedCounties(toggle.checked);
        if (RegionalCoverageExplorerState.getActiveLevel() === "county") {
          updateStopLayerVisibility();
        }
      });
    }
  }

  // State sort (present on county and state views)
  const stateSort = document.getElementById("state-sort");
  stateSort?.addEventListener("change", () => {
    bindStateList(stateSort.value);
  });

  // City-level controls
  if (level === "city") {
    const cityStateSelect = document.getElementById("city-state-select");
    cityStateSelect?.addEventListener("change", () => {
      RegionalCoverageExplorerState.setSelectedStateFips(cityStateSelect.value || null);
      RegionalCoverageExplorerState.setSelectedCityId(null);
      setSelectionHighlight("", "city");
      fitToState(cityStateSelect.value);
      if (RegionalCoverageExplorerState.getActiveLevel() === "city") {
        void renderActiveLevel();
      }
    });

    const cityStatus = document.getElementById("city-status");
    cityStatus?.addEventListener("change", () => {
      const stateFips = RegionalCoverageExplorerState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    });

    const citySort = document.getElementById("city-sort");
    citySort?.addEventListener("change", () => {
      const stateFips = RegionalCoverageExplorerState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    });

    const cityStopToggle = document.getElementById("toggle-city-stops");
    if (cityStopToggle) {
      cityStopToggle.checked = RegionalCoverageExplorerState.getShowStoppedCities();
      cityStopToggle.addEventListener("change", () => {
        RegionalCoverageExplorerState.setShowStoppedCities(cityStopToggle.checked);
        if (RegionalCoverageExplorerState.getActiveLevel() === "city") {
          updateStopLayerVisibility();
        }
      });
    }

    const citySearch = document.getElementById("city-search");
    citySearch?.addEventListener("input", () => {
      if (citySearchDebounceTimer) {
        clearTimeout(citySearchDebounceTimer);
      }
      citySearchDebounceTimer = setTimeout(() => {
        const stateFips = RegionalCoverageExplorerState.getSelectedStateFips();
        if (stateFips) {
          void loadCityList(stateFips, 1);
        }
      }, 250);
    });
  }
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
  RegionalCoverageExplorerState.setMap(map);
  bindMapLifecycle(map);

  setupPanelToggle();
  setupLevelControls(pageSignal);

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
    const activeMap = RegionalCoverageExplorerState.getMap();
    if (activeMap) {
      try {
        activeMap.remove();
      } catch {
        // Ignore map cleanup errors.
      }
    }
    RegionalCoverageExplorerState.resetState?.();
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}
