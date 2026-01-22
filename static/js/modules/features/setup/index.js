/* global mapboxgl */
import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";
import { onPageLoad } from "../../utils.js";
import { getBouncieFormValues } from "./steps/bouncie.js";
import {
  destroyMapPreview,
  isValidMapboxToken,
  renderMapPreview,
} from "./steps/mapbox.js";
import { readJsonResponse, responseErrorMessage } from "./validation.js";

const SETUP_STATUS_API = "/api/setup/status";
const PROFILE_API = "/api/profile";
const APP_SETTINGS_API = "/api/app_settings";
const MAP_SERVICES_API = "/api/map-services";
const SUGGESTED_STATES = new Set(["CA", "TX", "NY"]);

let pageSignal = null;
let mapPreview = null;
let setupStatus = null;
let mapServiceStatus = null;
let stateCatalog = null;
let selectedStates = new Set();
let pollingTimer = null;
let currentStep = 0;

onPageLoad(
  ({ signal, cleanup } = {}) => {
    pageSignal = signal || null;
    initializeSetup();
    if (typeof cleanup === "function") {
      cleanup(() => {
        pageSignal = null;
        mapPreview = destroyMapPreview(mapPreview);
        stopStatusPolling();
      });
    }
  },
  { route: "/setup-wizard" }
);

function withSignal(options = {}) {
  if (pageSignal) {
    return { ...options, signal: pageSignal };
  }
  return options;
}

async function initializeSetup() {
  bindEvents();
  await Promise.all([
    loadSetupStatus(),
    loadMapboxSettings(),
    loadBouncieCredentials(),
    loadStateCatalog(),
    refreshMapServicesStatus(),
  ]);
  updateStepState();
  updateMapCoverageUI();
}

function bindEvents() {
  document
    .getElementById("credentials-continue-btn")
    ?.addEventListener("click", handleCredentialsContinue);

  document
    .getElementById("connectBouncieBtn")
    ?.addEventListener("click", handleConnectBouncie);
  document
    .getElementById("syncVehiclesBtn")
    ?.addEventListener("click", syncVehicles);

  document
    .getElementById("toggleClientSecret")
    ?.addEventListener("click", () => togglePasswordVisibility("clientSecret"));

  document
    .getElementById("mapboxToken")
    ?.addEventListener("input", handleMapboxInput);

  document
    .getElementById("map-setup-btn")
    ?.addEventListener("click", startMapSetup);
  document
    .getElementById("map-cancel-btn")
    ?.addEventListener("click", cancelMapSetup);
  document
    .getElementById("finish-setup-btn")
    ?.addEventListener("click", completeSetupAndExit);
}

async function loadSetupStatus() {
  try {
    const data = await apiClient.get(SETUP_STATUS_API, withSignal());
    setupStatus = data;
  } catch (_error) {
    setupStatus = null;
  }
}

async function loadMapboxSettings() {
  try {
    const response = await apiClient.raw(APP_SETTINGS_API, withSignal());
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load Mapbox settings")
      );
    }
    const token = data.mapbox_token || "";
    const input = document.getElementById("mapboxToken");
    if (input) {
      input.value = token;
    }
    handleMapboxInput();
  } catch (_error) {
    showStatus("credentials-status", "Unable to load Mapbox settings.", true);
  }
}

