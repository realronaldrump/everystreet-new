/**
 * Vehicles Page JavaScript
 * Handles vehicle display and odometer management
 */

(() => {
  // State
  let allVehicles = [];
  let currentVehicle = null;
  let bouncieOdometer = null;
  let pageSignal = null;

  // LocalStorage key for persisting selected vehicle
  const STORAGE_KEY = "selectedVehicleImei";

  // DOM Elements
  let elements = {};

  // Initialize
  window.utils?.onPageLoad(
    ({ signal, cleanup } = {}) => {
      pageSignal = signal || null;
      cacheElements();
      resetState();
      initializeEventListeners(signal);
      loadVehicle();
      if (typeof cleanup === "function") {
        cleanup(() => {
          pageSignal = null;
          resetState();
        });
      }
    },
    { route: "/vehicles" }
  );

  function cacheElements() {
    elements = {
      loadingState: document.getElementById("loading-state"),
      emptyState: document.getElementById("empty-state"),
      vehicleContent: document.getElementById("vehicle-content"),

      // Vehicle info
      vehicleName: document.getElementById("vehicle-name"),
      vehicleSubtitle: document.getElementById("vehicle-subtitle"),
      vehicleStatusBadge: document.getElementById("vehicle-status-badge"),
      vehicleImei: document.getElementById("vehicle-imei"),
      vehicleVin: document.getElementById("vehicle-vin"),
      vehicleMake: document.getElementById("vehicle-make"),
      vehicleModel: document.getElementById("vehicle-model"),
      vehicleYear: document.getElementById("vehicle-year"),

      // Odometer
      currentOdometer: document.getElementById("current-odometer"),
      odometerSource: document.getElementById("odometer-source"),
      odometerUpdated: document.getElementById("odometer-updated"),
      bouncieOdometer: document.getElementById("bouncie-odometer"),
      bouncieReadingSection: document.getElementById("bouncie-reading-section"),
      manualOdometerInput: document.getElementById("manual-odometer-input"),

      // Settings
      customNameInput: document.getElementById("custom-name-input"),
      activeStatusToggle: document.getElementById("active-status-toggle"),

      // Buttons
      syncFromEmptyBtn: document.getElementById("sync-from-empty-btn"),
      syncVehicleBtn: document.getElementById("sync-vehicle-btn"),
      refreshBouncieBtn: document.getElementById("refresh-bouncie-btn"),
      useBouncieReadingBtn: document.getElementById("use-bouncie-reading-btn"),
      saveManualOdometerBtn: document.getElementById("save-manual-odometer-btn"),
      saveSettingsBtn: document.getElementById("save-settings-btn"),

      // Vehicle selector
      vehicleSelectorCard: document.getElementById("vehicle-selector-card"),
      vehicleSelect: document.getElementById("vehicle-select"),

      // Toast
      notificationToast: document.getElementById("notification-toast"),
      toastTitle: document.getElementById("toast-title"),
      toastBody: document.getElementById("toast-body"),
    };
  }

  function resetState() {
    allVehicles = [];
    currentVehicle = null;
    bouncieOdometer = null;
  }

  function withSignal(options = {}) {
    if (pageSignal) {
      return { ...options, signal: pageSignal };
    }
    return options;
  }

  /**
   * Initialize event listeners
   */
  function initializeEventListeners(signal) {
    if (elements.syncFromEmptyBtn) {
      elements.syncFromEmptyBtn.addEventListener(
        "click",
        syncFromBouncie,
        signal ? { signal } : false
      );
    }
    if (elements.syncVehicleBtn) {
      elements.syncVehicleBtn.addEventListener(
        "click",
        syncFromBouncie,
        signal ? { signal } : false
      );
    }
    if (elements.refreshBouncieBtn) {
      elements.refreshBouncieBtn.addEventListener(
        "click",
        fetchBouncieOdometer,
        signal ? { signal } : false
      );
    }
    if (elements.useBouncieReadingBtn) {
      elements.useBouncieReadingBtn.addEventListener(
        "click",
        useBouncieReading,
        signal ? { signal } : false
      );
    }
    if (elements.saveManualOdometerBtn) {
      elements.saveManualOdometerBtn.addEventListener(
        "click",
        saveManualOdometer,
        signal ? { signal } : false
      );
    }
    if (elements.saveSettingsBtn) {
      elements.saveSettingsBtn.addEventListener(
        "click",
        saveSettings,
        signal ? { signal } : false
      );
    }
    if (elements.vehicleSelect) {
      elements.vehicleSelect.addEventListener(
        "change",
        handleVehicleSelectChange,
        signal ? { signal } : false
      );
    }
  }

  /**
   * Load the vehicle data
   */
  async function loadVehicle() {
    if (pageSignal?.aborted) {
      return;
    }
    showLoading();

    try {
      const response = await fetch("/api/vehicles?active_only=false", withSignal());
      if (!response.ok) {
        throw new Error("Failed to fetch vehicles");
      }

      const vehicles = await response.json();

      if (vehicles.length === 0) {
        showEmpty();
        return;
      }

      // Store all vehicles
      allVehicles = vehicles;

      // Show vehicle selector if multiple vehicles
      if (vehicles.length > 1) {
        populateVehicleSelector(vehicles);
        elements.vehicleSelectorCard.style.display = "block";
      } else {
        elements.vehicleSelectorCard.style.display = "none";
      }

      // Determine which vehicle to display
      const savedImei = window.utils?.getStorage(STORAGE_KEY);
      let vehicleToDisplay = null;

      // Try to find saved vehicle
      if (savedImei) {
        vehicleToDisplay = vehicles.find((v) => v.imei === savedImei);
      }

      // Fall back to first active vehicle, or first vehicle
      if (!vehicleToDisplay) {
        vehicleToDisplay = vehicles.find((v) => v.is_active) || vehicles[0];
      }

      selectVehicle(vehicleToDisplay.imei);
      showContent();
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error loading vehicle:", error);
      showEmpty();
      showNotification("Error", "Failed to load vehicle data", "error");
    }
  }

  /**
   * Populate the vehicle selector dropdown
   */
  function populateVehicleSelector(vehicles) {
    if (!elements.vehicleSelect) {
      return;
    }

    elements.vehicleSelect.innerHTML = "";

    vehicles.forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.imei;
      option.textContent = getVehicleDisplayName(vehicle);
      elements.vehicleSelect.appendChild(option);
    });
  }

  /**
   * Get display name for a vehicle
   */
  function getVehicleDisplayName(vehicle) {
    if (vehicle.custom_name) {
      return vehicle.custom_name;
    }
    const parts = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : `Vehicle ${vehicle.imei}`;
  }

  /**
   * Handle vehicle selector change
   */
  function handleVehicleSelectChange() {
    const selectedImei = elements.vehicleSelect.value;
    if (selectedImei) {
      selectVehicle(selectedImei);
    }
  }

  /**
   * Select and display a vehicle by IMEI
   */
  function selectVehicle(imei) {
    const vehicle = allVehicles.find((v) => v.imei === imei);
    if (!vehicle) {
      return;
    }

    currentVehicle = vehicle;

    // Persist selection
    window.utils?.setStorage(STORAGE_KEY, imei);
    window.ESStore?.updateFilters({ vehicle: imei }, { source: "vehicle" });

    // Update dropdown selection
    if (elements.vehicleSelect) {
      elements.vehicleSelect.value = imei;
    }

    // Display the vehicle
    displayVehicle(vehicle);

    // Fetch live Bouncie odometer reading
    fetchBouncieOdometer();
  }

  /**
   * Display vehicle data in the UI
   */
  function displayVehicle(vehicle) {
    if (!vehicle) {
      return;
    }

    // Name and subtitle
    const displayName =
      vehicle.custom_name ||
      `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim() ||
      "My Vehicle";
    elements.vehicleName.textContent = displayName;

    const subtitle = vehicle.custom_name
      ? `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim()
      : vehicle.vin || vehicle.imei;
    elements.vehicleSubtitle.textContent = subtitle || "--";

    // Status badge
    if (vehicle.is_active) {
      elements.vehicleStatusBadge.innerHTML =
        '<span class="badge bg-success">Active</span>';
    } else {
      elements.vehicleStatusBadge.innerHTML =
        '<span class="badge bg-secondary">Inactive</span>';
    }

    // Info grid
    elements.vehicleImei.textContent = vehicle.imei || "--";
    elements.vehicleVin.textContent = vehicle.vin || "--";
    elements.vehicleMake.textContent = vehicle.make || "--";
    elements.vehicleModel.textContent = vehicle.model || "--";
    elements.vehicleYear.textContent = vehicle.year || "--";

    // Odometer
    if (vehicle.odometer_reading) {
      elements.currentOdometer.textContent = formatNumber(vehicle.odometer_reading);

      const sourceLabels = {
        bouncie: "From Bouncie",
        manual: "Manually entered",
        trip: "From trip data",
      };
      const sourceLabel = sourceLabels[vehicle.odometer_source] || "Unknown source";
      elements.odometerSource.innerHTML = `<i class="fas fa-info-circle me-1"></i>${sourceLabel}`;

      if (vehicle.odometer_updated_at) {
        const updatedDate = new Date(vehicle.odometer_updated_at);
        elements.odometerUpdated.textContent = `Updated ${formatRelativeTime(updatedDate)}`;
      }
    } else {
      elements.currentOdometer.textContent = "--";
      elements.odometerSource.innerHTML =
        '<i class="fas fa-info-circle me-1"></i>No reading yet';
      elements.odometerUpdated.textContent = "";
    }

    // Settings form
    elements.customNameInput.value = vehicle.custom_name || "";
    elements.activeStatusToggle.checked = vehicle.is_active;

    // Pre-fill manual input with current reading
    if (vehicle.odometer_reading) {
      elements.manualOdometerInput.placeholder = formatNumber(vehicle.odometer_reading);
    }
  }

  /**
   * Fetch live odometer reading from Bouncie
   */
  async function fetchBouncieOdometer() {
    if (!currentVehicle) {
      return;
    }

    elements.bouncieOdometer.innerHTML =
      '<span class="spinner-border spinner-border-sm" role="status"></span>';
    elements.useBouncieReadingBtn.disabled = true;

    try {
      const response = await fetch(
        `/api/vehicle-location?imei=${currentVehicle.imei}&use_now=true`,
        withSignal()
      );
      const data = await response.json();

      if (data.odometer) {
        bouncieOdometer = data.odometer;
        elements.bouncieOdometer.textContent = `${formatNumber(data.odometer)} miles`;
        elements.bouncieOdometer.classList.remove("error");
        elements.useBouncieReadingBtn.disabled = false;
      } else {
        bouncieOdometer = null;
        elements.bouncieOdometer.textContent = "Unable to retrieve";
        elements.bouncieOdometer.classList.add("error");
        elements.useBouncieReadingBtn.disabled = true;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error fetching Bouncie odometer:", error);
      bouncieOdometer = null;
      elements.bouncieOdometer.textContent = "Connection error";
      elements.bouncieOdometer.classList.add("error");
      elements.useBouncieReadingBtn.disabled = true;
    }
  }

  /**
   * Use the Bouncie reading as the current odometer
   */
  async function useBouncieReading() {
    if (!currentVehicle || !bouncieOdometer) {
      return;
    }

    try {
      await updateVehicleOdometer(bouncieOdometer, "bouncie");
      showNotification("Success", "Odometer updated from Bouncie", "success");
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error updating odometer:", error);
      showNotification("Error", "Failed to update odometer", "error");
    }
  }

  /**
   * Save manually entered odometer
   */
  async function saveManualOdometer() {
    if (!currentVehicle) {
      return;
    }

    const value = parseFloat(elements.manualOdometerInput.value);
    if (Number.isNaN(value) || value < 0) {
      showNotification("Error", "Please enter a valid odometer reading", "error");
      return;
    }

    try {
      await updateVehicleOdometer(value, "manual");
      elements.manualOdometerInput.value = "";
      showNotification("Success", "Odometer updated", "success");
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error saving manual odometer:", error);
      showNotification("Error", "Failed to save odometer", "error");
    }
  }

  /**
   * Update vehicle odometer via API
   */
  async function updateVehicleOdometer(reading, source) {
    const response = await fetch(
      `/api/vehicles/${currentVehicle.imei}`,
      withSignal({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imei: currentVehicle.imei,
          odometer_reading: reading,
          odometer_source: source,
        }),
      })
    );

    if (!response.ok) {
      throw new Error("Failed to update vehicle");
    }

    // Reload to show updated data
    await loadVehicle();
  }

  /**
   * Save vehicle settings (name, active status)
   */
  async function saveSettings() {
    if (!currentVehicle) {
      return;
    }

    const customName = elements.customNameInput.value.trim() || null;
    const isActive = elements.activeStatusToggle.checked;

    try {
      const response = await fetch(
        `/api/vehicles/${currentVehicle.imei}`,
        withSignal({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imei: currentVehicle.imei,
            custom_name: customName,
            is_active: isActive,
          }),
        })
      );

      if (!response.ok) {
        throw new Error("Failed to save settings");
      }

      await loadVehicle();
      showNotification("Success", "Settings saved", "success");
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error saving settings:", error);
      showNotification("Error", "Failed to save settings", "error");
    }
  }

  /**
   * Sync vehicles from Bouncie
   */
  async function syncFromBouncie() {
    showLoading();

    try {
      const response = await fetch(
        "/api/profile/bouncie-credentials/sync-vehicles",
        withSignal({
          method: "POST",
        })
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Sync failed");
      }

      showNotification(
        "Success",
        data.message || "Vehicle synced from Bouncie",
        "success"
      );
      await loadVehicle();
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Error syncing from Bouncie:", error);
      showNotification(
        "Error",
        error.message || "Failed to sync from Bouncie",
        "error"
      );
      // Reload to show whatever state we have
      await loadVehicle();
    }
  }

  // UI State helpers
  function showLoading() {
    elements.loadingState.style.display = "block";
    elements.emptyState.style.display = "none";
    elements.vehicleContent.style.display = "none";
  }

  function showEmpty() {
    elements.loadingState.style.display = "none";
    elements.emptyState.style.display = "block";
    elements.vehicleContent.style.display = "none";
  }

  function showContent() {
    elements.loadingState.style.display = "none";
    elements.emptyState.style.display = "none";
    elements.vehicleContent.style.display = "block";
  }

  /**
   * Show a toast notification
   */
  function showNotification(title, message, type = "info") {
    elements.toastTitle.textContent = title;
    elements.toastBody.textContent = message;

    // Update icon based on type
    const iconClass =
      type === "success"
        ? "fa-check-circle text-success"
        : type === "error"
          ? "fa-exclamation-circle text-danger"
          : "fa-info-circle text-primary";

    const toastHeader = elements.notificationToast.querySelector(".toast-header i");
    if (toastHeader) {
      toastHeader.className = `fas ${iconClass} me-2`;
    }

    const toast = new window.bootstrap.Toast(elements.notificationToast);
    toast.show();
  }

  /**
   * Format number with commas
   */
  function formatNumber(num) {
    if (num === null || num === undefined) {
      return "--";
    }
    return Number(num).toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    });
  }

  /**
   * Format relative time (e.g., "2 hours ago")
   */
  function formatRelativeTime(date) {
    if (!date) {
      return "";
    }

    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) {
      return "just now";
    }
    if (diffMins < 60) {
      return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    }
    if (diffHours < 24) {
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    }
    if (diffDays < 7) {
      return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    }

    return date.toLocaleDateString();
  }
})();
