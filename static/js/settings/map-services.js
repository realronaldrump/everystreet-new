/**
 * Map Services Tab - Settings Page
 *
 * Manages:
 * - Service health monitoring (Nominatim, Valhalla)
 * - Region browsing and downloading from Geofabrik
 * - Build job tracking
 */

const API_BASE = "/api/map-data";

// State
let selectedRegion = null;
let currentRegionPath = [];
let healthCheckInterval = null;
let jobPollInterval = null;
let deleteRegionId = null;

// =============================================================================
// Initialization
// =============================================================================

export function initMapServicesTab() {
  setupEventListeners();
  loadServiceHealth();
  loadRegions();
  loadActiveJobs();

  // Start health check polling (every 30 seconds)
  healthCheckInterval = setInterval(loadServiceHealth, 30000);

  // Start job polling (every 3 seconds when there are active jobs)
  jobPollInterval = setInterval(loadActiveJobs, 3000);
}

export function cleanupMapServicesTab() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (jobPollInterval) {
    clearInterval(jobPollInterval);
    jobPollInterval = null;
  }
}

function setupEventListeners() {
  // Health refresh button
  document
    .getElementById("refresh-health-btn")
    ?.addEventListener("click", refreshHealth);

  // Download region button
  document
    .getElementById("download-region-btn")
    ?.addEventListener("click", downloadSelectedRegion);

  // Delete region confirmation
  document
    .getElementById("confirm-delete-region-btn")
    ?.addEventListener("click", confirmDeleteRegion);

  // Region browser navigation
  document
    .getElementById("region-breadcrumb")
    ?.addEventListener("click", handleBreadcrumbClick);
  document
    .getElementById("region-list")
    ?.addEventListener("click", handleRegionClick);

  // Load regions when modal opens
  const addRegionModal = document.getElementById("addRegionModal");
  addRegionModal?.addEventListener("show.bs.modal", () => {
    currentRegionPath = [];
    selectedRegion = null;
    updateSelectedRegionUI();
    loadGeofabrikRegions();
  });
}

// =============================================================================
// Service Health
// =============================================================================

async function loadServiceHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();

    updateHealthCard("nominatim", data.nominatim);
    updateHealthCard("valhalla", data.valhalla);
  } catch (error) {
    console.error("Failed to load service health:", error);
  }
}

function updateHealthCard(service, health) {
  const badge = document.getElementById(`${service}-status-badge`);
  const responseTime = document.getElementById(`${service}-response-time`);
  const lastCheck = document.getElementById(`${service}-last-check`);
  const errorDiv = document.getElementById(`${service}-error`);
  const versionSpan = document.getElementById(`${service}-version`);
  const tileCountSpan = document.getElementById(`${service}-tile-count`);

  if (health.healthy) {
    badge.className = "badge bg-success";
    badge.textContent = "Healthy";
    errorDiv?.classList.add("d-none");
  } else {
    badge.className = "badge bg-danger";
    badge.textContent = "Unhealthy";
    if (errorDiv && health.error) {
      errorDiv.textContent = health.error;
      errorDiv.classList.remove("d-none");
    }
  }

  if (responseTime) {
    responseTime.textContent = health.response_time_ms
      ? `${health.response_time_ms.toFixed(0)}ms`
      : "--";
  }

  if (lastCheck && health.last_check) {
    lastCheck.textContent = formatRelativeTime(health.last_check);
  }

  if (versionSpan && health.version) {
    versionSpan.textContent = health.version;
  }

  if (tileCountSpan && health.tile_count !== undefined) {
    tileCountSpan.textContent =
      health.tile_count !== null ? health.tile_count.toLocaleString() : "--";
  }
}

