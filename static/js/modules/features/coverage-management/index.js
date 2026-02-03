/* global bootstrap, mapboxgl */
/**
 * Coverage Management - New Simplified Version
 *
 * Event-driven coverage system with:
 * - Simple add/delete operations (no configuration)
 * - Automatic coverage updates
 * - Viewport-based map rendering
 */

// API base URL
import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import GlobalJobTracker from "../../ui/global-job-tracker.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml } from "../../utils.js";
import { isJobTerminalStatus, renderAreasTable } from "./areas.js";
import { setMetricValue } from "./stats.js";

const API_BASE = "/api/coverage";

// State
let currentAreaId = null;
let map = null;
const _streetSource = null;
let activeStreetPopup = null;
let highlightedSegmentId = null;
let currentMapFilter = "all";
const areaErrorById = new Map();
const areaNameById = new Map();
let activeErrorAreaId = null;

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
let streetInteractivityReady = false;

// Background job tracking (minimizable progress + resume)
const _ACTIVE_JOB_STORAGE_KEY = "coverageManagement.activeJob";
const JOB_POLL_INTERVAL_MS = 1500;

const activeJob = null;
let activeJobsByAreaId = new Map();
const _activeJobPolling = null;
let pageActive = false;
let pageSignal = null;

const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;

// =============================================================================
// Initialization
// =============================================================================

export default async function initCoverageManagementPage({ signal, cleanup } = {}) {
  console.log("Coverage Management initialized");

  pageSignal = signal || null;
  pageActive = true;
  setupEventListeners(signal);
  setupBackgroundJobUI();
  initValidationUI();

  // Move modal outside the layout-wrapper to prevent z-index stacking issues
  // The layout-wrapper creates a stacking context that can trap modals behind the backdrop
  const addAreaModal = document.getElementById("addAreaModal");
  const modalsContainer = document.getElementById("modals-container");
  if (addAreaModal && modalsContainer && !modalsContainer.contains(addAreaModal)) {
    modalsContainer.appendChild(addAreaModal);
  }

  // Load initial data
  await loadAreas();

  // Resume any in-progress job (even after refresh/browser close)
  await resumeBackgroundJob();

  const teardown = () => {
    pageActive = false;
    pageSignal = null;
    if (activeStreetPopup) {
      try {
        activeStreetPopup.remove();
      } catch {
        // Ignore cleanup errors.
      }
      activeStreetPopup = null;
    }
    if (map) {
      try {
        map.remove();
      } catch {
        // Ignore cleanup errors.
      }
      map = null;
    }
    activeJobsByAreaId = new Map();
    activeErrorAreaId = null;
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
}

function setupEventListeners(signal) {
  // Refresh button
  document
    .getElementById("refresh-table-btn")
    ?.addEventListener("click", loadAreas, signal ? { signal } : false);
  document
    .getElementById("quick-refresh-all")
    ?.addEventListener("click", loadAreas, signal ? { signal } : false);

  // Add area button
  document
    .getElementById("add-coverage-area")
    ?.addEventListener("click", addArea, signal ? { signal } : false);

  const locationInput = document.getElementById("location-input");
  const locationType = document.getElementById("location-type");
  const candidatesContainer = document.getElementById(
    "location-validation-candidates"
  );
  const addAreaModal = document.getElementById("addAreaModal");
  const debouncedValidate = debounce(validateLocationInput, VALIDATION_DEBOUNCE_MS);

  const handleValidationTrigger = () => {
    clearValidationSelection();
    const query = locationInput?.value.trim() || "";
    if (!query) {
      setValidationStatus({
        icon: "fa-location-dot",
        message: "Enter a location to validate.",
        tone: "neutral",
      });
    } else if (query.length < 2) {
      setValidationStatus({
        icon: "fa-pen",
        message: "Keep typing to validate.",
        tone: "neutral",
      });
    } else {
      setValidationStatus({
        icon: "fa-spinner fa-spin",
        message: "Validating location...",
        tone: "info",
      });
    }
    debouncedValidate();
  };

  locationInput?.addEventListener(
    "input",
    handleValidationTrigger,
    signal ? { signal } : false
  );
  locationType?.addEventListener(
    "change",
    handleValidationTrigger,
    signal ? { signal } : false
  );
  candidatesContainer?.addEventListener(
    "click",
    handleCandidateClick,
    signal ? { signal } : false
  );
  addAreaModal?.addEventListener(
    "hidden.bs.modal",
    () => {
      resetValidationState();
    },
    signal ? { signal } : false
  );

  const coverageTable = document.getElementById("coverage-areas-table");
  coverageTable?.addEventListener(
    "click",
    handleCoverageErrorClick,
    signal ? { signal } : false
  );
  coverageTable?.addEventListener(
    "click",
    handleAreaActionClick,
    signal ? { signal } : false
  );

  document
    .getElementById("coverage-error-dismiss")
    ?.addEventListener("click", hideCoverageErrorDetails, signal ? { signal } : false);

  // Close dashboard
  document.getElementById("close-dashboard-btn")?.addEventListener(
    "click",
    () => {
      document.getElementById("coverage-dashboard").style.display = "none";
      currentAreaId = null;
    },
    signal ? { signal } : false
  );

  // Dashboard action buttons
  document.getElementById("recalculate-coverage-btn")?.addEventListener(
    "click",
    async () => {
      if (currentAreaId) {
        const areaName
          = document.getElementById("dashboard-location-name")?.textContent
          || "this area";
        await recalculateCoverage(currentAreaId, areaName);
      }
    },
    signal ? { signal } : false
  );

  document.getElementById("rebuild-area-btn")?.addEventListener(
    "click",
    async () => {
      if (currentAreaId) {
        const areaName
          = document.getElementById("dashboard-location-name")?.textContent
          || "this area";
        await rebuildArea(currentAreaId, areaName);
      }
    },
    signal ? { signal } : false
  );

  // Window resize handler
  let resizeTimeout;
  window.addEventListener(
    "resize",
    () => {
      if (map) {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => map.resize(), 200);
      }
    },
    signal ? { signal } : false
  );

  // Map filter buttons
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener(
      "click",
      (e) => {
        document.querySelectorAll("[data-filter]").forEach((b) => {
          b.classList.remove("active", "btn-primary", "btn-success", "btn-danger");
          b.classList.add(
            `btn-outline-${
              b.dataset.filter === "all"
                ? "primary"
                : b.dataset.filter === "driven"
                  ? "success"
                  : "danger"
            }`
          );
        });
        e.target.classList.add("active");
        e.target.classList.remove(
          "btn-outline-primary",
          "btn-outline-success",
          "btn-outline-danger"
        );
        e.target.classList.add(
          `btn-${
            e.target.dataset.filter === "all"
              ? "primary"
              : e.target.dataset.filter === "driven"
                ? "success"
                : "danger"
          }`
        );

        applyMapFilter(e.target.dataset.filter);
      },
      signal ? { signal } : false
    );
  });
}

