/* global bootstrap, mapboxgl */
/**
 * Coverage Management — Comprehensive Refactor
 *
 * Two-view system:
 *   "list"  — area card grid (default)
 *   "area"  — full-viewport map with sidebar + street detail panel
 *
 * New features:
 *   - Mark segment as driven / undriveable / undriven (in-place GeoJSON update)
 *   - Progress ring with milestone celebrations
 *   - Job history tab (lazy-loaded)
 *   - Optimal route generation & display
 *   - Keyboard shortcuts
 *   - Glassmorphic map overlays
 *   - Street detail side panel (replaces popup)
 */

import apiClient from "../../core/api-client.js";
import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { createMap, isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import GlobalJobTracker from "../../ui/global-job-tracker.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml } from "../../utils.js";
import { renderAreaCards } from "./areas.js";
import {
  formatMiles,
  formatRelativeTime,
  getCoverageTierClass,
  normalizeCoveragePercent,
  setMetricValue,
} from "./stats.js";

const API_BASE = "/api/coverage";
const APP_SETTINGS_API = "/api/app_settings";

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
  currentMapFilter: "all",
  streetsCacheKey: null,
  streetsCacheGeojson: null,
  renderedStreetsCacheKey: null,
  streetsLoadRequestId: 0,
  hoveredSegmentId: null,
  hoverPopup: null,

  // Street detail panel
  selectedSegment: null, // { segmentId, properties }

  // Jobs/area tracking
  activeJobsByAreaId: new Map(),
  areaErrorById: new Map(),
  areaNameById: new Map(),
  areaRoadFilterVersionById: new Map(),
  activeErrorAreaId: null,
  areaViewRequestId: 0,

  // Milestone
  previousCoveragePercent: null,

  // Optimal route
  optimalRouteLayerAdded: false,
  optimalRouteTaskId: null,
  optimalRoutePollTimer: null,

  // Service roads (kept synced across toggles)
  currentAreaSyncToken: null,
  currentAreaRoadFilterVersion: null,

  // Page lifecycle
  pageActive: false,
  pageSignal: null,
});

let state = INITIAL_STATE();

// IDs for both modal + dashboard service roads toggles
const INCLUDE_SERVICE_TOGGLE_IDS = [
  "include-service-roads-toggle",
  "dashboard-include-service-roads-toggle",
];

const VALIDATION_DEBOUNCE_MS = 500;
const validationState = {
  status: "idle",
  lastQuery: "",
  lastType: "",
  candidates: [],
  selectedCandidate: null,
  confirmedCandidate: null,
  confirmedBoundary: null,
  note: "",
  requestId: 0,
  resolveRequestId: 0,
};
let validationElements = null;

const STREET_LAYERS = ["streets-undriven", "streets-driven", "streets-undriveable"];
const HIGHLIGHT_LAYER_ID = "streets-highlight";
const HOVER_LAYER_ID = "streets-hover";

// Ring math: r=60, cx/cy=70, viewBox 140×140
const RING_R = 60;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R; // ≈376.99

const withSignal = (options = {}) =>
  state.pageSignal ? { ...options, signal: state.pageSignal } : options;

// =============================================================================
// Initialization
// =============================================================================

export default async function initCoverageManagementPage({ signal, cleanup } = {}) {
  state.pageSignal = signal || null;
  state.pageActive = true;

  // Move modal to #modals-container to avoid z-index stacking issues
  const addAreaModal = document.getElementById("addAreaModal");
  const modalsContainer = document.getElementById("modals-container");
  if (addAreaModal && modalsContainer && !modalsContainer.contains(addAreaModal)) {
    modalsContainer.appendChild(addAreaModal);
  }

  setupEventListeners(signal);
  setupSidebarTabs(signal);
  setupStreetMarkingListeners(signal);
  setupKeyboardShortcuts(signal);
  initValidationUI();
  await loadCoverageFilterSettings();

  // Load initial area list
  await loadAreas();

  // Resume any background jobs (GlobalJobTracker handles localStorage persistence)
  // No-op here — GlobalJobTracker auto-resumes.

  // Teardown function
  const teardown = () => {
    state.pageActive = false;
    state.pageSignal = null;

    // Clean up optional route poll timer
    if (state.optimalRoutePollTimer) {
      clearTimeout(state.optimalRoutePollTimer);
    }

    // Clean up map
    if (state.map) {
      try {
        state.map.remove();
      } catch {
        /* ignore */
      }
    }

    // Clean up hover popup
    if (state.hoverPopup) {
      try {
        state.hoverPopup.remove();
      } catch {
        /* ignore */
      }
    }

    // Reset all state
    state = INITIAL_STATE();
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }

  return teardown;
}

// =============================================================================
// Event Listeners
// =============================================================================

function setupEventListeners(signal) {
  const opt = signal ? { signal } : false;

  // List view controls
  document
    .getElementById("refresh-list-btn")
    ?.addEventListener("click", loadAreas, opt);

  // Area cards container (delegated)
  document
    .getElementById("area-cards-grid")
    ?.addEventListener("click", handleAreaCardClick, opt);

  // Add area button
  document.getElementById("add-coverage-area")?.addEventListener("click", addArea, opt);

  // Modal form inputs
  const locationInput = document.getElementById("location-input");
  const locationType = document.getElementById("location-type");
  const debouncedValidate = debounce(validateLocationInput, VALIDATION_DEBOUNCE_MS);

  const handleValidationTrigger = () => {
    validationState.requestId += 1;
    clearValidationSelection();
    const query = locationInput?.value.trim() || "";
    if (!query) {
      setValidationStatus({
        icon: "fa-location-dot",
        message: "Enter a location to validate.",
        tone: "neutral",
      });
      validationState.lastQuery = "";
      validationState.lastType = "";
      validationState.candidates = [];
      renderValidationCandidates([]);
      if (validationElements?.note) {
        validationElements.note.textContent = "";
        validationElements.note.classList.add("d-none");
      }
    } else if (query.length < 2) {
      setValidationStatus({
        icon: "fa-pen",
        message: "Keep typing to validate.",
        tone: "neutral",
      });
      validationState.lastQuery = "";
      validationState.lastType = "";
      validationState.candidates = [];
      renderValidationCandidates([]);
      if (validationElements?.note) {
        validationElements.note.textContent = "";
        validationElements.note.classList.add("d-none");
      }
    } else {
      setValidationStatus({
        icon: "fa-spinner fa-spin",
        message: "Validating location…",
        tone: "info",
      });
    }
    debouncedValidate();
  };

  locationInput?.addEventListener("input", handleValidationTrigger, opt);
  locationType?.addEventListener("change", handleValidationTrigger, opt);

  // Service roads toggles
  INCLUDE_SERVICE_TOGGLE_IDS.forEach((id) => {
    document
      .getElementById(id)
      ?.addEventListener("change", handleIncludeServiceRoadsToggle, opt);
  });

  // Validation candidates
  document
    .getElementById("location-validation-candidates")
    ?.addEventListener("click", handleCandidateClick, opt);

  // Reset validation on modal close
  document
    .getElementById("addAreaModal")
    ?.addEventListener("hidden.bs.modal", () => resetValidationState(), opt);

  // Error panel dismiss
  document
    .getElementById("coverage-error-dismiss")
    ?.addEventListener("click", hideCoverageErrorDetails, opt);

  // Sidebar back button
  document
    .getElementById("sidebar-back-btn")
    ?.addEventListener("click", backToList, opt);

  // Recalculate / rebuild buttons in sidebar
  document.getElementById("recalculate-coverage-btn")?.addEventListener(
    "click",
    () => {
      if (state.currentAreaId) {
        const name = state.areaNameById.get(state.currentAreaId) || "this area";
        recalculateCoverage(state.currentAreaId, name);
      }
    },
    opt
  );

  document.getElementById("rebuild-area-btn")?.addEventListener(
    "click",
    () => {
      if (state.currentAreaId) {
        const name = state.areaNameById.get(state.currentAreaId) || "this area";
        rebuildArea(state.currentAreaId, name);
      }
    },
    opt
  );

  // Map filter chips
  document.getElementById("map-filter-overlay")?.addEventListener(
    "click",
    (e) => {
      const chip = e.target.closest("[data-filter]");
      if (!chip) {
        return;
      }
      applyMapFilter(chip.dataset.filter || "all");
    },
    opt
  );

  // Optimal route generate button
  document.getElementById("generate-route-btn")?.addEventListener(
    "click",
    () => {
      if (state.currentAreaId) {
        generateOptimalRoute(state.currentAreaId);
      }
    },
    opt
  );

  // Show/hide route toggle
  document.getElementById("show-route-toggle")?.addEventListener(
    "change",
    (e) => {
      toggleOptimalRouteVisibility(e.target.checked);
    },
    opt
  );

  // Window resize handler
  let resizeTimeout;
  window.addEventListener(
    "resize",
    () => {
      if (state.map) {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => state.map.resize(), 200);
      }
    },
    opt
  );
}

