/**
 * Profile Settings Page JavaScript
 * Handles Bouncie API credentials management
 */

(() => {
  let currentDevices = [];
  let pageSignal = null;

  // Initialize page
  window.utils?.onPageLoad(
    ({ signal, cleanup } = {}) => {
      pageSignal = signal || null;
      initializeEventListeners(signal);
      loadCredentials();
      if (typeof cleanup === "function") {
        cleanup(() => {
          pageSignal = null;
          currentDevices = [];
        });
      }
    },
    { route: "/profile" }
  );

  function withSignal(options = {}) {
    if (pageSignal) {
      return { ...options, signal: pageSignal };
    }
    return options;
  }

  /**
   * Initialize all event listeners
   */
  function initializeEventListeners(signal) {
    const form = document.getElementById("bouncieCredentialsForm");
    if (form) {
      form.addEventListener(
        "submit",
        handleSaveCredentials,
        signal ? { signal } : false
      );
    }

    const loadBtn = document.getElementById("loadCredentialsBtn");
    if (loadBtn) {
      loadBtn.addEventListener("click", loadCredentials, signal ? { signal } : false);
    }

    const unmaskBtn = document.getElementById("unmaskCredentialsBtn");
    if (unmaskBtn) {
      unmaskBtn.addEventListener(
        "click",
        unmaskAllCredentials,
        signal ? { signal } : false
      );
    }

    const addDeviceBtn = document.getElementById("addDeviceBtn");
    if (addDeviceBtn) {
      addDeviceBtn.addEventListener(
        "click",
        () => addDeviceInput(),
        signal ? { signal } : false
      );
    }

    const toggleSecretBtn = document.getElementById("toggleClientSecret");
    if (toggleSecretBtn) {
      toggleSecretBtn.addEventListener(
        "click",
        () => togglePasswordVisibility("clientSecret", "toggleClientSecret"),
        signal ? { signal } : false
      );
    }

    const toggleAuthBtn = document.getElementById("toggleAuthCode");
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener(
        "click",
        () => togglePasswordVisibility("authorizationCode", "toggleAuthCode"),
        signal ? { signal } : false
      );
    }

    // Vehicle sync for authorized devices (syncs to credentials)
    const syncVehiclesBtn = document.getElementById("syncVehiclesBtn");
    if (syncVehiclesBtn) {
      syncVehiclesBtn.addEventListener(
        "click",
        syncVehiclesFromBouncie,
        signal ? { signal } : false
      );
    }
  }

  /**
   * Load credentials from the server
   */
  async function loadCredentials() {
    if (pageSignal?.aborted) {
      return;
    }
    try {
      showStatus("Loading credentials...", "info");

      const response = await fetch("/api/profile/bouncie-credentials", withSignal());
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
      if (error.name === "AbortError") {
        return;
      }
      showStatus(`Error loading credentials: ${error.message}`, "error");
    }
  }

  /**
   * Unmask all credentials (loads full unmasked values)
   */
  async function unmaskAllCredentials() {
    if (pageSignal?.aborted) {
      return;
    }
    try {
      showStatus("Loading unmasked credentials...", "info");

      const response = await fetch(
        "/api/profile/bouncie-credentials/unmask",
        withSignal()
      );
      const data = await response.json();

      if (data.status === "success" && data.credentials) {
        populateForm(data.credentials, false);
        showStatus("Credentials unmasked", "success");
      } else {
        showStatus("Failed to unmask credentials", "error");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
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
    if (pageSignal?.aborted) {
      return;
    }

    // Collect form data
    const clientId = document.getElementById("clientId").value.trim();
    const clientSecret = document.getElementById("clientSecret").value.trim();
    const redirectUri = document.getElementById("redirectUri").value.trim();
    const authorizationCode = document.getElementById("authorizationCode").value.trim();
    const fetchConcurrency
      = document.getElementById("fetchConcurrency")?.value.trim() || "12";

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

      const response = await fetch(
        "/api/profile/bouncie-credentials",
        withSignal({
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
        })
      );

      const data = await response.json();

      if (response.ok && data.status === "success") {
        showStatus("Credentials saved successfully!", "success");
        currentDevices = devices;

        // Reload to show masked values
        setTimeout(() => {
          if (!pageSignal?.aborted) {
            loadCredentials();
          }
        }, 1500);
      } else {
        showStatus(
          `Error saving credentials: ${data.detail || data.message || "Unknown error"}`,
          "error"
        );
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
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
    if (pageSignal?.aborted) {
      return;
    }
    try {
      showStatus("Syncing vehicles from Bouncie...", "info");

      const response = await fetch(
        "/api/profile/bouncie-credentials/sync-vehicles",
        withSignal({
          method: "POST",
        })
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to sync vehicles");
      }

      showStatus(data.message || "Vehicles synced successfully!", "success");

      // Reload credentials to update authorized devices
      await loadCredentials();
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      showStatus(`Error syncing vehicles: ${error.message}`, "error");
    }
  }

})();
