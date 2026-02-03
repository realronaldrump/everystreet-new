/* global mapboxgl */

import apiClient from "../../core/api-client.js";
import { CONFIG } from "../../core/config.js";
import mapBase from "../../map-base.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { DateUtils } from "../../utils.js";
import { clearInlineStatus, setInlineStatus } from "../settings/status-utils.js";

const { mapboxgl } = globalThis;
const { flatpickr } = globalThis;

let elements = {};

// Phase state machine
const PHASES = {
  SELECT: "select",
  PROCESS: "process",
  RESULTS: "results",
};

let _currentPhase = PHASES.SELECT;

function cacheElements() {
  elements = {
    form: document.getElementById("map-matching-form"),
    modeSelect: document.getElementById("map-match-mode"),
    selectionCards: document.getElementById("map-match-selection-cards"),
    dateModeSelect: document.getElementById("map-match-date-mode"),
    dateControls: document.getElementById("map-match-date-controls"),
    dateRange: document.getElementById("map-match-date-range"),
    interval: document.getElementById("map-match-interval"),
    startInput: document.getElementById("map-match-start"),
    endInput: document.getElementById("map-match-end"),
    intervalSelect: document.getElementById("map-match-interval-select"),
    unmatchedOnly: document.getElementById("map-match-unmatched-only"),
    tripControls: document.getElementById("map-match-trip-controls"),
    tripIdInput: document.getElementById("map-match-trip-id"),
    previewBtn: document.getElementById("map-match-preview-btn"),
    previewStatus: document.getElementById("map-match-preview-status"),
    previewPanel: document.getElementById("map-match-preview-panel"),
    previewSummary: document.getElementById("map-match-preview-summary"),
    previewBody: document.getElementById("map-match-preview-body"),
    previewMapBtn: document.getElementById("map-match-preview-map-btn"),
    previewMapStatus: document.getElementById("map-match-preview-map-status"),
    previewMapSummary: document.getElementById("map-match-preview-map-summary"),
    previewMapBody: document.getElementById("map-match-preview-map-body"),
    previewMapEmpty: document.getElementById("map-match-preview-map-empty"),
    previewMap: document.getElementById("map-match-preview-map"),
    submitStatus: document.getElementById("map-match-submit-status"),
    submitBtn: document.getElementById("map-match-submit"),
    refreshBtn: document.getElementById("map-match-refresh"),
    historyClearBtn: document.getElementById("map-match-history-clear"),
    historyStatus: document.getElementById("map-match-history-status"),
    historyToggle: document.getElementById("map-match-history-toggle"),
    historyBody: document.getElementById("map-match-history-body"),
    historyCount: document.getElementById("map-match-history-count"),
    jobsList: document.getElementById("map-match-jobs-list"),
    jobsBody: document.getElementById("map-match-jobs-body"),
    currentEmpty: document.getElementById("map-match-current-empty"),
    currentPanel: document.getElementById("map-match-current-panel"),
    progressBar: document.getElementById("map-match-progress-bar"),
    progressRing: document.getElementById("map-match-progress-ring"),
    progressPercent: document.getElementById("map-match-progress-percent"),
    progressMessage: document.getElementById("map-match-progress-message"),
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
    wizardShell: document.getElementById("mm-wizard-shell"),
    phaseIndicator: document.querySelector(".mm-phase-indicator"),
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
    tabMatchedCount: document.getElementById("mm-tab-matched-count"),
    tabFailedCount: document.getElementById("mm-tab-failed-count"),
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
  };
}

let currentJobId = null;
let _currentJobStage = null;
let pollTimer = null;
let previewSignature = null;
let previewPayload = null;
let matchedPreviewMap = null;
let matchedPreviewMapReady = false;
let matchedPreviewPendingGeojson = null;
let matchedPreviewFeaturesById = new Map();
let matchedPreviewSelectedId = null;
let lastAutoPreviewJobId = null;
let jobsPollTimer = null;
let matchedSelection = new Set();
let selectedQuickPick = null;
let pageSignal = null;
let failedTripsData = [];
let failedSelection = new Set();

// Result modes for the results phase
const RESULT_MODES = {
  JOB: "job", // Showing results from a specific job
  BROWSE_MATCHED: "browse_matched", // Browsing all matched trips
  BROWSE_FAILED: "browse_failed", // Browsing failed trips
};

let _currentResultMode = RESULT_MODES.JOB;

const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;
const apiGet = (url, options = {}) => apiClient.get(url, withSignal(options));
const apiPost = (url, body, options = {}) =>
  apiClient.post(url, body, withSignal(options));
const apiDelete = (url, options = {}) => apiClient.delete(url, withSignal(options));

const LAST_JOB_STORAGE_KEY = "map_matching:last_job_id";
const TERMINAL_STAGES = new Set(["completed", "failed", "error", "cancelled"]);
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * 42; // r=42

// Friendly messages for different stages
const FRIENDLY_MESSAGES = {
  queued: "Getting ready...",
  processing: "Improving your routes...",
  completed: "All done!",
  failed: "Something went wrong",
  error: "Something went wrong",
  cancelled: "Cancelled by user",
};

// User-friendly failure reasons
function formatFailureReason(matchStatus) {
  if (!matchStatus) {
    return "Unknown issue";
  }

  const status = String(matchStatus).toLowerCase();

  if (status.startsWith("skipped:no-gps") || status.includes("no gps")) {
    return "No GPS data recorded";
  }
  if (status.startsWith("skipped:single-point") || status.includes("single point")) {
    return "Only one location point";
  }
  if (status.startsWith("skipped:insufficient") || status.includes("insufficient")) {
    return "Not enough coordinates";
  }
  if (status.startsWith("error:no-geometry") || status.includes("no geometry")) {
    return "No route geometry returned";
  }
  if (status.startsWith("error:") || status.includes("error")) {
    // Extract message after 'error:'
    const msg = status.replace(/^error:/, "").trim();
    if (msg && msg !== "error") {
      return msg.charAt(0).toUpperCase() + msg.slice(1);
    }
    return "Route matching failed";
  }
  if (status.startsWith("skipped:")) {
    const reason = status
      .replace(/^skipped:/, "")
      .replace(/-/g, " ")
      .trim();
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  }

  return matchStatus;
}

// ========================================
// Phase State Machine
// ========================================

