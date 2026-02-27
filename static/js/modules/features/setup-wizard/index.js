import apiClient from "../../core/api-client.js";
import { swupReady } from "../../core/navigation.js";
import {
  fetchBouncieCredentials as fetchBouncieCredentialsShared,
  saveBouncieCredentials as saveBouncieCredentialsShared,
} from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { getBouncieFormValues } from "./steps/bouncie.js";
import { readJsonResponse, responseErrorMessage } from "./validation.js";

const SETUP_STATUS_API = "/api/setup/status";
const PROFILE_API = "/api/profile";
const MAP_SERVICES_API = "/api/map-services";
const MAP_SERVICES_AUTO_STATUS_API = "/api/map-services/auto-status";
const APP_SETTINGS_API = "/api/app_settings";
const TRIP_SYNC_STATUS_API = "/api/actions/trips/sync/status";
const TRIP_SYNC_START_API = "/api/actions/trips/sync";

let pageSignal = null;
let setupStatus = null;
let mapServiceStatus = null;
let stateCatalog = null;
let selectedStates = new Set();
let pollingTimer = null;
let currentStep = 0;
let mapSetupInFlight = false;
let coverageMode = "trips";
let tripSyncStatus = null;
let detectedStates = [];
let hasTripsForCoverage = false;
let bouncieConnected = false;

/** Coverage flow phase: 'needs-import' | 'importing' | 'detected' | 'building' | 'ready' */
let coveragePhase = "needs-import";

export default function initSetupWizardPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  initializeSetup();
  const teardown = () => {
    pageSignal = null;
    stopStatusPolling();
  };
  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}

function withSignal(options = {}) {
  if (pageSignal) {
    return { ...options, signal: pageSignal };
  }
  return options;
}

async function initializeSetup() {
  bindEvents(pageSignal);
  await Promise.all([
    loadSetupStatus(),
    loadBouncieCredentials(),
    loadCoverageSettings(),
    loadTripSyncStatus(),
    loadStateCatalog(),
    refreshMapServicesStatus(),
  ]);
  handleBouncieRedirectParams();
  updateStepState();
  updateCoveragePhase();
}

function bindEvents(signal) {
  const eventOptions = signal ? { signal } : false;
  document
    .getElementById("credentials-continue-btn")
    ?.addEventListener("click", handleCredentialsContinue, eventOptions);

  document
    .getElementById("connectBouncieBtn")
    ?.addEventListener("click", handleConnectBouncie, eventOptions);
  document
    .getElementById("syncVehiclesBtn")
    ?.addEventListener("click", syncVehicles, eventOptions);

  document
    .getElementById("toggleClientSecret")
    ?.addEventListener(
      "click",
      () => togglePasswordVisibility("clientSecret"),
      eventOptions
    );

  document
    .getElementById("map-setup-btn")
    ?.addEventListener("click", startMapSetup, eventOptions);
  document
    .getElementById("map-cancel-btn")
    ?.addEventListener("click", cancelMapSetup, eventOptions);
  document
    .getElementById("finish-setup-btn")
    ?.addEventListener("click", completeSetupAndExit, eventOptions);

  document.querySelectorAll(".setup-step-button").forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        const target = Number(button.dataset.stepTarget || 0);
        if (Number.isNaN(target)) {
          return;
        }
        if (target <= currentStep) {
          goToStep(target);
        }
      },
      eventOptions
    );
  });

  // Back-to-credentials button in step 2
  document
    .querySelector('.setup-step-button-back[data-step-target="0"]')
    ?.addEventListener(
      "click",
      () => goToStep(0),
      eventOptions
    );

  document
    .getElementById("coverage-import-trips-btn")
    ?.addEventListener("click", importTripsForCoverage, eventOptions);
}

async function loadSetupStatus() {
  try {
    const data = await apiClient.get(SETUP_STATUS_API, withSignal());
    setupStatus = data;
  } catch {
    setupStatus = null;
  }
}

async function loadCoverageSettings() {
  try {
    const data = await apiClient.get(APP_SETTINGS_API, withSignal());
    coverageMode = String(data?.mapCoverageMode || "trips").toLowerCase();
  } catch {
    coverageMode = "trips";
  }
  if (mapServiceStatus) {
    applySelectedStatesFromStatus();
  }
}