async function refreshHealth() {
  const btn = document.getElementById("refresh-health-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';

  try {
    await fetch(`${API_BASE}/health/refresh`, { method: "POST" });
    await loadServiceHealth();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh Health';
  }
}

// =============================================================================
// Region Management
// =============================================================================

async function loadRegions() {
  const tbody = document.getElementById("regions-table-body");
  if (!tbody) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/regions`);
    const data = await response.json();

    // Remove loading row
    const loadingRow = document.getElementById("regions-loading-row");
    if (loadingRow) {
      loadingRow.remove();
    }

    if (!data.regions || data.regions.length === 0) {
      tbody.innerHTML = `
        <tr id="no-regions-row">
          <td colspan="6" class="text-center text-muted py-4">
            No regions configured. Click "Add Region" to download OSM data.
          </td>
        </tr>
      `;
      return;
    }

    // Remove no-regions row if it exists
    const noRegionsRow = document.getElementById("no-regions-row");
    if (noRegionsRow) {
      noRegionsRow.remove();
    }

    tbody.innerHTML = data.regions
      .map(
        (region) => `
      <tr data-region-id="${region.id}">
        <td>
          <strong>${escapeHtml(region.display_name)}</strong>
          <div class="small text-muted">${escapeHtml(region.name)}</div>
        </td>
        <td>${region.file_size_mb ? `${region.file_size_mb.toFixed(1)} MB` : "--"}</td>
        <td>${renderStatusBadge(region.status)}</td>
        <td>${renderStatusBadge(region.nominatim_status)}</td>
        <td>${renderStatusBadge(region.valhalla_status)}</td>
        <td>
          <div class="btn-group btn-group-sm">
            ${renderRegionActions(region)}
          </div>
        </td>
      </tr>
    `,
      )
      .join("");
  } catch (error) {
    console.error("Failed to load regions:", error);
    const loadingRow = document.getElementById("regions-loading-row");
    if (loadingRow) {
      loadingRow.innerHTML = `
        <td colspan="6" class="text-center text-danger py-4">
          Failed to load regions. <a href="#" onclick="window.mapServices?.loadRegions()">Retry</a>
        </td>
      `;
    }
  }
}

function renderStatusBadge(status) {
  const configs = {
    not_downloaded: {
      class: "secondary",
      icon: "cloud-download-alt",
      text: "Not Downloaded",
    },
    downloading: {
      class: "info",
      icon: "spinner fa-spin",
      text: "Downloading",
    },
    downloaded: { class: "primary", icon: "check", text: "Downloaded" },
    not_built: { class: "secondary", icon: "hammer", text: "Not Built" },
    building: { class: "warning", icon: "cog fa-spin", text: "Building" },
    building_nominatim: {
      class: "warning",
      icon: "cog fa-spin",
      text: "Building",
    },
    building_valhalla: {
      class: "warning",
      icon: "cog fa-spin",
      text: "Building",
    },
    ready: { class: "success", icon: "check-circle", text: "Ready" },
    error: { class: "danger", icon: "exclamation-triangle", text: "Error" },
  };

  const config = configs[status] || configs.not_downloaded;
  return `<span class="badge bg-${config.class}"><i class="fas fa-${config.icon} me-1"></i>${config.text}</span>`;
}

function renderRegionActions(region) {
  const actions = [];

  // Build actions for downloaded regions
  if (
    region.status === "downloaded" ||
    region.status === "ready" ||
    region.status === "error"
  ) {
    if (region.nominatim_status !== "ready") {
      actions.push(`
        <button class="btn btn-outline-info" onclick="window.mapServices.buildNominatim('${region.id}')" title="Build Nominatim">
          <i class="fas fa-search-location"></i>
        </button>
      `);
    }
    if (region.valhalla_status !== "ready") {
      actions.push(`
        <button class="btn btn-outline-warning" onclick="window.mapServices.buildValhalla('${region.id}')" title="Build Valhalla">
          <i class="fas fa-route"></i>
        </button>
      `);
    }
  }

  // Delete action (always available)
  actions.push(`
    <button class="btn btn-outline-danger" onclick="window.mapServices.deleteRegion('${region.id}', '${escapeHtml(region.display_name)}')" title="Delete">
      <i class="fas fa-trash"></i>
    </button>
  `);

  return actions.join("");
}

// =============================================================================
// Geofabrik Browser
// =============================================================================

async function loadGeofabrikRegions(parent = "") {
  const regionList = document.getElementById("region-list");
  if (!regionList) {
    return;
  }

  regionList.innerHTML = `
    <div class="text-center py-3">
      <div class="spinner-border spinner-border-sm me-2" role="status"></div>
      Loading regions...
    </div>
  `;

  try {
    const url = parent
      ? `${API_BASE}/geofabrik/regions?parent=${encodeURIComponent(parent)}`
      : `${API_BASE}/geofabrik/regions`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.regions || data.regions.length === 0) {
      regionList.innerHTML = `
        <div class="text-center text-muted py-3">
          No sub-regions available.
        </div>
      `;
      return;
    }

    // Sort regions: folders first, then by name
    const sortedRegions = data.regions.sort((a, b) => {
      if (a.has_children && !b.has_children) {
        return -1;
      }
      if (!a.has_children && b.has_children) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    regionList.innerHTML = sortedRegions
      .map(
        (region) => `
      <div class="region-item d-flex justify-content-between align-items-center p-2 border-bottom"
           data-region-id="${escapeHtml(region.id)}"
           data-region-name="${escapeHtml(region.name)}"
           data-region-size="${region.pbf_size_mb || ""}"
           data-region-url="${escapeHtml(region.pbf_url || "")}"
           data-has-children="${region.has_children}">
        <div class="d-flex align-items-center">
          ${region.has_children ? '<i class="fas fa-folder text-warning me-2"></i>' : '<i class="fas fa-map text-info me-2"></i>'}
          <span>${escapeHtml(region.name)}</span>
        </div>
        <div class="text-muted small">
          ${region.pbf_size_mb ? `${region.pbf_size_mb.toFixed(1)} MB` : ""}
          ${region.has_children ? '<i class="fas fa-chevron-right ms-2"></i>' : ""}
        </div>
      </div>
    `,
      )
      .join("");

    // Update breadcrumb
    updateBreadcrumb();
  } catch (error) {
    console.error("Failed to load Geofabrik regions:", error);
    regionList.innerHTML = `
      <div class="text-center text-danger py-3">
        Failed to load regions. Please try again.
      </div>
    `;
  }
}

function handleBreadcrumbClick(event) {
  const link = event.target.closest("a[data-region]");
  if (!link) {
    return;
  }

  event.preventDefault();
  const { region } = link.dataset;

  // Update path
  if (region === "") {
    currentRegionPath = [];
  } else {
    const index = currentRegionPath.indexOf(region);
    if (index >= 0) {
      currentRegionPath = currentRegionPath.slice(0, index + 1);
    }
  }

  // Clear selection when navigating
  selectedRegion = null;
  updateSelectedRegionUI();

  // Load regions for this path
  loadGeofabrikRegions(currentRegionPath.join("/"));
}

function handleRegionClick(event) {
  const item = event.target.closest(".region-item");
  if (!item) {
    return;
  }

  const { regionId } = item.dataset;
  const { regionName } = item.dataset;
  const { regionSize } = item.dataset;
  const { regionUrl } = item.dataset;
  const hasChildren = item.dataset.hasChildren === "true";

  if (hasChildren) {
    // Navigate into folder
    currentRegionPath.push(regionId);
    selectedRegion = null;
    updateSelectedRegionUI();
    loadGeofabrikRegions(currentRegionPath.join("/"));
  } else {
    // Select this region for download
    selectedRegion = {
      id: regionId,
      name: regionName,
      size: regionSize,
      url: regionUrl,
    };
    updateSelectedRegionUI();

    // Highlight selected item
    document.querySelectorAll(".region-item").forEach((el) => {
      el.classList.remove("bg-primary", "text-white");
    });
    item.classList.add("bg-primary", "text-white");
  }
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById("region-breadcrumb");
  if (!breadcrumb) {
    return;
  }

  const items = [{ id: "", name: "World" }];

  let path = "";
  for (const segment of currentRegionPath) {
    path = path ? `${path}/${segment}` : segment;
    items.push({
      id: path,
      name: segment.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
    });
  }

  const ol = breadcrumb.querySelector("ol");
  if (ol) {
    ol.innerHTML = items
      .map(
        (item, index) => `
      <li class="breadcrumb-item ${index === items.length - 1 ? "active" : ""}">
        ${index === items.length - 1 ? item.name : `<a href="#" data-region="${item.id}">${item.name}</a>`}
      </li>
    `,
      )
      .join("");
  }
}

function updateSelectedRegionUI() {
  const infoDiv = document.getElementById("selected-region-info");
  const downloadBtn = document.getElementById("download-region-btn");
  const nameSpan = document.getElementById("selected-region-name");
  const sizeSpan = document.getElementById("selected-region-size");
  const idSpan = document.getElementById("selected-region-id");

  if (selectedRegion) {
    infoDiv?.classList.remove("d-none");
    downloadBtn.disabled = false;
    if (nameSpan) {
      nameSpan.textContent = selectedRegion.name;
    }
    if (sizeSpan) {
      sizeSpan.textContent = selectedRegion.size
        ? `${parseFloat(selectedRegion.size).toFixed(1)} MB`
        : "Unknown";
    }
    if (idSpan) {
      idSpan.textContent = selectedRegion.id;
    }
  } else {
    infoDiv?.classList.add("d-none");
    downloadBtn.disabled = true;
  }
}

// =============================================================================
// Download & Build Actions
// =============================================================================

async function downloadSelectedRegion() {
  if (!selectedRegion) {
    return;
  }

  const btn = document.getElementById("download-region-btn");
  btn.disabled = true;
  btn.innerHTML =
    '<i class="fas fa-spinner fa-spin"></i> Starting download & build...';

  try {
    // Use the unified download-and-build endpoint for one-click setup
    const response = await fetch(`${API_BASE}/regions/download-and-build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        geofabrik_id: selectedRegion.id,
        display_name: selectedRegion.name,
      }),
    });

    const data = await response.json();

    if (data.success) {
      // Close modal and refresh
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("addRegionModal"),
      );
      modal?.hide();

      window.notificationManager?.show(
        `Download & build started for ${selectedRegion.name}. ` +
          "This will download OSM data, then build Nominatim and Valhalla automatically.",
        "success",
      );

      // Refresh regions and jobs
      await loadRegions();
      await loadActiveJobs();
    } else {
      window.notificationManager?.show(
        data.detail || "Failed to start download",
        "danger",
      );
    }
  } catch (error) {
    console.error("Failed to start download:", error);
    window.notificationManager?.show("Failed to start download", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> Download & Build';
  }
}