function setPhase(phase) {
  if (!PHASES[phase.toUpperCase()] && !Object.values(PHASES).includes(phase)) {
    console.warn("Invalid phase:", phase);
    return;
  }

  _currentPhase = phase;

  // Update phase sections
  document.querySelectorAll(".mm-phase").forEach((section) => {
    const sectionPhase = section.dataset.phase;
    const isActive = sectionPhase === phase;
    section.classList.toggle("is-active", isActive);

    // Manage focus for accessibility
    if (isActive) {
      const heading = section.querySelector("h1, h2");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
  });

  // Update phase indicator dots
  const phaseOrder = [PHASES.SELECT, PHASES.PROCESS, PHASES.RESULTS];
  const currentIndex = phaseOrder.indexOf(phase);

  document.querySelectorAll(".mm-phase-step").forEach((step, _index) => {
    const stepPhase = step.dataset.phase;
    const stepIndex = phaseOrder.indexOf(stepPhase);

    step.classList.remove("is-active", "is-completed");

    if (stepIndex < currentIndex) {
      step.classList.add("is-completed");
    } else if (stepIndex === currentIndex) {
      step.classList.add("is-active");
    }
  });

  // Update connectors
  document.querySelectorAll(".mm-phase-connector").forEach((connector, index) => {
    connector.classList.toggle("is-active", index < currentIndex);
  });
}

function resetToSelect() {
  currentJobId = null;
  _currentJobStage = null;
  lastAutoPreviewJobId = null;
  stopPolling();
  setPhase(PHASES.SELECT);
  setResultMode(RESULT_MODES.JOB);

  // Clear URL parameter
  const url = new URL(window.location.href);
  url.searchParams.delete("job");
  window.history.replaceState({}, "", url.toString());
}

// ========================================
// History Drawer
// ========================================

function openHistoryDrawer() {
  elements.historyDrawer?.classList.add("is-open");
  elements.drawerBackdrop?.classList.add("is-visible");
  document.body.style.overflow = "hidden";

  // Focus management for accessibility
  const closeBtn = elements.drawerClose;
  if (closeBtn) {
    closeBtn.focus();
  }
}

function closeHistoryDrawer() {
  elements.historyDrawer?.classList.remove("is-open");
  elements.drawerBackdrop?.classList.remove("is-visible");
  document.body.style.overflow = "";

  // Return focus to FAB
  elements.historyFab?.focus();
}

function _toggleHistoryDrawer() {
  const isOpen = elements.historyDrawer?.classList.contains("is-open");
  if (isOpen) {
    closeHistoryDrawer();
  } else {
    openHistoryDrawer();
  }
}

// ========================================
// Core Functions
// ========================================

function destroyPreviewMap() {
  if (matchedPreviewMap) {
    try {
      matchedPreviewMap.remove();
    } catch {
      // Ignore cleanup errors.
    }
  }
  matchedPreviewMap = null;
  matchedPreviewMapReady = false;
  matchedPreviewPendingGeojson = null;
  matchedPreviewFeaturesById = new Map();
  matchedPreviewSelectedId = null;
}

function resetState() {
  currentJobId = null;
  _currentJobStage = null;
  previewSignature = null;
  previewPayload = null;
  lastAutoPreviewJobId = null;
  matchedSelection = new Set();
  selectedQuickPick = null;
  _currentPhase = PHASES.SELECT;
  _currentResultMode = RESULT_MODES.JOB;
  failedTripsData = [];
  failedSelection = new Set();
  destroyPreviewMap();
}

function storeLastJobId(jobId) {
  if (!jobId) {
    return;
  }
  try {
    window.localStorage.setItem(LAST_JOB_STORAGE_KEY, jobId);
  } catch (error) {
    console.warn("Unable to persist map matching job id", error);
  }
}

function getStoredJobId() {
  try {
    return window.localStorage.getItem(LAST_JOB_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to read stored map matching job id", error);
    return null;
  }
}

function isTerminalStage(stage) {
  return stage ? TERMINAL_STAGES.has(stage) : false;
}

function formatFriendlyDate(dateStr) {
  if (!dateStr) {
    return "";
  }
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatTripDate(startTime, _endTime) {
  if (!startTime) {
    return "Unknown date";
  }
  const start = new Date(startTime);
  const dateStr = start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dateStr} at ${timeStr}`;
}

function setModeUI(mode) {
  const isDate = mode === "date_range";
  const isTrip = mode === "trip_id";
  elements.dateControls?.classList.toggle("d-none", !isDate);
  elements.tripControls?.classList.toggle("d-none", !isTrip);

  // Update selection options (new wizard UI)
  document.querySelectorAll(".mm-option").forEach((option) => {
    const optionMode = option.dataset.mode;
    option.classList.toggle("is-selected", optionMode === mode);
    const radio = option.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = optionMode === mode;
    }
  });

  // Legacy: Update selection cards
  document.querySelectorAll(".selection-card").forEach((card) => {
    const cardMode = card.dataset.mode;
    card.classList.toggle("is-selected", cardMode === mode);
    const radio = card.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = cardMode === mode;
    }
  });

  // Sync hidden select
  if (elements.modeSelect) {
    elements.modeSelect.value = mode;
  }

  invalidatePreview();
}

function setDateModeUI(mode) {
  const isInterval = mode === "interval";
  elements.dateRange?.classList.toggle("d-none", isInterval);
  elements.interval?.classList.toggle("d-none", !isInterval);
  invalidatePreview();
}

function updateProgressRing(pct) {
  if (!elements.progressRing) {
    return;
  }
  const offset
    = PROGRESS_RING_CIRCUMFERENCE - (pct / 100) * PROGRESS_RING_CIRCUMFERENCE;
  elements.progressRing.style.strokeDashoffset = offset;
}

function updateProgressUI(progress) {
  if (!progress) {
    elements.currentPanel?.classList.add("d-none");
    elements.currentEmpty?.classList.remove("d-none");
    _currentJobStage = null;
    if (elements.cancelBtn) {
      elements.cancelBtn.classList.add("d-none");
      elements.cancelBtn.disabled = true;
    }
    return;
  }

  elements.currentPanel?.classList.remove("d-none");
  elements.currentEmpty?.classList.add("d-none");
  _currentJobStage = progress.stage || null;

  const pct = Math.min(100, Math.max(0, progress.progress || 0));

  // Update progress ring
  updateProgressRing(pct);
  if (elements.progressPercent) {
    elements.progressPercent.textContent = `${pct}%`;
  }

  // Update legacy progress bar (hidden but kept for compatibility)
  if (elements.progressBar) {
    elements.progressBar.style.width = `${pct}%`;
    elements.progressBar.textContent = `${pct}%`;
    elements.progressBar.setAttribute("aria-valuenow", `${pct}`);
  }

  // Friendly message
  const stage = progress.stage || "unknown";
  const friendlyMsg = FRIENDLY_MESSAGES[stage] || progress.message || "";
  if (elements.progressMessage) {
    elements.progressMessage.textContent = friendlyMsg;
  }

  if (elements.cancelBtn) {
    const canCancel = !isTerminalStage(stage);
    elements.cancelBtn.classList.toggle("d-none", !canCancel);
    elements.cancelBtn.disabled = !canCancel;
  }

  // Simplified metrics
  const metrics = progress.metrics || {};
  if (metrics.total != null && elements.progressMetrics) {
    const matchedCount = metrics.matched ?? metrics.map_matched ?? 0;
    elements.progressMetrics.textContent = `${matchedCount} of ${metrics.total} trips matched`;
  } else if (elements.progressMetrics) {
    elements.progressMetrics.textContent = "";
  }

  // Update ring color based on state
  if (elements.progressRing) {
    elements.progressRing.classList.remove("is-success", "is-error", "is-cancelled");
    if (stage === "completed") {
      elements.progressRing.classList.add("is-success");
    } else if (stage === "failed" || stage === "error") {
      elements.progressRing.classList.add("is-error");
    } else if (stage === "cancelled") {
      elements.progressRing.classList.add("is-cancelled");
    }
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (jobsPollTimer) {
    clearInterval(jobsPollTimer);
    jobsPollTimer = null;
  }
}

async function fetchJob(jobId) {
  if (!jobId) {
    return;
  }
  try {
    const data = await apiGet(CONFIG.API.mapMatchingJob(jobId));
    updateProgressUI(data);

    if (isTerminalStage(data.stage)) {
      stopPolling();

      // Transition to results phase when completed
      if (data.stage === "completed" && jobId && lastAutoPreviewJobId !== jobId) {
        lastAutoPreviewJobId = jobId;
        setPhase(PHASES.RESULTS);
        loadMatchedPreview(jobId, { silent: true });
      } else if (
        data.stage === "failed"
        || data.stage === "error"
        || data.stage === "cancelled"
      ) {
        // Stay on process phase but show error state
        // User can click "Match More" to go back
      }
    }
    return data;
  } catch (error) {
    console.error("Failed to fetch job", error);
    stopPolling();
    return null;
  }
}

function startPolling(jobId) {
  currentJobId = jobId;
  lastAutoPreviewJobId = null;
  storeLastJobId(jobId);

  // Transition to process phase
  setPhase(PHASES.PROCESS);

  fetchJob(jobId);
  stopPolling();
  pollTimer = setInterval(() => fetchJob(jobId), 1000);
  jobsPollTimer = setInterval(() => loadJobs(), 5000);

  const url = new URL(window.location.href);
  url.searchParams.set("job", jobId);
  window.history.replaceState({}, "", url.toString());
}

async function loadJobs() {
  try {
    const data = await apiGet(CONFIG.API.mapMatchingJobs);
    renderJobs(data.jobs || []);
    return data.jobs || [];
  } catch (error) {
    console.error("Failed to load jobs", error);
    return [];
  }
}

function renderJobs(jobs) {
  // Update count badge
  if (elements.historyCount) {
    elements.historyCount.textContent = jobs.length;
    elements.historyCount.dataset.count = jobs.length;
  }

  // Render as cards in the drawer
  if (elements.jobsList) {
    if (jobs.length === 0) {
      elements.jobsList.innerHTML = `
        <div class="mm-history-empty" style="padding: var(--space-6); text-align: center; color: var(--text-tertiary); font-size: var(--font-size-sm);">
          <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: var(--space-2); opacity: 0.5;"></i>
          <div>No recent activity</div>
        </div>
      `;
    } else {
      elements.jobsList.innerHTML = jobs
        .map((job) => {
          const status = job.stage || "unknown";
          const progress = job.progress ?? 0;
          const updated = formatFriendlyDate(job.updated_at);
          const isTerminal = isTerminalStage(status);
          const statusClass
            = status === "completed"
              ? "is-completed"
              : status === "cancelled"
                ? "is-cancelled"
                : status === "processing" || status === "queued"
                  ? "is-processing"
                  : "is-failed";
          const canCancel = !isTerminal;

          // Friendly status message
          let message = job.message || "";
          if (status === "completed") {
            const metrics = job.metrics || {};
            const matched = metrics.matched ?? metrics.map_matched ?? 0;
            message = `${matched} trips matched`;
          } else if (status === "cancelled") {
            message = job.message || "Cancelled";
          } else if (status === "processing") {
            message = "Improving routes...";
          } else if (status === "queued") {
            message = "Waiting to start";
          }

          return `
            <div class="history-job" data-job-id="${job.job_id}">
              <div class="history-job-status ${statusClass}"></div>
              <div class="history-job-info">
                <div class="history-job-time">${updated}</div>
                <div class="history-job-message">${message}</div>
              </div>
              <div class="history-job-progress">${progress}%</div>
              <div class="history-job-actions">
                <button class="btn btn-ghost btn-sm" data-action="view" data-job-id="${job.job_id}" title="View">
                  <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-ghost btn-sm" data-action="preview" data-job-id="${job.job_id}" title="Show results" ${!isTerminal ? "disabled" : ""}>
                  <i class="fas fa-map"></i>
                </button>
                <button class="btn btn-ghost btn-sm text-danger" data-action="cancel" data-job-id="${job.job_id}" title="Cancel" ${!canCancel ? "disabled" : ""}>
                  <i class="fas fa-stop"></i>
                </button>
                <button class="btn btn-ghost btn-sm" data-action="delete" data-job-id="${job.job_id}" title="Remove" ${!isTerminal ? "disabled" : ""}>
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  // Also update legacy table for compatibility
  if (elements.jobsBody) {
    elements.jobsBody.innerHTML = jobs
      .map((job) => {
        const status = job.stage || "unknown";
        const progress = job.progress ?? 0;
        const updated = job.updated_at ? new Date(job.updated_at).toLocaleString() : "";
        const isTerminal = isTerminalStage(status);
        return `
          <tr>
            <td class="text-truncate" style="max-width: 220px">${job.job_id || ""}</td>
            <td>${status}</td>
            <td>${progress}%</td>
            <td>${updated}</td>
            <td class="text-truncate" style="max-width: 260px">${job.message || ""}</td>
            <td>
              <button class="btn btn-sm btn-outline-secondary" data-job-id="${job.job_id}">View</button>
              <button class="btn btn-sm btn-outline-primary ms-2" data-preview-job-id="${job.job_id}" ${!isTerminal ? "disabled" : ""}>Preview</button>
              <button class="btn btn-sm btn-outline-danger ms-2" data-cancel-job-id="${job.job_id}" ${isTerminal ? "disabled" : ""}>Cancel</button>
              <button class="btn btn-sm btn-outline-danger ms-2" data-delete-job-id="${job.job_id}" ${!isTerminal ? "disabled" : ""}>Remove</button>
            </td>
          </tr>
        `;
      })
      .join("");
  }
}

function buildPayload() {
  const mode = elements.modeSelect?.value || "unmatched";
  if (mode === "unmatched") {
    return { mode: "unmatched" };
  }

  if (mode === "trip_id") {
    const tripId = elements.tripIdInput?.value.trim();
    if (!tripId) {
      throw new Error("Trip ID is required");
    }
    return { mode: "trip_id", trip_id: tripId };
  }

  const unmatchedOnly = Boolean(elements.unmatchedOnly?.checked);

  // Check if using quick pick interval
  if (selectedQuickPick) {
    return {
      mode: "date_range",
      interval_days: selectedQuickPick,
      unmatched_only: unmatchedOnly,
    };
  }

  // Custom date range
  const start = elements.startInput?.value.trim();
  const end = elements.endInput?.value.trim();
  if (!start || !end) {
    throw new Error("Please select a date range or quick pick option");
  }
  return {
    mode: "date_range",
    start_date: start,
    end_date: end,
    unmatched_only: unmatchedOnly,
  };
}

function invalidatePreview() {
  previewSignature = null;
  previewPayload = null;
  clearInlineStatus(elements.previewStatus);
  clearInlineStatus(elements.submitStatus);
  elements.previewPanel?.classList.add("d-none");
  if (elements.previewBody) {
    elements.previewBody.innerHTML = "";
  }
  if (elements.previewSummary) {
    elements.previewSummary.textContent = "";
  }
}

function renderPreview(data) {
  if (!data || !elements.previewPanel) {
    return;
  }

  const total = data.total || 0;
  if (total === 0) {
    if (elements.previewSummary) {
      elements.previewSummary.textContent = "No trips found for this selection";
    }
  } else if (elements.previewSummary) {
    elements.previewSummary.textContent = `${total} trip${total !== 1 ? "s" : ""} ready to improve`;
  }

  // Render sample in hidden table for legacy compatibility
  const sample = data.sample || [];
  if (elements.previewBody) {
    elements.previewBody.innerHTML = sample
      .map((trip) => {
        const dateStr = formatTripDate(trip.startTime);
        let distance = "";
        if (trip.distance != null && !Number.isNaN(Number(trip.distance))) {
          distance = `${Number(trip.distance).toFixed(1)} mi`;
        }
        return `
          <tr>
            <td>${dateStr}</td>
            <td style="text-align: right; color: var(--text-tertiary);">${distance}</td>
          </tr>
        `;
      })
      .join("");
  }

  elements.previewPanel.classList.remove("d-none");
}

async function previewTrips() {
  clearInlineStatus(elements.previewStatus);
  try {
    const payload = buildPayload();
    const signature = JSON.stringify(payload);
    setInlineStatus(elements.previewStatus, "Loading preview...", "info");
    const response = await apiPost(
      `${CONFIG.API.mapMatchingJobs}/preview?limit=25`,
      payload
    );
    previewSignature = signature;
    previewPayload = payload;
    renderPreview(response);
    clearInlineStatus(elements.previewStatus);
  } catch (error) {
    setInlineStatus(elements.previewStatus, error.message, "danger");
  }
}

async function submitForm(event) {
  event.preventDefault();
  clearInlineStatus(elements.submitStatus);

  try {
    // Build payload fresh if not previewed
    let payload;
    if (previewPayload && previewSignature) {
      const currentPayload = buildPayload();
      if (JSON.stringify(currentPayload) !== previewSignature) {
        // Preview is stale, use fresh payload
        payload = currentPayload;
      } else {
        payload = previewPayload;
      }
    } else {
      payload = buildPayload();
    }

    setInlineStatus(elements.submitStatus, "Starting...", "info");
    const result = await apiPost(CONFIG.API.mapMatchingJobs, payload);
    clearInlineStatus(elements.submitStatus);
    notificationManager.show("Route improvement started!", "success");
    if (result?.job_id) {
      startPolling(result.job_id);
      loadJobs();
    }
  } catch (error) {
    setInlineStatus(elements.submitStatus, error.message, "danger");
    notificationManager.show(error.message, "danger");
  }
}

function wireEvents(signal) {
  if (!elements.form) {
    return;
  }
  const eventOptions = signal ? { signal } : false;

  // New wizard: Selection options (mm-option)
  document.querySelectorAll(".mm-option").forEach((option) => {
    option.addEventListener(
      "click",
      () => {
        const { mode } = option.dataset;
        if (mode) {
          setModeUI(mode);
        }
      },
      eventOptions
    );
  });

  // Legacy: Selection cards
  document.querySelectorAll(".selection-card").forEach((card) => {
    card.addEventListener(
      "click",
      () => {
        const { mode } = card.dataset;
        if (mode) {
          setModeUI(mode);
        }
      },
      eventOptions
    );
  });

  // New wizard: Quick pick buttons (mm-quick-pick)
  document.querySelectorAll(".mm-quick-pick").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        const days = parseInt(btn.dataset.days, 10);
        selectedQuickPick = days;

        // Clear custom date inputs
        if (elements.startInput) {
          elements.startInput.value = "";
        }
        if (elements.endInput) {
          elements.endInput.value = "";
        }

        // Update button states
        document.querySelectorAll(".mm-quick-pick").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });

        // Legacy quick-pick-btn compatibility
        document.querySelectorAll(".quick-pick-btn").forEach((b) => {
          b.classList.toggle("is-active", parseInt(b.dataset.days, 10) === days);
        });

        // Update legacy selects for compatibility
        if (elements.dateModeSelect) {
          elements.dateModeSelect.value = "interval";
        }
        if (elements.intervalSelect) {
          elements.intervalSelect.value = String(days);
        }

        invalidatePreview();
      },
      eventOptions
    );
  });

  // Legacy: Quick pick buttons
  document.querySelectorAll(".quick-pick-btn").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        const days = parseInt(btn.dataset.days, 10);
        selectedQuickPick = days;

        // Clear custom date inputs
        if (elements.startInput) {
          elements.startInput.value = "";
        }
        if (elements.endInput) {
          elements.endInput.value = "";
        }

        // Update button states (both new and legacy)
        document.querySelectorAll(".quick-pick-btn, .mm-quick-pick").forEach((b) => {
          b.classList.toggle("is-active", parseInt(b.dataset.days, 10) === days);
        });

        // Update legacy selects for compatibility
        if (elements.dateModeSelect) {
          elements.dateModeSelect.value = "interval";
        }
        if (elements.intervalSelect) {
          elements.intervalSelect.value = String(days);
        }

        invalidatePreview();
      },
      eventOptions
    );
  });

  // Custom date inputs clear quick pick
  [elements.startInput, elements.endInput].forEach((input) => {
    if (input) {
      input.addEventListener(
        "change",
        () => {
          selectedQuickPick = null;
          document.querySelectorAll(".quick-pick-btn, .mm-quick-pick").forEach((b) => {
            b.classList.remove("is-active");
          });
          if (elements.dateModeSelect) {
            elements.dateModeSelect.value = "date";
          }
          invalidatePreview();
        },
        eventOptions
      );
    }
  });

  // Advanced toggle
  elements.advancedToggle?.addEventListener(
    "click",
    () => {
      const isOpen = elements.advancedOptions?.classList.toggle("d-none") === false;
      elements.advancedToggle.classList.toggle("is-open", isOpen);
    },
    eventOptions
  );

  // Match more button (return to select phase)
  elements.matchMoreBtn?.addEventListener(
    "click",
    () => {
      resetToSelect();
    },
    eventOptions
  );

  // History FAB
  elements.historyFab?.addEventListener(
    "click",
    () => {
      openHistoryDrawer();
    },
    eventOptions
  );

  // Drawer close button
  elements.drawerClose?.addEventListener(
    "click",
    () => {
      closeHistoryDrawer();
    },
    eventOptions
  );

  // Drawer backdrop
  elements.drawerBackdrop?.addEventListener(
    "click",
    () => {
      closeHistoryDrawer();
    },
    eventOptions
  );

  // Escape key to close drawer
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && elements.historyDrawer?.classList.contains("is-open")) {
        closeHistoryDrawer();
      }
    },
    eventOptions
  );

  // Legacy: History toggle (collapse/expand) - now just open drawer
  elements.historyToggle?.addEventListener(
    "click",
    (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.closest("button")) {
        return;
      }
      openHistoryDrawer();
    },
    eventOptions
  );

  // History job actions
  elements.jobsList?.addEventListener(
    "click",
    (event) => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) {
        return;
      }

      const { action } = btn.dataset;
      const { jobId } = btn.dataset;

      if (action === "view" && jobId) {
        closeHistoryDrawer();
        startPolling(jobId);
      } else if (action === "preview" && jobId) {
        closeHistoryDrawer();
        setPhase(PHASES.RESULTS);
        currentJobId = jobId;
        loadMatchedPreview(jobId);
      } else if (action === "cancel" && jobId) {
        cancelJob(jobId);
      } else if (action === "delete" && jobId) {
        deleteJobHistory(jobId);
      }
    },
    eventOptions
  );

  // Legacy support
  elements.modeSelect?.addEventListener(
    "change",
    (e) => {
      setModeUI(e.target.value);
    },
    eventOptions
  );

  elements.dateModeSelect?.addEventListener(
    "change",
    (e) => {
      setDateModeUI(e.target.value);
    },
    eventOptions
  );

  elements.form.addEventListener("submit", submitForm, eventOptions);
  elements.previewBtn?.addEventListener("click", previewTrips, eventOptions);
  elements.previewMapBtn?.addEventListener(
    "click",
    () => {
      loadMatchedPreview(currentJobId);
    },
    eventOptions
  );

  elements.cancelBtn?.addEventListener(
    "click",
    () => {
      cancelJob(currentJobId);
    },
    eventOptions
  );

  elements.refreshBtn?.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      loadJobs();
    },
    eventOptions
  );

  elements.historyClearBtn?.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      clearHistory();
    },
    eventOptions
  );

  elements.previewSelectAll?.addEventListener(
    "change",
    (event) => {
      selectAllVisible(event.target.checked);
    },
    eventOptions
  );

  elements.previewClearSelection?.addEventListener(
    "click",
    () => {
      clearSelection();
    },
    eventOptions
  );

  elements.previewUnmatchSelected?.addEventListener(
    "click",
    () => {
      clearMatchedTrips(Array.from(matchedSelection));
    },
    eventOptions
  );

  elements.previewDeleteSelected?.addEventListener(
    "click",
    () => {
      deleteTrips(Array.from(matchedSelection));
    },
    eventOptions
  );

  // Legacy table events
  elements.jobsBody?.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button[data-job-id]");
      const previewButton = event.target.closest("button[data-preview-job-id]");
      const cancelButton = event.target.closest("button[data-cancel-job-id]");
      const deleteButton = event.target.closest("button[data-delete-job-id]");
      if (deleteButton) {
        const jobId = deleteButton.dataset.deleteJobId;
        if (jobId) {
          deleteJobHistory(jobId);
        }
        return;
      }
      if (cancelButton) {
        const jobId = cancelButton.dataset.cancelJobId;
        if (jobId) {
          cancelJob(jobId);
        }
        return;
      }
      if (previewButton) {
        const jobId = previewButton.dataset.previewJobId;
        if (jobId) {
          setPhase(PHASES.RESULTS);
          currentJobId = jobId;
          loadMatchedPreview(jobId);
        }
        return;
      }
      if (!button) {
        return;
      }
      const { jobId } = button.dataset;
      if (jobId) {
        startPolling(jobId);
      }
    },
    eventOptions
  );

  // Results trip cards
  elements.resultsTrips?.addEventListener(
    "click",
    (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (actionButton) {
        const { tripId } = actionButton.dataset;
        const { action } = actionButton.dataset;
        if (tripId && action === "unmatch") {
          clearMatchedTrips([tripId]);
        } else if (tripId && action === "delete") {
          deleteTrips([tripId]);
        }
        return;
      }

      const checkbox = event.target.closest(".result-trip-select input");
      if (checkbox) {
        setSelection(checkbox.dataset.tripId, checkbox.checked);
        return;
      }

      const card = event.target.closest(".result-trip[data-trip-id]");
      if (card) {
        const { tripId } = card.dataset;
        focusMatchedPreviewTrip(tripId);
      }
    },
    eventOptions
  );

  // Legacy table for matched preview
  elements.previewMapBody?.addEventListener(
    "click",
    (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (actionButton) {
        const { tripId } = actionButton.dataset;
        const { action } = actionButton.dataset;
        if (tripId && action === "unmatch") {
          clearMatchedTrips([tripId]);
        } else if (tripId && action === "delete") {
          deleteTrips([tripId]);
        }
        return;
      }

      const checkbox = event.target.closest(".matched-preview-select");
      if (checkbox) {
        return;
      }

      const row = event.target.closest("tr[data-trip-id]");
      if (!row) {
        return;
      }
      const { tripId } = row.dataset;
      focusMatchedPreviewTrip(tripId);
    },
    eventOptions
  );

  elements.previewMapBody?.addEventListener(
    "change",
    (event) => {
      const checkbox = event.target.closest(".matched-preview-select");
      if (!checkbox) {
        return;
      }
      setSelection(checkbox.dataset.tripId, checkbox.checked);
    },
    eventOptions
  );

  // Browse matched trips button
  elements.browseMatchedBtn?.addEventListener(
    "click",
    () => {
      browseMatchedTrips();
    },
    eventOptions
  );

  // Browse failed trips button
  elements.browseFailedBtn?.addEventListener(
    "click",
    () => {
      browseFailedTrips();
    },
    eventOptions
  );

  // Browse back buttons (return to select)
  elements.browseBackBtn?.addEventListener(
    "click",
    () => {
      resetToSelect();
    },
    eventOptions
  );

  elements.failedBackBtn?.addEventListener(
    "click",
    () => {
      resetToSelect();
    },
    eventOptions
  );

  // Browse refresh buttons
  elements.browseRefreshBtn?.addEventListener(
    "click",
    () => {
      browseMatchedTrips({ silent: true });
    },
    eventOptions
  );

  elements.failedRefreshBtn?.addEventListener(
    "click",
    () => {
      browseFailedTrips({ silent: true });
    },
    eventOptions
  );

  // Tab switching
  elements.tabMatched?.addEventListener(
    "click",
    () => {
      switchTab("matched");
    },
    eventOptions
  );

  elements.tabFailed?.addEventListener(
    "click",
    () => {
      switchTab("failed");
    },
    eventOptions
  );

  // Failed trips list event delegation
  elements.failedTrips?.addEventListener(
    "click",
    (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (actionButton) {
        const { tripId } = actionButton.dataset;
        const { action } = actionButton.dataset;
        if (tripId && action === "retry") {
          retryMatchingTrips([tripId]);
        } else if (tripId && action === "delete") {
          deleteTrips([tripId]);
        }
        return;
      }

      const checkbox = event.target.closest(".failed-trip-select input");
      if (checkbox) {
        setFailedSelection(checkbox.dataset.tripId, checkbox.checked);
      }
    },
    eventOptions
  );

  // Failed trips select all
  elements.failedSelectAll?.addEventListener(
    "change",
    (event) => {
      selectAllFailed(event.target.checked);
    },
    eventOptions
  );

  // Retry selected failed trips
  elements.retrySelectedBtn?.addEventListener(
    "click",
    () => {
      retryMatchingTrips(Array.from(failedSelection));
    },
    eventOptions
  );

  // Delete selected failed trips
  elements.deleteFailedSelectedBtn?.addEventListener(
    "click",
    () => {
      deleteTrips(Array.from(failedSelection));
    },
    eventOptions
  );

  // Retry all failed trips
  elements.retryAllBtn?.addEventListener(
    "click",
    () => {
      const allFailedIds = failedTripsData.map((t) => t.transactionId).filter(Boolean);
      if (allFailedIds.length > 0) {
        retryMatchingTrips(allFailedIds);
      }
    },
    eventOptions
  );

  const invalidateTargets = [
    elements.modeSelect,
    elements.dateModeSelect,
    elements.startInput,
    elements.endInput,
    elements.intervalSelect,
    elements.unmatchedOnly,
    elements.tripIdInput,
  ];
  invalidateTargets.forEach((el) => {
    if (!el) {
      return;
    }
    el.addEventListener("input", invalidatePreview, eventOptions);
    el.addEventListener("change", invalidatePreview, eventOptions);
  });
}

