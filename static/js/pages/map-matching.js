/* global mapboxgl */

import apiClient from "../modules/core/api-client.js";
import { CONFIG } from "../modules/core/config.js";
import mapBase from "../modules/map-base.js";
import notificationManager from "../modules/ui/notifications.js";
import confirmationDialog from "../modules/ui/confirmation-dialog.js";
import { DateUtils } from "../modules/utils.js";
import { clearInlineStatus, setInlineStatus } from "../settings/status-utils.js";

const elements = {
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
  previewUnmatchSelected: document.getElementById("map-match-preview-unmatch-selected"),
  previewDeleteSelected: document.getElementById("map-match-preview-delete-selected"),
  previewActionsStatus: document.getElementById("map-match-preview-actions-status"),
  advancedToggle: document.getElementById("map-match-advanced-toggle"),
  advancedOptions: document.getElementById("map-match-advanced-options"),
  resultsTrips: document.getElementById("map-match-results-trips"),
  resultsCount: document.getElementById("map-match-results-count"),
  bulkActions: document.getElementById("map-match-bulk-actions"),
};

let currentJobId = null;
let currentJobStage = null;
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
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else if (days === 1) {
    return "Yesterday";
  } else if (days < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatTripDate(startTime, endTime) {
  if (!startTime) return "Unknown date";
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
  elements.dateControls.classList.toggle("d-none", !isDate);
  elements.tripControls.classList.toggle("d-none", !isTrip);

  // Update selection cards
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
  if (!elements.progressRing) return;
  const offset = PROGRESS_RING_CIRCUMFERENCE - (pct / 100) * PROGRESS_RING_CIRCUMFERENCE;
  elements.progressRing.style.strokeDashoffset = offset;
}

function updateProgressUI(progress) {
  if (!progress) {
    elements.currentPanel.classList.add("d-none");
    elements.currentEmpty.classList.remove("d-none");
    currentJobStage = null;
    if (elements.cancelBtn) {
      elements.cancelBtn.classList.add("d-none");
      elements.cancelBtn.disabled = true;
    }
    return;
  }

  elements.currentPanel.classList.remove("d-none");
  elements.currentEmpty.classList.add("d-none");
  currentJobStage = progress.stage || null;

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
  elements.progressMessage.textContent = friendlyMsg;

  if (elements.cancelBtn) {
    const canCancel = !isTerminalStage(stage);
    elements.cancelBtn.classList.toggle("d-none", !canCancel);
    elements.cancelBtn.disabled = !canCancel;
  }

  // Simplified metrics
  const metrics = progress.metrics || {};
  if (metrics.total != null) {
    const matchedCount = metrics.matched ?? metrics.map_matched ?? 0;
    const processed = metrics.processed ?? 0;
    elements.progressMetrics.textContent = `${matchedCount} of ${metrics.total} trips improved`;
  } else {
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
    const data = await apiClient.get(CONFIG.API.mapMatchingJob(jobId));
    updateProgressUI(data);
    if (isTerminalStage(data.stage)) {
      stopPolling();
    }
    if (data.stage === "completed" && jobId && lastAutoPreviewJobId !== jobId) {
      lastAutoPreviewJobId = jobId;
      loadMatchedPreview(jobId, { silent: true });
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
    const data = await apiClient.get(CONFIG.API.mapMatchingJobs);
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
  }

  // Render as cards in the new UI
  if (elements.jobsList) {
    if (jobs.length === 0) {
      elements.jobsList.innerHTML = `
        <div class="history-empty" style="padding: var(--space-4); text-align: center; color: var(--text-tertiary); font-size: var(--font-size-sm);">
          No recent activity
        </div>
      `;
    } else {
      elements.jobsList.innerHTML = jobs
        .map((job) => {
          const status = job.stage || "unknown";
          const progress = job.progress ?? 0;
          const updated = formatFriendlyDate(job.updated_at);
          const isTerminal = isTerminalStage(status);
          const statusClass = status === "completed" ? "is-completed" :
            status === "cancelled" ? "is-cancelled" :
              (status === "processing" || status === "queued") ? "is-processing" : "is-failed";
          const canCancel = !isTerminal;

          // Friendly status message
          let message = job.message || "";
          if (status === "completed") {
            const metrics = job.metrics || {};
            const matched = metrics.matched ?? metrics.map_matched ?? 0;
            message = `${matched} trips improved`;
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
  const mode = elements.modeSelect.value;
  if (mode === "unmatched") {
    return { mode: "unmatched" };
  }

  if (mode === "trip_id") {
    const tripId = elements.tripIdInput.value.trim();
    if (!tripId) {
      throw new Error("Trip ID is required");
    }
    return { mode: "trip_id", trip_id: tripId };
  }

  const unmatchedOnly = Boolean(elements.unmatchedOnly.checked);

  // Check if using quick pick interval
  if (selectedQuickPick) {
    return {
      mode: "date_range",
      interval_days: selectedQuickPick,
      unmatched_only: unmatchedOnly,
    };
  }

  // Custom date range
  const start = elements.startInput.value.trim();
  const end = elements.endInput.value.trim();
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
  // Don't disable submit button - allow direct submission
}

function renderPreview(data) {
  if (!data || !elements.previewPanel) {
    return;
  }

  const total = data.total || 0;
  const sample = data.sample || [];
  if (total === 0) {
    elements.previewSummary.textContent = "No trips found for this selection.";
  } else {
    elements.previewSummary.textContent = `Found ${total} trip${total !== 1 ? "s" : ""} to improve`;
  }

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

  elements.previewPanel.classList.remove("d-none");
}

async function previewTrips() {
  clearInlineStatus(elements.previewStatus);
  try {
    const payload = buildPayload();
    const signature = JSON.stringify(payload);
    setInlineStatus(elements.previewStatus, "Loading preview...", "info");
    const response = await apiClient.post(
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
    const result = await apiClient.post(CONFIG.API.mapMatchingJobs, payload);
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

function wireEvents() {
  if (!elements.form) {
    return;
  }

  // Selection cards
  document.querySelectorAll(".selection-card").forEach((card) => {
    card.addEventListener("click", () => {
      const mode = card.dataset.mode;
      if (mode) {
        setModeUI(mode);
      }
    });
  });

  // Quick pick buttons
  document.querySelectorAll(".quick-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const days = parseInt(btn.dataset.days, 10);
      selectedQuickPick = days;

      // Clear custom date inputs
      if (elements.startInput) elements.startInput.value = "";
      if (elements.endInput) elements.endInput.value = "";

      // Update button states
      document.querySelectorAll(".quick-pick-btn").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });

      // Update legacy selects for compatibility
      if (elements.dateModeSelect) elements.dateModeSelect.value = "interval";
      if (elements.intervalSelect) elements.intervalSelect.value = String(days);

      invalidatePreview();
    });
  });

  // Custom date inputs clear quick pick
  [elements.startInput, elements.endInput].forEach((input) => {
    if (input) {
      input.addEventListener("change", () => {
        selectedQuickPick = null;
        document.querySelectorAll(".quick-pick-btn").forEach((b) => {
          b.classList.remove("is-active");
        });
        if (elements.dateModeSelect) elements.dateModeSelect.value = "date";
        invalidatePreview();
      });
    }
  });

  // Advanced toggle
  elements.advancedToggle?.addEventListener("click", () => {
    const isOpen = elements.advancedOptions?.classList.toggle("d-none") === false;
    elements.advancedToggle.classList.toggle("is-open", isOpen);
  });

  // History toggle (collapse/expand)
  elements.historyToggle?.addEventListener("click", (e) => {
    // Don't toggle if clicking on action buttons
    if (e.target.closest("button")) return;
    const historyWidget = elements.historyToggle.closest(".map-matching-history");
    historyWidget?.classList.toggle("is-collapsed");
  });

  // History job actions
  elements.jobsList?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const jobId = btn.dataset.jobId;

    if (action === "view" && jobId) {
      startPolling(jobId);
    } else if (action === "preview" && jobId) {
      startPolling(jobId);
      loadMatchedPreview(jobId);
    } else if (action === "cancel" && jobId) {
      cancelJob(jobId);
    } else if (action === "delete" && jobId) {
      deleteJobHistory(jobId);
    }
  });

  // Legacy support
  elements.modeSelect?.addEventListener("change", (e) => {
    setModeUI(e.target.value);
  });

  elements.dateModeSelect?.addEventListener("change", (e) => {
    setDateModeUI(e.target.value);
  });

  elements.form.addEventListener("submit", submitForm);
  elements.previewBtn?.addEventListener("click", previewTrips);
  elements.previewMapBtn?.addEventListener("click", () => {
    loadMatchedPreview(currentJobId);
  });

  elements.cancelBtn?.addEventListener("click", () => {
    cancelJob(currentJobId);
  });

  elements.refreshBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    loadJobs();
  });

  elements.historyClearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearHistory();
  });

  elements.previewSelectAll?.addEventListener("change", (event) => {
    selectAllVisible(event.target.checked);
  });

  elements.previewClearSelection?.addEventListener("click", () => {
    clearSelection();
  });

  elements.previewUnmatchSelected?.addEventListener("click", () => {
    clearMatchedTrips(Array.from(matchedSelection));
  });

  elements.previewDeleteSelected?.addEventListener("click", () => {
    deleteTrips(Array.from(matchedSelection));
  });

  // Legacy table events
  elements.jobsBody?.addEventListener("click", (event) => {
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
        startPolling(jobId);
        loadMatchedPreview(jobId);
      }
      return;
    }
    if (!button) {
      return;
    }
    const jobId = button.dataset.jobId;
    if (jobId) {
      startPolling(jobId);
    }
  });

  // Results trip cards
  elements.resultsTrips?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      const tripId = actionButton.dataset.tripId;
      const action = actionButton.dataset.action;
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
      const tripId = card.dataset.tripId;
      focusMatchedPreviewTrip(tripId);
    }
  });

  // Legacy table for matched preview
  elements.previewMapBody?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      const tripId = actionButton.dataset.tripId;
      const action = actionButton.dataset.action;
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
    const tripId = row.dataset.tripId;
    focusMatchedPreviewTrip(tripId);
  });

  elements.previewMapBody?.addEventListener("change", (event) => {
    const checkbox = event.target.closest(".matched-preview-select");
    if (!checkbox) {
      return;
    }
    setSelection(checkbox.dataset.tripId, checkbox.checked);
  });

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
    el.addEventListener("input", invalidatePreview);
    el.addEventListener("change", invalidatePreview);
  });
}

