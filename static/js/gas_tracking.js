/**
 * Gas Tracking Module
 * Handles gas fill-up recording, MPG calculation, and statistics
 */

// State
let map = null;
let marker = null;
let currentLocation = null;
let vehicles = [];
let _selectedVehicle = null;

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", async () => {
  await initializePage();
});

/**
 * Initialize the page
 */
async function initializePage() {
  try {
    // Initialize map
    await initializeMap();

    // Load vehicles
    await loadVehicles();

    // Load statistics
    await loadStatistics();

    // Load recent fill-ups
    await loadRecentFillups();

    // Set up event listeners
    setupEventListeners();

    // Set current time as default
    setCurrentTime();
  } catch (error) {
    console.error("Error initializing gas tracking page:", error);
    showError("Failed to initialize page");
  }
}

/**
 * Initialize Mapbox map
 */
async function initializeMap() {
  if (!window.MAPBOX_ACCESS_TOKEN) {
    console.error("Mapbox access token not found");
    return;
  }

  mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

  map = new mapboxgl.Map({
    container: "fillup-map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-95.7129, 37.0902], // Default: US center
    zoom: 4,
  });

  // Add navigation controls
  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  // Wait for map to load
  await new Promise((resolve) => map.on("load", resolve));
}

/**
 * Load vehicles from API
 */
