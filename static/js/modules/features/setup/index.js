/* global mapboxgl */
import apiClient from "../../core/api-client.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { formatTimeAgo, onPageLoad } from "../../utils.js";
import { getBouncieFormValues } from "./steps/bouncie.js";
import {
  destroyMapPreview,
  isValidMapboxToken,
  renderMapPreview,
} from "./steps/mapbox.js";
import { renderRegionList, sortRegions } from "./steps/region.js";
import { readJsonResponse, responseErrorMessage } from "./validation.js";

const SETUP_API = "/api/setup";
const SETUP_SESSION_API = "/api/setup/session";
const PROFILE_API = "/api/profile";
const APP_SETTINGS_API = "/api/app_settings";
const MAP_DATA_API = "/api/map-data";
const SETUP_TAB_STORAGE_KEY = "es:setup-tab-id";
const SESSION_POLL_INTERVAL_MS = 3500;
const REGION_VIEW_US = "us";
const REGION_VIEW_GLOBAL = "global";
const REGION_LARGE_DOWNLOAD_MB = 2000;
const REGION_STALE_PROGRESS_MINUTES = 15;

const stepKeys = ["welcome", "bouncie", "mapbox", "region", "complete"];
let currentStep = 0;
const setupState = {
  bouncie: false,
  mapbox: false,
  region: false,
};
let setupStatus = null;
let sessionState = null;
let sessionId = null;
let sessionVersion = null;
let sessionClientId = null;
let sessionReadOnly = false;
let _sessionOwner = false;
let sessionPollInterval = null;
let navigationGuardCleanup = null;
let actionInFlight = false;
let allowExternalRedirect = false;
let bouncieStatus = null;
let bouncieDetails = { client_id: "", redirect_uri: "" };
let mapboxTokenValue = "";
const dirtyState = {
  bouncie: false,
  mapbox: false,
};
let selectedRegion = null;
let currentRegionPath = [];
let regionView = REGION_VIEW_US;
let regionSearchQuery = "";
let currentRegionItems = [];
let usRegionItems = [];
let mapPreview = null;
let pageSignal = null;
let regionControlsLocked = false;
let geoServiceStatus = null;

