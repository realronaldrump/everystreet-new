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
    initializeMobileToggles();
  });

  /**
   * Initialize all event listeners
   */
  function initializeEventListeners() {
    // Desktop event listeners
    const desktopForm = document.getElementById("bouncieCredentialsForm");
    if (desktopForm) {
      desktopForm.addEventListener("submit", handleSaveCredentials);
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
        togglePasswordVisibility("clientSecret", "toggleClientSecret"),
      );
    }

    const toggleAuthBtn = document.getElementById("toggleAuthCode");
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener("click", () =>
        togglePasswordVisibility("authorizationCode", "toggleAuthCode"),
      );
    }

    // Mobile event listeners
    const mobileForm = document.getElementById("mobile-bouncieCredentialsForm");
    if (mobileForm) {
      mobileForm.addEventListener("submit", handleSaveCredentials);
    }

    // Vehicle Management Listeners
    const syncVehiclesBtn = document.getElementById("syncVehiclesBtn");
    if (syncVehiclesBtn) {
      syncVehiclesBtn.addEventListener("click", syncVehiclesFromBouncie);
    }

    const mobileSyncVehiclesBtn = document.getElementById(
      "mobile-syncVehiclesBtn",
    );
    if (mobileSyncVehiclesBtn) {
      mobileSyncVehiclesBtn.addEventListener("click", syncVehiclesFromBouncie);
    }

    const mobileAddVehicleBtn = document.getElementById("mobile-addVehicleBtn");
    if (mobileAddVehicleBtn) {
      mobileAddVehicleBtn.addEventListener("click", addNewVehicle);
    }

    const mobileLoadBtn = document.getElementById("mobile-loadCredentialsBtn");
    if (mobileLoadBtn) {
      mobileLoadBtn.addEventListener("click", loadCredentials);
    }

    const mobileAddDeviceBtn = document.getElementById("mobile-addDeviceBtn");
    if (mobileAddDeviceBtn) {
      mobileAddDeviceBtn.addEventListener("click", () =>
        addDeviceInput("mobile"),
      );
    }

    const mobileToggleSecretBtn = document.getElementById(
      "mobile-toggleClientSecret",
    );
    if (mobileToggleSecretBtn) {
      mobileToggleSecretBtn.addEventListener("click", () =>
        togglePasswordVisibility(
          "mobile-clientSecret",
          "mobile-toggleClientSecret",
        ),
      );
    }

    const mobileToggleAuthBtn = document.getElementById(
      "mobile-toggleAuthCode",
    );
    if (mobileToggleAuthBtn) {
      mobileToggleAuthBtn.addEventListener("click", () =>
        togglePasswordVisibility(
          "mobile-authorizationCode",
          "mobile-toggleAuthCode",
        ),
      );
    }
  }

  /**
   * Initialize mobile section toggles
   */
  function initializeMobileToggles() {
    const headers = document.querySelectorAll(
      ".mobile-settings-section-header",
    );
    headers.forEach((header) => {
      header.addEventListener("click", function () {
        const content = this.nextElementSibling;
        const chevron = this.querySelector(".mobile-settings-section-chevron");

        if (content?.classList.contains("mobile-settings-section-content")) {
          this.classList.toggle("expanded");
          content.classList.toggle("expanded");
          if (chevron) {
            chevron.style.transform = this.classList.contains("expanded")
              ? "rotate(180deg)"
              : "rotate(0deg)";
          }
        }
      });
    });
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
          "warning",
        );
      }
    } catch (error) {
      console.error("Error loading credentials:", error);
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
      console.error("Error unmasking credentials:", error);
      showStatus(`Error unmasking credentials: ${error.message}`, "error");
    }
  }

  /**
   * Populate form with credential data
   * @param {Object} credentials - Credential data
   * @param {boolean} masked - Whether credentials are masked
   */
  function populateForm(credentials, masked = true) {
    // Desktop form
    const clientIdInput = document.getElementById("clientId");
    const clientSecretInput = document.getElementById("clientSecret");
    const redirectUriInput = document.getElementById("redirectUri");
    const authCodeInput = document.getElementById("authorizationCode");
    const fetchConcurrencyInput = document.getElementById("fetchConcurrency");

    if (clientIdInput) clientIdInput.value = credentials.client_id || "";
    if (clientSecretInput)
      clientSecretInput.value = credentials.client_secret || "";
    if (redirectUriInput)
      redirectUriInput.value = credentials.redirect_uri || "";
    if (authCodeInput)
      authCodeInput.value = credentials.authorization_code || "";
    if (fetchConcurrencyInput)
      fetchConcurrencyInput.value = credentials.fetch_concurrency || "12";

    // Mobile form
    const mobileClientIdInput = document.getElementById("mobile-clientId");
    const mobileClientSecretInput = document.getElementById(
      "mobile-clientSecret",
    );
    const mobileRedirectUriInput =
      document.getElementById("mobile-redirectUri");
    const mobileAuthCodeInput = document.getElementById(
      "mobile-authorizationCode",
    );
    const mobileFetchConcurrencyInput = document.getElementById(
      "mobile-fetchConcurrency",
    );

    if (mobileClientIdInput)
      mobileClientIdInput.value = credentials.client_id || "";
    if (mobileClientSecretInput)
      mobileClientSecretInput.value = credentials.client_secret || "";
    if (mobileRedirectUriInput)
      mobileRedirectUriInput.value = credentials.redirect_uri || "";
    if (mobileAuthCodeInput)
      mobileAuthCodeInput.value = credentials.authorization_code || "";
    if (mobileFetchConcurrencyInput)
      mobileFetchConcurrencyInput.value = credentials.fetch_concurrency || "12";

    // Handle devices
    currentDevices = credentials.authorized_devices || [];
    renderDevices();

    // Add CSS class for masked fields
    if (masked) {
      if (clientSecretInput)
        clientSecretInput.classList.add("credential-masked");
      if (authCodeInput) authCodeInput.classList.add("credential-masked");
      if (mobileClientSecretInput)
        mobileClientSecretInput.classList.add("credential-masked");
      if (mobileAuthCodeInput)
        mobileAuthCodeInput.classList.add("credential-masked");
    } else {
      if (clientSecretInput)
        clientSecretInput.classList.remove("credential-masked");
      if (authCodeInput) authCodeInput.classList.remove("credential-masked");
      if (mobileClientSecretInput)
        mobileClientSecretInput.classList.remove("credential-masked");
      if (mobileAuthCodeInput)
        mobileAuthCodeInput.classList.remove("credential-masked");
    }
  }

  /**
   * Render device input fields
   */
  function renderDevices() {
    const desktopContainer = document.getElementById("devicesList");
    const mobileContainer = document.getElementById("mobile-devicesList");

    if (desktopContainer) {
      desktopContainer.innerHTML = "";
      currentDevices.forEach((device, index) => {
        desktopContainer.appendChild(createDeviceInput(device, index));
      });

      if (currentDevices.length === 0) {
        desktopContainer.appendChild(createDeviceInput("", 0));
      }
    }

    if (mobileContainer) {
      mobileContainer.innerHTML = "";
      currentDevices.forEach((device, index) => {
        mobileContainer.appendChild(createDeviceInput(device, index, "mobile"));
      });

      if (currentDevices.length === 0) {
        mobileContainer.appendChild(createDeviceInput("", 0, "mobile"));
      }
    }
  }

  /**
   * Create a device input element
   * @param {string} value - Device IMEI value
   * @param {number} index - Device index
   * @param {string} prefix - Prefix for mobile/desktop
   */
  function createDeviceInput(value, index, prefix = "") {
    const container = document.createElement("div");
    container.className = "device-list-item";

    const input = document.createElement("input");
    input.type = "text";
    input.className = prefix ? "mobile-form-input" : "form-control";
    input.placeholder = "Enter device IMEI";
    input.value = value;
    input.dataset.index = index;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-sm btn-outline-danger";
    removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
    removeBtn.onclick = () => removeDevice(index, prefix);

    container.appendChild(input);
    container.appendChild(removeBtn);

    return container;
  }

  /**
   * Add a new device input
   * @param {string} prefix - Prefix for mobile/desktop
   */
  function addDeviceInput() {
    currentDevices.push("");
    renderDevices();
  }

  /**
   * Remove a device input
   * @param {number} index - Index to remove
   * @param {string} prefix - Prefix for mobile/desktop
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

    const isMobile = event.target.id.includes("mobile");
    const prefix = isMobile ? "mobile-" : "";

    // Collect form data
    const clientId = document.getElementById(`${prefix}clientId`).value.trim();
    const clientSecret = document
      .getElementById(`${prefix}clientSecret`)
      .value.trim();
    const redirectUri = document
      .getElementById(`${prefix}redirectUri`)
      .value.trim();
    const authorizationCode = document
      .getElementById(`${prefix}authorizationCode`)
      .value.trim();
    const fetchConcurrency =
      document.getElementById(`${prefix}fetchConcurrency`)?.value.trim() ||
      "12";

    // Collect devices
    const deviceInputs = document.querySelectorAll(
      `#${isMobile ? "mobile-" : ""}devicesList input`,
    );
    const devices = Array.from(deviceInputs)
      .map((input) => input.value.trim())
      .filter((val) => val.length > 0);

    // Validate
    if (!clientId || !clientSecret || !redirectUri || !authorizationCode) {
      showStatus("All credential fields are required", "error", isMobile);
      return;
    }

    if (devices.length === 0) {
      showStatus(
        "At least one authorized device is required",
        "error",
        isMobile,
      );
      return;
    }

    try {
      showStatus("Saving credentials...", "info", isMobile);

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
        showStatus("Credentials saved successfully!", "success", isMobile);
        currentDevices = devices;

        // Reload to show masked values
        setTimeout(() => {
          loadCredentials();
        }, 1500);
      } else {
        showStatus(
          `Error saving credentials: ${data.detail || data.message || "Unknown error"}`,
          "error",
          isMobile,
        );
      }
    } catch (error) {
      console.error("Error saving credentials:", error);
      showStatus(
        `Error saving credentials: ${error.message}`,
        "error",
        isMobile,
      );
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
        if (icon) icon.className = "fas fa-eye-slash";
      } else {
        input.type = "password";
        if (icon) icon.className = "fas fa-eye";
      }
    }
  }

  /**
   * Show status message
   * @param {string} message - Status message
   * @param {string} type - Status type (success, error, warning, info)
   * @param {boolean} isMobile - Whether to show on mobile view
   */
  function showStatus(message, type, isMobile = false) {
    const statusId = isMobile
      ? "mobile-credentialsSaveStatus"
      : "credentialsSaveStatus";
    const bannerId = isMobile
      ? "mobile-credentials-status-banner"
      : "credentials-status-banner";
    const bannerTextId = isMobile
      ? "mobile-credentials-status-text"
      : "credentials-status-text";

    const statusEl = document.getElementById(statusId);
    const bannerEl = document.getElementById(bannerId);
    const bannerTextEl = document.getElementById(bannerTextId);

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

  // ========================================
  // Vehicle Management
  // ========================================

  /**
   * Load and display vehicles
   */
  async function loadVehicles() {
    const vehiclesList = document.getElementById("vehiclesList");
    const mobileVehiclesList = document.getElementById("mobile-vehiclesList");

    try {
      const response = await fetch("/api/vehicles?active_only=false");
      if (!response.ok) throw new Error("Failed to load vehicles");

      const vehicles = await response.json();
      const noVehiclesHtml =
        '<p class="text-center text-muted py-3">No vehicles found. Click "Sync from Bouncie" to auto-discover vehicles.</p>';

      // Update Desktop List
      if (vehiclesList) {
        if (vehicles.length === 0) {
          vehiclesList.innerHTML = noVehiclesHtml;
        } else {
          vehiclesList.innerHTML = vehicles
            .map((vehicle) => createVehicleItem(vehicle, false))
            .join("");
        }
      }

      // Update Mobile List
      if (mobileVehiclesList) {
        if (vehicles.length === 0) {
          mobileVehiclesList.innerHTML = noVehiclesHtml;
        } else {
          mobileVehiclesList.innerHTML = vehicles
            .map((vehicle) => createVehicleItem(vehicle, true))
            .join("");
        }
      }

      // Add event listeners if we have vehicles
      if (vehicles.length > 0) {
        vehicles.forEach((vehicle) => {
          // Add listeners for Desktop
          addVehicleListeners(vehicle.imei, false);
          // Add listeners for Mobile
          addVehicleListeners(vehicle.imei, true);
        });
      }
    } catch (error) {
      console.error("Error loading vehicles:", error);
      const errorHtml =
        '<p class="text-center text-danger py-3">Error loading vehicles</p>';

      if (vehiclesList) {
        vehiclesList.innerHTML = errorHtml;
      }
      if (mobileVehiclesList) {
        mobileVehiclesList.innerHTML = errorHtml;
      }
    }
  }

  /**
   * Add listeners for a vehicle item
   */
  function addVehicleListeners(imei, isMobile = false) {
    const prefix = isMobile ? "mobile-" : "";
    const saveBtn = document.getElementById(`${prefix}save-vehicle-${imei}`);
    const deleteBtn = document.getElementById(
      `${prefix}delete-vehicle-${imei}`,
    );

    if (saveBtn) {
      saveBtn.addEventListener("click", () => saveVehicle(imei, isMobile));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deleteVehicle(imei));
    }
  }

  /**
   * Create HTML for a vehicle item
   */
  function createVehicleItem(vehicle, isMobile = false) {
    const prefix = isMobile ? "mobile-" : "";

    const statusBadge = vehicle.is_active
      ? '<span class="badge bg-success">Active</span>'
      : '<span class="badge bg-secondary">Inactive</span>';

    // Different layout for mobile? Or just stacked.
    // We need unique IDs for mobile elements.

    return `
      <div class="vehicle-item-container" id="${prefix}vehicle-${vehicle.imei}">
        <div class="row g-3">
          <div class="col-md-3">
            <label class="form-label small text-muted">IMEI</label>
            <input type="text" class="form-control form-control-sm" value="${vehicle.imei}" readonly style="background: rgba(0,0,0,0.2);" />
          </div>
          <div class="col-md-3">
            <label class="form-label small text-muted">VIN</label>
            <input type="text" class="form-control form-control-sm" value="${vehicle.vin || "N/A"}" readonly style="background: rgba(0,0,0,0.2);" />
          </div>
          <div class="col-md-4">
            <label class="form-label small text-muted">Custom Name</label>
            <input type="text" class="form-control form-control-sm" id="${prefix}name-${vehicle.imei}"
                   value="${vehicle.custom_name || ""}" placeholder="Enter friendly name..." />
          </div>
          <div class="col-md-2">
            <label class="form-label small text-muted">Status</label>
            <div>${statusBadge}</div>
            <div class="form-check form-switch mt-1">
              <input class="form-check-input" type="checkbox" id="${prefix}active-${vehicle.imei}"
                     ${vehicle.is_active ? "checked" : ""} />
              <label class="form-check-label small" for="${prefix}active-${vehicle.imei}">Active</label>
            </div>
          </div>
          <div class="col-12">
            <button type="button" class="btn btn-sm btn-primary" id="${prefix}save-vehicle-${vehicle.imei}">
              <i class="fas fa-save"></i> Save Changes
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger" id="${prefix}delete-vehicle-${vehicle.imei}">
              <i class="fas fa-trash"></i> Deactivate
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Save vehicle changes
   */
  async function saveVehicle(imei, isMobile = false) {
    const prefix = isMobile ? "mobile-" : "";
    const nameInput = document.getElementById(`${prefix}name-${imei}`);
    const activeInput = document.getElementById(`${prefix}active-${imei}`);

    try {
      const vehicleData = {
        imei,
        custom_name: nameInput.value || null,
        is_active: activeInput.checked,
      };

      const response = await fetch(`/api/vehicles/${imei}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(vehicleData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to save vehicle");
      }

      showStatus("Vehicle updated successfully!", "success");
      await loadVehicles();
    } catch (error) {
      console.error("Error saving vehicle:", error);
      showStatus(error.message || "Failed to save vehicle", "error");
    }
  }

  /**
   * Delete vehicle
   */
  async function deleteVehicle(imei) {
    if (
      !confirm(
        "Are you sure you want to delete this vehicle? This will mark it as inactive.",
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/vehicles/${imei}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to delete vehicle");
      }

      showStatus("Vehicle deleted successfully!", "success");
      await loadVehicles();
    } catch (error) {
      console.error("Error deleting vehicle:", error);
      showStatus(error.message || "Failed to delete vehicle", "error");
    }
  }

  /**
   * Add new vehicle
   */
  async function addNewVehicle() {
    const imei = prompt("Enter vehicle IMEI:");
    if (!imei) return;

    try {
      const vehicleData = {
        imei: imei.trim(),
        custom_name: null,
        vin: null,
        is_active: true,
      };

      const response = await fetch("/api/vehicles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(vehicleData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to add vehicle");
      }

      showStatus("Vehicle added successfully!", "success");
      await loadVehicles();
    } catch (error) {
      console.error("Error adding vehicle:", error);
      showStatus(error.message || "Failed to add vehicle", "error");
    }
  }

  /**
   * Sync vehicles from Bouncie
   */
  async function syncVehiclesFromBouncie() {
    try {
      showStatus("Syncing vehicles from Bouncie...", "info");

      const response = await fetch(
        "/api/profile/bouncie-credentials/sync-vehicles",
        {
          method: "POST",
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to sync vehicles");
      }

      showStatus(data.message || "Vehicles synced successfully!", "success");

      // Reload vehicles and credentials (to update authorized devices)
      await Promise.all([loadVehicles(), loadCredentials()]);
    } catch (error) {
      console.error("Error syncing vehicles:", error);
      showStatus(`Error syncing vehicles: ${error.message}`, "error");
    }
  }

  // Initialize vehicle management
  const addVehicleBtn = document.getElementById("addVehicleBtn");
  if (addVehicleBtn) {
    addVehicleBtn.addEventListener("click", addNewVehicle);

    // Load vehicles on page load
    loadVehicles();
  }
})();
