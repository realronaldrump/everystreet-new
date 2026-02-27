/* global bootstrap */

import apiClient from "../core/api-client.js";
import notificationManager from "./notifications.js";

/**
 * Global Job Tracker — SSE-powered with polling fallback.
 *
 * Renders an interactive multi-stage pipeline tracker that shows
 * real-time progress, live metrics, and stage-by-stage timing.
 */

const JOB_TRACKER_STORAGE_KEY = "coverage.activeJob";
const JOB_POLL_INTERVAL_MS = 2000;
const API_BASE = "/api/coverage";

// Pipeline stage definitions (must match backend STAGES order)
const PIPELINE_STAGES = [
  {
    key: "boundary",
    label: "Boundary",
    icon: "fa-map-marker-alt",
    description: "Resolving area boundary",
  },
  {
    key: "graph",
    label: "Street Network",
    icon: "fa-project-diagram",
    description: "Loading roads from OpenStreetMap",
  },
  {
    key: "segmenting",
    label: "Segmenting",
    icon: "fa-cut",
    description: "Breaking streets into segments",
  },
  {
    key: "storing",
    label: "Database",
    icon: "fa-database",
    description: "Saving segments",
  },
  {
    key: "statistics",
    label: "Statistics",
    icon: "fa-chart-bar",
    description: "Calculating coverage stats",
  },
  {
    key: "backfill",
    label: "Trip Matching",
    icon: "fa-route",
    description: "Matching historical trips",
  },
];

// State
let activeJob = null;
let eventSource = null;
let pollTimeout = null;
let stageMetrics = {};
let activeStageKey = null;
let completedStages = new Set();
let stageStartTimes = {};
let stageElapsedIntervalId = null;
let pipelineStartTime = null;

function notify(message, type) {
  notificationManager.show(message, type);
}

// =============================================================================
// Initialization
// =============================================================================

function initGlobalJobTracker() {
  setupGlobalUI();
  resumeJobTracking();
}

function setupGlobalUI() {
  const badgeEl = document.getElementById("minimized-progress-badge");
  const modalEl = document.getElementById("taskProgressModal");

  badgeEl?.addEventListener("click", restoreJobModal);
  modalEl?.addEventListener("hide.bs.modal", () => releaseModalFocus(modalEl));

  document.addEventListener("coverage:job-started", (e) => {
    if (e.detail?.jobId) {
      startGlobalTracking(e.detail);
    }
  });
}

// =============================================================================
// Job Management
// =============================================================================

function saveJobState() {
  if (activeJob) {
    localStorage.setItem(JOB_TRACKER_STORAGE_KEY, JSON.stringify(activeJob));
  } else {
    localStorage.removeItem(JOB_TRACKER_STORAGE_KEY);
  }
}

function loadJobState() {
  const stored = localStorage.getItem(JOB_TRACKER_STORAGE_KEY);
  return stored ? JSON.parse(stored) : null;
}

async function resumeJobTracking() {
  const stored = loadJobState();
  if (stored?.jobId) {
    try {
      const job = await fetchJobStatus(stored.jobId);
      if (isJobActive(job.status)) {
        activeJob = { ...stored, ...mapJobToState(job) };
        saveJobState();

        if (activeJob.minimized) {
          showMinimizedBadge();
        } else {
          renderProgressModal();
          showProgressModal();
        }

        connectSSE(activeJob.jobId);
      } else {
        handleJobFinished(job);
      }
    } catch (e) {
      console.warn("Failed to resume active job", e);
      clearJobState();
    }
  }
}

function startGlobalTracking(config) {
  activeJob = {
    jobId: config.jobId,
    jobType: config.jobType || "unknown",
    areaId: config.areaId,
    areaName: config.areaName,
    message: config.initialMessage || "Starting…",
    progress: 0,
    status: "pending",
    minimized: false,
  };

  // Reset stage tracking
  stageMetrics = {};
  activeStageKey = null;
  completedStages = new Set();
  stageStartTimes = {};
  pipelineStartTime = Date.now();

  saveJobState();
  renderProgressModal();
  showProgressModal();
  connectSSE(activeJob.jobId);
}