onPageLoad(
  ({ signal, cleanup } = {}) => {
    pageSignal = signal || null;
    initializeSetup();
    if (typeof cleanup === "function") {
      cleanup(() => {
        pageSignal = null;
        stopSessionPolling();
        teardownNavigationGuard();
        mapPreview = destroyMapPreview(mapPreview);
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

function getSessionClientId() {
  if (sessionClientId) {
    return sessionClientId;
  }
  let stored = null;
  try {
    stored = sessionStorage.getItem(SETUP_TAB_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (!stored) {
    if (window.crypto?.randomUUID) {
      stored = window.crypto.randomUUID();
    } else {
      stored = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    try {
      sessionStorage.setItem(SETUP_TAB_STORAGE_KEY, stored);
    } catch {
      // Ignore storage failures.
    }
  }
  return stored;
}

function createIdempotencyKey() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `idemp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getStepKeyByIndex(index) {
  return stepKeys[index] || stepKeys[0];
}

function getStepIndexByKey(key) {
  return stepKeys.indexOf(key);
}

function getCurrentStepKey() {
  return getStepKeyByIndex(currentStep);
}

function getRegionStepState() {
  return sessionState?.step_states?.region || null;
}

function isRegionJobInFlight() {
  return Boolean(getRegionStepState()?.in_flight);
}

function getRegionJobStatus() {
  return getRegionStepState()?.metadata?.job_status || null;
}

function markDirty(stepKey) {
  if (Object.hasOwn(dirtyState, stepKey)) {
    dirtyState[stepKey] = true;
  }
}

function clearDirty(stepKey) {
  if (Object.hasOwn(dirtyState, stepKey)) {
    dirtyState[stepKey] = false;
  }
}

function isStepDirty(stepKey) {
  return Boolean(dirtyState[stepKey]);
}

function _getCurrentStepState() {
  return sessionState?.step_states?.[getCurrentStepKey()] || {};
}

function isStepLocked() {
  const steps = sessionState?.step_states;
  if (!steps) {
    return false;
  }
  return Object.values(steps).some(
    (state) => state?.in_flight || state?.interruptible === false
  );
}

function setActionInFlight(locked) {
  actionInFlight = locked;
  applyLockState();
}

async function requestSetupSession(method = "GET") {
  const isPost = method.toUpperCase() === "POST";
  const url = isPost
    ? SETUP_SESSION_API
    : `${SETUP_SESSION_API}?client_id=${encodeURIComponent(sessionClientId)}`;
  const response = await apiClient.raw(
    url,
    withSignal({
      method,
      headers: { "Content-Type": "application/json" },
      body: isPost ? JSON.stringify({ client_id: sessionClientId }) : undefined,
    })
  );
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      responseErrorMessage(response, data, "Failed to load setup session")
    );
  }
  return data;
}

async function initSetupSession() {
  try {
    const data = await requestSetupSession("POST");
    applySessionState(data);
    startSessionPolling();
    registerNavigationGuard();
  } catch (error) {
    console.warn("Failed to initialize setup session", error);
  }
}

function startSessionPolling() {
  stopSessionPolling();
  sessionPollInterval = setInterval(() => {
    refreshSetupSession();
  }, SESSION_POLL_INTERVAL_MS);
}

function stopSessionPolling() {
  if (sessionPollInterval) {
    clearInterval(sessionPollInterval);
    sessionPollInterval = null;
  }
}

async function refreshSetupSession() {
  if (!sessionId) {
    return;
  }
  try {
    const data = await requestSetupSession("GET");
    applySessionState(data);
  } catch (error) {
    console.warn("Failed to refresh setup session", error);
  }
}

function applySessionState(payload) {
  if (!payload || !payload.session) {
    return;
  }
  sessionState = payload.session;
  setupStatus = payload.setup_status || null;
  sessionId = sessionState.id;
  sessionVersion = sessionState.version;
  _sessionOwner = Boolean(payload.client?.is_owner);
  sessionReadOnly = Boolean(payload.client && !payload.client.is_owner);

  setupState.bouncie = Boolean(setupStatus?.steps?.bouncie?.complete);
  setupState.mapbox = Boolean(setupStatus?.steps?.mapbox?.complete);
  setupState.region = Boolean(setupStatus?.steps?.region?.complete);
  geoServiceStatus = setupStatus?.geo_services || null;

  const nextIndex = getStepIndexByKey(sessionState.current_step || "welcome");
  showStep(nextIndex >= 0 ? nextIndex : 0);
  updateStepIndicators();
  updateGeoServiceStatus(geoServiceStatus);
  updateRegionFromSession(sessionState.step_states?.region);
  updateSummary();
  applyLockState();
  renderSessionBanner(payload);
  updateResumeCta();
}

function updateResumeCta() {
  const startBtn = document.getElementById("setup-start-btn");
  if (!startBtn) {
    return;
  }
  const resume = Boolean(sessionState && sessionState.current_step !== "welcome");
  startBtn.textContent = resume ? "Resume Setup" : "Get Started";
}

function renderSessionBanner(payload) {
  const banner = document.getElementById("setup-session-banner");
  const message = document.getElementById("setup-session-banner-message");
  const takeoverBtn = document.getElementById("setup-session-takeover-btn");
  if (!banner || !message) {
    return;
  }
  const ownerId = payload?.client?.owner_id;
  const ownerIsStale = payload?.client?.owner_is_stale;

  if (sessionReadOnly && ownerId) {
    banner.classList.remove("d-none");
    message.textContent =
      "Setup is active in another tab. This view is read-only until it finishes.";
    if (takeoverBtn) {
      takeoverBtn.classList.toggle("d-none", !ownerIsStale);
      takeoverBtn.onclick = ownerIsStale ? handleSessionTakeover : null;
    }
    return;
  }

  banner.classList.add("d-none");
  if (takeoverBtn) {
    takeoverBtn.classList.add("d-none");
    takeoverBtn.onclick = null;
  }
}

function applyLockState() {
  const locked = sessionReadOnly || actionInFlight || isStepLocked();
  const activeCard = document.querySelector(".setup-step.is-active .setup-card");
  activeCard?.classList.toggle("is-locked", locked);
  document.body.classList.toggle("setup-readonly", sessionReadOnly);

  const buttonIds = [
    "setup-start-btn",
    "bouncie-save-btn",
    "toggleClientSecret",
    "mapbox-back-btn",
    "mapbox-save-btn",
    "region-back-btn",
    "region-finish-btn",
    "region-skip-btn",
    "confirm-region-skip",
    "download-region-btn",
    "auto-region-btn",
    "complete-back-btn",
    "complete-setup-btn",
    "syncVehiclesBtn",
    "addDeviceBtn",
  ];
  buttonIds.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = locked;
    }
  });

  [
    "clientId",
    "clientSecret",
    "redirectUri",
    "fetchConcurrency",
    "mapboxToken",
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.disabled = locked;
    }
  });

  setRegionControlsLocked(locked || isStepLocked());
}

function registerNavigationGuard() {
  teardownNavigationGuard();
  const guard = async () => {
    if (allowExternalRedirect) {
      return true;
    }
    if (sessionReadOnly) {
      return true;
    }
    const stepKey = getCurrentStepKey();
    if (isStepDirty(stepKey)) {
      if (confirmationDialog) {
        return confirmationDialog.show({
          title: "Leave setup?",
          message: "You have unsaved changes. Leaving will discard them.",
          confirmText: "Leave",
          cancelText: "Stay",
          confirmButtonClass: "btn-danger",
        });
      }
      return false; // Safe default
    }
    if (actionInFlight) {
      showNavigationBlockedNotice();
      return false;
    }
    if (isStepLocked()) {
      if (isRegionJobInFlight()) {
        return true;
      }
      showNavigationBlockedNotice();
      return false;
    }
    return true;
  };

  const handleBeforeUnload = (event) => {
    if (allowExternalRedirect) {
      return undefined;
    }
    if (actionInFlight) {
      event.preventDefault();
      event.returnValue = "Setup is saving. Leaving may interrupt it.";
      return event.returnValue;
    }
    if (isStepDirty(getCurrentStepKey())) {
      event.preventDefault();
      event.returnValue = "You have unsaved setup changes.";
      return event.returnValue;
    }
    if (isStepLocked() && !isRegionJobInFlight()) {
      event.preventDefault();
      event.returnValue = "Setup is running. Leaving may interrupt it.";
      return event.returnValue;
    }
    return undefined;
  };

  window.ESRouteGuard = guard;
  window.addEventListener("beforeunload", handleBeforeUnload);
  navigationGuardCleanup = () => {
    if (window.ESRouteGuard === guard) {
      window.ESRouteGuard = null;
    }
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}

function teardownNavigationGuard() {
  if (navigationGuardCleanup) {
    navigationGuardCleanup();
    navigationGuardCleanup = null;
  }
}

function showNavigationBlockedNotice() {
  if (isRegionJobInFlight()) {
    notificationManager.show(
      "Map data is downloading in the background. You can close this tab and return later. Setup steps stay locked until it finishes.",
      "info"
    );
    return;
  }
  notificationManager.show(
    "Setup is running. Please wait for the current step to finish.",
    "warning"
  );
}

function showBouncieRedirectModal() {
  const modalEl = document.getElementById("bouncieRedirectModal");
  if (!modalEl || !window.bootstrap?.Modal) {
    return false;
  }
  const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
  return true;
}

async function initializeSetup() {
  bindEventListeners();
  sessionClientId = getSessionClientId();

  // Show the first step immediately to avoid blank state
  showStep(1); // Default to Bouncie step

  await initSetupSession();
  await loadBouncieCredentials();
  await loadServiceConfig();
  await loadRegionView();
  updateResumeCta();
  checkBouncieRedirectStatus();
  await updateBouncieConnectionStatus();
}

function checkBouncieRedirectStatus() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("bouncie_connected");
  const error = params.get("bouncie_error");
  const vehiclesSynced = params.get("vehicles_synced");

  if (connected === "true") {
    // Vehicles are now synced automatically during OAuth callback
    const vehicleCount = parseInt(vehiclesSynced, 10) || 0;
    let message;
    if (vehicleCount > 0) {
      message = `Successfully connected to Bouncie! ${vehicleCount} vehicle(s) synced automatically. Click 'Save & Continue' to proceed.`;
    } else {
      message =
        "Successfully connected to Bouncie! No vehicles found in your account. You can add them later.";
    }
    showStatus("setup-bouncie-status", message, false);
    // Clear the query params from URL
    window.history.replaceState({}, document.title, window.location.pathname);

    // Refresh setup session to update status
    refreshSetupSession();
  } else if (error) {
    let errorMsg = "Failed to connect to Bouncie.";
    if (error === "missing_code") {
      errorMsg =
        "OAuth callback did not receive authorization code. Check your redirect URI configuration.";
    } else if (error === "missing_state") {
      errorMsg =
        "OAuth callback did not include a valid state parameter. Please try connecting again.";
    } else if (error === "state_mismatch") {
      errorMsg = "OAuth state mismatch detected. Please retry the connection.";
    } else if (error === "state_expired") {
      errorMsg = "OAuth session expired before completion. Please try again.";
    } else if (error === "storage_failed") {
      errorMsg = "Failed to save authorization. Please try again.";
    } else if (error === "token_exchange_failed") {
      errorMsg =
        "Failed to exchange authorization code for an access token. Verify your client credentials and redirect URI.";
    } else if (error === "vehicle_sync_failed") {
      errorMsg =
        "Connected to Bouncie, but vehicle sync failed. Please try syncing again.";
    } else {
      errorMsg = `OAuth error: ${decodeURIComponent(error)}`;
    }
    showStatus("setup-bouncie-status", errorMsg, true);
    // Clear the query params from URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function updateBouncieConnectionStatus() {
  const syncBtn = document.getElementById("syncVehiclesBtn");
  if (!syncBtn) {
    return;
  }
  try {
    const response = await apiClient.raw(
      `${PROFILE_API.replace("/profile", "/bouncie")}/status`,
      withSignal()
    );
    const data = await readJsonResponse(response);
    if (!response.ok || !data) {
      return;
    }
    bouncieStatus = data;
    if (typeof data.connected === "boolean") {
      syncBtn.disabled = !data.connected;
    }
    updateSummary();
  } catch (_error) {
    // Silently fail - status check is optional
  }
}

function bindEventListeners() {
  document
    .getElementById("setup-start-btn")
    ?.addEventListener("click", () => handleStepNavigation("bouncie"));

  document
    .getElementById("bouncie-back-btn")
    ?.addEventListener("click", () => handleStepNavigation("welcome"));
  document
    .getElementById("bouncie-save-btn")
    ?.addEventListener("click", () => saveBouncieCredentials(true));

  document
    .getElementById("mapbox-back-btn")
    ?.addEventListener("click", () => handleStepNavigation("bouncie"));
  document
    .getElementById("mapbox-save-btn")
    ?.addEventListener("click", () => saveMapboxSettings(true));
  document.getElementById("mapboxToken")?.addEventListener("input", handleMapboxInput);

  document
    .getElementById("region-back-btn")
    ?.addEventListener("click", () => handleStepNavigation("mapbox"));
  document
    .getElementById("region-finish-btn")
    ?.addEventListener("click", completeSetup);
  document
    .getElementById("region-skip-btn")
    ?.addEventListener("click", handleRegionSkip);
  document
    .getElementById("confirm-region-skip")
    ?.addEventListener("click", confirmRegionSkip);

  document
    .getElementById("complete-back-btn")
    ?.addEventListener("click", () => handleStepNavigation("region"));
  document
    .getElementById("complete-setup-btn")
    ?.addEventListener("click", completeSetup);

  document
    .getElementById("connectBouncieBtn")
    ?.addEventListener("click", handleConnectBouncie);

  document
    .getElementById("syncVehiclesBtn")
    ?.addEventListener("click", syncVehiclesFromBouncie);

  document
    .getElementById("toggleClientSecret")
    ?.addEventListener("click", () => togglePasswordVisibility("clientSecret"));
  document;

  document
    .getElementById("download-region-btn")
    ?.addEventListener("click", downloadSelectedRegion);
  document
    .getElementById("region-cancel-btn")
    ?.addEventListener("click", cancelRegionDownload);
  document
    .getElementById("auto-region-btn")
    ?.addEventListener("click", autoDetectRegion);
  document
    .getElementById("region-view-us")
    ?.addEventListener("click", () => setRegionView(REGION_VIEW_US));
  document
    .getElementById("region-view-global")
    ?.addEventListener("click", () => setRegionView(REGION_VIEW_GLOBAL));
  document
    .getElementById("region-search-input")
    ?.addEventListener("input", handleRegionSearch);
  document
    .getElementById("region-breadcrumb")
    ?.addEventListener("click", handleBreadcrumbClick);
  document.getElementById("region-list")?.addEventListener("click", handleRegionClick);

  ["clientId", "clientSecret", "redirectUri"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => markDirty("bouncie"));
  });

  ["mapboxToken"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => markDirty("mapbox"));
  });
}

async function handleStepNavigation(nextStepKey, metadata = {}) {
  if (!sessionId || !sessionVersion) {
    return;
  }
  if (sessionReadOnly || actionInFlight || isStepLocked()) {
    showNavigationBlockedNotice();
    return;
  }
  const currentKey = getCurrentStepKey();
  if (nextStepKey === currentKey) {
    return;
  }
  setActionInFlight(true);
  try {
    const response = await apiClient.raw(
      `${SETUP_SESSION_API}/${sessionId}/advance`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: sessionClientId,
          current_step: currentKey,
          next_step: nextStepKey,
          version: sessionVersion,
          idempotency_key: createIdempotencyKey(),
          metadata,
        }),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to move setup step")
      );
    }
    applySessionState(data);
  } catch (error) {
    notificationManager.show(error.message, "danger");
  } finally {
    setActionInFlight(false);
  }
}

async function handleSessionTakeover() {
  if (!sessionId) {
    return;
  }
  setActionInFlight(true);
  try {
    const response = await apiClient.raw(
      `${SETUP_SESSION_API}/${sessionId}/claim`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: sessionClientId,
          force: true,
        }),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to claim setup session")
      );
    }
    applySessionState(data);
  } catch (error) {
    notificationManager.show(error.message, "danger");
  } finally {
    setActionInFlight(false);
  }
}

function showStep(index) {
  const steps = document.querySelectorAll(".setup-step");
  steps.forEach((step) => {
    const stepIndex = Number(step.dataset.step);
    step.classList.toggle("is-active", stepIndex === index);
  });
  currentStep = index;
  const stepKey = getStepKeyByIndex(index);
  if (stepKey === "region" && setupState.region) {
    showRegionStatus("A region is already configured. Add another if needed.", false);
  }
  if (stepKey === "complete") {
    updateSummary();
  }
  updateStepIndicators();
  applyLockState();
}

function updateStepIndicators() {
  document.querySelectorAll(".setup-step-item").forEach((item) => {
    const stepIndex = Number(item.dataset.step);
    item.classList.toggle("is-active", stepIndex === currentStep);
    const key = item.dataset.stepKey;
    const stepState = key ? sessionState?.step_states?.[key] : null;
    const isComplete = stepState?.status === "completed";
    item.classList.toggle("is-complete", Boolean(isComplete));
  });
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
        responseErrorMessage(response, data, "Unable to load credentials")
      );
    }
    const creds = data.credentials || {};
    document.getElementById("clientId").value = creds.client_id || "";
    document.getElementById("clientSecret").value = creds.client_secret || "";

    // Auto-populate redirect URI if empty
    let redirectUri = creds.redirect_uri || "";
    if (!redirectUri) {
      redirectUri = await getExpectedRedirectUri();
    }
    document.getElementById("redirectUri").value = redirectUri;

    bouncieDetails = {
      client_id: creds.client_id || "",
      redirect_uri: redirectUri || "",
    };
    updateSummary();
    clearDirty("bouncie");
  } catch (_error) {
    showStatus("setup-bouncie-status", "Unable to load credentials", true);
  }
}

async function getExpectedRedirectUri() {
  try {
    const response = await apiClient.raw(
      `${PROFILE_API.replace("/profile", "/bouncie")}/redirect-uri`,
      withSignal()
    );
    const data = await readJsonResponse(response);
    if (response.ok && data?.redirect_uri) {
      return data.redirect_uri;
    }
  } catch {
    // Fall back to constructing from window.location
  }
  // Fallback: construct from current URL
  return `${window.location.origin}/api/bouncie/callback`;
}

async function saveBouncieCredentials(advance = false) {
  if (!sessionId || !sessionVersion) {
    showStatus("setup-bouncie-status", "Setup session is not ready yet.", true);
    return;
  }
  if (sessionReadOnly || actionInFlight) {
    showStatus(
      "setup-bouncie-status",
      "Setup is locked while another step is running.",
      true
    );
    return;
  }
  const values = getBouncieFormValues();

  if (!values.client_id || !values.client_secret) {
    showStatus("setup-bouncie-status", "All credential fields are required.", true);
    return;
  }
  if (!values.redirect_uri) {
    showStatus("setup-bouncie-status", "Redirect URI is required.", true);
    return;
  }
  let shouldAdvance = false;
  try {
    showStatus("setup-bouncie-status", "Saving credentials...", false);
    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
        }),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to save credentials")
      );
    }
    bouncieDetails = {
      client_id: values.client_id,
      redirect_uri: values.redirect_uri,
    };
    updateSummary();
    clearDirty("bouncie");
    showStatus("setup-bouncie-status", data?.message || "Credentials saved.", false);
    shouldAdvance = advance;
  } catch (error) {
    showStatus("setup-bouncie-status", error.message, true);
  } finally {
    setActionInFlight(false);
  }
  if (shouldAdvance) {
    await handleStepNavigation("mapbox");
  }
}

async function syncVehiclesFromBouncie() {
  if (sessionReadOnly || actionInFlight) {
    showStatus(
      "setup-bouncie-status",
      "Setup is locked while another step is running.",
      true
    );
    return;
  }
  setActionInFlight(true);
  try {
    showStatus("setup-bouncie-status", "Syncing vehicles...", false);
    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials/sync-vehicles`,
      withSignal({ method: "POST" })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Failed to sync vehicles"));
    }
    clearDirty("bouncie");
    showStatus("setup-bouncie-status", data?.message || "Vehicles synced.", false);
    await updateBouncieConnectionStatus();
  } catch (error) {
    showStatus("setup-bouncie-status", error.message, true);
  } finally {
    setActionInFlight(false);
  }
}

async function handleConnectBouncie(e) {
  e.preventDefault();
  if (sessionReadOnly || actionInFlight) {
    showStatus(
      "setup-bouncie-status",
      "Setup is locked while another step is running.",
      true
    );
    return;
  }
  allowExternalRedirect = false;

  // 1. Validate form values
  const values = getBouncieFormValues();
  if (!values.client_id || !values.client_secret || !values.redirect_uri) {
    showStatus("setup-bouncie-status", "Please enter all credentials first.", true);
    return;
  }

  // 2. Save credentials (without advancing step)
  // We use saveBouncieCredentials but need to establish it doesn't navigate away
  // saveBouncieCredentials(false) is what we want.
  setActionInFlight(true);
  try {
    showStatus(
      "setup-bouncie-status",
      "Saving credentials before connecting...",
      false
    );

    // Using the existing save function logic but inline or calling it?
    // calling saveBouncieCredentials directly might be easier if it supports no-navigation.
    // It does support `advance=false` as argument.

    const response = await apiClient.raw(
      `${PROFILE_API}/bouncie-credentials`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values }),
      })
    );

    if (!response.ok) {
      const data = await readJsonResponse(response);
      throw new Error(
        responseErrorMessage(response, data, "Failed to save credentials")
      );
    }

    bouncieDetails = {
      client_id: values.client_id,
      redirect_uri: values.redirect_uri,
    };
    updateSummary();
    clearDirty("bouncie");
    showStatus("setup-bouncie-status", "Redirecting to Bouncie...", false);

    // 3. Redirect to authorize
    allowExternalRedirect = true;
    const modalShown = showBouncieRedirectModal();
    const redirectDelay = modalShown ? 450 : 0;
    window.setTimeout(() => {
      window.location.href = "/api/bouncie/authorize";
    }, redirectDelay);
  } catch (error) {
    showStatus("setup-bouncie-status", error.message, true);
    allowExternalRedirect = false;
    setActionInFlight(false);
  }
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) {
    return;
  }
  input.type = input.type === "password" ? "text" : "password";
}