async function buildNominatim(regionId) {
  try {
    const response = await fetch(
      `${API_BASE}/regions/${regionId}/build/nominatim`,
      {
        method: "POST",
      },
    );

    const data = await response.json();

    if (data.success) {
      window.notificationManager?.show("Nominatim build started", "success");
      await loadRegions();
      await loadActiveJobs();
    } else {
      window.notificationManager?.show(
        data.detail || "Failed to start build",
        "danger",
      );
    }
  } catch (error) {
    console.error("Failed to start Nominatim build:", error);
    window.notificationManager?.show("Failed to start build", "danger");
  }
}

async function buildValhalla(regionId) {
  try {
    const response = await fetch(
      `${API_BASE}/regions/${regionId}/build/valhalla`,
      {
        method: "POST",
      },
    );

    const data = await response.json();

    if (data.success) {
      window.notificationManager?.show("Valhalla build started", "success");
      await loadRegions();
      await loadActiveJobs();
    } else {
      window.notificationManager?.show(
        data.detail || "Failed to start build",
        "danger",
      );
    }
  } catch (error) {
    console.error("Failed to start Valhalla build:", error);
    window.notificationManager?.show("Failed to start build", "danger");
  }
}

function deleteRegion(regionId, regionName) {
  deleteRegionId = regionId;
  document.getElementById("delete-region-name").textContent = regionName;
  const modal = new bootstrap.Modal(
    document.getElementById("deleteRegionModal"),
  );
  modal.show();
}