function initDatePickers() {
  if (DateUtils?.initDatePicker) {
    DateUtils.initDatePicker(".datepicker");
  } else if (flatpickr) {
    flatpickr(".datepicker", {
      enableTime: false,
      dateFormat: "Y-m-d",
    });
  }
}

function ensureMapboxToken() {
  if (window.MAPBOX_ACCESS_TOKEN) {
    return true;
  }
  const meta = document.querySelector('meta[name="mapbox-access-token"]');
  if (meta?.content) {
    window.MAPBOX_ACCESS_TOKEN = meta.content;
    return true;
  }
  return false;
}

function getMatchedPreviewColor() {
  if (!elements.previewMap) {
    return CONFIG.LAYER_DEFAULTS.matchedTrips.color;
  }
  const container = elements.previewMap.closest(".mm-results-map-container");
  if (!container) {
    return CONFIG.LAYER_DEFAULTS.matchedTrips.color;
  }
  const color = getComputedStyle(container).getPropertyValue("--matched-preview-color");
  return color?.trim() || CONFIG.LAYER_DEFAULTS.matchedTrips.color;
}

function ensureMatchedPreviewMap() {
  if (!elements.previewMap) {
    return null;
  }
  if (matchedPreviewMap) {
    return matchedPreviewMap;
  }
  if (typeof mapboxgl === "undefined") {
    setInlineStatus(elements.previewMapStatus, "Mapbox GL is not loaded.", "danger");
    return null;
  }
  if (!ensureMapboxToken()) {
    setInlineStatus(elements.previewMapStatus, "Mapbox token is missing.", "danger");
    return null;
  }

  matchedPreviewMap = mapBase.createMap("map-match-preview-map", {
    center: [-96.5, 37.5],
    zoom: 3.4,
    interactive: true,
  });

  matchedPreviewMap.scrollZoom.disable();
  matchedPreviewMap.boxZoom.disable();
  matchedPreviewMap.dragRotate.disable();
  matchedPreviewMap.keyboard.disable();
  matchedPreviewMap.doubleClickZoom.disable();
  matchedPreviewMap.touchZoomRotate.disableRotation();

  matchedPreviewMap.on("load", () => {
    matchedPreviewMapReady = true;
    if (matchedPreviewPendingGeojson) {
      updateMatchedPreviewMap(matchedPreviewPendingGeojson);
      matchedPreviewPendingGeojson = null;
    }
  });

  return matchedPreviewMap;
}