async function loadServiceConfig() {
  try {
    const response = await apiClient.raw(APP_SETTINGS_API, withSignal());
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Unable to load Mapbox settings")
      );
    }
    mapboxTokenValue = data.mapbox_token || "";
    document.getElementById("mapboxToken").value = mapboxTokenValue;
    handleMapboxInput();
    updateSummary();
    clearDirty("mapbox");
  } catch (_error) {
    showStatus("setup-mapbox-status", "Unable to load Mapbox settings.", true);
  }
}

function handleMapboxInput() {
  const token = document.getElementById("mapboxToken").value.trim();
  if (!token) {
    mapPreview = destroyMapPreview(mapPreview);
    showStatus("setup-mapbox-status", "Enter a Mapbox token to preview maps.", false);
    return;
  }
  if (!isValidMapboxToken(token)) {
    mapPreview = destroyMapPreview(mapPreview);
    showStatus(
      "setup-mapbox-status",
      "Mapbox token must start with pk. and be valid length.",
      true
    );
    return;
  }
  showStatus("setup-mapbox-status", "Token looks good.", false);
  mapPreview = destroyMapPreview(mapPreview);
  mapPreview = renderMapPreview({
    token,
    onError: () => {
      showStatus(
        "setup-mapbox-status",
        "Map preview failed to load. Double-check the token.",
        true
      );
    },
  });
}

