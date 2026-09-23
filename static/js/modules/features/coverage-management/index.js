/**
 * Coverage page controller. Two views share the page: "list", the grid of
 * coverage areas, and "area", a full-height street map with a sidebar.
 * This module wires events, switches views, and runs area jobs (add,
 * rebuild, recalculate, batch). The street map and panel live in
 * street-map.js, sidebar figures in area-dashboard.js, the History tab in
 * job-history.js, coverage filters in service-roads.js, the Add Area
 * lookup in validation.js, and shared state in context.js.
 */

import apiClient from "../../core/api-client.js";
import { navigate } from "../../core/navigation.js";
import {
  getExplorationSelection,
  setExplorationSelection,
} from "../../core/exploration-map.js";
import { updateRegion } from "../../core/partial-update.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import GlobalJobTracker from "../../ui/global-job-tracker.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml } from "../../utils.js";
import { DEFAULT_AREA_SORT, renderAreaCards, sortCoverageAreas } from "./areas.js";
import { shortAreaName, splitAreaName } from "./area-name.js";
import {
  formatDate,
  formatMiles,
  formatNumber,
  formatPercent,
  plural,
} from "../coverage-journal/format.js";
import { formatRelativeTime, normalizeCoveragePercent } from "./stats.js";
import {
  COVERAGE_TRIP_MODE_SELECT_IDS,
  INCLUDE_SERVICE_TOGGLE_IDS,
  apiDelete,
  apiGet,
  apiPost,
  bindCoveragePage,
  getCoverageTripModeEndpointParam,
  getCoverageTripModeLabel,
  resetCoverageState,
  state,
  withSignal,
} from "./context.js";
import { refreshDashboardStats, updateStatsUI } from "./area-dashboard.js";
import {
  applyMapFilter,
  applyStreetDecision,
  closeStreetDetailPanel,
  initOrUpdateMap,
  inkStreetLayers,
  loadStreets,
  markSegmentDriven,
  markSegmentUndriveable,
  markSegmentUndriven,
} from "./street-map.js";
import { loadDrivingActivity, loadJobHistory } from "./job-history.js";
import {
  describeIncludeServiceRoadsScope,
  getCoverageTripModeSelection,
  getIncludeServiceRoadsSelection,
  handleCoverageTripModeChange,
  handleIncludeServiceRoadsToggle,
  loadCoverageFilterSettings,
  setIncludeServiceRoadsStatus,
  shouldRebuildForServiceFilter,
} from "./service-roads.js";
import {
  VALIDATION_DEBOUNCE_MS,
  clearValidationSelection,
  handleCandidateClick,
  initValidationUI,
  renderValidationCandidates,
  resetValidationState,
  setValidationStatus,
  validateLocationInput,
  validationElements,
  validationState,
} from "./validation.js";

const ACTIVE_JOB_REFRESH_MS = 5000;
const OPTIMAL_ROUTE_JOB_TYPE = "optimal_route";
const COVERAGE_JOB_TYPES = new Set(["area_ingestion", "area_rebuild", "area_backfill"]);

// =============================================================================
// Initialization
// =============================================================================

export default async function initCoverageManagementPage({
  signal,
  cleanup,
  api,
} = {}) {
  bindCoveragePage({ signal, api });
  state.pageActive = true;
  const ownedState = state;
  const teardown = () => {
    ownedState.viewportAbort?.abort();
    ownedState.pageActive = false;
    ownedState.pageSignal = null;
    clearTimeout(ownedState.activeJobsRefreshTimeoutId);
    ownedState.map?.remove();
    ownedState.hoverPopup?.remove();
    resetCoverageState(ownedState);
  };
  cleanup?.(teardown);

  const modalsContainer = document.getElementById("modals-container");
  ["addAreaModal", "batchRecalculateModal"].forEach((modalId) => {
    const modal = document.getElementById(modalId);
    if (modal && modalsContainer && !modalsContainer.contains(modal)) {
      modalsContainer.appendChild(modal);
    }
  });

  setupEventListeners(signal);
  setupSidebarTabs(signal);
  setupStreetMarkingListeners(signal);
  setupKeyboardShortcuts(signal);
  initValidationUI();
  await loadCoverageFilterSettings();
  if (signal?.aborted) return;

  // Load initial area list
  await loadAreas();
  if (signal?.aborted) return;
  const requestedArea =
    new URLSearchParams(window.location.search).get("area") ||
    getExplorationSelection().areaId;
  if (requestedArea && state.areaList.some((area) => area.id === requestedArea))
    await viewArea(requestedArea);

  // Resume any background jobs (GlobalJobTracker handles localStorage persistence)
  // No-op here — GlobalJobTracker auto-resumes.

  return teardown;
}