function updateMatchedPreviewEmptyState(message) {
  if (!elements.previewMapEmpty) {
    return;
  }
  if (message) {
    const content = elements.previewMapEmpty.querySelector(
      ".mm-empty-map-content span, .empty-map-content span"
    );
    if (content) {
      content.textContent = message;
    }
    elements.previewMapEmpty.classList.remove("d-none");
  } else {
    elements.previewMapEmpty.classList.add("d-none");
  }
}

function updateMatchedSelectionUI() {
  const total = elements.resultsTrips
    ? elements.resultsTrips.querySelectorAll(".result-trip-select input").length
    : 0;
  const selectedCount = matchedSelection.size;

  if (elements.previewSelectionCount) {
    elements.previewSelectionCount.textContent = `${selectedCount} selected`;
  }

  // Show/hide bulk actions
  if (elements.bulkActions) {
    elements.bulkActions.classList.toggle("d-none", selectedCount === 0);
  }

  if (elements.previewSelectAll) {
    const allSelected = total > 0 && selectedCount === total;
    elements.previewSelectAll.checked = allSelected;
    elements.previewSelectAll.indeterminate = selectedCount > 0 && !allSelected;
    elements.previewSelectAll.disabled = total === 0;
  }

  const disableActions = selectedCount === 0;
  if (elements.previewClearSelection) {
    elements.previewClearSelection.disabled = disableActions;
  }
  if (elements.previewUnmatchSelected) {
    elements.previewUnmatchSelected.disabled = disableActions;
  }
  if (elements.previewDeleteSelected) {
    elements.previewDeleteSelected.disabled = disableActions;
  }
}

