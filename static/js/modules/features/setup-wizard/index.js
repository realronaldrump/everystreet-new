import apiClient from "../../core/api-client.js";
import { swupReady } from "../../core/navigation.js";
import {
  fetchBouncieCredentials as fetchBouncieCredentialsShared,
  fetchMapboxToken,
  saveBouncieCredentials as saveBouncieCredentialsShared,
  saveMapboxToken,
} from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { getBouncieFormValues } from "./steps/bouncie.js";
import {
  destroyMapPreview,
  isValidMapboxToken,
  renderMapPreview,
} from "./steps/mapbox.js";
import { readJsonResponse, responseErrorMessage } from "./validation.js";

const SETUP_STATUS_API = "/api/setup/status";
const PROFILE_API = "/api/profile";
const MAP_SERVICES_API = "/api/map-services";
const MAP_SERVICES_AUTO_STATUS_API = "/api/map-services/auto-status";
const APP_SETTINGS_API = "/api/app_settings";
const TRIP_SYNC_STATUS_API = "/api/actions/trips/sync/status";
const TRIP_SYNC_START_API = "/api/actions/trips/sync";

let pageSignal = null;
let mapPreview = null;
let setupStatus = null;
let mapServiceStatus = null;
let stateCatalog = null;
let selectedStates = new Set();
let pollingTimer = null;
let currentStep = 0;
let _coverageView = "select";
let mapSetupInFlight = false;
let coverageMode = "trips";
let tripSyncStatus = null;
let detectedStates = [];
let hasTripsForCoverage = false;
let bouncieConnected = false;
let lastCoverageRestricted = false;

