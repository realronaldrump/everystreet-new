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
        togglePasswordVisibility("clientSecret", "toggleClientSecret"),
      );
    }

    const toggleAuthBtn = document.getElementById("toggleAuthCode");
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener("click", () =>
        togglePasswordVisibility("authorizationCode", "toggleAuthCode"),
      );
    }

    // Vehicle Management Listeners
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

    // Handle devices
    currentDevices = credentials.authorized_devices || [];
    renderDevices();

    // Add CSS class for masked fields
    if (masked) {
      if (clientSecretInput)
        clientSecretInput.classList.add("credential-masked");
      if (authCodeInput) authCodeInput.classList.add("credential-masked");
    } else {
      if (clientSecretInput)
        clientSecretInput.classList.remove("credential-masked");
      if (authCodeInput) authCodeInput.classList.remove("credential-masked");
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
    const authorizationCode = document
      .getElementById("authorizationCode")
      .value.trim();
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
          "error",
        );
      }
    } catch (error) {
      console.error("Error saving credentials:", error);
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

  // ========================================
  // Vehicle Management
  // ========================================

  /**
   * Load and display vehicles
   */
  async function loadVehicles() {
    const vehiclesList = document.getElementById("vehiclesList");

    try {
      const response = await fetch("/api/vehicles?active_only=false");
      if (!response.ok) throw new Error("Failed to load vehicles");

      const vehicles = await response.json();
      const noVehiclesHtml =
        '<p class="text-center text-muted py-3">No vehicles found. Click "Sync from Bouncie" to auto-discover vehicles.</p>';

      if (vehiclesList) {
        if (vehicles.length === 0) {
          vehiclesList.innerHTML = noVehiclesHtml;
        } else {
          vehiclesList.innerHTML = vehicles
            .map((vehicle) => createVehicleItem(vehicle))
            .join("");
        }
      }

      // Add event listeners if we have vehicles
      if (vehicles.length > 0) {
        vehicles.forEach((vehicle) => {
          addVehicleListeners(vehicle.imei);
        });
      }
    } catch (error) {
      console.error("Error loading vehicles:", error);
      if (vehiclesList) {
        vehiclesList.innerHTML =
          '<p class="text-center text-danger py-3">Error loading vehicles</p>';
      }
    }
  }

  /**
   * Add listeners for a vehicle item
   */
  function addVehicleListeners(imei) {
    const saveBtn = document.getElementById(`save-vehicle-${imei}`);
    const deleteBtn = document.getElementById(`delete-vehicle-${imei}`);

    if (saveBtn) {
      saveBtn.addEventListener("click", () => saveVehicle(imei));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deleteVehicle(imei));
    }
  }

  /**
   * Create HTML for a vehicle item
   */
  function createVehicleItem(vehicle) {
    const statusBadge = vehicle.is_active
      ? '<span class="badge bg-success">Active</span>'
      : '<span class="badge bg-secondary">Inactive</span>';

    return `
      <div class="vehicle-item-container" id="vehicle-${vehicle.imei}">
        <div class="row g-3">
          <div class="col-md-3">
            <label class="form-label small text-muted">IMEI</label>
            <input type="text" class="form-control form-control-sm" value="${vehicle.imei}" readonly style="background: var(--surface-2);" />
          </div>
          <div class="col-md-3">
            <label class="form-label small text-muted">VIN</label>
            <input type="text" class="form-control form-control-sm" value="${vehicle.vin || "N/A"}" readonly style="background: var(--surface-2);" />
          </div>
          <div class="col-md-4">
            <label class="form-label small text-muted">Custom Name</label>
            <input type="text" class="form-control form-control-sm" id="name-${vehicle.imei}"
                   value="${vehicle.custom_name || ""}" placeholder="Enter friendly name..." />
          </div>
          <div class="col-md-2">
            <label class="form-label small text-muted">Status</label>
            <div>${statusBadge}</div>
            <div class="form-check form-switch mt-1">
              <input class="form-check-input" type="checkbox" id="active-${vehicle.imei}"
                     ${vehicle.is_active ? "checked" : ""} />
              <label class="form-check-label small" for="active-${vehicle.imei}">Active</label>
            </div>
          </div>
          <div class="col-12">
            <button type="button" class="btn btn-sm btn-primary" id="save-vehicle-${vehicle.imei}">
              <i class="fas fa-save"></i> Save Changes
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger" id="delete-vehicle-${vehicle.imei}">
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
  async function saveVehicle(imei) {
    const nameInput = document.getElementById(`name-${imei}`);
    const activeInput = document.getElementById(`active-${imei}`);

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