function stopTracking() {
  disconnectSSE();
  clearTimeout(pollTimeout);
  clearInterval(stageElapsedIntervalId);
  activeJob = null;
  stageMetrics = {};
  activeStageKey = null;
  completedStages = new Set();
  stageStartTimes = {};
  pipelineStartTime = null;
  saveJobState();
  hideProgressModal();
  hideMinimizedBadge();
}

function clearJobState() {
  activeJob = null;
  localStorage.removeItem(JOB_TRACKER_STORAGE_KEY);
}

// =============================================================================
// SSE Connection (primary) with polling fallback
// =============================================================================

function connectSSE(jobId) {
  disconnectSSE();

  try {
    const url = `${API_BASE}/jobs/${jobId}/stream`;
    eventSource = new EventSource(url);

    eventSource.addEventListener("snapshot", (e) => {
      const data = JSON.parse(e.data);
      handleProgressEvent(data);
    });

    eventSource.addEventListener("progress", (e) => {
      const data = JSON.parse(e.data);
      handleProgressEvent(data);
    });

    eventSource.addEventListener("stage", (e) => {
      const data = JSON.parse(e.data);
      handleStageTransition(data);
    });

    eventSource.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      handleDoneEvent(data);
    });

    eventSource.addEventListener("heartbeat", () => {});

    eventSource.addEventListener("timeout", () => {
      disconnectSSE();
      startPolling(jobId);
    });

    eventSource.onerror = () => {
      console.warn("SSE connection lost, falling back to polling");
      disconnectSSE();
      startPolling(jobId);
    };
  } catch {
    console.warn("SSE unavailable, using polling");
    startPolling(jobId);
  }
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleProgressEvent(data) {
  if (!activeJob) return;

  if (data.stage && data.stage !== activeStageKey) {
    handleStageTransition(data);
  }

  if (data.progress != null) activeJob.progress = data.progress;
  if (data.message) activeJob.message = data.message;
  if (data.status) activeJob.status = data.status;
  if (data.stage) activeJob.stage = data.stage;

  if (data.metrics && data.stage) {
    stageMetrics[data.stage] = {
      ...(stageMetrics[data.stage] || {}),
      ...data.metrics,
    };
  }

  saveJobState();
  updateUI();
}

function handleStageTransition(data) {
  if (!activeJob) return;

  const newStage = data.stage;
  if (!newStage) return;

  // Mark previous stage as completed
  if (activeStageKey && activeStageKey !== newStage) {
    completedStages.add(activeStageKey);
    if (stageStartTimes[activeStageKey]) {
      const elapsed = Date.now() - stageStartTimes[activeStageKey];
      stageMetrics[activeStageKey] = {
        ...(stageMetrics[activeStageKey] || {}),
        elapsed_ms: elapsed,
      };
    }
  }

  activeStageKey = newStage;
  stageStartTimes[newStage] = Date.now();

  if (data.progress != null) activeJob.progress = data.progress;
  if (data.message) activeJob.message = data.message;

  saveJobState();
  updateUI();
}

function handleDoneEvent(data) {
  if (!activeJob) return;

  // Mark all stages complete
  if (activeStageKey) {
    completedStages.add(activeStageKey);
  }

  activeJob.status = data.status || "completed";
  activeJob.progress = 100;
  activeJob.result = data.result || null;

  updateUI();

  const success = data.status === "completed";

  // Brief delay so the user sees 100%
  setTimeout(() => {
    stopTracking();

    const title = getJobTitle(activeJob?.jobType);
    if (success) {
      const result = data.result || {};
      const miles = result.total_miles ? ` (${result.total_miles} mi)` : "";
      const segs = result.segments_total
        ? ` — ${result.segments_total.toLocaleString()} segments`
        : "";
      const dur = result.pipeline_duration_ms
        ? ` in ${formatDuration(result.pipeline_duration_ms)}`
        : "";
      notify(`${title} completed${dur}${segs}${miles}`, "success");
    } else {
      notify(
        `${title} ${data.status}: ${data.error || data.message || "Unknown error"}`,
        "danger"
      );
    }

    document.dispatchEvent(
      new CustomEvent("coverage:job-finished", {
        detail: { job: data, success },
      })
    );
  }, 800);
}

// =============================================================================
// Polling fallback
// =============================================================================