async function saveMapboxSettings(advance = false) {
  if (!sessionId || !sessionVersion) {
    showStatus("setup-mapbox-status", "Setup session is not ready yet.", true);
    return;
  }
  if (sessionReadOnly || actionInFlight) {
    showStatus(
      "setup-mapbox-status",
      "Setup is locked while another step is running.",
      true
    );
    return;
  }
  const token = document.getElementById("mapboxToken").value.trim();
  if (!isValidMapboxToken(token)) {
    showStatus("setup-mapbox-status", "Enter a valid Mapbox token.", true);
    return;
  }

  const payload = {
    mapbox_token: token,
  };

  setActionInFlight(true);
  let shouldAdvance = false;
  try {
    showStatus("setup-mapbox-status", "Saving Mapbox settings...", false);
    const response = await apiClient.raw(
      APP_SETTINGS_API,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Failed to save settings"));
    }
    mapboxTokenValue = token;
    updateSummary();
    clearDirty("mapbox");
    showStatus("setup-mapbox-status", "Mapbox settings saved.", false);
    shouldAdvance = advance;
  } catch (error) {
    showStatus("setup-mapbox-status", error.message, true);
  } finally {
    setActionInFlight(false);
  }
  if (shouldAdvance) {
    await handleStepNavigation("region");
  }
}