async function loadTripSyncStatus() {
  try {
    tripSyncStatus = await apiClient.get(TRIP_SYNC_STATUS_API, withSignal());
  } catch {
    tripSyncStatus = null;
  }
  updateTripSyncStatusUI();
}

async function loadBouncieCredentials() {
  try {
    const credentials = await fetchBouncieCredentialsShared(withSignal());
    const clientId = document.getElementById("clientId");
    const clientSecret = document.getElementById("clientSecret");
    const redirectUri = document.getElementById("redirectUri");
    if (clientId) {
      clientId.value = credentials.client_id || "";
    }
    if (clientSecret) {
      clientSecret.value = credentials.client_secret || "";
    }
    if (redirectUri) {
      const expectedRedirect =
        credentials.redirect_uri || (await getExpectedRedirectUri());
      redirectUri.value = expectedRedirect;
    }
    bouncieConnected = Boolean(credentials.authorization_code);
    updateBouncieActions();
  } catch {
    showStatus("credentials-status", "Unable to load Bouncie credentials.", true);
    bouncieConnected = false;
    updateBouncieActions();
  }
}

function updateBouncieActions() {
  const syncBtn = document.getElementById("syncVehiclesBtn");
  if (!syncBtn) {
    return;
  }
  const canSync = Boolean(bouncieConnected);
  syncBtn.disabled = !canSync;
  syncBtn.setAttribute("aria-disabled", String(!canSync));
  syncBtn.title = canSync
    ? "Sync vehicles from Bouncie"
    : "Connect with Bouncie to enable vehicle sync.";
}