function setupSidebarTabs(signal) {
  const opt = signal ? { signal } : false;
  document.querySelectorAll(".sidebar-tab-btn").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        const targetId = btn.dataset.tabTarget;
        if (!targetId) {
          return;
        }

        // Update tab buttons
        document.querySelectorAll(".sidebar-tab-btn").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });

        // Show/hide panels
        document.querySelectorAll(".sidebar-tab-panel").forEach((panel) => {
          panel.hidden = panel.id !== targetId;
        });

        // Lazy-load history
        if (targetId === "sidebar-tab-history" && state.currentAreaId) {
          loadJobHistory(state.currentAreaId);
        }
      },
      opt
    );
  });
}

function setupStreetMarkingListeners(signal) {
  const opt = signal ? { signal } : false;

  document.getElementById("street-mark-driven-btn")?.addEventListener(
    "click",
    async () => {
      if (!state.selectedSegment || !state.currentAreaId) {
        return;
      }
      await markSegmentDriven(state.currentAreaId, state.selectedSegment.segmentId);
    },
    opt
  );

  document.getElementById("street-mark-undriveable-btn")?.addEventListener(
    "click",
    async () => {
      if (!state.selectedSegment || !state.currentAreaId) {
        return;
      }
      await markSegmentUndriveable(
        state.currentAreaId,
        state.selectedSegment.segmentId
      );
    },
    opt
  );

  document.getElementById("street-mark-undriven-btn")?.addEventListener(
    "click",
    async () => {
      if (!state.selectedSegment || !state.currentAreaId) {
        return;
      }
      await markSegmentUndriven(state.currentAreaId, state.selectedSegment.segmentId);
    },
    opt
  );

  document.getElementById("street-detail-close")?.addEventListener(
    "click",
    () => {
      closeStreetDetailPanel();
    },
    opt
  );
}

function setupKeyboardShortcuts(signal) {
  document.addEventListener(
    "keydown",
    (e) => {
      // Don't fire in inputs
      const tag = e.target?.tagName?.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      if (e.target?.isContentEditable) {
        return;
      }
      if (e.defaultPrevented) {
        return;
      }

      if (state.view === "area") {
        if (e.key === "Escape") {
          e.preventDefault();
          if (state.selectedSegment) {
            closeStreetDetailPanel();
          } else {
            backToList();
          }
        } else if (e.key === "1") {
          e.preventDefault();
          applyMapFilter("all");
        } else if (e.key === "2") {
          e.preventDefault();
          applyMapFilter("driven");
        } else if (e.key === "3") {
          e.preventDefault();
          applyMapFilter("undriven");
        }
      } else if (state.view === "list") {
        if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          const modal = document.getElementById("addAreaModal");
          if (modal) {
            bootstrap.Modal.getOrCreateInstance(modal).show();
          }
        } else if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          loadAreas();
        }
      }
    },
    signal ? { signal } : false
  );
}

// =============================================================================
// View Switching
// =============================================================================

async function switchView(viewName) {
  const currentViewEl = document.getElementById(
    state.view === "list" ? "coverage-list-view" : "coverage-area-view"
  );
  const nextViewEl = document.getElementById(
    viewName === "list" ? "coverage-list-view" : "coverage-area-view"
  );

  if (!currentViewEl || !nextViewEl) {
    return;
  }

  // Exit current view
  currentViewEl.classList.add("is-exiting");
  await new Promise((r) => setTimeout(r, 200));
  currentViewEl.style.display = "none";
  currentViewEl.classList.remove("is-exiting");

  // Enter next view
  if (viewName === "area") {
    nextViewEl.style.display = "flex";
    nextViewEl.setAttribute("aria-hidden", "false");
  } else {
    nextViewEl.style.display = "block";
    nextViewEl.setAttribute("aria-hidden", "false");
  }
  nextViewEl.classList.add("is-entering");
  await new Promise((r) => setTimeout(r, 280));
  nextViewEl.classList.remove("is-entering");

  state.view = viewName;

  // Resize map after view transition
  if (viewName === "area" && state.map) {
    setTimeout(() => state.map.resize(), 50);
  }
}

async function backToList() {
  closeStreetDetailPanel();
  state.areaViewRequestId += 1;

  // Reset area-view state
  state.previousCoveragePercent = null;
  state.currentAreaId = null;
  state.currentAreaData = null;
  state.currentAreaSyncToken = null;
  state.currentAreaRoadFilterVersion = null;

  // Reset sidebar tabs to Stats
  document.querySelectorAll(".sidebar-tab-btn").forEach((b, i) => {
    b.classList.toggle("is-active", i === 0);
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
  });
  document.querySelectorAll(".sidebar-tab-panel").forEach((panel, i) => {
    panel.hidden = i !== 0;
  });

  await switchView("list");
  await loadAreas();
}

// =============================================================================
// Service Roads Filter
// =============================================================================

function getIncludeServiceRoadsToggles() {
  return INCLUDE_SERVICE_TOGGLE_IDS.map((id) => document.getElementById(id)).filter(
    Boolean
  );
}

function setIncludeServiceRoadsToggleState({ checked, disabled } = {}) {
  getIncludeServiceRoadsToggles().forEach((t) => {
    if (typeof checked === "boolean") {
      t.checked = checked;
    }
    if (typeof disabled === "boolean") {
      t.disabled = disabled;
    }
  });
}

