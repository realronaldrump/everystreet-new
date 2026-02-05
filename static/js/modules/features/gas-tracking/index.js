/* global mapboxgl */

import apiClient from "../../core/api-client.js";
import store from "../../core/store.js";
import { createMap } from "../../map-base.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import { formatVehicleName, getStorage, setStorage } from "../../utils.js";

/**
 * Gas Tracking Module - Redesigned for better UX
 * Handles gas fill-up recording, MPG calculation, and statistics
 */

// State
let map = null;
let marker = null;
let currentLocation = null;
let vehicles = [];
let recentFillups = [];
let vehicleDiscoveryAttempted = false;
let pageSignal = null;

const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;
const apiRaw = (url, options = {}) => apiClient.raw(url, withSignal(options));

// Use shared notification manager
const showSuccess = (msg) => notificationManager.show(msg, "success");
const showError = (msg) => notificationManager.show(msg, "danger");

export default async function initGasTrackingPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  try {
    await initializePage(signal, cleanup);
  } catch (e) {
    showError(`Critical Error: ${e.message}`);
  }
}

/**
 * Initialize the page
 */
async function initializePage(signal, cleanup) {
  try {
    // Initialize map (but don't show it immediately)
    await initializeMap();

    // Load vehicles
    await loadVehicles();

    // Load statistics
    await loadStatistics();

    // Load recent fill-ups
    await loadRecentFillups();

    // Set up event listeners
    setupEventListeners(signal);

    // Set current time as default
    setCurrentTime();

    const teardown = () => {
      pageSignal = null;
      if (marker) {
        try {
          marker.remove();
        } catch {
          // Ignore cleanup errors.
        }
        marker = null;
      }
      if (map) {
        try {
          map.remove();
        } catch {
          // Ignore cleanup errors.
        }
        map = null;
      }
    };

    if (typeof cleanup === "function") {
      cleanup(teardown);
    } else {
      return teardown;
    }
  } catch {
    showError("Failed to initialize page");
  }
}

/**
 * Initialize Mapbox map
 */
async function initializeMap() {
  if (!window.MAPBOX_ACCESS_TOKEN) {
    return;
  }

  // Use the shared map factory if available to ensure consistent styling
  if (createMap) {
    map = createMap("fillup-map", {
      center: [-95.7129, 37.0902],
      zoom: 4,
      attributionControl: false,
    });
  } else {
    // Fallback if factory not found
    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
    map = new mapboxgl.Map({
      container: "fillup-map",
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-95.7129, 37.0902],
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
  }

  // Wait for map to load
  await new Promise((resolve) => map.on("load", resolve));
}

/**
 * Update inline vehicle status helper
 */
function setVehicleStatus(message, tone = "muted") {
  const statusEl = document.getElementById("vehicle-status");
  if (!statusEl) {
    return;
  }

  const toneClassMap = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    muted: "form-hint",
    info: "text-info",
  };

  const toneClass = toneClassMap[tone] || toneClassMap.muted;
  statusEl.className = toneClass;
  statusEl.textContent = message;
}

/**
 * Toggle vehicle loading indicator and selection state
 */
function toggleVehicleLoading(isLoading, _message = "Detecting vehicles...") {
  const loadingEl = document.getElementById("vehicle-loading-state");
  const vehicleSelect = document.getElementById("vehicle-select");

  if (loadingEl) {
    loadingEl.style.display = isLoading ? "flex" : "none";
  }
  if (vehicleSelect) {
    vehicleSelect.disabled = isLoading && !vehicleSelect.value;
  }
}

/**
 * Load vehicles from API
 */