async function loadRegionView() {
  updateRegionViewControls();
  if (regionView === REGION_VIEW_US) {
    await loadUsRegions();
  } else {
    await loadGeofabrikRegions(currentRegionPath.join("/"));
  }
}

function setRegionView(view) {
  if (regionView === view) {
    return;
  }
  regionView = view;
  regionSearchQuery = "";
  const searchInput = document.getElementById("region-search-input");
  if (searchInput) {
    searchInput.value = "";
  }
  selectedRegion = null;
  updateSelectedRegionUI();
  if (regionView === REGION_VIEW_US) {
    currentRegionPath = [];
    loadUsRegions();
  } else {
    loadGeofabrikRegions(currentRegionPath.join("/"));
  }
  updateRegionViewControls();
}

function updateRegionViewControls() {
  const usBtn = document.getElementById("region-view-us");
  const globalBtn = document.getElementById("region-view-global");
  usBtn?.classList.toggle("is-active", regionView === REGION_VIEW_US);
  globalBtn?.classList.toggle("is-active", regionView === REGION_VIEW_GLOBAL);

  const breadcrumb = document.getElementById("region-breadcrumb");
  if (breadcrumb && regionView === REGION_VIEW_US) {
    breadcrumb.innerHTML = '<li class="breadcrumb-item active">United States</li>';
  }

  const searchWrap = document.getElementById("region-search-wrap");
  const searchInput = document.getElementById("region-search-input");
  if (searchWrap) {
    searchWrap.classList.remove("d-none");
  }
  if (searchInput) {
    searchInput.placeholder =
      regionView === REGION_VIEW_US ? "Search states" : "Search regions";
  }
}

function handleRegionSearch(event) {
  regionSearchQuery = event.target.value || "";
  applyRegionFilter();
}

function applyRegionFilter() {
  const regionList = document.getElementById("region-list");
  if (!regionList) {
    return;
  }
  const query = regionSearchQuery.trim().toLowerCase();
  if (!query) {
    renderRegionList(regionList, currentRegionItems);
    return;
  }
  const filtered = currentRegionItems.filter((region) => {
    const name = String(region.name || "").toLowerCase();
    const id = String(region.id || "").toLowerCase();
    return name.includes(query) || id.includes(query);
  });
  renderRegionList(regionList, filtered);
}

async function loadUsRegions() {
  const regionList = document.getElementById("region-list");
  if (!regionList) {
    return;
  }
  if (usRegionItems.length > 0) {
    currentRegionItems = usRegionItems;
    applyRegionFilter();
    updateBreadcrumb();
    return;
  }
  regionList.innerHTML = '<div class="text-muted">Loading regions...</div>';

  try {
    const data = await apiClient.get(
      `${MAP_DATA_API}/geofabrik/us-states`,
      withSignal()
    );
    const sorted = sortRegions(data?.regions || []);
    usRegionItems = sorted;
    currentRegionItems = sorted;
    applyRegionFilter();
    updateBreadcrumb();
  } catch (_error) {
    currentRegionItems = [];
    regionList.innerHTML = '<div class="text-danger">Failed to load regions.</div>';
  }
}

async function loadGeofabrikRegions(parent = "") {
  const regionList = document.getElementById("region-list");
  if (!regionList) {
    return;
  }
  regionList.innerHTML = '<div class="text-muted">Loading regions...</div>';

  try {
    const url = parent
      ? `${MAP_DATA_API}/geofabrik/regions?parent=${encodeURIComponent(parent)}`
      : `${MAP_DATA_API}/geofabrik/regions`;
    const data = await apiClient.get(url, withSignal());
    const sorted = sortRegions(data?.regions || []);
    currentRegionItems = sorted;
    applyRegionFilter();
    updateBreadcrumb();
  } catch (_error) {
    currentRegionItems = [];
    regionList.innerHTML = '<div class="text-danger">Failed to load regions.</div>';
  }
}

function handleBreadcrumbClick(event) {
  if (regionControlsLocked) {
    return;
  }
  if (regionView === REGION_VIEW_US) {
    return;
  }
  const link = event.target.closest("a[data-region]");
  if (!link) {
    return;
  }
  event.preventDefault();
  const { region } = link.dataset;
  if (!region) {
    currentRegionPath = [];
  } else {
    const index = currentRegionPath.indexOf(region);
    if (index >= 0) {
      currentRegionPath = currentRegionPath.slice(0, index + 1);
    }
  }
  selectedRegion = null;
  updateSelectedRegionUI();
  loadGeofabrikRegions(currentRegionPath.join("/"));
}