export default function initSetupWizardPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  initializeSetup();
  const teardown = () => {
    pageSignal = null;
    mapPreview = destroyMapPreview(mapPreview);
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
    loadMapboxSettings(),
    loadBouncieCredentials(),
    loadCoverageSettings(),
    loadTripSyncStatus(),
    loadStateCatalog(),
    refreshMapServicesStatus(),
  ]);
  handleBouncieRedirectParams();
  updateStepState();
  updateMapCoverageUI();
  updateCoverageView("select");
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
    .getElementById("mapboxToken")
    ?.addEventListener("input", handleMapboxInput, eventOptions);

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

  document
    .getElementById("coverage-review-btn")
    ?.addEventListener("click", () => updateCoverageView("review"), eventOptions);

  document
    .getElementById("coverage-back-btn")
    ?.addEventListener("click", () => updateCoverageView("select"), eventOptions);

  document.getElementById("coverage-run-btn")?.addEventListener(
    "click",
    () => {
      updateCoverageView("run");
      startMapSetup();
    },
    eventOptions
  );

  document
    .getElementById("coverage-import-trips-btn")
    ?.addEventListener("click", importTripsForCoverage, eventOptions);

  document.querySelectorAll(".setup-tab").forEach((tab) => {
    tab.addEventListener(
      "click",
      () => {
        if (tab.disabled || tab.classList.contains("is-disabled")) {
          return;
        }
        const target = tab.dataset.coverageTab || "select";
        updateCoverageView(target);
      },
      eventOptions
    );
  });

  document.getElementById("state-search")?.addEventListener(
    "input",
    (event) => {
      const query = event.target?.value || "";
      filterStateList(query);
    },
    eventOptions
  );
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
  updateCoverageModeUI();
  if (mapServiceStatus) {
    applySelectedStatesFromStatus();
    updateMapCoverageUI();
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

async function loadMapboxSettings() {
  try {
    const token = await fetchMapboxToken(withSignal());
    const input = document.getElementById("mapboxToken");
    if (input) {
      input.value = token;
    }
    handleMapboxInput();
  } catch {
    showStatus("credentials-status", "Unable to load Mapbox settings.", true);
  }
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
    renderStateGrid();
  } catch {
    const grid = document.getElementById("state-selection");
    if (grid) {
      grid.innerHTML = '<div class="text-danger">Failed to load states.</div>';
    }
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
    updateMapCoverageUI();
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

function updateStepState() {
  const bouncieComplete = setupStatus?.steps?.bouncie?.complete;
  const mapboxComplete = setupStatus?.steps?.mapbox?.complete;
  const credentialsComplete = Boolean(bouncieComplete && mapboxComplete);

  const coverageComplete = setupStatus?.steps?.coverage?.complete;

  updateStepList(credentialsComplete, Boolean(coverageComplete));

  if (currentStep === 0 && credentialsComplete) {
    goToStep(1);
  } else if (currentStep === 1 && !credentialsComplete) {
    goToStep(0);
  }

  updateHeroMeta();

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
  updateHeroMeta();
}

function updateHeroMeta() {
  const currentStepEl = document.getElementById("setup-current-step");
  const nextStepEl = document.getElementById("setup-next-step");
  if (currentStepEl) {
    currentStepEl.textContent = `${currentStep + 1} of 2`;
  }
  if (!nextStepEl) {
    return;
  }
  if (currentStep === 0) {
    nextStepEl.textContent = "Save credentials, then import trips for coverage.";
  } else {
    nextStepEl.textContent = "Review coverage, then start the build.";
  }
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) {
    return;
  }
  input.type = input.type === "password" ? "text" : "password";
}

function handleMapboxInput() {
  const token = document.getElementById("mapboxToken")?.value.trim();
  if (!token) {
    mapPreview = destroyMapPreview(mapPreview);
    return;
  }
  if (!isValidMapboxToken(token)) {
    mapPreview = destroyMapPreview(mapPreview);
    showStatus(
      "credentials-status",
      "Mapbox token must start with pk. and be valid length.",
      true
    );
    return;
  }
  mapPreview = destroyMapPreview(mapPreview);
  mapPreview = renderMapPreview({
    token,
    onError: () => {
      showStatus(
        "credentials-status",
        "Map preview failed to load. Double-check the token.",
        true
      );
    },
  });
}

async function handleCredentialsContinue() {
  const bouncieOk = await saveBouncieCredentials();
  if (!bouncieOk) {
    await loadSetupStatus();
    updateStepState();
    return;
  }

  const mapboxOk = await saveMapboxSettings();
  await loadSetupStatus();
  updateStepState();

  if (!mapboxOk) {
    return;
  }

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
      mapboxError || "Enter a valid Mapbox token before continuing.",
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

async function saveMapboxSettings() {
  const token = document.getElementById("mapboxToken")?.value.trim();
  if (!isValidMapboxToken(token)) {
    showStatus("credentials-status", "Enter a valid Mapbox token.", true);
    return false;
  }
  try {
    await saveMapboxToken(token, withSignal());
    showStatus("credentials-status", "Mapbox settings saved.", false);
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
    // Fall back to origin-based redirect URI.
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

function renderStateGrid() {
  const container = document.getElementById("state-selection");
  if (!container || !stateCatalog?.regions || !stateCatalog?.states) {
    return;
  }

  const statesByCode = new Map();
  stateCatalog.states.forEach((state) => {
    statesByCode.set(state.code, state);
  });

  container.innerHTML = Object.entries(stateCatalog.regions)
    .map(([regionName, codes]) => {
      const items = codes
        .map((code) => {
          const state = statesByCode.get(code);
          if (!state) {
            return "";
          }
          const size = Number(state.size_mb || 0);
          return `
            <label class="state-option">
              <input type="checkbox" value="${state.code}" data-size="${size}" />
              <span class="state-name">${state.name}</span>
              <span class="state-size">${size ? `${size} MB` : "--"}</span>
            </label>
          `;
        })
        .join("");
      return `
        <div class="state-region" data-region="${regionName}">
          <div class="state-region-header" role="button" tabindex="0">
            <div class="state-region-title">${regionName}</div>
            <span class="state-region-toggle">Collapse</span>
          </div>
          <div class="state-region-grid">${items}</div>
        </div>
      `;
    })
    .join("");

  const emptyState = document.createElement("div");
  emptyState.className = "state-empty text-muted d-none";
  emptyState.id = "state-empty";
  emptyState.textContent = "No trip coverage detected yet.";
  container.appendChild(emptyState);

  const eventOptions = pageSignal ? { signal: pageSignal } : false;

  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener(
      "change",
      () => {
        const code = input.value;
        if (input.checked) {
          selectedStates.add(code);
        } else {
          selectedStates.delete(code);
        }
        updateSelectionSummary();
        updateStateSelectionUI();
      },
      eventOptions
    );
  });

  container.querySelectorAll(".state-region-header").forEach((header) => {
    header.addEventListener("click", () => toggleRegion(header), eventOptions);
    header.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleRegion(header);
        }
      },
      eventOptions
    );
  });

  applySelectedStatesFromStatus();
  updateSelectionSummary();
  updateStateSelectionUI();
}