// =============================================================================
// Background Job UI (minimize + resume)
// =============================================================================

function setupBackgroundJobUI() {
  // Global job tracking handles resume/minimize; this keeps coverage UI stable.
  updateProgress(0, "Ready", "");
}

async function resumeBackgroundJob() {
  // No-op: GlobalJobTracker resumes automatically from localStorage.
}

function showProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) {
    return;
  }
  const modal = bootstrap.Modal.getOrCreateInstance(el);
  modal.show();
}

function _hideProgressModal() {
  const el = document.getElementById("taskProgressModal");
  if (!el) {
    return;
  }
  // Blur focused element before hiding to prevent aria-hidden accessibility warning
  const focusedElement = el.querySelector(":focus");
  if (focusedElement) {
    focusedElement.blur();
  }
  const modal = bootstrap.Modal.getInstance(el);
  modal?.hide();
}

function hideMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  badge?.classList.add("d-none");
}

function updateMinimizedBadge() {
  const badge = document.getElementById("minimized-progress-badge");
  if (!badge) {
    return;
  }

  const title = document.getElementById("task-progress-title")?.textContent;
  const pctText
    = document.querySelector("#taskProgressModal .progress-bar")?.textContent || "0%";

  const nameEl = badge.querySelector(".minimized-location-name");
  const pctEl = badge.querySelector(".minimized-progress-percent");

  if (nameEl) {
    nameEl.textContent = title || "Background Job";
  }
  if (pctEl) {
    pctEl.textContent = pctText;
  }
}

function setProgressModalTitle() {
  const titleEl = document.getElementById("task-progress-title");
  if (titleEl && !titleEl.textContent) {
    titleEl.textContent = "Processing...";
  }
}

// =============================================================================
// API Functions
// =============================================================================

async function apiGet(endpoint) {
  return apiClient.get(`${API_BASE}${endpoint}`, withSignal());
}

async function apiPost(endpoint, data) {
  return apiClient.post(`${API_BASE}${endpoint}`, data, withSignal());
}

