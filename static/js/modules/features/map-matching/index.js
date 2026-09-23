/**
 * Map Matching page controller: the select, progress, and results phases,
 * job polling and history, provider choice, and the failed-trips browser.
 * The matched-trips preview lives in preview.js, labels in labels.js, and
 * the page's elements and API client in context.js.
 */

import { updateUrlHistory } from "../../core/url-history.js";
import { CONFIG } from "../../core/config.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { DateUtils, escapeHtml } from "../../utils.js";
import { clearInlineStatus, setInlineStatus } from "../settings/status-utils.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  cacheElements,
  clearPageContext,
  elements,
  setPageContext,
} from "./context.js";
import {
  FRIENDLY_MESSAGES,
  formatAttemptSummary,
  formatFailureReason,
  formatFriendlyDate,
  formatSummaryCount,
  formatTripDate,
  isTerminalStage,
  normalizeMatchedTripsResponse,
  normalizeProviderPolicy,
  providerBadgeLabel,
  providerPolicyFallbackLabel,
} from "./labels.js";
import {
  clearFocusedTrip,
  clearSelection,
  destroyPreviewMap,
  focusMatchedPreviewTrip,
  matchedSelection,
  resetMatchedSelection,
  selectAllVisible,
  setSelection,
  updateMatchedPreviewEmptyState,
  updateMatchedPreviewMap,
  updateMatchedPreviewTable,
  updateMatchedSelectionUI,
} from "./preview.js";

// Phase state machine
const PHASES = {
  SELECT: "select",
  PROCESS: "process",
  RESULTS: "results",
};

let _currentPhase = PHASES.SELECT;

let currentJobId = null;
let _currentJobStage = null;
let pollTimer = null;
let previewSignature = null;
let previewPayload = null;
let lastAutoPreviewJobId = null;
let jobsPollTimer = null;
let selectedQuickPick = null;
let failedTripsData = [];
let failedSelection = new Set();
let mapboxFallbackAvailable = false;

// Result modes for the results phase
const RESULT_MODES = {
  JOB: "job", // Showing results from a specific job
  BROWSE_MATCHED: "browse_matched", // Browsing all matched trips
  BROWSE_FAILED: "browse_failed", // Browsing failed trips
};

let _currentResultMode = RESULT_MODES.JOB;

const LAST_JOB_STORAGE_KEY = "map_matching:last_job_id";
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * 42;

function getSelectedProviderPolicy() {
  const selected = document.querySelector('input[name="provider-policy"]:checked');
  return normalizeProviderPolicy(selected?.value);
}

function setProviderPolicy(policy) {
  const normalized = normalizeProviderPolicy(policy);
  const input = document.querySelector(
    `input[name="provider-policy"][value="${normalized}"]`
  );
  if (input) {
    input.checked = true;
    updateProviderPolicyUI();
  }
  return normalized;
}

function matchingEngineLabel(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value?.label) {
    return value.label;
  }
  return providerPolicyFallbackLabel(getSelectedProviderPolicy());
}

function updateEngineLabel(value) {
  const label = matchingEngineLabel(value);
  if (typeof value === "object" && value) {
    updateMapboxOnlyButton(Boolean(value.mapbox_available));
  }
  if (elements.engineLabel) {
    elements.engineLabel.textContent = label;
  }
  if (elements.progressEngine) {
    elements.progressEngine.textContent = label ? `Matching engine: ${label}` : "";
  }
}

function updateProviderPolicyUI() {
  const selected = getSelectedProviderPolicy();
  document.querySelectorAll(".mm-provider-choice").forEach((choice) => {
    const radio = choice.querySelector('input[type="radio"]');
    choice.classList.toggle("is-selected", radio?.value === selected);
  });
  updateEngineLabel(providerPolicyFallbackLabel(selected));
  invalidatePreview();
}

function updateMapboxOnlyButton(available) {
  mapboxFallbackAvailable = Boolean(available);
  if (!elements.mapboxOnlyBtn) {
    return;
  }
  elements.mapboxOnlyBtn.disabled = !mapboxFallbackAvailable;
  elements.mapboxOnlyBtn.title = mapboxFallbackAvailable
    ? "Run current selection with Mapbox only"
    : "Mapbox token missing";
}