function toggleRegion(header) {
  const region = header.closest(".state-region");
  if (!region) {
    return;
  }
  const collapsed = region.classList.toggle("is-collapsed");
  const toggle = region.querySelector(".state-region-toggle");
  if (toggle) {
    toggle.textContent = collapsed ? "Expand" : "Collapse";
  }
}

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
  updateStateSelectionUI();
  updateSelectionSummary();
}

function updateStateSelectionUI() {
  const container = document.getElementById("state-selection");
  if (!container) {
    return;
  }
  const locked = coverageMode === "trips" || coverageMode === "auto";
  container.classList.toggle("is-locked", locked);

  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const selected = selectedStates.has(input.value);
    input.checked = selected;
    input.disabled = locked;
    input.closest(".state-option")?.classList.toggle("is-selected", selected);
  });

  const searchInput = document.getElementById("state-search");
  if (searchInput) {
    searchInput.disabled = locked;
  }

  const emptyState = document.getElementById("state-empty");
  if (locked) {
    container.querySelectorAll(".state-option").forEach((option) => {
      const code = option.querySelector('input[type="checkbox"]')?.value;
      const visible = code && selectedStates.has(code);
      option.style.display = visible ? "grid" : "none";
    });
    container.querySelectorAll(".state-region").forEach((region) => {
      const options = Array.from(region.querySelectorAll(".state-option"));
      const hasVisible = options.some((option) => option.style.display !== "none");
      region.style.display = hasVisible ? "block" : "none";
    });
    if (emptyState) {
      emptyState.classList.toggle("d-none", selectedStates.size > 0);
    }
  } else {
    if (lastCoverageRestricted) {
      const query = searchInput?.value || "";
      filterStateList(query);
    }
    if (emptyState) {
      emptyState.classList.add("d-none");
    }
  }
  lastCoverageRestricted = locked;
}

function updateSelectionSummary() {
  const requiresSelection = !(coverageMode === "trips" || coverageMode === "auto");
  const selectionMissing = requiresSelection && !selectedStates.size;
  const noTrips = shouldBlockCoverageSetup();
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

  const sizeReviewEl = document.getElementById("coverage-total-size-review");
  if (sizeReviewEl) {
    sizeReviewEl.textContent = totalSize ? `${totalSize.toLocaleString()} MB` : "--";
  }

  const timeReviewEl = document.getElementById("coverage-time-estimate-review");
  if (timeReviewEl) {
    const hours = totalSize / 500;
    timeReviewEl.textContent = formatDuration(hours);
  }

  const reviewBtn = document.getElementById("coverage-review-btn");
  if (reviewBtn) {
    reviewBtn.disabled = selectionMissing || noTrips;
  }
  const runBtn = document.getElementById("coverage-run-btn");
  if (runBtn) {
    runBtn.disabled = selectionMissing || noTrips;
  }

  updateCoverageLists();
}

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

