/**
 * Coverage Management - New Simplified Version
 *
 * Event-driven coverage system with:
 * - Simple add/delete operations (no configuration)
 * - Automatic coverage updates
 * - Viewport-based map rendering
 */

// API base URL
const API_BASE = "/api/coverage";

// State
let currentAreaId = null;
let map = null;
let streetSource = null;
let activeStreetPopup = null;
let highlightedSegmentId = null;
let currentMapFilter = "all";

const STREET_LAYERS = ["streets-undriven", "streets-driven", "streets-undriveable"];
const HIGHLIGHT_LAYER_ID = "streets-highlight";
let streetInteractivityReady = false;

// Background job tracking (minimizable progress + resume)
const ACTIVE_JOB_STORAGE_KEY = "coverageManagement.activeJob";
const JOB_POLL_INTERVAL_MS = 1500;

let activeJob = null;
let activeJobsByAreaId = new Map();
let activeJobPolling = null;

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  console.log("Coverage Management initialized");

  setupEventListeners();
  setupBackgroundJobUI();

  // Load initial data
  await loadAreas();

  // Resume any in-progress job (even after refresh/browser close)
  await resumeBackgroundJob();
});

function setupEventListeners() {
  // Refresh button
  document.getElementById("refresh-table-btn")?.addEventListener("click", loadAreas);
  document.getElementById("quick-refresh-all")?.addEventListener("click", loadAreas);

  // Add area button
  document.getElementById("add-coverage-area")?.addEventListener("click", addArea);

  // Close dashboard
  document.getElementById("close-dashboard-btn")?.addEventListener("click", () => {
    document.getElementById("coverage-dashboard").style.display = "none";
    currentAreaId = null;
  });

  // Dashboard action buttons
  document
    .getElementById("recalculate-coverage-btn")
    ?.addEventListener("click", async () => {
      if (currentAreaId) {
        const areaName =
          document.getElementById("dashboard-location-name")?.textContent ||
          "this area";
        await recalculateCoverage(currentAreaId, areaName);
      }
    });

  document.getElementById("rebuild-area-btn")?.addEventListener("click", async () => {
    if (currentAreaId) {
      const areaName =
        document.getElementById("dashboard-location-name")?.textContent || "this area";
      await rebuildArea(currentAreaId, areaName);
    }
  });

  // Window resize handler
  let resizeTimeout;
  window.addEventListener("resize", () => {
    if (map) {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => map.resize(), 200);
    }
  });

  // Map filter buttons
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll("[data-filter]").forEach((b) => {
        b.classList.remove("active", "btn-primary", "btn-success", "btn-danger");
        b.classList.add(
          "btn-outline-" +
            (b.dataset.filter === "all"
              ? "primary"
              : b.dataset.filter === "driven"
                ? "success"
                : "danger")
        );
      });
      e.target.classList.add("active");
      e.target.classList.remove(
        "btn-outline-primary",
        "btn-outline-success",
        "btn-outline-danger"
      );
      e.target.classList.add(
        "btn-" +
          (e.target.dataset.filter === "all"
            ? "primary"
            : e.target.dataset.filter === "driven"
              ? "success"
              : "danger")
      );

      applyMapFilter(e.target.dataset.filter);
    });
  });
}

// =============================================================================
// Background Job UI (minimize + resume)
// =============================================================================

function setupBackgroundJobUI() {
  const modalEl = document.getElementById("taskProgressModal");
  const minimizeBtn = document.getElementById("minimize-progress-modal");
  const badgeEl = document.getElementById("minimized-progress-badge");

  minimizeBtn?.addEventListener("click", () => {
    hideProgressModal();
  });

  badgeEl?.addEventListener("click", () => {
    showProgressModal();
  });

  badgeEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showProgressModal();
    }
  });

  modalEl?.addEventListener("shown.bs.modal", () => {
    hideMinimizedBadge();
  });

  modalEl?.addEventListener("hidden.bs.modal", () => {
    if (activeJob && isJobActiveStatus(activeJob.status)) {
      showMinimizedBadge();
    }
  });
}

function getProgressModalInstance() {
  const modalEl = document.getElementById("taskProgressModal");
  if (!modalEl) return null;

  return bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
}

