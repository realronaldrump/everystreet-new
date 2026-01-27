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
const APP_SETTINGS_API = "/api/app_settings";

let _lastStatus = null;
let pollTimer = null;
let lastDbSample = null;
let _coverageSettings = null;

export function initMapServicesTab() {
  loadCoverageSettings();
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
    ensureMapServicesLayout();
    const response = await apiClient.raw(`${MAP_SERVICES_API}/auto-status`);
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error(
        "[MapServices] Failed to parse auto-status response:",
        parseError,
        "Raw:",
        text
      );
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
  const statusContainer = ensureMapServicesLayout();
  if (!statusContainer) {
    return;
  }

  statusContainer.innerHTML = `
    <div class="map-services-auto">
      ${renderStatusHeader(status)}
      ${renderServicesStatus(status)}
      ${renderStatesCoverage(status)}
      ${renderProgressSection(status)}
      ${renderActions(status)}
    </div>
  `;

  attachEventListeners();
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
  const build = status.build || {};
  const phase = build.phase || status.status;
  const phaseMessage = (status.message || "").trim();
  const isBuilding
    = status.is_building || status.status === "building" || status.status === "downloading";

  const geocodingIcon = geocoding.ready
    ? "fa-check"
    : isBuilding
      ? "fa-spinner fa-spin"
      : "fa-clock";
  const routingIcon = routing.ready
    ? "fa-check"
    : isBuilding
      ? "fa-spinner fa-spin"
      : "fa-clock";

  const geocodingError = !geocoding.ready && !isBuilding ? geocoding.error : null;
  const routingError = !routing.ready && !isBuilding ? routing.error : null;

  let geocodingNote = null;
  let routingNote = null;
  if (isBuilding) {
    if (phase === "building_geocoder") {
      geocodingNote = phaseMessage || "Importing map data...";
      routingNote = "Queued after geocoder";
    } else if (phase === "building_router") {
      geocodingNote = geocoding.ready ? "Ready" : "Geocoder ready";
      routingNote = phaseMessage || "Building routing tiles...";
    } else if (phase === "downloading") {
      geocodingNote = "Downloading extracts...";
      routingNote = "Downloading extracts...";
    } else {
      geocodingNote = "Preparing setup...";
      routingNote = "Preparing setup...";
    }
  }

  return `
    <div class="map-services-indicators">
      <div class="service-indicator ${geocoding.ready ? "is-ready" : "is-pending"}">
        <i class="fas ${geocodingIcon}"></i>
        <span>Address Lookup</span>
        ${geocodingError ? `<small class="service-error">${escapeHtml(truncate(geocodingError, 40))}</small>` : ""}
        ${!geocodingError && geocodingNote ? `<small class="service-note">${escapeHtml(geocodingNote)}</small>` : ""}
      </div>
      <div class="service-indicator ${routing.ready ? "is-ready" : "is-pending"}">
        <i class="fas ${routingIcon}"></i>
        <span>Route Planning</span>
        ${routingError ? `<small class="service-error">${escapeHtml(truncate(routingError, 40))}</small>` : ""}
        ${!routingError && routingNote ? `<small class="service-note">${escapeHtml(routingNote)}</small>` : ""}
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
    lastDbSample = null;
    return "";
  }

  const progress = clampNumber(status.progress || 0, 0, 100);
  const message = status.message || "Processing...";
  const build = status.build || {};
  const phase = build.phase || status.status || "building";
  const phaseLabel = getBuildPhaseLabel(phase);
  const rawPhaseProgress = Number(build.phase_progress);
  const phaseProgress = Number.isFinite(rawPhaseProgress) && rawPhaseProgress >= 0
    ? clampNumber(rawPhaseProgress, 0, 100)
    : null;
  const phasePercent = phaseProgress === null ? "—" : `${Math.round(phaseProgress)}%`;
  const startedAt = build.started_at;
  const lastProgressAt = build.last_progress_at || status.last_updated;
  const elapsed = startedAt ? formatDuration(Date.now() - Date.parse(startedAt)) : "—";
  const lastUpdate = lastProgressAt ? timeAgo(lastProgressAt) : "—";
  const isStale = lastProgressAt
    ? Date.now() - Date.parse(lastProgressAt) > 90 * 1000
    : false;
  const geocoderProgress = status.geocoder_progress || {};
  const dbSizeBytes = Number(geocoderProgress.db_size_bytes);
  const dbSizeLabel = Number.isFinite(dbSizeBytes) ? formatBytes(dbSizeBytes) : null;
  const dbSizeAt = geocoderProgress.db_size_at;
  const activityDetail = buildActivityDetail(geocoderProgress);

  let dbDeltaLabel = null;
  if (Number.isFinite(dbSizeBytes)) {
    const sampleAt = dbSizeAt ? Date.parse(dbSizeAt) : Date.now();
    if (lastDbSample && dbSizeBytes >= lastDbSample.bytes) {
      const delta = dbSizeBytes - lastDbSample.bytes;
      if (delta > 0) {
        dbDeltaLabel = `+${formatBytes(delta)}`;
      }
    }
    lastDbSample = { bytes: dbSizeBytes, at: sampleAt };
  }

  return `
    <div class="map-services-progress is-active">
      <div class="progress-block">
        <div class="progress-label">
          <span>Overall Progress</span>
          <span class="progress-percent">${Math.round(progress)}%</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar" style="width: ${progress}%"></div>
        </div>
      </div>
      <div class="progress-block">
        <div class="progress-label">
          <span>${escapeHtml(phaseLabel)}</span>
          <span class="progress-percent">${phasePercent}</span>
        </div>
        <div class="progress-bar-container is-secondary">
          <div class="progress-bar ${
            phaseProgress === null ? "is-indeterminate" : ""
          }" style="width: ${phaseProgress === null ? 100 : phaseProgress}%"></div>
        </div>
      </div>
      <div class="progress-meta">
        <span class="meta-chip">Phase: ${escapeHtml(phaseLabel)}</span>
        <span class="meta-chip">Elapsed: ${elapsed}</span>
        <span class="meta-chip">Last update: ${lastUpdate}</span>
        ${
          dbSizeLabel
            ? `<span class="meta-chip">DB size: ${dbSizeLabel}${dbDeltaLabel ? ` (${dbDeltaLabel})` : ""}</span>`
            : ""
        }
        ${
          activityDetail
            ? `<span class="meta-chip">DB activity: ${escapeHtml(activityDetail)}</span>`
            : ""
        }
      </div>
      <div class="progress-status">
        <span class="progress-message">${escapeHtml(message)}</span>
        ${
          activityDetail
            ? `<span class="progress-detail">${escapeHtml(activityDetail)}</span>`
            : ""
        }
        <span class="progress-activity ${isStale && !dbDeltaLabel ? "is-stale" : ""}">
          ${
            isStale
              ? dbDeltaLabel
                ? `DB growing (${dbDeltaLabel})`
                : "No new log output yet"
              : "Active"
          }
        </span>
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
  const { is_building, needs_provisioning, last_error, retry_count, max_retries }
    = status;
  const retryCap = typeof max_retries === "number" && max_retries > 0 ? max_retries : 3;
  const displayAttempt = Math.min(retry_count || 0, retryCap);
  const noTrips
    = !(status?.detected_states || []).length && !(status?.configured_states || []).length;

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
  } else if (noTrips && !last_error) {
    buttons.push(`
      <button class="btn btn-primary" id="provision-btn" disabled title="Import trips first">
        <i class="fas fa-download"></i> <span class="btn-text">Import trips first</span>
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
  const statusContainer = ensureMapServicesLayout();
  if (!statusContainer) {
    return;
  }

  statusContainer.innerHTML = `
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

function ensureMapServicesLayout() {
  const container = document.getElementById("map-services-content");
  if (!container) {
    return null;
  }
  if (!container.dataset.layoutReady) {
    container.innerHTML = `
      <div id="map-services-settings"></div>
      <div id="map-services-status"></div>
    `;
    container.dataset.layoutReady = "true";
  }
  return document.getElementById("map-services-status");
}

async function loadCoverageSettings() {
  try {
    ensureMapServicesLayout();
    const data = await apiClient.get(APP_SETTINGS_API);
    _coverageSettings = data || {};
  } catch (error) {
    console.warn("[MapServices] Failed to load app settings:", error);
    _coverageSettings = _coverageSettings || {};
  }
  renderCoverageSettings(_coverageSettings);
}

function renderCoverageSettings(settings) {
  const container = document.getElementById("map-services-settings");
  if (!container) {
    return;
  }

  const mode = (settings.mapCoverageMode || "trips").toLowerCase();
  const bufferMiles = sanitizeNumber(settings.mapCoverageBufferMiles, 10);
  const simplifyFeet = sanitizeNumber(settings.mapCoverageSimplifyFeet, 150);
  const maxPoints = sanitizeInt(settings.mapCoverageMaxPointsPerTrip, 2000);
  const batchSize = sanitizeInt(settings.mapCoverageBatchSize, 200);

  container.innerHTML = `
    <div class="settings-group map-services-settings-card">
      <h3 class="settings-group-title">
        <i class="fas fa-layer-group"></i>
        Coverage Settings
      </h3>
      <p class="text-muted small mb-3">
        Build map data from your actual trip coverage. All distances are in miles or feet.
        Changes apply the next time you run map setup.
      </p>
      <form id="map-coverage-settings-form">
        <div class="setting-item">
          <div class="setting-label">
            <div class="setting-label-title">Coverage Mode</div>
            <div class="setting-label-description">
              Trip coverage builds a smaller extract around your trips. Full states is slower but broader.
            </div>
          </div>
          <div class="setting-control">
            <select id="map-coverage-mode" class="form-select">
              <option value="trips"${mode === "trips" ? " selected" : ""}>
                Trip coverage (recommended)
              </option>
              <option value="states"${mode === "states" ? " selected" : ""}>
                Full states
              </option>
            </select>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="setting-label-title">Coverage Buffer (miles)</div>
            <div class="setting-label-description">
              Extra margin around trip paths to avoid edge misses.
            </div>
          </div>
          <div class="setting-control">
            <input
              type="number"
              class="form-control"
              id="map-coverage-buffer-miles"
              min="0"
              step="0.5"
              value="${bufferMiles}"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="setting-label-title">Coverage Simplify (feet)</div>
            <div class="setting-label-description">
              Simplify the polygon to speed extraction; 0 keeps full detail.
            </div>
          </div>
          <div class="setting-control">
            <input
              type="number"
              class="form-control"
              id="map-coverage-simplify-feet"
              min="0"
              step="10"
              value="${simplifyFeet}"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="setting-label-title">Max Points per Trip</div>
            <div class="setting-label-description">
              Downsamples long traces to keep coverage building fast.
            </div>
          </div>
          <div class="setting-control">
            <input
              type="number"
              class="form-control"
              id="map-coverage-max-points"
              min="100"
              step="100"
              value="${maxPoints}"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-label">
            <div class="setting-label-title">Batch Size</div>
            <div class="setting-label-description">
              Controls how many trip shapes are merged at a time.
            </div>
          </div>
          <div class="setting-control">
            <input
              type="number"
              class="form-control"
              id="map-coverage-batch-size"
              min="50"
              step="50"
              value="${batchSize}"
            />
          </div>
        </div>

        <div class="d-flex gap-2 align-items-center mt-3">
          <button class="btn btn-primary" type="submit">
            <i class="fas fa-save"></i> Save Coverage Settings
          </button>
          <span class="text-muted small" id="coverage-settings-status"></span>
        </div>
      </form>
    </div>
  `;

  attachCoverageSettingsListeners();
}

function attachCoverageSettingsListeners() {
  const form = document.getElementById("map-coverage-settings-form");
  if (!form || form.dataset.bound === "true") {
    return;
  }
  form.dataset.bound = "true";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const modeInput = document.getElementById("map-coverage-mode");
    const bufferInput = document.getElementById("map-coverage-buffer-miles");
    const simplifyInput = document.getElementById("map-coverage-simplify-feet");
    const maxPointsInput = document.getElementById("map-coverage-max-points");
    const batchInput = document.getElementById("map-coverage-batch-size");
    const statusEl = document.getElementById("coverage-settings-status");

    const mode = (modeInput?.value || "trips").toLowerCase();
    const bufferMiles = Math.max(0, sanitizeNumber(bufferInput?.value, 10));
    const simplifyFeet = Math.max(0, sanitizeNumber(simplifyInput?.value, 150));
    const maxPoints = Math.max(100, sanitizeInt(maxPointsInput?.value, 2000));
    const batchSize = Math.max(50, sanitizeInt(batchInput?.value, 200));

    const payload = {
      mapCoverageMode: mode,
      mapCoverageBufferMiles: bufferMiles,
      mapCoverageSimplifyFeet: simplifyFeet,
      mapCoverageMaxPointsPerTrip: maxPoints,
      mapCoverageBatchSize: batchSize,
    };

    if (statusEl) {
      statusEl.textContent = "Saving...";
    }

    try {
      await apiClient.post(APP_SETTINGS_API, payload);
      _coverageSettings = { ...(_coverageSettings || {}), ...payload };
      notificationManager.show("Coverage settings saved.", "success");
      if (statusEl) {
        statusEl.textContent = "Saved. Re-run map setup to apply.";
      }
    } catch (error) {
      console.error("[MapServices] Failed to save coverage settings:", error);
      notificationManager.show("Failed to save coverage settings.", "danger");
      if (statusEl) {
        statusEl.textContent = "Save failed.";
      }
    }
  });
}

