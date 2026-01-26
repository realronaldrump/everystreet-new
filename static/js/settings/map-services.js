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

let _lastStatus = null;
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
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error("[MapServices] Failed to parse auto-status response:", parseError, "Raw:", text);
      throw new Error("Invalid response from server");
    }
    if (!response.ok) {
      throw new Error(data?.detail || "Unable to load map status.");
    }
    console.log("[MapServices] Auto-status loaded:", data);
    _lastStatus = data;
    renderAutoStatus(data);
    adjustPolling(data);
  } catch (error) {
    console.error("[MapServices] refreshAutoStatus error:", error);
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
  if (!container) {
    return;
  }

  container.innerHTML = `
    <div class="map-services-auto">
      ${renderStatusHeader(status)}
      ${renderCredentialsCta()}
      ${renderServicesStatus(status)}
      ${renderStatesCoverage(status)}
      ${renderProgressSection(status)}
      ${renderActions(status)}
    </div>
  `;

  attachEventListeners();
}

/**
 * Render credentials CTA
 */
function renderCredentialsCta() {
  return `
    <div class="map-services-credentials">
      <div class="map-services-credentials-card">
        <div class="map-services-credentials-copy">
          <strong>Mapbox token</strong>
          <span>Managed in Settings → Credentials.</span>
        </div>
        <a class="btn btn-sm btn-outline-primary" href="/settings#credentials" data-es-no-spa>
          Manage credentials
        </a>
      </div>
    </div>
  `;
}

/**
 * Render the main status header
 */
function renderStatusHeader(status) {
  const { is_ready, is_building, status: rawStatus, message } = status;

  let icon,
label,
tone;
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
    configured_state_names.length === 0
    && missing_state_details.length === 0
    && detected_states.length === 0
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
  if (!status.is_building) {
    return "";
  }

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
 *
 * Button design:
 * - "Download Map Data" (primary): Starts initial provisioning
 * - "Retry Setup" (warning): Retries after an error - distinct from refresh
 * - "Check Status" (muted link): Manual status refresh - icon only, subtle
 */
function renderActions(status) {
  const {
    is_building,
    needs_provisioning,
    last_error,
    retry_count,
    max_retries,
  } = status;
  const retryCap = typeof max_retries === "number" && max_retries > 0 ? max_retries : 3;
  const displayAttempt = Math.min(retry_count || 0, retryCap);

  const buttons = [];

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

  // Show retry button if there was an error (distinct from refresh)
  if (last_error && !is_building && !needs_provisioning) {
    buttons.push(`
      <button class="btn btn-warning" id="retry-btn" title="Retry the failed setup">
        <i class="fas fa-redo-alt"></i> <span class="btn-text">Retry Setup</span>
      </button>
    `);
  }

  // Refresh button - only show when not building (auto-polls during build)
  // Use muted styling to differentiate from action buttons
  if (!is_building) {
    buttons.push(`
      <button class="btn btn-link btn-sm text-muted" id="refresh-btn" title="Check current status">
        <i class="fas fa-sync"></i>
      </button>
    `);
  }

  if (buttons.length === 0) {
    return "";
  }

  return `
    <div class="map-services-actions">
      <div class="action-buttons d-flex gap-2 align-items-center">${buttons.join("")}</div>
      ${
        last_error
          ? `
        <div class="map-services-error-message mt-2">
          <i class="fas fa-exclamation-circle text-warning"></i>
          <span>${escapeHtml(truncate(last_error, 100))}</span>
          ${
            retry_count > 0
              ? `<small class="text-muted ms-2">(Attempt ${displayAttempt}/${retryCap}${retry_count > retryCap ? ", attempts exceeded" : ""})</small>`
              : ""
          }
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
  document
    .getElementById("provision-btn")
    ?.addEventListener("click", triggerProvisioning);
  document.getElementById("cancel-setup-btn")?.addEventListener("click", cancelSetup);
  document.getElementById("retry-btn")?.addEventListener("click", triggerProvisioning);
  document.getElementById("refresh-btn")?.addEventListener("click", handleRefresh);
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
  console.log("[MapServices] triggerProvisioning called");
  const btn
    = document.getElementById("provision-btn") || document.getElementById("retry-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
  }

  try {
    console.log("[MapServices] Calling auto-provision API...");
    const response = await apiClient.raw(`${MAP_SERVICES_API}/auto-provision`, {
      method: "POST",
    });

    console.log("[MapServices] Response status:", response.status);
    const data = await response.json();
    console.log("[MapServices] Response data:", data);

    if (!response.ok) {
      throw new Error(data.detail || "Failed to start provisioning");
    }

    notificationManager.show("Map setup started.", "success");
    await refreshAutoStatus();
  } catch (error) {
    console.error("[MapServices] Error:", error);
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
      btn.innerHTML
        = '<i class="fas fa-times"></i> <span class="btn-text">Cancel</span>';
    }
  }
}

/**
 * Render error state
 */
function renderError(message) {
  const container = document.getElementById("map-services-content");
  if (!container) {
    return;
  }

  container.innerHTML = `
    <div class="map-services-error-state">
      <i class="fas fa-exclamation-triangle"></i>
      <p>${escapeHtml(message)}</p>
      <button class="btn btn-secondary" id="error-retry-btn">
        <i class="fas fa-redo"></i> Retry
      </button>
    </div>
  `;

  document
    .getElementById("error-retry-btn")
    ?.addEventListener("click", refreshAutoStatus);
}

/**
 * Format size in MB to human readable
 */
function formatSize(mb) {
  if (!mb || mb === 0) {
    return "";
  }
  if (mb >= 1000) {
    return `${(mb / 1000).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLen) {
  if (!str) {
    return "";
  }
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.substring(0, maxLen)}...`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) {
    return "";
  }
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