async function confirmDeleteRegion() {
  if (!deleteRegionId) {
    return;
  }

  const btn = document.getElementById("confirm-delete-region-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

  try {
    const response = await fetch(`${API_BASE}/regions/${deleteRegionId}`, {
      method: "DELETE",
    });

    const data = await response.json();

    if (data.success) {
      window.notificationManager?.show("Region deleted", "success");

      // Close modal
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("deleteRegionModal"),
      );
      modal?.hide();

      // Refresh
      await loadRegions();
    } else {
      window.notificationManager?.show(
        data.detail || "Failed to delete region",
        "danger",
      );
    }
  } catch (error) {
    console.error("Failed to delete region:", error);
    window.notificationManager?.show("Failed to delete region", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-trash"></i> Delete';
    deleteRegionId = null;
  }
}

// =============================================================================
// Active Jobs
// =============================================================================

async function loadActiveJobs() {
  const jobsList = document.getElementById("active-jobs-list");
  const noJobsMsg = document.getElementById("no-active-jobs");
  if (!jobsList) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/jobs?active_only=true`);
    const data = await response.json();

    if (!data.jobs || data.jobs.length === 0) {
      if (noJobsMsg) {
        noJobsMsg.style.display = "block";
      }
      // Remove any job cards
      jobsList.querySelectorAll(".job-card").forEach((el) => el.remove());
      return;
    }

    if (noJobsMsg) {
      noJobsMsg.style.display = "none";
    }

    // Update or create job cards
    for (const job of data.jobs) {
      let card = jobsList.querySelector(`[data-job-id="${job.id}"]`);

      if (!card) {
        card = document.createElement("div");
        card.className = "job-card card bg-darker mb-2";
        card.dataset.jobId = job.id;
        jobsList.appendChild(card);
      }

      card.innerHTML = `
        <div class="card-body py-2">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div>
              <strong>${formatJobType(job.job_type)}</strong>
              <span class="badge bg-${job.status === "running" ? "primary" : "secondary"} ms-2">${job.status}</span>
            </div>
            <button class="btn btn-sm btn-outline-danger" onclick="window.mapServices.cancelJob('${job.id}')" title="Cancel">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="progress mb-2" style="height: 20px;">
            <div class="progress-bar progress-bar-striped progress-bar-animated"
                 role="progressbar"
                 style="width: ${job.progress}%"
                 aria-valuenow="${job.progress}"
                 aria-valuemin="0"
                 aria-valuemax="100">
              ${job.progress.toFixed(0)}%
            </div>
          </div>
          <div class="small text-muted">${escapeHtml(job.message || job.stage)}</div>
        </div>
      `;
    }

    // Remove cards for jobs that are no longer active
    const activeJobIds = new Set(data.jobs.map((j) => j.id));
    jobsList.querySelectorAll(".job-card").forEach((card) => {
      if (!activeJobIds.has(card.dataset.jobId)) {
        card.remove();
      }
    });

    // Also refresh regions to show updated status
    await loadRegions();
  } catch (error) {
    console.error("Failed to load active jobs:", error);
  }
}

async function cancelJob(jobId) {
  try {
    const response = await fetch(`${API_BASE}/jobs/${jobId}`, {
      method: "DELETE",
    });

    const data = await response.json();

    if (data.success) {
      window.notificationManager?.show("Job cancelled", "success");
      await loadActiveJobs();
      await loadRegions();
    } else {
      window.notificationManager?.show(
        data.detail || "Failed to cancel job",
        "danger",
      );
    }
  } catch (error) {
    console.error("Failed to cancel job:", error);
    window.notificationManager?.show("Failed to cancel job", "danger");
  }
}

// =============================================================================
// Utilities
// =============================================================================

function formatJobType(type) {
  const types = {
    download: "Download",
    download_and_build_all: "Download & Full Build",
    build_nominatim: "Nominatim Build",
    build_valhalla: "Valhalla Build",
    build_all: "Full Build",
  };
  return types[type] || type;
}

function formatRelativeTime(isoString) {
  if (!isoString) {
    return "--";
  }

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  if (!text) {
    return "";
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// Export for global access
// =============================================================================

// Make functions available globally for onclick handlers
window.mapServices = {
  loadRegions,
  buildNominatim,
  buildValhalla,
  deleteRegion,
  cancelJob,
};

export default {
  initMapServicesTab,
  cleanupMapServicesTab,
};
