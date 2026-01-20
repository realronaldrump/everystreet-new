/* global mapboxgl */
(() => {
  const SETUP_API = "/api/setup";
  const SETUP_SESSION_API = "/api/setup/session";
  const PROFILE_API = "/api/profile";
  const APP_SETTINGS_API = "/api/app_settings";
  const MAP_DATA_API = "/api/map-data";
  const SETUP_TAB_STORAGE_KEY = "es:setup-tab-id";
  const SESSION_POLL_INTERVAL_MS = 3500;

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
  const dirtyState = {
    bouncie: false,
    mapbox: false,
  };
  let currentDevices = [];
  let selectedRegion = null;
  let currentRegionPath = [];
  let mapPreview = null;
  let pageSignal = null;
  let regionControlsLocked = false;
  let geoServiceStatus = null;

  window.utils?.onPageLoad(
    ({ signal, cleanup } = {}) => {
      pageSignal = signal || null;
      initializeSetup();
      if (typeof cleanup === "function") {
        cleanup(() => {
          pageSignal = null;
          stopSessionPolling();
          teardownNavigationGuard();
          destroyMapPreview();
        });
      }
    },
    { route: "/setup" }
  );

  function withSignal(options = {}) {
    if (pageSignal) {
      return { ...options, signal: pageSignal };
    }
    return options;
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function responseErrorMessage(response, data, fallback) {
    if (data && typeof data === "object") {
      const detail = data.detail || data.message || data.error;
      if (detail) {
        if (typeof detail === "string") {
          return detail;
        }
        if (typeof detail === "object") {
          return detail.message || detail.detail || JSON.stringify(detail);
        }
      }
    }
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    return fallback || `Request failed (${response.status}${statusText})`;
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
    const response = await fetch(
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

    if (setupStatus?.setup_completed) {
      window.location.assign("/");
      return;
    }

    setupState.bouncie = Boolean(setupStatus?.steps?.bouncie?.complete);
    setupState.mapbox = Boolean(setupStatus?.steps?.mapbox?.complete);
    setupState.region = Boolean(setupStatus?.steps?.region?.complete);
    geoServiceStatus = setupStatus?.geo_services || null;

    const nextIndex = getStepIndexByKey(sessionState.current_step || "welcome");
    showStep(nextIndex >= 0 ? nextIndex : 0);
    updateStepIndicators();
    updateSummary();
    updateGeoServiceStatus(geoServiceStatus);
    updateRegionFromSession(sessionState.step_states?.region);
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
      message.textContent
        = "Setup is active in another tab. This view is read-only until it finishes.";
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
      "bouncie-back-btn",
      "bouncie-save-btn",
      "toggleClientSecret",
      "toggleAuthCode",
      "mapbox-back-btn",
      "mapbox-save-btn",
      "region-back-btn",
      "region-continue-btn",
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
      "authorizationCode",
      "fetchConcurrency",
      "mapboxToken",
    ].forEach((id) => {
      const input = document.getElementById(id);
      if (input) {
        input.disabled = locked;
      }
    });

    document
      .querySelectorAll("#devicesList input, #devicesList button")
      .forEach((el) => {
        el.disabled = locked;
      });

    setRegionControlsLocked(locked || isStepLocked());
  }

  function registerNavigationGuard() {
    teardownNavigationGuard();
    const guard = async () => {
      if (sessionReadOnly) {
        return true;
      }
      if (actionInFlight || isStepLocked()) {
        showNavigationBlockedNotice();
        return false;
      }
      const stepKey = getCurrentStepKey();
      if (isStepDirty(stepKey)) {
        if (window.confirmationDialog) {
          return window.confirmationDialog.show({
            title: "Leave setup?",
            message: "You have unsaved changes. Leaving will discard them.",
            confirmText: "Leave",
            cancelText: "Stay",
            confirmButtonClass: "btn-danger",
          });
        }
        return window.confirm("You have unsaved changes. Leave setup?");
      }
      return true;
    };

    const handleBeforeUnload = (event) => {
      if (actionInFlight || isStepLocked()) {
        event.preventDefault();
        event.returnValue = "Setup is running. Leaving may interrupt it.";
        return event.returnValue;
      }
      if (isStepDirty(getCurrentStepKey())) {
        event.preventDefault();
        event.returnValue = "You have unsaved setup changes.";
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
    window.notificationManager?.show?.(
      "Setup is running. Please wait for the current step to finish.",
      "warning"
    );
  }

  async function initializeSetup() {
    bindEventListeners();
    sessionClientId = getSessionClientId();
    await initSetupSession();
    await loadBouncieCredentials();
    await loadServiceConfig();
    await loadGeofabrikRegions();
    updateResumeCta();
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
    document
      .getElementById("mapboxToken")
      ?.addEventListener("input", handleMapboxInput);

    document
      .getElementById("region-back-btn")
      ?.addEventListener("click", () => handleStepNavigation("mapbox"));
    document
      .getElementById("region-continue-btn")
      ?.addEventListener("click", () => handleStepNavigation("complete"));
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

    document.getElementById("addDeviceBtn")?.addEventListener("click", addDeviceInput);
    document
      .getElementById("syncVehiclesBtn")
      ?.addEventListener("click", syncVehiclesFromBouncie);

    document
      .getElementById("toggleClientSecret")
      ?.addEventListener("click", () => togglePasswordVisibility("clientSecret"));
    document
      .getElementById("toggleAuthCode")
      ?.addEventListener("click", () => togglePasswordVisibility("authorizationCode"));

    document
      .getElementById("download-region-btn")
      ?.addEventListener("click", downloadSelectedRegion);
    document
      .getElementById("auto-region-btn")
      ?.addEventListener("click", autoDetectRegion);
    document
      .getElementById("region-breadcrumb")
      ?.addEventListener("click", handleBreadcrumbClick);
    document
      .getElementById("region-list")
      ?.addEventListener("click", handleRegionClick);

    [
      "clientId",
      "clientSecret",
      "redirectUri",
      "authorizationCode",
      "fetchConcurrency",
    ].forEach((id) => {
      document
        .getElementById(id)
        ?.addEventListener("input", () => markDirty("bouncie"));
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
      const response = await fetch(
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
      window.notificationManager?.show?.(error.message, "danger");
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
      const response = await fetch(
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
      window.notificationManager?.show?.(error.message, "danger");
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
      const response = await fetch(
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
      document.getElementById("redirectUri").value = creds.redirect_uri || "";
      document.getElementById("authorizationCode").value
        = creds.authorization_code || "";
      document.getElementById("fetchConcurrency").value = creds.fetch_concurrency || 12;
      currentDevices = Array.isArray(creds.authorized_devices)
        ? creds.authorized_devices
        : [];
      renderDevices();
      clearDirty("bouncie");
    } catch (_error) {
      showStatus("setup-bouncie-status", "Unable to load credentials", true);
    }
  }

  function renderDevices() {
    const container = document.getElementById("devicesList");
    if (!container) {
      return;
    }
    if (!Array.isArray(currentDevices) || currentDevices.length === 0) {
      currentDevices = [""];
    }
    container.innerHTML = "";
    currentDevices.forEach((device, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "input-group mb-2";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "form-control";
      input.placeholder = "Enter device IMEI";
      input.value = device || "";
      input.disabled = sessionReadOnly || actionInFlight || isStepLocked();
      input.addEventListener("input", (event) => {
        currentDevices[index] = event.target.value;
        markDirty("bouncie");
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-outline-danger";
      removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
      removeBtn.disabled = sessionReadOnly || actionInFlight || isStepLocked();
      removeBtn.addEventListener("click", () => removeDeviceInput(index));

      wrapper.appendChild(input);
      wrapper.appendChild(removeBtn);
      container.appendChild(wrapper);
    });
  }

  function addDeviceInput() {
    if (sessionReadOnly || actionInFlight || isStepLocked()) {
      showStatus(
        "setup-bouncie-status",
        "Setup is locked while another step runs.",
        true
      );
      return;
    }
    currentDevices.push("");
    markDirty("bouncie");
    renderDevices();
  }

  function removeDeviceInput(index) {
    if (sessionReadOnly || actionInFlight || isStepLocked()) {
      showStatus(
        "setup-bouncie-status",
        "Setup is locked while another step runs.",
        true
      );
      return;
    }
    if (currentDevices.length <= 1) {
      showStatus("setup-bouncie-status", "At least one device is required.", true);
      return;
    }
    currentDevices.splice(index, 1);
    markDirty("bouncie");
    renderDevices();
  }

  function getBouncieFormValues() {
    const fetchConcurrency = Number.parseInt(
      document.getElementById("fetchConcurrency").value,
      10
    );
    return {
      client_id: document.getElementById("clientId").value.trim(),
      client_secret: document.getElementById("clientSecret").value.trim(),
      redirect_uri: document.getElementById("redirectUri").value.trim(),
      authorization_code: document.getElementById("authorizationCode").value.trim(),
      authorized_devices: currentDevices.map((device) => device.trim()),
      fetch_concurrency: Number.isFinite(fetchConcurrency) ? fetchConcurrency : 12,
    };
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
    const devices = values.authorized_devices.filter((device) => device.length > 0);

    if (!values.client_id || !values.client_secret || !values.authorization_code) {
      showStatus("setup-bouncie-status", "All credential fields are required.", true);
      return;
    }
    if (!values.redirect_uri) {
      showStatus("setup-bouncie-status", "Redirect URI is required.", true);
      return;
    }
    if (devices.length === 0) {
      showStatus("setup-bouncie-status", "Add at least one authorized device.", true);
      return;
    }

    setActionInFlight(true);
    let shouldAdvance = false;
    try {
      showStatus("setup-bouncie-status", "Saving credentials...", false);
      const response = await fetch(
        `${PROFILE_API}/bouncie-credentials`,
        withSignal({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...values,
            authorized_devices: devices,
          }),
        })
      );
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(response, data, "Failed to save credentials")
        );
      }
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
      const response = await fetch(
        `${PROFILE_API}/bouncie-credentials/sync-vehicles`,
        withSignal({ method: "POST" })
      );
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(response, data, "Failed to sync vehicles")
        );
      }
      currentDevices = Array.isArray(data.authorized_devices)
        ? data.authorized_devices
        : currentDevices;
      renderDevices();
      clearDirty("bouncie");
      showStatus("setup-bouncie-status", data?.message || "Vehicles synced.", false);
    } catch (error) {
      showStatus("setup-bouncie-status", error.message, true);
    } finally {
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
      const response = await fetch(APP_SETTINGS_API, withSignal());
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(response, data, "Unable to load Mapbox settings")
        );
      }
      document.getElementById("mapboxToken").value = data.mapbox_token || "";
      handleMapboxInput();
      clearDirty("mapbox");
    } catch (_error) {
      showStatus("setup-mapbox-status", "Unable to load Mapbox settings.", true);
    }
  }

  function handleMapboxInput() {
    const token = document.getElementById("mapboxToken").value.trim();
    if (!token) {
      destroyMapPreview();
      showStatus("setup-mapbox-status", "Enter a Mapbox token to preview maps.", false);
      return;
    }
    if (!isValidMapboxToken(token)) {
      destroyMapPreview();
      showStatus(
        "setup-mapbox-status",
        "Mapbox token must start with pk. and be valid length.",
        true
      );
      return;
    }
    showStatus("setup-mapbox-status", "Token looks good.", false);
    renderMapPreview(token);
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
      const response = await fetch(
        APP_SETTINGS_API,
        withSignal({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(response, data, "Failed to save settings")
        );
      }
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

  function isValidMapboxToken(token) {
    return Boolean(token?.startsWith("pk.") && token.length >= 20);
  }

  function renderMapPreview(token) {
    if (typeof mapboxgl === "undefined") {
      return;
    }
    const container = document.getElementById("mapbox-preview");
    if (!container) {
      return;
    }
    const placeholder = container.querySelector(".mapbox-preview-placeholder");
    if (placeholder) {
      placeholder.style.display = "none";
    }
    destroyMapPreview();
    mapboxgl.accessToken = token;
    mapPreview = new mapboxgl.Map({
      container,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-96, 37.8],
      zoom: 3,
      interactive: false,
      attributionControl: false,
    });
    mapPreview.on("error", () => {
      showStatus(
        "setup-mapbox-status",
        "Map preview failed to load. Double-check the token.",
        true
      );
    });
  }

  function destroyMapPreview() {
    const container = document.getElementById("mapbox-preview");
    const placeholder = container?.querySelector(".mapbox-preview-placeholder");
    if (mapPreview) {
      try {
        mapPreview.remove();
      } catch {
        // Ignore cleanup errors.
      }
      mapPreview = null;
    }
    if (placeholder) {
      placeholder.style.display = "grid";
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
      const response = await fetch(url, withSignal());
      const data = await response.json();

      if (!data.regions || data.regions.length === 0) {
        regionList.innerHTML = '<div class="text-muted">No regions found.</div>';
        return;
      }

      const sorted = data.regions.sort((a, b) => {
        if (a.has_children && !b.has_children) {
          return -1;
        }
        if (!a.has_children && b.has_children) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

      regionList.innerHTML = sorted
        .map(
          (region) => `
            <div class="region-item"
              data-region-id="${escapeHtml(region.id)}"
              data-region-name="${escapeHtml(region.name)}"
              data-region-size="${region.pbf_size_mb || ""}"
              data-has-children="${region.has_children}">
              <div class="d-flex align-items-center gap-2">
                ${region.has_children ? '<i class="fas fa-folder"></i>' : '<i class="fas fa-map"></i>'}
                <span>${escapeHtml(region.name)}</span>
              </div>
              <div class="text-muted small">
                ${region.pbf_size_mb ? `${region.pbf_size_mb.toFixed(1)} MB` : ""}
                ${region.has_children ? '<i class="fas fa-chevron-right ms-2"></i>' : ""}
              </div>
            </div>
          `
        )
        .join("");
      updateBreadcrumb();
    } catch (_error) {
      regionList.innerHTML = '<div class="text-danger">Failed to load regions.</div>';
    }
  }

  function handleBreadcrumbClick(event) {
    if (regionControlsLocked) {
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

    if (selectedRegion) {
      info?.classList.remove("d-none");
      downloadBtn.disabled = regionControlsLocked;
      nameEl.textContent = selectedRegion.name;
      idEl.textContent = selectedRegion.id;
      sizeEl.textContent = selectedRegion.size
        ? `${parseFloat(selectedRegion.size).toFixed(1)} MB`
        : "Unknown";
    } else {
      info?.classList.add("d-none");
      downloadBtn.disabled = true;
    }
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
  }

  async function downloadSelectedRegion() {
    if (!selectedRegion) {
      return;
    }
    await runRegionStep("download", selectedRegion);
  }

  async function autoDetectRegion() {
    await runRegionStep("auto", null);
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
          : "Starting download and build...",
        false
      );
      const response = await fetch(
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

    if (jobStatus && progressWrap && progressBar && progressText) {
      const progress = Number(jobStatus.progress || 0);
      progressWrap.classList.remove("d-none");
      progressBar.style.width = `${progress}%`;
      progressBar.textContent = `${Math.round(progress)}%`;
      progressText.textContent = jobStatus.message || jobStatus.stage || "Working...";
    } else {
      progressWrap?.classList.add("d-none");
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
    const containersRunning = Boolean(nominatim.container_running && valhalla.container_running);
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
    if (window.confirmationDialog?.show) {
      window.confirmationDialog
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
      return;
    }
    if (window.confirm("Skip map data setup? Map services will stay offline.")) {
      handleStepNavigation("complete", { region_skipped: true });
    }
  }

  function confirmRegionSkip() {
    const modalEl = document.getElementById("regionSkipModal");
    if (modalEl && window.bootstrap?.Modal) {
      window.bootstrap.Modal.getInstance(modalEl)?.hide();
    }
    handleStepNavigation("complete", { region_skipped: true });
  }

  function showRegionStatus(message, isError) {
    showStatus("region-status", message, isError);
  }

  function updateSummary() {
    document.getElementById("summary-bouncie").textContent = setupState.bouncie
      ? "Configured"
      : "Missing";
    document.getElementById("summary-mapbox").textContent = setupState.mapbox
      ? "Configured"
      : "Missing";
    document.getElementById("summary-region").textContent = setupState.region
      ? "Configured"
      : "Needs data";
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
      const response = await fetch(
        `${SETUP_API}/complete`,
        withSignal({ method: "POST" })
      );
      const data = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(response, data, "Failed to complete setup")
        );
      }
      showStatus("setup-complete-status", "Setup complete! Redirecting...", false);
      await refreshSetupSession();
      window.location.assign("/");
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

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }
})();