function handleRegionClick(event) {
  if (regionControlsLocked) {
    return;
  }
  const item = event.target.closest(".region-item");
  if (!item) {
    return;
  }
  const { regionId, regionName, regionSize } = item.dataset;
  const hasChildren = item.dataset.hasChildren === "true";
  if (hasChildren) {
    currentRegionPath.push(regionId);
    selectedRegion = null;
    updateSelectedRegionUI();
    loadGeofabrikRegions(currentRegionPath.join("/"));
    return;
  }

  selectedRegion = {
    id: regionId,
    name: regionName,
    size: regionSize,
    has_children: hasChildren,
  };
  updateSelectedRegionUI();
  document.querySelectorAll(".region-item").forEach((el) => {
    el.classList.remove("is-selected");
  });
  item.classList.add("is-selected");
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById("region-breadcrumb");
  if (!breadcrumb) {
    return;
  }
  if (regionView === REGION_VIEW_US) {
    breadcrumb.innerHTML = '<li class="breadcrumb-item active">United States</li>';
    return;
  }
  const items = [{ id: "", name: "World" }];
  let path = "";
  for (const segment of currentRegionPath) {
    path = path ? `${path}/${segment}` : segment;
    items.push({
      id: path,
      name: segment.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    });
  }
  breadcrumb.innerHTML = items
    .map(
      (item, index) => `
        <li class="breadcrumb-item ${index === items.length - 1 ? "active" : ""}">
          ${
            index === items.length - 1
              ? item.name
              : `<a href="#" data-region="${item.id}">${item.name}</a>`
          }
        </li>
      `
    )
    .join("");
}

function updateSelectedRegionUI() {
  const info = document.getElementById("selected-region-info");
  const nameEl = document.getElementById("selected-region-name");
  const idEl = document.getElementById("selected-region-id");
  const sizeEl = document.getElementById("selected-region-size");
  const downloadBtn = document.getElementById("download-region-btn");
  const warningEl = document.getElementById("selected-region-warning");

  if (selectedRegion) {
    info?.classList.remove("d-none");
    downloadBtn.disabled = regionControlsLocked;
    nameEl.textContent = selectedRegion.name;
    idEl.textContent = selectedRegion.id;
    sizeEl.textContent = selectedRegion.size
      ? `${parseFloat(selectedRegion.size).toFixed(1)} MB`
      : "Unknown";
    const warnings = [];
    const sizeValue = Number(selectedRegion.size);
    if (Number.isFinite(sizeValue) && sizeValue >= REGION_LARGE_DOWNLOAD_MB) {
      warnings.push(
        `Large download (~${sizeValue.toFixed(1)} MB). Plan for extra disk space and a long build time.`
      );
    }
    if (warningEl) {
      if (warnings.length > 0) {
        warningEl.textContent = warnings.join(" ");
        warningEl.classList.remove("d-none");
      } else {
        warningEl.textContent = "";
        warningEl.classList.add("d-none");
      }
    }
  } else {
    info?.classList.add("d-none");
    downloadBtn.disabled = true;
    if (warningEl) {
      warningEl.textContent = "";
      warningEl.classList.add("d-none");
    }
  }
}

function updateRegionCancelUI(stepState) {
  const cancelWrap = document.getElementById("region-cancel-wrap");
  const cancelBtn = document.getElementById("region-cancel-btn");
  if (!cancelWrap || !cancelBtn) {
    return;
  }
  const jobStatus = stepState?.metadata?.job_status;
  const canCancel = Boolean(
    jobStatus && ["pending", "running"].includes(jobStatus.status)
  );
  cancelWrap.classList.toggle("d-none", !canCancel);
  cancelBtn.disabled = !canCancel || sessionReadOnly || actionInFlight;
}

function setRegionControlsLocked(locked) {
  const isLocked = Boolean(locked || sessionReadOnly || actionInFlight);
  regionControlsLocked = isLocked;
  const regionList = document.getElementById("region-list");
  const breadcrumb = document.getElementById("region-breadcrumb");
  const regionActions = document.querySelector(".setup-region-actions");
  const controlIds = [
    "auto-region-btn",
    "region-back-btn",
    "region-skip-btn",
    "region-continue-btn",
    "region-view-us",
    "region-view-global",
    "region-search-input",
  ];

  regionList?.classList.toggle("is-disabled", isLocked);
  breadcrumb?.classList.toggle("is-disabled", isLocked);
  regionActions?.classList.toggle("is-disabled", isLocked);
  controlIds.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = isLocked;
    }
  });
  updateSelectedRegionUI();
  updateRegionCancelUI(getRegionStepState());
}

async function downloadSelectedRegion() {
  if (!selectedRegion) {
    return;
  }
  const sizeValue = Number(selectedRegion.size);
  if (Number.isFinite(sizeValue) && sizeValue >= REGION_LARGE_DOWNLOAD_MB) {
    if (confirmationDialog) {
      const confirmed = await confirmationDialog.show({
        title: "Large download",
        message: `This region is about ${sizeValue.toFixed(
          1
        )} MB. Large downloads can take hours and require plenty of disk space. Continue?`,
        confirmText: "Download",
        cancelText: "Cancel",
        confirmButtonClass: "btn-warning",
      });
      if (!confirmed) {
        return;
      }
    }
  }
  await runRegionStep("download", selectedRegion);
}

async function autoDetectRegion() {
  await runRegionStep("auto", null);
}

async function cancelRegionDownload() {
  const jobStatus = getRegionJobStatus();
  const jobId = jobStatus?.id;
  if (!jobId) {
    showRegionStatus("No active download to cancel.", true);
    return;
  }
  if (sessionReadOnly || actionInFlight) {
    showRegionStatus("Setup is locked while another step is running.", true);
    return;
  }
  let confirmed = false;
  if (confirmationDialog) {
    confirmed = await confirmationDialog.show({
      title: "Cancel map download?",
      message:
        "This stops the download and removes any partial files. You can restart it later.",
      confirmText: "Cancel download",
      cancelText: "Keep downloading",
      confirmButtonClass: "btn-danger",
    });
  }
  if (!confirmed) {
    return;
  }
  setActionInFlight(true);
  try {
    showRegionStatus("Cancelling download and cleaning up files...", false);
    const response = await apiClient.raw(
      `${MAP_DATA_API}/jobs/${jobId}`,
      withSignal({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to cancel download")
      );
    }
    await refreshSetupSession();
  } catch (error) {
    showRegionStatus(error.message, true);
  } finally {
    setActionInFlight(false);
  }
}

async function runRegionStep(mode, region) {
  if (!sessionId || !sessionVersion) {
    showRegionStatus("Setup session is not ready yet.", true);
    return;
  }
  if (sessionReadOnly || actionInFlight) {
    showRegionStatus("Setup is locked while another step is running.", true);
    return;
  }
  setActionInFlight(true);
  try {
    showRegionStatus(
      mode === "auto"
        ? "Searching for a suggested region..."
        : "Starting download and build. This runs in the background, so it is safe to close this tab or browser.",
      false
    );
    const response = await apiClient.raw(
      `${SETUP_SESSION_API}/${sessionId}/step/region/run`,
      withSignal({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: sessionClientId,
          version: sessionVersion,
          idempotency_key: createIdempotencyKey(),
          mode,
          region,
        }),
      })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to start region setup")
      );
    }
    applySessionState(data);
  } catch (error) {
    showRegionStatus(error.message, true);
  } finally {
    setActionInFlight(false);
  }
}