// =============================================================================
// Event Listeners
// =============================================================================

function setupEventListeners(signal) {
  const opt = signal ? { signal } : false;
  document.addEventListener("themeChanged", inkStreetLayers, opt);
  document.addEventListener(
    "historicalTripsUpdated",
    async () => {
      await loadAreas();
      const areaId = state.currentAreaId;
      if (areaId && !signal?.aborted) {
        await refreshDashboardStats(areaId);
        await loadStreets(areaId, state.currentAreaSyncToken);
      }
    },
    opt
  );

  // List view controls
  document
    .getElementById("refresh-list-btn")
    ?.addEventListener("click", loadAreas, opt);

  document.getElementById("coverage-area-sort")?.addEventListener(
    "change",
    (event) => {
      state.areaSort = event.currentTarget.value || DEFAULT_AREA_SORT;
      state.areaList = sortCoverageAreas(state.areaList, state.areaSort);
      renderAreaCards({
        areas: state.areaList,
        activeJobsByAreaId: state.activeJobsByAreaId,
        activeRouteJobsByAreaId: state.activeRouteJobsByAreaId,
        areaErrorById: state.areaErrorById,
        areaNameById: state.areaNameById,
      });
    },
    opt
  );

  document
    .getElementById("batch-recalculate-open-btn")
    ?.addEventListener("click", openBatchRecalculateModal, opt);

  document
    .getElementById("batch-select-ready-btn")
    ?.addEventListener("click", selectAllBatchEligibleAreas, opt);

  document
    .getElementById("batch-clear-selection-btn")
    ?.addEventListener("click", clearBatchSelection, opt);

  document
    .getElementById("batch-recalculate-area-list")
    ?.addEventListener("change", updateBatchRecalculateSelectionState, opt);

  document
    .getElementById("batch-recalculate-start-btn")
    ?.addEventListener("click", queueBatchRecalculate, opt);

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
  COVERAGE_TRIP_MODE_SELECT_IDS.forEach((id) => {
    document
      .getElementById(id)
      ?.addEventListener("change", handleCoverageTripModeChange, opt);
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

  // Share coverage card button
  document
    .getElementById("share-coverage-btn")
    ?.addEventListener("click", handleShareClick, opt);

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

        // Lazy-load history (driving activity + background jobs)
        if (targetId === "sidebar-tab-history" && state.currentAreaId) {
          loadDrivingActivity(state.currentAreaId);
          loadJobHistory(state.currentAreaId);
        }
      },
      opt
    );
  });
}

