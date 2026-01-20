/* global mapboxgl */
(() => {
  const SETUP_API = "/api/setup";
  const PROFILE_API = "/api/profile";
  const APP_SETTINGS_API = "/api/app_settings";
  const MAP_DATA_API = "/api/map-data";

  const stepKeys = ["welcome", "bouncie", "mapbox", "region", "complete"];
  let currentStep = 0;
  let setupState = {
    bouncie: false,
    mapbox: false,
    region: false,
  };
  let currentDevices = [];
  let selectedRegion = null;
  let currentRegionPath = [];
  let regionPollInterval = null;
  let mapPreview = null;
  let pageSignal = null;
  let regionControlsLocked = false;

  window.utils?.onPageLoad(
    ({ signal, cleanup } = {}) => {
      pageSignal = signal || null;
      initializeSetup();
      if (typeof cleanup === "function") {
        cleanup(() => {
          pageSignal = null;
          stopRegionPolling();
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

  async function initializeSetup() {
    bindEventListeners();
    await loadSetupStatus();
    await loadBouncieCredentials();
    await loadServiceConfig();
    await loadGeofabrikRegions();
    showStep(0);
  }

  function bindEventListeners() {
    document
      .getElementById("setup-start-btn")
      ?.addEventListener("click", () => showStep(1));

    document
      .getElementById("bouncie-back-btn")
      ?.addEventListener("click", () => showStep(0));
    document
      .getElementById("bouncie-save-btn")
      ?.addEventListener("click", () => saveBouncieCredentials(true));

    document
      .getElementById("mapbox-back-btn")
      ?.addEventListener("click", () => showStep(1));
    document
      .getElementById("mapbox-save-btn")
      ?.addEventListener("click", () => saveMapboxSettings(true));
    document
      .getElementById("mapboxToken")
      ?.addEventListener("input", handleMapboxInput);

    document
      .getElementById("region-back-btn")
      ?.addEventListener("click", () => showStep(2));
    document
      .getElementById("region-continue-btn")
      ?.addEventListener("click", () => showStep(4));
    document
      .getElementById("region-skip-btn")
      ?.addEventListener("click", handleRegionSkip);

    document
      .getElementById("complete-back-btn")
      ?.addEventListener("click", () => showStep(3));
    document
      .getElementById("complete-setup-btn")
      ?.addEventListener("click", completeSetup);

    document
      .getElementById("addDeviceBtn")
      ?.addEventListener("click", addDeviceInput);
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
  }

  function showStep(index) {
    const steps = document.querySelectorAll(".setup-step");
    steps.forEach((step) => {
      const stepIndex = Number(step.dataset.step);
      step.classList.toggle("is-active", stepIndex === index);
    });
    currentStep = index;
    if (stepKeys[index] === "region" && setupState.region) {
      showRegionStatus("A region is already configured. Add another if needed.", false);
    }
    if (stepKeys[index] === "complete") {
      updateSummary();
    }
    updateStepIndicators();
  }

  function updateStepIndicators() {
    document.querySelectorAll(".setup-step-item").forEach((item) => {
      const stepIndex = Number(item.dataset.step);
      item.classList.toggle("is-active", stepIndex === currentStep);
      const key = item.dataset.stepKey;
      if (key && setupState[key]) {
        item.classList.add("is-complete");
      } else {
        item.classList.remove("is-complete");
      }
    });
  }

  async function loadSetupStatus() {
    try {
      const response = await fetch(`${SETUP_API}/status`, withSignal());
      const data = await response.json();
      if (data.setup_completed) {
        window.location.assign("/");
        return;
      }
      setupState.bouncie = Boolean(data.steps?.bouncie?.complete);
      setupState.mapbox = Boolean(data.steps?.mapbox?.complete);
      setupState.region = Boolean(data.steps?.region?.complete);
      updateStepIndicators();
    } catch (error) {
      console.warn("Failed to load setup status", error);
    }
  }

  async function loadBouncieCredentials() {
    try {
      const response = await fetch(
        `${PROFILE_API}/bouncie-credentials/unmask`,
        withSignal()
      );
      const data = await response.json();
      const creds = data.credentials || {};
      document.getElementById("clientId").value = creds.client_id || "";
      document.getElementById("clientSecret").value = creds.client_secret || "";
      document.getElementById("redirectUri").value = creds.redirect_uri || "";
      document.getElementById("authorizationCode").value
        = creds.authorization_code || "";
      document.getElementById("fetchConcurrency").value
        = creds.fetch_concurrency || 12;
      currentDevices = Array.isArray(creds.authorized_devices)
        ? creds.authorized_devices
        : [];
      renderDevices();
    } catch (error) {
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
      input.addEventListener("input", (event) => {
        currentDevices[index] = event.target.value;
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-outline-danger";
      removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
      removeBtn.addEventListener("click", () => removeDeviceInput(index));

      wrapper.appendChild(input);
      wrapper.appendChild(removeBtn);
      container.appendChild(wrapper);
    });
  }

  function addDeviceInput() {
    currentDevices.push("");
    renderDevices();
  }

  function removeDeviceInput(index) {
    if (currentDevices.length <= 1) {
      showStatus("setup-bouncie-status", "At least one device is required.", true);
      return;
    }
    currentDevices.splice(index, 1);
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
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to save credentials");
      }
      setupState.bouncie = true;
      updateStepIndicators();
      showStatus("setup-bouncie-status", data.message || "Credentials saved.", false);
      if (advance) {
        showStep(2);
      }
    } catch (error) {
      showStatus("setup-bouncie-status", error.message, true);
    }
  }

  async function syncVehiclesFromBouncie() {
    try {
      showStatus("setup-bouncie-status", "Syncing vehicles...", false);
      const response = await fetch(
        `${PROFILE_API}/bouncie-credentials/sync-vehicles`,
        withSignal({ method: "POST" })
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to sync vehicles");
      }
      currentDevices = Array.isArray(data.authorized_devices)
        ? data.authorized_devices
        : currentDevices;
      renderDevices();
      showStatus(
        "setup-bouncie-status",
        data.message || "Vehicles synced.",
        false
      );
    } catch (error) {
      showStatus("setup-bouncie-status", error.message, true);
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
      const data = await response.json();
      document.getElementById("mapboxToken").value = data.mapbox_token || "";
      document.getElementById("nominatimBaseUrl").value = data.nominatim_base_url || "";
      document.getElementById("nominatimUserAgent").value = data.nominatim_user_agent || "";
      document.getElementById("valhallaBaseUrl").value = data.valhalla_base_url || "";
      document.getElementById("geofabrikMirror").value = data.geofabrik_mirror || "";
      handleMapboxInput();
    } catch (error) {
      showStatus("setup-mapbox-status", "Unable to load Mapbox settings.", true);
    }
  }

  function handleMapboxInput() {
    const token = document.getElementById("mapboxToken").value.trim();
    if (!token) {
      destroyMapPreview();
      showStatus(
        "setup-mapbox-status",
        "Enter a Mapbox token to preview maps.",
        false
      );
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
    const token = document.getElementById("mapboxToken").value.trim();
    if (!isValidMapboxToken(token)) {
      showStatus("setup-mapbox-status", "Enter a valid Mapbox token.", true);
      return;
    }

    const payload = {
      mapbox_token: token,
      nominatim_base_url: document.getElementById("nominatimBaseUrl").value.trim(),
      nominatim_user_agent: document.getElementById("nominatimUserAgent").value.trim(),
      valhalla_base_url: document.getElementById("valhallaBaseUrl").value.trim(),
      geofabrik_mirror: document.getElementById("geofabrikMirror").value.trim(),
    };

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
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to save settings");
      }
      setupState.mapbox = true;
      updateStepIndicators();
      showStatus("setup-mapbox-status", "Mapbox settings saved.", false);
      if (advance) {
        showStep(3);
      }
    } catch (error) {
      showStatus("setup-mapbox-status", error.message, true);
    }
  }

  function isValidMapboxToken(token) {
    return Boolean(token && token.startsWith("pk.") && token.length >= 20);
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
    regionList.innerHTML = "<div class=\"text-muted\">Loading regions...</div>";

    try {
      const url = parent
        ? `${MAP_DATA_API}/geofabrik/regions?parent=${encodeURIComponent(parent)}`
        : `${MAP_DATA_API}/geofabrik/regions`;
      const response = await fetch(url, withSignal());
      const data = await response.json();

      if (!data.regions || data.regions.length === 0) {
        regionList.innerHTML = "<div class=\"text-muted\">No regions found.</div>";
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
    } catch (error) {
      regionList.innerHTML = "<div class=\"text-danger\">Failed to load regions.</div>";
    }
  }

  function handleBreadcrumbClick(event) {
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
    regionControlsLocked = locked;
    const regionList = document.getElementById("region-list");
    const breadcrumb = document.getElementById("region-breadcrumb");
    const regionActions = document.querySelector(".setup-region-actions");
    const controlIds = [
      "auto-region-btn",
      "region-back-btn",
      "region-skip-btn",
      "region-continue-btn",
    ];

    regionList?.classList.toggle("is-disabled", locked);
    breadcrumb?.classList.toggle("is-disabled", locked);
    regionActions?.classList.toggle("is-disabled", locked);
    controlIds.forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.disabled = locked;
      }
    });
    updateSelectedRegionUI();
  }

  async function downloadSelectedRegion() {
    if (!selectedRegion) {
      return;
    }
    setRegionControlsLocked(true);
    try {
      showRegionStatus("Starting download and build...", false);
      const response = await fetch(
        `${MAP_DATA_API}/regions/download-and-build`,
        withSignal({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            geofabrik_id: selectedRegion.id,
            display_name: selectedRegion.name,
          }),
        })
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to start download");
      }
      startRegionJob(data.job_id, selectedRegion.name);
    } catch (error) {
      setRegionControlsLocked(false);
      showRegionStatus(error.message, true);
    }
  }

  async function autoDetectRegion() {
    setRegionControlsLocked(true);
    try {
      showRegionStatus("Searching for a suggested region...", false);
      const response = await fetch(
        `${SETUP_API}/auto-configure-region`,
        withSignal({ method: "POST" })
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || data.detail || "No region suggestion found");
      }
      selectedRegion = data.region || selectedRegion;
      updateSelectedRegionUI();
      startRegionJob(data.job_id, data.region?.name || "Suggested region");
    } catch (error) {
      setRegionControlsLocked(false);
      showRegionStatus(error.message, true);
    }
  }

  function startRegionJob(jobId, name) {
    if (!jobId) {
      return;
    }
    setRegionControlsLocked(true);
    const progressWrap = document.getElementById("region-progress");
    const progressBar = document.getElementById("region-progress-bar");
    const progressText = document.getElementById("region-progress-text");
    progressWrap?.classList.remove("d-none");
    progressBar.style.width = "0%";
    progressBar.textContent = "0%";
    progressText.textContent = name ? `Downloading ${name}` : "Downloading region";
    stopRegionPolling();

    regionPollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${MAP_DATA_API}/jobs/${jobId}`, withSignal());
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || "Failed to read job status");
        }
        const progress = Number(data.progress || 0);
        progressBar.style.width = `${progress}%`;
        progressBar.textContent = `${Math.round(progress)}%`;
        progressText.textContent = data.message || data.stage || "Working...";

        if (["completed", "failed", "cancelled"].includes(data.status)) {
          stopRegionPolling();
          setRegionControlsLocked(false);
          if (data.status === "completed") {
            setupState.region = true;
            showRegionStatus("Region download complete.", false);
            updateStepIndicators();
          } else {
            showRegionStatus(data.error || "Region setup failed.", true);
          }
        }
      } catch (error) {
        stopRegionPolling();
        setRegionControlsLocked(false);
        showRegionStatus(error.message, true);
      }
    }, 2000);
  }

  function stopRegionPolling() {
    if (regionPollInterval) {
      clearInterval(regionPollInterval);
      regionPollInterval = null;
    }
  }

  function handleRegionSkip() {
    setupState.region = false;
    updateStepIndicators();
    showStep(4);
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
      ? "Downloaded"
      : "Skipped";
  }

  async function completeSetup() {
    if (!setupState.bouncie || !setupState.mapbox) {
      showStatus(
        "setup-complete-status",
        "Complete the required steps before finishing setup.",
        true
      );
      return;
    }
    try {
      showStatus("setup-complete-status", "Finalizing setup...", false);
      const response = await fetch(
        `${SETUP_API}/complete`,
        withSignal({ method: "POST" })
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to complete setup");
      }
      showStatus("setup-complete-status", "Setup complete! Redirecting...", false);
      window.location.assign("/");
    } catch (error) {
      showStatus("setup-complete-status", error.message, true);
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