async function loadStateCatalog() {
  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/states`, withSignal());
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load state catalog")
      );
    }
    stateCatalog = data;
  } catch {
    stateCatalog = null;
  }
}

async function refreshMapServicesStatus() {
  try {
    const response = await apiClient.raw(MAP_SERVICES_AUTO_STATUS_API, withSignal());
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load map status")
      );
    }
    mapServiceStatus = normalizeMapServiceStatus(data);
    applySelectedStatesFromStatus();
  } catch {
    mapServiceStatus = null;
  }
}

function normalizeMapServiceStatus(data) {
  if (!data) {
    return null;
  }
  return {
    config: {
      selected_states: data.configured_states || [],
      status: data.status,
      progress: data.progress,
      message: data.message,
      last_updated: data.last_updated,
    },
    progress: {
      phase: data.build?.phase,
      phase_progress: data.build?.phase_progress,
      total_progress: data.build?.total_progress,
      started_at: data.build?.started_at,
      last_progress_at: data.build?.last_progress_at,
    },
    detected_states: data.detected_states || [],
    missing_states: data.missing_states || [],
    needs_provisioning: data.needs_provisioning,
    raw: data,
  };
}

/* ── Step Navigation ──────────────────────────────────────────── */

function updateStepState() {
  const bouncieComplete = setupStatus?.steps?.bouncie?.complete;
  const mapboxComplete = setupStatus?.steps?.mapbox?.complete;
  const credentialsComplete = Boolean(bouncieComplete && mapboxComplete);

  const coverageComplete = setupStatus?.steps?.coverage?.complete;

  updateStepList(credentialsComplete, Boolean(coverageComplete));
  updateProgressBar(credentialsComplete, Boolean(coverageComplete));

  if (currentStep === 0 && credentialsComplete) {
    goToStep(1);
  } else if (currentStep === 1 && !credentialsComplete) {
    goToStep(0);
  }

  const mapSetupBtn = document.getElementById("map-setup-btn");
  if (mapSetupBtn) {
    mapSetupBtn.disabled = !credentialsComplete;
  }
}

function updateStepList(credentialsComplete, coverageComplete) {
  const stepItems = document.querySelectorAll(".setup-step-item");
  stepItems.forEach((item) => {
    const step = Number(item.dataset.step || 0);
    if (step === 0) {
      item.classList.toggle("is-complete", credentialsComplete);
    }
    if (step === 1) {
      item.classList.toggle("is-complete", coverageComplete);
    }
    item.classList.toggle("is-active", step === currentStep);
  });
}

function updateProgressBar(credentialsComplete, coverageComplete) {
  // Progress dots
  document.querySelectorAll(".setup-progress-step").forEach((step) => {
    const idx = Number(step.dataset.progressStep || 0);
    step.classList.toggle("is-active", idx === currentStep);
    if (idx === 0) {
      step.classList.toggle("is-complete", credentialsComplete);
    }
    if (idx === 1) {
      step.classList.toggle("is-complete", coverageComplete);
    }
  });

  // Connector fill
  const connector = document.getElementById("progress-connector");
  if (connector) {
    connector.classList.remove("is-half", "is-full");
    if (coverageComplete) {
      connector.classList.add("is-full");
    } else if (credentialsComplete) {
      connector.classList.add("is-half");
    }
  }
}

function goToStep(stepIndex) {
  currentStep = stepIndex;
  document.querySelectorAll(".setup-step").forEach((step) => {
    const index = Number(step.dataset.step || 0);
    step.classList.toggle("is-active", index === currentStep);
  });
  updateStepList(
    Boolean(
      setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete
    ),
    Boolean(setupStatus?.steps?.coverage?.complete)
  );
  updateProgressBar(
    Boolean(
      setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete
    ),
    Boolean(setupStatus?.steps?.coverage?.complete)
  );
  if (currentStep === 1) {
    updateCoveragePhase();
  }
}

/* ── Password Toggle ──────────────────────────────────────────── */

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) {
    return;
  }
  input.type = input.type === "password" ? "text" : "password";
}

/* ── Credentials ──────────────────────────────────────────────── */

async function handleCredentialsContinue() {
  const bouncieOk = await saveBouncieCredentials();
  if (!bouncieOk) {
    await loadSetupStatus();
    updateStepState();
    return;
  }

  await loadSetupStatus();
  updateStepState();

  const bouncieComplete = setupStatus?.steps?.bouncie?.complete;
  const mapboxComplete = setupStatus?.steps?.mapbox?.complete;

  const missing = setupStatus?.steps?.bouncie?.missing || [];
  const missingNonDevice = missing.filter((item) => item !== "authorized_devices");

  if ((bouncieComplete || missingNonDevice.length === 0) && mapboxComplete) {
    if (missing.includes("authorized_devices")) {
      showStatus(
        "credentials-status",
        "You can sync vehicles later from Settings > Credentials.",
        false
      );
    }
    goToStep(1);
    return;
  }

  if (missing.includes("authorized_devices")) {
    showStatus(
      "credentials-status",
      "You can sync vehicles later from Settings > Credentials.",
      false
    );
  }

  if (missingNonDevice.length) {
    const missingLabel = missingNonDevice
      .map((item) => item.replace(/_/g, " "))
      .join(", ");
    showStatus("credentials-status", `Missing Bouncie fields: ${missingLabel}.`, true);
    return;
  }

  if (!mapboxComplete) {
    const mapboxError = setupStatus?.steps?.mapbox?.error;
    showStatus(
      "credentials-status",
      mapboxError || "Mapbox configuration is invalid.",
      true
    );
    return;
  }

  showStatus("credentials-status", "Finish credentials before continuing.", true);
}

async function saveBouncieCredentials() {
  const payload = getBouncieFormValues();
  if (!payload.client_id || !payload.client_secret || !payload.redirect_uri) {
    showStatus("credentials-status", "All Bouncie fields are required.", true);
    return false;
  }

  // Guard against invalid localhost Redirect URIs that cause SSL errors
  const uri = payload.redirect_uri.toLowerCase();
  if (uri.includes("localhost")) {
    if (uri.startsWith("https://")) {
      showStatus("credentials-status", "Localhost does not support HTTPS. Please use http://localhost:8080/api/bouncie/callback", true);
      return false;
    }
    if (uri.includes("www.localhost")) {
      showStatus("credentials-status", "www.localhost is invalid. Please use http://localhost:8080/api/bouncie/callback", true);
      return false;
    }
  }

  try {
    showStatus("credentials-status", "Saving credentials...", false);
    const data = await saveBouncieCredentialsShared(payload, withSignal());
    showStatus("credentials-status", data?.message || "Credentials saved.", false);
    return true;
  } catch (error) {
    showStatus("credentials-status", error.message, true);
    return false;
  }
}

async function syncVehicles() {
  try {
    if (!bouncieConnected) {
      showStatus(
        "credentials-status",
        "Connect with Bouncie before syncing vehicles.",
        true
      );
      return;
    }
    showStatus("credentials-status", "Syncing vehicles...", false);
    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials/sync-vehicles`,
      withSignal({ method: "POST" })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Vehicle sync failed"));
    }
    showStatus("credentials-status", data?.message || "Vehicles synced.", false);
    await loadSetupStatus();
    updateStepState();
  } catch (error) {
    showStatus("credentials-status", error.message, true);
  }
}