function getIncludeServiceRoadsSelection() {
  const toggles = getIncludeServiceRoadsToggles();
  return toggles.length ? Boolean(toggles[0].checked) : true;
}

function setIncludeServiceRoadsStatus(message, tone = "secondary") {
  const tones = {
    secondary: "text-secondary",
    info: "text-info",
    success: "text-success",
    danger: "text-danger",
  };
  const cls = tones[tone] || tones.secondary;
  document.querySelectorAll("[data-include-service-status]").forEach((el) => {
    el.className = `form-text d-block mt-1 ${cls}`;
    el.textContent = message;
  });
}

function parseIncludeServiceFromFilterSignature(sig) {
  if (typeof sig !== "string" || !sig.trim()) {
    return null;
  }
  const m = sig.match(/(?:^|\|)service=(include|exclude)(?:\||$)/);
  return m ? m[1] === "include" : null;
}

function shouldRebuildForServiceFilter(areaId, includeServiceRoads) {
  const sig =
    state.areaRoadFilterVersionById.get(areaId) ||
    (state.currentAreaId === areaId ? state.currentAreaRoadFilterVersion : null);
  const areaIncludes = parseIncludeServiceFromFilterSignature(sig);
  if (areaIncludes === null) {
    return true;
  }
  return areaIncludes !== includeServiceRoads;
}

async function loadCoverageFilterSettings() {
  setIncludeServiceRoadsToggleState({ disabled: true });
  setIncludeServiceRoadsStatus("Loading filter settings…", "info");

  try {
    const settings = await apiClient.get(APP_SETTINGS_API, withSignal());
    const include = settings?.coverageIncludeServiceRoads !== false;
    setIncludeServiceRoadsToggleState({ checked: include });
    setIncludeServiceRoadsStatus(
      include
        ? "Service roads are included for new area builds."
        : "Service roads are excluded for new area builds.",
      "secondary"
    );
  } catch {
    setIncludeServiceRoadsToggleState({ checked: true });
    setIncludeServiceRoadsStatus("Using default: include service roads.", "secondary");
  } finally {
    setIncludeServiceRoadsToggleState({ disabled: false });
  }
}

async function handleIncludeServiceRoadsToggle(event) {
  const toggle = event?.currentTarget;
  if (!toggle) {
    return;
  }

  const include = Boolean(toggle.checked);
  const prev = !include;
  setIncludeServiceRoadsToggleState({ checked: include, disabled: true });
  setIncludeServiceRoadsStatus("Saving filter setting…", "info");

  try {
    await apiClient.post(
      APP_SETTINGS_API,
      { coverageIncludeServiceRoads: include },
      withSignal()
    );
    setIncludeServiceRoadsStatus(
      include
        ? "Service roads are included for new area builds."
        : "Service roads are excluded for new area builds.",
      "success"
    );
    notificationManager.show(
      "Street filter saved. Use Recalculate Coverage to apply it.",
      "success"
    );
  } catch (error) {
    setIncludeServiceRoadsToggleState({ checked: prev });
    setIncludeServiceRoadsStatus("Save failed. Keeping previous setting.", "danger");
    notificationManager.show(
      `Failed to save filter setting: ${error.message}`,
      "danger"
    );
  } finally {
    setIncludeServiceRoadsToggleState({ disabled: false });
  }
}

// =============================================================================
// API Helpers
// =============================================================================

function apiGet(endpoint) {
  return apiClient.get(`${API_BASE}${endpoint}`, withSignal());
}

function apiPost(endpoint, data) {
  return apiClient.post(`${API_BASE}${endpoint}`, data, withSignal());
}

function apiPatch(endpoint, data) {
  return apiClient.patch(`${API_BASE}${endpoint}`, data, withSignal());
}

function apiDelete(endpoint) {
  return apiClient.delete(`${API_BASE}${endpoint}`, withSignal());
}

// =============================================================================
// Area List
// =============================================================================

async function loadAreas() {
  try {
    // Fetch areas and active jobs in parallel
    const [areasData, jobsData] = await Promise.all([
      apiGet("/areas"),
      apiGet("/jobs").catch(() => ({ jobs: [] })),
    ]);

    // Build active jobs map
    state.activeJobsByAreaId = new Map();
    (jobsData?.jobs || []).forEach((job) => {
      if (job.area_id) {
        state.activeJobsByAreaId.set(job.area_id, job);
      }
    });

    const { hasAreas } = renderAreaCards({
      areas: areasData.areas || [],
      activeJobsByAreaId: state.activeJobsByAreaId,
      areaErrorById: state.areaErrorById,
      areaNameById: state.areaNameById,
    });

    if (hasAreas) {
      refreshCoverageErrorDetails(areasData.areas);
    } else {
      hideCoverageErrorDetails();
    }

    const countEl = document.getElementById("total-areas-count");
    if (countEl) {
      countEl.textContent = (areasData.areas || []).length;
    }
  } catch (error) {
    console.error("Failed to load areas:", error);
    notificationManager.show(
      `Failed to load coverage areas: ${error.message}`,
      "danger"
    );
  }
}

function handleAreaCardClick(event) {
  // Area actions from card + explicit error details trigger
  const btn = event.target.closest("[data-area-action], [data-error-action]");
  if (!btn) {
    return;
  }

  const { areaId } = btn.dataset;
  if (!areaId) {
    return;
  }

  const areaName =
    btn.dataset.areaName || state.areaNameById.get(areaId) || "Coverage area";
  const action = btn.dataset.areaAction;

  // Handle error trigger (card status click)
  if (btn.dataset.errorAction === "show") {
    showCoverageErrorDetails(areaId, areaName);
    return;
  }

  if (!action) {
    return;
  }

  switch (action) {
    case "view":
      viewArea(areaId);
      break;
    case "recalculate":
      recalculateCoverage(areaId, areaName);
      break;
    case "rebuild":
      rebuildArea(areaId, areaName);
      break;
    case "delete":
      deleteArea(areaId, areaName);
      break;
  }
}

// =============================================================================
// Area CRUD
// =============================================================================

async function addArea() {
  const displayNameInput = document.getElementById("location-input").value.trim();
  const areaType = document.getElementById("location-type").value;

  if (!displayNameInput) {
    notificationManager.show("Please enter a location name", "warning");
    return;
  }

  if (!validationState.confirmedBoundary || !validationState.confirmedCandidate) {
    notificationManager.show(
      "Please validate and confirm a location before adding.",
      "warning"
    );
    return;
  }

  const displayName =
    validationState.confirmedCandidate.display_name || displayNameInput;

  try {
    // Close modal
    const addModal = document.getElementById("addAreaModal");
    addModal?.querySelector(":focus")?.blur();
    bootstrap.Modal.getInstance(addModal)?.hide();

    const result = await apiPost("/areas", {
      display_name: displayName,
      area_type: areaType,
      boundary: validationState.confirmedBoundary,
    });

    await loadAreas();

    if (result.job_id) {
      GlobalJobTracker.start({
        jobId: result.job_id,
        jobType: "area_ingestion",
        areaId: result.area_id || null,
        areaName: displayName,
        initialMessage: result.message || "Setting up area…",
      });

      notificationManager.show(
        result.message || `"${displayName}" is being set up in the background.`,
        "info"
      );
    }

    document.getElementById("location-input").value = "";
    resetValidationState();
  } catch (error) {
    console.error("Failed to add area:", error);
    notificationManager.show(`Failed to add area: ${error.message}`, "danger");
  }
}