async function loadBouncieCredentials() {
  try {
    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials/unmask`,
      withSignal()
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load Bouncie credentials")
      );
    }
    const clientId = document.getElementById("clientId");
    const clientSecret = document.getElementById("clientSecret");
    const redirectUri = document.getElementById("redirectUri");
    if (clientId) {
      clientId.value = data.client_id || "";
    }
    if (clientSecret) {
      clientSecret.value = data.client_secret || "";
    }
    if (redirectUri) {
      redirectUri.value = data.redirect_uri || buildRedirectUri();
    }
  } catch (_error) {
    showStatus("credentials-status", "Unable to load Bouncie credentials.", true);
  }
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
  } catch (_error) {
    const grid = document.getElementById("state-selection");
    if (grid) {
      grid.innerHTML = '<div class="text-danger">Failed to load states.</div>';
    }
  }
}

async function refreshMapServicesStatus() {
  try {
    const response = await apiClient.raw(`${MAP_SERVICES_API}/status`, withSignal());
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load map status")
      );
    }
    mapServiceStatus = data;
    applySelectedStatesFromStatus();
    updateMapCoverageUI();
  } catch (_error) {
    mapServiceStatus = null;
  }
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
    Boolean(setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete),
    Boolean(setupStatus?.steps?.coverage?.complete)
  );
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
  const mapboxOk = await saveMapboxSettings();
  await loadSetupStatus();
  updateStepState();

  if (bouncieOk && mapboxOk && setupStatus?.steps?.bouncie?.complete) {
    goToStep(1);
  } else {
    showStatus(
      "credentials-status",
      "Finish credentials and sync vehicles before continuing.",
      true
    );
  }
}

async function saveBouncieCredentials() {
  const payload = getBouncieFormValues();
  if (!payload.client_id || !payload.client_secret || !payload.redirect_uri) {
    showStatus("credentials-status", "All Bouncie fields are required.", true);
    return false;
  }
  try {
    showStatus("credentials-status", "Saving credentials...", false);
    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to save credentials")
      );
    }
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
    const response = await apiClient.raw(
      APP_SETTINGS_API,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapbox_token: token }),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Failed to save settings"));
    }
    showStatus("credentials-status", "Mapbox settings saved.", false);
    return true;
  } catch (error) {
    showStatus("credentials-status", error.message, true);
    return false;
  }
}

async function syncVehicles() {
  try {
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
          const suggested = SUGGESTED_STATES.has(code);
          const label = suggested ? "Suggested" : "";
          return `
            <label class="state-option ${suggested ? "is-suggested" : ""}">
              <input type="checkbox" value="${state.code}" data-size="${size}" />
              <span class="state-name">${state.name}</span>
              <span class="state-size">${size ? `${size} MB` : "--"}</span>
              ${label ? `<span class="state-tag">${label}</span>` : ""}
            </label>
          `;
        })
        .join("");
      return `
        <div class="state-region">
          <div class="state-region-title">${regionName}</div>
          <div class="state-region-grid">${items}</div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener("change", () => {
      const code = input.value;
      if (input.checked) {
        selectedStates.add(code);
      } else {
        selectedStates.delete(code);
      }
      updateSelectionSummary();
      updateStateSelectionUI();
    });
  });

  applySelectedStatesFromStatus();
  updateSelectionSummary();
  updateStateSelectionUI();
}

function applySelectedStatesFromStatus() {
  const configured = mapServiceStatus?.config?.selected_states || [];
  selectedStates = new Set(configured);
  updateStateSelectionUI();
  updateSelectionSummary();
}

function updateStateSelectionUI() {
  const container = document.getElementById("state-selection");
  if (!container) {
    return;
  }
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const selected = selectedStates.has(input.value);
    input.checked = selected;
    input.closest(".state-option")?.classList.toggle("is-selected", selected);
  });
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

async function startMapSetup() {
  if (!selectedStates.size) {
    showStatus("coverage-status", "Select at least one state.", true);
    return;
  }
  try {
    showStatus("coverage-status", "Starting map setup...", false);
    await apiClient.raw(`${MAP_SERVICES_API}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: Array.from(selectedStates) }),
    });
    await refreshMapServicesStatus();
    startStatusPolling();
  } catch (error) {
    showStatus("coverage-status", error.message || "Setup failed.", true);
  }
}

async function cancelMapSetup() {
  try {
    showStatus("coverage-status", "Cancelling setup...", false);
    await apiClient.raw(`${MAP_SERVICES_API}/cancel`, { method: "POST" });
    await refreshMapServicesStatus();
  } catch (error) {
    showStatus("coverage-status", error.message || "Cancel failed.", true);
  }
}

function updateMapCoverageUI() {
  const status = mapServiceStatus?.config;
  const progress = mapServiceStatus?.progress;

  const messageEl = document.getElementById("map-setup-message");
  if (messageEl) {
    messageEl.textContent = status?.message || "Select states to begin.";
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
    const showProgress = status?.status === "downloading" || status?.status === "building";
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

  const infoEl = document.getElementById("coverage-status-pill");
  if (infoEl) {
    infoEl.textContent = status?.status
      ? status.status.replace("_", " ")
      : "not configured";
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
}

function startStatusPolling() {
  if (pollingTimer) {
    return;
  }
  pollingTimer = setInterval(async () => {
    await refreshMapServicesStatus();
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
    window.location.href = "/";
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
}