function showProgressModal() {
  const modal = getProgressModalInstance();
  if (!modal) return;
  modal.show();
}

function hideProgressModal() {
  const modal = getProgressModalInstance();
  if (!modal) return;
  modal.hide();
}

function showMinimizedBadge() {
  const badgeEl = document.getElementById("minimized-progress-badge");
  if (!badgeEl) return;

  updateMinimizedBadge();
  badgeEl.classList.remove("d-none");
}

function hideMinimizedBadge() {
  const badgeEl = document.getElementById("minimized-progress-badge");
  if (!badgeEl) return;
  badgeEl.classList.add("d-none");
}

function updateMinimizedBadge() {
  const badgeEl = document.getElementById("minimized-progress-badge");
  if (!badgeEl) return;

  const nameEl = badgeEl.querySelector(".minimized-location-name");
  const percentEl = badgeEl.querySelector(".minimized-progress-percent");

  const locationName = activeJob?.areaName || "Working...";
  const roundedProgress =
    typeof activeJob?.progress === "number" ? Math.round(activeJob.progress) : 0;

  if (nameEl) nameEl.textContent = locationName;
  if (percentEl) percentEl.textContent = `${roundedProgress}%`;
  badgeEl.title = activeJob?.stage || "";
}

function getJobTitle(jobType) {
  if (jobType === "area_rebuild") return "Rebuilding Area";
  return "Setting Up Area";
}

function setProgressModalTitle() {
  const titleEl = document.getElementById("task-progress-title");
  if (!titleEl) return;

  const baseTitle = getJobTitle(activeJob?.jobType);
  const areaName = activeJob?.areaName;

  titleEl.textContent = areaName ? `${baseTitle}: ${areaName}` : baseTitle;
}

function isJobActiveStatus(status) {
  return status === "pending" || status === "running";
}

function isJobTerminalStatus(status) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "needs_attention" ||
    status === "cancelled"
  );
}

function saveActiveJobToStorage() {
  if (!activeJob) {
    localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify(activeJob));
}