async function handleConnectBouncie(event) {
  event.preventDefault();
  const saved = await saveBouncieCredentials();
  if (!saved) {
    return;
  }
  window.location.href = "/api/bouncie/authorize";
}

function buildRedirectUri() {
  return `${window.location.origin}/api/bouncie/callback`;
}

async function getExpectedRedirectUri() {
  try {
    const response = await apiClient.raw("/api/bouncie/redirect-uri", withSignal());
    const data = await readJsonResponse(response);
    if (response.ok && data?.redirect_uri) {
      return data.redirect_uri;
    }
  } catch {
    // use origin-based redirect URI.
  }
  return buildRedirectUri();
}

function handleBouncieRedirectParams() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("bouncie_error");
  const connected = params.get("bouncie_connected");
  const synced = params.get("vehicles_synced");

  if (error) {
    showStatus("credentials-status", `Bouncie error: ${error}`, true);
  } else if (connected) {
    const count = synced ? ` (${synced} vehicles synced)` : "";
    showStatus("credentials-status", `Bouncie connected${count}.`, false);
  }

  if (error || connected) {
    const url = new URL(window.location.href);
    url.searchParams.delete("bouncie_error");
    url.searchParams.delete("bouncie_connected");
    url.searchParams.delete("vehicles_synced");
    window.history.replaceState(window.history.state, document.title, url.pathname);
  }
}

/* ── Coverage Phase Logic ─────────────────────────────────────── */

function determineCoveragePhase() {
  const status = mapServiceStatus?.config;
  const running = status?.status === "downloading" || status?.status === "building";
  const ready = status?.status === "ready";

  if (ready) {
    return "ready";
  }
  if (running || mapSetupInFlight) {
    return "building";
  }

  const noTrips = shouldBlockCoverageSetup();
  if (noTrips) {
    if (tripSyncStatus?.state === "syncing") {
      return "importing";
    }
    return "needs-import";
  }

  return "detected";
}

function updateCoveragePhase() {
  coveragePhase = determineCoveragePhase();

  const phases = ["import", "detected", "building", "ready"];
  phases.forEach((id) => {
    const el = document.getElementById(`phase-${id}`);
    if (!el) {
      return;
    }
    const visible =
      (id === "import" && (coveragePhase === "needs-import" || coveragePhase === "importing")) ||
      (id === "detected" && coveragePhase === "detected") ||
      (id === "building" && coveragePhase === "building") ||
      (id === "ready" && coveragePhase === "ready");
    el.classList.toggle("d-none", !visible);
  });

  updateImportUI();
  updateDetectedStatesUI();
  updateBuildUI();
  updateCoverageStatusPill();
  updateCoverageDescription();

  if (coveragePhase === "building" || coveragePhase === "importing") {
    startStatusPolling();
  } else {
    stopStatusPolling();
  }

  // Hide back button on ready phase
  const actions = document.getElementById("coverage-actions");
  if (actions) {
    actions.classList.toggle("d-none", coveragePhase === "ready");
  }
}

function updateCoverageStatusPill() {
  const pill = document.getElementById("coverage-status-pill");
  if (!pill) {
    return;
  }
  const labels = {
    "needs-import": "Needs trips",
    "importing": "Importing...",
    "detected": "Ready to build",
    "building": "Building...",
    "ready": "Ready",
  };
  pill.textContent = labels[coveragePhase] || "Not configured";
  pill.classList.remove("is-muted", "is-warning", "is-success");
  if (coveragePhase === "ready") {
    pill.classList.add("is-success");
  } else if (coveragePhase === "building" || coveragePhase === "importing") {
    pill.classList.add("is-warning");
  } else {
    pill.classList.add("is-muted");
  }
}