function updateRegionFromSession(stepState) {
  if (!stepState) {
    return;
  }
  const metadata = stepState.metadata || {};
  const jobStatus = metadata.job_status || null;
  if (metadata.selected_region) {
    selectedRegion = {
      id: metadata.selected_region.id,
      name: metadata.selected_region.name,
      size: metadata.selected_region.size,
    };
    updateSelectedRegionUI();
  } else if (!stepState.in_flight) {
    selectedRegion = null;
    updateSelectedRegionUI();
  }

  const progressWrap = document.getElementById("region-progress");
  const progressBar = document.getElementById("region-progress-bar");
  const progressText = document.getElementById("region-progress-text");
  const backgroundNote = document.getElementById("region-background-note");
  let lastProgressAgeMinutes = null;

  if (jobStatus && progressWrap && progressBar && progressText) {
    const progress = Number(jobStatus.progress || 0);
    progressWrap.classList.remove("d-none");
    progressBar.style.width = `${progress}%`;
    progressBar.textContent = `${Math.round(progress)}%`;
    const message = jobStatus.message || jobStatus.stage || "Working...";
    const lastProgressAt = jobStatus.last_progress_at
      ? new Date(jobStatus.last_progress_at)
      : null;
    if (lastProgressAt && !Number.isNaN(lastProgressAt.getTime())) {
      lastProgressAgeMinutes = (Date.now() - lastProgressAt.getTime()) / 60000;
      const timeAgo = formatTimeAgo(lastProgressAt.toISOString(), true);
      progressText.textContent = `${message} (updated ${timeAgo})`;
    } else {
      progressText.textContent = message;
    }
  } else {
    progressWrap?.classList.add("d-none");
  }

  if (backgroundNote) {
    backgroundNote.classList.toggle("d-none", !stepState.in_flight);
  }

  updateRegionCancelUI(stepState);

  if (jobStatus && !["completed", "failed", "cancelled"].includes(jobStatus.status)) {
    if (
      lastProgressAgeMinutes !== null &&
      lastProgressAgeMinutes >= REGION_STALE_PROGRESS_MINUTES
    ) {
      showRegionStatus(
        `No progress updates in ${Math.round(
          lastProgressAgeMinutes
        )} minutes. The worker may be stalled. Try canceling and restarting the download.`,
        true
      );
    } else {
      showRegionStatus(
        "Download is running in the background. You can close this tab or browser and return later.",
        false
      );
    }
  }
  if (jobStatus?.status === "completed") {
    showRegionStatus("Region download complete.", false);
  }
  if (jobStatus?.status === "failed") {
    showRegionStatus(jobStatus.error || "Region setup failed.", true);
  }
  if (jobStatus?.status === "cancelled") {
    showRegionStatus("Region setup was cancelled.", true);
  }
}

function updateGeoServiceStatus(geoServices) {
  const stepStatus = document.getElementById("region-step-status");
  const banner = document.getElementById("region-service-banner");
  const title = document.getElementById("region-service-title");
  const detail = document.getElementById("region-service-detail");
  const completeBanner = document.getElementById("region-ready-banner");

  if (!geoServices) {
    if (stepStatus) {
      stepStatus.textContent = "Service status unavailable";
    }
    if (title) {
      title.textContent = "Map service status unavailable";
    }
    if (detail) {
      detail.textContent = "";
    }
    if (completeBanner) {
      completeBanner.classList.add("d-none");
    }
    return;
  }

  const nominatim = geoServices.nominatim || {};
  const valhalla = geoServices.valhalla || {};
  const containersRunning = Boolean(
    nominatim.container_running && valhalla.container_running
  );
  const servicesReady = Boolean(nominatim.has_data && valhalla.has_data);

  if (stepStatus) {
    if (servicesReady) {
      stepStatus.textContent = "Services ready";
    } else if (containersRunning) {
      stepStatus.textContent = "Services waiting for data";
    } else {
      stepStatus.textContent = "Containers offline";
    }
  }

  if (title) {
    if (servicesReady) {
      title.textContent = "Map services are ready";
    } else if (containersRunning) {
      title.textContent = "Map services are waiting for data";
    } else {
      title.textContent = "Map service containers are offline";
    }
  }

  if (detail) {
    const nomContainer = nominatim.container_running ? "Running" : "Stopped";
    const valContainer = valhalla.container_running ? "Running" : "Stopped";
    const nomData = nominatim.has_data ? "Ready" : "Missing";
    const valData = valhalla.has_data ? "Ready" : "Missing";
    detail.textContent = `Containers: Nominatim ${nomContainer}, Valhalla ${valContainer} | Data: Nominatim ${nomData}, Valhalla ${valData}`;
  }

  if (banner) {
    banner.classList.toggle("setup-region-alert-ready", servicesReady);
  }
  if (completeBanner) {
    const showBanner = !setupState.region || !servicesReady;
    completeBanner.classList.toggle("d-none", !showBanner);
  }
}

function handleRegionSkip() {
  if (sessionReadOnly || actionInFlight || isStepLocked()) {
    showRegionStatus("Setup is locked while another step is running.", true);
    return;
  }
  const modalEl = document.getElementById("regionSkipModal");
  if (modalEl && window.bootstrap?.Modal) {
    const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
    return;
  }
  if (confirmationDialog) {
    confirmationDialog
      .show({
        title: "Skip map data setup?",
        message:
          "Geocoding and routing stay offline until you import a region. Continue anyway?",
        confirmText: "Skip",
        cancelText: "Keep setting up",
        confirmButtonClass: "btn-warning",
      })
      .then((confirmed) => {
        if (confirmed) {
          handleStepNavigation("complete", { region_skipped: true });
        }
      });
  }
}

function confirmRegionSkip() {
  const modalEl = document.getElementById("regionSkipModal");
  if (modalEl && window.bootstrap?.Modal) {
    window.bootstrap.Modal.getInstance(modalEl)?.hide();
  }
  // Complete setup directly, skipping the region step
  completeSetup();
}

