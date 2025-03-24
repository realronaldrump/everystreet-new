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
      this.initialize();
    }

    createFallbackLoadingManager() {
      return {
        startOperation: (name) =>
          console.log(`LoadingManager not available: ${name}`),
        addSubOperation: (opName, subName) =>
          console.log(`LoadingManager not available: ${opName}.${subName}`),
        updateSubOperation: (opName, subName, progress) =>
          console.log(
            `LoadingManager not available: ${opName}.${subName} (${progress}%)`
          ),
        finish: (name) =>
          console.log(
            `LoadingManager not available: finished ${name || "all"}`
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
          }
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
          { data: "id" },
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
          },
          {
            data: "timeSinceLastVisit",
            className: "numeric-cell",
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
        }
      );

      // Toggle view button
      $("#visits-table-container").on("click", "#toggle-view-btn", () =>
        this.toggleView()
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
            error
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
          (d) => d.totalVisits
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
          "warning"
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
          "success"
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
          "success"
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
              "hours"
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
          "danger"
        );
      }
    }

    async toggleView(placeId = null) {
      this.isDetailedView = !this.isDetailedView;

      const elements = {
        visitsChart: document.getElementById("visitsChart"),
        visitsTableContainer: document.getElementById("visits-table-container"),
        tripsForPlaceContainer: document.getElementById(
          "trips-for-place-container"
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
          "danger"
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
          "danger"
        );
      }
    }
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.visitsManager = new VisitsManager();
  });
})();