function updateTripSyncStatusUI() {
  const countEl = document.getElementById("trip-sync-count");
  const lastSuccessEl = document.getElementById("trip-sync-last-success");
  const lastAttemptEl = document.getElementById("trip-sync-last-attempt");
  const statePill = document.getElementById("trip-sync-state-pill");
  const hintEl = document.getElementById("trip-sync-hint");
  const bannerTitle = document.getElementById("coverage-trips-title");
  const bannerMessage = document.getElementById("coverage-trips-message");
  const importBtn = document.getElementById("coverage-import-trips-btn");

  if (!tripSyncStatus) {
    if (countEl) {
      countEl.textContent = "--";
    }
    if (lastSuccessEl) {
      lastSuccessEl.textContent = "--";
    }
    if (lastAttemptEl) {
      lastAttemptEl.textContent = "--";
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

  const lastSuccess = tripSyncStatus.last_success_at
    ? formatRelativeTime(tripSyncStatus.last_success_at)
    : "Never";
  const lastAttempt = tripSyncStatus.last_attempt_at
    ? formatRelativeTime(tripSyncStatus.last_attempt_at)
    : "Never";
  if (lastSuccessEl) {
    lastSuccessEl.textContent = lastSuccess || "Never";
  }
  if (lastAttemptEl) {
    lastAttemptEl.textContent = lastAttempt || "Never";
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

  if (bannerTitle && bannerMessage) {
    if (state === "syncing") {
      bannerTitle.textContent = "Importing trips";
      bannerMessage.textContent =
        "Trip import is running. Coverage will update automatically.";
    } else if (state === "error") {
      bannerTitle.textContent = "Trip sync needs attention";
      bannerMessage.textContent = tripSyncStatus.error?.message || "Trip sync failed.";
    } else if (state === "paused") {
      bannerTitle.textContent = "Trip sync is paused";
      bannerMessage.textContent =
        tripSyncStatus.error?.message || "Complete setup to import trips.";
    } else {
      bannerTitle.textContent = "Import trips first";
      bannerMessage.textContent =
        "We need at least one trip to calculate coverage. Sync trips to continue.";
    }
  }

  if (importBtn) {
    const disableImport = state === "syncing" || state === "paused";
    importBtn.disabled = disableImport;
    importBtn.textContent = state === "syncing" ? "Importing..." : "Import trips";
    importBtn.title = tripSyncStatus.error?.message || "";
  }
}

function updateCoverageLists() {
  const summaryList = document.getElementById("coverage-summary-list");
  const reviewList = document.getElementById("coverage-review-list");
  const selected = Array.from(selectedStates);
  const noTrips = shouldBlockCoverageSetup();
  const items = selected
    .map((code) => stateCatalog?.states?.find((item) => item.code === code))
    .filter(Boolean)
    .map((state) => {
      const size = Number(state.size_mb || 0);
      return `
        <div class="setup-selection-pill">
          <span>${state.name}</span>
          <span>${size ? `${size} MB` : "--"}</span>
        </div>
      `;
    })
    .join("");

  const empty = noTrips
    ? '<div class="text-muted">No trips imported yet.</div>'
    : '<div class="text-muted">No states selected yet.</div>';
  if (summaryList) {
    summaryList.innerHTML = items || empty;
  }
  if (reviewList) {
    reviewList.innerHTML = items || empty;
  }
}

function updateCoverageView(view) {
  _coverageView = view;
  document.querySelectorAll(".setup-coverage-view").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.coverageView === view);
  });
  document.querySelectorAll(".setup-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.coverageTab === view);
  });
}

function filterStateList(query) {
  if (coverageMode === "trips" || coverageMode === "auto") {
    return;
  }
  const normalized = query.trim().toLowerCase();
  const container = document.getElementById("state-selection");
  if (!container) {
    return;
  }

  container.querySelectorAll(".state-option").forEach((option) => {
    const name = option.querySelector(".state-name")?.textContent?.toLowerCase() || "";
    const visible = !normalized || name.includes(normalized);
    option.style.display = visible ? "grid" : "none";
  });

  container.querySelectorAll(".state-region").forEach((region) => {
    const options = Array.from(region.querySelectorAll(".state-option"));
    const hasVisible = options.some((option) => option.style.display !== "none");
    region.style.display = hasVisible ? "block" : "none";
  });
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
    updateMapCoverageUI();
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
    await refreshMapServicesStatus();
    updateCoverageView("run");
    startStatusPolling();
  } catch (error) {
    mapSetupInFlight = false;
    updateMapCoverageUI();
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
  } catch (error) {
    showStatus("coverage-status", error.message || "Cancel failed.", true);
  }
}