async function deleteArea(areaId, displayName) {
  const confirmed = await confirmationDialog.show({
    title: "Delete Coverage Area",
    message: `Delete "<strong>${escapeHtml(displayName)}</strong>"?<br><br>This will remove all coverage data for this area.`,
    allowHtml: true,
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiDelete(`/areas/${areaId}`);
    notificationManager.show(`Area "${displayName}" deleted`, "success");
    if (state.currentAreaId === areaId) {
      await backToList();
    } else {
      await loadAreas();
    }
  } catch (error) {
    console.error("Failed to delete area:", error);
    notificationManager.show(`Failed to delete area: ${error.message}`, "danger");
    await loadAreas();
  }
}

async function rebuildArea(areaId, displayName) {
  const confirmed = await confirmationDialog.show({
    title: "Rebuild Coverage Area",
    message:
      "Rebuild this area with fresh data from the local OSM extract?<br><br>This may take a few minutes.",
    allowHtml: true,
    confirmText: "Rebuild",
    confirmButtonClass: "btn-warning",
  });

  if (!confirmed) {
    return;
  }

  try {
    const result = await apiPost(`/areas/${areaId}/rebuild`, {});
    await loadAreas();

    if (result.job_id) {
      GlobalJobTracker.start({
        jobId: result.job_id,
        jobType: "area_rebuild",
        areaId,
        areaName: displayName,
        initialMessage: result.message || "Rebuilding area…",
      });
      notificationManager.show(
        result.message || "Rebuild started in the background.",
        "info"
      );
    }
  } catch (error) {
    console.error("Failed to rebuild area:", error);
    notificationManager.show(`Failed to rebuild area: ${error.message}`, "danger");
  }
}

async function recalculateCoverage(areaId, displayName) {
  const includeServiceRoads = getIncludeServiceRoadsSelection();
  const needsRebuild = shouldRebuildForServiceFilter(areaId, includeServiceRoads);
  const policyLabel = includeServiceRoads ? "include" : "exclude";

  const confirmed = await confirmationDialog.show({
    title: "Recalculate Coverage",
    message: needsRebuild
      ? `Recalculate coverage for "<strong>${escapeHtml(displayName)}</strong>" using the current service-road policy (<strong>${policyLabel}</strong>)?<br><br>This will rebuild streets from OSM, then rematch trips.`
      : `Recalculate coverage for "<strong>${escapeHtml(displayName)}</strong>" by matching all existing trips?<br><br>Street filters already match — this will run a fast backfill.`,
    allowHtml: true,
    confirmText: needsRebuild ? "Recalculate + Rebuild Streets" : "Recalculate",
    confirmButtonClass: needsRebuild ? "btn-warning" : "btn-info",
  });

  if (!confirmed) {
    return;
  }

  try {
    if (needsRebuild) {
      const result = await apiPost(`/areas/${areaId}/rebuild`, {});
      await loadAreas();
      if (result.job_id) {
        GlobalJobTracker.start({
          jobId: result.job_id,
          jobType: "area_rebuild",
          areaId,
          areaName: displayName,
          initialMessage:
            result.message || "Rebuilding area and recalculating coverage…",
        });
      }
      notificationManager.show(
        result.message || "Rebuild started in the background.",
        "info"
      );
      return;
    }

    notificationManager.show("Recalculating coverage… This may take a moment.", "info");
    const result = await apiPost(`/areas/${areaId}/backfill`, {});
    notificationManager.show(
      `Coverage recalculated! Updated ${result.segments_updated} segments.`,
      "success"
    );
    await loadAreas();
    if (state.currentAreaId === areaId) {
      await refreshDashboardStats(areaId);
    }
  } catch (error) {
    console.error("Failed to recalculate coverage:", error);
    notificationManager.show(
      `Failed to recalculate coverage: ${error.message}`,
      "danger"
    );
  }
}

// =============================================================================
// Area Detail View
// =============================================================================

async function viewArea(areaId) {
  const requestId = ++state.areaViewRequestId;
  state.currentAreaId = areaId;
  state.previousCoveragePercent = null;
  closeStreetDetailPanel();

  // Transition to area view immediately
  await switchView("area");

  try {
    // Fetch area details + segment summary in parallel
    const [data, summary] = await Promise.all([
      apiGet(`/areas/${areaId}`),
      apiGet(`/areas/${areaId}/streets/summary`),
    ]);

    if (requestId !== state.areaViewRequestId || state.currentAreaId !== areaId) {
      return;
    }

    const { area } = data;
    if (!area) {
      throw new Error("Area details are unavailable.");
    }
    state.currentAreaSyncToken = area?.last_synced || area?.created_at || null;
    state.currentAreaRoadFilterVersion = area?.road_filter_version || null;
    state.currentAreaData = area;

    if (area?.id) {
      state.areaRoadFilterVersionById.set(area.id, state.currentAreaRoadFilterVersion);
    }

    // Update sidebar header
    const sidebarNameEl = document.getElementById("sidebar-area-name");
    if (sidebarNameEl) {
      sidebarNameEl.textContent = area.display_name;
    }
    const sidebarTypeEl = document.getElementById("sidebar-area-type");
    if (sidebarTypeEl) {
      sidebarTypeEl.textContent = area.area_type || "";
    }

    // Set initial coverage percent for milestone tracking
    state.previousCoveragePercent = normalizeCoveragePercent(area.coverage_percentage);

    // Update stats UI
    updateStatsUI(area, summary);

    // Init or update map
    if (data.bounding_box) {
      await initOrUpdateMap(areaId, data.bounding_box, state.currentAreaSyncToken);
    }
  } catch (error) {
    if (requestId !== state.areaViewRequestId || state.currentAreaId !== areaId) {
      return;
    }
    console.error("Failed to load area:", error);
    notificationManager.show(`Failed to load area details: ${error.message}`, "danger");
  }
}

async function refreshDashboardStats(areaId) {
  try {
    const [data, summary] = await Promise.all([
      apiGet(`/areas/${areaId}`),
      apiGet(`/areas/${areaId}/streets/summary`),
    ]);
    if (areaId !== state.currentAreaId) {
      return;
    }
    const { area } = data;
    if (!area) {
      return;
    }
    const prevPct = state.previousCoveragePercent;
    const newPct = normalizeCoveragePercent(area.coverage_percentage);

    updateStatsUI(area, summary);
    checkMilestone(prevPct, newPct);
    state.previousCoveragePercent = newPct;
  } catch (error) {
    console.error("Failed to refresh stats:", error);
  }
}

// =============================================================================
// Stats UI + Progress Ring
// =============================================================================

function updateStatsUI(area, summary) {
  const pct = normalizeCoveragePercent(area.coverage_percentage);

  // Large ring
  const ringFillEl = document.querySelector("#ring-svg .progress-ring-fill");
  if (ringFillEl) {
    renderProgressRing(ringFillEl, pct);
  }

  // Ring center label
  const ringPctEl = document.getElementById("ring-pct-value");
  if (ringPctEl) {
    ringPctEl.textContent = `${pct.toFixed(1)}%`;
  }

  // Map coverage chip
  const mapPctEl = document.getElementById("map-coverage-pct");
  if (mapPctEl) {
    mapPctEl.textContent = `${pct.toFixed(1)}%`;
  }

  // Quick stat pills
  const remaining = Math.max(
    0,
    (area.total_length_miles || 0) - (area.driven_length_miles || 0)
  );
  setMetricValue("qs-driven", area.driven_length_miles || 0, {
    decimals: 1,
    suffix: " mi",
  });
  setMetricValue("qs-remaining", remaining, { decimals: 1, suffix: " mi" });
  setMetricValue("qs-total", area.total_length_miles || 0, {
    decimals: 1,
    suffix: " mi",
  });

  const undrivenSegs = summary?.segment_counts?.undriven || 0;
  setMetricValue("qs-segments-remaining", undrivenSegs);

  // Segment breakdown
  setMetricValue("seg-driven", summary?.segment_counts?.driven || 0);
  setMetricValue("seg-undriven", summary?.segment_counts?.undriven || 0);
  setMetricValue("seg-undriveable", summary?.segment_counts?.undriveable || 0);

  // Last activity
  const lastActivityEl = document.getElementById("qs-last-activity");
  if (lastActivityEl) {
    lastActivityEl.textContent = area.last_synced
      ? formatRelativeTime(area.last_synced)
      : "—";
  }
}

function renderProgressRing(fillEl, pct) {
  const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
  fillEl.style.strokeDashoffset = offset.toFixed(2);

  // Update tier class
  const tierClass = getCoverageTierClass(pct);
  Array.from(fillEl.classList)
    .filter((className) => className.startsWith("tier-"))
    .forEach((className) => fillEl.classList.remove(className));
  fillEl.classList.add("progress-ring-fill", tierClass);
}

// =============================================================================
// Milestone Celebrations
// =============================================================================

const MILESTONES = [25, 50, 75, 100];
const MILESTONE_MESSAGES = {
  25: {
    icon: "🌱",
    title: "25% Complete!",
    sub: "Great start — a quarter of the way there.",
  },
  50: {
    icon: "⚡",
    title: "Halfway There!",
    sub: "You're right in the thick of it. Keep going!",
  },
  75: {
    icon: "🔥",
    title: "75% Done!",
    sub: "Almost there — the finish line is in sight!",
  },
  100: {
    icon: "🏆",
    title: "Every Street!",
    sub: "You've driven every street in this area!",
  },
};

function checkMilestone(prevPct, newPct) {
  if (prevPct === null || prevPct === undefined) {
    return;
  }
  const crossed = MILESTONES.find((m) => prevPct < m && newPct >= m);
  if (!crossed) {
    return;
  }
  showMilestoneCelebration(MILESTONE_MESSAGES[crossed]);
}

function showMilestoneCelebration({ icon, title, sub }) {
  const overlay = document.getElementById("milestone-overlay");
  if (!overlay) {
    return;
  }

  overlay.innerHTML = `
    <div class="milestone-content">
      <span class="milestone-icon">${icon}</span>
      <h2 class="milestone-title">${escapeHtml(title)}</h2>
      <p class="milestone-subtitle">${escapeHtml(sub)}</p>
      <button class="btn btn-primary" id="milestone-dismiss-btn">Keep Exploring</button>
    </div>`;

  overlay.classList.add("is-celebrating");
  overlay.setAttribute("aria-hidden", "false");

  document.getElementById("milestone-dismiss-btn")?.addEventListener(
    "click",
    () => {
      overlay.classList.remove("is-celebrating");
      overlay.setAttribute("aria-hidden", "true");
    },
    { once: true }
  );

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    overlay.classList.remove("is-celebrating");
    overlay.setAttribute("aria-hidden", "true");
  }, 8000);
}