function renderProviderSummary(summary = {}) {
  const setText = (element, value) => {
    if (element) {
      element.textContent = formatSummaryCount(value);
    }
  };

  setText(elements.summaryMatched, summary.matched);
  setText(elements.summaryValhalla, summary.valhalla_matched);
  setText(elements.summaryMapbox, summary.mapbox_matched);
  setText(elements.summaryFallback, summary.mapbox_fallback_matched);
  setText(elements.summaryFailed, summary.failed);
  setText(elements.summarySkipped, summary.skipped);
  if (summary.matching_engine && getSelectedProviderPolicy() === "auto") {
    updateEngineLabel(summary.matching_engine);
  } else {
    updateMapboxOnlyButton(Boolean(summary.matching_engine?.mapbox_available));
  }

  if (elements.summaryFoot) {
    const pending = formatSummaryCount(summary.pending);
    const untracked = formatSummaryCount(summary.untracked_matched);
    const mapboxOnly = formatSummaryCount(summary.mapbox_only_matched);
    elements.summaryFoot.textContent = `Pending ${pending} · Mapbox-only ${mapboxOnly} · No engine tag ${untracked}`;
  }
}

async function loadProviderSummary() {
  try {
    const summary = await apiGet(CONFIG.API.mapMatchingSummary);
    renderProviderSummary(summary || {});
    return summary;
  } catch (error) {
    console.error("Failed to load map matching summary", error);
    if (elements.summaryFoot) {
      elements.summaryFoot.textContent = "Summary unavailable";
    }
    return null;
  }
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

  document.querySelectorAll(".mm-phase-step").forEach((step) => {
    const stepPhase = step.dataset.phase;
    const stepIndex = phaseOrder.indexOf(stepPhase);

    step.classList.remove("is-active", "is-completed");

    if (stepIndex < currentIndex) {
      step.classList.add("is-completed");
    } else if (stepIndex === currentIndex) {
      step.classList.add("is-active");
    }
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
  updateUrlHistory(url.toString());
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

function resetState() {
  currentJobId = null;
  _currentJobStage = null;
  previewSignature = null;
  previewPayload = null;
  lastAutoPreviewJobId = null;
  resetMatchedSelection();
  selectedQuickPick = null;
  _currentPhase = PHASES.SELECT;
  _currentResultMode = RESULT_MODES.JOB;
  failedTripsData = [];
  failedSelection = new Set();
  mapboxFallbackAvailable = false;
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

function getSelectedMode() {
  const selected = document.querySelector('input[name="match-mode"]:checked');
  return selected?.value || "unmatched";
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

  invalidatePreview();
}

function updateProgressRing(pct) {
  if (!elements.progressRing) {
    return;
  }
  const offset =
    PROGRESS_RING_CIRCUMFERENCE - (pct / 100) * PROGRESS_RING_CIRCUMFERENCE;
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
  updateEngineLabel(metrics.matching_engine || progress.matching_engine);
  if (metrics.total != null && elements.progressMetrics) {
    const matchedCount = metrics.matched ?? metrics.map_matched ?? 0;
    const mapboxMetricLabel =
      normalizeProviderPolicy(metrics.provider_policy) === "mapbox_only"
        ? "Mapbox matched"
        : "Mapbox fallback matched";
    const parts = [
      `Valhalla matched ${metrics.valhalla_matched ?? matchedCount}`,
      `${mapboxMetricLabel} ${metrics.fallback_matched ?? metrics.mapbox_matched ?? 0}`,
      `Failed ${metrics.failed ?? 0}`,
      `Skipped ${metrics.skipped ?? 0}`,
    ];
    elements.progressMetrics.innerHTML = parts
      .map((part) => `<span class="mm-progress-metric-chip">${escapeHtml(part)}</span>`)
      .join("");
  } else if (elements.progressMetrics) {
    elements.progressMetrics.innerHTML = "";
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
    return null;
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
        loadProviderSummary();
        loadFailedTripsCount();
      } else if (
        data.stage === "failed" ||
        data.stage === "error" ||
        data.stage === "cancelled"
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
  updateUrlHistory(url.toString());
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
          const statusClass =
            status === "completed"
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
            message = "Matching trips to roads...";
          } else if (status === "queued") {
            message = "Waiting to start";
          }
          const metrics = job.metrics || {};
          const providerBadge = providerBadgeLabel(metrics);

          return `
            <div class="history-job" data-job-id="${job.job_id}">
              <div class="history-job-status ${statusClass}"></div>
              <div class="history-job-info">
                <div class="history-job-time">${escapeHtml(updated)}</div>
                <div class="history-job-message">${escapeHtml(message)}</div>
                <div class="history-job-provider">${escapeHtml(providerBadge)}</div>
              </div>
              <div class="history-job-progress">${escapeHtml(progress)}%</div>
              <div class="history-job-actions">
                <button class="btn btn-ghost btn-sm" data-action="view" data-job-id="${job.job_id}" title="View" aria-label="View job details">
                  <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-ghost btn-sm" data-action="preview" data-job-id="${job.job_id}" title="Show results" aria-label="Show job results" ${!isTerminal ? "disabled" : ""}>
                  <i class="fas fa-map"></i>
                </button>
                <button class="btn btn-ghost btn-sm text-danger" data-action="cancel" data-job-id="${job.job_id}" title="Cancel" aria-label="Cancel job" ${!canCancel ? "disabled" : ""}>
                  <i class="fas fa-stop"></i>
                </button>
                <button class="btn btn-ghost btn-sm" data-action="delete" data-job-id="${job.job_id}" title="Remove" aria-label="Remove job" ${!isTerminal ? "disabled" : ""}>
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }
}

function buildPayload({ providerPolicyOverride = null } = {}) {
  const mode = getSelectedMode();
  const provider_policy = normalizeProviderPolicy(
    providerPolicyOverride || getSelectedProviderPolicy()
  );
  if (mode === "unmatched") {
    return { mode: "unmatched", provider_policy };
  }

  if (mode === "trip_id") {
    const tripId = elements.tripIdInput?.value.trim();
    if (!tripId) {
      throw new Error("Trip ID is required");
    }
    return { mode: "trip_id", trip_id: tripId, provider_policy };
  }

  const unmatchedOnly = Boolean(elements.unmatchedOnly?.checked);

  // Check if using quick pick interval
  if (selectedQuickPick) {
    return {
      mode: "date_range",
      interval_days: selectedQuickPick,
      unmatched_only: unmatchedOnly,
      provider_policy,
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
    provider_policy,
  };
}

function invalidatePreview() {
  previewSignature = null;
  previewPayload = null;
  clearInlineStatus(elements.previewStatus);
  clearInlineStatus(elements.submitStatus);
  elements.previewPanel?.classList.add("d-none");
  if (elements.previewSummary) {
    elements.previewSummary.textContent = "";
  }
}

function renderPreview(data) {
  if (!data || !elements.previewPanel) {
    return;
  }
  updateEngineLabel(data.matching_engine);

  const total = data.total || 0;
  if (total === 0) {
    if (elements.previewSummary) {
      elements.previewSummary.textContent = "No trips found for this selection";
    }
  } else if (elements.previewSummary) {
    elements.previewSummary.textContent = `${total} trip${total !== 1 ? "s" : ""} ready to match`;
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

async function submitMapMatchingPayload(payload) {
  setInlineStatus(elements.submitStatus, "Starting...", "info");
  const result = await apiPost(CONFIG.API.mapMatchingJobs, payload);
  clearInlineStatus(elements.submitStatus);
  notificationManager.show("Map matching started!", "success");
  if (result?.job_id) {
    startPolling(result.job_id);
    loadJobs();
  }
  return result;
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

    await submitMapMatchingPayload(payload);
  } catch (error) {
    setInlineStatus(elements.submitStatus, error.message, "danger");
    notificationManager.show(error.message, "danger");
  }
}

async function submitMapboxOnlySelection() {
  clearInlineStatus(elements.submitStatus);
  if (!mapboxFallbackAvailable) {
    const message = "Mapbox token missing";
    setInlineStatus(elements.submitStatus, message, "warning");
    notificationManager.show(message, "warning");
    return;
  }
  try {
    setProviderPolicy("mapbox_only");
    const payload = buildPayload({ providerPolicyOverride: "mapbox_only" });
    await submitMapMatchingPayload(payload);
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

  document.querySelectorAll('input[name="match-mode"]').forEach((input) => {
    input.addEventListener(
      "change",
      () => {
        if (input.checked) {
          setModeUI(input.value);
        }
      },
      eventOptions
    );
  });

  document.querySelectorAll('input[name="provider-policy"]').forEach((input) => {
    input.addEventListener("change", updateProviderPolicyUI, eventOptions);
  });

  elements.mapboxOnlyBtn?.addEventListener(
    "click",
    submitMapboxOnlySelection,
    eventOptions
  );

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
          document.querySelectorAll(".mm-quick-pick").forEach((b) => {
            b.classList.remove("is-active");
          });
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
    elements.startInput,
    elements.endInput,
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
  DateUtils.initDatePicker(".datepicker");
}

async function clearMatchedTrips(tripIds, { silent = false } = {}) {
  if (!tripIds.length) {
    return;
  }

  const confirmed = await confirmationDialog.show({
    title: "Remove match",
    message:
      "This keeps your trip but removes the map match. You can match it again later.",
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
      notificationManager.show("Match removed", "success");
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
    clearFocusedTrip();
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

async function browseMatchedTrips({ silent = false } = {}) {
  setPhase(PHASES.RESULTS);
  setResultMode(RESULT_MODES.BROWSE_MATCHED);

  clearInlineStatus(elements.previewMapStatus);
  clearInlineStatus(elements.previewActionsStatus);

  try {
    clearFocusedTrip();
    resetMatchedSelection();

    if (!silent) {
      setInlineStatus(elements.previewMapStatus, "Loading matched trips...", "info");
    }

    // Fetch all matched trips
    const response = await apiGet(`${CONFIG.API.matchedTrips}?limit=100`);
    const { trips, geojson, total } = normalizeMatchedTripsResponse(response);
    const summaryCount = typeof total === "number" ? total : trips.length;

    // Update summary
    if (elements.browseSummary) {
      elements.browseSummary.textContent =
        summaryCount > 0
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
    const total = Number(response?.total ?? trips.length);
    failedTripsData = trips;

    // Update summary
    if (elements.failedSummary) {
      elements.failedSummary.textContent =
        total > 0
          ? `${total} trip${total !== 1 ? "s" : ""} with issues`
          : "No failed trips";
    }

    // Update count badge
    if (elements.failedCountBadge) {
      elements.failedCountBadge.textContent = total;
      elements.failedCountBadge.classList.toggle("d-none", total === 0);
    }

    // Render failed trips list
    renderFailedTrips(trips, total);

    // Update map - show empty state for failed trips
    updateMatchedPreviewEmptyState("Select trips to retry matching");

    clearInlineStatus(elements.previewMapStatus);
  } catch (error) {
    console.error("Failed to load failed trips", error);
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
  }
}

function renderFailedTrips(trips, total = trips.length) {
  if (!elements.failedTrips) {
    return;
  }

  // Update count
  if (elements.failedListCount) {
    elements.failedListCount.textContent =
      total > 0
        ? `${trips.length} of ${total} trip${total !== 1 ? "s" : ""} with issues`
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
      const attemptSummary = formatAttemptSummary(trip.matchAttemptSummary);
      const isSelected = failedSelection.has(String(tripId));

      return `
        <div class="failed-trip" data-trip-id="${escapeHtml(tripId)}">
          <div class="failed-trip-select">
            <input type="checkbox" class="form-check-input" data-trip-id="${escapeHtml(tripId)}" ${isSelected ? "checked" : ""} />
          </div>
          <div class="failed-trip-info">
            <div class="failed-trip-date">${escapeHtml(dateStr)}</div>
            <div class="failed-trip-reason">
              <i class="fas fa-exclamation-circle"></i>
              <span>${escapeHtml(reason)}</span>
            </div>
            ${
              attemptSummary
                ? `<div class="failed-trip-attempts">${escapeHtml(attemptSummary)}</div>`
                : ""
            }
          </div>
          <div class="failed-trip-actions">
            <button class="btn btn-ghost btn-sm" data-action="retry" data-trip-id="${escapeHtml(tripId)}" title="Retry matching" aria-label="Retry trip matching">
              <i class="fas fa-redo"></i>
            </button>
            <button class="btn btn-ghost btn-sm text-danger" data-action="delete" data-trip-id="${escapeHtml(tripId)}" title="Delete trip" aria-label="Delete trip">
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
      provider_policy: getSelectedProviderPolicy(),
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

export default async function initMapMatchingPage({ signal, cleanup, api } = {}) {
  setPageContext({ signal, api });
  cacheElements();
  resetState();

  if (!elements.form) {
    const teardown = () => {
      stopPolling();
      resetState();
      clearPageContext();
    };
    if (typeof cleanup === "function") {
      cleanup(teardown);
    } else {
      return teardown;
    }
    return teardown;
  }

  // Initialize phase
  setPhase(PHASES.SELECT);
  setModeUI(getSelectedMode());
  updateEngineLabel(providerPolicyFallbackLabel(getSelectedProviderPolicy()));
  updateMapboxOnlyButton(false);
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
  loadProviderSummary();
  loadFailedTripsCount();

  const teardown = () => {
    stopPolling();
    resetState();
    closeHistoryDrawer();
    clearPageContext();
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}