function updateMapCoverageUI() {
  const status = mapServiceStatus?.config;
  const progress = mapServiceStatus?.progress;
  const running = status?.status === "downloading" || status?.status === "building";
  const ready = status?.status === "ready";
  const noTrips = shouldBlockCoverageSetup();
  const selectionMissing =
    !(coverageMode === "trips" || coverageMode === "auto") && !selectedStates.size;

  const messageEl = document.getElementById("map-setup-message");
  if (messageEl) {
    let message = status?.message || "Select states to begin.";
    if (noTrips) {
      if (tripSyncStatus?.state === "syncing") {
        message = "Importing trips now. Coverage will update automatically.";
      } else if (tripSyncStatus?.error?.message) {
        const { message: tripSyncErrorMessage } = tripSyncStatus.error;
        message = tripSyncErrorMessage;
      } else {
        message = "Import trips first to detect coverage.";
      }
    }
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

  const progressWrap = document.getElementById("map-setup-progress");
  const progressBar = document.getElementById("map-setup-progress-bar");
  const progressText = document.getElementById("map-setup-progress-text");

  const percent = Number(status?.progress || 0);
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, percent)}%`;
  }
  if (progressText) {
    progressText.textContent = percent ? `${percent.toFixed(0)}%` : "";
  }
  if (progressWrap) {
    const showProgress =
      status?.status === "downloading" || status?.status === "building";
    progressWrap.classList.toggle("d-none", !showProgress);
  }

  const cancelBtn = document.getElementById("map-cancel-btn");
  if (cancelBtn) {
    cancelBtn.classList.toggle(
      "d-none",
      !(status?.status === "downloading" || status?.status === "building")
    );
  }

  const finishBtn = document.getElementById("finish-setup-btn");
  if (finishBtn) {
    const canFinish = status?.status === "ready" && setupStatus?.required_complete;
    finishBtn.classList.toggle("d-none", !canFinish);
  }

  const locked = status?.status === "downloading" || status?.status === "building";
  const coverageLocked = coverageMode === "trips" || coverageMode === "auto";
  const selectionLocked = locked || coverageLocked;
  const selectionContainer = document.getElementById("state-selection");
  if (selectionContainer) {
    selectionContainer.classList.toggle("is-locked", selectionLocked);
  }
  document
    .querySelectorAll('#state-selection input[type="checkbox"]')
    .forEach((input) => {
      input.disabled = selectionLocked;
    });
  const searchInput = document.getElementById("state-search");
  if (searchInput) {
    searchInput.disabled = selectionLocked;
  }
  const mapSetupBtn = document.getElementById("map-setup-btn");
  if (mapSetupBtn) {
    const credentialsComplete =
      setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete;
    mapSetupBtn.classList.toggle("d-none", running || ready || mapSetupInFlight);
    mapSetupBtn.disabled =
      locked || !credentialsComplete || mapSetupInFlight || noTrips || selectionMissing;
    mapSetupBtn.title = noTrips ? "Import trips first" : "";
  }

  const infoEl = document.getElementById("coverage-status-pill");
  if (infoEl) {
    infoEl.textContent = status?.status
      ? status.status.replace("_", " ")
      : "not configured";
  }

  if (running || ready) {
    updateCoverageView("run");
  }

  if (
    status?.status === "downloading" ||
    status?.status === "building" ||
    progress?.phase === "downloading"
  ) {
    startStatusPolling();
  } else {
    stopStatusPolling();
  }

  if (status?.status === "error") {
    showStatus("coverage-status", status.message || "Setup failed.", true);
  } else if (status?.status === "ready") {
    showStatus("coverage-status", "Map coverage is ready.", false);
  } else {
    showStatus("coverage-status", "", false);
  }

  if (!running && !ready) {
    mapSetupInFlight = false;
  }

  const runBtn = document.getElementById("coverage-run-btn");
  if (runBtn) {
    runBtn.disabled =
      running || ready || mapSetupInFlight || noTrips || selectionMissing;
    runBtn.title = noTrips ? "Import trips first" : "";
  }

  const reviewBtn = document.getElementById("coverage-review-btn");
  if (reviewBtn) {
    reviewBtn.disabled =
      running || ready || mapSetupInFlight || noTrips || selectionMissing;
    reviewBtn.title = noTrips ? "Import trips first" : "";
  }

  const banner = document.getElementById("coverage-trips-banner");
  if (banner) {
    banner.classList.toggle("d-none", !noTrips);
  }

  const searchWrap = document.getElementById("coverage-search");
  if (searchWrap) {
    const hideSearch = coverageMode === "trips" || coverageMode === "auto";
    searchWrap.classList.toggle("d-none", hideSearch);
  }

  const hint = document.getElementById("coverage-select-hint");
  if (hint) {
    hint.classList.toggle(
      "d-none",
      !(coverageMode === "trips" || coverageMode === "auto")
    );
  }

  const selectTitle = document.getElementById("coverage-select-title");
  const selectDesc = document.getElementById("coverage-select-description");
  if (selectTitle && selectDesc) {
    if (coverageMode === "trips" || coverageMode === "auto") {
      selectTitle.textContent = "Detected coverage";
      selectDesc.textContent = "States are inferred from your trip paths.";
    } else {
      selectTitle.textContent = "Select states";
      selectDesc.textContent =
        "Start with the states you need now. You can add more later.";
    }
  }

  const modePill = document.getElementById("coverage-mode-pill");
  if (modePill) {
    modePill.textContent = coverageMode === "states" ? "Full states" : "Trip coverage";
  }

  const stepDescription = document.getElementById("coverage-step-description");
  if (stepDescription) {
    if (coverageMode === "states") {
      stepDescription.textContent =
        "Choose the states you need now. Coverage can be expanded later as you travel.";
    } else {
      stepDescription.textContent =
        "Coverage is built from your trips so geocoding stays local and fast. We download the smallest extract that fully covers your trip area.";
    }
  }

  const tabs = document.querySelectorAll(".setup-tab");
  const disableTabs = (noTrips || selectionMissing) && !running && !ready;
  tabs.forEach((tab) => {
    const target = tab.dataset.coverageTab || "select";
    if (target === "select") {
      tab.classList.remove("is-disabled");
      tab.disabled = false;
      tab.removeAttribute("aria-disabled");
      return;
    }
    tab.classList.toggle("is-disabled", disableTabs);
    tab.disabled = disableTabs;
    tab.setAttribute("aria-disabled", disableTabs ? "true" : "false");
  });
}

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
    await loadTripSyncStatus();
    await refreshMapServicesStatus();
  } catch (error) {
    showStatus("coverage-status", error.message || "Trip import failed.", true);
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function updateCoverageModeUI() {
  const modePill = document.getElementById("coverage-mode-pill");
  if (modePill) {
    modePill.textContent = coverageMode === "states" ? "Full states" : "Trip coverage";
  }

  const stepDescription = document.getElementById("coverage-step-description");
  if (stepDescription) {
    if (coverageMode === "states") {
      stepDescription.textContent =
        "Choose the states you need now. Coverage can be expanded later as you travel.";
    } else {
      stepDescription.textContent =
        "Coverage is built from your trips so geocoding stays local and fast. We download the smallest extract that fully covers your trip area.";
    }
  }
}

function startStatusPolling() {
  if (pollingTimer) {
    return;
  }
  pollingTimer = setInterval(async () => {
    await refreshMapServicesStatus();
    await loadTripSyncStatus();
    await loadSetupStatus();
    updateStepState();
  }, 4000);
}

function stopStatusPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

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