async function apiDelete(endpoint) {
  return apiClient.delete(`${API_BASE}${endpoint}`, withSignal());
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
    <span>${escapeHtml(message)}</span>
  `;
}

function showValidationNote(note) {
  if (!validationElements?.note) {
    return;
  }
  if (!note) {
    validationElements.note.classList.add("d-none");
    validationElements.note.textContent = "";
    return;
  }
  validationElements.note.textContent = note;
  validationElements.note.classList.remove("d-none");
}

function showValidationConfirmation(message) {
  if (!validationElements?.confirmation) {
    return;
  }
  validationElements.confirmation.innerHTML = `
    <i class="fas fa-check-circle me-2" aria-hidden="true"></i>${escapeHtml(message)}
  `;
  validationElements.confirmation.classList.remove("d-none");
}

function hideValidationConfirmation() {
  if (!validationElements?.confirmation) {
    return;
  }
  validationElements.confirmation.classList.add("d-none");
  validationElements.confirmation.innerHTML = "";
}

function clearValidationSelection() {
  validationState.selectedCandidate = null;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  validationState.note = "";
  validationState.candidates = [];
  validationState.status = "idle";
  validationState.requestId += 1;
  validationState.resolveRequestId += 1;
  setAddButtonEnabled(false);
  renderValidationCandidates();
  showValidationNote("");
  hideValidationConfirmation();
}

function resetValidationState() {
  validationState.lastQuery = "";
  validationState.lastType = "";
  clearValidationSelection();
  setValidationStatus({
    icon: "fa-location-dot",
    message: "Enter a location to validate.",
    tone: "neutral",
  });
}

async function validateLocationInput() {
  const query = document.getElementById("location-input")?.value.trim() || "";
  const areaType = document.getElementById("location-type")?.value || "";

  if (!query) {
    resetValidationState();
    return;
  }

  if (query.length < 2) {
    setValidationStatus({
      icon: "fa-pen",
      message: "Keep typing to validate.",
      tone: "neutral",
    });
    return;
  }

  validationState.lastQuery = query;
  validationState.lastType = areaType;
  validationState.status = "validating";
  const requestId = ++validationState.requestId;

  setValidationStatus({
    icon: "fa-spinner fa-spin",
    message: "Validating location...",
    tone: "info",
  });
  showValidationNote("");
  hideValidationConfirmation();
  renderValidationCandidates();

  try {
    const data = await apiPost("/areas/validate", {
      location: query,
      area_type: areaType,
      limit: 5,
    });
    if (requestId !== validationState.requestId) {
      return;
    }

    validationState.candidates = data.candidates || [];
    validationState.note = data.note || "";
    validationState.status = "ready";

    renderValidationCandidates();
    showValidationNote(validationState.note);

    if (!validationState.candidates.length) {
      setValidationStatus({
        icon: "fa-circle-xmark",
        message: "No matches found.",
        tone: "warning",
      });
      return;
    }

    setValidationStatus({
      icon: "fa-list-check",
      message: "Select a match to confirm.",
      tone: "info",
    });
  } catch (error) {
    if (requestId !== validationState.requestId) {
      return;
    }
    validationState.candidates = [];
    validationState.note = "";
    validationState.status = "error";
    renderValidationCandidates();
    showValidationNote("");

    const isNotFound = error?.status === 404;
    setValidationStatus({
      icon: "fa-circle-xmark",
      message: isNotFound ? "No matches found." : error.message,
      tone: isNotFound ? "warning" : "danger",
    });
  }
}

function renderValidationCandidates() {
  if (!validationElements?.candidates) {
    return;
  }
  if (!validationState.candidates.length) {
    validationElements.candidates.innerHTML = "";
    return;
  }

  validationElements.candidates.innerHTML = validationState.candidates
    .map((candidate) => {
      const displayName = escapeHtml(candidate.display_name || "Unknown location");
      const classLabel = candidate.class || candidate.class_;
      const typeLabel = [classLabel, candidate.type]
        .filter(Boolean)
        .map((value) => escapeHtml(String(value)))
        .join(" / ");
      const mismatchBadge = candidate.type_match
        ? ""
        : '<span class="validation-badge badge-mismatch">Type mismatch</span>';
      return `
        <button type="button"
                class="validation-candidate"
                data-osm-id="${candidate.osm_id}"
                data-osm-type="${candidate.osm_type}"
                aria-label="Select ${displayName}">
          <div class="candidate-main">
            <div class="candidate-title">${displayName}</div>
            <div class="candidate-meta">
              ${typeLabel ? `<span class="validation-badge badge-type">${typeLabel}</span>` : ""}
              ${mismatchBadge}
            </div>
          </div>
        </button>
      `;
    })
    .join("");
}

function handleCandidateClick(event) {
  const button = event.target.closest(".validation-candidate");
  if (!button) {
    return;
  }

  const osmId = button.dataset.osmId;
  const osmType = button.dataset.osmType;
  if (!osmId || !osmType) {
    return;
  }

  const candidate = validationState.candidates.find(
    (item) => String(item.osm_id) === String(osmId) && item.osm_type === osmType
  );
  if (!candidate) {
    return;
  }

  validationElements?.candidates
    ?.querySelectorAll(".validation-candidate")
    .forEach((el) => {
      el.classList.toggle("is-selected", el === button);
      el.setAttribute("aria-selected", el === button ? "true" : "false");
    });

  confirmCandidate(candidate);
}

async function confirmCandidate(candidate) {
  validationState.selectedCandidate = candidate;
  validationState.confirmedCandidate = null;
  validationState.confirmedBoundary = null;
  setAddButtonEnabled(false);
  hideValidationConfirmation();

  const requestId = ++validationState.resolveRequestId;
  setValidationStatus({
    icon: "fa-spinner fa-spin",
    message: "Confirming match...",
    tone: "info",
  });

  try {
    const data = await apiPost("/areas/resolve", {
      osm_id: candidate.osm_id,
      osm_type: candidate.osm_type,
    });
    if (requestId !== validationState.resolveRequestId) {
      return;
    }

    validationState.confirmedCandidate = {
      ...candidate,
      display_name: data.candidate?.display_name || candidate.display_name,
    };
    validationState.confirmedBoundary = data.candidate?.boundary || null;

    if (!validationState.confirmedBoundary) {
      throw new Error("Unable to confirm boundary.");
    }

    setValidationStatus({
      icon: "fa-check-circle",
      message: "Location confirmed.",
      tone: "success",
    });
    showValidationConfirmation(
      `Confirmed: ${validationState.confirmedCandidate.display_name}`
    );
    setAddButtonEnabled(true);
  } catch (error) {
    if (requestId !== validationState.resolveRequestId) {
      return;
    }
    validationState.confirmedCandidate = null;
    validationState.confirmedBoundary = null;
    setAddButtonEnabled(false);
    setValidationStatus({
      icon: "fa-circle-xmark",
      message: error.message || "Unable to confirm location.",
      tone: "danger",
    });
  }
}

// =============================================================================
// Area Management
// =============================================================================

async function loadAreas() {
  try {
    const [areasData, jobsData] = await Promise.all([
      apiGet("/areas"),
      apiGet("/jobs").catch(() => ({ jobs: [] })),
    ]);

    const jobs = jobsData.jobs || [];
    activeJobsByAreaId = new Map(
      jobs.filter((job) => job.area_id).map((job) => [job.area_id, job])
    );

    if (!pageActive) {
      return;
    }

    const { hasAreas } = renderAreasTable({
      areas: areasData.areas,
      activeJobsByAreaId,
      areaErrorById,
      areaNameById,
    });
    if (hasAreas) {
      refreshCoverageErrorDetails(areasData.areas);
    } else {
      hideCoverageErrorDetails();
    }
    const totalAreasCountEl = document.getElementById("total-areas-count");
    if (totalAreasCountEl) {
      totalAreasCountEl.textContent = areasData.areas.length;
    }
  } catch (error) {
    console.error("Failed to load areas:", error);
    showNotification(`Failed to load coverage areas: ${error.message}`, "danger");
  }
}

function handleAreaActionClick(event) {
  const button = event.target.closest("[data-area-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.areaAction;
  const { areaId } = button.dataset;
  if (!action || !areaId) {
    return;
  }

  const areaName
    = button.dataset.areaName || areaNameById.get(areaId) || "Coverage area";

  if (action === "view") {
    viewArea(areaId);
  } else if (action === "recalculate") {
    recalculateCoverage(areaId, areaName);
  } else if (action === "rebuild") {
    rebuildArea(areaId, areaName);
  } else if (action === "delete") {
    deleteArea(areaId, areaName);
  }
}

async function addArea() {
  const displayNameInput = document.getElementById("location-input").value.trim();
  const areaType = document.getElementById("location-type").value;

  if (!displayNameInput) {
    showNotification("Please enter a location name", "warning");
    return;
  }

  if (!validationState.confirmedBoundary || !validationState.confirmedCandidate) {
    showNotification(
      "Please validate and confirm a location before adding.",
      "warning"
    );
    return;
  }

  const displayName
    = validationState.confirmedCandidate.display_name || displayNameInput;

  try {
    // Blur focused element and close add modal
    const addModal = document.getElementById("addAreaModal");
    const focusedElement = addModal?.querySelector(":focus");
    if (focusedElement) {
      focusedElement.blur();
    }
    bootstrap.Modal.getInstance(addModal)?.hide();

    // Show progress modal (can be minimized)
    hideMinimizedBadge();
    showProgressModal();
    updateProgress(0, "Creating area...", "Submitting request");

    const titleEl = document.getElementById("task-progress-title");
    if (titleEl) {
      titleEl.textContent = `Setting Up Area: ${displayName}`;
    }

    // Create area (kicks off background ingestion job server-side)
    const result = await apiPost("/areas", {
      display_name: displayName,
      area_type: areaType,
      boundary: validationState.confirmedBoundary,
    });

    // Refresh table immediately so you can keep using the page
    await loadAreas();

    // Start/resume progress tracking in the background
    if (result.job_id) {
      GlobalJobTracker.start({
        jobId: result.job_id,
        jobType: "area_ingestion",
        areaId: result.area_id || null,
        areaName: displayName,
        initialMessage: result.message || "Setting up area...",
      });

      showNotification(
        result.message
          || `Area "${displayName}" is being set up in the background. You can minimize this window and keep using the app.`,
        "info"
      );
    }

    // Clear form
    document.getElementById("location-input").value = "";
    resetValidationState();
  } catch (error) {
    console.error("Failed to add area:", error);
    showNotification(`Failed to add area: ${error.message}`, "danger");
  }
}

async function deleteArea(areaId, displayName) {
  const confirmed = await confirmationDialog.show({
    title: "Delete Coverage Area",
    message: `Delete "<strong>${escapeHtml(displayName)}</strong>"?<br><br>This will remove all coverage data for this area.`,
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  const row = document.querySelector(`[data-area-id="${areaId}"]`);
  const tbody = row?.parentElement || null;
  const nextSibling = row?.nextElementSibling || null;
  const totalCountEl = document.getElementById("total-areas-count");
  const previousCount = totalCountEl?.textContent || null;

  try {
    if (row) {
      row.remove();
    }
    if (totalCountEl) {
      const currentCount = Number.parseInt(totalCountEl.textContent || "0", 10);
      if (Number.isFinite(currentCount)) {
        totalCountEl.textContent = String(Math.max(0, currentCount - 1));
      }
    }

    await apiDelete(`/areas/${areaId}`);
    showNotification(`Area "${displayName}" deleted`, "success");

    if (currentAreaId === areaId) {
      document.getElementById("coverage-dashboard").style.display = "none";
      currentAreaId = null;
    }

    await loadAreas();
  } catch (error) {
    console.error("Failed to delete area:", error);
    if (row && tbody) {
      if (nextSibling) {
        tbody.insertBefore(row, nextSibling);
      } else {
        tbody.appendChild(row);
      }
    }
    if (totalCountEl && previousCount !== null) {
      totalCountEl.textContent = previousCount;
    }
    showNotification(`Failed to delete area: ${error.message}`, "danger");
  }
}

async function rebuildArea(areaId, displayName = null) {
  const confirmed = await confirmationDialog.show({
    title: "Rebuild Coverage Area",
    message:
      "Rebuild this area with fresh data from the local OSM extract?<br><br>This may take a few minutes.",
    confirmText: "Rebuild",
    confirmButtonClass: "btn-warning",
  });

  if (!confirmed) {
    return;
  }

  try {
    const result = await apiPost(`/areas/${areaId}/rebuild`, {});

    // Refresh table immediately so you can keep using the page
    await loadAreas();

    if (result.job_id) {
      GlobalJobTracker.start({
        jobId: result.job_id,
        jobType: "area_rebuild",
        areaId,
        areaName: displayName,
        initialMessage: result.message || "Rebuilding area...",
      });

      showNotification(
        result.message
          || "Rebuild started in the background. You can minimize this window and keep using the app.",
        "info"
      );
    }
  } catch (error) {
    console.error("Failed to rebuild area:", error);
    showNotification(`Failed to rebuild area: ${error.message}`, "danger");
  }
}

async function recalculateCoverage(areaId, displayName) {
  const confirmed = await confirmationDialog.show({
    title: "Recalculate Coverage",
    message:
      `Recalculate coverage for "<strong>${escapeHtml(displayName)}</strong>" by matching all existing trips?<br><br>`
      + `This will update coverage data without reloading the local OSM extract. Use this if coverage seems incomplete.`,
    confirmText: "Recalculate",
    confirmButtonClass: "btn-info",
  });

  if (!confirmed) {
    return;
  }

  try {
    showNotification("Recalculating coverage... This may take a moment.", "info");

    const result = await apiPost(`/areas/${areaId}/backfill`, {});

    showNotification(
      `Coverage recalculated! Updated ${result.segments_updated} segments.`,
      "success"
    );

    // Refresh the table to show updated stats
    await loadAreas();

    // If we're viewing this area, refresh the map too
    if (currentAreaId === areaId) {
      await viewArea(areaId);
    }
  } catch (error) {
    console.error("Failed to recalculate coverage:", error);
    showNotification(`Failed to recalculate coverage: ${error.message}`, "danger");
  }
}

// =============================================================================
// Error Details Panel
// =============================================================================

function handleCoverageErrorClick(event) {
  const trigger = event.target.closest("[data-error-action='show']");
  if (!trigger) {
    return;
  }

  const { areaId } = trigger.dataset;
  const areaName = areaNameById.get(areaId) || trigger.dataset.areaName || "";

  showCoverageErrorDetails(areaId, areaName);
}

function showCoverageErrorDetails(areaId, areaName, { scroll = true } = {}) {
  if (!areaId) {
    return;
  }

  const panel = document.getElementById("coverage-error-panel");
  if (!panel) {
    return;
  }

  const titleEl = document.getElementById("coverage-error-title");
  const areaEl = document.getElementById("coverage-error-area");
  const messageEl = document.getElementById("coverage-error-message");
  const errorMessage = areaErrorById.get(areaId) || "No error details were recorded.";

  if (titleEl) {
    titleEl.textContent = "Coverage calculation error";
  }
  if (areaEl) {
    areaEl.textContent = areaName ? `Area: ${areaName}` : "Coverage area error";
  }
  if (messageEl) {
    messageEl.textContent = errorMessage;
  }

  activeErrorAreaId = areaId;

  panel.classList.remove("d-none");
  panel.classList.remove("fade-in-up");
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
  activeErrorAreaId = null;
}

function refreshCoverageErrorDetails(areas) {
  if (!activeErrorAreaId) {
    return;
  }

  const area = areas?.find((entry) => entry.id === activeErrorAreaId);
  if (!area || area.status !== "error") {
    hideCoverageErrorDetails();
    return;
  }

  showCoverageErrorDetails(area.id, area.display_name, { scroll: false });
}

// =============================================================================
// Job Progress Polling
// =============================================================================

async function _pollJobProgress(jobId) {
  let consecutiveErrors = 0;

  while (pageActive && activeJob && activeJob.jobId === jobId) {
    try {
      const job = await apiGet(`/jobs/${jobId}`);
      consecutiveErrors = 0;

      // Keep local state in sync so we can resume after refresh
      activeJob.status = job.status;
      activeJob.progress = job.progress;
      activeJob.stage = job.stage;
      activeJob.message = job.message;
      activeJob.jobType = job.job_type || activeJob.jobType;
      activeJob.areaId = job.area_id || activeJob.areaId;
      activeJob.areaName = job.area_display_name || activeJob.areaName;

      setProgressModalTitle();
      updateProgress(job.progress, job.stage, job.message);

      if (isJobTerminalStatus(job.status)) {
        if (job.status === "completed") {
          return job;
        }

        const err = new Error(job.error || job.stage || "Job failed");
        err.job = job;
        throw err;
      }

      await sleep(JOB_POLL_INTERVAL_MS);
    } catch (error) {
      // Stop polling if the user started tracking a different job
      if (!activeJob || activeJob.jobId !== jobId) {
        return null;
      }

      // Bubble up explicit job failures
      if (error?.job) {
        throw error;
      }

      consecutiveErrors += 1;
      console.warn("Error polling job:", error);

      updateProgress(
        activeJob.progress ?? 0,
        "Connection lost - retrying...",
        activeJob.message
      );
      await sleep(Math.min(30000, 1000 * consecutiveErrors));
    }
  }

  return null;
}

function updateProgress(percent, message, detailMessage = null) {
  const bar = document.querySelector("#taskProgressModal .progress-bar");
  const msg = document.querySelector("#taskProgressModal .progress-message");
  const stage = document.querySelector("#taskProgressModal .progress-stage");
  const resolvedDetail
    = typeof detailMessage === "string" ? detailMessage : activeJob?.message || "";

  if (bar) {
    bar.style.width = `${percent}%`;
    bar.textContent = `${Math.round(percent)}%`;
  }
  if (msg) {
    msg.textContent = message || resolvedDetail || "Working...";
  }
  if (stage) {
    const percentLabel = `${Math.round(percent)}% complete`;
    stage.textContent = resolvedDetail
      ? `${resolvedDetail} | ${percentLabel}`
      : percentLabel;
  }

  // Keep minimized badge up-to-date
  if (activeJob) {
    activeJob.progress = percent;
    activeJob.stage = message;
    activeJob.message = resolvedDetail;
    updateMinimizedBadge();
  }
}

// =============================================================================
// Map & Dashboard
// =============================================================================

async function viewArea(areaId) {
  currentAreaId = areaId;
  clearStreetPopup();

  try {
    // Show dashboard
    document.getElementById("coverage-dashboard").style.display = "block";

    // Load area details
    const data = await apiGet(`/areas/${areaId}`);
    const { area } = data;

    // Update stats
    document.getElementById("dashboard-location-name").textContent = area.display_name;
    setMetricValue("dashboard-total-length", area.total_length_miles, {
      decimals: 2,
      suffix: " mi",
    });
    setMetricValue("dashboard-driven-length", area.driven_length_miles, {
      decimals: 2,
      suffix: " mi",
    });
    setMetricValue("dashboard-coverage-percentage", area.coverage_percentage, {
      decimals: 2,
      suffix: "%",
    });

    // Load segment counts
    const summary = await apiGet(`/areas/${areaId}/streets/summary`);
    setMetricValue("segments-driven", summary.segment_counts.driven || 0);
    setMetricValue("segments-undriven", summary.segment_counts.undriven || 0);
    setMetricValue("segments-undriveable", summary.segment_counts.undriveable || 0);

    // Initialize or update map
    if (data.bounding_box) {
      initOrUpdateMap(areaId, data.bounding_box);
    }

    // Scroll to dashboard
    document
      .getElementById("coverage-dashboard")
      .scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    console.error("Failed to load area:", error);
    showNotification(`Failed to load area details: ${error.message}`, "danger");
  }
}

function initOrUpdateMap(areaId, bbox) {
  const container = document.getElementById("coverage-map");
  container.innerHTML = ""; // Clear loading spinner

  if (!map) {
    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
    map = new mapboxgl.Map({
      container: "coverage-map",
      style: "mapbox://styles/mapbox/dark-v11",
      bounds: [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      fitBoundsOptions: { padding: 50 },
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.on("load", () => {
      loadStreets(areaId);
      map.resize();
    });
    map.on("moveend", () => loadStreets(areaId));
  } else {
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 50 }
    );
    loadStreets(areaId);
    // Resize the map after a short delay to ensure the container has updated dimensions
    setTimeout(() => map.resize(), 100);
  }
}

async function loadStreets(areaId) {
  if (!map || !areaId) {
    return;
  }

  const bounds = map.getBounds();

  try {
    const data = await apiGet(
      `/areas/${areaId}/streets/geojson?${new URLSearchParams({
        min_lon: bounds.getWest(),
        min_lat: bounds.getSouth(),
        max_lon: bounds.getEast(),
        max_lat: bounds.getNorth(),
      })}`
    );

    // Update or add source
    if (map.getSource("streets")) {
      map.getSource("streets").setData(data);
    } else {
      map.addSource("streets", { type: "geojson", data });

      // Undriven streets (red)
      map.addLayer({
        id: "streets-undriven",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "undriven"],
        paint: {
          "line-color": "#ef4444",
          "line-width": 2,
          "line-opacity": 0.8,
        },
      });

      // Driven streets (green)
      map.addLayer({
        id: "streets-driven",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "driven"],
        paint: {
          "line-color": "#22c55e",
          "line-width": 2,
          "line-opacity": 0.8,
        },
      });

      // Undriveable streets (gray, dashed)
      map.addLayer({
        id: "streets-undriveable",
        type: "line",
        source: "streets",
        filter: ["==", ["get", "status"], "undriveable"],
        paint: {
          "line-color": "#6b7280",
          "line-width": 1,
          "line-opacity": 0.5,
          "line-dasharray": [2, 2],
        },
      });

      // Highlighted segment layer (on top)
      map.addLayer({
        id: HIGHLIGHT_LAYER_ID,
        type: "line",
        source: "streets",
        filter: ["==", ["get", "segment_id"], ""],
        paint: {
          "line-color": "#fbbf24",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });

      setupStreetInteractivity();
    }
  } catch (error) {
    console.error("Failed to load streets:", error);
  }
}

function setupStreetInteractivity() {
  if (!map || streetInteractivityReady) {
    return;
  }

  streetInteractivityReady = true;

  STREET_LAYERS.forEach((layerId) => {
    if (!map.getLayer(layerId)) {
      return;
    }

    map.on("click", layerId, handleStreetClick);
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  });

  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, {
      layers: STREET_LAYERS,
    });
    if (!features.length) {
      clearStreetPopup();
    }
  });
}

function handleStreetClick(event) {
  const feature = event.features?.[0];
  if (!feature || !map) {
    return;
  }

  const popupContent = createStreetPopupContent(feature.properties || {});

  clearStreetPopup();

  activeStreetPopup = new mapboxgl.Popup({
    closeButton: true,
    closeOnClick: false,
    className: "coverage-segment-popup",
    maxWidth: "260px",
  })
    .setLngLat(event.lngLat)
    .setHTML(popupContent)
    .addTo(map);

  activeStreetPopup.on("close", () => {
    activeStreetPopup = null;
    setHighlightedSegment(null);
  });

  setHighlightedSegment(feature.properties?.segment_id);
}

function clearStreetPopup() {
  if (activeStreetPopup) {
    activeStreetPopup.remove();
    activeStreetPopup = null;
  }
  setHighlightedSegment(null);
}

function setHighlightedSegment(segmentId) {
  highlightedSegmentId = segmentId || null;
  updateHighlightFilter();
}

function updateHighlightFilter() {
  if (!map || !map.getLayer(HIGHLIGHT_LAYER_ID)) {
    return;
  }

  if (!highlightedSegmentId) {
    map.setFilter(HIGHLIGHT_LAYER_ID, ["==", ["get", "segment_id"], ""]);
    return;
  }

  const baseFilter = ["==", ["get", "segment_id"], highlightedSegmentId];

  if (currentMapFilter === "driven") {
    map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      ["==", ["get", "status"], "driven"],
    ]);
  } else if (currentMapFilter === "undriven") {
    map.setFilter(HIGHLIGHT_LAYER_ID, [
      "all",
      baseFilter,
      ["==", ["get", "status"], "undriven"],
    ]);
  } else {
    map.setFilter(HIGHLIGHT_LAYER_ID, baseFilter);
  }
}

function createStreetPopupContent(props) {
  const streetName = escapeHtml(props.street_name || "Unnamed Street");
  const segmentId = escapeHtml(props.segment_id || "Unknown");
  const statusKey
    = typeof props.status === "string" ? props.status.toLowerCase() : "unknown";
  const statusLabel = formatStatus(statusKey);
  const lengthLabel = formatSegmentLength(props.length_miles);
  const highwayType = escapeHtml(formatHighwayType(props.highway_type));
  const firstDriven = formatPopupDate(props.first_driven_at, statusKey);
  const lastDriven = formatPopupDate(props.last_driven_at, statusKey);

  return `
    <div class="segment-popup-content">
      <div class="popup-header">
        <div class="popup-title">${streetName}</div>
        <span class="status-pill status-${statusKey}">${statusLabel}</span>
      </div>
      <div class="popup-subtitle">${highwayType} &middot; ${lengthLabel}</div>
      <div class="popup-grid">
        <div class="popup-item">
          <span class="popup-label">First driven</span>
          <span class="popup-value">${firstDriven}</span>
        </div>
        <div class="popup-item">
          <span class="popup-label">Last driven</span>
          <span class="popup-value">${lastDriven}</span>
        </div>
      </div>
      <div class="popup-meta">
        <span class="popup-label">Segment</span>
        <span class="popup-value segment-id">${segmentId}</span>
      </div>
    </div>
  `;
}

function formatStatus(statusKey) {
  if (statusKey === "driven") {
    return "Driven";
  }
  if (statusKey === "undriven") {
    return "Undriven";
  }
  if (statusKey === "undriveable") {
    return "Undriveable";
  }
  return "Unknown";
}

function formatSegmentLength(lengthMiles) {
  const miles = Number(lengthMiles);
  if (!Number.isFinite(miles)) {
    return "Unknown";
  }
  return `${miles.toFixed(2)} mi`;
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

function formatHighwayType(type) {
  if (!type) {
    return "Unknown";
  }
  const normalized = String(type).replace(/_/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function applyMapFilter(filter) {
  if (!map) {
    return;
  }

  currentMapFilter = filter;

  STREET_LAYERS.forEach((layerId) => {
    if (!map.getLayer(layerId)) {
      return;
    }

    if (filter === "all") {
      map.setLayoutProperty(layerId, "visibility", "visible");
    } else if (filter === "driven") {
      map.setLayoutProperty(
        layerId,
        "visibility",
        layerId === "streets-driven" ? "visible" : "none"
      );
    } else if (filter === "undriven") {
      map.setLayoutProperty(
        layerId,
        "visibility",
        layerId === "streets-undriven" ? "visible" : "none"
      );
    }
  });

  updateHighlightFilter();
}

// =============================================================================
// Utilities
// =============================================================================

function showNotification(message, type = "info") {
  notificationManager.show(message, type);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
