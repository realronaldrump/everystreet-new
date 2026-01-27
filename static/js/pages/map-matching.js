import apiClient from "../modules/core/api-client.js";
import { CONFIG } from "../modules/core/config.js";
import notificationManager from "../modules/ui/notifications.js";
import { DateUtils } from "../modules/utils.js";
import { clearInlineStatus, setInlineStatus } from "../settings/status-utils.js";

const elements = {
  form: document.getElementById("map-matching-form"),
  modeSelect: document.getElementById("map-match-mode"),
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
  submitStatus: document.getElementById("map-match-submit-status"),
  refreshBtn: document.getElementById("map-match-refresh"),
  jobsBody: document.getElementById("map-match-jobs-body"),
  currentEmpty: document.getElementById("map-match-current-empty"),
  currentPanel: document.getElementById("map-match-current-panel"),
  progressBar: document.getElementById("map-match-progress-bar"),
  progressMessage: document.getElementById("map-match-progress-message"),
  progressMetrics: document.getElementById("map-match-progress-metrics"),
};

let currentJobId = null;
let pollTimer = null;

function setModeUI(mode) {
  const isDate = mode === "date_range";
  const isTrip = mode === "trip_id";
  elements.dateControls.classList.toggle("d-none", !isDate);
  elements.tripControls.classList.toggle("d-none", !isTrip);
  clearInlineStatus(elements.submitStatus);
}

function setDateModeUI(mode) {
  const isInterval = mode === "interval";
  elements.dateRange.classList.toggle("d-none", isInterval);
  elements.interval.classList.toggle("d-none", !isInterval);
  clearInlineStatus(elements.submitStatus);
}

function updateProgressUI(progress) {
  if (!progress) {
    elements.currentPanel.classList.add("d-none");
    elements.currentEmpty.classList.remove("d-none");
    return;
  }

  elements.currentPanel.classList.remove("d-none");
  elements.currentEmpty.classList.add("d-none");

  const pct = Math.min(100, Math.max(0, progress.progress || 0));
  elements.progressBar.style.width = `${pct}%`;
  elements.progressBar.textContent = `${pct}%`;
  elements.progressMessage.textContent = progress.message || "";

  const metrics = progress.metrics || {};
  if (metrics.total != null) {
    elements.progressMetrics.textContent = `Total: ${metrics.total} | Processed: ${metrics.processed || 0} | Matched: ${metrics.map_matched || 0} | Failed: ${metrics.failed || 0}`;
  } else {
    elements.progressMetrics.textContent = "";
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchJob(jobId) {
  if (!jobId) {
    return;
  }
  try {
    const data = await apiClient.get(CONFIG.API.mapMatchingJob(jobId));
    updateProgressUI(data);
    if (["completed", "failed", "error"].includes(data.stage)) {
      stopPolling();
    }
  } catch (error) {
    console.error("Failed to fetch job", error);
    stopPolling();
  }
}

function startPolling(jobId) {
  currentJobId = jobId;
  fetchJob(jobId);
  stopPolling();
  pollTimer = setInterval(() => fetchJob(jobId), 1000);

  const url = new URL(window.location.href);
  url.searchParams.set("job", jobId);
  window.history.replaceState({}, "", url.toString());
}

async function loadJobs() {
  try {
    const data = await apiClient.get(CONFIG.API.mapMatchingJobs);
    renderJobs(data.jobs || []);
  } catch (error) {
    console.error("Failed to load jobs", error);
  }
}

function renderJobs(jobs) {
  if (!elements.jobsBody) {
    return;
  }
  elements.jobsBody.innerHTML = jobs
    .map((job) => {
      const status = job.stage || "unknown";
      const progress = job.progress ?? 0;
      const updated = job.updated_at ? new Date(job.updated_at).toLocaleString() : "";
      return `
        <tr>
          <td class="text-truncate" style="max-width: 220px">${job.job_id || ""}</td>
          <td>${status}</td>
          <td>${progress}%</td>
          <td>${updated}</td>
          <td class="text-truncate" style="max-width: 260px">${job.message || ""}</td>
          <td>
            <button class="btn btn-sm btn-outline-secondary" data-job-id="${job.job_id}">
              View
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
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

  const dateMode = elements.dateModeSelect.value;
  const unmatchedOnly = Boolean(elements.unmatchedOnly.checked);

  if (dateMode === "interval") {
    const interval = parseInt(elements.intervalSelect.value, 10);
    if (!interval || interval < 1) {
      throw new Error("Interval must be selected");
    }
    return {
      mode: "date_range",
      interval_days: interval,
      unmatched_only: unmatchedOnly,
    };
  }

  const start = elements.startInput.value.trim();
  const end = elements.endInput.value.trim();
  if (!start || !end) {
    throw new Error("Start and end dates are required");
  }
  return {
    mode: "date_range",
    start_date: start,
    end_date: end,
    unmatched_only: unmatchedOnly,
  };
}

async function submitForm(event) {
  event.preventDefault();
  clearInlineStatus(elements.submitStatus);

  try {
    const payload = buildPayload();
    setInlineStatus(elements.submitStatus, "Queueing job...", "info");
    const result = await apiClient.post(CONFIG.API.mapMatchingJobs, payload);
    setInlineStatus(elements.submitStatus, "Job queued.", "success");
    notificationManager.show("Map matching job queued", "success");
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

  elements.modeSelect.addEventListener("change", (e) => {
    setModeUI(e.target.value);
  });

  elements.dateModeSelect.addEventListener("change", (e) => {
    setDateModeUI(e.target.value);
  });

  elements.form.addEventListener("submit", submitForm);

  elements.refreshBtn?.addEventListener("click", () => {
    loadJobs();
  });

  elements.jobsBody?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-job-id]");
    if (!button) {
      return;
    }
    const jobId = button.dataset.jobId;
    if (jobId) {
      startPolling(jobId);
    }
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

function initFromURL() {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("job");
  if (jobId) {
    startPolling(jobId);
  } else {
    updateProgressUI(null);
  }
}

function init() {
  if (!elements.form || !elements.modeSelect || !elements.dateModeSelect) {
    return;
  }
  setModeUI(elements.modeSelect.value);
  setDateModeUI(elements.dateModeSelect.value);
  wireEvents();
  initDatePickers();
  loadJobs();
  initFromURL();
}

init();
