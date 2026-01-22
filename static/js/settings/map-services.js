/**
 * Map Services Tab - Settings Page
 *
 * Provides automatic map coverage detection and seamless provisioning.
 * States are automatically detected from trip data and map services
 * are configured without manual intervention.
 */

import apiClient from "../modules/core/api-client.js";
import notificationManager from "../modules/ui/notifications.js";

const MAP_SERVICES_API = "/api/map-services";

let lastStatus = null;
let pollTimer = null;

export function initMapServicesTab() {
  refreshAutoStatus();
}

export function cleanupMapServicesTab() {
  stopPolling();
}

export default {
  initMapServicesTab,
  cleanupMapServicesTab,
};

/**
 * Start polling for status updates
 */
function startPolling(intervalMs = 4000) {
  stopPolling();
  pollTimer = setInterval(refreshAutoStatus, intervalMs);
}

/**
 * Stop polling
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Refresh the automatic provisioning status
 */
async function refreshAutoStatus() {
  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/auto-status`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.detail || "Unable to load map status.");
    }
    lastStatus = data;
    renderAutoStatus(data);
    adjustPolling(data);
  } catch (error) {
    renderError(error.message);
  }
}

/**
 * Adjust polling based on current status
 */
function adjustPolling(status) {
  if (status.is_building) {
    if (!pollTimer) {
      startPolling(4000);
    }
  } else {
    stopPolling();
  }
}

/**
 * Render the automatic status UI
 */
function renderAutoStatus(status) {
  const container = document.getElementById("map-services-content");
  if (!container) return;

  container.innerHTML = `
    <div class="map-services-auto">
      ${renderStatusHeader(status)}
      ${renderMapboxConfig()}
      ${renderServicesStatus(status)}
      ${renderStatesCoverage(status)}
      ${renderProgressSection(status)}
      ${renderActions(status)}
    </div>
  `;

  attachEventListeners();
  loadMapboxToken(); // Load the token when rendering
}

/**
 * Render Mapbox configuration section
 */
function renderMapboxConfig() {
  return `
    <div class="mapbox-config-section mb-4">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <label for="mapbox-token-input" class="form-label mb-0 fw-bold">Mapbox Access Token</label>
        <button class="btn btn-sm btn-outline-primary" id="save-mapbox-token-btn" disabled>
          Save Token
        </button>
      </div>
      <div class="input-group">
        <span class="input-group-text"><i class="fas fa-key"></i></span>
        <input type="password" class="form-control" id="mapbox-token-input" placeholder="pk.eyJ..." />
        <button class="btn btn-outline-secondary" type="button" id="toggle-mapbox-token">
          <i class="fas fa-eye"></i>
        </button>
      </div>
      <div class="form-text">
        Required for map tiles and static images. Changes take effect immediately.
      </div>
    </div>
  `;
}

/**
 * Load Mapbox token from settings
 */
async function loadMapboxToken() {
  try {
    const response = await apiClient.get("/api/app_settings");
    const tokenInput = document.getElementById("mapbox-token-input");
    if (tokenInput && response.mapbox_token) {
      tokenInput.value = response.mapbox_token;
    }
  } catch (error) {
    console.error("Failed to load Mapbox token", error);
  }
}

/**
 * Save Mapbox token
 */
async function saveMapboxToken() {
  const tokenInput = document.getElementById("mapbox-token-input");
  const saveBtn = document.getElementById("save-mapbox-token-btn");
  if (!tokenInput || !saveBtn) return;

  const token = tokenInput.value.trim();
  if (!token) return;

  try {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    
    await apiClient.post("/api/app_settings", { mapbox_token: token });
    
    notificationManager.show("Mapbox token saved successfully", "success");
    saveBtn.innerHTML = "Saved!";
    setTimeout(() => {
      saveBtn.innerHTML = "Save Token";
      saveBtn.disabled = false;
    }, 2000);
  } catch (error) {
    notificationManager.show("Failed to save Mapbox token", "danger");
    saveBtn.innerHTML = "Save Token";
    saveBtn.disabled = false;
  }
}

/**
 * Render the main status header
 */
function renderStatusHeader(status) {
  const { is_ready, is_building, status: rawStatus, message } = status;

  let icon, label, tone;
  if (is_ready) {
    icon = "fa-check-circle";
    label = "Map Services Ready";
    tone = "success";
  } else if (is_building) {
    icon = "fa-spinner fa-spin";
    label = "Setting Up";
    tone = "info";
  } else if (rawStatus === "error") {
    icon = "fa-exclamation-triangle";
    label = "Setup Issue";
    tone = "warning";
  } else {
    icon = "fa-map";
    label = "Map Services";
    tone = "neutral";
  }

  return `
    <div class="map-services-header" data-tone="${tone}">
      <div class="map-services-header-icon">
        <i class="fas ${icon}"></i>
      </div>
      <div class="map-services-header-content">
        <h3 class="map-services-header-title">${label}</h3>
        <p class="map-services-header-message">${escapeHtml(message || getDefaultMessage(status))}</p>
      </div>
    </div>
  `;
}

/**
 * Get default message based on status
 */
function getDefaultMessage(status) {
  if (status.is_ready) {
    return "Address lookup and route planning are working.";
  }
  if (status.is_building) {
    return "Downloading and building map data...";
  }
  if (status.needs_provisioning) {
    return "New trip areas detected that need map data.";
  }
  if (status.configured_states?.length === 0) {
    return "No map data configured yet. Trip areas will be detected automatically.";
  }
  return "Waiting for trips to detect coverage areas.";
}

/**
 * Render services status indicators
 */
function renderServicesStatus(status) {
  const services = status.services || {};
  const geocoding = services.geocoding || {};
  const routing = services.routing || {};

  return `
    <div class="map-services-indicators">
      <div class="service-indicator ${geocoding.ready ? "is-ready" : "is-pending"}">
        <i class="fas ${geocoding.ready ? "fa-check" : "fa-clock"}"></i>
        <span>Address Lookup</span>
        ${geocoding.error && !geocoding.ready ? `<small class="service-error">${escapeHtml(truncate(geocoding.error, 40))}</small>` : ""}
      </div>
      <div class="service-indicator ${routing.ready ? "is-ready" : "is-pending"}">
        <i class="fas ${routing.ready ? "fa-check" : "fa-clock"}"></i>
        <span>Route Planning</span>
        ${routing.error && !routing.ready ? `<small class="service-error">${escapeHtml(truncate(routing.error, 40))}</small>` : ""}
      </div>
    </div>
  `;
}

/**
 * Render states coverage section
 */
function renderStatesCoverage(status) {
  const {
    configured_state_names = [],
    configured_size_mb = 0,
    missing_state_details = [],
    missing_size_mb = 0,
    detected_states = [],
  } = status;

  // Don't show if no data at all
  if (
    configured_state_names.length === 0 &&
    missing_state_details.length === 0 &&
    detected_states.length === 0
  ) {
    return `
      <div class="map-services-empty">
        <i class="fas fa-route"></i>
        <p>No trip data detected yet. Map coverage will be configured automatically as you add trips.</p>
      </div>
    `;
  }

  let html = '<div class="map-coverage-section">';

  // Configured states (ready)
  if (configured_state_names.length > 0) {
    html += `
      <div class="coverage-group coverage-ready">
        <div class="coverage-group-header">
          <i class="fas fa-check-circle"></i>
          <span>Covered Areas</span>
          <span class="coverage-size">${formatSize(configured_size_mb)}</span>
        </div>
        <div class="coverage-states">
          ${configured_state_names.map((name) => `<span class="state-chip is-ready">${escapeHtml(name)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  // Missing states (detected but not configured)
  if (missing_state_details.length > 0 && !status.is_building) {
    html += `
      <div class="coverage-group coverage-pending">
        <div class="coverage-group-header">
          <i class="fas fa-clock"></i>
          <span>Pending Areas</span>
          <span class="coverage-size">${formatSize(missing_size_mb)}</span>
        </div>
        <div class="coverage-states">
          ${missing_state_details.map((s) => `<span class="state-chip is-pending">${escapeHtml(s.name)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  html += "</div>";
  return html;
}

/**
 * Render progress section during builds
 */
function renderProgressSection(status) {
  if (!status.is_building) return "";

  const progress = Math.round(status.progress || 0);
  const message = status.message || "Processing...";

  return `
    <div class="map-services-progress">
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${progress}%"></div>
      </div>
      <div class="progress-info">
        <span class="progress-message">${escapeHtml(message)}</span>
        <span class="progress-percent">${progress}%</span>
      </div>
    </div>
  `;
}

/**
 * Render action buttons
 */
function renderActions(status) {
  const { is_building, needs_provisioning, last_error, retry_count } = status;

  let buttons = [];

  if (is_building) {
    buttons.push(`
      <button class="btn btn-secondary" id="cancel-setup-btn">
        <i class="fas fa-times"></i> <span class="btn-text">Cancel</span>
      </button>
    `);
  } else if (needs_provisioning) {
    buttons.push(`
      <button class="btn btn-primary" id="provision-btn">
        <i class="fas fa-download"></i> <span class="btn-text">Download Map Data</span>
      </button>
    `);
  }

  // Show retry button if there was an error
  if (last_error && !is_building && !needs_provisioning) {
    buttons.push(`
      <button class="btn btn-secondary" id="retry-btn">
        <i class="fas fa-redo"></i> <span class="btn-text">Retry</span>
      </button>
    `);
  }

  // Refresh button
  buttons.push(`
    <button class="btn btn-ghost" id="refresh-btn" title="Refresh status">
      <i class="fas fa-sync-alt"></i>
    </button>
  `);

  if (buttons.length === 0) return "";

  return `
    <div class="map-services-actions">
      <div class="action-buttons">${buttons.join("")}</div>
      ${
        last_error
          ? `
        <div class="map-services-error-message">
          <i class="fas fa-exclamation-circle"></i>
          <span>${escapeHtml(truncate(last_error, 100))}</span>
          ${retry_count > 0 ? `<small>(Retry ${retry_count}/3)</small>` : ""}
        </div>
      `
          : ""
      }
    </div>
  `;
}

/**
 * Attach event listeners to buttons
 */
function attachEventListeners() {
  document.getElementById("provision-btn")?.addEventListener("click", triggerProvisioning);
  document.getElementById("cancel-setup-btn")?.addEventListener("click", cancelSetup);
  document.getElementById("retry-btn")?.addEventListener("click", triggerProvisioning);
  document.getElementById("refresh-btn")?.addEventListener("click", handleRefresh);

  // Mapbox token listeners
  const tokenInput = document.getElementById("mapbox-token-input");
  const saveBtn = document.getElementById("save-mapbox-token-btn");
  const toggleBtn = document.getElementById("toggle-mapbox-token");

  if (tokenInput) {
    tokenInput.addEventListener("input", () => {
      if (saveBtn) saveBtn.disabled = false;
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", saveMapboxToken);
  }

  if (toggleBtn && tokenInput) {
    toggleBtn.addEventListener("click", () => {
      const type = tokenInput.getAttribute("type") === "password" ? "text" : "password";
      tokenInput.setAttribute("type", type);
      toggleBtn.querySelector("i").classList.toggle("fa-eye");
      toggleBtn.querySelector("i").classList.toggle("fa-eye-slash");
    });
  }
}

/**
 * Handle refresh button click
 */
async function handleRefresh() {
  const btn = document.getElementById("refresh-btn");
  if (btn) {
    btn.disabled = true;
    btn.querySelector("i")?.classList.add("fa-spin");
  }
  try {
    await refreshAutoStatus();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.querySelector("i")?.classList.remove("fa-spin");
    }
  }
}

/**
 * Trigger automatic provisioning
 */
async function triggerProvisioning() {
  const btn = document.getElementById("provision-btn") || document.getElementById("retry-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
  }

  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/auto-provision`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Failed to start provisioning");
    }

    notificationManager.show("Map setup started.", "success");
    await refreshAutoStatus();
  } catch (error) {
    notificationManager.show(error.message, "danger");
    await refreshAutoStatus();
  }
}

/**
 * Cancel ongoing setup
 */
async function cancelSetup() {
  const btn = document.getElementById("cancel-setup-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling...';
  }

  try {
    await apiClient.raw(`${MAP_SERVICES_API}/cancel`, { method: "POST" });
    notificationManager.show("Setup cancelled.", "success");
    await refreshAutoStatus();
  } catch (error) {
    notificationManager.show(error.message || "Unable to cancel.", "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-times"></i> <span class="btn-text">Cancel</span>';
    }
  }
}

/**
 * Render error state
 */
function renderError(message) {
  const container = document.getElementById("map-services-content");
  if (!container) return;

  container.innerHTML = `
    <div class="map-services-error-state">
      <i class="fas fa-exclamation-triangle"></i>
      <p>${escapeHtml(message)}</p>
      <button class="btn btn-secondary" id="error-retry-btn">
        <i class="fas fa-redo"></i> Retry
      </button>
    </div>
  `;

  document.getElementById("error-retry-btn")?.addEventListener("click", refreshAutoStatus);
}

/**
 * Format size in MB to human readable
 */
function formatSize(mb) {
  if (!mb || mb === 0) return "";
  if (mb >= 1000) {
    return `${(mb / 1000).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