function setupStreetMarkingListeners(signal) {
  document.getElementById("street-restore-automatic-btn")?.addEventListener(
    "click",
    () => {
      if (state.selectedSegment)
        void applyStreetDecision(
          state.currentAreaId,
          state.selectedSegment.segmentId,
          "automatic"
        );
    },
    signal ? { signal } : {}
  );
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
      // A native dialog owns keyboard interaction while the page is inert.
      if (document.querySelector("dialog[open]")) return;
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

function isCoverageJobType(jobType) {
  return COVERAGE_JOB_TYPES.has(
    String(jobType || "")
      .trim()
      .toLowerCase()
  );
}

function isRouteJobType(jobType) {
  return (
    String(jobType || "")
      .trim()
      .toLowerCase() === OPTIMAL_ROUTE_JOB_TYPE
  );
}

function getActiveCoverageJob(areaId) {
  return state.activeJobsByAreaId.get(areaId) || null;
}

function getActiveRouteJob(areaId) {
  return state.activeRouteJobsByAreaId.get(areaId) || null;
}

function clearActiveJobsRefresh() {
  if (state.activeJobsRefreshTimeoutId) {
    clearTimeout(state.activeJobsRefreshTimeoutId);
    state.activeJobsRefreshTimeoutId = null;
  }
}

function scheduleActiveJobsRefresh(hasActiveJobs) {
  clearActiveJobsRefresh();
  if (!hasActiveJobs || !state.pageActive) {
    return;
  }

  state.activeJobsRefreshTimeoutId = window.setTimeout(() => {
    state.activeJobsRefreshTimeoutId = null;
    if (!state.pageActive) {
      return;
    }
    loadAreas();
  }, ACTIVE_JOB_REFRESH_MS);
}

function getCoverageJobLabel(jobType) {
  switch (
    String(jobType || "")
      .trim()
      .toLowerCase()
  ) {
    case "area_ingestion":
      return "setup";
    case "area_rebuild":
      return "rebuild";
    case "area_backfill":
      return "coverage recalculation";
    default:
      return "job";
  }
}

async function cancelCoverageJob(areaId, displayName) {
  const job = getActiveCoverageJob(areaId);
  if (!job?.job_id) {
    notificationManager.show("No active coverage job found for this area.", "warning");
    await loadAreas();
    return;
  }

  const jobLabel = getCoverageJobLabel(job.job_type);
  const confirmed = await confirmationDialog.show({
    title: "Stop Background Job",
    message: `Stop the active ${escapeHtml(jobLabel)} for "<strong>${escapeHtml(displayName)}</strong>"?<br><br>The current background work will be cancelled. You can start it again from this card afterward.`,
    allowHtml: true,
    confirmText: "Stop Job",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiDelete(`/jobs/${job.job_id}`);
    notificationManager.show(`Stopped the active ${jobLabel}.`, "info");
    await loadAreas();
  } catch (error) {
    console.error("Failed to cancel coverage job:", error);
    notificationManager.show(
      `Failed to stop background job: ${error.message}`,
      "danger"
    );
  }
}

async function cancelRouteJob(areaId, displayName) {
  const job = getActiveRouteJob(areaId);
  if (!job) {
    notificationManager.show(
      "No active optimal route generation was found for this area.",
      "warning"
    );
    await loadAreas();
    return;
  }

  const confirmed = await confirmationDialog.show({
    title: "Stop Optimal Route Generation",
    message: `Stop optimal route generation for "<strong>${escapeHtml(displayName)}</strong>"?<br><br>You can restart it from this card after cancellation completes.`,
    allowHtml: true,
    confirmText: "Stop Route",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  try {
    if (job.task_id) {
      await apiClient.delete(`/api/optimal-routes/${job.task_id}`, withSignal());
    } else if (job.job_id) {
      await apiDelete(`/jobs/${job.job_id}`);
    } else {
      throw new Error("Route job identifier is missing.");
    }
    notificationManager.show("Optimal route generation stopped.", "info");
    await loadAreas();
  } catch (error) {
    console.error("Failed to cancel route job:", error);
    notificationManager.show(
      `Failed to stop route generation: ${error.message}`,
      "danger"
    );
  }
}

async function generateOptimalRoute(areaId, displayName, { restart = false } = {}) {
  const activeRouteJob = getActiveRouteJob(areaId);
  const title = restart ? "Regenerate Optimal Route" : "Generate Optimal Route";
  const message = restart
    ? `Build a fresh optimal route for "<strong>${escapeHtml(displayName)}</strong>"?<br><br>This will replace the current route${activeRouteJob ? " and restart the in-progress generation" : ""}.`
    : `Generate an optimal route for "<strong>${escapeHtml(displayName)}</strong>"?<br><br>This runs in the background and will appear on this card as progress updates arrive.`;

  const confirmed = await confirmationDialog.show({
    title,
    message,
    allowHtml: true,
    confirmText: restart ? "Regenerate" : "Generate",
    confirmButtonClass: restart ? "btn-warning" : "btn-primary",
  });

  if (!confirmed) {
    return;
  }

  try {
    if (restart && activeRouteJob) {
      if (activeRouteJob.task_id) {
        await apiClient.delete(
          `/api/optimal-routes/${activeRouteJob.task_id}`,
          withSignal()
        );
      } else if (activeRouteJob.job_id) {
        await apiDelete(`/jobs/${activeRouteJob.job_id}`);
      }
    }

    const result = await apiPost(`/areas/${areaId}/optimal-route`, {});
    const messageText =
      result.status === "already_running"
        ? "Optimal route generation is already running for this area."
        : restart
          ? "Optimal route regeneration started."
          : "Optimal route generation started.";
    notificationManager.show(messageText, "info");
    await loadAreas();
  } catch (error) {
    console.error("Failed to start optimal route generation:", error);
    notificationManager.show(
      `Failed to ${restart ? "regenerate" : "generate"} optimal route: ${error.message}`,
      "danger"
    );
  }
}

// =============================================================================
// Batch Recalculation
// =============================================================================

function isAreaBatchEligible(area) {
  return area?.status === "ready" && !getActiveCoverageJob(area.id);
}

function getBatchEligibleAreas() {
  return state.areaList.filter(isAreaBatchEligible);
}

function updateBatchOpenButtonState() {
  const btn = document.getElementById("batch-recalculate-open-btn");
  if (!btn) {
    return;
  }

  const eligibleCount = getBatchEligibleAreas().length;
  btn.disabled = eligibleCount < 2;
  btn.setAttribute("aria-disabled", eligibleCount < 2 ? "true" : "false");
  btn.title =
    eligibleCount < 2 ? "At least two ready areas are needed" : "Batch recalculate";
}

function getSelectedBatchAreaIds() {
  return Array.from(document.querySelectorAll(".batch-area-check:checked")).map(
    (input) => input.value
  );
}

function getBatchAreaStatusLabel(area) {
  const activeJob = getActiveCoverageJob(area.id);
  if (activeJob) {
    return "Queued";
  }
  if (area.status !== "ready") {
    return area.status || "Unavailable";
  }
  const includeServiceRoads = getIncludeServiceRoadsSelection();
  return shouldRebuildForServiceFilter(area.id, includeServiceRoads)
    ? "Rebuild streets"
    : "Rematch trips";
}

function renderBatchRecalculateModal() {
  const list = document.getElementById("batch-recalculate-area-list");
  if (!list) {
    return;
  }

  const areas = state.areaList || [];
  if (areas.length === 0) {
    list.innerHTML = `
      <div class="batch-empty-state">
        <i class="fas fa-map-marked-alt" aria-hidden="true"></i>
        <span>No coverage areas yet.</span>
      </div>`;
    updateBatchRecalculateSelectionState();
    return;
  }

  list.innerHTML = areas
    .map((area) => {
      const eligible = isAreaBatchEligible(area);
      const pct = normalizeCoveragePercent(area.coverage_percentage);
      const areaName = escapeHtml(shortAreaName(area.display_name));
      const statusLabel = escapeHtml(getBatchAreaStatusLabel(area));
      const lastSynced = area.last_synced
        ? formatRelativeTime(area.last_synced)
        : "Never synced";
      return `
        <label class="batch-area-row${eligible ? "" : " is-disabled"}" role="listitem">
          <input type="checkbox"
                 class="form-check-input batch-area-check"
                 value="${area.id}"
                 ${eligible ? "" : "disabled"}
                 aria-label="Select ${areaName}" />
          <span class="batch-area-copy">
            <span class="batch-area-name">${areaName}</span>
            <span class="batch-area-meta">
              ${escapeHtml(formatPercent(pct, { complete: area.is_complete }))} driven · updated ${escapeHtml(lastSynced.toLowerCase())}
            </span>
          </span>
          <span class="batch-area-status">${statusLabel}</span>
        </label>`;
    })
    .join("");

  updateBatchRecalculateSelectionState();
}

function openBatchRecalculateModal() {
  renderBatchRecalculateModal();
  const modal = document.getElementById("batchRecalculateModal");
  if (!modal) {
    return;
  }
  bootstrap.Modal.getOrCreateInstance(modal).show();
}

function selectAllBatchEligibleAreas() {
  document.querySelectorAll(".batch-area-check:not(:disabled)").forEach((input) => {
    input.checked = true;
  });
  updateBatchRecalculateSelectionState();
}

function clearBatchSelection() {
  document.querySelectorAll(".batch-area-check").forEach((input) => {
    input.checked = false;
  });
  updateBatchRecalculateSelectionState();
}

function updateBatchRecalculateSelectionState() {
  const selectedIds = getSelectedBatchAreaIds();
  const eligibleCount = getBatchEligibleAreas().length;
  const summary = document.getElementById("batch-recalculate-summary");
  const startBtn = document.getElementById("batch-recalculate-start-btn");

  if (summary) {
    summary.textContent =
      selectedIds.length > 0
        ? `${selectedIds.length} selected · ${eligibleCount} ready`
        : `${eligibleCount} ready`;
  }
  if (startBtn) {
    startBtn.disabled = selectedIds.length < 2;
  }
}

async function queueBatchRecalculate() {
  const selectedIds = getSelectedBatchAreaIds();
  if (selectedIds.length < 2) {
    notificationManager.show("Select at least two ready areas.", "warning");
    return;
  }

  const startBtn = document.getElementById("batch-recalculate-start-btn");
  const previousHtml = startBtn?.innerHTML;
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin me-1" aria-hidden="true"></i>Queueing';
  }

  try {
    const result = await apiPost("/areas/batch/recalculate", {
      area_ids: selectedIds,
      trip_mode: getCoverageTripModeSelection(),
      rebuild_policy: "auto",
    });

    const modal = document.getElementById("batchRecalculateModal");
    modal?.querySelector(":focus")?.blur();
    bootstrap.Modal.getInstance(modal)?.hide();
    notificationManager.show(
      result.message || "Coverage recalculation batch queued.",
      "info"
    );
    await loadAreas();
  } catch (error) {
    console.error("Failed to queue coverage batch:", error);
    notificationManager.show(
      `Failed to queue coverage batch: ${error.message}`,
      "danger"
    );
  } finally {
    if (startBtn) {
      startBtn.innerHTML = previousHtml;
      updateBatchRecalculateSelectionState();
    }
  }
}

// =============================================================================
// Area List
// =============================================================================

async function loadAreas() {
  clearActiveJobsRefresh();

  try {
    // Fetch areas and active jobs in parallel
    const [areasData, jobsData] = await Promise.all([
      apiGet("/areas"),
      apiGet("/jobs").catch(() => ({ jobs: [] })),
    ]);

    // Build active jobs map
    state.activeJobsByAreaId = new Map();
    state.activeRouteJobsByAreaId = new Map();
    (jobsData?.jobs || []).forEach((job) => {
      if (!job.area_id) {
        return;
      }

      if (isRouteJobType(job.job_type)) {
        if (job.route_kind !== "full_area") return;
        if (!state.activeRouteJobsByAreaId.has(job.area_id)) {
          state.activeRouteJobsByAreaId.set(job.area_id, job);
        }
        return;
      }

      if (
        isCoverageJobType(job.job_type) &&
        !state.activeJobsByAreaId.has(job.area_id)
      ) {
        state.activeJobsByAreaId.set(job.area_id, job);
      }
    });

    const hasActiveJobs =
      state.activeJobsByAreaId.size > 0 || state.activeRouteJobsByAreaId.size > 0;
    state.areaList = sortCoverageAreas(areasData.areas, state.areaSort);
    state.areaRoadFilterVersionById.clear();
    state.areaList.forEach((area) => {
      state.areaRoadFilterVersionById.set(area.id, area.road_filter_version || null);
    });

    const { hasAreas } = updateRegion(document.getElementById("area-cards-grid"), () =>
      renderAreaCards({
        areas: state.areaList,
        activeJobsByAreaId: state.activeJobsByAreaId,
        activeRouteJobsByAreaId: state.activeRouteJobsByAreaId,
        areaErrorById: state.areaErrorById,
        areaNameById: state.areaNameById,
      })
    );

    scheduleActiveJobsRefresh(hasActiveJobs);

    if (hasAreas) {
      refreshCoverageErrorDetails(areasData.areas);
    } else {
      hideCoverageErrorDetails();
    }

    renderCoverageSummary(state.areaList);
    updateBatchOpenButtonState();
  } catch (error) {
    console.error("Failed to load areas:", error);
    notificationManager.show(
      `Failed to load coverage areas: ${error.message}`,
      "danger"
    );
    scheduleActiveJobsRefresh(
      state.activeJobsByAreaId.size > 0 || state.activeRouteJobsByAreaId.size > 0
    );
    updateBatchOpenButtonState();
  }
}

/** Totals across every area, above the cards. */
function renderCoverageSummary(areas) {
  const band = document.getElementById("coverage-figures");
  if (!band) {
    return;
  }
  const ready = areas.filter((area) => area.status === "ready");
  band.hidden = ready.length === 0;
  if (!ready.length) {
    return;
  }
  const sum = (key) =>
    ready.reduce((total, area) => total + Number(area[key] || 0), 0);
  const complete = ready.filter((area) => area.is_complete).length;
  const latest = ready
    .filter((area) => area.last_coverage_trip_at)
    .sort((a, b) => Date.parse(b.last_coverage_trip_at) - Date.parse(a.last_coverage_trip_at))[0];
  const set = (id, text) => {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = text;
    }
  };
  set("coverage-sum-areas", formatNumber(areas.length));
  set(
    "coverage-sum-complete",
    complete ? `${plural(complete, "area")} fully driven` : "None fully driven yet"
  );
  set("coverage-sum-driven", formatNumber(sum("driven_length_miles"), 1));
  set("coverage-sum-total", `of ${formatMiles(sum("driveable_length_miles"), 1)}`);
  set("coverage-sum-left", formatNumber(sum("remaining_length_miles"), 1));
  set(
    "coverage-sum-last",
    latest ? formatDate(latest.last_coverage_trip_at, "short") : "—"
  );
  set("coverage-sum-last-area", latest ? splitAreaName(latest.display_name).name : "");
}

function handleAreaCardClick(event) {
  // Area actions from card + explicit error details trigger
  const btn = event.target.closest("[data-area-action], [data-error-action]");
  if (!btn) {
    // Clicked on the card body itself (not an action button).
    // If this area has a minimized progress modal, restore it.
    const card = event.target.closest(".area-card");
    const cardAreaId = card?.dataset?.areaId;
    if (
      cardAreaId &&
      GlobalJobTracker.isMinimized &&
      GlobalJobTracker.activeAreaId === cardAreaId
    ) {
      GlobalJobTracker.restore();
    }
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
    case "journal":
      void navigate(`/coverage-management/${encodeURIComponent(areaId)}/journal`);
      break;
    case "view":
      viewArea(areaId);
      break;
    case "generate-route":
      generateOptimalRoute(areaId, areaName);
      break;
    case "restart-route":
      generateOptimalRoute(areaId, areaName, { restart: true });
      break;
    case "cancel-route":
      cancelRouteJob(areaId, areaName);
      break;
    case "cancel-job":
      cancelCoverageJob(areaId, areaName);
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
  const tripMode = getCoverageTripModeSelection();

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
      trip_mode: tripMode,
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
  const tripMode = getCoverageTripModeSelection();
  const tripModeLabel = getCoverageTripModeLabel(tripMode);
  const confirmed = await confirmationDialog.show({
    title: "Rebuild streets",
    message: `Rebuild the streets of "<strong>${escapeHtml(displayName)}</strong>" from the local OpenStreetMap extract, then match your trips again using <strong>${escapeHtml(tripModeLabel)}</strong>?<br><br>This runs in the background and takes a few minutes. Your manual corrections are kept.`,
    allowHtml: true,
    confirmText: "Rebuild",
    confirmButtonClass: "btn-warning",
  });

  if (!confirmed) {
    return;
  }

  try {
    const result = await apiPost(
      `/areas/${areaId}/rebuild?trip_mode=${getCoverageTripModeEndpointParam(tripMode)}`,
      {}
    );
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
  const tripMode = getCoverageTripModeSelection();
  const tripModeLabel = getCoverageTripModeLabel(tripMode);
  const needsRebuild = shouldRebuildForServiceFilter(areaId, includeServiceRoads);
  const policyLabel = includeServiceRoads ? "include" : "exclude";

  const confirmed = await confirmationDialog.show({
    title: "Recalculate coverage",
    message: needsRebuild
      ? `Service roads are now <strong>${policyLabel === "include" ? "included" : "excluded"}</strong>, so the streets of "<strong>${escapeHtml(displayName)}</strong>" are rebuilt first. Then your trips are matched again using <strong>${escapeHtml(tripModeLabel)}</strong>.<br><br>This runs in the background. Your manual corrections are kept.`
      : `Match every trip in "<strong>${escapeHtml(displayName)}</strong>" to its streets again using <strong>${escapeHtml(tripModeLabel)}</strong>?<br><br>This runs in the background. Your manual corrections are kept.`,
    allowHtml: true,
    confirmText: needsRebuild ? "Rebuild and recalculate" : "Recalculate",
    confirmButtonClass: needsRebuild ? "btn-warning" : "btn-info",
  });

  if (!confirmed) {
    return;
  }

  try {
    if (needsRebuild) {
      const result = await apiPost(
        `/areas/${areaId}/rebuild?trip_mode=${getCoverageTripModeEndpointParam(tripMode)}`,
        {}
      );
      await loadAreas();
      if (result.job_id) {
        GlobalJobTracker.start({
          jobId: result.job_id,
          jobType: "area_rebuild",
          areaId,
          areaName: displayName,
          initialMessage:
            result.message || "Rebuilding area and recalculating street coverage...",
        });
      }
      notificationManager.show(
        result.message || "Rebuild started in the background.",
        "info"
      );
      return;
    }

    notificationManager.show(
      "Recalculating street coverage in the background...",
      "info"
    );
    const result = await apiPost(
      `/areas/${areaId}/backfill?background=true&trip_mode=${getCoverageTripModeEndpointParam(tripMode)}`,
      {}
    );
    await loadAreas();
    if (result.job_id) {
      GlobalJobTracker.start({
        jobId: result.job_id,
        jobType: "area_backfill",
        areaId,
        areaName: displayName,
        initialMessage:
          result.message || "Recalculating street coverage in the background...",
      });
    }
    notificationManager.show(
      result.message || "Street coverage recalculation queued.",
      "info"
    );
  } catch (error) {
    console.error("Failed to recalculate street coverage:", error);
    notificationManager.show(
      `Failed to recalculate street coverage: ${error.message}`,
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
  const previousSelection = getExplorationSelection();
  setExplorationSelection(
    areaId,
    previousSelection.areaId === areaId ? previousSelection.routeId : null
  );
  closeStreetDetailPanel();

  // Transition to area view immediately
  await switchView("area");

  try {
    const data = await apiGet(`/areas/${areaId}`, { cache: false });

    if (requestId !== state.areaViewRequestId || state.currentAreaId !== areaId) {
      return;
    }

    const { area } = data;
    if (!area) {
      throw new Error("Area details are unavailable.");
    }
    state.currentAreaSyncToken = `${area.area_version}:${area.coverage_revision}`;
    state.currentAreaRoadFilterVersion = area?.road_filter_version || null;
    state.currentAreaData = area;

    if (area?.id) {
      state.areaRoadFilterVersionById.set(area.id, state.currentAreaRoadFilterVersion);
    }

    // Refresh the service-roads scope message now that we know which area is open.
    const includeServiceRoads = getIncludeServiceRoadsSelection();
    const scope = describeIncludeServiceRoadsScope(includeServiceRoads);
    setIncludeServiceRoadsStatus(scope.message, scope.tone);

    // Update sidebar header
    const { name, region } = splitAreaName(area.display_name);
    const sidebarNameEl = document.getElementById("sidebar-area-name");
    if (sidebarNameEl) {
      sidebarNameEl.textContent = name;
      sidebarNameEl.title = area.display_name;
    }
    const sidebarTypeEl = document.getElementById("sidebar-area-type");
    if (sidebarTypeEl) {
      sidebarTypeEl.textContent = region;
    }
    for (const id of ["coverage-journal-link", "coverage-journal-summary-link"]) {
      const journalLink = document.getElementById(id);
      if (journalLink) {
        journalLink.href = `/coverage-management/${encodeURIComponent(areaId)}/journal`;
        journalLink.setAttribute("aria-label", `Open the coverage journal for ${name}`);
      }
    }

    // Update stats UI
    updateStatsUI(area);

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

// =============================================================================
// Share
// =============================================================================

async function handleShareClick() {
  if (!state.currentAreaData || state.currentAreaData.id !== state.currentAreaId) {
    return;
  }

  try {
    const area = state.currentAreaData;
    const signal = state.pageSignal;
    const { openCoverageShare } = await import("../coverage-share/index.js");
    if (
      signal?.aborted ||
      state.currentAreaData !== area ||
      state.currentAreaId !== area.id
    )
      return;
    openCoverageShare({ area, signal });
  } catch (error) {
    console.error("Failed to open share preview:", error);
    notificationManager.show(
      "Could not open the share preview. Please try again.",
      "danger"
    );
  }
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