function initDatePickers() {
  if (DateUtils?.initDatePicker) {
    DateUtils.initDatePicker(".datepicker");
  } else if (typeof flatpickr !== "undefined") {
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
  const widget = elements.previewMap.closest(".map-matching-preview");
  if (!widget) {
    return CONFIG.LAYER_DEFAULTS.matchedTrips.color;
  }
  const color = getComputedStyle(widget).getPropertyValue("--matched-preview-color");
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
    const content = elements.previewMapEmpty.querySelector(".empty-map-content span");
    if (content) content.textContent = message;
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
    elements.previewMapBody
      .querySelectorAll("tr[data-trip-id]")
      .forEach((row) => {
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
    elements.previewMapBody
      .querySelectorAll("tr[data-trip-id]")
      .forEach((row) => {
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
  const highlightColor = CONFIG.LAYER_DEFAULTS.matchedTrips.highlightColor;

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
      elements.previewMapSummary.textContent = `${total} improved trip${total !== 1 ? "s" : ""}`;
    } else {
      elements.previewMapSummary.textContent = "No improved trips yet";
    }
  }

  // Update results count
  if (elements.resultsCount) {
    elements.resultsCount.textContent = total > 0 ? `${total} trip${total !== 1 ? "s" : ""}` : "No trips yet";
  }

  if (!total) {
    updateMatchedPreviewEmptyState("No improved trips yet");
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
      "This keeps your trip but removes the route improvement. You can re-improve it later.",
    confirmText: "Remove",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Removing...", "info");
    if (tripIds.length === 1) {
      await apiClient.delete(CONFIG.API.matchedTripById(tripIds[0]));
    } else {
      await apiClient.post(CONFIG.API.matchedTripsBulkUnmatch, {
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
    message:
      "This permanently deletes the trips and cannot be undone. Are you sure?",
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Deleting...", "info");
    if (tripIds.length === 1) {
      await apiClient.delete(CONFIG.API.tripById(tripIds[0]));
    } else {
      await apiClient.post(CONFIG.API.tripsBulkDelete, {
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
      "Stop this job? Trips already improved will remain, and remaining trips will be skipped.",
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
    const response = await apiClient.post(CONFIG.API.mapMatchingJobCancel(jobId));
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
    message:
      "Remove this from your activity list? Running jobs will continue.",
    confirmText: "Remove",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.historyStatus, "Removing...", "info");
    await apiClient.delete(CONFIG.API.mapMatchingJob(jobId));
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
    const response = await apiClient.delete(
      `${CONFIG.API.mapMatchingJobs}?include_active=false`
    );
    await loadJobs();
    clearInlineStatus(elements.historyStatus);
    const deleted = response?.deleted ?? 0;
    if (deleted > 0) {
      notificationManager.show(`Cleared ${deleted} completed job${deleted !== 1 ? "s" : ""}`, "success");
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

  clearInlineStatus(elements.previewMapStatus);
  clearInlineStatus(elements.previewActionsStatus);
  try {
    matchedPreviewSelectedId = null;
    setFocusedTripUI(null);
    if (!silent) {
      setInlineStatus(elements.previewMapStatus, "Loading...", "info");
    }
    const response = await apiClient.get(CONFIG.API.mapMatchingJobMatches(jobId));
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

function focusMatchedPreviewTrip(tripId) {
  if (!tripId) {
    return;
  }
  matchedPreviewSelectedId = String(tripId);
  setFocusedTripUI(matchedPreviewSelectedId);
  const map = ensureMatchedPreviewMap();
  if (map && map.getLayer("matched-preview-highlight")) {
    map.setFilter("matched-preview-highlight", [
      "==",
      ["get", "transactionId"],
      matchedPreviewSelectedId,
    ]);
  }
  const feature = matchedPreviewFeaturesById.get(matchedPreviewSelectedId);
  if (feature) {
    const bounds = buildBoundsFromGeojson({ type: "FeatureCollection", features: [feature] });
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
    startPolling(storedJobId);
    return;
  }
  updateProgressUI(null);
}

async function init() {
  if (!elements.form || !elements.modeSelect) {
    return;
  }
  setModeUI(elements.modeSelect.value);
  invalidatePreview();
  updateMatchedSelectionUI();
  wireEvents();
  initDatePickers();

  // Initialize progress ring
  if (elements.progressRing) {
    elements.progressRing.style.strokeDasharray = PROGRESS_RING_CIRCUMFERENCE;
    elements.progressRing.style.strokeDashoffset = PROGRESS_RING_CIRCUMFERENCE;
  }

  const jobFromUrl = getJobIdFromURL();
  if (jobFromUrl) {
    startPolling(jobFromUrl);
  }
  const jobs = await loadJobs();
  if (!jobFromUrl) {
    await resumeFromJobs(jobs);
  }
}

init();