async function loadVehicles(options = {}) {
  const { skipDiscovery = false } = options;
  const vehicleSelect = document.getElementById("vehicle-select");

  try {
    toggleVehicleLoading(true, "Loading vehicles...");
    setVehicleStatus("Loading your vehicles...", "muted");

    const response = await apiRaw("/api/vehicles?active_only=true");
    if (!response.ok) {
      throw new Error("Failed to load vehicles");
    }

    vehicles = await response.json();

    vehicleSelect.innerHTML = '<option value="">Choose your vehicle...</option>';

    if (vehicles.length === 0 && !vehicleDiscoveryAttempted && !skipDiscovery) {
      vehicleDiscoveryAttempted = true;
      const discovered = await attemptVehicleDiscovery();
      if (discovered) {
        return loadVehicles({ skipDiscovery: true });
      }
    }

    if (vehicles.length === 0) {
      vehicleSelect.innerHTML
        = '<option value="">No vehicles found. Go to Profile to sync/add.</option>';
      setVehicleStatus(
        "No vehicles detected. Try syncing from your Profile page.",
        "warning"
      );
      return vehicles;
    }

    vehicles.forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.imei;
      option.textContent = formatVehicleName(vehicle);
      option.dataset.vin = vehicle.vin || "";
      vehicleSelect.appendChild(option);
    });

    const savedImei = getStorage("selectedVehicleImei");
    if (savedImei && vehicles.some((vehicle) => vehicle.imei === savedImei)) {
      vehicleSelect.value = savedImei;
      await updateLocationAndOdometer();
      setVehicleStatus(
        `Loaded ${formatVehicleName(vehicles.find((v) => v.imei === savedImei))}`,
        "success"
      );
      return vehicles;
    }

    // If only one vehicle, auto-select it
    if (vehicles.length === 1) {
      vehicleSelect.value = vehicles[0].imei;
      await updateLocationAndOdometer();
      setVehicleStatus(`Auto-selected ${formatVehicleName(vehicles[0])}`, "success");
      return vehicles;
    }
    if (vehicles.length > 0) {
      setVehicleStatus(
        `${vehicles.length} vehicles available. Select one to continue.`,
        "success"
      );
    }
    return vehicles;
  } catch {
    setVehicleStatus("Could not load vehicles. Please sync from Profile.", "danger");
    showError("Failed to load vehicles");
    return [];
  } finally {
    toggleVehicleLoading(false);
  }
}

/**
 * Attempt to auto-discover vehicles via Bouncie or trip history
 */
async function attemptVehicleDiscovery() {
  const discoverySteps = [
    {
      label: "Connecting to Bouncie…",
      url: "/api/profile/bouncie-credentials/sync-vehicles",
      method: "POST",
      successMessage: "Pulled vehicles directly from Bouncie.",
      tolerateStatuses: [400, 401],
      hasVehicles: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    },
    {
      label: "Scanning trip history…",
      url: "/api/vehicles/sync-from-trips",
      method: "POST",
      successMessage: "Created vehicles from your recorded trips.",
      hasVehicles: (data) =>
        (data?.synced ?? 0) > 0
        || (data?.updated ?? 0) > 0
        || (data?.total_vehicles ?? 0) > 0,
    },
  ];

  for (const step of discoverySteps) {
    try {
      toggleVehicleLoading(true, step.label);
      const response = await apiRaw(step.url, { method: step.method });

      if (!response.ok) {
        if (step.tolerateStatuses?.includes(response.status)) {
          continue;
        }
        continue;
      }

      const data = await response.json().catch(() => ({}));
      if (step.hasVehicles?.(data)) {
        setVehicleStatus(step.successMessage, "success");
        showSuccess(step.successMessage);
        return true;
      }
    } catch {
      // Vehicle discovery error, continue to next step
    }
  }

  return false;
}

/**
 * Update location and odometer based on selected time and vehicle
 */