function loadActiveJobFromStorage() {
  const raw = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearActiveJob() {
  activeJob = null;
  activeJobPolling = null;
  localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
}

async function resumeBackgroundJob() {
  const stored = loadActiveJobFromStorage();

  if (stored?.jobId) {
    try {
      const snapshot = await apiGet(`/jobs/${stored.jobId}`);

      if (isJobTerminalStatus(snapshot.status)) {
        const title = getJobTitle(snapshot.job_type);
        const areaName = snapshot.area_display_name || stored.areaName;
        const areaPart = areaName ? `: "${areaName}"` : "";

        clearActiveJob();
        hideMinimizedBadge();
        hideProgressModal();

        if (snapshot.status === "completed") {
          showNotification(`${title} completed${areaPart}`, "success");
          await loadAreas();
        } else {
          const errMsg = snapshot.error || snapshot.stage || "Job failed";
          showNotification(`${title} failed${areaPart}. ${errMsg}`, "danger");
          await loadAreas();
        }

        return;
      }

      startTrackingJob({
        jobId: stored.jobId,
        jobType: snapshot.job_type || stored.jobType,
        areaId: snapshot.area_id || stored.areaId,
        areaName: snapshot.area_display_name || stored.areaName,
        showModal: false,
        initialSnapshot: snapshot,
      });
      return;
    } catch (error) {
      console.warn("Failed to resume stored job:", error);
      clearActiveJob();
    }
  }

  // No stored job; fall back to any active jobs on server
  try {
    const data = await apiGet("/jobs");
    const jobs = data.jobs || [];
    if (!jobs.length) return;

    const job = jobs[0];
    if (!job?.job_id) return;

    startTrackingJob({
      jobId: job.job_id,
      jobType: job.job_type,
      areaId: job.area_id,
      areaName: job.area_display_name,
      showModal: false,
      initialSnapshot: job,
    });
  } catch (error) {
    console.warn("Failed to load active jobs:", error);
  }
}

function startTrackingJob({
  jobId,
  jobType,
  areaId,
  areaName,
  showModal = false,
  initialMessage = "Starting...",
  initialSnapshot = null,
}) {
  if (!jobId) return;

  activeJob = {
    jobId,
    jobType,
    areaId: areaId || null,
    areaName: areaName || null,
    status: initialSnapshot?.status || "pending",
    stage: initialSnapshot?.stage || initialMessage,
    progress: initialSnapshot?.progress ?? 0,
  };

  saveActiveJobToStorage();
  setProgressModalTitle();
  updateProgress(activeJob.progress, activeJob.stage);
  updateMinimizedBadge();

  if (showModal) {
    hideMinimizedBadge();
    showProgressModal();
  } else {
    showMinimizedBadge();
  }

  // Only one poller per jobId
  if (activeJobPolling?.jobId === jobId) return;

  activeJobPolling = { jobId };
  pollJobProgress(jobId)
    .then((job) => {
      if (!job) return;
      void handleJobCompleted(job);
    })
    .catch((error) => {
      void handleJobFailed(error);
    });
}

async function handleJobCompleted(job) {
  const title = getJobTitle(job.job_type || activeJob?.jobType);
  const areaName = job.area_display_name || activeJob?.areaName;
  const areaPart = areaName ? `: "${areaName}"` : "";

  clearActiveJob();
  hideMinimizedBadge();
  hideProgressModal();

  showNotification(`${title} completed${areaPart}`, "success");

  await loadAreas();

  if (currentAreaId && job.area_id && currentAreaId === job.area_id) {
    await viewArea(currentAreaId);
  }
}

async function handleJobFailed(error) {
  const job = error?.job;
  const title = getJobTitle(job?.job_type || activeJob?.jobType);
  const areaName = job?.area_display_name || activeJob?.areaName;
  const areaPart = areaName ? `: "${areaName}"` : "";
  const errMsg = job?.error || error?.message || "Job failed";

  clearActiveJob();
  hideMinimizedBadge();
  hideProgressModal();

  showNotification(`${title} failed${areaPart}. ${errMsg}`, "danger");

  await loadAreas();
}

// =============================================================================
// API Functions
// =============================================================================

async function apiGet(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function apiPost(endpoint, data) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function apiDelete(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, { method: "DELETE" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed: ${response.status}`);
  }
  return response.json();
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

    renderAreasTable(areasData.areas);
    document.getElementById("total-areas-count").textContent = areasData.areas.length;
  } catch (error) {
    console.error("Failed to load areas:", error);
    showNotification("Failed to load coverage areas: " + error.message, "danger");
  }
}

function renderAreasTable(areas) {
  const tbody = document.querySelector("#coverage-areas-table tbody");

  if (!areas || areas.length === 0) {
    tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center p-4">
                    <div class="empty-state">
                        <i class="fas fa-map-marked-alt fa-3x text-secondary mb-3"></i>
                        <p class="mb-2">No coverage areas yet</p>
                        <button class="btn btn-success btn-sm" data-bs-toggle="modal" data-bs-target="#addAreaModal">
                            <i class="fas fa-plus me-1"></i>Add Your First Area
                        </button>
                    </div>
                </td>
            </tr>`;
    return;
  }

  tbody.innerHTML = areas
    .map(
      (area) => `
        <tr data-area-id="${area.id}">
            <td>
                <strong>${escapeHtml(area.display_name)}</strong>
                <br><small class="text-secondary">${area.area_type}</small>
            </td>
            <td>${renderStatus(area.status, area.health, activeJobsByAreaId.get(area.id))}</td>
            <td>${formatMiles(area.total_length_miles)}</td>
            <td>${formatMiles(area.driven_length_miles)}</td>
            <td>
                <div class="progress" style="height: 20px; min-width: 100px;">
                    <div class="progress-bar bg-success" style="width: ${area.coverage_percentage}%">
                        ${area.coverage_percentage.toFixed(1)}%
                    </div>
                </div>
            </td>
            <td>${area.last_synced ? formatRelativeTime(area.last_synced) : "Never"}</td>
            <td>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-primary" onclick="viewArea('${area.id}')" 
                            title="View on map" ${area.status !== "ready" ? "disabled" : ""}>
                        <i class="fas fa-map"></i>
                    </button>
                    <button class="btn btn-outline-info" onclick="recalculateCoverage('${area.id}', '${escapeHtml(area.display_name)}')"
                            title="Recalculate coverage from trips" ${area.status !== "ready" ? "disabled" : ""}>
                        <i class="fas fa-calculator"></i>
                    </button>
                    <button class="btn btn-outline-warning" onclick="rebuildArea('${area.id}', '${escapeHtml(area.display_name)}')"
                             title="Rebuild with fresh OSM data" ${area.status !== "ready" ? "disabled" : ""}>
                        <i class="fas fa-sync"></i>
                    </button>
                    <button class="btn btn-outline-danger" onclick="deleteArea('${area.id}', '${escapeHtml(area.display_name)}')"
                            title="Delete area">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `
    )
    .join("");
}

function renderStatus(status, health, job) {
  const statusConfig = {
    ready: { class: "success", icon: "check-circle", text: "Ready" },
    initializing: { class: "info", icon: "spinner fa-spin", text: "Setting up..." },
    rebuilding: { class: "warning", icon: "sync fa-spin", text: "Rebuilding..." },
    error: { class: "danger", icon: "exclamation-circle", text: "Error" },
  };

  const config = statusConfig[status] || statusConfig["error"];
  const badge = `<span class="badge bg-${config.class}">
        <i class="fas fa-${config.icon} me-1"></i>${config.text}
    </span>`;

  if (
    job &&
    isJobActiveStatus(job.status) &&
    (status === "initializing" || status === "rebuilding")
  ) {
    const percent = typeof job.progress === "number" ? Math.round(job.progress) : 0;
    const stageText = job.stage ? escapeHtml(job.stage) : "";
    return `<div>${badge}</div><div class="small text-secondary mt-1">${stageText} (${percent}%)</div>`;
  }

  return badge;
}

async function addArea() {
  const displayName = document.getElementById("location-input").value.trim();
  const areaType = document.getElementById("location-type").value;

  if (!displayName) {
    showNotification("Please enter a location name", "warning");
    return;
  }

  try {
    // Close add modal
    bootstrap.Modal.getInstance(document.getElementById("addAreaModal"))?.hide();

    // Show progress modal (can be minimized)
    hideMinimizedBadge();
    showProgressModal();
    updateProgress(0, "Creating area...");

    const titleEl = document.getElementById("task-progress-title");
    if (titleEl) {
      titleEl.textContent = `Setting Up Area: ${displayName}`;
    }

    // Create area (kicks off background ingestion job server-side)
    const result = await apiPost("/areas", {
      display_name: displayName,
      area_type: areaType,
    });

    // Refresh table immediately so you can keep using the page
    await loadAreas();

    // Start/resume progress tracking in the background
    if (result.job_id) {
      startTrackingJob({
        jobId: result.job_id,
        jobType: "area_ingestion",
        areaId: result.area_id || null,
        areaName: displayName,
        showModal: true,
        initialMessage: result.message || "Setting up area...",
      });

      showNotification(
        result.message ||
          `Area "${displayName}" is being set up in the background. You can minimize this window and keep using the app.`,
        "info"
      );
    }

    // Clear form
    document.getElementById("location-input").value = "";
  } catch (error) {
    console.error("Failed to add area:", error);
    clearActiveJob();
    hideMinimizedBadge();
    hideProgressModal();
    showNotification("Failed to add area: " + error.message, "danger");
  }
}

async function deleteArea(areaId, displayName) {
  const confirmed = await window.confirmationDialog?.show({
    title: "Delete Coverage Area",
    message: `Delete "<strong>${escapeHtml(displayName)}</strong>"?<br><br>This will remove all coverage data for this area.`,
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiDelete(`/areas/${areaId}`);
    showNotification(`Area "${displayName}" deleted`, "success");

    if (currentAreaId === areaId) {
      document.getElementById("coverage-dashboard").style.display = "none";
      currentAreaId = null;
    }

    await loadAreas();
  } catch (error) {
    console.error("Failed to delete area:", error);
    showNotification("Failed to delete area: " + error.message, "danger");
  }
}

async function rebuildArea(areaId, displayName = null) {
  const confirmed = await window.confirmationDialog?.show({
    title: "Rebuild Coverage Area",
    message:
      "Rebuild this area with fresh data from OpenStreetMap?<br><br>This may take a few minutes.",
    confirmText: "Rebuild",
    confirmButtonClass: "btn-warning",
  });

  if (!confirmed) {
    return;
  }

  try {
    hideMinimizedBadge();
    showProgressModal();
    updateProgress(0, "Starting rebuild...");

    const result = await apiPost(`/areas/${areaId}/rebuild`, {});

    // Refresh table immediately so you can keep using the page
    await loadAreas();

    if (result.job_id) {
      startTrackingJob({
        jobId: result.job_id,
        jobType: "area_rebuild",
        areaId,
        areaName: displayName,
        showModal: true,
        initialMessage: result.message || "Rebuilding area...",
      });

      showNotification(
        result.message ||
          "Rebuild started in the background. You can minimize this window and keep using the app.",
        "info"
      );
    }
  } catch (error) {
    console.error("Failed to rebuild area:", error);
    clearActiveJob();
    hideMinimizedBadge();
    hideProgressModal();
    showNotification("Failed to rebuild area: " + error.message, "danger");
  }
}

async function recalculateCoverage(areaId, displayName) {
  const confirmed = await window.confirmationDialog?.show({
    title: "Recalculate Coverage",
    message:
      `Recalculate coverage for "<strong>${escapeHtml(displayName)}</strong>" by matching all existing trips?<br><br>` +
      `This will update coverage data without re-downloading streets from OSM. Use this if coverage seems incomplete.`,
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
    showNotification("Failed to recalculate coverage: " + error.message, "danger");
  }
}

// =============================================================================
// Job Progress Polling
// =============================================================================

async function pollJobProgress(jobId) {
  let consecutiveErrors = 0;

  while (activeJob && activeJob.jobId === jobId) {
    try {
      const job = await apiGet(`/jobs/${jobId}`);
      consecutiveErrors = 0;

      // Keep local state in sync so we can resume after refresh
      activeJob.status = job.status;
      activeJob.progress = job.progress;
      activeJob.stage = job.stage;
      activeJob.jobType = job.job_type || activeJob.jobType;
      activeJob.areaId = job.area_id || activeJob.areaId;
      activeJob.areaName = job.area_display_name || activeJob.areaName;

      saveActiveJobToStorage();
      setProgressModalTitle();
      updateProgress(job.progress, job.stage);

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

      updateProgress(activeJob.progress ?? 0, "Connection lost - retrying...");
      await sleep(Math.min(30000, 1000 * consecutiveErrors));
    }
  }

  return null;
}

function updateProgress(percent, message) {
  const bar = document.querySelector("#taskProgressModal .progress-bar");
  const msg = document.querySelector("#taskProgressModal .progress-message");
  const stage = document.querySelector("#taskProgressModal .progress-stage");

  if (bar) {
    bar.style.width = `${percent}%`;
    bar.textContent = `${Math.round(percent)}%`;
  }
  if (msg) msg.textContent = message;
  if (stage) stage.textContent = `${Math.round(percent)}% complete`;

  // Keep minimized badge up-to-date
  if (activeJob) {
    activeJob.progress = percent;
    activeJob.stage = message;
    saveActiveJobToStorage();
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
    const area = data.area;

    // Update stats
    document.getElementById("dashboard-location-name").textContent = area.display_name;
    document.getElementById("dashboard-total-length").textContent = formatMiles(
      area.total_length_miles
    );
    document.getElementById("dashboard-driven-length").textContent = formatMiles(
      area.driven_length_miles
    );
    document.getElementById("dashboard-coverage-percentage").textContent =
      `${area.coverage_percentage.toFixed(1)}%`;

    // Load segment counts
    const summary = await apiGet(`/areas/${areaId}/streets/summary`);
    document.getElementById("segments-driven").textContent =
      summary.segment_counts.driven || 0;
    document.getElementById("segments-undriven").textContent =
      summary.segment_counts.undriven || 0;
    document.getElementById("segments-undriveable").textContent =
      summary.segment_counts.undriveable || 0;

    // Initialize or update map
    if (data.bounding_box) {
      await initOrUpdateMap(areaId, data.bounding_box);
    }

    // Scroll to dashboard
    document
      .getElementById("coverage-dashboard")
      .scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    console.error("Failed to load area:", error);
    showNotification("Failed to load area details: " + error.message, "danger");
  }
}

async function initOrUpdateMap(areaId, bbox) {
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
  if (!map || !areaId) return;

  const bounds = map.getBounds();

  try {
    const data = await apiGet(
      `/areas/${areaId}/streets/geojson?` +
        new URLSearchParams({
          min_lon: bounds.getWest(),
          min_lat: bounds.getSouth(),
          max_lon: bounds.getEast(),
          max_lat: bounds.getNorth(),
        })
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
  if (!map || streetInteractivityReady) return;

  streetInteractivityReady = true;

  STREET_LAYERS.forEach((layerId) => {
    if (!map.getLayer(layerId)) return;

    map.on("click", layerId, handleStreetClick);
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  });

  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: STREET_LAYERS });
    if (!features.length) {
      clearStreetPopup();
    }
  });
}

function handleStreetClick(event) {
  const feature = event.features?.[0];
  if (!feature || !map) return;

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
  if (!map || !map.getLayer(HIGHLIGHT_LAYER_ID)) return;

  if (!highlightedSegmentId) {
    map.setFilter(HIGHLIGHT_LAYER_ID, ["==", ["get", "segment_id"], ""]);
    return;
  }

  const baseFilter = ["==", ["get", "segment_id"], highlightedSegmentId];

  if (currentMapFilter === "driven") {
    map.setFilter(HIGHLIGHT_LAYER_ID, ["all", baseFilter, ["==", ["get", "status"], "driven"]]);
  } else if (currentMapFilter === "undriven") {
    map.setFilter(
      HIGHLIGHT_LAYER_ID,
      ["all", baseFilter, ["==", ["get", "status"], "undriven"]]
    );
  } else {
    map.setFilter(HIGHLIGHT_LAYER_ID, baseFilter);
  }
}

function createStreetPopupContent(props) {
  const streetName = escapeHtml(props.street_name || "Unnamed Street");
  const segmentId = escapeHtml(props.segment_id || "Unknown");
  const statusKey =
    typeof props.status === "string" ? props.status.toLowerCase() : "unknown";
  const statusLabel = formatStatus(statusKey);
  const statusClass = statusLabel ? `status-${statusKey}` : "";
  const lengthLabel = formatSegmentLength(props.length_miles);
  const highwayType = escapeHtml(formatHighwayType(props.highway_type));

  return `
    <div class="segment-popup-content">
      <div class="popup-title">${streetName}</div>
      <div class="popup-detail">
        <span class="popup-label">Status</span>
        <span class="popup-value ${statusClass}">${statusLabel}</span>
      </div>
      <div class="popup-detail">
        <span class="popup-label">Length</span>
        <span class="popup-value">${lengthLabel}</span>
      </div>
      <div class="popup-detail">
        <span class="popup-label">Type</span>
        <span class="popup-value">${highwayType}</span>
      </div>
      <div class="popup-detail popup-meta">
        <span class="popup-label">Segment</span>
        <span class="popup-value segment-id">${segmentId}</span>
      </div>
    </div>
  `;
}

function formatStatus(statusKey) {
  if (statusKey === "driven") return "Driven";
  if (statusKey === "undriven") return "Undriven";
  if (statusKey === "undriveable") return "Undriveable";
  return "Unknown";
}

function formatSegmentLength(lengthMiles) {
  const miles = Number(lengthMiles);
  if (!Number.isFinite(miles)) {
    return "Unknown";
  }
  return `${miles.toFixed(2)} mi`;
}

function formatHighwayType(type) {
  if (!type) return "Unknown";
  const normalized = String(type).replace(/_/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function applyMapFilter(filter) {
  if (!map) return;

  currentMapFilter = filter;

  STREET_LAYERS.forEach((layerId) => {
    if (!map.getLayer(layerId)) return;

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
  window.notificationManager?.show(message, type);
}

function formatMiles(miles) {
  if (miles === null || miles === undefined) return "0 mi";
  return `${miles.toFixed(2)} mi`;
}

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Make functions available globally for onclick handlers
window.viewArea = viewArea;
window.deleteArea = deleteArea;
window.rebuildArea = rebuildArea;
window.recalculateCoverage = recalculateCoverage;