function startPolling(jobId) {
  clearTimeout(pollTimeout);
  let errorCount = 0;
  const MAX_POLL_ERRORS = 5;

  const poll = async () => {
    if (!activeJob || activeJob.jobId !== jobId) return;

    try {
      const job = await fetchJobStatus(jobId);
      errorCount = 0;

      const prevStage = activeJob.stage;
      activeJob = { ...activeJob, ...mapJobToState(job) };

      if (job.stage && job.stage !== prevStage) {
        handleStageTransition({ stage: job.stage, progress: job.progress });
      }

      saveJobState();

      if (isJobActive(job.status)) {
        updateUI();
        pollTimeout = setTimeout(poll, JOB_POLL_INTERVAL_MS);
      } else {
        handleDoneEvent({
          status: job.status,
          result: job.result,
          error: job.error,
          message: job.message,
        });
      }
    } catch (e) {
      errorCount++;
      if (e?.status === 404 || errorCount >= MAX_POLL_ERRORS) {
        stopTracking();
        return;
      }
      const backoff = JOB_POLL_INTERVAL_MS * 2 ** errorCount;
      pollTimeout = setTimeout(poll, Math.min(backoff, 30000));
    }
  };

  poll();
}

function fetchJobStatus(jobId) {
  return apiClient.get(`${API_BASE}/jobs/${jobId}`);
}

// =============================================================================
// Actions
// =============================================================================

async function cancelActiveJob() {
  if (!activeJob) return;
  const { jobId } = activeJob;

  try {
    await apiClient.delete(`${API_BASE}/jobs/${jobId}`);
    stopTracking();
    notify("Job cancelled", "info");
    document.dispatchEvent(
      new CustomEvent("coverage:job-cancelled", { detail: { jobId } })
    );
  } catch (e) {
    console.error("Failed to cancel job:", e);
    notify("Failed to cancel job", "danger");
  }
}

function minimizeJob() {
  if (!activeJob) return;
  activeJob.minimized = true;
  saveJobState();
  hideProgressModal();
  showMinimizedBadge();
}

function restoreJobModal() {
  if (!activeJob) return;
  activeJob.minimized = false;
  saveJobState();
  hideMinimizedBadge();
  renderProgressModal();
  showProgressModal();
}

function handleJobFinished(job) {
  stopTracking();

  const success = job.status === "completed";
  const title = getJobTitle(job.job_type);
  const msg = success
    ? "completed successfully"
    : `failed: ${job.error || job.message}`;

  notify(`${title} ${msg}`, success ? "success" : "danger");

  document.dispatchEvent(
    new CustomEvent("coverage:job-finished", {
      detail: { job, success },
    })
  );
}

// =============================================================================
// UI Rendering
// =============================================================================

function renderProgressModal() {
  const body = document.querySelector("#taskProgressModal .modal-body");
  if (!body) return;

  const areaName = activeJob?.areaName || "Coverage Area";
  const jobTitle = getJobTitle(activeJob?.jobType);

  body.innerHTML = `
    <div class="pipeline-tracker">
      <div class="pipeline-header">
        <div class="pipeline-overall">
          <div class="pipeline-progress-bar">
            <div class="pipeline-progress-fill" style="width: 0%"></div>
          </div>
          <div class="pipeline-progress-label">
            <span class="pipeline-pct">0%</span>
            <span class="pipeline-elapsed"></span>
          </div>
        </div>
      </div>
      <div class="pipeline-stages">
        ${PIPELINE_STAGES.map(
          (s, i) => `
          <div class="pipeline-stage is-pending" data-stage="${s.key}" data-index="${i}">
            <div class="pipeline-stage-indicator">
              <div class="pipeline-stage-dot">
                <i class="fas ${s.icon}"></i>
              </div>
              ${i < PIPELINE_STAGES.length - 1 ? '<div class="pipeline-stage-line"></div>' : ""}
            </div>
            <div class="pipeline-stage-content">
              <div class="pipeline-stage-header">
                <span class="pipeline-stage-label">${s.label}</span>
                <span class="pipeline-stage-time"></span>
              </div>
              <div class="pipeline-stage-description">${s.description}</div>
              <div class="pipeline-stage-metrics"></div>
            </div>
          </div>
        `
        ).join("")}
      </div>
      <div class="pipeline-message" id="pipeline-live-message"></div>
    </div>
  `;

  // Update modal title
  const titleEl = document.getElementById("task-progress-title");
  if (titleEl) titleEl.textContent = `${jobTitle}: ${areaName}`;

  // Wire up action buttons
  document.getElementById("minimize-progress-modal")?.addEventListener("click", minimizeJob);
  document.getElementById("cancel-progress-modal")?.addEventListener("click", cancelActiveJob);

  // Start elapsed timer
  clearInterval(stageElapsedIntervalId);
  stageElapsedIntervalId = setInterval(updateElapsedTimes, 1000);

  updateUI();
}

