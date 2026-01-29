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
  jobsBody: document.getElementById("map-match-jobs-body"),
  currentEmpty: document.getElementById("map-match-current-empty"),
  currentPanel: document.getElementById("map-match-current-panel"),
  progressBar: document.getElementById("map-match-progress-bar"),
  progressMessage: document.getElementById("map-match-progress-message"),
  progressMetrics: document.getElementById("map-match-progress-metrics"),
  previewSelectAll: document.getElementById("map-match-preview-select-all"),
  previewSelectionCount: document.getElementById("map-match-preview-selection-count"),
  previewClearSelection: document.getElementById("map-match-preview-clear-selection"),
  previewUnmatchSelected: document.getElementById("map-match-preview-unmatch-selected"),
  previewDeleteSelected: document.getElementById("map-match-preview-delete-selected"),
  previewActionsStatus: document.getElementById("map-match-preview-actions-status"),
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

const LAST_JOB_STORAGE_KEY = "map_matching:last_job_id";
const TERMINAL_STAGES = new Set(["completed", "failed", "error"]);

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

function setModeUI(mode) {
  const isDate = mode === "date_range";
  const isTrip = mode === "trip_id";
  elements.dateControls.classList.toggle("d-none", !isDate);
  elements.tripControls.classList.toggle("d-none", !isTrip);
  invalidatePreview();
}

function setDateModeUI(mode) {
  const isInterval = mode === "interval";
  elements.dateRange.classList.toggle("d-none", isInterval);
  elements.interval.classList.toggle("d-none", !isInterval);
  invalidatePreview();
}

