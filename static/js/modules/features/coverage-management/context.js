/**
 * Coverage page state and API access, shared by the page and its panels.
 * `state` is replaced with a fresh object when the page leaves; modules
 * read it through this live binding.
 */

import apiClient from "../../core/api-client.js";
import { createFeatureApi } from "../../core/feature-api.js";
import { DEFAULT_AREA_SORT } from "./areas.js";

export const API_BASE = "/api/coverage";
export const APP_SETTINGS_API = "/api/app_settings";

// =============================================================================
// Module State — Single object, explicit teardown
// =============================================================================

const INITIAL_STATE = () => ({
  // View
  view: "list", // "list" | "area"
  currentAreaId: null,
  currentAreaData: null,

  // Map
  map: null,
  streetInteractivityReady: false,
  currentMapFilters: ["all"],
  streetsCacheKey: null,
  streetsCacheGeojson: null,
  renderedStreetsCacheKey: null,
  streetsLoadRequestId: 0,
  viewportAbort: null,
  hoveredSegmentId: null,
  hoverPopup: null,

  // Street detail panel
  selectedSegment: null, // { segmentId, properties }

  // Jobs/area tracking
  activeJobsByAreaId: new Map(),
  activeRouteJobsByAreaId: new Map(),
  areaList: [],
  areaSort: DEFAULT_AREA_SORT,
  areaErrorById: new Map(),
  areaNameById: new Map(),
  areaRoadFilterVersionById: new Map(),
  activeErrorAreaId: null,
  areaViewRequestId: 0,
  activeJobsRefreshTimeoutId: null,

  // Service roads (kept synced across toggles)
  currentAreaSyncToken: null,
  currentAreaRoadFilterVersion: null,
  coverageTripMode: "both",

  // Page lifecycle
  pageActive: false,
  pageSignal: null,
});

export let state = INITIAL_STATE();
let featureApi = createFeatureApi();

/** Bind the page to its navigation signal and API client. */
export function bindCoveragePage({ signal, api } = {}) {
  state.pageSignal = signal || null;
  featureApi = api || createFeatureApi({ signal: state.pageSignal });
}

/** Start the next page load from fresh state, unless one already has. */
export function resetCoverageState(ownedState) {
  if (state === ownedState) {
    state = INITIAL_STATE();
  }
}

// IDs for both modal + dashboard service roads toggles
export const INCLUDE_SERVICE_TOGGLE_IDS = [
  "include-service-roads-toggle",
  "dashboard-include-service-roads-toggle",
];
export const COVERAGE_TRIP_MODE_SELECT_IDS = [
  "dashboard-coverage-trip-mode",
  "modal-coverage-trip-mode",
];
const COVERAGE_TRIP_MODES = new Set(["regular", "matched", "both"]);
export const DEFAULT_COVERAGE_TRIP_MODE = "both"; // ≈376.99

export const withSignal = (options = {}) => featureApi.withSignal(options);

export function normalizeCoverageTripMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return COVERAGE_TRIP_MODES.has(mode) ? mode : DEFAULT_COVERAGE_TRIP_MODE;
}

export function getCoverageTripModeLabel(mode) {
  switch (normalizeCoverageTripMode(mode)) {
    case "regular":
      return "GPS traces";
    case "matched":
      return "map-matched traces";
    default:
      return "the best available trace";
  }
}

export function getCoverageTripModeEndpointParam(mode) {
  return encodeURIComponent(normalizeCoverageTripMode(mode));
}

// =============================================================================
// API Helpers
// =============================================================================

export function apiGet(endpoint, options = {}) {
  return apiClient.get(`${API_BASE}${endpoint}`, withSignal(options));
}

export function apiPost(endpoint, data) {
  return apiClient.post(`${API_BASE}${endpoint}`, data, withSignal());
}

export function apiPatch(endpoint, data) {
  return apiClient.patch(`${API_BASE}${endpoint}`, data, withSignal());
}

export function apiDelete(endpoint) {
  return apiClient.delete(`${API_BASE}${endpoint}`, withSignal());
}
