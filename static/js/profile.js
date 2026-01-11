/**
 * Profile Settings Page JavaScript
 * Handles Bouncie API credentials management
 */

(() => {
  let currentDevices = [];

  // Initialize page
  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    loadCredentials();
  });

  /**
   * Initialize all event listeners
   */
  function initializeEventListeners() {
    const form = document.getElementById("bouncieCredentialsForm");
    if (form) {
      form.addEventListener("submit", handleSaveCredentials);
    }

    const loadBtn = document.getElementById("loadCredentialsBtn");
    if (loadBtn) {
      loadBtn.addEventListener("click", loadCredentials);
    }

    const unmaskBtn = document.getElementById("unmaskCredentialsBtn");
    if (unmaskBtn) {
      unmaskBtn.addEventListener("click", unmaskAllCredentials);
    }

    const addDeviceBtn = document.getElementById("addDeviceBtn");
    if (addDeviceBtn) {
      addDeviceBtn.addEventListener("click", () => addDeviceInput());
    }

    const toggleSecretBtn = document.getElementById("toggleClientSecret");
    if (toggleSecretBtn) {
      toggleSecretBtn.addEventListener("click", () =>
        togglePasswordVisibility("clientSecret", "toggleClientSecret")
      );
    }

    const toggleAuthBtn = document.getElementById("toggleAuthCode");
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener("click", () =>
        togglePasswordVisibility("authorizationCode", "toggleAuthCode")
      );
    }

    // Vehicle sync for authorized devices (syncs to credentials)
    const syncVehiclesBtn = document.getElementById("syncVehiclesBtn");
    if (syncVehiclesBtn) {
      syncVehiclesBtn.addEventListener("click", syncVehiclesFromBouncie);
    }
  }

  /**
   * Load credentials from the server
   */
  async function loadCredentials() {
    try {
      showStatus("Loading credentials...", "info");

      const response = await fetch("/api/profile/bouncie-credentials");
      const data = await response.json();

      if (data.status === "success" && data.credentials) {
        populateForm(data.credentials);
        showStatus("Credentials loaded successfully", "success");
      } else {
        showStatus(
          "No credentials found. Please enter your Bouncie credentials.",
          "warning"
        );
      }
    } catch (error) {
      showStatus(`Error loading credentials: ${error.message}`, "error");
    }
  }

  /**
   * Unmask all credentials (loads full unmasked values)
   */
  async function unmaskAllCredentials() {
    try {
      showStatus("Loading unmasked credentials...", "info");

      const response = await fetch("/api/profile/bouncie-credentials/unmask");
      const data = await response.json();

      if (data.status === "success" && data.credentials) {
        populateForm(data.credentials, false);
        showStatus("Credentials unmasked", "success");
      } else {
        showStatus("Failed to unmask credentials", "error");
      }
    } catch (error) {
      showStatus(`Error unmasking credentials: ${error.message}`, "error");
    }
  }

  /**
   * Populate form with credential data
   * @param {Object} credentials - Credential data
   * @param {boolean} masked - Whether credentials are masked
   */
  function populateForm(credentials, masked = true) {
    const clientIdInput = document.getElementById("clientId");
    const clientSecretInput = document.getElementById("clientSecret");
    const redirectUriInput = document.getElementById("redirectUri");
    const authCodeInput = document.getElementById("authorizationCode");
    const fetchConcurrencyInput = document.getElementById("fetchConcurrency");

    if (clientIdInput) {
      clientIdInput.value = credentials.client_id || "";
    }
    if (clientSecretInput) {
      clientSecretInput.value = credentials.client_secret || "";
    }
    if (redirectUriInput) {
      redirectUriInput.value = credentials.redirect_uri || "";
    }
    if (authCodeInput) {
      authCodeInput.value = credentials.authorization_code || "";
    }
    if (fetchConcurrencyInput) {
      fetchConcurrencyInput.value = credentials.fetch_concurrency || "12";
    }

    // Handle devices
    currentDevices = credentials.authorized_devices || [];
    renderDevices();

    // Add CSS class for masked fields
    if (masked) {
      if (clientSecretInput) {
        clientSecretInput.classList.add("credential-masked");
      }
      if (authCodeInput) {
        authCodeInput.classList.add("credential-masked");
      }
    } else {
      if (clientSecretInput) {
        clientSecretInput.classList.remove("credential-masked");
      }
      if (authCodeInput) {
        authCodeInput.classList.remove("credential-masked");
      }
    }
  }

  /**
   * Render device input fields
   */
  function renderDevices() {
    const container = document.getElementById("devicesList");

    if (container) {
      container.innerHTML = "";
      currentDevices.forEach((device, index) => {
        container.appendChild(createDeviceInput(device, index));
      });

      if (currentDevices.length === 0) {
        container.appendChild(createDeviceInput("", 0));
      }
    }
  }

  /**
   * Create a device input element
   * @param {string} value - Device IMEI value
   * @param {number} index - Device index
   */
  function createDeviceInput(value, index) {
    const container = document.createElement("div");
    container.className = "device-list-item";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-control";
    input.placeholder = "Enter device IMEI";
    input.value = value;
    input.dataset.index = index;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-sm btn-outline-danger";
    removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
    removeBtn.onclick = () => removeDevice(index);

    container.appendChild(input);
    container.appendChild(removeBtn);

    return container;
  }

  /**
   * Add a new device input
   */
  function addDeviceInput() {
    currentDevices.push("");
    renderDevices();
  }

  /**
   * Remove a device input
   * @param {number} index - Index to remove
   */
  function removeDevice(index) {
    if (currentDevices.length > 1) {
      currentDevices.splice(index, 1);
      renderDevices();
    } else {
      showStatus("At least one device is required", "warning");
    }
  }

  /**
   * Handle save credentials form submission
   * @param {Event} event - Form submit event
   */
  async function handleSaveCredentials(event) {
    event.preventDefault();

    // Collect form data
    const clientId = document.getElementById("clientId").value.trim();
    const clientSecret = document.getElementById("clientSecret").value.trim();
    const redirectUri = document.getElementById("redirectUri").value.trim();
    const authorizationCode = document.getElementById("authorizationCode").value.trim();
    const fetchConcurrency =
      document.getElementById("fetchConcurrency")?.value.trim() || "12";

    // Collect devices
    const deviceInputs = document.querySelectorAll("#devicesList input");
    const devices = Array.from(deviceInputs)
      .map((input) => input.value.trim())
      .filter((val) => val.length > 0);

    // Validate
    if (!clientId || !clientSecret || !redirectUri || !authorizationCode) {
      showStatus("All credential fields are required", "error");
      return;
    }

    if (devices.length === 0) {
      showStatus("At least one authorized device is required", "error");
      return;
    }

    try {
      showStatus("Saving credentials...", "info");

      const response = await fetch("/api/profile/bouncie-credentials", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          authorization_code: authorizationCode,
          authorized_devices: devices,
          fetch_concurrency: parseInt(fetchConcurrency, 10) || 12,
        }),
      });

      const data = await response.json();

      if (response.ok && data.status === "success") {
        showStatus("Credentials saved successfully!", "success");
        currentDevices = devices;

        // Reload to show masked values
        setTimeout(() => {
          loadCredentials();
        }, 1500);
      } else {
        showStatus(
          `Error saving credentials: ${data.detail || data.message || "Unknown error"}`,
          "error"
        );
      }
    } catch (error) {
      showStatus(`Error saving credentials: ${error.message}`, "error");
    }
  }

  /**
   * Toggle password visibility
   * @param {string} inputId - Input element ID
   * @param {string} buttonId - Button element ID
   */
  function togglePasswordVisibility(inputId, buttonId) {
    const input = document.getElementById(inputId);
    const button = document.getElementById(buttonId);

    if (input && button) {
      const icon = button.querySelector("i");
      if (input.type === "password") {
        input.type = "text";
        if (icon) {
          icon.className = "fas fa-eye-slash";
        }
      } else {
        input.type = "password";
        if (icon) {
          icon.className = "fas fa-eye";
        }
      }
    }
  }

  /**
   * Show status message
   * @param {string} message - Status message
   * @param {string} type - Status type (success, error, warning, info)
   */
  function showStatus(message, type) {
    const statusEl = document.getElementById("credentialsSaveStatus");
    const bannerEl = document.getElementById("credentials-status-banner");
    const bannerTextEl = document.getElementById("credentials-status-text");

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `alert alert-${getBootstrapClass(type)} mt-3`;
      statusEl.style.display = "block";

      setTimeout(() => {
        statusEl.style.display = "none";
      }, 5000);
    }

    if (bannerEl && bannerTextEl) {
      bannerTextEl.textContent = message;
      bannerEl.className = `credentials-status ${type}`;
      bannerEl.style.display = "block";

      if (type === "success") {
        setTimeout(() => {
          bannerEl.style.display = "none";
        }, 5000);
      }
    }
  }

  /**
   * Map status type to Bootstrap class
   * @param {string} type - Status type
   */
  function getBootstrapClass(type) {
    const map = {
      success: "success",
      error: "danger",
      warning: "warning",
      info: "info",
    };
    return map[type] || "info";
  }

  /**
   * Sync vehicles from Bouncie (updates authorized devices in credentials)
   */
  async function syncVehiclesFromBouncie() {
    try {
      showStatus("Syncing vehicles from Bouncie...", "info");

      const response = await fetch("/api/profile/bouncie-credentials/sync-vehicles", {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to sync vehicles");
      }

      showStatus(data.message || "Vehicles synced successfully!", "success");

      // Reload credentials to update authorized devices
      await loadCredentials();
    } catch (error) {
      showStatus(`Error syncing vehicles: ${error.message}`, "error");
    }
  }

  // ========================================
  // App Settings (Mapbox, Clarity)
  // ========================================

  /**
   * Initialize app settings event listeners
   */
  function initializeAppSettingsListeners() {
    const form = document.getElementById("appSettingsForm");
    if (form) {
      form.addEventListener("submit", handleSaveAppSettings);
    }

    const loadBtn = document.getElementById("loadAppSettingsBtn");
    if (loadBtn) {
      loadBtn.addEventListener("click", loadAppSettings);
    }

    const toggleMapboxBtn = document.getElementById("toggleMapboxToken");
    if (toggleMapboxBtn) {
      toggleMapboxBtn.addEventListener("click", () =>
        togglePasswordVisibility("mapboxToken", "toggleMapboxToken")
      );
    }
  }

  /**
   * Load app settings from the server
   */
  async function loadAppSettings() {
    const statusEl = document.getElementById("appSettingsSaveStatus");

    try {
      if (statusEl) {
        statusEl.textContent = "Loading settings...";
        statusEl.className = "alert alert-info mt-3";
        statusEl.style.display = "block";
      }

      const response = await fetch("/api/profile/app-settings");
      const data = await response.json();

      if (data.status === "success" && data.settings) {
        const mapboxInput = document.getElementById("mapboxToken");
        const clarityInput = document.getElementById("clarityProjectId");

        if (mapboxInput) {
          mapboxInput.value = data.settings.mapbox_access_token || "";
        }
        if (clarityInput) {
          clarityInput.value = data.settings.clarity_project_id || "";
        }

        if (statusEl) {
          statusEl.textContent = "Settings loaded";
          statusEl.className = "alert alert-success mt-3";
          setTimeout(() => {
            statusEl.style.display = "none";
          }, 2000);
        }
      } else if (statusEl) {
        statusEl.textContent =
          "No settings configured yet. Please enter your Mapbox token.";
        statusEl.className = "alert alert-warning mt-3";
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `Error loading settings: ${error.message}`;
        statusEl.className = "alert alert-danger mt-3";
        statusEl.style.display = "block";
      }
    }
  }

  /**
   * Handle save app settings form submission
   * @param {Event} event - Form submit event
   */
  async function handleSaveAppSettings(event) {
    event.preventDefault();

    const statusEl = document.getElementById("appSettingsSaveStatus");
    const mapboxInput = document.getElementById("mapboxToken");
    const clarityInput = document.getElementById("clarityProjectId");

    const mapboxToken = mapboxInput?.value.trim() || "";
    const clarityProjectId = clarityInput?.value.trim() || null;

    // Validate Mapbox token format
    if (!mapboxToken) {
      if (statusEl) {
        statusEl.textContent = "Mapbox access token is required for maps to work.";
        statusEl.className = "alert alert-danger mt-3";
        statusEl.style.display = "block";
      }
      return;
    }

    if (!mapboxToken.startsWith("pk.")) {
      if (statusEl) {
        statusEl.textContent =
          "Mapbox token should start with 'pk.' (public token). Secret tokens (sk.) will not work.";
        statusEl.className = "alert alert-warning mt-3";
        statusEl.style.display = "block";
      }
      // Allow saving anyway as user may know what they're doing
    }

    try {
      if (statusEl) {
        statusEl.textContent = "Saving settings...";
        statusEl.className = "alert alert-info mt-3";
        statusEl.style.display = "block";
      }

      const response = await fetch("/api/profile/app-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mapbox_access_token: mapboxToken,
          clarity_project_id: clarityProjectId,
        }),
      });

      const data = await response.json();

      if (response.ok && data.status === "success") {
        // Explicitly ensure the values stay in the inputs (don't clear them)
        if (mapboxInput) {
          mapboxInput.value = mapboxToken;
        }
        if (clarityInput) {
          clarityInput.value = clarityProjectId || "";
        }

        if (statusEl) {
          statusEl.textContent =
            "Settings saved! Refresh the page to apply changes to maps.";
          statusEl.className = "alert alert-success mt-3";
          statusEl.style.display = "block";
        }
      } else if (statusEl) {
        statusEl.textContent = `Error: ${data.detail || data.message || "Unknown error"}`;
        statusEl.className = "alert alert-danger mt-3";
        statusEl.style.display = "block";
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `Error saving settings: ${error.message}`;
        statusEl.className = "alert alert-danger mt-3";
        statusEl.style.display = "block";
      }
    }
  }

  // Initialize app settings listeners and load on page load
  initializeAppSettingsListeners();
  loadAppSettings();
})();