function showRegionStatus(message, isError) {
  showStatus("region-status", message, isError);
}

function maskValue(value, head = 4, tail = 4) {
  if (!value) {
    return "";
  }
  const text = String(value);
  if (text.length <= head + tail) {
    return text;
  }
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function truncateText(value, maxLength = 100) {
  if (!value) {
    return "";
  }
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatRegionSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return `${parsed.toFixed(1)} MB`;
}

function getGeoServiceSummary(geoServices) {
  if (!geoServices) {
    return "";
  }
  const nominatim = geoServices.nominatim || {};
  const valhalla = geoServices.valhalla || {};
  const containersRunning = Boolean(
    nominatim.container_running && valhalla.container_running
  );
  const servicesReady = Boolean(nominatim.has_data && valhalla.has_data);
  if (servicesReady) {
    return "Ready";
  }
  if (containersRunning) {
    return "Waiting for data";
  }
  return "Offline";
}

function buildBouncieSummaryDetail() {
  const parts = [];
  const clientId = bouncieDetails?.client_id?.trim() || "";
  const redirectUri = bouncieDetails?.redirect_uri?.trim() || "";
  const clientIdLabel = clientId
    ? maskValue(clientId, 4, 4)
    : setupState.bouncie
      ? "Set"
      : "Not set";
  const redirectLabel = redirectUri || (setupState.bouncie ? "Set" : "Not set");
  parts.push(`Client ID: ${clientIdLabel}`);
  parts.push(`Redirect URI: ${redirectLabel}`);
  if (bouncieStatus) {
    if (typeof bouncieStatus.connected === "boolean") {
      parts.push(`Connected: ${bouncieStatus.connected ? "Yes" : "No"}`);
    }
    if (typeof bouncieStatus.device_count === "number") {
      parts.push(`Vehicles: ${bouncieStatus.device_count}`);
    }
  }
  return parts.join(" | ");
}

function buildMapboxSummaryDetail() {
  const parts = [];
  const token = mapboxTokenValue?.trim();
  const mapboxStep = setupStatus?.steps?.mapbox || {};
  const tokenLabel = token
    ? maskValue(token, 8, 4)
    : mapboxStep.complete
      ? "Set"
      : "Not set";
  parts.push(`Token: ${tokenLabel}`);
  if (mapboxStep.error) {
    parts.push(`Error: ${truncateText(mapboxStep.error, 90)}`);
  } else if (typeof mapboxStep.complete === "boolean") {
    parts.push(`Valid: ${mapboxStep.complete ? "Yes" : "No"}`);
  }
  return parts.join(" | ");
}

function buildRegionSummaryDetail() {
  const parts = [];
  const regionState = sessionState?.step_states?.region || {};
  const metadata = regionState?.metadata || {};
  if (metadata.skipped) {
    parts.push("Skipped for now");
  }

  if (selectedRegion?.name || selectedRegion?.id) {
    let label = selectedRegion.name || selectedRegion.id;
    if (selectedRegion.name && selectedRegion.id) {
      label = `${selectedRegion.name} (${selectedRegion.id})`;
    }
    const sizeLabel = formatRegionSize(selectedRegion.size);
    if (sizeLabel) {
      label = `${label} - ${sizeLabel}`;
    }
    parts.push(`Selected: ${label}`);
  } else if (setupState.region) {
    parts.push("Selected: Previously configured");
  } else {
    parts.push("Selected: Not set");
  }

  const jobStatus = metadata.job_status;
  if (jobStatus?.status) {
    let jobLabel = `Download: ${jobStatus.status}`;
    const progress = Number(jobStatus.progress || 0);
    if (
      ["pending", "running"].includes(jobStatus.status) &&
      Number.isFinite(progress)
    ) {
      jobLabel = `${jobLabel} (${Math.round(progress)}%)`;
    }
    parts.push(jobLabel);
  }

  const serviceSummary = getGeoServiceSummary(geoServiceStatus);
  if (serviceSummary) {
    parts.push(`Services: ${serviceSummary}`);
  }

  return parts.join(" | ");
}

function updateSummary() {
  const bouncieStatusEl = document.getElementById("summary-bouncie");
  if (bouncieStatusEl) {
    bouncieStatusEl.textContent = setupState.bouncie ? "Configured" : "Missing";
  }
  const mapboxStatusEl = document.getElementById("summary-mapbox");
  if (mapboxStatusEl) {
    mapboxStatusEl.textContent = setupState.mapbox ? "Configured" : "Missing";
  }
  const regionStatusEl = document.getElementById("summary-region");
  if (regionStatusEl) {
    regionStatusEl.textContent = setupState.region ? "Configured" : "Needs data";
  }

  const bouncieDetailEl = document.getElementById("summary-bouncie-detail");
  if (bouncieDetailEl) {
    bouncieDetailEl.textContent = buildBouncieSummaryDetail() || "--";
  }
  const mapboxDetailEl = document.getElementById("summary-mapbox-detail");
  if (mapboxDetailEl) {
    mapboxDetailEl.textContent = buildMapboxSummaryDetail() || "--";
  }
  const regionDetailEl = document.getElementById("summary-region-detail");
  if (regionDetailEl) {
    regionDetailEl.textContent = buildRegionSummaryDetail() || "--";
  }
}

async function completeSetup() {
  if (sessionReadOnly || actionInFlight) {
    showStatus("setup-complete-status", "Setup is locked in another tab.", true);
    return;
  }
  if (!setupState.bouncie || !setupState.mapbox) {
    showStatus(
      "setup-complete-status",
      "Complete the required steps before finishing setup.",
      true
    );
    return;
  }
  setActionInFlight(true);
  try {
    showStatus("setup-complete-status", "Finalizing setup...", false);
    const response = await apiClient.raw(
      `${SETUP_API}/complete`,
      withSignal({ method: "POST" })
    );
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(responseErrorMessage(response, data, "Failed to complete setup"));
    }
    const alreadyCompleted = Boolean(data?.already_completed);
    showStatus(
      "setup-complete-status",
      alreadyCompleted
        ? "Setup is already completed. You can review settings here."
        : "Setup complete! Redirecting...",
      false
    );
    await refreshSetupSession();
    if (!alreadyCompleted) {
      window.location.assign("/");
    }
  } catch (error) {
    showStatus("setup-complete-status", error.message, true);
  } finally {
    setActionInFlight(false);
  }
}

function showStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.remove("is-error", "is-success");
  if (isError) {
    el.classList.add("is-error");
  } else {
    el.classList.add("is-success");
  }
  el.style.display = "block";
}