function syncSelectionStyles() {
  if (elements.resultsTrips) {
    elements.resultsTrips.querySelectorAll(".result-trip").forEach((card) => {
      const tripId = String(card.dataset.tripId || "");
      const isSelected = matchedSelection.has(tripId);
      card.classList.toggle("is-selected", isSelected);
      const checkbox = card.querySelector(".result-trip-select input");
      if (checkbox) {
        checkbox.checked = isSelected;
      }
    });
  }
  if (elements.previewMapBody) {
    elements.previewMapBody.querySelectorAll("tr[data-trip-id]").forEach((row) => {
      const tripId = String(row.dataset.tripId || "");
      const isSelected = matchedSelection.has(tripId);
      row.classList.toggle("is-selected", isSelected);
      const checkbox = row.querySelector(".matched-preview-select");
      if (checkbox) {
        checkbox.checked = isSelected;
      }
    });
  }
}

function setFocusedTripUI(tripId) {
  const normalized = tripId ? String(tripId) : null;
  if (elements.resultsTrips) {
    elements.resultsTrips.querySelectorAll(".result-trip").forEach((card) => {
      const cardId = String(card.dataset.tripId || "");
      const isFocused = normalized !== null && cardId === normalized;
      card.classList.toggle("is-focused", isFocused);
    });
  }
  if (elements.previewMapBody) {
    elements.previewMapBody.querySelectorAll("tr[data-trip-id]").forEach((row) => {
      const rowId = String(row.dataset.tripId || "");
      const isFocused = normalized !== null && rowId === normalized;
      row.classList.toggle("is-focused", isFocused);
    });
  }
}

function syncSelectionWithRows(tripIds) {
  const allowed = new Set(tripIds.filter(Boolean).map(String));
  matchedSelection = new Set(
    Array.from(matchedSelection).filter((id) => allowed.has(id))
  );
  updateMatchedSelectionUI();
}

function setSelection(tripId, checked) {
  if (!tripId) {
    return;
  }
  const normalized = String(tripId);
  if (checked) {
    matchedSelection.add(normalized);
  } else {
    matchedSelection.delete(normalized);
  }
  clearInlineStatus(elements.previewActionsStatus);
  syncSelectionStyles();
  updateMatchedSelectionUI();
}

function clearSelection() {
  matchedSelection = new Set();
  syncSelectionStyles();
  clearInlineStatus(elements.previewActionsStatus);
  updateMatchedSelectionUI();
}

function selectAllVisible(checked) {
  matchedSelection = new Set();
  if (checked && elements.resultsTrips) {
    elements.resultsTrips
      .querySelectorAll(".result-trip-select input")
      .forEach((checkbox) => {
        const tripId = String(checkbox.dataset.tripId || "");
        if (tripId) {
          matchedSelection.add(tripId);
        }
      });
  }
  if (checked && elements.previewMapBody) {
    elements.previewMapBody
      .querySelectorAll(".matched-preview-select")
      .forEach((checkbox) => {
        const tripId = String(checkbox.dataset.tripId || "");
        if (tripId) {
          matchedSelection.add(tripId);
        }
      });
  }
  syncSelectionStyles();
  clearInlineStatus(elements.previewActionsStatus);
  updateMatchedSelectionUI();
}