function updateCoverageDescription() {
  const el = document.getElementById("coverage-step-description");
  if (!el) {
    return;
  }
  if (coverageMode === "states") {
    el.textContent =
      "Choose the states you need now. Coverage can be expanded later as you travel.";
  } else {
    el.textContent =
      "Import your recent trips so we can detect which states to download. Coverage data powers local geocoding and routing.";
  }

  const modePill = document.getElementById("coverage-mode-pill");
  if (modePill) {
    modePill.textContent = coverageMode === "states" ? "Full states" : "Trip coverage";
  }
}

/* ── Import Phase UI ──────────────────────────────────────────── */

function updateImportUI() {
  const btn = document.getElementById("coverage-import-trips-btn");
  if (!btn) {
    return;
  }

  const isSyncing = tripSyncStatus?.state === "syncing";
  btn.disabled = isSyncing;

  if (isSyncing) {
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Importing...';
  } else {
    btn.innerHTML = '<i class="fas fa-download"></i> Import Recent Trips';
  }

  const descEl = document.getElementById("import-description");
  if (descEl) {
    if (isSyncing) {
      descEl.innerHTML =
        "Importing trips now. Coverage will update automatically once the import finishes.";
    } else {
      descEl.innerHTML =
        'We\'ll fetch your trips from <strong>the last 7 days</strong> from Bouncie. ' +
        "This tells us which states you've been driving in so we download " +
        "only the coverage data you actually need.";
    }
  }
}

function updateTripSyncStatusUI() {
  const countEl = document.getElementById("trip-sync-count");
  const statePill = document.getElementById("trip-sync-state-pill");
  const hintEl = document.getElementById("trip-sync-hint");

  if (!tripSyncStatus) {
    if (countEl) {
      countEl.textContent = "--";
    }
    if (statePill) {
      statePill.textContent = "Idle";
      statePill.classList.remove("is-warning", "is-danger", "is-success");
      statePill.classList.add("is-muted");
    }
    if (hintEl) {
      hintEl.textContent = "";
      hintEl.classList.add("d-none");
    }
    return;
  }

  const tripCount = Number(tripSyncStatus.trip_count || 0);
  if (countEl) {
    countEl.textContent = Number.isFinite(tripCount)
      ? tripCount.toLocaleString()
      : "--";
  }

  const state = tripSyncStatus.state || "idle";
  let label = "Idle";
  let pillClass = "is-muted";
  if (state === "syncing") {
    label = "Syncing";
    pillClass = "is-warning";
  } else if (state === "paused") {
    label = "Paused";
    pillClass = "is-warning";
  } else if (state === "error") {
    label = "Attention";
    pillClass = "is-danger";
  } else if (tripCount > 0) {
    label = "Ready";
    pillClass = "is-success";
  }

  if (statePill) {
    statePill.textContent = label;
    statePill.classList.remove("is-muted", "is-warning", "is-danger", "is-success");
    statePill.classList.add(pillClass);
  }

  let hint = "";
  if (tripSyncStatus.error?.message) {
    hint = tripSyncStatus.error.message;
  } else if (state === "syncing") {
    hint = "Trip import is running. Coverage will update automatically.";
  }
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.classList.toggle("d-none", !hint);
  }
}

/* ── Detected States UI ───────────────────────────────────────── */

function applySelectedStatesFromStatus() {
  const configured = mapServiceStatus?.config?.selected_states || [];
  detectedStates = mapServiceStatus?.detected_states || [];
  const preferDetected = coverageMode === "trips" || coverageMode === "auto";
  const selection = preferDetected
    ? detectedStates.length
      ? detectedStates
      : configured
    : configured;
  selectedStates = new Set(selection);
}

function updateDetectedStatesUI() {
  const container = document.getElementById("state-selection");
  if (!container || coveragePhase !== "detected") {
    return;
  }

  const selected = Array.from(selectedStates);
  if (!selected.length) {
    container.innerHTML = '<div class="text-muted">No trip coverage detected yet.</div>';
    return;
  }

  const chips = selected
    .map((code) => {
      const state = stateCatalog?.states?.find((item) => item.code === code);
      const name = state?.name || code;
      const size = Number(state?.size_mb || 0);
      return `
        <div class="setup-state-chip">
          <span>${name}</span>
          <span class="state-size">${size ? `${size} MB` : ""}</span>
        </div>
      `;
    })
    .join("");

  container.innerHTML = chips;

  updateSelectionSummary();
}