async function loadVehicles() {
  try {
    // First sync vehicles from trips to ensure they exist
    try {
      const syncResponse = await fetch("/api/vehicles/sync-from-trips", {
        method: "POST",
      });
      if (syncResponse.ok) {
        const syncResult = await syncResponse.json();
        console.log("Vehicle sync result:", syncResult);
      }
    } catch (syncError) {
      console.warn("Failed to sync vehicles:", syncError);
    }

    const response = await fetch("/api/vehicles?active_only=true");
    if (!response.ok) throw new Error("Failed to load vehicles");

    vehicles = await response.json();
    console.log(`Loaded ${vehicles.length} vehicles:`, vehicles);

    const vehicleSelect = document.getElementById("vehicle-select");
    vehicleSelect.innerHTML = '<option value="">Select Vehicle...</option>';

    if (vehicles.length === 0) {
      vehicleSelect.innerHTML =
        '<option value="">No vehicles found - check profile settings</option>';
      return;
    }

    vehicles.forEach((vehicle) => {
      const option = document.createElement("option");
      option.value = vehicle.imei;
      const displayName =
        vehicle.custom_name ||
        (vehicle.vin ? `VIN: ${vehicle.vin}` : `IMEI: ${vehicle.imei}`);
      option.textContent = displayName;
      option.dataset.vin = vehicle.vin || "";
      vehicleSelect.appendChild(option);
    });

    // If only one vehicle, auto-select it
    if (vehicles.length === 1) {
      vehicleSelect.value = vehicles[0].imei;
      _selectedVehicle = vehicles[0];
      await updateLocationAndOdometer();
    }
  } catch (error) {
    console.error("Error loading vehicles:", error);
    showError("Failed to load vehicles");
  }
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
    locationText.textContent = "Please select a vehicle";
    odometerDisplay.textContent = "--";
    return;
  }

  try {
    locationText.textContent = "Loading location...";
    odometerDisplay.textContent = "Loading...";

    // Determine if we should use "now" or a specific timestamp
    const useNow = !fillupTime || isNearCurrentTime(fillupTime);

    let url = `/api/vehicle-location?imei=${encodeURIComponent(vehicleSelect.value)}`;
    if (useNow) {
      url += "&use_now=true";
    } else {
      url += `&timestamp=${encodeURIComponent(new Date(fillupTime).toISOString())}`;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch location");

    const data = await response.json();
    currentLocation = data;

    // Update map
    if (data.latitude && data.longitude) {
      updateMap(data.latitude, data.longitude);
      locationText.textContent =
        data.address ||
        `${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}`;
    } else {
      locationText.textContent = "Location not available";
    }

    // Update odometer
    if (data.odometer) {
      odometerDisplay.textContent = Math.round(data.odometer);
      odometerInput.value = Math.round(data.odometer);
    } else {
      odometerDisplay.textContent = "Not available";
    }
  } catch (error) {
    console.error("Error fetching location:", error);
    locationText.textContent = "Error loading location";
    odometerDisplay.textContent = "--";
  }
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
  if (!map) return;

  // Remove existing marker
  if (marker) {
    marker.remove();
  }

  // Add new marker
  marker = new mapboxgl.Marker({ color: "#10b981" })
    .setLngLat([lon, lat])
    .addTo(map);

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
  const pricePerGallon =
    parseFloat(document.getElementById("price-per-gallon").value) || 0;
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
function setupEventListeners() {
  // Vehicle selection change
  document
    .getElementById("vehicle-select")
    .addEventListener("change", async (e) => {
      _selectedVehicle = vehicles.find((v) => v.imei === e.target.value);
      await updateLocationAndOdometer();
      await loadRecentFillups();
      await loadStatistics();
    });

  // Fill-up time change
  document
    .getElementById("fillup-time")
    .addEventListener("change", updateLocationAndOdometer);

  // Use Now button
  document.getElementById("use-now-btn").addEventListener("click", () => {
    setCurrentTime();
    updateLocationAndOdometer();
  });

  // Calculate total cost when price or gallons change
  document
    .getElementById("gallons")
    .addEventListener("input", calculateTotalCost);
  document
    .getElementById("price-per-gallon")
    .addEventListener("input", calculateTotalCost);

  // Form submission
  document
    .getElementById("gas-fillup-form")
    .addEventListener("submit", handleFormSubmit);
}

/**
 * Handle form submission
 */
async function handleFormSubmit(e) {
  e.preventDefault();

  const submitButton = document.querySelector(".btn-save");
  const spinner = document.querySelector(".loading-spinner");

  try {
    // Show loading state
    submitButton.disabled = true;
    spinner.classList.add("active");

    // Gather form data
    const formData = {
      imei: document.getElementById("vehicle-select").value,
      fillup_time: new Date(
        document.getElementById("fillup-time").value,
      ).toISOString(),
      gallons: parseFloat(document.getElementById("gallons").value),
      price_per_gallon:
        parseFloat(document.getElementById("price-per-gallon").value) || null,
      total_cost:
        parseFloat(document.getElementById("total-cost").value) || null,
      odometer: parseFloat(document.getElementById("odometer").value) || null,
      latitude: currentLocation?.latitude || null,
      longitude: currentLocation?.longitude || null,
      is_full_tank: document.getElementById("full-tank").checked,
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
    const response = await fetch("/api/gas-fillups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(formData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Failed to save fill-up");
    }

    const result = await response.json();

    // Show success message
    showSuccess("Fill-up recorded successfully!");

    // Show calculated MPG if available
    if (result.calculated_mpg) {
      const mpgDisplay = document.getElementById("calculated-mpg");
      const mpgValue = document.getElementById("mpg-value");
      mpgValue.textContent = result.calculated_mpg.toFixed(2);
      mpgDisplay.style.display = "block";

      setTimeout(() => {
        mpgDisplay.style.display = "none";
      }, 5000);
    }

    // Reset form (except vehicle selection)
    document.getElementById("gas-fillup-form").reset();
    document.getElementById("vehicle-select").value = formData.imei;
    setCurrentTime();

    // Reload data
    await Promise.all([loadRecentFillups(), loadStatistics()]);
  } catch (error) {
    console.error("Error submitting fill-up:", error);
    showError(error.message || "Failed to save fill-up");
  } finally {
    submitButton.disabled = false;
    spinner.classList.remove("active");
  }
}

/**
 * Load recent fill-ups
 */
async function loadRecentFillups() {
  const vehicleSelect = document.getElementById("vehicle-select");
  const fillupList = document.getElementById("fillup-list");

  try {
    let url = "/api/gas-fillups?limit=10";
    if (vehicleSelect.value) {
      url += `&imei=${encodeURIComponent(vehicleSelect.value)}`;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to load fill-ups");

    const fillups = await response.json();

    if (fillups.length === 0) {
      fillupList.innerHTML =
        '<p class="text-center text-muted">No fill-ups recorded yet</p>';
      return;
    }

    fillupList.innerHTML = fillups
      .map((fillup) => createFillupItem(fillup))
      .join("");
  } catch (error) {
    console.error("Error loading fill-ups:", error);
    fillupList.innerHTML =
      '<p class="text-center text-danger">Error loading fill-ups</p>';
  }
}

/**
 * Create HTML for a fill-up item
 */
function createFillupItem(fillup) {
  const date = new Date(fillup.fillup_time).toLocaleString();
  const cost = fillup.total_cost ? `$${fillup.total_cost.toFixed(2)}` : "--";
  const mpg = fillup.calculated_mpg ? fillup.calculated_mpg.toFixed(2) : "--";
  const pricePerGallon = fillup.price_per_gallon
    ? `$${fillup.price_per_gallon.toFixed(2)}`
    : "--";

  return `
        <div class="fillup-item">
            <div class="fillup-header">
                <span class="fillup-date">${date}</span>
                <span class="badge bg-primary">${fillup.gallons.toFixed(2)} gal</span>
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
                    <span class="fillup-detail-value">${fillup.odometer ? `${Math.round(fillup.odometer)} mi` : "--"}</span>
                </div>
            </div>
            ${fillup.notes ? `<div class="mt-2"><small class="text-muted">${fillup.notes}</small></div>` : ""}
        </div>
    `;
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

    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to load statistics");

    const stats = await response.json();

    // Update stats display
    document.getElementById("total-fillups").textContent =
      stats.total_fillups || 0;
    document.getElementById("total-spent").textContent =
      `$${(stats.total_cost || 0).toFixed(2)}`;
    document.getElementById("avg-mpg").textContent = stats.average_mpg
      ? stats.average_mpg.toFixed(1)
      : "--";
    document.getElementById("cost-per-mile").textContent = stats.cost_per_mile
      ? `$${stats.cost_per_mile.toFixed(3)}`
      : "$0.00";
  } catch (error) {
    console.error("Error loading statistics:", error);
  }
}

/**
 * Show success message
 */
function showSuccess(message) {
  // Create a Bootstrap toast or alert
  const alert = document.createElement("div");
  alert.className =
    "alert alert-success alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3";
  alert.style.zIndex = "9999";
  alert.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
  document.body.appendChild(alert);

  setTimeout(() => {
    alert.remove();
  }, 5000);
}

/**
 * Show error message
 */
function showError(message) {
  const alert = document.createElement("div");
  alert.className =
    "alert alert-danger alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3";
  alert.style.zIndex = "9999";
  alert.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
  document.body.appendChild(alert);

  setTimeout(() => {
    alert.remove();
  }, 5000);
}