function buildBoundsFromGeojson(geojson) {
  if (!geojson?.features?.length || typeof mapboxgl === "undefined") {
    return null;
  }
  const bounds = new mapboxgl.LngLatBounds();
  let hasPoint = false;
  geojson.features.forEach((feature) => {
    const geometry = feature?.geometry;
    if (!geometry) {
      return;
    }
    const { type, coordinates } = geometry;
    if (type === "LineString") {
      coordinates.forEach((coord) => {
        bounds.extend(coord);
        hasPoint = true;
      });
    } else if (type === "MultiLineString") {
      coordinates.forEach((line) => {
        line.forEach((coord) => {
          bounds.extend(coord);
          hasPoint = true;
        });
      });
    } else if (type === "Point") {
      bounds.extend(coordinates);
      hasPoint = true;
    }
  });
  return hasPoint ? bounds : null;
}

function updateMatchedPreviewMap(geojson) {
  const map = ensureMatchedPreviewMap();
  if (!map || !geojson) {
    return;
  }
  matchedPreviewFeaturesById = new Map();
  (geojson.features || []).forEach((feature) => {
    const tripId = feature?.properties?.transactionId;
    if (tripId) {
      matchedPreviewFeaturesById.set(String(tripId), feature);
    }
  });
  if (!matchedPreviewMapReady) {
    matchedPreviewPendingGeojson = geojson;
    return;
  }

  const sourceId = "matched-preview-source";
  const layerId = "matched-preview-layer";
  const highlightId = "matched-preview-highlight";
  const color = getMatchedPreviewColor();
  const { highlightColor } = CONFIG.LAYER_DEFAULTS.matchedTrips;

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, {
      type: "geojson",
      data: geojson,
      promoteId: "transactionId",
    });
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": color,
        "line-opacity": 0.8,
        "line-width": 3,
      },
    });
    map.addLayer({
      id: highlightId,
      type: "line",
      source: sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": highlightColor || "#40E0D0",
        "line-opacity": 0.95,
        "line-width": 6,
      },
      filter: ["==", ["get", "transactionId"], ""],
    });
  }

  if (map.getLayer(highlightId)) {
    map.setFilter(
      highlightId,
      matchedPreviewSelectedId
        ? ["==", ["get", "transactionId"], matchedPreviewSelectedId]
        : ["==", ["get", "transactionId"], ""]
    );
  }

  const bounds = buildBoundsFromGeojson(geojson);
  if (bounds) {
    map.fitBounds(bounds, { padding: 40, duration: 600 });
    updateMatchedPreviewEmptyState(null);
  } else {
    updateMatchedPreviewEmptyState("No routes to display");
  }
}