// =============================================================================
// Map
// =============================================================================

async function initOrUpdateMap(areaId, bbox, areaSyncToken = null) {
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

    state.map = createMap("coverage-map", {
      style: styleUrl,
      accessToken,
      bounds: [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      fitBoundsOptions: { padding: 50 },
      attributionControl: false,
    });

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

async function loadStreets(areaId, areaSyncToken = null) {
  if (!state.map || !areaId) {
    return;
  }

  const requestId = ++state.streetsLoadRequestId;
  const cacheKey = buildStreetsCacheKey(areaId, areaSyncToken);

  // Already rendered this version
  if (cacheKey === state.renderedStreetsCacheKey && state.map.getSource("streets")) {
    return;
  }

  try {
    let data = state.streetsCacheKey === cacheKey ? state.streetsCacheGeojson : null;
    if (!data) {
      data = await apiGet(`/areas/${areaId}/streets/all`);
      state.streetsCacheKey = cacheKey;
      state.streetsCacheGeojson = data;
    }

    if (
      requestId !== state.streetsLoadRequestId ||
      areaId !== state.currentAreaId ||
      !state.map
    ) {
      return;
    }

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
        paint: { "line-color": "#c47050", "line-width": 4, "line-opacity": 0.85 },
      });

      // Driven streets
      state.map.addLayer({
        id: "streets-driven",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "driven"],
        paint: { "line-color": "#4d9a6a", "line-width": 4, "line-opacity": 0.85 },
      });

      // Undriveable streets (dashed)
      state.map.addLayer({
        id: "streets-undriveable",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "undriveable"],
        paint: {
          "line-color": "#727a84",
          "line-width": 2,
          "line-opacity": 0.5,
          "line-dasharray": [2, 2],
        },
      });

      // Hover layer (white glow, no pointer events — driven by JS filter)
      state.map.addLayer({
        id: HOVER_LAYER_ID,
        type: "line",
        source: "streets",
        filter: ["==", ["get", "segment_id"], ""],
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.3 },
      });

      // Highlight layer (selected segment, on top)
      state.map.addLayer({
        id: HIGHLIGHT_LAYER_ID,
        type: "line",
        source: "streets",
        filter: ["==", ["get", "segment_id"], ""],
        paint: { "line-color": "#d4a24a", "line-width": 6, "line-opacity": 0.95 },
      });

      setupStreetInteractivity();
    }
  } catch (error) {
    console.error("Failed to load streets:", error);
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

function applyMapFilter(filter) {
  state.currentMapFilter = filter;

  // Update filter chip UI
  document.querySelectorAll(".map-filter-chip").forEach((chip) => {
    const active = chip.dataset.filter === filter;
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
    if (filter === "driven" && layerId !== "streets-driven") {
      visible = "none";
    }
    if (filter === "undriven" && layerId !== "streets-undriven") {
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

  if (state.currentMapFilter === "driven") {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      ["==", ["get", "status"], "driven"],
    ]);
  } else if (state.currentMapFilter === "undriven") {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      ["==", ["get", "status"], "undriven"],
    ]);
  } else {
    state.map.setFilter(HIGHLIGHT_LAYER_ID, baseFilter);
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
    typeof props.status === "string" ? props.status.toLowerCase() : "unknown";

  state.selectedSegment = { segmentId, properties: props };

  // Populate panel fields
  const nameEl = document.getElementById("street-detail-name");
  if (nameEl) {
    nameEl.textContent = getStreetDisplayName(props.street_name, segmentId);
  }

  const statusPillEl = document.getElementById("street-detail-status-pill");
  if (statusPillEl) {
    statusPillEl.textContent = formatStatus(status);
    statusPillEl.className = `street-status-pill status-${status}`;
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

  // Highlight segment on map
  setHighlightedSegment(segmentId);

  // Open panel
  const panel = document.getElementById("street-detail-panel");
  if (panel) {
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
  }
}

function closeStreetDetailPanel() {
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

async function markSegmentDriven(areaId, segmentId) {
  if (!segmentId) {
    notificationManager.show(
      "Cannot mark segment: missing segment identifier.",
      "danger"
    );
    return;
  }
  try {
    await apiPost(`/areas/${areaId}/streets/mark-driven`, { segment_ids: [segmentId] });
    notificationManager.show("Segment marked as driven", "success");
    updateStreetStatus(segmentId, "driven");
    closeStreetDetailPanel();
    await refreshDashboardStats(areaId);
  } catch (error) {
    notificationManager.show(`Failed to mark as driven: ${error.message}`, "danger");
  }
}

async function markSegmentUndriveable(areaId, segmentId) {
  if (!segmentId) {
    notificationManager.show(
      "Cannot mark segment: missing segment identifier.",
      "danger"
    );
    return;
  }
  try {
    await apiPatch(`/areas/${areaId}/streets/${segmentId}`, { status: "undriveable" });
    notificationManager.show("Segment marked as undriveable", "success");
    updateStreetStatus(segmentId, "undriveable");
    closeStreetDetailPanel();
    await refreshDashboardStats(areaId);
  } catch (error) {
    notificationManager.show(
      `Failed to mark as undriveable: ${error.message}`,
      "danger"
    );
  }
}

async function markSegmentUndriven(areaId, segmentId) {
  if (!segmentId) {
    notificationManager.show(
      "Cannot reset segment: missing segment identifier.",
      "danger"
    );
    return;
  }
  try {
    await apiPatch(`/areas/${areaId}/streets/${segmentId}`, { status: "undriven" });
    notificationManager.show("Segment reset to undriven", "success");
    updateStreetStatus(segmentId, "undriven");
    closeStreetDetailPanel();
    await refreshDashboardStats(areaId);
  } catch (error) {
    notificationManager.show(`Failed to reset segment: ${error.message}`, "danger");
  }
}

/**
 * Mutates the cached GeoJSON in-place and pushes updated data to the map source.
 * This gives instant visual feedback without a full reload.
 */
function updateStreetStatus(segmentId, newStatus) {
  const source = state.map?.getSource("streets");
  if (!source || !state.streetsCacheGeojson?.features) {
    return;
  }

  const feature = state.streetsCacheGeojson.features.find(
    (f) => f.properties?.segment_id === segmentId
  );

  if (feature) {
    feature.properties.status = newStatus;
    if (newStatus === "driven") {
      const now = new Date().toISOString();
      feature.properties.last_driven_at = now;
      if (!feature.properties.first_driven_at) {
        feature.properties.first_driven_at = now;
      }
    }
  }

  source.setData(state.streetsCacheGeojson);
  // Invalidate rendered cache key so next viewArea re-fetches from server
  state.renderedStreetsCacheKey = null;
}

// =============================================================================
// Job History
// =============================================================================

async function loadJobHistory(areaId) {
  const container = document.getElementById("job-history-container");
  if (!container) {
    return;
  }

  container.innerHTML = `<p class="text-secondary small text-center mt-4">
    <i class="fas fa-spinner fa-spin me-1" aria-hidden="true"></i>Loading history…
  </p>`;

  try {
    const data = await apiGet(`/areas/${areaId}/jobs`);
    if (areaId !== state.currentAreaId) {
      return;
    }
    renderJobHistory(data.jobs || []);
  } catch {
    if (areaId !== state.currentAreaId) {
      return;
    }
    container.innerHTML =
      '<p class="text-secondary small text-center mt-4">Could not load job history.</p>';
  }
}

function renderJobHistory(jobs) {
  const container = document.getElementById("job-history-container");
  if (!container) {
    return;
  }

  if (!jobs.length) {
    container.innerHTML =
      '<p class="text-secondary small text-center mt-4">No recent jobs found.</p>';
    return;
  }

  const typeLabels = {
    area_ingestion: "Area Setup",
    area_rebuild: "OSM Rebuild",
    area_backfill: "Coverage Recalculate",
    optimal_route: "Route Generation",
  };

  const statusIcons = {
    completed:
      '<i class="fas fa-check-circle text-success" aria-label="Completed"></i>',
    failed: '<i class="fas fa-exclamation-circle text-danger" aria-label="Failed"></i>',
    running: '<i class="fas fa-spinner fa-spin text-info" aria-label="Running"></i>',
    pending: '<i class="fas fa-clock text-warning" aria-label="Pending"></i>',
    cancelled:
      '<i class="fas fa-times-circle text-secondary" aria-label="Cancelled"></i>',
  };

  container.innerHTML = `<div class="job-history-list">
    ${jobs
      .map(
        (job) => `
      <div class="job-history-item">
        <div class="job-history-header">
          <span class="job-history-type">
            ${statusIcons[job.status] || ""}
            ${escapeHtml(typeLabels[job.job_type] || job.job_type || "Job")}
          </span>
          <span class="job-history-time">${job.created_at ? formatRelativeTime(job.created_at) : ""}</span>
        </div>
        ${job.message ? `<div class="job-history-message">${escapeHtml(job.message)}</div>` : ""}
      </div>`
      )
      .join("")}
  </div>`;
}

// =============================================================================
// Optimal Route
// =============================================================================

async function generateOptimalRoute(areaId) {
  const btn = document.getElementById("generate-route-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      '<i class="fas fa-spinner fa-spin me-1" aria-hidden="true"></i>Generating…';
  }

  const infoContainer = document.getElementById("route-info-container");
  if (infoContainer) {
    infoContainer.innerHTML =
      '<p class="text-secondary small">Generating optimal route… This may take a minute.</p>';
  }

  notificationManager.show("Generating optimal route…", "info");

  try {
    const result = await apiPost(`/areas/${areaId}/optimal-route`, {});
    state.optimalRouteTaskId = result.task_id;

    if (result.status === "already_running") {
      notificationManager.show("Route generation already in progress.", "info");
    }

    // Poll for completion
    pollOptimalRoute(areaId, result.task_id || result.job_id);
  } catch (error) {
    notificationManager.show(`Route generation failed: ${error.message}`, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML =
        '<i class="fas fa-magic me-1" aria-hidden="true"></i>Generate Optimal Route';
    }
    if (infoContainer) {
      infoContainer.innerHTML = "";
    }
  }
}

function pollOptimalRoute(areaId, taskId) {
  if (!taskId || !state.pageActive) {
    return;
  }

  const checkStatus = async () => {
    if (!state.pageActive || state.currentAreaId !== areaId) {
      return;
    }

    try {
      const job = await apiGet(`/jobs/${taskId}`);
      const progress =
        job.status === "completed"
          ? 100
          : typeof job.progress === "number"
            ? Math.round(job.progress)
            : 0;

      const infoContainer = document.getElementById("route-info-container");
      if (infoContainer && job.status !== "completed") {
        infoContainer.innerHTML = `
          <div class="progress mb-2" style="height: 6px;">
            <div class="progress-bar" style="width: ${progress}%"></div>
          </div>
          <p class="text-secondary small mb-0">${escapeHtml(job.message || "Processing…")}</p>`;
      }

      if (job.status === "completed") {
        // Fetch and display the route
        const routeData = await apiGet(`/areas/${areaId}/optimal-route`);
        renderOptimalRouteOnMap(routeData);

        const btn = document.getElementById("generate-route-btn");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML =
            '<i class="fas fa-sync me-1" aria-hidden="true"></i>Regenerate Route';
        }

        const toggleWrapper = document.getElementById("show-route-toggle-wrapper");
        if (toggleWrapper) {
          toggleWrapper.style.display = "";
        }

        if (infoContainer) {
          infoContainer.innerHTML =
            '<p class="text-success small"><i class="fas fa-check me-1"></i>Optimal route generated and displayed on map.</p>';
        }

        notificationManager.show("Optimal route ready!", "success");
        return;
      }

      if (job.status === "failed" || job.status === "cancelled") {
        const btn = document.getElementById("generate-route-btn");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML =
            '<i class="fas fa-magic me-1" aria-hidden="true"></i>Generate Optimal Route';
        }
        const infoEl = document.getElementById("route-info-container");
        if (infoEl) {
          infoEl.innerHTML =
            '<p class="text-danger small">Route generation failed.</p>';
        }
        notificationManager.show("Route generation failed.", "danger");
        return;
      }

      // Still running — poll again
      state.optimalRoutePollTimer = setTimeout(checkStatus, 2000);
    } catch (err) {
      console.error("Optimal route poll error:", err);
      state.optimalRoutePollTimer = setTimeout(checkStatus, 3000);
    }
  };

  // Start polling
  state.optimalRoutePollTimer = setTimeout(checkStatus, 1500);
}

function renderOptimalRouteOnMap(routeGeoJSON) {
  if (!state.map) {
    return;
  }

  if (state.map.getSource("optimal-route")) {
    state.map.getSource("optimal-route").setData(routeGeoJSON);
    return;
  }

  state.map.addSource("optimal-route", { type: "geojson", data: routeGeoJSON });
  state.map.addLayer({
    id: "optimal-route-line",
    type: "line",
    source: "optimal-route",
    paint: {
      "line-color": "#b87a4a",
      "line-width": 3,
      "line-dasharray": [3, 2],
      "line-opacity": 0.9,
    },
  });
  state.optimalRouteLayerAdded = true;
}

function toggleOptimalRouteVisibility(visible) {
  if (!state.map || !state.map.getLayer("optimal-route-line")) {
    return;
  }
  state.map.setLayoutProperty(
    "optimal-route-line",
    "visibility",
    visible ? "visible" : "none"
  );
}

// =============================================================================
// Error Panel
// =============================================================================

function showCoverageErrorDetails(areaId, areaName, { scroll = true } = {}) {
  if (!areaId) {
    return;
  }

  const panel = document.getElementById("coverage-error-panel");
  if (!panel) {
    return;
  }

  const errorMessage =
    state.areaErrorById.get(areaId) || "No error details were recorded.";

  const titleEl = document.getElementById("coverage-error-title");
  if (titleEl) {
    titleEl.textContent = "Coverage calculation error";
  }

  const areaEl = document.getElementById("coverage-error-area");
  if (areaEl) {
    areaEl.textContent = areaName ? `Area: ${areaName}` : "";
  }

  const messageEl = document.getElementById("coverage-error-message");
  if (messageEl) {
    messageEl.textContent = errorMessage;
  }

  state.activeErrorAreaId = areaId;
  panel.classList.remove("d-none", "fade-in-up");
  void panel.offsetWidth;
  panel.classList.add("fade-in-up");

  if (scroll) {
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function hideCoverageErrorDetails() {
  const panel = document.getElementById("coverage-error-panel");
  if (!panel) {
    return;
  }
  panel.classList.add("d-none");
  panel.classList.remove("fade-in-up");
  state.activeErrorAreaId = null;
}

function refreshCoverageErrorDetails(areas) {
  if (!state.activeErrorAreaId) {
    return;
  }
  const area = areas?.find((a) => a.id === state.activeErrorAreaId);
  if (!area || area.status !== "error") {
    hideCoverageErrorDetails();
  } else {
    showCoverageErrorDetails(area.id, area.display_name, { scroll: false });
  }
}

// =============================================================================
// Location Validation
// =============================================================================

function initValidationUI() {
  validationElements = {
    status: document.getElementById("location-validation-status"),
    note: document.getElementById("location-validation-note"),
    candidates: document.getElementById("location-validation-candidates"),
    confirmation: document.getElementById("location-validation-confirmation"),
    addButton: document.getElementById("add-coverage-area"),
  };
  resetValidationState();
}

function setAddButtonEnabled(enabled) {
  if (!validationElements?.addButton) {
    return;
  }
  validationElements.addButton.disabled = !enabled;
  validationElements.addButton.setAttribute("aria-disabled", String(!enabled));
}

function setValidationStatus({ icon, message, tone = "neutral" }) {
  if (!validationElements?.status) {
    return;
  }
  const toneClassMap = {
    neutral: "text-secondary",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };
  const toneClass = toneClassMap[tone] || toneClassMap.neutral;
  validationElements.status.className = `validation-status ${toneClass}`;
  validationElements.status.innerHTML = `
    <span class="status-icon"><i class="fas ${icon}" aria-hidden="true"></i></span>
    <span>${escapeHtml(message)}</span>`;
}

function clearValidationSelection() {
  validationState.resolveRequestId += 1;
  validationState.selectedCandidate = null;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);

  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }
  if (validationElements?.candidates) {
    validationElements.candidates
      .querySelectorAll(".validation-candidate")
      .forEach((el) => {
        el.classList.remove("is-selected");
      });
  }
}

function resetValidationState() {
  Object.assign(validationState, {
    status: "idle",
    lastQuery: "",
    lastType: "",
    candidates: [],
    selectedCandidate: null,
    confirmedCandidate: null,
    confirmedBoundary: null,
    note: "",
    requestId: 0,
    resolveRequestId: 0,
  });
  if (validationElements?.candidates) {
    validationElements.candidates.innerHTML = "";
  }
  if (validationElements?.note) {
    validationElements.note.textContent = "";
    validationElements.note.classList.add("d-none");
  }
  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }
  setAddButtonEnabled(false);
  setValidationStatus({
    icon: "fa-location-dot",
    message: "Enter a location to validate.",
    tone: "neutral",
  });
}