async function updateLocationAndOdometer() {
  const vehicleSelect = document.getElementById("vehicle-select");
  const fillupTime = document.getElementById("fillup-time").value;
  const locationText = document.getElementById("location-text");
  const odometerDisplay = document.getElementById("odometer-display");
  const odometerInput = document.getElementById("odometer");

  if (!vehicleSelect.value) {
    if (locationText) {
      locationText.textContent = "Select a vehicle to see location";
    }
    if (odometerDisplay) {
      odometerDisplay.textContent = "Last known: --";
    }
    return;
  }

  try {
    if (locationText) {
      locationText.textContent = "Loading location...";
    }
    if (odometerDisplay) {
      odometerDisplay.textContent = "Loading...";
    }

    // Determine if we should use "now" or a specific timestamp
    const useNow = !fillupTime || isNearCurrentTime(fillupTime);

    let url = `/api/vehicle-location?imei=${encodeURIComponent(vehicleSelect.value)}`;
    if (useNow) {
      url += "&use_now=true";
    } else {
      url += `&timestamp=${encodeURIComponent(new Date(fillupTime).toISOString())}`;
    }

    const response = await apiRaw(url);

    if (!response.ok) {
      // Handle specific error cases
      if (response.status === 404) {
        // No trip data for this vehicle
        if (locationText) {
          locationText.textContent = "No trip data available";
        }
        if (odometerDisplay) {
          odometerDisplay.textContent = "Enter odometer reading";
        }
        if (odometerInput) {
          odometerInput.placeholder = "Enter miles";
        }
        if (map && marker) {
          marker.remove();
        }
        currentLocation = null;
        return;
      }
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.detail || `Failed to fetch location (${response.status})`
      );
    }

    const data = await response.json();
    currentLocation = data;

    // Update map
    if (data.latitude && data.longitude) {
      updateMap(data.latitude, data.longitude);
      if (locationText) {
        locationText.textContent = data.address
          ? truncateText(data.address, 40)
          : `${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`;
      }
    } else {
      if (locationText) {
        locationText.textContent = "Location not available";
      }
      if (map && marker) {
        marker.remove();
      }
    }

    // Update odometer - strict check for null/undefined to allow 0
    if (data.odometer != null) {
      const odoVal = Math.round(data.odometer);
      if (odometerDisplay) {
        odometerDisplay.textContent = `Last known: ${odoVal.toLocaleString()} mi`;
      }
      if (odometerInput && !odometerInput.value) {
        odometerInput.value = odoVal;
      }
    } else {
      if (odometerDisplay) {
        odometerDisplay.textContent = "Enter odometer reading";
      }
      if (odometerInput) {
        odometerInput.placeholder = "Enter miles";
      }
    }
  } catch {
    if (locationText) {
      locationText.textContent = "Error loading location";
    }
    if (odometerDisplay) {
      odometerDisplay.textContent = "Last known: --";
    }
    currentLocation = null;
  }
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.substring(0, maxLength - 3)}...`;
}

/**
 * Check if a datetime string is near the current time (within 5 minutes)
 */
function isNearCurrentTime(datetimeString) {
  const inputTime = new Date(datetimeString);
  const now = new Date();
  const diff = Math.abs(now - inputTime);
  return diff < 5 * 60 * 1000; // 5 minutes in milliseconds
}

/**
 * Update map with location
 */
function updateMap(lat, lon) {
  if (!map) {
    return;
  }

  // Remove existing marker
  if (marker) {
    marker.remove();
  }

  // Add new marker
  marker = new mapboxgl.Marker({ color: "#3b8a7f" }).setLngLat([lon, lat]).addTo(map);

  // Fly to location
  map.flyTo({
    center: [lon, lat],
    zoom: 14,
    duration: 1000,
  });
}

/**
 * Calculate total cost
 */
function calculateTotalCost() {
  const gallons = parseFloat(document.getElementById("gallons").value) || 0;
  const pricePerGallon
    = parseFloat(document.getElementById("price-per-gallon").value) || 0;
  const totalCostInput = document.getElementById("total-cost");

  if (gallons > 0 && pricePerGallon > 0) {
    totalCostInput.value = (gallons * pricePerGallon).toFixed(2);
  } else {
    totalCostInput.value = "";
  }
}

/**
 * Set current time in datetime input
 */
function setCurrentTime() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localTime = new Date(now.getTime() - offset * 60 * 1000);
  const timeString = localTime.toISOString().slice(0, 16);
  document.getElementById("fillup-time").value = timeString;
}

/**
 * Set up event listeners
 */
function setupEventListeners(signal) {
  // Vehicle selection change
  document.getElementById("vehicle-select").addEventListener(
    "change",
    async (event) => {
      const selected = event.target.value || null;
      setStorage("selectedVehicleImei", selected);
      store.updateFilters({ vehicle: selected }, { source: "vehicle" });
      await updateLocationAndOdometer();
      await loadRecentFillups();
      await loadStatistics();
    },
    signal ? { signal } : false
  );

  // Fill-up time change
  document
    .getElementById("fillup-time")
    .addEventListener("change", updateLocationAndOdometer, signal ? { signal } : false);

  // Use Now button
  document.getElementById("use-now-btn").addEventListener(
    "click",
    () => {
      setCurrentTime();
      updateLocationAndOdometer();
    },
    signal ? { signal } : false
  );

  // Calculate total cost when price or gallons change
  document
    .getElementById("gallons")
    .addEventListener("input", calculateTotalCost, signal ? { signal } : false);
  document
    .getElementById("price-per-gallon")
    .addEventListener("input", calculateTotalCost, signal ? { signal } : false);

  // Form submission
  document
    .getElementById("gas-fillup-form")
    .addEventListener("submit", handleFormSubmit, signal ? { signal } : false);

  // Cancel edit
  document
    .getElementById("cancel-edit-btn")
    .addEventListener("click", resetFormState, signal ? { signal } : false);

  // Odometer Not Recorded toggle
  document.getElementById("odometer-not-recorded").addEventListener(
    "change",
    (e) => {
      const odoInput = document.getElementById("odometer");
      if (e.target.checked) {
        odoInput.value = "";
        odoInput.disabled = true;
        odoInput.placeholder = "Not recorded";
      } else {
        odoInput.disabled = false;
        odoInput.placeholder = "Miles";
      }
    },
    signal ? { signal } : false
  );

  // Auto-calc Odometer
  document
    .getElementById("auto-calc-odometer")
    .addEventListener("click", autoCalcOdometer, signal ? { signal } : false);

  // Fill-up list actions (edit/delete)
  const fillupList = document.getElementById("fillup-list");
  fillupList?.addEventListener(
    "click",
    (event) => {
      const target
        = event.target instanceof Element ? event.target : event.target?.parentElement;
      const button = target?.closest("[data-action]");
      if (!button) {
        return;
      }
      const action = button.getAttribute("data-action");
      const fillupId = button.getAttribute("data-fillup-id");
      if (!fillupId) {
        return;
      }
      if (action === "edit") {
        editFillup(fillupId);
      } else if (action === "delete") {
        deleteFillup(fillupId);
      }
    },
    signal ? { signal } : false
  );

  // Advanced section toggle
  const advancedToggle = document.getElementById("advanced-toggle");
  const advancedContent = document.getElementById("advanced-content");

  if (advancedToggle && advancedContent) {
    advancedToggle.addEventListener(
      "click",
      () => {
        const isExpanded = advancedToggle.getAttribute("aria-expanded") === "true";
        advancedToggle.setAttribute("aria-expanded", !isExpanded);
        // Use classList toggle for better CSS control
        if (isExpanded) {
          advancedContent.classList.remove("is-expanded");
          advancedContent.style.display = "none";
        } else {
          advancedContent.style.display = "flex";
          advancedContent.classList.add("is-expanded");
        }

        // Resize map when shown
        if (!isExpanded && map) {
          setTimeout(() => map.resize(), 100);
        }
      },
      signal ? { signal } : false
    );
  }
}

/**
 * Auto-calculate odometer
 */
async function autoCalcOdometer() {
  const imei = document.getElementById("vehicle-select").value;
  const fillupTime = document.getElementById("fillup-time").value;
  const odoInput = document.getElementById("odometer");
  const odoCheck = document.getElementById("odometer-not-recorded");
  const autoCalcBtn = document.getElementById("auto-calc-odometer");

  if (!imei) {
    showError("Please select a vehicle first");
    return;
  }
  if (odoCheck.checked) {
    showError("Please uncheck 'Not Recorded' first");
    return;
  }

  try {
    // Show loading state
    autoCalcBtn.innerHTML
      = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
    autoCalcBtn.disabled = true;

    const timestamp = new Date(fillupTime).toISOString();
    const response = await apiRaw(
      `/api/vehicles/estimate-odometer?imei=${encodeURIComponent(imei)}&timestamp=${encodeURIComponent(timestamp)}`
    );

    if (!response.ok) {
      throw new Error("Failed to estimate odometer");
    }

    const result = await response.json();

    if (result.estimated_odometer !== null) {
      odoInput.value = result.estimated_odometer;
      // Visual feedback
      odoInput.classList.add("is-valid");
      setTimeout(() => {
        odoInput.classList.remove("is-valid");
      }, 1000);
      showSuccess(
        `Estimated from ${result.method} (Anchor: ${result.anchor_odometer}, Diff: ${result.distance_diff} mi)`
      );
    } else {
      showError("Could not estimate: No previous/next trusted odometer found.");
    }
  } catch {
    showError("Failed to auto-calculate odometer");
  } finally {
    // Restore button
    autoCalcBtn.innerHTML = '<i class="fas fa-magic"></i>';
    autoCalcBtn.disabled = false;
  }
}

/**
 * Handle form submission
 */
async function handleFormSubmit(e) {
  e.preventDefault();

  const submitButton = document.getElementById("submit-btn");
  const spinner = document.getElementById("submit-spinner");
  const fillupId = document.getElementById("fillup-id").value;
  const isEdit = Boolean(fillupId);

  try {
    // Show loading state
    submitButton.disabled = true;
    spinner.style.display = "inline-block";

    // Gather form data
    const isNoOdo = document.getElementById("odometer-not-recorded").checked;

    const formData = {
      imei: document.getElementById("vehicle-select").value,
      fillup_time: new Date(document.getElementById("fillup-time").value).toISOString(),
      gallons: parseFloat(document.getElementById("gallons").value),
      price_per_gallon:
        parseFloat(document.getElementById("price-per-gallon").value) || null,
      total_cost: parseFloat(document.getElementById("total-cost").value) || null,
      odometer: isNoOdo
        ? null
        : parseFloat(document.getElementById("odometer").value) || null,
      latitude: currentLocation?.latitude || null,
      longitude: currentLocation?.longitude || null,
      is_full_tank: document.getElementById("full-tank").checked,
      missed_previous: document.getElementById("missed-previous").checked,
      notes: document.getElementById("notes").value || null,
    };

    // Validate
    if (!formData.imei) {
      throw new Error("Please select a vehicle");
    }
    if (!formData.gallons || formData.gallons <= 0) {
      throw new Error("Please enter a valid amount of gallons");
    }

    // Submit to API
    let url = "/api/gas-fillups";
    let method = "POST";

    if (isEdit) {
      url += `/${fillupId}`;
      method = "PUT";
    }

    const response = await apiRaw(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(formData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        error.detail || `Failed to ${isEdit ? "update" : "save"} fill-up`
      );
    }

    const result = await response.json();

    // Show success message
    showSuccess(`Fill-up ${isEdit ? "updated" : "recorded"} successfully!`);

    // Show calculated MPG if available
    if (result.calculated_mpg) {
      const mpgDisplay = document.getElementById("calculated-mpg");
      const mpgValue = document.getElementById("mpg-value");
      mpgValue.textContent = result.calculated_mpg.toFixed(2);
      mpgDisplay.style.display = "flex";

      setTimeout(() => {
        mpgDisplay.style.display = "none";
      }, 5000);
    }

    // Reset form
    resetFormState();

    // Reload data
    await Promise.all([loadRecentFillups(), loadStatistics()]);
  } catch (error) {
    showError(error.message || `Failed to ${isEdit ? "update" : "save"} fill-up`);
  } finally {
    submitButton.disabled = false;
    spinner.style.display = "none";
  }
}

/**
 * Reset form state (clear fields, exit edit mode)
 */
function resetFormState() {
  document.getElementById("gas-fillup-form").reset();

  // Clear ID and reset buttons
  document.getElementById("fillup-id").value = "";
  document.getElementById("cancel-edit-btn").style.display = "none";
  document.getElementById("submit-btn-text").textContent = "Save Fill-up";
  document.getElementById("form-badge").style.display = "none";

  // Reset Odometer check
  const odoInput = document.getElementById("odometer");
  const odoCheck = document.getElementById("odometer-not-recorded");
  odoCheck.checked = false;
  odoInput.disabled = false;
  odoInput.placeholder = "Miles";

  // Reset helper text
  document.getElementById("location-text").textContent
    = "Select a vehicle to see location";
  document.getElementById("odometer-display").textContent = "Last known: --";
  document.getElementById("calculated-mpg").style.display = "none";

  // Collapse advanced section
  const advancedToggle = document.getElementById("advanced-toggle");
  const advancedContent = document.getElementById("advanced-content");
  if (advancedToggle && advancedContent) {
    advancedToggle.setAttribute("aria-expanded", "false");
    advancedContent.style.display = "none";
  }

  // Retain vehicle selection if possible, otherwise reset
  const vehicleSelect = document.getElementById("vehicle-select");
  const selectedVehicle = vehicleSelect.value;
  if (selectedVehicle) {
    // Re-select it after a tick because reset clears it
    setTimeout(() => {
      vehicleSelect.value = selectedVehicle;
      setCurrentTime(); // Reset time to now
      currentLocation = null; // Clear old location data
      if (marker) {
        marker.remove();
      }
      updateLocationAndOdometer(); // Fetch fresh "now" data
    }, 0);
  } else {
    setCurrentTime();
  }
}

/**
 * Load recent fill-ups
 */
async function loadRecentFillups() {
  const vehicleSelect = document.getElementById("vehicle-select");
  const fillupList = document.getElementById("fillup-list");
  const historyCount = document.getElementById("history-count");

  try {
    let url = "/api/gas-fillups?limit=10";
    if (vehicleSelect.value) {
      url += `&imei=${encodeURIComponent(vehicleSelect.value)}`;
    }

    const response = await apiRaw(url);
    if (!response.ok) {
      throw new Error("Failed to load fill-ups");
    }

    const fillups = await response.json();
    recentFillups = fillups; // Store globally

    // Update count badge
    if (historyCount) {
      historyCount.textContent = fillups.length;
    }

    if (fillups.length === 0) {
      fillupList.innerHTML = `
        <div class="empty-state" id="empty-state">
          <div class="empty-icon">
            <i class="fas fa-gas-pump"></i>
          </div>
          <h3 class="empty-title">No fill-ups yet</h3>
          <p class="empty-text">Record your first fill-up to start tracking your fuel efficiency.</p>
        </div>
      `;
      return;
    }

    fillupList.innerHTML = fillups.map((fillup) => createFillupItem(fillup)).join("");
  } catch {
    fillupList.innerHTML
      = '<p class="text-center text-danger p-4">Error loading fill-ups</p>';
  }
}

/**
 * Create HTML for a fill-up item
 */
function createFillupItem(fillup) {
  const date = new Date(fillup.fillup_time);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const cost = fillup.total_cost ? `$${fillup.total_cost.toFixed(2)}` : "--";
  const mpg = fillup.calculated_mpg ? fillup.calculated_mpg.toFixed(1) : "--";
  const pricePerGallon = fillup.price_per_gallon
    ? `$${fillup.price_per_gallon.toFixed(2)}`
    : "--";

  // Lookup vehicle name
  const vehicle = vehicles.find((v) => v.imei === fillup.imei);
  const vehicleName = vehicle
    ? vehicle.custom_name || `Vehicle ${vehicle.vin || vehicle.imei.slice(-4)}`
    : fillup.vin || fillup.imei?.slice(-4) || "Unknown";

  return `
    <div class="fillup-item" id="fillup-item-${fillup._id}">
      <div class="fillup-header">
        <div class="fillup-main">
          <span class="fillup-date">${dateStr} at ${timeStr}</span>
          <span class="fillup-vehicle">${vehicleName}</span>
        </div>
        <span class="fillup-amount">${fillup.gallons.toFixed(2)} gal</span>
      </div>

      <div class="fillup-details">
        <div class="fillup-detail">
          <span class="fillup-detail-label">Total Cost</span>
          <span class="fillup-detail-value">${cost}</span>
        </div>
        <div class="fillup-detail">
          <span class="fillup-detail-label">Price/Gallon</span>
          <span class="fillup-detail-value">${pricePerGallon}</span>
        </div>
        <div class="fillup-detail">
          <span class="fillup-detail-label">MPG</span>
          <span class="fillup-detail-value">${mpg}</span>
        </div>
        <div class="fillup-detail">
          <span class="fillup-detail-label">Odometer</span>
          <span class="fillup-detail-value">${fillup.odometer ? `${Math.round(fillup.odometer).toLocaleString()} mi` : "--"}</span>
        </div>
      </div>

      ${fillup.notes ? `<div class="fillup-notes"><i class="fas fa-sticky-note"></i>${fillup.notes}</div>` : ""}

      <div class="fillup-actions">
        <button data-action="edit" data-fillup-id="${fillup._id}" title="Edit">
          <i class="fas fa-edit"></i>
        </button>
        <button data-action="delete" data-fillup-id="${fillup._id}" title="Delete">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `;
}

/**
 * Edit a fill-up
 */
function editFillup(id) {
  const fillup = recentFillups.find((f) => f._id === id);
  if (!fillup) {
    return;
  }

  // Expand advanced section
  const advancedToggle = document.getElementById("advanced-toggle");
  const advancedContent = document.getElementById("advanced-content");
  if (advancedToggle && advancedContent) {
    advancedToggle.setAttribute("aria-expanded", "true");
    advancedContent.style.display = "flex";
    advancedContent.classList.add("is-expanded");
    // Resize map
    if (map) {
      setTimeout(() => map.resize(), 100);
    }
  }

  // Switch to edit mode UI
  document.getElementById("fillup-id").value = fillup._id;
  document.getElementById("submit-btn-text").textContent = "Update Fill-up";
  document.getElementById("cancel-edit-btn").style.display = "block";
  document.getElementById("form-badge").style.display = "inline-flex";

  // Populate form
  document.getElementById("vehicle-select").value = fillup.imei;

  // Format date for datetime-local input
  const dateObj = new Date(fillup.fillup_time);
  const offset = dateObj.getTimezoneOffset();
  const localTime = new Date(dateObj.getTime() - offset * 60 * 1000);
  document.getElementById("fillup-time").value = localTime.toISOString().slice(0, 16);

  document.getElementById("gallons").value = fillup.gallons;
  document.getElementById("price-per-gallon").value = fillup.price_per_gallon || "";
  document.getElementById("total-cost").value = fillup.total_cost || "";

  // Odometer handling
  const odoInput = document.getElementById("odometer");
  const odoCheck = document.getElementById("odometer-not-recorded");

  if (fillup.odometer === null || fillup.odometer === undefined) {
    odoCheck.checked = true;
    odoInput.value = "";
    odoInput.disabled = true;
    odoInput.placeholder = "Not recorded";
  } else {
    odoCheck.checked = false;
    odoInput.value = fillup.odometer;
    odoInput.disabled = false;
    odoInput.placeholder = "Miles";
  }

  document.getElementById("full-tank").checked = fillup.is_full_tank !== false;
  document.getElementById("missed-previous").checked = fillup.missed_previous === true;
  document.getElementById("notes").value = fillup.notes || "";

  // Set location state
  currentLocation = {
    latitude: fillup.latitude,
    longitude: fillup.longitude,
    odometer: fillup.odometer,
  };

  // Update map marker
  if (fillup.latitude && fillup.longitude) {
    updateMap(fillup.latitude, fillup.longitude);
    document.getElementById("location-text").textContent = "Location from record";
    document.getElementById("odometer-display").textContent = fillup.odometer
      ? `${Math.round(fillup.odometer).toLocaleString()} mi`
      : "Not recorded";
  }

  // Scroll to form
  document
    .querySelector(".form-section")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Delete a fill-up
 */
async function deleteFillup(id) {
  const confirmed = await confirmationDialog.show({
    title: "Delete Fill-up",
    message: "Are you sure you want to delete this fill-up record?",
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    return;
  }

  try {
    const response = await apiRaw(`/api/gas-fillups/${id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to delete fill-up");
    }

    showSuccess("Fill-up deleted successfully");

    // If we were editing this one, reset the form
    if (document.getElementById("fillup-id").value === id) {
      resetFormState();
    }

    await Promise.all([loadRecentFillups(), loadStatistics()]);
  } catch {
    showError("Failed to delete fill-up");
  }
}

/**
 * Load statistics
 */
async function loadStatistics() {
  const vehicleSelect = document.getElementById("vehicle-select");

  try {
    let url = "/api/gas-statistics";
    if (vehicleSelect.value) {
      url += `?imei=${encodeURIComponent(vehicleSelect.value)}`;
    }

    const response = await apiRaw(url);
    if (!response.ok) {
      throw new Error("Failed to load statistics");
    }

    const stats = await response.json();

    // Update stats display
    document.getElementById("total-fillups").textContent = stats.total_fillups || 0;
    document.getElementById("total-spent").textContent
      = `$${(stats.total_cost || 0).toFixed(0)}`;
    document.getElementById("avg-mpg").textContent = stats.average_mpg
      ? stats.average_mpg.toFixed(1)
      : "--";
  } catch {
    // Error loading statistics - silently ignore
  }
}