function sanitizeNumber(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function buildActivityDetail(progress) {
  const query = progress?.active_query;
  if (!query) {
    return "";
  }
  const summarized = summarizePgQuery(query);
  const state = progress?.active_state;
  const waitType = progress?.active_wait_event_type;
  const waitEvent = progress?.active_wait_event;
  const waitDetail = waitType ? `${waitType}${waitEvent ? `/${waitEvent}` : ""}` : null;
  const stateDetail = state ? state : null;
  const suffixParts = [stateDetail, waitDetail].filter(Boolean);
  return suffixParts.length > 0
    ? `${summarized} (${suffixParts.join(", ")})`
    : summarized;
}

function summarizePgQuery(query) {
  const cleaned = query.replace(/\s+/g, " ").trim();
  const patterns = [
    /^COPY\s+("?[\w."]+"?)/i,
    /^ANALYZE\s+("?[\w."]+"?)/i,
    /^VACUUM\s+("?[\w."]+"?)/i,
    /^CREATE\s+TABLE\s+("?[\w."]+"?)/i,
    /^INSERT\s+INTO\s+("?[\w."]+"?)/i,
    /^UPDATE\s+("?[\w."]+"?)/i,
    /^SELECT\s+/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const verb = cleaned.split(" ", 1)[0].toUpperCase();
      if (match[1]) {
        return `${verb} ${match[1].replace(/\"/g, "")}`;
      }
      return verb;
    }
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
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

function clampNumber(value, min, max) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return min;
  }
  return Math.min(Math.max(numberValue, min), max);
}

function getBuildPhaseLabel(phase) {
  switch (phase) {
    case "downloading":
      return "Downloading map data";
    case "building_geocoder":
      return "Geocoder import";
    case "building_router":
      return "Routing tiles";
    case "idle":
      return "Preparing";
    default:
      return "In progress";
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function timeAgo(isoString) {
  if (!isoString) {
    return "—";
  }
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) {
    return "—";
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 10) {
    return "just now";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return `${hours}h ${remMinutes}m ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
