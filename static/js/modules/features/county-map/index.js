/* global topojson */
/**
 * Unified County/State/City Coverage Explorer
 */

import { swupReady } from "../../core/navigation.js";
import * as CoverageAPI from "../../county-map/api.js";
import { MAP_CONFIG, getStateName } from "../../county-map/constants.js";
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
  setSelectionHighlight,
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
  updateSummaryBar,
} from "../../county-map/ui.js";
import { createMap } from "../../map-core.js";
import notificationManager from "../../ui/notifications.js";

const MAX_CONTEXT_RECOVERY_ATTEMPTS = 2;
const CONTEXT_RECOVERY_COOLDOWN_MS = 30_000;
const RECALC_STALE_MS = 6 * 60 * 60 * 1000;
const RECALC_POLL_MS = 1500;
const RECALC_NO_JOB_GRACE_MS = 20_000;

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

function isRecalcStateStale(startedAt, nowMs = Date.now()) {
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    return true;
  }
  return nowMs - startedAt.getTime() > RECALC_STALE_MS;
}

function toDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isJobActive(job) {
  const status = String(job?.status || "").toLowerCase();
  return status === "pending" || status === "running";
}

function isJobFailed(job) {
  return String(job?.status || "").toLowerCase() === "failed";
}

function isJobCompleted(job) {
  return String(job?.status || "").toLowerCase() === "completed";
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
    const fallbackStateName = getStateName(stateFips);

    feature.properties = feature.properties || {};
    feature.properties.fips = fips;
    feature.properties.stateFips = stateFips;
    feature.properties.stateName =
      feature.properties.stateName ||
      feature.properties.state ||
      fallbackStateName ||
      "Unknown State";

    countyToState[fips] = {
      stateFips,
      stateName: feature.properties.stateName,
    };

    if (!stateTotals[stateFips]) {
      stateTotals[stateFips] = {
        name: feature.properties.stateName,
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

function getStateRollupsWithCountyActivity() {
  const countyActivityStateFips = getCountyActivityStateFips({
    countyVisits: CountyMapState.getCountyVisits(),
    countyStops: CountyMapState.getCountyStops(),
  });

  return CountyMapState.getStateRollups().filter((entry) =>
    countyActivityStateFips.has(String(entry?.stateFips || "").padStart(2, "0"))
  );
}

export function getCityTabStateRollups(
  stateRollups = CountyMapState.getStateRollups()
) {
  const rollups = Array.isArray(stateRollups) ? stateRollups : [];
  return rollups.filter(
    (entry) => Number(entry?.city?.total || 0) > 0
  );
}

function getPreferredStateFips(stateRollups = CountyMapState.getStateRollups()) {
  const rollups = Array.isArray(stateRollups) ? stateRollups : [];
  const existing = CountyMapState.getSelectedStateFips();
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
    CountyMapState.setSelectedStateFips(null);
    return;
  }
  select.value = selected;
  CountyMapState.setSelectedStateFips(selected);
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
  const map = CountyMapState.getMap();
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
    countyVisits: CountyMapState.getCountyVisits(),
    countyStops: CountyMapState.getCountyStops(),
  });

  renderStateStatsList({
    sortBy: resolvedSort,
    includeState: (entry) =>
      countyActivityStateFips.has(String(entry?.stateFips || "").padStart(2, "0")),
    onSelectState: async (stateFips) => {
      CountyMapState.setSelectedStateFips(stateFips);
      setSelectionHighlight(stateFips, "state");
      updateStateSelector();
      fitToState(stateFips);

      if (CountyMapState.getActiveLevel() !== "city") {
        bindStateList(resolvedSort);
      }

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
  updateSummaryBar();
  updateLastUpdated(summary?.lastUpdated);
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

  const countyFips = String(feature.properties?.fips || feature.id || "").padStart(5, "0");
  if (!countyFips) {
    return;
  }

  CountyMapState.setSelectedCountyFips(countyFips);
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

  CountyMapState.setSelectedStateFips(stateFips);
  setSelectionHighlight(stateFips, "state");
  updateStateSelector();
  fitToState(stateFips);
  bindStateList(document.getElementById("state-sort")?.value || null);

  if (CountyMapState.getActiveLevel() === "city") {
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

  CountyMapState.setSelectedCityId(cityId);
  setSelectionHighlight(cityId, "city");
  fitToFeatureGeometry(feature, { maxZoom: 10 });

  document.querySelectorAll(".city-stat-item").forEach((row) => {
    const rowCityId = String(row.dataset.cityId || "");
    const isSelected = rowCityId === cityId;
    row.classList.toggle("city-stat-item--selected", isSelected);
    row.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
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
  CountyMapState.setCityStopsForState(stateFips, cityVisits.stopped || {});
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
      if (!cityId) {
        return;
      }

      CountyMapState.setSelectedCityId(cityId);
      setSelectionHighlight(cityId, "city");

      document.querySelectorAll(".city-stat-item").forEach((row) => {
        const rowCityId = String(row.dataset.cityId || "");
        const isSelected = rowCityId === cityId;
        row.classList.toggle("city-stat-item--selected", isSelected);
        row.setAttribute("aria-selected", isSelected ? "true" : "false");
      });

      const city = cities.find((row) => String(row.cityId) === String(cityId));
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
  setSelectionHighlight(CountyMapState.getSelectedCountyFips(), "county");
  updateStopLayerVisibility();
  detachLevelClickHandlers(map);
  attachCountyClickHandler(map);
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
  setSelectionHighlight(CountyMapState.getSelectedStateFips(), "state");
  detachLevelClickHandlers(map);
  attachStateClickHandler(map);
  setupInteractions();
}

async function renderCityMode(token) {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  const stateFips = getPreferredStateFips(getCityTabStateRollups());
  if (!stateFips) {
    CountyMapState.setSelectedStateFips(null);
    CountyMapState.setSelectedCityId(null);
    renderLevelLayers("city", {
      cityFeatureCollection: {
        type: "FeatureCollection",
        features: [],
      },
      showStoppedCities: CountyMapState.getShowStoppedCities(),
    });
    applyCityVisitFeatureState(map, {}, {});
    setSelectionHighlight("", "city");
    detachLevelClickHandlers(map);
    attachCityClickHandler(map);
    setupInteractions();
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
    showStoppedCities: CountyMapState.getShowStoppedCities(),
  });

  const cityVisits = CountyMapState.getCityVisitsForState(stateFips);
  const cityStops = CountyMapState.getCityStopsForState(stateFips);
  applyCityVisitFeatureState(map, cityVisits, cityStops);
  setSelectionHighlight(CountyMapState.getSelectedCityId(), "city");
  updateStopLayerVisibility();
  detachLevelClickHandlers(map);
  attachCityClickHandler(map);
  setupInteractions();

  await loadCityList(stateFips, 1);
}

async function renderActiveLevel() {
  const level = CountyMapState.getActiveLevel();
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

  // One-time binding: tab buttons and summary pills switch levels
  document
    .querySelectorAll(".coverage-level-btn[data-level], .summary-pill[data-level]")
    .forEach((el) => {
      el.addEventListener(
        "click",
        () => {
          const { level } = el.dataset;
          if (!level || level === CountyMapState.getActiveLevel()) {
            return;
          }
          CountyMapState.setActiveLevel(level);
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
  const level = CountyMapState.getActiveLevel();

  // County: stop toggle
  if (level === "county") {
    const toggle = document.getElementById("toggle-stops");
    if (toggle) {
      toggle.checked = CountyMapState.getShowStoppedCounties();
      toggle.addEventListener("change", () => {
        CountyMapState.setShowStoppedCounties(toggle.checked);
        if (CountyMapState.getActiveLevel() === "county") {
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
      CountyMapState.setSelectedStateFips(cityStateSelect.value || null);
      CountyMapState.setSelectedCityId(null);
      setSelectionHighlight("", "city");
      fitToState(cityStateSelect.value);
      if (CountyMapState.getActiveLevel() === "city") {
        void renderActiveLevel();
      }
    });

    const cityStatus = document.getElementById("city-status");
    cityStatus?.addEventListener("change", () => {
      const stateFips = CountyMapState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    });

    const citySort = document.getElementById("city-sort");
    citySort?.addEventListener("change", () => {
      const stateFips = CountyMapState.getSelectedStateFips();
      if (stateFips) {
        void loadCityList(stateFips, 1);
      }
    });

    const cityStopToggle = document.getElementById("toggle-city-stops");
    if (cityStopToggle) {
      cityStopToggle.checked = CountyMapState.getShowStoppedCities();
      cityStopToggle.addEventListener("change", () => {
        CountyMapState.setShowStoppedCities(cityStopToggle.checked);
        if (CountyMapState.getActiveLevel() === "city") {
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
        const stateFips = CountyMapState.getSelectedStateFips();
        if (stateFips) {
          void loadCityList(stateFips, 1);
        }
      }, 250);
    });
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

function buildRecalculateDetails(job = null) {
  const metrics = job?.metrics || {};
  const result = job?.result || {};
  const processedTrips = Number(
    metrics.processedTrips ?? result.processedTrips ?? 0
  );
  const totalTrips = Number(metrics.totalTrips ?? result.totalTrips ?? 0);
  const visitedCounties = Number(
    metrics.visitedCounties ?? result.visitedCounties ?? 0
  );
  const visitedCities = Number(metrics.visitedCities ?? result.visitedCities ?? 0);
  const stoppedCounties = Number(
    metrics.stoppedCounties ?? result.stoppedCounties ?? 0
  );
  const stoppedCities = Number(metrics.stoppedCities ?? result.stoppedCities ?? 0);

  return {
    stage: job?.stage || "Working",
    progress: Number(job?.progress ?? 0),
    mode: job?.mode || metrics.mode || result.mode || "incremental",
    processedTrips,
    totalTrips,
    visitedCounties,
    visitedCities,
    stoppedCounties,
    stoppedCities,
  };
}

function refreshCoveragePage() {
  swupReady.then((swup) => {
    swup.navigate(window.location.href, {
      cache: { read: false, write: true },
      history: "replace",
    });
  });
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
  storeRecalcState(startedAt, null);
  updateRecalculateUi(true, "Starting coverage recalculation...", {
    stage: "Queued",
    progress: 0,
  });

  try {
    const data = await CoverageAPI.triggerRecalculation({ signal: pageSignal });
    if (data.success) {
      const job = data?.job || null;
      const jobId = typeof data?.jobId === "string" ? data.jobId : job?.id || null;
      storeRecalcState(startedAt, jobId);
      if (job) {
        updateRecalculateUi(
          true,
          job.message || "Recalculating coverage data...",
          buildRecalculateDetails(job)
        );
      }
      setTimeout(() => startRecalculatePolling(startedAt, jobId), 500);
    } else {
      notificationManager.show(`Error starting calculation: ${data.error}`, "danger");
      clearRecalcState();
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (!pageSignal?.aborted) {
        clearRecalcState();
      }
      return;
    }
    clearRecalcState();
  }
}

/**
 * Start polling for recalculation completion
 */
function startRecalculatePolling(startedAt, jobId = null) {
  if (pageSignal?.aborted) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }
  if (CountyMapState.getRecalcPollerActive()) {
    return;
  }
  CountyMapState.setRecalcPollerActive(true);
  setTimeout(() => checkAndRefresh(startedAt, jobId), RECALC_POLL_MS);
}

/**
 * Check if calculation is done and refresh
 */
async function checkAndRefresh(startedAt, activeJobId = null) {
  if (pageSignal?.aborted) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }
  if (!CountyMapState.getIsRecalculating()) {
    CountyMapState.setRecalcPollerActive(false);
    return;
  }
  if (isRecalcStateStale(startedAt)) {
    clearRecalcState();
    notificationManager.show(
      "Coverage recalculation timed out. Please try again.",
      "warning"
    );
    return;
  }

  try {
    const data = await CoverageAPI.fetchCacheStatus({ signal: pageSignal });
    const job = data?.recalculation?.job || null;
    const lastUpdated = toDate(data?.lastUpdated);
    const updatedAfterStart = lastUpdated ? lastUpdated >= startedAt : false;

    if (job && isJobActive(job)) {
      const jobId = typeof job?.id === "string" ? job.id : activeJobId;
      storeRecalcState(startedAt, jobId);
      updateRecalculateUi(
        true,
        job.message || "Recalculating coverage data...",
        buildRecalculateDetails(job)
      );
      if (!pageSignal?.aborted) {
        setTimeout(() => checkAndRefresh(startedAt, jobId), RECALC_POLL_MS);
      }
      return;
    }

    if (job && isJobFailed(job)) {
      clearRecalcState();
      notificationManager.show(
        job.error || job.message || "Coverage recalculation failed.",
        "danger"
      );
      return;
    }

    const completedAt = toDate(job?.completedAt);
    const completedAfterStart = completedAt ? completedAt >= startedAt : false;

    if (
      (job && isJobCompleted(job) && (completedAfterStart || updatedAfterStart)) ||
      (data.cached && updatedAfterStart)
    ) {
      clearRecalcState();
      refreshCoveragePage();
      return;
    }

    if (!job) {
      const elapsedMs = Date.now() - startedAt.getTime();
      const workerShouldExist = Boolean(data?.isRecalculating);
      if (!workerShouldExist && elapsedMs > RECALC_NO_JOB_GRACE_MS) {
        clearRecalcState();
        notificationManager.show(
          "No active recalculation job was found. Please start recalculation again.",
          "warning"
        );
        return;
      }

      updateRecalculateUi(true, "Waiting for recalculation worker...", {
        stage: "Starting",
        progress: 0,
        mode: data?.defaultMode || "incremental",
      });
    }

    if (!pageSignal?.aborted) {
      setTimeout(() => checkAndRefresh(startedAt, activeJobId), RECALC_POLL_MS);
    }
  } catch (error) {
    if (!isAbortError(error) && !pageSignal?.aborted) {
      setTimeout(() => checkAndRefresh(startedAt, activeJobId), 2500);
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
  if (isRecalcStateStale(recalcState.startedAt)) {
    clearRecalcState();
    return;
  }
  CountyMapState.setIsRecalculating(true);
  updateRecalculateUi(true, "Resuming coverage recalculation...", {
    stage: "Reconnecting",
    progress: 0,
  });
  startRecalculatePolling(recalcState.startedAt, recalcState.jobId || null);
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