function updateProgressUI(progress) {
  if (!progress) {
    elements.currentPanel.classList.add("d-none");
    elements.currentEmpty.classList.remove("d-none");
    currentJobStage = null;
    return;
  }

  elements.currentPanel.classList.remove("d-none");
  elements.currentEmpty.classList.add("d-none");
  currentJobStage = progress.stage || null;

  const pct = Math.min(100, Math.max(0, progress.progress || 0));
  elements.progressBar.style.width = `${pct}%`;
  elements.progressBar.textContent = `${pct}%`;
  elements.progressBar.setAttribute("aria-valuenow", `${pct}`);
  elements.progressBar.setAttribute("aria-valuemin", "0");
  elements.progressBar.setAttribute("aria-valuemax", "100");
  elements.progressMessage.textContent = progress.message || "";

  const metrics = progress.metrics || {};
  if (metrics.total != null) {
    // Build a clear metrics display
    const parts = [];
    parts.push(`Total: ${metrics.total}`);
    if (metrics.processed != null) {
      parts.push(`Processed: ${metrics.processed}`);
    }
    // Use either 'matched' (new format) or 'map_matched' (old format)
    const matchedCount = metrics.matched ?? metrics.map_matched ?? 0;
    parts.push(`Matched: ${matchedCount}`);
    if (metrics.skipped != null && metrics.skipped > 0) {
      parts.push(`Skipped: ${metrics.skipped}`);
    }
    if (metrics.failed != null && metrics.failed > 0) {
      parts.push(`Failed: ${metrics.failed}`);
    }
    elements.progressMetrics.textContent = parts.join(" | ");
  } else {
    elements.progressMetrics.textContent = "";
  }

  const stage = progress.stage || "unknown";
  elements.progressBar.classList.remove(
    "bg-success",
    "bg-danger",
    "bg-warning",
    "bg-secondary",
    "bg-primary",
    "progress-bar-striped",
    "progress-bar-animated"
  );

  if (stage === "completed") {
    elements.progressBar.classList.add("bg-success");
  } else if (stage === "failed" || stage === "error") {
    elements.progressBar.classList.add("bg-danger");
  } else if (stage === "queued") {
    elements.progressBar.classList.add("bg-secondary");
  } else {
    elements.progressBar.classList.add("bg-primary", "progress-bar-striped", "progress-bar-animated");
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
  if (!elements.jobsBody) {
    return;
  }
  elements.jobsBody.innerHTML = jobs
    .map((job) => {
      const status = job.stage || "unknown";
      const progress = job.progress ?? 0;
      const updated = job.updated_at ? new Date(job.updated_at).toLocaleString() : "";
      const isTerminal = isTerminalStage(status);
      const previewDisabled = !isTerminal;
      const removeDisabled = !isTerminal;
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
            <button class="btn btn-sm btn-outline-primary ms-2" data-preview-job-id="${job.job_id}"
                    ${previewDisabled ? "disabled" : ""}>
              Preview
            </button>
            <button class="btn btn-sm btn-outline-danger ms-2" data-delete-job-id="${job.job_id}"
                    ${removeDisabled ? "disabled" : ""}>
              Remove
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
  if (elements.submitBtn) {
    elements.submitBtn.disabled = true;
  }
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
    elements.previewSummary.textContent = `Found ${total} trips. Showing ${sample.length}.`;
  }

  elements.previewBody.innerHTML = sample
    .map((trip) => {
      const start = trip.startTime ? new Date(trip.startTime).toLocaleString() : "--";
      const end = trip.endTime ? new Date(trip.endTime).toLocaleString() : "--";
      let distance = "--";
      if (trip.distance != null && !Number.isNaN(Number(trip.distance))) {
        distance = `${Number(trip.distance).toFixed(2)} mi`;
      }
      const status = trip.matchedGps ? "Matched" : "Unmatched";
      return `\n        <tr>\n          <td class=\"text-truncate\" style=\"max-width: 220px\">${trip.transactionId || ""}</td>\n          <td>${start}</td>\n          <td>${end}</td>\n          <td>${distance}</td>\n          <td>${status}</td>\n        </tr>\n      `;
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
    setInlineStatus(elements.previewStatus, "Preview loaded.", "success");
    if (elements.submitBtn) {
      elements.submitBtn.disabled = (response.total || 0) === 0;
    }
  } catch (error) {
    setInlineStatus(elements.previewStatus, error.message, "danger");
  }
}

async function submitForm(event) {
  event.preventDefault();
  clearInlineStatus(elements.submitStatus);

  try {
    if (!previewPayload || !previewSignature) {
      setInlineStatus(
        elements.submitStatus,
        "Preview trips before starting.",
        "warning"
      );
      return;
    }

    const currentPayload = buildPayload();
    if (JSON.stringify(currentPayload) !== previewSignature) {
      setInlineStatus(
        elements.submitStatus,
        "Preview is out of date. Please preview again.",
        "warning"
      );
      return;
    }

    setInlineStatus(elements.submitStatus, "Queueing job...", "info");
    const result = await apiClient.post(
      CONFIG.API.mapMatchingJobs,
      previewPayload
    );
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
  elements.previewBtn?.addEventListener("click", previewTrips);
  elements.previewMapBtn?.addEventListener("click", () => {
    loadMatchedPreview(currentJobId);
  });

  elements.refreshBtn?.addEventListener("click", () => {
    loadJobs();
  });

  elements.historyClearBtn?.addEventListener("click", () => {
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

  elements.jobsBody?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-job-id]");
    const previewButton = event.target.closest("button[data-preview-job-id]");
    const deleteButton = event.target.closest("button[data-delete-job-id]");
    if (deleteButton) {
      const jobId = deleteButton.dataset.deleteJobId;
      if (jobId) {
        deleteJobHistory(jobId);
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
    elements.previewMapBody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("is-selected", tr === row);
    });
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
    elements.previewMapEmpty.textContent = message;
    elements.previewMapEmpty.classList.remove("d-none");
  } else {
    elements.previewMapEmpty.classList.add("d-none");
  }
}

function updateMatchedSelectionUI() {
  const total = elements.previewMapBody
    ? elements.previewMapBody.querySelectorAll(".matched-preview-select").length
    : 0;
  const selectedCount = matchedSelection.size;

  if (elements.previewSelectionCount) {
    elements.previewSelectionCount.textContent = `${selectedCount} selected`;
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
  updateMatchedSelectionUI();
}

function clearSelection() {
  matchedSelection = new Set();
  if (elements.previewMapBody) {
    elements.previewMapBody
      .querySelectorAll(".matched-preview-select")
      .forEach((checkbox) => {
        checkbox.checked = false;
      });
  }
  clearInlineStatus(elements.previewActionsStatus);
  updateMatchedSelectionUI();
}

function selectAllVisible(checked) {
  matchedSelection = new Set();
  if (elements.previewMapBody) {
    elements.previewMapBody
      .querySelectorAll(".matched-preview-select")
      .forEach((checkbox) => {
        checkbox.checked = checked;
        if (checked) {
          matchedSelection.add(String(checkbox.dataset.tripId || ""));
        }
      });
  }
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
    updateMatchedPreviewEmptyState("No matched geometry to display.");
  }
}

function updateMatchedPreviewTable(data) {
  if (!elements.previewMapBody || !elements.previewMapSummary) {
    return;
  }

  const total = data?.total || 0;
  const sample = data?.sample || [];
  const stage = data?.stage ? ` (${data.stage})` : "";
  const windowLabel = data?.window?.start && data?.window?.end
    ? ` • Window: ${new Date(data.window.start).toLocaleDateString()} → ${new Date(
        data.window.end
      ).toLocaleDateString()}`
    : "";
  elements.previewMapSummary.textContent = total
    ? `Matched ${total} trips${stage}. Showing ${sample.length}.${windowLabel}`
    : `No matched trips found for this job.${windowLabel}`;
  if (!total) {
    updateMatchedPreviewEmptyState("No matched trips found for this job.");
  }

  matchedPreviewFeaturesById = new Map();

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
      return `\n        <tr data-trip-id="${tripId}">\n          <td class="matched-preview-select-cell">\n            <input class="form-check-input matched-preview-select" type="checkbox" data-trip-id="${tripId}" aria-label="Select trip ${tripId}" ${isSelected ? "checked" : ""} />\n          </td>\n          <td class=\"text-truncate\" style=\"max-width: 200px\">${tripId}</td>\n          <td>${matchedAt}</td>\n          <td>${distance}</td>\n          <td>${status}</td>\n          <td class="matched-preview-actions-cell">\n            <button class="btn btn-sm btn-outline-secondary" data-action="unmatch" data-trip-id="${tripId}">\n              Clear\n            </button>\n            <button class="btn btn-sm btn-outline-danger" data-action="delete" data-trip-id="${tripId}">\n              Delete\n            </button>\n          </td>\n        </tr>\n      `;
    })
    .join("");

  syncSelectionWithRows(sample.map((trip) => String(trip.transactionId || "")));
}

async function clearMatchedTrips(tripIds, { silent = false } = {}) {
  if (!tripIds.length) {
    return;
  }

  const confirmed = await confirmationDialog.show({
    title: "Clear matched route",
    message:
      "This keeps the trip but removes the snapped route. You can rematch it later.",
    confirmText: "Clear match",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Clearing matches...", "info");
    if (tripIds.length === 1) {
      await apiClient.delete(CONFIG.API.matchedTripById(tripIds[0]));
    } else {
      await apiClient.post(CONFIG.API.matchedTripsBulkUnmatch, {
        trip_ids: tripIds,
      });
    }
    if (!silent) {
      notificationManager.show("Match cleared.", "success");
    }
    clearSelection();
    await loadMatchedPreview(currentJobId, { silent: true });
    setInlineStatus(elements.previewActionsStatus, "Matches cleared.", "success");
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
    confirmText: "Delete trips",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.previewActionsStatus, "Deleting trips...", "info");
    if (tripIds.length === 1) {
      await apiClient.delete(CONFIG.API.tripById(tripIds[0]));
    } else {
      await apiClient.post(CONFIG.API.tripsBulkDelete, {
        trip_ids: tripIds,
      });
    }
    if (!silent) {
      notificationManager.show("Trips deleted.", "success");
    }
    clearSelection();
    await loadMatchedPreview(currentJobId, { silent: true });
    setInlineStatus(elements.previewActionsStatus, "Trips deleted.", "success");
  } catch (error) {
    console.error("Failed to delete trips", error);
    setInlineStatus(elements.previewActionsStatus, error.message, "danger");
  }
}

async function deleteJobHistory(jobId) {
  if (!jobId) {
    return;
  }
  const confirmed = await confirmationDialog.show({
    title: "Remove history entry",
    message:
      "This removes the job from the history list. Running jobs will keep going.",
    confirmText: "Remove",
    confirmButtonClass: "btn-danger",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.historyStatus, "Removing history entry...", "info");
    await apiClient.delete(CONFIG.API.mapMatchingJob(jobId));
    if (currentJobId === jobId) {
      currentJobId = null;
      stopPolling();
      updateProgressUI(null);
    }
    await loadJobs();
    setInlineStatus(elements.historyStatus, "History entry removed.", "success");
  } catch (error) {
    console.error("Failed to delete history entry", error);
    setInlineStatus(elements.historyStatus, error.message, "danger");
  }
}

async function clearHistory() {
  const confirmed = await confirmationDialog.show({
    title: "Clear history",
    message:
      "This removes completed map matching records from the list. Active jobs stay running.",
    confirmText: "Clear history",
    confirmButtonClass: "btn-primary",
  });
  if (!confirmed) {
    return;
  }

  try {
    setInlineStatus(elements.historyStatus, "Clearing history...", "info");
    const response = await apiClient.delete(
      `${CONFIG.API.mapMatchingJobs}?include_active=false`
    );
    await loadJobs();
    const deleted = response?.deleted ?? 0;
    const skipped = response?.skipped_active ?? 0;
    const suffix = skipped ? " Active jobs kept." : "";
    setInlineStatus(
      elements.historyStatus,
      deleted
        ? `Cleared ${deleted} entries.${suffix}`
        : `No completed jobs to clear.${suffix}`,
      "success"
    );
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
        "Select a job to preview matched trips.",
        "warning"
      );
    }
    return;
  }

  clearInlineStatus(elements.previewMapStatus);
  clearInlineStatus(elements.previewActionsStatus);
  try {
    matchedPreviewSelectedId = null;
    elements.previewMapBody?.querySelectorAll("tr").forEach((tr) => {
      tr.classList.remove("is-selected");
    });
    setInlineStatus(elements.previewMapStatus, "Loading matched preview...", "info");
    const response = await apiClient.get(CONFIG.API.mapMatchingJobMatches(jobId));
    updateMatchedPreviewTable(response);
    if (response?.geojson) {
      updateMatchedPreviewMap(response.geojson);
    } else {
      updateMatchedPreviewEmptyState("No matched geometry to display.");
    }
    setInlineStatus(elements.previewMapStatus, "Preview loaded.", "success");
  } catch (error) {
    setInlineStatus(elements.previewMapStatus, error.message, "danger");
  }
}

function focusMatchedPreviewTrip(tripId) {
  if (!tripId) {
    return;
  }
  matchedPreviewSelectedId = String(tripId);
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
  if (!elements.form || !elements.modeSelect || !elements.dateModeSelect) {
    return;
  }
  setModeUI(elements.modeSelect.value);
  setDateModeUI(elements.dateModeSelect.value);
  invalidatePreview();
  updateMatchedSelectionUI();
  wireEvents();
  initDatePickers();
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
