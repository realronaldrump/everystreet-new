/* global bootstrap, notificationManager, confirmationDialog */
"use strict";

(() => {
  class CoverageManager {
    constructor() {
      this.validatedLocation = null;
      this.taskProgressModal = new bootstrap.Modal(
        document.getElementById("taskProgressModal"),
      );
      this.activeTaskIds = new Set();
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.locationData = null;
      this.map = null;
      this.coverageMap = null;
      this.streetLayers = null;
      this.selectedLocation = null;
      this.setupEventListeners();
      this.loadCoverageAreas();
      this.setupAutoRefresh(); // Set up auto-refresh if any area is still processing
    }

    setupEventListeners() {
      document
        .getElementById("validate-location")
        .addEventListener("click", () => {
          this.validateLocation();
        });

      document
        .getElementById("add-coverage-area")
        .addEventListener("click", () => {
          this.addCoverageArea();
        });

      document
        .getElementById("cancel-processing")
        .addEventListener("click", () => {
          this.cancelProcessing(this.currentProcessingLocation);
        });

      // Disable "Add Area" button when location input changes
      document
        .getElementById("location-input")
        .addEventListener("input", () => {
          document.getElementById("add-coverage-area").disabled = true;
          this.validatedLocation = null;
        });

      // Refresh coverage areas when the modal is closed
      document
        .getElementById("taskProgressModal")
        .addEventListener("hidden.bs.modal", () => {
          this.loadCoverageAreas();
        });

      // Button event listeners using event delegation for dynamically added elements
      document
        .querySelector("#coverage-areas-table")
        .addEventListener("click", (e) => {
          const target = e.target.closest("button");
          if (!target) return;

          // Extract location from data attribute
          let location;
          try {
            location = JSON.parse(target.dataset.location);
          } catch (err) {
            console.error("Error parsing location data:", err);
            return;
          }

          // Update coverage button
          if (target.classList.contains("update-coverage-btn")) {
            e.preventDefault();
            this.updateCoverageForArea(location);
          }
          // Delete area button
          else if (target.classList.contains("delete-area-btn")) {
            e.preventDefault();
            this.deleteArea(location);
          }
          // View on map button
          else if (target.classList.contains("view-area-btn")) {
            e.preventDefault();
            CoverageManager.viewAreaOnMap(location);
          }
          // Cancel processing button (if it exists)
          else if (target.classList.contains("cancel-processing")) {
            e.preventDefault();
            this.cancelProcessing(location);
          }
        });

      // Add click handler for location names in the table
      document.addEventListener("click", (e) => {
        const locationLink = e.target.closest(".location-name-link");
        if (locationLink) {
          e.preventDefault();
          const locationId = locationLink.dataset.locationId;
          this.displayCoverageDashboard(locationId);
        }
      });

      // Dashboard event delegation for the coverage map area
      document.addEventListener("click", (e) => {
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          try {
            const location = JSON.parse(updateMissingDataBtn.dataset.location);
            this.updateCoverageForArea(location);
          } catch (err) {
            console.error("Error parsing location data:", err);
          }
        }
      });

      // Export coverage map button
      document
        .getElementById("export-coverage-map")
        .addEventListener("click", () => {
          if (this.coverageMap) {
            this.exportCoverageMap();
          }
        });

      // Map filter buttons
      document
        .getElementById("show-all-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("all");
          this.toggleFilterButtonState(e.target);
        });

      document
        .getElementById("show-driven-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("driven");
          this.toggleFilterButtonState(e.target);
        });

      document
        .getElementById("show-undriven-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("undriven");
          this.toggleFilterButtonState(e.target);
        });
    }

    async validateLocation() {
      const locInput = document.getElementById("location-input");
      const locType = document.getElementById("location-type");
      if (!locInput?.value || !locType?.value) {
        notificationManager.show(
          "Please enter a location and select a location type.",
          "danger",
        );
        return;
      }

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: locInput.value,
            locationType: locType.value,
          }),
        });

        if (!response.ok) throw new Error("Failed to validate location");
        const data = await response.json();

        if (!data) {
          notificationManager.show(
            "Location not found. Please check your input.",
            "warning",
          );
          return;
        }

        this.validatedLocation = data;
        document.getElementById("add-coverage-area").disabled = false;
        notificationManager.show("Location validated successfully!", "success");
      } catch (error) {
        console.error("Error validating location:", error);
        notificationManager.show(
          "Failed to validate location. Please try again.",
          "danger",
        );
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation) {
        notificationManager.show("Please validate a location first.", "danger");
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const { areas } = await response.json();

        const exists = areas.some(
          (area) =>
            area.location.display_name === this.validatedLocation.display_name,
        );

        if (exists) {
          notificationManager.show(
            "This area is already being tracked.",
            "warning",
          );
          return;
        }

        // Add the new area immediately to the table, marked as "processing".
        const newArea = {
          location: this.validatedLocation,
          total_length: 0,
          driven_length: 0,
          coverage_percentage: 0,
          total_segments: 0,
          last_updated: null, // Indicates that processing is underway.
          status: "processing",
        };
        CoverageManager.updateCoverageTable([...areas, newArea]);

        this.showProgressModal("Starting background processing...", 0);
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: this.validatedLocation.display_name,
            location_type: document.getElementById("location-type").value,
          }),
        });

        if (!preprocessResponse.ok)
          throw new Error("Failed to start preprocessing");
        const taskData = await preprocessResponse.json();

        if (taskData?.task_id) {
          this.activeTaskIds.add(taskData.task_id);
        }

        notificationManager.show(
          "Coverage area processing started. You can check the status in the table.",
          "success",
        );

        // Reset input and validated state.
        document.getElementById("location-input").value = "";
        document.getElementById("add-coverage-area").disabled = true;
        this.validatedLocation = null;
      } catch (error) {
        console.error("Error adding coverage area:", error);
        notificationManager.show(
          "Failed to add coverage area. Please try again.",
          "danger",
        );
      } finally {
        this.hideProgressModal();
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel) {
        notificationManager.show("No active processing to cancel.", "warning");
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: locationToCancel }),
        });

        if (!response.ok) throw new Error("Failed to cancel processing");

        notificationManager.show(
          "Processing cancelled successfully.",
          "success",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        notificationManager.show(
          "Failed to cancel processing. Please try again.",
          "danger",
        );
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");
      const stageInfoEl = modal.querySelector(".stage-info");
      const statsInfoEl = modal.querySelector(".stats-info");
      const timeInfoEl = modal.querySelector(".time-info");

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      messageEl.textContent = message;

      // Clear previous details.
      stageInfoEl.innerHTML = "";
      statsInfoEl.innerHTML = "";
      timeInfoEl.innerHTML = "";

      this.processingStartTime = Date.now();
      this.taskProgressModal.show();
    }

    hideProgressModal() {
      this.taskProgressModal.hide();
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const data = await response.json();
        this.constructor.updateCoverageTable(data.areas);
      } catch (error) {
        console.error("Error loading coverage areas: %s", error);
        notificationManager.show(
          "Failed to load coverage areas. Please refresh the page.",
          "danger",
        );
      }
    }

    static updateCoverageTable(areas) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      tableBody.innerHTML = "";

      if (areas.length === 0) {
        const row = document.createElement("tr");
        row.innerHTML =
          '<td colspan="7" class="text-center">No coverage areas found</td>';
        tableBody.appendChild(row);
        return;
      }

      areas.forEach((area) => {
        const row = document.createElement("tr");
        if (area.status === "processing") {
          row.classList.add("processing-row");
        }

        // Format dates
        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";

        // Convert meters to miles
        const totalLengthMiles = (area.total_length * 0.000621371).toFixed(2);
        const drivenLengthMiles = (area.driven_length * 0.000621371).toFixed(2);

        row.innerHTML = `
          <td>
            <a href="#" class="location-name-link text-info" data-location-id="${
              area._id
            }">
              ${area.location.display_name}
            </a>
          </td>
          <td>${totalLengthMiles} miles</td>
          <td>${drivenLengthMiles} miles</td>
          <td>
            <div class="progress" style="height: 20px;">
              <div class="progress-bar bg-success" role="progressbar" 
                style="width: ${area.coverage_percentage.toFixed(1)}%;" 
                aria-valuenow="${area.coverage_percentage.toFixed(1)}" 
                aria-valuemin="0" aria-valuemax="100">
                ${area.coverage_percentage.toFixed(1)}%
              </div>
            </div>
          </td>
          <td>${area.total_segments || 0}</td>
          <td>${lastUpdated}</td>
          <td>
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-primary view-area-btn" data-location='${JSON.stringify(
                area.location,
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-map-marked-alt"></i>
              </button>
              <button class="btn btn-sm btn-success update-coverage-btn" data-location='${JSON.stringify(
                area.location,
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-danger delete-area-btn" data-location='${JSON.stringify(
                area.location,
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    async updateCoverageForArea(location) {
      if (!location) return;

      try {
        // Store the current location being processed
        this.currentProcessingLocation = location;

        // Capture the current location ID if we're viewing it in the dashboard
        const isUpdatingDisplayedLocation =
          this.selectedLocation &&
          this.selectedLocation.location &&
          this.selectedLocation.location.display_name === location.display_name;

        const lastLocationId = isUpdatingDisplayedLocation
          ? document.querySelector(".location-name-link[data-location-id]")
              ?.dataset.locationId
          : null;

        // Show progress modal
        this.showProgressModal(
          "Updating coverage for " + location.display_name,
          0,
        );

        // Start coverage calculation
        const response = await fetch("/api/street_coverage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            location: location,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to start coverage calculation");
        }

        const data = await response.json();
        if (!data.task_id) {
          throw new Error("No task ID returned");
        }

        // Poll for progress updates
        await this.pollCoverageProgress(data.task_id);

        // Refresh the coverage areas
        await this.loadCoverageAreas();

        // Refresh the dashboard if we were updating the displayed location
        if (isUpdatingDisplayedLocation && lastLocationId) {
          // Wait a moment for the coverage data to be fully updated in the database
          setTimeout(() => {
            this.displayCoverageDashboard(lastLocationId);
          }, 1000);
        }

        notificationManager.show(
          "Coverage updated successfully for " + location.display_name,
          "success",
        );
      } catch (error) {
        console.error("Error updating coverage: ", error);
        notificationManager.show(
          "Error updating coverage: " + error.message,
          "danger",
        );
      } finally {
        this.hideProgressModal();
        this.currentProcessingLocation = null;
      }
    }

    static viewAreaOnMap(location) {
      localStorage.setItem("selectedLocation", JSON.stringify(location));
      window.location.href = "/";
    }

    async deleteArea(location) {
      const confirmed = await confirmationDialog.show({
        message: `Are you sure you want to delete the coverage area for ${location.display_name}?`,
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location }),
        });

        if (!response.ok) throw new Error("Failed to delete coverage area");

        await this.loadCoverageAreas();
        notificationManager.show(
          "Coverage area deleted successfully!",
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        notificationManager.show(
          "Failed to delete coverage area. Please try again.",
          "danger",
        );
      }
    }

    setupAutoRefresh() {
      setInterval(async () => {
        const processingRows = document.querySelectorAll(".processing-row");
        if (processingRows.length > 0) {
          await this.loadCoverageAreas();
        }
      }, 5000);
    }

    updateModalContent(data) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");
      const stageInfoEl = modal.querySelector(".stage-info");
      const statsInfoEl = modal.querySelector(".stats-info");
      const timeInfoEl = modal.querySelector(".time-info");

      // Update progress bar and message.
      progressBar.style.width = `${data.progress}%`;
      progressBar.setAttribute("aria-valuenow", data.progress);
      messageEl.textContent = data.message || "Processing...";

      // Display the current stage with an appropriate icon.
      const stageIcon = CoverageManager.getStageIcon(data.stage);
      stageInfoEl.innerHTML = `
        <span class="text-info">
          <i class="${stageIcon}"></i>
          ${CoverageManager.formatStageName(data.stage)}
        </span>
      `;

      // Show additional statistics if available.
      if (data.processed_trips !== undefined) {
        statsInfoEl.innerHTML = `
          <div class="mt-2">
            <div class="mb-1">
              <i class="fas fa-route"></i> Trips: ${data.processed_trips} / ${
                data.total_trips
              }
            </div>
            <div class="mb-1">
              <i class="fas fa-road"></i> Covered Segments: ${
                data.covered_segments || 0
              }
            </div>
            <div>
              <i class="fas fa-ruler"></i> Total Length: ${(
                (data.total_length || 0) * 0.000621371
              ).toFixed(2)} miles
            </div>
          </div>
        `;
      }

      // Update elapsed time.
      if (this.processingStartTime) {
        const elapsedSeconds = Math.floor(
          (Date.now() - this.processingStartTime) / 1000,
        );
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        timeInfoEl.innerHTML = `
          <small>
            <i class="fas fa-clock"></i> Time Elapsed: ${minutes}m ${seconds}s
          </small>
        `;
      }
    }

    static getStageIcon(stage) {
      const icons = {
        initializing: "fas fa-cog fa-spin",
        loading_streets: "fas fa-map-marked-alt",
        indexing: "fas fa-database",
        counting_trips: "fas fa-calculator",
        processing_trips: "fas fa-route",
        finalizing: "fas fa-check-circle",
        complete: "fas fa-flag-checkered",
        error: "fas fa-exclamation-triangle",
      };
      return icons[stage] || "fas fa-circle-notch fa-spin";
    }

    static formatStageName(stage) {
      return stage
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }

    // Note: Removed the static qualifier so that we can use instance properties.
    async pollCoverageProgress(taskId) {
      const maxRetries = 180; // Approximately 15 minutes (with 5-second intervals).
      let retries = 0;
      let lastProgress = -1;

      while (retries < maxRetries) {
        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (!response.ok) throw new Error("Failed to get coverage status");

          const data = await response.json();

          if (data.progress !== lastProgress) {
            this.updateModalContent(data);
            lastProgress = data.progress;
          }

          if (data.stage === "complete") {
            return data;
          } else if (data.stage === "error") {
            throw new Error(data.message || "Coverage calculation failed");
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
          retries++;
        } catch (error) {
          console.error("Error polling coverage progress:", error);
          throw error;
        }
      }
      throw new Error("Coverage calculation timed out");
    }

    // New method to display the coverage dashboard for a selected location
    async displayCoverageDashboard(locationId) {
      try {
        // Show loading indicator
        document.getElementById("dashboard-location-name").textContent =
          "Loading...";
        document.getElementById("coverage-dashboard").style.display = "block";

        // Fetch the detailed coverage data
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to load coverage data");
        }

        // Store the selected location for later use
        this.selectedLocation = data.coverage;

        // Check if there's any street data or if reprocessing is needed
        const hasStreetData =
          data.coverage.streets_geojson &&
          data.coverage.streets_geojson.features &&
          data.coverage.streets_geojson.features.length > 0;

        const needsReprocessing = data.coverage.needs_reprocessing || false;
        const hasError = data.coverage.has_error || false;

        // Update the dashboard title and show appropriate status if needed
        let titleText = data.coverage.location_name;
        if (hasError) {
          titleText += " (Error)";
        } else if (needsReprocessing) {
          titleText += " (Needs Update)";
        }
        document.getElementById("dashboard-location-name").textContent =
          titleText;

        // Update the dashboard stats
        this.updateDashboardStats(data.coverage);

        if (needsReprocessing || !hasStreetData) {
          // Show a message if there's no street data or reprocessing is needed
          const mapContainer = document.getElementById("coverage-map");
          const statusMessage = hasError
            ? `<h5><i class="fas fa-exclamation-circle me-2"></i>Error in coverage calculation</h5>
               <p>${
                 data.coverage.error_message ||
                 "An unknown error occurred during coverage calculation."
               }</p>`
            : `<h5><i class="fas fa-exclamation-triangle me-2"></i>No street data available</h5>
               <p class="mb-0">Street data for this location is missing. This may be because:</p>
               <ul>
                 <li>The coverage calculation is still processing</li>
                 <li>The coverage calculation encountered an error</li>
                 <li>The location doesn't have any mapped streets</li>
               </ul>`;

          mapContainer.innerHTML = `
            <div class="alert alert-warning">
              ${statusMessage}
              <p>Try updating the coverage for this location:</p>
              <button class="update-missing-data-btn btn btn-primary" data-location='${JSON.stringify(
                data.coverage.location || {},
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-sync-alt me-1"></i> Update Coverage Data
              </button>
            </div>
          `;

          // Add event listener for the update button
          mapContainer
            .querySelector(".update-missing-data-btn")
            ?.addEventListener("click", (e) => {
              const location = JSON.parse(e.target.dataset.location);
              this.updateCoverageForArea(location);
            });

          // Hide the chart container
          document.getElementById("street-type-chart").innerHTML =
            '<div class="alert alert-warning">No street data available</div>';

          // Scroll to the dashboard
          document
            .getElementById("coverage-dashboard")
            .scrollIntoView({ behavior: "smooth" });
          return;
        }

        // Initialize and populate the map
        this.initializeCoverageMap(data.coverage);

        // Initialize and populate the street type chart
        this.createStreetTypeChart(data.coverage.street_types);

        // Scroll to the dashboard
        document
          .getElementById("coverage-dashboard")
          .scrollIntoView({ behavior: "smooth" });
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        document.getElementById("dashboard-location-name").textContent =
          "Error loading data";
        document.getElementById("coverage-map").innerHTML =
          `<div class="alert alert-danger">
            <h5><i class="fas fa-exclamation-circle me-2"></i>Error loading coverage data</h5>
            <p>${error.message}</p>
            <p>Please try refreshing the page or select a different location.</p>
          </div>`;
      }
    }

    // Update dashboard statistics
    updateDashboardStats(coverage) {
      // Set the location name
      document.getElementById("dashboard-location-name").textContent =
        coverage.location_name;

      // Convert meters to miles for display
      const totalMiles = (coverage.total_length * 0.000621371).toFixed(2);
      const drivenMiles = (coverage.driven_length * 0.000621371).toFixed(2);

      // Update the stats
      document.getElementById("dashboard-total-streets").textContent =
        coverage.total_streets;
      document.getElementById("dashboard-total-length").textContent =
        `${totalMiles} miles`;
      document.getElementById("dashboard-driven-length").textContent =
        `${drivenMiles} miles`;
      document.getElementById("dashboard-coverage-percentage").textContent =
        `${coverage.coverage_percentage.toFixed(1)}%`;

      // Format the last updated date
      const lastUpdated = coverage.last_updated
        ? new Date(coverage.last_updated).toLocaleString()
        : "Never";
      document.getElementById("dashboard-last-updated").textContent =
        lastUpdated;
    }

    // Initialize and populate the coverage map
    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");

      // Clear the map container if it already has a map
      if (this.coverageMap) {
        this.coverageMap.remove();
        mapContainer.innerHTML = "";
      }

      // Initialize the map
      this.coverageMap = L.map("coverage-map");

      // Add the tile layer (OpenStreetMap)
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.coverageMap);

      // Add the streets GeoJSON data
      this.addStreetsToMap(coverage.streets_geojson);

      // Fit the map to the bounds of the streets
      this.fitMapToBounds();
    }

    // Add streets to the coverage map with appropriate styling
    addStreetsToMap(geojson) {
      // Clear existing layers
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      } else {
        this.streetLayers = L.layerGroup().addTo(this.coverageMap);
      }

      // Store the GeoJSON for filtering
      this.streetsGeoJson = geojson;
      this.currentFilter = "all";

      // Define style functions
      const styleStreet = (feature) => {
        const isDriven = feature.properties.driven;
        return {
          color: isDriven ? "#4caf50" : "#ff5252",
          weight: 3,
          opacity: 0.8,
        };
      };

      // Add the GeoJSON layer
      const streetsLayer = L.geoJSON(geojson, {
        style: styleStreet,
        filter: (feature) => {
          // No filtering by default (show all)
          return true;
        },
        onEachFeature: (feature, layer) => {
          // Add popup with street info
          const props = feature.properties;
          const streetName = props.name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const length = (props.segment_length * 0.000621371).toFixed(2);
          const status = props.driven ? "Driven" : "Not Driven";

          layer.bindPopup(`
            <strong>${streetName}</strong><br>
            Type: ${streetType}<br>
            Length: ${length} miles<br>
            Status: <span class="${
              props.driven ? "text-success" : "text-danger"
            }">${status}</span>
          `);
        },
      }).addTo(this.streetLayers);

      // Store the bounds for later use
      this.mapBounds = streetsLayer.getBounds();
    }

    // Fit the map to the bounds of the streets
    fitMapToBounds() {
      if (this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, {
          padding: [20, 20],
        });
      }
    }

    // Create a chart showing street type coverage
    createStreetTypeChart(streetTypes) {
      // Limit to top 5 street types by length for better visualization
      const topTypes = streetTypes.slice(0, 5);

      // Prepare data for the chart
      const labels = topTypes.map((t) => t.type);
      const totalLengths = topTypes.map((t) =>
        (t.length * 0.000621371).toFixed(2),
      );
      const drivenLengths = topTypes.map((t) =>
        (t.covered_length * 0.000621371).toFixed(2),
      );

      // Check if Chart.js is loaded
      if (typeof Chart === "undefined") {
        console.error("Chart.js is not loaded");
        document.getElementById("street-type-chart").innerHTML =
          '<div class="alert alert-warning">Chart.js is required to display this chart</div>';
        return;
      }

      // Clear existing chart
      const chartContainer = document.getElementById("street-type-chart");
      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      // Create the chart
      new Chart(ctx, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Driven (miles)",
              data: drivenLengths,
              backgroundColor: "#4caf50",
              borderColor: "#388e3c",
              borderWidth: 1,
            },
            {
              label: "Not Driven (miles)",
              data: totalLengths.map((total, i) =>
                (total - drivenLengths[i]).toFixed(2),
              ),
              backgroundColor: "#ff5252",
              borderColor: "#d32f2f",
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              stacked: true,
              ticks: {
                color: "#e0e0e0",
              },
            },
            y: {
              stacked: true,
              ticks: {
                color: "#e0e0e0",
              },
            },
          },
          plugins: {
            legend: {
              position: "top",
              labels: {
                color: "#e0e0e0",
              },
            },
            title: {
              display: false,
            },
          },
        },
      });
    }

    // Export the coverage map as an image
    exportCoverageMap() {
      if (!this.coverageMap) return;

      // Create a timestamp for the filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const locationName = this.selectedLocation.location_name
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const filename = `coverage_map_${locationName}_${timestamp}.png`;

      try {
        // Use leaflet-image if available, otherwise fallback to a message
        if (typeof leafletImage !== "undefined") {
          leafletImage(this.coverageMap, (err, canvas) => {
            if (err) {
              console.error("Error generating map image:", err);
              alert("Failed to generate map image");
              return;
            }

            // Create download link
            const link = document.createElement("a");
            link.download = filename;
            link.href = canvas.toDataURL("image/png");
            link.click();
          });
        } else {
          alert("To export the map, please take a screenshot manually.");
        }
      } catch (error) {
        console.error("Error exporting map:", error);
        alert(`Error exporting map: ${error.message}`);
      }
    }

    // Set map filter to show only certain streets
    setMapFilter(filterType) {
      if (!this.coverageMap || !this.streetsGeoJson) return;

      this.currentFilter = filterType;

      // Remove existing layers
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      }

      // Define style functions
      const styleStreet = (feature) => {
        const isDriven = feature.properties.driven;
        return {
          color: isDriven ? "#4caf50" : "#ff5252",
          weight: 3,
          opacity: 0.8,
        };
      };

      // Define filter function based on filter type
      const filterFunc = (feature) => {
        if (filterType === "all") return true;
        if (filterType === "driven") return feature.properties.driven;
        if (filterType === "undriven") return !feature.properties.driven;
        return true;
      };

      // Add the filtered GeoJSON layer
      const streetsLayer = L.geoJSON(this.streetsGeoJson, {
        style: styleStreet,
        filter: filterFunc,
        onEachFeature: (feature, layer) => {
          // Add popup with street info
          const props = feature.properties;
          const streetName = props.name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const length = (props.segment_length * 0.000621371).toFixed(2);
          const status = props.driven ? "Driven" : "Not Driven";

          layer.bindPopup(`
            <strong>${streetName}</strong><br>
            Type: ${streetType}<br>
            Length: ${length} miles<br>
            Status: <span class="${
              props.driven ? "text-success" : "text-danger"
            }">${status}</span>
          `);
        },
      }).addTo(this.streetLayers);
    }

    // Toggle active state of filter buttons
    toggleFilterButtonState(clickedButton) {
      // Remove active class from all buttons
      document.querySelectorAll(".map-controls .btn").forEach((btn) => {
        btn.classList.remove("active");
      });

      // Add active class to clicked button
      clickedButton.classList.add("active");
    }
  }

  // Initialize the coverage manager when the DOM is loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized");
  });
})();
