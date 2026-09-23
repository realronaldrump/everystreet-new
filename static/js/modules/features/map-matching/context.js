/**
 * Map Matching page context: its cached elements, navigation signal, and
 * API client, shared by the page and its preview.
 */

import { createFeatureApi } from "../../core/feature-api.js";

export let elements = {};

export function cacheElements() {
  elements = {
    form: document.getElementById("map-matching-form"),
    dateControls: document.getElementById("map-match-date-controls"),
    startInput: document.getElementById("map-match-start"),
    endInput: document.getElementById("map-match-end"),
    unmatchedOnly: document.getElementById("map-match-unmatched-only"),
    tripControls: document.getElementById("map-match-trip-controls"),
    tripIdInput: document.getElementById("map-match-trip-id"),
    previewBtn: document.getElementById("map-match-preview-btn"),
    previewStatus: document.getElementById("map-match-preview-status"),
    previewPanel: document.getElementById("map-match-preview-panel"),
    previewSummary: document.getElementById("map-match-preview-summary"),
    engineLabel: document.getElementById("map-match-engine-label"),
    previewMapBtn: document.getElementById("map-match-preview-map-btn"),
    previewMapStatus: document.getElementById("map-match-preview-map-status"),
    previewMapSummary: document.getElementById("map-match-preview-map-summary"),
    previewMapEmpty: document.getElementById("map-match-preview-map-empty"),
    previewMap: document.getElementById("map-match-preview-map"),
    submitStatus: document.getElementById("map-match-submit-status"),
    refreshBtn: document.getElementById("map-match-refresh"),
    historyClearBtn: document.getElementById("map-match-history-clear"),
    historyStatus: document.getElementById("map-match-history-status"),
    historyCount: document.getElementById("map-match-history-count"),
    jobsList: document.getElementById("map-match-jobs-list"),
    currentEmpty: document.getElementById("map-match-current-empty"),
    currentPanel: document.getElementById("map-match-current-panel"),
    progressRing: document.getElementById("map-match-progress-ring"),
    progressPercent: document.getElementById("map-match-progress-percent"),
    progressMessage: document.getElementById("map-match-progress-message"),
    progressEngine: document.getElementById("map-match-progress-engine"),
    progressMetrics: document.getElementById("map-match-progress-metrics"),
    cancelBtn: document.getElementById("map-match-cancel-btn"),
    previewSelectAll: document.getElementById("map-match-preview-select-all"),
    previewSelectionCount: document.getElementById("map-match-preview-selection-count"),
    previewClearSelection: document.getElementById("map-match-preview-clear-selection"),
    previewUnmatchSelected: document.getElementById(
      "map-match-preview-unmatch-selected"
    ),
    previewDeleteSelected: document.getElementById("map-match-preview-delete-selected"),
    previewActionsStatus: document.getElementById("map-match-preview-actions-status"),
    advancedToggle: document.getElementById("map-match-advanced-toggle"),
    advancedOptions: document.getElementById("map-match-advanced-options"),
    resultsTrips: document.getElementById("map-match-results-trips"),
    resultsCount: document.getElementById("map-match-results-count"),
    bulkActions: document.getElementById("map-match-bulk-actions"),
    // Wizard elements
    matchMoreBtn: document.getElementById("mm-match-more-btn"),
    // History drawer elements
    historyDrawer: document.getElementById("mm-history-drawer"),
    historyFab: document.getElementById("mm-history-fab"),
    drawerBackdrop: document.getElementById("mm-drawer-backdrop"),
    drawerClose: document.getElementById("mm-drawer-close"),
    // Browse/Quick action elements
    browseMatchedBtn: document.getElementById("mm-browse-matched-btn"),
    browseFailedBtn: document.getElementById("mm-browse-failed-btn"),
    failedCountBadge: document.getElementById("mm-failed-count"),
    summaryMatched: document.getElementById("mm-summary-matched"),
    summaryValhalla: document.getElementById("mm-summary-valhalla"),
    summaryMapbox: document.getElementById("mm-summary-mapbox"),
    summaryFallback: document.getElementById("mm-summary-fallback"),
    summaryFailed: document.getElementById("mm-summary-failed"),
    summarySkipped: document.getElementById("mm-summary-skipped"),
    summaryFoot: document.getElementById("mm-summary-foot"),
    // Results headers
    resultsHeaderSuccess: document.getElementById("mm-results-header-success"),
    resultsHeaderBrowse: document.getElementById("mm-results-header-browse"),
    resultsHeaderFailed: document.getElementById("mm-results-header-failed"),
    browseSummary: document.getElementById("mm-browse-summary"),
    browseRefreshBtn: document.getElementById("mm-browse-refresh-btn"),
    browseBackBtn: document.getElementById("mm-browse-back-btn"),
    failedSummary: document.getElementById("mm-failed-summary"),
    failedRefreshBtn: document.getElementById("mm-failed-refresh-btn"),
    failedBackBtn: document.getElementById("mm-failed-back-btn"),
    // Tabs
    resultsTabs: document.getElementById("mm-results-tabs"),
    tabMatched: document.getElementById("mm-tab-matched"),
    tabFailed: document.getElementById("mm-tab-failed"),
    // Failed trips list
    matchedListContainer: document.getElementById("mm-matched-list-container"),
    failedListContainer: document.getElementById("mm-failed-list-container"),
    failedTrips: document.getElementById("mm-failed-trips"),
    failedListCount: document.getElementById("mm-failed-list-count"),
    failedBulkActions: document.getElementById("mm-failed-bulk-actions"),
    failedSelectionCount: document.getElementById("mm-failed-selection-count"),
    retrySelectedBtn: document.getElementById("mm-retry-selected-btn"),
    deleteFailedSelectedBtn: document.getElementById("mm-delete-failed-selected-btn"),
    failedSelectAll: document.getElementById("mm-failed-select-all"),
    retryAllBtn: document.getElementById("mm-retry-all-btn"),
    matchMoreContainer: document.getElementById("mm-match-more-container"),
    mapboxOnlyBtn: document.getElementById("map-match-mapbox-only-btn"),
  };
}
let pageSignal = null;
let featureApi = createFeatureApi();

/** Bind the page to its navigation signal and API client. */
export function setPageContext({ signal, api } = {}) {
  pageSignal = signal || null;
  featureApi = api || createFeatureApi({ signal: pageSignal });
}

/** Forget the page's elements and signal when it leaves. */
export function clearPageContext() {
  elements = {};
  pageSignal = null;
}

export const apiGet = (url, options = {}) => featureApi.get(url, options);
export const apiPost = (url, body, options = {}) => featureApi.post(url, body, options);
export const apiDelete = (url, options = {}) => featureApi.delete(url, options);