async function validateLocationInput() {
  const query = document.getElementById("location-input")?.value.trim() || "";
  const areaType = document.getElementById("location-type")?.value || "city";

  if (!query || query.length < 2) {
    return;
  }

  if (query === validationState.lastQuery && areaType === validationState.lastType) {
    return;
  }

  validationState.lastQuery = query;
  validationState.lastType = areaType;
  const requestId = ++validationState.requestId;

  try {
    const result = await apiClient.post(
      `${API_BASE}/areas/validate`,
      { location: query, area_type: areaType, limit: 5 },
      withSignal()
    );

    if (requestId !== validationState.requestId) {
      return;
    }

    validationState.candidates = prioritizeBoundaryCandidates(result.candidates || []);
    renderValidationCandidates(validationState.candidates);

    if (validationState.candidates.length === 0) {
      setValidationStatus({
        icon: "fa-triangle-exclamation",
        message: "No matches found. Try a different spelling or area type.",
        tone: "warning",
      });
    } else {
      setValidationStatus({
        icon: "fa-list",
        message: `Found ${validationState.candidates.length} match${validationState.candidates.length !== 1 ? "es" : ""}. Select one to confirm.`,
        tone: "info",
      });
    }

    const preferredCandidateIndex = getPreferredValidationCandidateIndex(
      validationState.candidates
    );
    if (preferredCandidateIndex >= 0) {
      await resolveValidationCandidateAtIndex(preferredCandidateIndex, { auto: true });
    }

    if (result.note && validationElements?.note) {
      validationElements.note.textContent = result.note;
      validationElements.note.classList.remove("d-none");
    } else if (validationElements?.note) {
      validationElements.note.textContent = "";
      validationElements.note.classList.add("d-none");
    }
  } catch (error) {
    if (requestId !== validationState.requestId) {
      return;
    }
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Validation error: ${error.message}`,
      tone: "danger",
    });
  }
}

function isNodeValidationCandidate(candidate) {
  return String(candidate?.osm_type || "")
    .trim()
    .toLowerCase() === "node";
}

function prioritizeBoundaryCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return Array.isArray(candidates) ? candidates : [];
  }

  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      isNode: isNodeValidationCandidate(candidate),
    }))
    .sort((a, b) => {
      if (a.isNode !== b.isNode) {
        return a.isNode ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map(({ candidate }) => candidate);
}

function getPreferredValidationCandidateIndex(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return -1;
  }
  return candidates.findIndex((candidate) => !isNodeValidationCandidate(candidate));
}

async function resolveValidationCandidateAtIndex(index, { auto = false } = {}) {
  const candidate = validationState.candidates[index];
  if (!candidate) {
    return;
  }

  validationState.selectedCandidate = candidate;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);
  if (validationElements?.confirmation) {
    validationElements.confirmation.classList.add("d-none");
    validationElements.confirmation.textContent = "";
  }

  // Mark selected
  validationElements?.candidates
    ?.querySelectorAll(".validation-candidate")
    .forEach((el, i) => {
      el.classList.toggle("is-selected", i === index);
      el.setAttribute("aria-selected", i === index ? "true" : "false");
    });

  setValidationStatus({
    icon: "fa-spinner fa-spin",
    message: auto ? "Resolving boundary for best match…" : "Resolving boundary…",
    tone: "info",
  });

  const resolveId = ++validationState.resolveRequestId;

  try {
    const result = await apiClient.post(
      `${API_BASE}/areas/resolve`,
      { osm_id: candidate.osm_id, osm_type: candidate.osm_type },
      withSignal()
    );

    if (resolveId !== validationState.resolveRequestId) {
      return;
    }

    const resolvedCandidate =
      result && typeof result === "object" && result.candidate
        ? result.candidate
        : result;
    const resolvedBoundary =
      resolvedCandidate && typeof resolvedCandidate === "object"
        ? resolvedCandidate.boundary
        : null;

    if (!resolvedBoundary) {
      throw new Error("Resolved location did not include a boundary.");
    }

    validationState.confirmedCandidate = resolvedCandidate;
    validationState.confirmedBoundary = resolvedBoundary;

    setValidationStatus({
      icon: "fa-check-circle",
      message: `Confirmed: ${escapeHtml(
        resolvedCandidate.display_name || candidate.display_name
      )}`,
      tone: "success",
    });

    if (validationElements?.confirmation) {
      validationElements.confirmation.textContent = `Ready to add: ${
        resolvedCandidate.display_name || candidate.display_name
      }`;
      validationElements.confirmation.classList.remove("d-none");
    }

    setAddButtonEnabled(true);
  } catch (error) {
    if (resolveId !== validationState.resolveRequestId) {
      return;
    }
    setValidationStatus({
      icon: "fa-exclamation-circle",
      message: `Failed to resolve boundary: ${error.message}`,
      tone: "danger",
    });
  }
}

function renderValidationCandidates(candidates) {
  if (!validationElements?.candidates) {
    return;
  }
  if (!candidates.length) {
    validationElements.candidates.innerHTML = "";
    return;
  }

  validationElements.candidates.innerHTML = candidates
    .map((c, idx) => {
      const typeMatch = c.type_match
        ? ""
        : '<span class="validation-badge badge-mismatch">Type mismatch</span>';
      const pointOnly = isNodeValidationCandidate(c)
        ? '<span class="validation-badge badge-node">Point only</span>'
        : "";
      const typeBadge = `<span class="validation-badge">${escapeHtml(c.osm_type || "")}</span>`;
      return `
        <button type="button"
                class="validation-candidate"
                data-candidate-index="${idx}"
                role="option"
                aria-selected="false">
          <div>
            <div class="candidate-title">${escapeHtml(c.display_name || "")}</div>
            <div class="candidate-meta">${typeBadge}${pointOnly}${typeMatch}</div>
          </div>
          <i class="fas fa-chevron-right text-secondary" aria-hidden="true"></i>
        </button>`;
    })
    .join("");
}

async function handleCandidateClick(event) {
  const btn = event.target.closest("[data-candidate-index]");
  if (!btn) {
    return;
  }

  const idx = parseInt(btn.dataset.candidateIndex, 10);
  if (Number.isNaN(idx)) {
    return;
  }
  await resolveValidationCandidateAtIndex(idx);
}

// =============================================================================
// Format Utilities
// =============================================================================

function formatStatus(statusKey) {
  const labels = { driven: "Driven", undriven: "Undriven", undriveable: "Undriveable" };
  return labels[statusKey] || "Unknown";
}

function formatHighwayType(type) {
  if (!type) {
    return "Unknown";
  }
  return String(type)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStreetDisplayName(streetName, segmentId = "") {
  const normalizedName = typeof streetName === "string" ? streetName.trim() : "";
  if (normalizedName) {
    return normalizedName;
  }
  const normalizedSegmentId = typeof segmentId === "string" ? segmentId.trim() : "";
  if (normalizedSegmentId) {
    return `Unnamed Street (${normalizedSegmentId})`;
  }
  return "Unnamed Street";
}

function formatPopupDate(value, statusKey) {
  if (!value) {
    if (statusKey === "driven") {
      return "Unknown";
    }
    if (statusKey === "undriveable") {
      return "N/A";
    }
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