function updateSelectionSummary() {
  const totalSize = Array.from(selectedStates).reduce((sum, code) => {
    const state = stateCatalog?.states?.find((item) => item.code === code);
    return sum + Number(state?.size_mb || 0);
  }, 0);

  const sizeEl = document.getElementById("coverage-total-size");
  if (sizeEl) {
    sizeEl.textContent = totalSize ? `${totalSize.toLocaleString()} MB` : "--";
  }

  const timeEl = document.getElementById("coverage-time-estimate");
  if (timeEl) {
    const hours = totalSize / 500;
    timeEl.textContent = formatDuration(hours);
  }

  // Hidden review elements (backward compat)
  const sizeReviewEl = document.getElementById("coverage-total-size-review");
  if (sizeReviewEl) {
    sizeReviewEl.textContent = totalSize ? `${totalSize.toLocaleString()} MB` : "--";
  }
  const timeReviewEl = document.getElementById("coverage-time-estimate-review");
  if (timeReviewEl) {
    const hours = totalSize / 500;
    timeReviewEl.textContent = formatDuration(hours);
  }
}

/* ── Build UI ─────────────────────────────────────────────────── */

function updateBuildUI() {
  const status = mapServiceStatus?.config;
  const progress = mapServiceStatus?.progress;
  const running = status?.status === "downloading" || status?.status === "building";

  // Progress bar
  const progressBar = document.getElementById("map-setup-progress-bar");
  const progressText = document.getElementById("map-setup-progress-text");
  const messageEl = document.getElementById("map-setup-message");

  const percent = Number(status?.progress || 0);
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, percent)}%`;
  }
  if (progressText) {
    progressText.textContent = percent ? `${percent.toFixed(0)}%` : "";
  }

  if (messageEl) {
    let message = status?.message || "Starting...";
    if (running) {
      const details = [];
      const phaseLabel = formatPhaseLabel(progress?.phase);
      if (phaseLabel) {
        details.push(phaseLabel);
      }
      const phasePct = Number(progress?.phase_progress ?? 0);
      if (Number.isFinite(phasePct)) {
        if (phasePct > 0) {
          details.push(`${Math.round(phasePct)}%`);
        } else if (phasePct < 0) {
          details.push("in progress");
        }
      }
      const updated = formatRelativeTime(status?.last_updated);
      if (updated) {
        details.push(`last update ${updated}`);
      }
      if (details.length) {
        message = `${message} (${details.join(" | ")})`;
      }
    }
    messageEl.textContent = message;
  }

  // Build button
  const mapSetupBtn = document.getElementById("map-setup-btn");
  if (mapSetupBtn) {
    const credentialsComplete =
      setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete;
    mapSetupBtn.classList.toggle("d-none", coveragePhase !== "detected");
    mapSetupBtn.disabled = !credentialsComplete || mapSetupInFlight || !selectedStates.size;
  }

  // Cancel button
  const cancelBtn = document.getElementById("map-cancel-btn");
  if (cancelBtn) {
    cancelBtn.classList.toggle("d-none", coveragePhase !== "building");
  }

  // Finish button
  const finishBtn = document.getElementById("finish-setup-btn");
  if (finishBtn) {
    finishBtn.classList.toggle("d-none", coveragePhase !== "ready");
  }

  if (status?.status === "error") {
    showStatus("coverage-status", status.message || "Setup failed.", true);
  } else if (status?.status === "ready") {
    showStatus("coverage-status", "Map coverage is ready.", false);
  } else {
    showStatus("coverage-status", "", false);
  }

  if (!running) {
    mapSetupInFlight = false;
  }
}

/* ── Coverage Actions ─────────────────────────────────────────── */

function shouldBlockCoverageSetup() {
  if (!(coverageMode === "trips" || coverageMode === "auto")) {
    return false;
  }
  const configured = mapServiceStatus?.config?.selected_states || [];
  const detected = mapServiceStatus?.detected_states || [];
  hasTripsForCoverage = detected.length > 0;
  if (configured.length > 0) {
    return false;
  }
  return !hasTripsForCoverage;
}

async function importTripsForCoverage() {
  const btn = document.getElementById("coverage-import-trips-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting import...';
  }
  try {
    showStatus("coverage-status", "Starting trip import...", false);
    const response = await apiClient.raw(TRIP_SYNC_START_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "recent", trigger_source: "setup" }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Trip import failed."));
    }
    notificationManager.show("Trip import started.", "success");
    showStatus("coverage-status", "", false);
    await loadTripSyncStatus();
    await refreshMapServicesStatus();
    updateCoveragePhase();
  } catch (error) {
    showStatus("coverage-status", error.message || "Trip import failed.", true);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-download"></i> Import Recent Trips';
    }
  }
}

async function startMapSetup() {
  if (mapSetupInFlight) {
    return;
  }
  if (shouldBlockCoverageSetup()) {
    showStatus("coverage-status", "Import trips first to build coverage.", true);
    return;
  }
  if (!(coverageMode === "trips" || coverageMode === "auto") && !selectedStates.size) {
    showStatus("coverage-status", "Select at least one state.", true);
    return;
  }
  try {
    mapSetupInFlight = true;
    updateCoveragePhase();
    showStatus("coverage-status", "Starting map setup...", false);
    const useAuto = coverageMode === "trips" || coverageMode === "auto";
    const response = await apiClient.raw(
      useAuto ? `${MAP_SERVICES_API}/auto-provision` : `${MAP_SERVICES_API}/configure`,
      {
        method: "POST",
        headers: useAuto ? undefined : { "Content-Type": "application/json" },
        body: useAuto
          ? undefined
          : JSON.stringify({ states: Array.from(selectedStates) }),
      }
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Setup failed."));
    }
    showStatus("coverage-status", "", false);
    await refreshMapServicesStatus();
    updateCoveragePhase();
  } catch (error) {
    mapSetupInFlight = false;
    updateCoveragePhase();
    showStatus("coverage-status", error.message || "Setup failed.", true);
  }
}

async function cancelMapSetup() {
  try {
    showStatus("coverage-status", "Cancelling setup...", false);
    const response = await apiClient.raw(`${MAP_SERVICES_API}/cancel`, {
      method: "POST",
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Cancel failed."));
    }
    await refreshMapServicesStatus();
    updateCoveragePhase();
  } catch (error) {
    showStatus("coverage-status", error.message || "Cancel failed.", true);
  }
}

/* ── Polling ──────────────────────────────────────────────────── */

function startStatusPolling() {
  if (pollingTimer) {
    return;
  }
  pollingTimer = setInterval(async () => {
    await refreshMapServicesStatus();
    await loadTripSyncStatus();
    await loadSetupStatus();
    updateStepState();
    updateCoveragePhase();
  }, 4000);
}

function stopStatusPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

/* ── Finish ───────────────────────────────────────────────────── */

async function completeSetupAndExit() {
  try {
    const response = await apiClient.raw(
      "/api/setup/complete",
      withSignal({ method: "POST" })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Unable to finish setup"));
    }
    try {
      window.localStorage.setItem("es:setup-status-refresh", String(Date.now()));
    } catch {
      // Ignore storage errors
    }
    document.dispatchEvent(new CustomEvent("es:setup-status-refresh"));
    swupReady.then((swup) => {
      swup.navigate("/", {
        cache: { read: false, write: true },
        history: "replace",
      });
    });
  } catch (error) {
    notificationManager.show(error.message || "Unable to finish setup.", "danger");
  }
}

/* ── Formatting Helpers ───────────────────────────────────────── */

function formatDuration(hours) {
  if (!hours || hours <= 0) {
    return "--";
  }
  if (hours < 1) {
    return "Under 1 hour";
  }
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  if (minutes === 0) {
    return `${wholeHours} hour${wholeHours === 1 ? "" : "s"}`;
  }
  return `${wholeHours}h ${minutes}m`;
}

function formatPhaseLabel(phase) {
  switch (phase) {
    case "downloading":
      return "Downloading data";
    case "building_geocoder":
      return "Building address lookup";
    case "building_router":
      return "Building route planning";
    default:
      return "";
  }
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "";
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 0) {
    return "";
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!remaining) {
    return `${hours}h ago`;
  }
  return `${hours}h ${remaining}m ago`;
}

/* ── Status Display ───────────────────────────────────────────── */

function showStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.toggle("is-error", Boolean(isError));
  el.classList.toggle("is-success", !isError && Boolean(message));
  el.style.display = message ? "block" : "none";
}
