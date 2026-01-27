/* global mapboxgl */
import apiClient from "../../core/api-client.js";
import {
  fetchBouncieCredentials as fetchBouncieCredentialsShared,
  fetchMapboxToken,
  saveBouncieCredentials as saveBouncieCredentialsShared,
  saveMapboxToken,
} from "../../settings/credentials.js";
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
let _coverageView = "select";
let mapSetupInFlight = false;

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
  handleBouncieRedirectParams();
  updateStepState();
  updateMapCoverageUI();
  updateCoverageView("select");
}

function bindEvents() {
  document
    .getElementById("credentials-continue-btn")
    ?.addEventListener("click", handleCredentialsContinue);

  document
    .getElementById("connectBouncieBtn")
    ?.addEventListener("click", handleConnectBouncie);
  document.getElementById("syncVehiclesBtn")?.addEventListener("click", syncVehicles);

  document
    .getElementById("toggleClientSecret")
    ?.addEventListener("click", () => togglePasswordVisibility("clientSecret"));

  document.getElementById("mapboxToken")?.addEventListener("input", handleMapboxInput);

  document.getElementById("map-setup-btn")?.addEventListener("click", startMapSetup);
  document.getElementById("map-cancel-btn")?.addEventListener("click", cancelMapSetup);
  document
    .getElementById("finish-setup-btn")
    ?.addEventListener("click", completeSetupAndExit);

  document.querySelectorAll(".setup-step-button").forEach((button) => {
    button.addEventListener("click", () => {
      const target = Number(button.dataset.stepTarget || 0);
      if (Number.isNaN(target)) {
        return;
      }
      if (target <= currentStep) {
        goToStep(target);
      }
    });
  });

  document.getElementById("coverage-review-btn")?.addEventListener("click", () => {
    updateCoverageView("review");
  });

  document.getElementById("coverage-back-btn")?.addEventListener("click", () => {
    updateCoverageView("select");
  });

  document.getElementById("coverage-run-btn")?.addEventListener("click", () => {
    updateCoverageView("run");
    startMapSetup();
  });

  document.querySelectorAll(".setup-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.coverageTab || "select";
      updateCoverageView(target);
    });
  });

  document.getElementById("state-search")?.addEventListener("input", (event) => {
    const query = event.target?.value || "";
    filterStateList(query);
  });
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
    const token = await fetchMapboxToken(withSignal());
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
      const expectedRedirect
        = credentials.redirect_uri || (await getExpectedRedirectUri());
      redirectUri.value = expectedRedirect;
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
    nextStepEl.textContent = "Save credentials, then choose coverage.";
  } else {
    nextStepEl.textContent = "Select coverage, then start the build.";
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
  } catch (_error) {
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
    window.history.replaceState({}, document.title, url.pathname);
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

  container.querySelectorAll(".state-region-header").forEach((header) => {
    header.addEventListener("click", () => toggleRegion(header));
    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleRegion(header);
      }
    });
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
    reviewBtn.disabled = selectedStates.size === 0;
  }
  const runBtn = document.getElementById("coverage-run-btn");
  if (runBtn) {
    runBtn.disabled = selectedStates.size === 0;
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

function updateCoverageLists() {
  const summaryList = document.getElementById("coverage-summary-list");
  const reviewList = document.getElementById("coverage-review-list");
  const selected = Array.from(selectedStates);
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

  const empty = '<div class="text-muted">No states selected yet.</div>';
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
  if (!selectedStates.size) {
    showStatus("coverage-status", "Select at least one state.", true);
    return;
  }
  try {
    mapSetupInFlight = true;
    updateMapCoverageUI();
    showStatus("coverage-status", "Starting map setup...", false);
    const response = await apiClient.raw(`${MAP_SERVICES_API}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: Array.from(selectedStates) }),
    });
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

  const messageEl = document.getElementById("map-setup-message");
  if (messageEl) {
    let message = status?.message || "Select states to begin.";
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
    const showProgress
      = status?.status === "downloading" || status?.status === "building";
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
  document
    .querySelectorAll('#state-selection input[type="checkbox"]')
    .forEach((input) => {
      input.disabled = locked;
    });
  const mapSetupBtn = document.getElementById("map-setup-btn");
  if (mapSetupBtn) {
    const credentialsComplete
      = setupStatus?.steps?.bouncie?.complete && setupStatus?.steps?.mapbox?.complete;
    const running = status?.status === "downloading" || status?.status === "building";
    const ready = status?.status === "ready";
    mapSetupBtn.classList.toggle("d-none", running || ready || mapSetupInFlight);
    mapSetupBtn.disabled
      = locked || !selectedStates.size || !credentialsComplete || mapSetupInFlight;
  }

  const infoEl = document.getElementById("coverage-status-pill");
  if (infoEl) {
    infoEl.textContent = status?.status
      ? status.status.replace("_", " ")
      : "not configured";
  }

  const ready = status?.status === "ready";
  if (running || ready) {
    updateCoverageView("run");
  }

  if (
    status?.status === "downloading"
    || status?.status === "building"
    || progress?.phase === "downloading"
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
    runBtn.disabled = running || ready || mapSetupInFlight || !selectedStates.size;
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
  el.classList.toggle("is-success", !isError && Boolean(message));
  el.style.display = message ? "block" : "none";
}