function updateUI() {
  if (!activeJob) return;
  if (activeJob.minimized) {
    updateBadgeUI();
  } else {
    updatePipelineUI();
  }
}

function updatePipelineUI() {
  const container = document.querySelector(".pipeline-tracker");
  if (!container) return;

  // Overall progress
  const pct = Math.round(activeJob.progress || 0);
  const fill = container.querySelector(".pipeline-progress-fill");
  const pctLabel = container.querySelector(".pipeline-pct");
  if (fill) fill.style.width = `${pct}%`;
  if (pctLabel) pctLabel.textContent = `${pct}%`;

  // Update each stage
  PIPELINE_STAGES.forEach((stageDef) => {
    const el = container.querySelector(`[data-stage="${stageDef.key}"]`);
    if (!el) return;

    const isCompleted = completedStages.has(stageDef.key);
    const isActive = activeStageKey === stageDef.key;
    const isPending = !isCompleted && !isActive;

    el.classList.toggle("is-completed", isCompleted);
    el.classList.toggle("is-active", isActive);
    el.classList.toggle("is-pending", isPending);

    // Update icon
    const dot = el.querySelector(".pipeline-stage-dot i");
    if (dot) {
      if (isCompleted) {
        dot.className = "fas fa-check";
      } else if (isActive) {
        dot.className = `fas ${stageDef.icon} fa-pulse`;
      } else {
        dot.className = `fas ${stageDef.icon}`;
      }
    }

    // Metrics
    const metricsEl = el.querySelector(".pipeline-stage-metrics");
    if (metricsEl) {
      const metrics = stageMetrics[stageDef.key];
      if (metrics) {
        metricsEl.innerHTML = renderStageMetrics(stageDef.key, metrics);
        metricsEl.classList.add("has-data");
      }
    }
  });

  // Live message
  const msgEl = document.getElementById("pipeline-live-message");
  if (msgEl && activeJob.message) {
    msgEl.textContent = activeJob.message;
  }

  updateElapsedTimes();
}

function updateElapsedTimes() {
  const container = document.querySelector(".pipeline-tracker");
  if (!container) return;

  // Per-stage times
  PIPELINE_STAGES.forEach((stageDef) => {
    const el = container.querySelector(
      `[data-stage="${stageDef.key}"] .pipeline-stage-time`
    );
    if (!el) return;

    const isCompleted = completedStages.has(stageDef.key);
    const metrics = stageMetrics[stageDef.key] || {};

    if (isCompleted && metrics.duration_ms) {
      el.textContent = formatDuration(metrics.duration_ms);
    } else if (isCompleted && metrics.elapsed_ms) {
      el.textContent = formatDuration(metrics.elapsed_ms);
    } else if (activeStageKey === stageDef.key && stageStartTimes[stageDef.key]) {
      const elapsed = Date.now() - stageStartTimes[stageDef.key];
      el.textContent = formatDuration(elapsed);
    } else {
      el.textContent = "";
    }
  });

  // Overall elapsed
  const overallEl = container.querySelector(".pipeline-elapsed");
  if (overallEl && pipelineStartTime) {
    const elapsed = Date.now() - pipelineStartTime;
    overallEl.textContent = formatDuration(elapsed);
  }
}

