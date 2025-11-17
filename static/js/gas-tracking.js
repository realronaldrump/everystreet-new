/* global $, DateUtils, handleError */

/**
 * Gas Tracking Manager
 * Handles gas fill-up tracking, MPG calculations, and fuel cost analysis
 */

// Wait for all required dependencies to load
function waitForDependencies() {
  return new Promise((resolve) => {
    const checkDependencies = () => {
      if (
        typeof $ !== "undefined" &&
        $.fn.DataTable &&
        typeof DateUtils !== "undefined" &&
        typeof window.utils !== "undefined"
      ) {
        resolve();
      } else {
        setTimeout(checkDependencies, 50);
      }
    };
    checkDependencies();
  });
}

class GasTrackingManager {
  constructor() {
    this.fillupsTable = null;
    this.currentVehicle = null;
    this.vehicles = [];
    this.fillups = [];
    this.statistics = null;
    this.isInitialized = false;
    this.isMobile = window.innerWidth <= 768;
    this.map = null;
    this.locationMarker = null;

    // Listen for window resize
    window.addEventListener("resize", () => {
      const wasMobile = this.isMobile;
      this.isMobile = window.innerWidth <= 768;
      if (wasMobile !== this.isMobile) {
        this.renderFillups();
      }
    });
  }

  async init() {
    if (this.isInitialized) return;

    try {
      await waitForDependencies();

      await this.loadVehicles();
      this.initializeMap();
      this.initializeForm();
      this.initializeTable();
      this.initializeEventListeners();
      this.isInitialized = true;

      // Load initial data if a vehicle is selected
      if (this.currentVehicle) {
        await this.loadFillups();
        await this.loadStatistics();
      }
    } catch (error) {
      console.error("Error initializing GasTrackingManager:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error initializing gas tracking", "error");
      }
    }
  }

  async loadVehicles() {
    try {
      // Sync vehicles from trips first
      await fetch("/api/vehicles/sync-from-trips", { method: "POST" });

      // Get vehicles from API
      const response = await fetch("/api/vehicles?active_only=true");
      if (!response.ok) throw new Error("Failed to load vehicles");

      this.vehicles = await response.json();

      // Populate vehicle select
      const vehicleSelect = document.getElementById("vehicle-select");
      if (vehicleSelect) {
        vehicleSelect.innerHTML = "";

        if (this.vehicles.length === 0) {
          vehicleSelect.innerHTML =
            '<option value="">No vehicles found</option>';
        } else {
          vehicleSelect.innerHTML =
            '<option value="">Select a vehicle...</option>';
          this.vehicles.forEach((vehicle) => {
            const option = document.createElement("option");
            option.value = vehicle.imei;
            option.textContent = vehicle.custom_name;
            option.dataset.vin = vehicle.vin || "";
            vehicleSelect.appendChild(option);
          });

          // Auto-select first vehicle
          if (this.vehicles.length > 0) {
            vehicleSelect.value = this.vehicles[0].imei;
            this.currentVehicle = this.vehicles[0].imei;
          }
        }
      }
    } catch (error) {
      console.error("Error loading vehicles:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error loading vehicles", "error");
      }
    }
  }

  initializeMap() {
    if (!window.MAPBOX_ACCESS_TOKEN || typeof mapboxgl === "undefined") {
      console.warn("Mapbox not available");
      return;
    }

    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

    const mapContainer = document.getElementById("fillup-map");
    if (mapContainer) {
      this.map = new mapboxgl.Map({
        container: "fillup-map",
        style: "mapbox://styles/mapbox/streets-v12",
        center: [-98.5795, 39.8283], // Center of US
        zoom: 3,
      });

      this.map.addControl(new mapboxgl.NavigationControl(), "top-right");
    }
  }

  initializeForm() {
    const form = document.getElementById("fillup-form");
    if (!form) return;

    // Set default fillup time to now
    const fillupTimeInput = document.getElementById("fillup-time");
    if (fillupTimeInput) {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      fillupTimeInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;

      // Add event listener for time changes to detect location
      fillupTimeInput.addEventListener("change", async () => {
        await this.detectLocationAtTime();
      });
    }

    // Calculate total cost on input change
    const priceInput = document.getElementById("price-per-gallon");
    const gallonsInput = document.getElementById("gallons");

    const updateTotal = () => {
      const price = parseFloat(priceInput.value) || 0;
      const gallons = parseFloat(gallonsInput.value) || 0;
      const total = price * gallons;

      const totalDisplay = document.getElementById("calculated-total");
      if (totalDisplay) {
        totalDisplay.textContent = `$${total.toFixed(2)}`;
      }
    };

    if (priceInput) priceInput.addEventListener("input", updateTotal);
    if (gallonsInput) gallonsInput.addEventListener("input", updateTotal);

    // Form submission
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.submitFillup();
    });

    // Load latest odometer reading when vehicle changes
    const vehicleSelect = document.getElementById("vehicle-select");
    if (vehicleSelect) {
      vehicleSelect.addEventListener("change", async (e) => {
        this.currentVehicle = e.target.value;
        if (this.currentVehicle) {
          await this.loadLatestOdometer();
          await this.loadFillups();
          await this.loadStatistics();
        }
      });

      // Load initial odometer
      if (this.currentVehicle) {
        this.loadLatestOdometer();
      }
    }
  }

  async loadLatestOdometer() {
    if (!this.currentVehicle) return;

    try {
      const response = await fetch(
        `/api/latest-odometer/${this.currentVehicle}`,
      );
      if (!response.ok) throw new Error("Failed to load odometer");

      const data = await response.json();
      const odometerInput = document.getElementById("odometer");
      const odometerHint = document.getElementById("odometer-hint");

      if (data.odometer && odometerInput) {
        odometerInput.value = data.odometer;
        if (odometerHint) {
          odometerHint.textContent = `Latest: ${data.odometer.toFixed(1)} mi`;
        }
      }
    } catch (error) {
      console.error("Error loading odometer:", error);
    }
  }

  async detectLocationAtTime() {
    if (!this.currentVehicle) {
      return;
    }

    const fillupTimeInput = document.getElementById("fillup-time");
    const odometerInput = document.getElementById("odometer");
    const locationTextInput = document.getElementById("location-text");
    const locationStatus = document.getElementById("location-status");

    if (!fillupTimeInput || !fillupTimeInput.value) {
      return;
    }

    // Show loading state
    if (locationTextInput) {
      locationTextInput.value = "Detecting location...";
    }
    if (locationStatus) {
      locationStatus.textContent = "Searching for vehicle location...";
      locationStatus.className = "text-muted";
    }

    try {
      // Convert datetime-local value to ISO format
      const timestamp = new Date(fillupTimeInput.value).toISOString();

      const response = await fetch(
        `/api/vehicle-location-at-time?imei=${encodeURIComponent(
          this.currentVehicle,
        )}&timestamp=${encodeURIComponent(timestamp)}`,
      );

      if (!response.ok) {
        throw new Error("Failed to detect location");
      }

      const data = await response.json();

      // Update odometer
      if (data.odometer && odometerInput) {
        odometerInput.value = data.odometer.toFixed(1);
      }

      // Update location text
      if (locationTextInput) {
        locationTextInput.value =
          data.location?.formatted_address ||
          data.location?.display_name ||
          `${data.coordinates[1].toFixed(6)}, ${data.coordinates[0].toFixed(6)}`;
      }

      // Update location status
      if (locationStatus) {
        locationStatus.textContent = data.source
          ? `Location detected from ${data.source}`
          : "Location detected";
        locationStatus.className = "text-success";
      }

      // Update map
      this.updateMapLocation(data.coordinates, data.location);
    } catch (error) {
      console.error("Error detecting location:", error);

      // Show error state
      if (locationTextInput) {
        locationTextInput.value = "Location not available";
      }
      if (locationStatus) {
        locationStatus.textContent =
          "Could not find vehicle location at this time";
        locationStatus.className = "text-warning";
      }
    }
  }

  updateMapLocation(coordinates, location) {
    if (!this.map || !coordinates || coordinates.length !== 2) {
      return;
    }

    const [lng, lat] = coordinates;

    // Remove existing marker
    if (this.locationMarker) {
      this.locationMarker.remove();
    }

    // Add new marker
    this.locationMarker = new mapboxgl.Marker({ color: "#1a73e8" })
      .setLngLat([lng, lat])
      .addTo(this.map);

    // Add popup if we have location details
    if (location) {
      const popupContent =
        location.formatted_address ||
        location.display_name ||
        "Fill-up location";
      this.locationMarker.setPopup(
        new mapboxgl.Popup({ offset: 25 }).setHTML(
          `<div style="padding: 8px;"><strong>${popupContent}</strong></div>`,
        ),
      );
    }

    // Center and zoom to location
    this.map.flyTo({
      center: [lng, lat],
      zoom: 15,
      duration: 1500,
    });
  }

  async submitFillup() {
    const submitBtn = document.getElementById("submit-fillup-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-2"></i>Saving...';
    }

    try {
      // Get location data if available
      let locationData = null;
      if (this.locationMarker) {
        const lngLat = this.locationMarker.getLngLat();
        const locationText = document.getElementById("location-text");
        locationData = {
          type: "Point",
          coordinates: [lngLat.lng, lngLat.lat],
          formatted_address: locationText ? locationText.value : null,
        };
      }

      const formData = {
        imei: document.getElementById("vehicle-select").value,
        fillup_time: document.getElementById("fillup-time").value,
        price_per_gallon: parseFloat(
          document.getElementById("price-per-gallon").value,
        ),
        gallons: parseFloat(document.getElementById("gallons").value),
        odometer: parseFloat(document.getElementById("odometer").value),
        is_full_tank: document.getElementById("is-full-tank").checked,
        location: locationData,
      };

      const response = await fetch("/api/gas-fillups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to save fill-up");
      }

      // Success!
      if (typeof handleError === "function") {
        handleError(null, "Fill-up saved successfully!", "success");
      }

      // Reset form
      document.getElementById("fillup-form").reset();
      document.getElementById("fillup-time").value = new Date()
        .toISOString()
        .slice(0, 16);

      // Clear location data
      const locationTextInput = document.getElementById("location-text");
      const locationStatus = document.getElementById("location-status");
      if (locationTextInput) {
        locationTextInput.value = "";
        locationTextInput.placeholder =
          "Select fill-up time to detect location...";
      }
      if (locationStatus) {
        locationStatus.textContent = "";
      }

      // Remove map marker
      if (this.locationMarker) {
        this.locationMarker.remove();
        this.locationMarker = null;
      }

      // Reset map view
      if (this.map) {
        this.map.flyTo({
          center: [-98.5795, 39.8283],
          zoom: 3,
          duration: 1000,
        });
      }

      // Reload data
      await this.loadFillups();
      await this.loadStatistics();
      await this.loadLatestOdometer();
    } catch (error) {
      console.error("Error saving fill-up:", error);
      if (typeof handleError === "function") {
        handleError(error, error.message, "error");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-save me-2"></i>Save Fill-Up';
      }
    }
  }

  async loadFillups() {
    if (!this.currentVehicle) {
      this.fillups = [];
      this.renderFillups();
      return;
    }

    try {
      const response = await fetch(
        `/api/gas-fillups?imei=${this.currentVehicle}&limit=100`,
      );
      if (!response.ok) throw new Error("Failed to load fill-ups");

      this.fillups = await response.json();
      this.renderFillups();
    } catch (error) {
      console.error("Error loading fill-ups:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error loading fill-ups", "error");
      }
    }
  }

  async loadStatistics() {
    if (!this.currentVehicle) {
      this.updateStatisticsDisplay(null);
      return;
    }

    try {
      const response = await fetch(
        `/api/gas-statistics?imei=${this.currentVehicle}`,
      );
      if (!response.ok) throw new Error("Failed to load statistics");

      this.statistics = await response.json();
      this.updateStatisticsDisplay(this.statistics);
    } catch (error) {
      console.error("Error loading statistics:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error loading statistics", "error");
      }
    }
  }

  updateStatisticsDisplay(stats) {
    const elements = {
      "stat-total-fillups": stats ? stats.total_fillups : "--",
      "stat-total-cost": stats ? `$${stats.total_cost.toFixed(2)}` : "--",
      "stat-avg-mpg": stats?.average_mpg ? `${stats.average_mpg} mpg` : "--",
      "stat-current-price": stats?.average_price_per_gallon
        ? `$${stats.average_price_per_gallon.toFixed(3)}/gal`
        : "--",
    };

    Object.entries(elements).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
      }
    });
  }

  initializeTable() {
    const tableElement = $("#fillups-table");
    if (!tableElement.length) return;

    this.fillupsTable = tableElement.DataTable({
      data: [],
      order: [[0, "desc"]],
      pageLength: 25,
      columns: [
        {
          data: "fillup_time",
          title: "Date",
          render: (data) => {
            if (!data) return "";
            const date = DateUtils.parseDate(data);
            return date
              ? DateUtils.formatDateTime(date, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "";
          },
        },
        {
          data: "location",
          title: "Location",
          render: (data) => {
            if (!data) return '<span class="text-muted">Auto-detected</span>';
            return (
              data.formatted_address ||
              data.display_name ||
              '<span class="text-muted">Unknown</span>'
            );
          },
        },
        {
          data: "gallons",
          title: "Gallons",
          render: (data) => (data ? data.toFixed(2) : "--"),
        },
        {
          data: "price_per_gallon",
          title: "Price/Gal",
          render: (data) => (data ? `$${data.toFixed(3)}` : "--"),
        },
        {
          data: "total_cost",
          title: "Total Cost",
          render: (data) => (data ? `$${data.toFixed(2)}` : "--"),
        },
        {
          data: "odometer",
          title: "Odometer",
          render: (data) => (data ? data.toFixed(1) : "--"),
        },
        {
          data: "calculated_mpg",
          title: "MPG",
          render: (data) => {
            if (!data) return '<span class="text-muted">--</span>';
            const mpg = parseFloat(data);
            let badgeClass = "average";
            if (mpg >= 30) badgeClass = "good";
            else if (mpg < 20) badgeClass = "poor";
            return `<span class="mpg-badge ${badgeClass}">${mpg.toFixed(1)} mpg</span>`;
          },
        },
        {
          data: "trip_since_last_fillup",
          title: "Distance",
          render: (data) => {
            if (!data || !data.distance_traveled) {
              return '<span class="text-muted">--</span>';
            }
            return `${data.distance_traveled.toFixed(1)} mi`;
          },
        },
        {
          data: null,
          title: "Actions",
          orderable: false,
          render: (_data, _type, row) => `
              <div class="action-buttons">
                <button class="btn btn-sm btn-outline-secondary edit-fillup-btn" data-id="${row._id}">
                  <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-danger delete-fillup-btn" data-id="${row._id}">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            `,
        },
      ],
      language: {
        emptyTable: "No fill-ups recorded yet",
        zeroRecords: "No fill-ups found",
      },
    });

    // Add click handlers for edit and delete buttons
    tableElement.on("click", ".edit-fillup-btn", (e) => {
      const id = $(e.currentTarget).data("id");
      this.editFillup(id);
    });

    tableElement.on("click", ".delete-fillup-btn", (e) => {
      const id = $(e.currentTarget).data("id");
      this.deleteFillup(id);
    });
  }

  renderFillups() {
    if (this.isMobile) {
      this.renderMobileFillups();
    } else {
      this.renderDesktopFillups();
    }
  }

  renderDesktopFillups() {
    if (this.fillupsTable) {
      this.fillupsTable.clear();
      this.fillupsTable.rows.add(this.fillups);
      this.fillupsTable.draw();
    }
  }

  renderMobileFillups() {
    const container = document.getElementById("mobile-fillups-list");
    if (!container) return;

    container.innerHTML = "";

    if (this.fillups.length === 0) {
      container.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="fas fa-gas-pump fa-3x mb-3"></i>
          <p>No fill-ups recorded yet</p>
        </div>
      `;
      return;
    }

    this.fillups.forEach((fillup) => {
      const card = this.createMobileFillupCard(fillup);
      container.appendChild(card);
    });
  }

  createMobileFillupCard(fillup) {
    const card = document.createElement("div");
    card.className = "mobile-fillup-card";

    const date = DateUtils.parseDate(fillup.fillup_time);
    const dateStr = date
      ? DateUtils.formatDateTime(date, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Unknown";

    const location =
      fillup.location?.formatted_address ||
      fillup.location?.display_name ||
      "Auto-detected";

    const mpgBadge = fillup.calculated_mpg
      ? `<span class="mpg-badge ${
          fillup.calculated_mpg >= 30
            ? "good"
            : fillup.calculated_mpg < 20
              ? "poor"
              : "average"
        }">${fillup.calculated_mpg.toFixed(1)} mpg</span>`
      : "";

    card.innerHTML = `
      <div class="mobile-fillup-header">
        <div>
          <div class="mobile-fillup-date">${dateStr}</div>
          <div class="mobile-fillup-location">
            <i class="fas fa-map-marker-alt me-1"></i>${location}
          </div>
        </div>
        <div class="mobile-fillup-cost">$${fillup.total_cost.toFixed(2)}</div>
      </div>

      <div class="mobile-fillup-details">
        <div class="mobile-fillup-detail">
          <div class="mobile-fillup-detail-label">Gallons</div>
          <div class="mobile-fillup-detail-value">${fillup.gallons.toFixed(2)}</div>
        </div>
        <div class="mobile-fillup-detail">
          <div class="mobile-fillup-detail-label">Price/Gal</div>
          <div class="mobile-fillup-detail-value">$${fillup.price_per_gallon.toFixed(3)}</div>
        </div>
        <div class="mobile-fillup-detail">
          <div class="mobile-fillup-detail-label">Odometer</div>
          <div class="mobile-fillup-detail-value">${fillup.odometer.toFixed(1)} mi</div>
        </div>
        <div class="mobile-fillup-detail">
          <div class="mobile-fillup-detail-label">MPG</div>
          <div class="mobile-fillup-detail-value">${mpgBadge || "--"}</div>
        </div>
      </div>

      <div class="mobile-fillup-actions">
        <button class="btn btn-sm btn-outline-secondary" onclick="gasTrackingManager.editFillup('${fillup._id}')">
          <i class="fas fa-edit me-1"></i>Edit
        </button>
        <button class="btn btn-sm btn-danger" onclick="gasTrackingManager.deleteFillup('${fillup._id}')">
          <i class="fas fa-trash me-1"></i>Delete
        </button>
      </div>
    `;

    return card;
  }

  async editFillup(id) {
    // Find the fillup
    const fillup = this.fillups.find((f) => f._id === id);
    if (!fillup) return;

    // Populate modal form
    document.getElementById("edit-fillup-id").value = fillup._id;
    document.getElementById("edit-price-per-gallon").value =
      fillup.price_per_gallon;
    document.getElementById("edit-gallons").value = fillup.gallons;
    document.getElementById("edit-odometer").value = fillup.odometer;

    // Show modal
    const modal = new bootstrap.Modal(
      document.getElementById("edit-fillup-modal"),
    );
    modal.show();
  }

  async deleteFillup(id) {
    const confirmDelete = confirm(
      "Are you sure you want to delete this fill-up record?",
    );
    if (!confirmDelete) return;

    try {
      const response = await fetch(`/api/gas-fillups/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete fill-up");
      }

      if (typeof handleError === "function") {
        handleError(null, "Fill-up deleted successfully", "success");
      }

      // Reload data
      await this.loadFillups();
      await this.loadStatistics();
    } catch (error) {
      console.error("Error deleting fill-up:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error deleting fill-up", "error");
      }
    }
  }

  initializeEventListeners() {
    // Toggle form collapse
    const toggleBtn = document.getElementById("toggle-form-btn");
    const formContainer = document.getElementById("fillup-form-container");

    if (toggleBtn && formContainer) {
      toggleBtn.addEventListener("click", () => {
        formContainer.classList.toggle("collapsed");
        const icon = toggleBtn.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-down");
          icon.classList.toggle("fa-chevron-up");
        }
      });
    }

    // Save edit modal
    const saveEditBtn = document.getElementById("save-edit-fillup-btn");
    if (saveEditBtn) {
      saveEditBtn.addEventListener("click", async () => {
        await this.saveEditedFillup();
      });
    }
  }

  async saveEditedFillup() {
    const id = document.getElementById("edit-fillup-id").value;
    const fillup = this.fillups.find((f) => f._id === id);
    if (!fillup) return;

    const saveBtn = document.getElementById("save-edit-fillup-btn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-2"></i>Saving...';
    }

    try {
      const formData = {
        imei: fillup.imei,
        fillup_time: fillup.fillup_time,
        price_per_gallon: parseFloat(
          document.getElementById("edit-price-per-gallon").value,
        ),
        gallons: parseFloat(document.getElementById("edit-gallons").value),
        odometer: parseFloat(document.getElementById("edit-odometer").value),
        is_full_tank: fillup.is_full_tank,
        location: fillup.location,
      };

      const response = await fetch(`/api/gas-fillups/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to update fill-up");
      }

      if (typeof handleError === "function") {
        handleError(null, "Fill-up updated successfully!", "success");
      }

      // Close modal
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("edit-fillup-modal"),
      );
      if (modal) modal.hide();

      // Reload data
      await this.loadFillups();
      await this.loadStatistics();
    } catch (error) {
      console.error("Error updating fill-up:", error);
      if (typeof handleError === "function") {
        handleError(error, error.message, "error");
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save me-2"></i>Save Changes';
      }
    }
  }
}

// Initialize when DOM is ready
let gasTrackingManager;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", async () => {
    gasTrackingManager = new GasTrackingManager();
    await gasTrackingManager.init();
  });
} else {
  gasTrackingManager = new GasTrackingManager();
  gasTrackingManager.init();
}
