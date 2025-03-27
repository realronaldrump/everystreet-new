"use strict";
/* global L, Chart, DateUtils, $ */
(() => {
  class VisitsManager {
    constructor() {
      this.map = null;
      this.places = new Map();
      this.drawControl = null;
      this.currentPolygon = null;
      this.visitsChart = null;
      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.drawingEnabled = false;
      this.customPlacesLayer = null;
      this.loadingManager =
        window.loadingManager || this.createFallbackLoadingManager();
      this.isDetailedView = false;
      this.setupDurationSorting();
      this.initialize();
    }

    // Helper function to convert duration strings like '5d', '2h 30m', etc. to seconds for proper sorting
    convertDurationToSeconds(duration) {
      if (!duration || duration === "N/A" || duration === "Unknown") return 0;

      let seconds = 0;
      const dayMatch = duration.match(/(\d+)d/);
      const hourMatch = duration.match(/(\d+)h/);
      const minuteMatch = duration.match(/(\d+)m/);
      const secondMatch = duration.match(/(\d+)s/);

      if (dayMatch) seconds += parseInt(dayMatch[1]) * 86400;
      if (hourMatch) seconds += parseInt(hourMatch[1]) * 3600;
      if (minuteMatch) seconds += parseInt(minuteMatch[1]) * 60;
      if (secondMatch) seconds += parseInt(secondMatch[1]);

      return seconds;
    }

    setupDurationSorting() {
      // Add a custom sorting method for duration columns
      if (window.$ && $.fn.dataTable) {
        $.fn.dataTable.ext.type.order["duration-pre"] = (data) => {
          return this.convertDurationToSeconds(data);
        };
      }
    }

    createFallbackLoadingManager() {
      return {
        startOperation: (name) =>
          console.log(`LoadingManager not available: ${name}`),
        addSubOperation: (opName, subName) =>
          console.log(`LoadingManager not available: ${opName}.${subName}`),
        updateSubOperation: (opName, subName, progress) =>
          console.log(
            `LoadingManager not available: ${opName}.${subName} (${progress}%)`,
          ),
        finish: (name) =>
          console.log(
            `LoadingManager not available: finished ${name || "all"}`,
          ),
        error: (message) => {
          console.error(`LoadingManager not available: Error - ${message}`);
          window.notificationManager?.show(message, "danger");
        },
      };
    }

    async initialize() {
      this.loadingManager.startOperation("Initializing Visits Page");
      try {
        await this.initializeMap();
        this.initializeDrawControls();
        this.initializeChart();
        this.initializeTables();
        this.setupEventListeners();
        await Promise.all([
          this.loadPlaces(),
          this.loadNonCustomPlacesVisits(),
        ]);
        this.loadingManager.finish();
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
      }
    }

    async initializeMap() {
      return new Promise((resolve) => {
        this.map = L.map("map", {
          center: [37.0902, -95.7129],
          zoom: 4,
          zoomControl: true,
        });

        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          {
            maxZoom: 19,
          },
        ).addTo(this.map);

        this.customPlacesLayer = L.layerGroup().addTo(this.map);
        resolve();
      });
    }

    initializeDrawControls() {
      this.drawControl = new L.Control.Draw({
        draw: {
          polygon: {
            allowIntersection: false,
            drawError: {
              color: "#e1e100",
              message: "<strong>Error:</strong> Shape edges cannot cross!",
            },
            shapeOptions: { color: "#BB86FC" },
          },
          circle: false,
          rectangle: false,
          circlemarker: false,
          marker: false,
          polyline: false,
        },
      });
    }

    initializeChart() {
      const ctx = document.getElementById("visitsChart")?.getContext("2d");
      if (!ctx) return;

      Chart.defaults.color = "rgba(255, 255, 255, 0.8)";
      Chart.defaults.font.family =
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

      this.visitsChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: [],
          datasets: [
            {
              label: "Visits per Place",
              data: [],
              backgroundColor: "#BB86FC",
              borderColor: "#9965EB",
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1,
                color: "rgba(255, 255, 255, 0.75)",
                font: { weight: "400" },
              },
              grid: { color: "rgba(255, 255, 255, 0.1)" },
            },
            x: {
              ticks: {
                color: "rgba(255, 255, 255, 0.8)",
                font: { weight: "500" },
              },
              grid: { color: "rgba(255, 255, 255, 0.1)" },
            },
          },
          plugins: {
            legend: {
              labels: {
                color: "rgba(255, 255, 255, 0.9)",
                font: { weight: "500" },
                boxWidth: 12,
                padding: 15,
              },
            },
            tooltip: {
              backgroundColor: "rgba(30, 30, 30, 0.9)",
              titleColor: "#BB86FC",
              bodyColor: "rgba(255, 255, 255, 0.9)",
              borderColor: "#BB86FC",
              borderWidth: 1,
              padding: 10,
              cornerRadius: 4,
              titleFont: { weight: "600" },
              bodyFont: { weight: "400" },
            },
          },
        },
      });
    }

    initializeTables() {
      this.initVisitsTable();
      this.initNonCustomVisitsTable();
      this.initTripsTable();
    }

    initVisitsTable() {
      const el = document.getElementById("visits-table");
      if (!el || !window.$) return;

      this.visitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]], // Sort by last visit descending
        columns: [
          {
            data: "name",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="place-link" data-place-id="${row._id}">${data}</a>`
                : data,
          },
          {
            data: "totalVisits",
            className: "numeric-cell",
            render: (data) => data || "0",
          },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? new Date(data).toLocaleDateString("en-US")
                  : "N/A"
                : data,
          },
          {
            data: "lastVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? new Date(data).toLocaleDateString("en-US")
                  : "N/A"
                : data,
          },
          {
            data: "avgTimeSpent",
            className: "numeric-cell",
            type: "duration",
            render: (data) => data || "N/A",
          },
        ],
        language: {
          emptyTable: "No visits recorded for custom places",
          info: "_START_ to _END_ of _TOTAL_ places",
          search: "Filter places:",
          paginate: {
            first: "First",
            last: "Last",
            next: "Next",
            previous: "Prev",
          },
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
      });
    }

    initNonCustomVisitsTable() {
      const el = document.getElementById("non-custom-visits-table");
      if (!el || !window.$) return;

      this.nonCustomVisitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]],
        columns: [
          { data: "name" },
          {
            data: "totalVisits",
            className: "numeric-cell",
          },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? new Date(data).toLocaleDateString("en-US")
                  : "N/A"
                : data,
          },
          {
            data: "lastVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? new Date(data).toLocaleDateString("en-US")
                  : "N/A"
                : data,
          },
        ],
        language: {
          emptyTable: "No visits recorded for non-custom places",
          info: "_START_ to _END_ of _TOTAL_ places",
          search: "Filter places:",
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
      });
    }

    initTripsTable() {
      const el = document.getElementById("trips-for-place-table");
      if (!el || !window.$) return;

      this.tripsTable = $(el).DataTable({
        responsive: true,
        order: [[1, "desc"]], // Sort by arrival time descending
        columns: [
          {
            data: "transactionId",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="trip-id-link" data-trip-id="${row.id}">${data}</a>`
                : data,
          },
          {
            data: "endTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                : data,
          },
          {
            data: "endTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                : data,
          },
          {
            data: "departureTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                  : "Unknown"
                : data,
          },
          {
            data: "timeSpent",
            className: "numeric-cell",
            type: "duration",
          },
          {
            data: "timeSinceLastVisit",
            className: "numeric-cell",
            type: "duration",
          },
          {
            data: null,
            className: "action-cell",
            orderable: false,
            render: (data, type, row) =>
              type === "display"
                ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}">
                    <i class="fas fa-map-marker-alt me-1"></i> View on Map
                  </button>`
                : "",
          },
        ],
        language: {
          emptyTable: "No trips found for this place",
          info: "_START_ to _END_ of _TOTAL_ trips",
          search: "Filter trips:",
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
      });

      // Add event listener for the view trip buttons
      $(el).on("click", ".view-trip-btn, .trip-id-link", (e) => {
        e.preventDefault();
        const tripId = $(e.currentTarget).data("trip-id");
        this.confirmViewTripOnMap(tripId);
      });
    }

    setupEventListeners() {
      // Drawing controls
      document
        .getElementById("start-drawing")
        ?.addEventListener("click", () => {
          if (!this.drawingEnabled) {
            this.map.addControl(this.drawControl);
            new L.Draw.Polygon(this.map).enable();
            this.drawingEnabled = true;
            document.getElementById("start-drawing").classList.add("active");
          }
        });

      document
        .getElementById("save-place")
        ?.addEventListener("click", () => this.savePlace());
      document
        .getElementById("back-to-places-btn")
        ?.addEventListener("click", () => this.toggleView());

      // Manage Places button
      document
        .getElementById("manage-places")
        ?.addEventListener("click", () => this.showManagePlacesModal());

      // Edit place form submission
      document
        .getElementById("edit-place-form")
        ?.addEventListener("submit", (e) => {
          e.preventDefault();
          this.saveEditedPlace();
        });

      // Edit place boundary button
      document
        .getElementById("edit-place-boundary")
        ?.addEventListener("click", () => this.startEditingPlaceBoundary());

      // Map drawing events
      this.map.on(L.Draw.Event.CREATED, (e) => {
        this.currentPolygon = e.layer;
        this.map.addLayer(this.currentPolygon);
        document.getElementById("save-place").disabled = false;
      });

      // Table interactions using event delegation
      $("#visits-table, #non-custom-visits-table").on(
        "click",
        ".place-link",
        (event) => {
          event.preventDefault();
          const placeId = $(event.target).data("place-id");
          this.toggleView(placeId);
        },
      );

      // Toggle view button
      $("#visits-table-container").on("click", "#toggle-view-btn", () =>
        this.toggleView(),
      );
    }

    async loadPlaces() {
      try {
        const response = await fetch("/api/places");
        if (!response.ok) throw new Error("Failed to fetch places");

        const places = await response.json();
        places.forEach((place) => {
          this.places.set(place._id, place);
          this.displayPlace(place);
        });

        await this.updateVisitsData();
      } catch (error) {
        console.error("Error loading places:", error);
        window.notificationManager?.show("Failed to load places", "danger");
      }
    }

    displayPlace(place) {
      const polygon = L.geoJSON(place.geometry, {
        style: { color: "#BB86FC", fillColor: "#BB86FC", fillOpacity: 0.2 },
      });

      polygon.bindPopup(`
        <div class="place-popup">
          <h6>${place.name}</h6>
          <button class="btn btn-sm btn-info" onclick="visitsManager.showPlaceStatistics('${place._id}')">
            View Statistics
          </button>
        </div>
      `);

      polygon.on("click", () => this.showPlaceStatistics(place._id));
      this.customPlacesLayer.addLayer(polygon);
    }

    async updateVisitsData() {
      const visitsData = [];

      // Use Promise.all to fetch all statistics in parallel
      const placeEntries = Array.from(this.places.entries());
      const statsPromises = placeEntries.map(async ([id, place]) => {
        try {
          const response = await fetch(`/api/places/${id}/statistics`);
          if (!response.ok)
            throw new Error(`Failed to fetch statistics for place ${id}`);

          const stats = await response.json();
          return {
            _id: id,
            name: place.name,
            totalVisits: stats.totalVisits,
            firstVisit: stats.firstVisit,
            lastVisit: stats.lastVisit,
            avgTimeSpent: stats.averageTimeSpent,
          };
        } catch (error) {
          console.error(
            `Error fetching statistics for place ${place.name}:`,
            error,
          );
          return null;
        }
      });

      const results = await Promise.all(statsPromises);
      const validResults = results.filter((result) => result !== null);

      // Update chart
      if (this.visitsChart) {
        this.visitsChart.data.labels = validResults.map((d) => d.name);
        this.visitsChart.data.datasets[0].data = validResults.map(
          (d) => d.totalVisits,
        );
        this.visitsChart.update();
      }

      // Update table
      if (this.visitsTable) {
        this.visitsTable.clear().rows.add(validResults).draw();
      }
    }

    async savePlace() {
      const placeName = document.getElementById("place-name")?.value.trim();
      if (!placeName || !this.currentPolygon) {
        window.notificationManager?.show(
          "Please enter a name for this place",
          "warning",
        );
        return;
      }

      try {
        const response = await fetch("/api/places", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: placeName,
            geometry: this.currentPolygon.toGeoJSON().geometry,
          }),
        });

        if (!response.ok) throw new Error("Failed to save place");

        const savedPlace = await response.json();
        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);
        this.resetDrawing();
        this.updateVisitsData();

        window.notificationManager?.show(
          `Place "${placeName}" saved successfully`,
          "success",
        );
      } catch (error) {
        console.error("Error saving place:", error);
        window.notificationManager?.show("Failed to save place", "danger");
      }
    }

    async deletePlace(placeId) {
      let confirmed = false;

      if (window.confirmationDialog) {
        confirmed = await window.confirmationDialog.show({
          title: "Delete Place",
          message: "Are you sure you want to delete this place?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
      } else {
        confirmed = confirm("Are you sure you want to delete this place?");
      }

      if (!confirmed) return;

      try {
        const response = await fetch(`/api/places/${placeId}`, {
          method: "DELETE",
        });

        if (!response.ok) throw new Error("Failed to delete place");

        this.places.delete(placeId);

        // Remove from map
        this.map.eachLayer((layer) => {
          if (layer.feature && layer.feature.properties.placeId === placeId) {
            this.map.removeLayer(layer);
          }
        });

        await this.updateVisitsData();
        window.notificationManager?.show(
          "Place deleted successfully",
          "success",
        );
      } catch (error) {
        console.error("Error deleting place:", error);
        window.notificationManager?.show("Failed to delete place", "danger");
      }
    }

    resetDrawing() {
      if (this.currentPolygon) this.map.removeLayer(this.currentPolygon);
      this.currentPolygon = null;

      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) placeNameInput.value = "";
      if (savePlaceBtn) savePlaceBtn.disabled = true;
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      if (this.drawControl) this.map.removeControl(this.drawControl);
      this.drawingEnabled = false;
    }

    // Manage Places functionality
    showManagePlacesModal() {
      const modal = new bootstrap.Modal(
        document.getElementById("manage-places-modal"),
      );

      // Clear and populate the table
      const tableBody = document.querySelector("#manage-places-table tbody");
      tableBody.innerHTML = "";

      // Sort places by name
      const placesArray = Array.from(this.places.values());
      placesArray.sort((a, b) => a.name.localeCompare(b.name));

      placesArray.forEach((place) => {
        const row = document.createElement("tr");

        row.innerHTML = `
          <td>${place.name}</td>
          <td>
            <div class="btn-group btn-group-sm" role="group">
              <button type="button" class="btn btn-primary edit-place-btn" data-place-id="${place._id}">
                <i class="fas fa-edit"></i> Edit
              </button>
              <button type="button" class="btn btn-danger delete-place-btn" data-place-id="${place._id}">
                <i class="fas fa-trash-alt"></i> Delete
              </button>
            </div>
          </td>
        `;

        tableBody.appendChild(row);
      });

      // Add event listeners for edit and delete buttons
      document.querySelectorAll(".edit-place-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const placeId = e.currentTarget.getAttribute("data-place-id");
          modal.hide();
          this.showEditPlaceModal(placeId);
        });
      });

      document.querySelectorAll(".delete-place-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const placeId = e.currentTarget.getAttribute("data-place-id");
          modal.hide();
          this.deletePlace(placeId);
        });
      });

      modal.show();
    }

    showEditPlaceModal(placeId) {
      const place = this.places.get(placeId);
      if (!place) return;

      const modal = new bootstrap.Modal(
        document.getElementById("edit-place-modal"),
      );
      document.getElementById("edit-place-id").value = placeId;
      document.getElementById("edit-place-name").value = place.name;

      this.placeBeingEdited = placeId;
      modal.show();
    }

    startEditingPlaceBoundary() {
      const placeId = document.getElementById("edit-place-id").value;
      const place = this.places.get(placeId);
      if (!place) return;

      // Hide the edit modal
      const editModal = bootstrap.Modal.getInstance(
        document.getElementById("edit-place-modal"),
      );
      editModal.hide();

      // Clear existing drawing
      this.resetDrawing();

      // Create a new polygon from the place geometry
      const existingGeometry = place.geometry;
      if (
        existingGeometry &&
        existingGeometry.coordinates &&
        existingGeometry.coordinates.length > 0
      ) {
        const coordinates = existingGeometry.coordinates[0];
        // Convert from GeoJSON [longitude, latitude] to Leaflet [latitude, longitude]
        const latLngs = coordinates.map((coord) => [coord[1], coord[0]]);

        // Create a polygon and add it to the map
        this.currentPolygon = L.polygon(latLngs, { color: "#BB86FC" });
        this.currentPolygon.addTo(this.map);

        // Enable the save button
        document.getElementById("save-place").disabled = false;
      }

      // Center map on the place
      if (this.currentPolygon) {
        this.map.fitBounds(this.currentPolygon.getBounds());
      }

      // Add the drawing control to allow editing the polygon
      this.map.addControl(this.drawControl);
      this.drawingEnabled = true;
      document.getElementById("start-drawing").classList.add("active");

      // Store reference to the place being edited
      this.placeBeingEdited = placeId;

      window.notificationManager?.show(
        "Edit the boundary for this place by drawing a new polygon, then save changes",
        "info",
      );
    }

    async saveEditedPlace() {
      const placeId = document.getElementById("edit-place-id").value;
      const newName = document.getElementById("edit-place-name").value.trim();

      if (!placeId || !newName) {
        window.notificationManager?.show(
          "Place name cannot be empty",
          "warning",
        );
        return;
      }

      try {
        // If we're editing boundary and have a new polygon, include the geometry
        let requestBody = { name: newName };
        if (this.currentPolygon && this.placeBeingEdited === placeId) {
          requestBody.geometry = this.currentPolygon.toGeoJSON().geometry;
        }

        const response = await fetch(`/api/places/${placeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) throw new Error("Failed to update place");

        const updatedPlace = await response.json();

        // Update the place in our local map
        this.places.set(placeId, updatedPlace);

        // Update the place on the map
        this.customPlacesLayer.clearLayers();
        Array.from(this.places.values()).forEach((place) => {
          this.displayPlace(place);
        });

        // Reset drawing if we edited the boundary
        if (this.currentPolygon) {
          this.resetDrawing();
        }

        // Close the modal
        const modal = bootstrap.Modal.getInstance(
          document.getElementById("edit-place-modal"),
        );
        if (modal) modal.hide();

        // Clear the place being edited
        this.placeBeingEdited = null;

        // Update visits data
        this.updateVisitsData();

        window.notificationManager?.show(
          `Place "${newName}" updated successfully`,
          "success",
        );
      } catch (error) {
        console.error("Error updating place:", error);
        window.notificationManager?.show("Failed to update place", "danger");
      }
    }

    /**
     * Shows the selected trip on the map
     * @param {string} tripId - The ID of the trip to view
     */
    confirmViewTripOnMap(tripId) {
      if (!tripId) return;

      // Directly fetch and show the trip without confirmation
      this.fetchAndShowTrip(tripId);
    }

    /**
     * Fetches trip data and displays it in a modal
     * @param {string} tripId - The ID of the trip to view
     */
    async fetchAndShowTrip(tripId) {
      try {
        // Show loading indicator
        this.loadingManager.startOperation("Fetching Trip Data");

        console.log(`Fetching trip data for ID: ${tripId}`);

        // Fetch the trip data from the API
        const response = await fetch(`/api/trips/${tripId}`);

        if (!response.ok) {
          throw new Error(`Failed to fetch trip: ${response.statusText}`);
        }

        // Get the base trip data
        const tripResponse = await response.json();
        console.log("Trip response received:", tripResponse);

        // In some APIs, the actual trip data might be nested under a 'trip' property
        const trip = tripResponse.trip || tripResponse;

        // Process and extract geometry from various possible sources
        this.extractTripGeometry(trip);

        // Initialize the trip map and display the data
        this.showTripOnMap(trip);

        this.loadingManager.finish();
      } catch (error) {
        console.error("Error fetching trip data:", error);
        this.loadingManager.error("Failed to fetch trip data");
        window.notificationManager?.show(
          "Error loading trip data. Please try again.",
          "danger",
        );
      }
    }

    /**
     * Extracts and processes trip geometry from various possible sources
     * @param {Object} trip - The trip data object
     */
    extractTripGeometry(trip) {
      // Try the default geometry field first
      if (
        trip.geometry &&
        trip.geometry.coordinates &&
        trip.geometry.coordinates.length > 0
      ) {
        console.log("Using existing geometry data");
        return;
      }

      // Check for matchedGps field
      if (
        trip.matchedGps &&
        trip.matchedGps.coordinates &&
        trip.matchedGps.coordinates.length > 0
      ) {
        console.log("Using matchedGps data");
        trip.geometry = trip.matchedGps;
        return;
      }

      // Try to parse gps JSON field if it exists
      if (typeof trip.gps === "string" && trip.gps) {
        try {
          console.log("Parsing gps field from JSON string");
          const gpsData = JSON.parse(trip.gps);
          if (
            gpsData &&
            gpsData.coordinates &&
            gpsData.coordinates.length > 0
          ) {
            console.log("Successfully parsed gps JSON data");
            trip.geometry = gpsData;
            return;
          }
        } catch (e) {
          console.error("Failed to parse gps JSON:", e);
        }
      }

      // If we have start and end coordinates, create a simple line
      if (
        trip.startGeoPoint &&
        trip.startGeoPoint.coordinates &&
        trip.destinationGeoPoint &&
        trip.destinationGeoPoint.coordinates
      ) {
        console.log("Creating geometry from start and end points");
        trip.geometry = {
          type: "LineString",
          coordinates: [
            trip.startGeoPoint.coordinates,
            trip.destinationGeoPoint.coordinates,
          ],
        };
        return;
      }

      console.log("No valid geometry data found in trip");
    }

    /**
     * Displays a trip on the map in a modal
     * @param {Object} trip - The trip data to display
     */
    showTripOnMap(trip) {
      // Clear previous trip info
      const tripInfoContainer = document.getElementById("trip-info");
      tripInfoContainer.innerHTML = "";

      // Format trip info
      const startTime = trip.startTime
        ? new Date(trip.startTime).toLocaleString()
        : "Unknown";
      const endTime = trip.endTime
        ? new Date(trip.endTime).toLocaleString()
        : "Unknown";

      // Extract and format the distance (handle multiple possible formats)
      let formattedDistance = "Unknown";
      if (trip.distance) {
        // Parse the distance value, which could be in various formats
        let distanceValue = trip.distance;

        // If it's an object with a value property, use that
        if (
          typeof distanceValue === "object" &&
          distanceValue.value !== undefined
        ) {
          distanceValue = distanceValue.value;
        }

        // Convert string to number if needed
        if (typeof distanceValue === "string") {
          distanceValue = parseFloat(distanceValue);
        }

        // Only format if we have a valid number
        if (!isNaN(distanceValue) && distanceValue > 0) {
          // Distance is often in miles already
          formattedDistance = `${distanceValue.toFixed(2)} miles`;
        }
      }
      const transactionId = trip.transactionId || trip._id;

      // Extract location information from nested objects
      const startLocation =
        trip.startLocation && trip.startLocation.formatted_address
          ? trip.startLocation.formatted_address
          : trip.startPlace || "Unknown";

      const endLocation =
        trip.destination && trip.destination.formatted_address
          ? trip.destination.formatted_address
          : trip.destinationPlace || "Unknown";

      // Display trip information
      tripInfoContainer.innerHTML = `
        <div class="trip-details">
          <h6>Transaction ID: ${transactionId}</h6>
          <div class="row">
            <div class="col-md-6">
              <p><strong>Start:</strong> ${startTime}</p>
              <p><strong>Start Location:</strong> ${startLocation}</p>
            </div>
            <div class="col-md-6">
              <p><strong>End:</strong> ${endTime}</p>
              <p><strong>End Location:</strong> ${endLocation}</p>
            </div>
          </div>
          <p><strong>Distance:</strong> ${formattedDistance}</p>
        </div>
      `;

      // Show the modal first so DOM is fully available
      const modal = new bootstrap.Modal(
        document.getElementById("view-trip-modal"),
      );
      modal.show();

      // Wait for modal to be fully shown before initializing map
      document.getElementById("view-trip-modal").addEventListener(
        "shown.bs.modal",
        () => {
          this.initializeTripMap(trip);
        },
        { once: true },
      );
    }

    /**
     * Initialize the trip map after the modal is shown
     * @param {Object} trip - The trip data to display on the map
     */
    initializeTripMap(trip) {
      // Get map container and reset it to ensure clean initialization
      const tripMapElement = document.getElementById("trip-map");

      // If there's a previous map in this container, remove it
      if (this.tripViewMap) {
        this.tripViewMap.remove();
        this.tripViewMap = null;
      }

      // Reset the container by replacing it with a clone
      const parent = tripMapElement.parentNode;
      const newMapElement = tripMapElement.cloneNode(false);
      parent.replaceChild(newMapElement, tripMapElement);

      // Initialize the map
      this.tripViewMap = L.map(newMapElement, { attributionControl: false });

      // Add base map layer
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          maxZoom: 19,
        },
      ).addTo(this.tripViewMap);

      // Add trip path to map if geometry exists
      if (
        trip.geometry &&
        trip.geometry.coordinates &&
        trip.geometry.coordinates.length > 0
      ) {
        // Create a line from the trip coordinates
        const tripPath = L.geoJSON(trip.geometry, {
          style: {
            color: "#BB86FC",
            weight: 4,
            opacity: 0.8,
          },
        }).addTo(this.tripViewMap);

        // Add start and end markers
        const coordinates = trip.geometry.coordinates;

        if (coordinates.length > 0) {
          // Start marker (first coordinate)
          const startCoord = coordinates[0];
          L.marker([startCoord[1], startCoord[0]], {
            icon: L.divIcon({
              className: "trip-marker start-marker",
              html: '<i class="fas fa-play-circle"></i>',
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            }),
          })
            .addTo(this.tripViewMap)
            .bindTooltip("Start");

          // End marker (last coordinate)
          const endCoord = coordinates[coordinates.length - 1];
          L.marker([endCoord[1], endCoord[0]], {
            icon: L.divIcon({
              className: "trip-marker end-marker",
              html: '<i class="fas fa-stop-circle"></i>',
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            }),
          })
            .addTo(this.tripViewMap)
            .bindTooltip("End");

          // Fit map to the bounds of the trip path
          this.tripViewMap.fitBounds(tripPath.getBounds(), {
            padding: [20, 20],
          });
        }
      } else {
        // If no geometry, show a message
        document.getElementById("trip-info").innerHTML +=
          `<div class="alert alert-warning">No route data available for this trip.</div>`;
        this.tripViewMap.setView([37.0902, -95.7129], 4); // Default US center view
      }

      // Ensure map renders correctly
      this.tripViewMap.invalidateSize();
    }

    async showPlaceStatistics(placeId) {
      try {
        const response = await fetch(`/api/places/${placeId}/statistics`);
        if (!response.ok) throw new Error("Failed to fetch place statistics");

        const stats = await response.json();
        const place = this.places.get(placeId);
        if (!place) throw new Error("Place not found");

        const formatDate = (date) =>
          date ? new Date(date).toLocaleDateString() : "N/A";
        const formatAvg = (avg, unit = "") =>
          avg
            ? typeof avg === "number"
              ? `${avg.toFixed(2)} ${unit}`.trim()
              : avg
            : "N/A";

        const popupContent = `
          <div class="custom-place-popup">
            <h6>${place.name}</h6>
            <p>Total Visits: ${stats.totalVisits}</p>
            <p>First Visit: ${formatDate(stats.firstVisit)}</p>
            <p>Last Visit: ${formatDate(stats.lastVisit)}</p>
            <p>Avg Time Spent: ${formatAvg(stats.averageTimeSpent)}</p>
            <p>Avg Time Since Last Visit: ${formatAvg(
              stats.averageTimeSinceLastVisit,
              "hours",
            )}</p>
          </div>
        `;

        this.customPlacesLayer.eachLayer((layer) => {
          if (layer.feature && layer.feature.properties.placeId === placeId) {
            layer.setPopupContent(popupContent);
          }
        });
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        window.notificationManager?.show(
          "Failed to fetch place statistics",
          "danger",
        );
      }
    }

    async toggleView(placeId = null) {
      this.isDetailedView = !this.isDetailedView;

      const elements = {
        visitsChart: document.getElementById("visitsChart"),
        visitsTableContainer: document.getElementById("visits-table-container"),
        tripsForPlaceContainer: document.getElementById(
          "trips-for-place-container",
        ),
        toggleViewBtn: document.getElementById("toggle-view-btn"),
      };

      if (this.isDetailedView) {
        if (elements.visitsChart) elements.visitsChart.style.display = "none";

        if (!placeId) {
          console.error("Place ID is undefined");
          this.isDetailedView = false;
          return;
        }

        await this.showTripsForPlace(placeId);

        if (elements.visitsTableContainer)
          elements.visitsTableContainer.style.display = "none";
        if (elements.tripsForPlaceContainer)
          elements.tripsForPlaceContainer.style.display = "block";
        if (elements.toggleViewBtn)
          elements.toggleViewBtn.textContent = "Show All Places";
      } else {
        if (elements.visitsChart) elements.visitsChart.style.display = "block";
        if (elements.visitsTableContainer)
          elements.visitsTableContainer.style.display = "block";
        if (elements.tripsForPlaceContainer)
          elements.tripsForPlaceContainer.style.display = "none";
        if (elements.toggleViewBtn)
          elements.toggleViewBtn.textContent = "Show Trips for Selected Place";
      }
    }

    async showTripsForPlace(placeId) {
      try {
        const response = await fetch(`/api/places/${placeId}/trips`);
        if (!response.ok) throw new Error("Failed to fetch trips for place");

        const data = await response.json();
        const trips = data.trips || [];

        if (this.tripsTable) {
          this.tripsTable.clear().rows.add(trips).draw();
        }

        // Update place name if available
        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement && data.name) {
          placeNameElement.textContent = data.name;
        }
      } catch (error) {
        console.error("Error fetching trips for place:", error);
        window.notificationManager?.show(
          "Failed to fetch trips for place",
          "danger",
        );
      }
    }

    async loadNonCustomPlacesVisits() {
      try {
        const response = await fetch("/api/non_custom_places_visits");
        if (!response.ok)
          throw new Error("Failed to fetch visits for non-custom places");

        const visitsData = await response.json();
        if (this.nonCustomVisitsTable) {
          this.nonCustomVisitsTable.clear().rows.add(visitsData).draw();
        }
      } catch (error) {
        console.error("Error fetching visits for non-custom places:", error);
        window.notificationManager?.show(
          "Failed to load non-custom places visits",
          "danger",
        );
      }
    }
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.visitsManager = new VisitsManager();
  });
})();