function updateMatchedPreviewTable(data) {
  const total = data?.total || 0;
  const sample = data?.sample || [];

  // Update summary
  if (elements.previewMapSummary) {
    if (total > 0) {
      elements.previewMapSummary.textContent = `${total} matched trip${total !== 1 ? "s" : ""}`;
    } else {
      elements.previewMapSummary.textContent = "No matched trips yet";
    }
  }

  // Update results count
  if (elements.resultsCount) {
    elements.resultsCount.textContent
      = total > 0 ? `${total} trip${total !== 1 ? "s" : ""}` : "No trips yet";
  }

  if (!total) {
    updateMatchedPreviewEmptyState("No matched trips yet");
  }

  matchedPreviewFeaturesById = new Map();

  // Render as cards in new UI
  if (elements.resultsTrips) {
    elements.resultsTrips.innerHTML = sample
      .map((trip) => {
        const tripId = trip.transactionId || "";
        const dateStr = formatTripDate(trip.startTime);
        let distance = "";
        if (trip.distance != null && !Number.isNaN(Number(trip.distance))) {
          distance = `${Number(trip.distance).toFixed(1)} mi`;
        }
        const isSelected = matchedSelection.has(String(tripId));
        return `
          <div class="result-trip ${isSelected ? "is-selected" : ""}" data-trip-id="${tripId}">
            <div class="result-trip-select">
              <input type="checkbox" class="form-check-input" data-trip-id="${tripId}" ${isSelected ? "checked" : ""} />
            </div>
            <div class="result-trip-info">
              <div class="result-trip-date">${dateStr}</div>
              <div class="result-trip-details">${distance}</div>
            </div>
            <div class="result-trip-actions">
              <button class="btn btn-ghost btn-sm" data-action="unmatch" data-trip-id="${tripId}" title="Remove improvement">
                <i class="fas fa-undo"></i>
              </button>
              <button class="btn btn-ghost btn-sm text-danger" data-action="delete" data-trip-id="${tripId}" title="Delete trip">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // Legacy table
  if (elements.previewMapBody) {
    elements.previewMapBody.innerHTML = sample
      .map((trip) => {
        const tripId = trip.transactionId || "";
        const matchedAt = trip.matched_at
          ? new Date(trip.matched_at).toLocaleString()
          : "--";
        let distance = "--";
        if (trip.distance != null && !Number.isNaN(Number(trip.distance))) {
          distance = `${Number(trip.distance).toFixed(2)} mi`;
        }
        const status = trip.matchStatus || (trip.matchedGps ? "Matched" : "Unmatched");
        const isSelected = matchedSelection.has(String(tripId));
        return `
          <tr data-trip-id="${tripId}">
            <td class="matched-preview-select-cell">
              <input class="form-check-input matched-preview-select" type="checkbox" data-trip-id="${tripId}" aria-label="Select trip ${tripId}" ${isSelected ? "checked" : ""} />
            </td>
            <td class="text-truncate" style="max-width: 200px">${tripId}</td>
            <td>${matchedAt}</td>
            <td>${distance}</td>
            <td>${status}</td>
            <td class="matched-preview-actions-cell">
              <button class="btn btn-sm btn-outline-secondary" data-action="unmatch" data-trip-id="${tripId}">Clear</button>
              <button class="btn btn-sm btn-outline-danger" data-action="delete" data-trip-id="${tripId}">Delete</button>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  syncSelectionWithRows(sample.map((trip) => String(trip.transactionId || "")));
}

async function clearMatchedTrips(tripIds, { silent = false } = {}) {
  if (!tripIds.length) {
    return;
  }

  const confirmed = await confirmationDialog.show({
    title: "Remove improvement",
    message:
      "This keeps your trip but removes the route improvement. You can re-match it later.",
    confirmText: "Remove",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Removing...", "info");
    if (tripIds.length === 1) {
      await apiDelete(CONFIG.API.matchedTripById(tripIds[0]));
    } else {
      await apiPost(CONFIG.API.matchedTripsBulkUnmatch, {
        trip_ids: tripIds,
      });
    }
    if (!silent) {
      notificationManager.show("Improvement removed", "success");
    }
    clearSelection();
    await loadMatchedPreview(currentJobId, { silent: true });
    clearInlineStatus(elements.previewActionsStatus);
  } catch (error) {
    console.error("Failed to clear matches", error);
    setInlineStatus(elements.previewActionsStatus, error.message, "danger");
  }
}

async function deleteTrips(tripIds, { silent = false } = {}) {
  if (!tripIds.length) {
    return;
  }

  const confirmed = await confirmationDialog.show({
    title: "Delete trips",
    message: "This permanently deletes the trips and cannot be undone. Are you sure?",
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Deleting...", "info");
    if (tripIds.length === 1) {
      await apiDelete(CONFIG.API.tripById(tripIds[0]));
    } else {
      await apiPost(CONFIG.API.tripsBulkDelete, {
        trip_ids: tripIds,
      });
    }
    if (!silent) {
      notificationManager.show("Trips deleted", "success");
    }
    clearSelection();
    await loadMatchedPreview(currentJobId, { silent: true });
    clearInlineStatus(elements.previewActionsStatus);
  } catch (error) {
    console.error("Failed to delete trips", error);
    setInlineStatus(elements.previewActionsStatus, error.message, "danger");
  }
}

async function cancelJob(jobId) {
  if (!jobId) {
    return;
  }
  const confirmed = await confirmationDialog.show({
    title: "Cancel map matching job",
    message:
      "Stop this job? Trips already matched will remain, and remaining trips will be skipped.",
    confirmText: "Cancel job",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  const disableCancelBtn = Boolean(elements.cancelBtn && currentJobId === jobId);
  try {
    if (disableCancelBtn) {
      elements.cancelBtn.disabled = true;
    }
    setInlineStatus(elements.historyStatus, "Cancelling...", "info");
    const response = await apiPost(CONFIG.API.mapMatchingJobCancel(jobId));
    if (response?.status === "already_finished") {
      notificationManager.show("Job already finished", "info");
    } else {
      notificationManager.show("Job cancelled", "info");
    }
    await loadJobs();
    if (currentJobId === jobId) {
      if (response?.job) {
        updateProgressUI(response.job);
      } else {
        await fetchJob(jobId);
      }
      stopPolling();
    }
    clearInlineStatus(elements.historyStatus);
  } catch (error) {
    console.error("Failed to cancel job", error);
    setInlineStatus(elements.historyStatus, error.message, "danger");
    if (disableCancelBtn) {
      elements.cancelBtn.disabled = false;
    }
  }
}

async function deleteJobHistory(jobId) {
  if (!jobId) {
    return;
  }
  const confirmed = await confirmationDialog.show({
    title: "Remove from history",
    message: "Remove this from your activity list? Running jobs will continue.",
    confirmText: "Remove",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.historyStatus, "Removing...", "info");
    await apiDelete(CONFIG.API.mapMatchingJob(jobId));
    if (currentJobId === jobId) {
      currentJobId = null;
      stopPolling();
      updateProgressUI(null);
    }
    await loadJobs();
    clearInlineStatus(elements.historyStatus);
  } catch (error) {
    console.error("Failed to delete history entry", error);
    setInlineStatus(elements.historyStatus, error.message, "danger");
  }
}

async function clearHistory() {
  const confirmed = await confirmationDialog.show({
    title: "Clear history",
    message:
      "Clear completed jobs from your activity list? Active jobs will continue running.",
    confirmText: "Clear",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.historyStatus, "Clearing...", "info");
    const response = await apiDelete(
      `${CONFIG.API.mapMatchingJobs}?include_active=false`
    );
    await loadJobs();
    clearInlineStatus(elements.historyStatus);
    const deleted = response?.deleted ?? 0;
    if (deleted > 0) {
      notificationManager.show(
        `Cleared ${deleted} completed job${deleted !== 1 ? "s" : ""}`,
        "success"
      );
    }
  } catch (error) {
    console.error("Failed to clear history", error);
    setInlineStatus(elements.historyStatus, error.message, "danger");
  }
}

async function loadMatchedPreview(jobId, { silent = false } = {}) {
  if (!jobId) {
    if (!silent) {
      setInlineStatus(
        elements.previewMapStatus,
        "Select a job to see results",
        "warning"
      );
    }
    return;
  }

  setResultMode(RESULT_MODES.JOB);
  clearInlineStatus(elements.previewMapStatus);
  clearInlineStatus(elements.previewActionsStatus);
  try {
    matchedPreviewSelectedId = null;
    setFocusedTripUI(null);
    if (!silent) {
      setInlineStatus(elements.previewMapStatus, "Loading...", "info");
    }
    const response = await apiGet(CONFIG.API.mapMatchingJobMatches(jobId));
    updateMatchedPreviewTable(response);
    if (response?.geojson) {
      updateMatchedPreviewMap(response.geojson);
    } else {
      updateMatchedPreviewEmptyState("No routes to display");
    }
    clearInlineStatus(elements.previewMapStatus);
  } catch (error) {
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
  }
}

// ========================================
// Browse Mode Functions
// ========================================

function setResultMode(mode) {
  _currentResultMode = mode;

  // Hide all headers first
  elements.resultsHeaderSuccess?.classList.add("d-none");
  elements.resultsHeaderBrowse?.classList.add("d-none");
  elements.resultsHeaderFailed?.classList.add("d-none");

  // Show/hide tabs based on mode
  const showTabs = mode === RESULT_MODES.JOB;
  elements.resultsTabs?.classList.toggle("d-none", !showTabs);

  // Show/hide match more button (only in job mode)
  elements.matchMoreContainer?.classList.toggle("d-none", mode !== RESULT_MODES.JOB);

  // Show appropriate header and content
  switch (mode) {
    case RESULT_MODES.JOB:
      elements.resultsHeaderSuccess?.classList.remove("d-none");
      switchTab("matched");
      break;
    case RESULT_MODES.BROWSE_MATCHED:
      elements.resultsHeaderBrowse?.classList.remove("d-none");
      elements.matchedListContainer?.classList.remove("d-none");
      elements.failedListContainer?.classList.add("d-none");
      break;
    case RESULT_MODES.BROWSE_FAILED:
      elements.resultsHeaderFailed?.classList.remove("d-none");
      elements.matchedListContainer?.classList.add("d-none");
      elements.failedListContainer?.classList.remove("d-none");
      break;
  }
}

function switchTab(tab) {
  // Update tab buttons
  elements.tabMatched?.classList.toggle("is-active", tab === "matched");
  elements.tabFailed?.classList.toggle("is-active", tab === "failed");

  // Show/hide content
  elements.matchedListContainer?.classList.toggle("d-none", tab !== "matched");
  elements.failedListContainer?.classList.toggle("d-none", tab !== "failed");
}

function normalizeMatchedTripsResponse(response) {
  if (!response) {
    return { trips: [], geojson: null, total: 0 };
  }

  const asFeatureCollection
    = response?.type === "FeatureCollection" && Array.isArray(response?.features)
      ? response
      : response?.geojson?.type === "FeatureCollection"
          && Array.isArray(response?.geojson?.features)
        ? response.geojson
        : null;

  const explicitTrips = Array.isArray(response?.trips) ? response.trips : null;
  if (explicitTrips) {
    const total = response?.total ?? explicitTrips.length;
    return { trips: explicitTrips, geojson: asFeatureCollection, total };
  }

  if (asFeatureCollection) {
    const trips = asFeatureCollection.features
      .map((feature) => {
        if (!feature) {
          return null;
        }
        const props = feature.properties || {};
        return {
          ...props,
          transactionId: props.transactionId || feature.id || "",
          matchedGps: feature.geometry || props.matchedGps || null,
        };
      })
      .filter(Boolean);

    return { trips, geojson: asFeatureCollection, total: trips.length };
  }

  return {
    trips: [],
    geojson: asFeatureCollection || response?.geojson || null,
    total: 0,
  };
}

async function browseMatchedTrips({ silent = false } = {}) {
  setPhase(PHASES.RESULTS);
  setResultMode(RESULT_MODES.BROWSE_MATCHED);

  clearInlineStatus(elements.previewMapStatus);
  clearInlineStatus(elements.previewActionsStatus);

  try {
    matchedPreviewSelectedId = null;
    setFocusedTripUI(null);
    matchedSelection = new Set();

    if (!silent) {
      setInlineStatus(elements.previewMapStatus, "Loading matched trips...", "info");
    }

    // Fetch all matched trips
    const response = await apiGet(`${CONFIG.API.matchedTrips}?limit=100`);
    const { trips, geojson, total } = normalizeMatchedTripsResponse(response);
    const summaryCount = typeof total === "number" ? total : trips.length;

    // Update summary
    if (elements.browseSummary) {
      elements.browseSummary.textContent
        = summaryCount > 0
          ? `${summaryCount} matched trip${summaryCount !== 1 ? "s" : ""}`
          : "No matched trips yet";
    }

    // Update table/cards
    updateMatchedPreviewTable({ total: summaryCount, sample: trips });

    // Update map with geojson if available
    if (geojson?.features?.length) {
      updateMatchedPreviewMap(geojson);
    } else {
      // Build geojson from trips that have geometry
      const features = trips
        .filter((t) => t.matchedGps?.coordinates)
        .map((t) => ({
          type: "Feature",
          properties: { transactionId: t.transactionId },
          geometry: t.matchedGps,
        }));

      if (features.length > 0) {
        updateMatchedPreviewMap({ type: "FeatureCollection", features });
      } else {
        updateMatchedPreviewEmptyState("No routes to display");
      }
    }

    clearInlineStatus(elements.previewMapStatus);
  } catch (error) {
    console.error("Failed to load matched trips", error);
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
  }
}

async function browseFailedTrips({ silent = false } = {}) {
  setPhase(PHASES.RESULTS);
  setResultMode(RESULT_MODES.BROWSE_FAILED);

  try {
    failedTripsData = [];
    failedSelection = new Set();

    if (!silent) {
      setInlineStatus(elements.previewMapStatus, "Loading failed trips...", "info");
    }

    // Fetch trips with failed/skipped match status
    const response = await apiGet(`${CONFIG.API.failedTrips}?limit=100`);
    const trips = response?.trips || [];
    failedTripsData = trips;

    // Update summary
    if (elements.failedSummary) {
      elements.failedSummary.textContent
        = trips.length > 0
          ? `${trips.length} trip${trips.length !== 1 ? "s" : ""} with issues`
          : "No failed trips";
    }

    // Update count badge
    if (elements.failedCountBadge) {
      elements.failedCountBadge.textContent = trips.length;
      elements.failedCountBadge.classList.toggle("d-none", trips.length === 0);
    }

    // Render failed trips list
    renderFailedTrips(trips);

    // Update map - show empty state for failed trips
    updateMatchedPreviewEmptyState("Select trips to retry matching");

    clearInlineStatus(elements.previewMapStatus);
  } catch (error) {
    console.error("Failed to load failed trips", error);
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
  }
}

function renderFailedTrips(trips) {
  if (!elements.failedTrips) {
    return;
  }

  // Update count
  if (elements.failedListCount) {
    elements.failedListCount.textContent
      = trips.length > 0
        ? `${trips.length} trip${trips.length !== 1 ? "s" : ""} with issues`
        : "No issues";
  }

  if (trips.length === 0) {
    elements.failedTrips.innerHTML = `
      <div class="mm-failed-empty">
        <i class="fas fa-check-circle"></i>
        <div>No failed trips found</div>
      </div>
    `;
    return;
  }

  elements.failedTrips.innerHTML = trips
    .map((trip) => {
      const tripId = trip.transactionId || "";
      const dateStr = formatTripDate(trip.startTime);
      const reason = formatFailureReason(trip.matchStatus);
      const isSelected = failedSelection.has(String(tripId));

      return `
        <div class="failed-trip" data-trip-id="${tripId}">
          <div class="failed-trip-select">
            <input type="checkbox" class="form-check-input" data-trip-id="${tripId}" ${isSelected ? "checked" : ""} />
          </div>
          <div class="failed-trip-info">
            <div class="failed-trip-date">${dateStr}</div>
            <div class="failed-trip-reason">
              <i class="fas fa-exclamation-circle"></i>
              <span>${reason}</span>
            </div>
          </div>
          <div class="failed-trip-actions">
            <button class="btn btn-ghost btn-sm mm-btn-retry" data-action="retry" data-trip-id="${tripId}" title="Retry matching">
              <i class="fas fa-redo"></i>
            </button>
            <button class="btn btn-ghost btn-sm text-danger" data-action="delete" data-trip-id="${tripId}" title="Delete trip">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  updateFailedSelectionUI();
}

function updateFailedSelectionUI() {
  const total = failedTripsData.length;
  const selectedCount = failedSelection.size;

  if (elements.failedSelectionCount) {
    elements.failedSelectionCount.textContent = `${selectedCount} selected`;
  }

  // Show/hide bulk actions
  if (elements.failedBulkActions) {
    elements.failedBulkActions.classList.toggle("d-none", selectedCount === 0);
  }

  if (elements.failedSelectAll) {
    const allSelected = total > 0 && selectedCount === total;
    elements.failedSelectAll.checked = allSelected;
    elements.failedSelectAll.indeterminate = selectedCount > 0 && !allSelected;
    elements.failedSelectAll.disabled = total === 0;
  }

  const disableActions = selectedCount === 0;
  if (elements.retrySelectedBtn) {
    elements.retrySelectedBtn.disabled = disableActions;
  }
  if (elements.deleteFailedSelectedBtn) {
    elements.deleteFailedSelectedBtn.disabled = disableActions;
  }
}

function setFailedSelection(tripId, checked) {
  if (!tripId) {
    return;
  }
  const normalized = String(tripId);
  if (checked) {
    failedSelection.add(normalized);
  } else {
    failedSelection.delete(normalized);
  }

  // Update checkbox in DOM
  const checkbox = elements.failedTrips?.querySelector(
    `input[data-trip-id="${tripId}"]`
  );
  if (checkbox) {
    checkbox.checked = checked;
  }

  updateFailedSelectionUI();
}

function selectAllFailed(checked) {
  failedSelection = new Set();
  if (checked) {
    failedTripsData.forEach((trip) => {
      if (trip.transactionId) {
        failedSelection.add(String(trip.transactionId));
      }
    });
  }

  // Update all checkboxes
  elements.failedTrips?.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = checked;
  });

  updateFailedSelectionUI();
}

async function retryMatchingTrips(tripIds) {
  if (!tripIds.length) {
    return;
  }

  try {
    setInlineStatus(elements.previewMapStatus, "Starting retry...", "info");

    const payload = {
      mode: "trip_ids",
      trip_ids: tripIds,
    };

    const result = await apiPost(CONFIG.API.mapMatchingJobs, payload);
    clearInlineStatus(elements.previewMapStatus);
    notificationManager.show(
      `Retrying ${tripIds.length} trip${tripIds.length !== 1 ? "s" : ""}`,
      "success"
    );

    if (result?.job_id) {
      startPolling(result.job_id);
      loadJobs();
    }
  } catch (error) {
    console.error("Failed to retry trips", error);
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
    notificationManager.show(error.message, "danger");
  }
}

async function loadFailedTripsCount() {
  try {
    const response = await apiGet(`${CONFIG.API.failedTrips}?limit=1`);
    const count = response?.total || 0;
    if (elements.failedCountBadge) {
      elements.failedCountBadge.textContent = count;
      elements.failedCountBadge.classList.toggle("d-none", count === 0);
    }
  } catch {
    // Ignore errors for count badge
  }
}

function focusMatchedPreviewTrip(tripId) {
  if (!tripId) {
    return;
  }
  matchedPreviewSelectedId = String(tripId);
  setFocusedTripUI(matchedPreviewSelectedId);
  const map = ensureMatchedPreviewMap();
  if (map?.getLayer("matched-preview-highlight")) {
    map.setFilter("matched-preview-highlight", [
      "==",
      ["get", "transactionId"],
      matchedPreviewSelectedId,
    ]);
  }
  const feature = matchedPreviewFeaturesById.get(matchedPreviewSelectedId);
  if (feature) {
    const bounds = buildBoundsFromGeojson({
      type: "FeatureCollection",
      features: [feature],
    });
    if (bounds) {
      map.fitBounds(bounds, { padding: 60, duration: 500 });
    }
  }
}

function getJobIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("job");
}

function findActiveJob(jobs) {
  if (!Array.isArray(jobs)) {
    return null;
  }
  return jobs.find((job) => job && !isTerminalStage(job.stage));
}

async function resumeFromJobs(jobs) {
  if (currentJobId) {
    return;
  }
  const active = findActiveJob(jobs);
  if (active?.job_id) {
    startPolling(active.job_id);
    return;
  }
  const storedJobId = getStoredJobId();
  if (storedJobId) {
    // Check if stored job is completed, go to results phase
    try {
      const job = await apiGet(CONFIG.API.mapMatchingJob(storedJobId));
      if (job && job.stage === "completed") {
        currentJobId = storedJobId;
        setPhase(PHASES.RESULTS);
        loadMatchedPreview(storedJobId, { silent: true });
        return;
      }
    } catch {
      // Ignore errors, just stay on select
    }
  }
  updateProgressUI(null);
}

export default async function initMapMatchingPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  cacheElements();
  resetState();

  if (!elements.form || !elements.modeSelect) {
    const teardown = () => {
      stopPolling();
      resetState();
      elements = {};
      pageSignal = null;
    };
    if (typeof cleanup === "function") {
      cleanup(teardown);
    } else {
      return teardown;
    }
    return;
  }

  // Initialize phase
  setPhase(PHASES.SELECT);
  setModeUI(elements.modeSelect.value);
  invalidatePreview();
  updateMatchedSelectionUI();
  wireEvents(signal);
  initDatePickers();

  // Initialize progress ring
  if (elements.progressRing) {
    elements.progressRing.style.strokeDasharray = PROGRESS_RING_CIRCUMFERENCE;
    elements.progressRing.style.strokeDashoffset = PROGRESS_RING_CIRCUMFERENCE;
  }

  const jobFromUrl = getJobIdFromURL();
  if (jobFromUrl) {
    // Check if job is completed or still processing
    try {
      const job = await apiGet(CONFIG.API.mapMatchingJob(jobFromUrl));
      if (job && job.stage === "completed") {
        currentJobId = jobFromUrl;
        setPhase(PHASES.RESULTS);
        loadMatchedPreview(jobFromUrl, { silent: true });
      } else if (job && !isTerminalStage(job.stage)) {
        startPolling(jobFromUrl);
      } else {
        // Failed/cancelled - show process phase with status
        currentJobId = jobFromUrl;
        setPhase(PHASES.PROCESS);
        updateProgressUI(job);
      }
    } catch {
      // If job not found, just start fresh
      setPhase(PHASES.SELECT);
    }
  }

  const jobs = await loadJobs();
  if (!jobFromUrl) {
    await resumeFromJobs(jobs);
  }

  // Load failed trips count for the badge
  loadFailedTripsCount();

  const teardown = () => {
    stopPolling();
    resetState();
    closeHistoryDrawer();
    elements = {};
    pageSignal = null;
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
}