function renderStageMetrics(stageKey, metrics) {
  const chips = [];

  switch (stageKey) {
    case "graph":
      if (metrics.streets_loaded != null) {
        chips.push(metricChip("fa-road", `${num(metrics.streets_loaded)} streets`));
      }
      if (metrics.streets_excluded) {
        chips.push(
          metricChip("fa-filter", `${num(metrics.streets_excluded)} filtered`)
        );
      }
      break;

    case "segmenting":
      if (metrics.segments_created != null) {
        chips.push(
          metricChip("fa-puzzle-piece", `${num(metrics.segments_created)} segments`)
        );
      }
      if (metrics.total_miles != null) {
        chips.push(metricChip("fa-ruler", `${metrics.total_miles} mi`));
      }
      break;

    case "storing":
      if (metrics.segments_stored != null) {
        chips.push(
          metricChip("fa-check-double", `${num(metrics.segments_stored)} saved`)
        );
      }
      break;

    case "statistics":
      if (metrics.coverage_pct != null) {
        chips.push(metricChip("fa-percentage", `${metrics.coverage_pct}%`));
      }
      if (metrics.driven_miles != null && metrics.driveable_miles != null) {
        chips.push(
          metricChip(
            "fa-car",
            `${metrics.driven_miles}/${metrics.driveable_miles} mi`
          )
        );
      }
      break;

    case "backfill":
      if (metrics.processed_trips != null) {
        const total = metrics.total_trips;
        const label =
          total != null
            ? `${num(metrics.processed_trips)}/${num(total)}`
            : num(metrics.processed_trips);
        chips.push(metricChip("fa-route", `${label} trips`));
      }
      if (metrics.matched_trips != null && metrics.matched_trips > 0) {
        chips.push(
          metricChip("fa-check", `${num(metrics.matched_trips)} matched`)
        );
      }
      if (metrics.segments_updated != null && metrics.segments_updated > 0) {
        chips.push(
          metricChip("fa-pen", `${num(metrics.segments_updated)} updated`)
        );
      }
      break;
  }

  return chips.join("");
}

function metricChip(icon, text) {
  return `<span class="pipeline-metric"><i class="fas ${icon}"></i>${text}</span>`;
}

function num(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}

function updateBadgeUI() {
  const badge = document.getElementById("minimized-progress-badge");
  if (!badge) return;

  const nameEl = badge.querySelector(".minimized-location-name");
  const pctEl = badge.querySelector(".minimized-progress-percent");

  if (nameEl) nameEl.textContent = activeJob?.areaName || "Background Job";
  if (pctEl) pctEl.textContent = `${Math.round(activeJob?.progress || 0)}%`;
}

// =============================================================================
// Modal Helpers
// =============================================================================

function releaseModalFocus(modalElement) {
  if (!modalElement) return;
  const { activeElement } = document;
  if (!activeElement || !modalElement.contains(activeElement)) return;
  if (typeof activeElement.blur === "function") activeElement.blur();
  if (!modalElement.contains(document.activeElement)) return;
  const { body } = document;
  if (!body || typeof body.focus !== "function") return;
  const hadTabIndex = body.hasAttribute("tabindex");
  const previousTabIndex = body.getAttribute("tabindex");
  body.setAttribute("tabindex", "-1");
  body.focus({ preventScroll: true });
  if (hadTabIndex) {
    if (previousTabIndex !== null) body.setAttribute("tabindex", previousTabIndex);
  } else {
    body.removeAttribute("tabindex");
  }
}

function showProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) return;
  const modal = bootstrap.Modal.getOrCreateInstance(el);
  modal.show();
}

function hideProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) return;
  releaseModalFocus(el);
  const modal = bootstrap.Modal.getInstance(el);
  modal?.hide();
}

function showMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  badge?.classList.remove("d-none");
  updateBadgeUI();
}

function hideMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  badge?.classList.add("d-none");
}

// =============================================================================
// Utilities
// =============================================================================

function getJobTitle(type) {
  if (type === "area_rebuild") return "Rebuilding Area";
  if (type === "area_backfill") return "Backfill Coverage";
  return "Setting Up Area";
}

function isJobActive(status) {
  return ["pending", "running"].includes(status);
}

function mapJobToState(job) {
  return {
    status: job.status,
    progress: job.progress,
    message: job.message,
    stage: job.stage,
    error: job.error,
    startedAt: job.started_at || job.startedAt,
    result: job.result,
  };
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// =============================================================================
// Export
// =============================================================================

const GlobalJobTracker = {
  start: startGlobalTracking,
  init: initGlobalJobTracker,
  resume: resumeJobTracking,
  stop: stopTracking,
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGlobalJobTracker);
} else {
  initGlobalJobTracker();
}

export { GlobalJobTracker };
export default GlobalJobTracker;
