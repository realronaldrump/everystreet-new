"use strict";
/* global L, Chart */
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
      this.loadingManager = window.loadingManager || {
        startOperation: () => {},
        addSubOperation: () => {},
        updateSubOperation: () => {},
        finish: () => {},
        error: () => {},
      };
      this.isDetailedView = false;
      this.initialize();
    }

    async initialize() {
      this.loadingManager.startOperation("Initializing Visits Page");
      try {
        await this.initializeMap();
        this.initializeDrawControls();
        this.initializeChart();
        this.initializeTables();
        this.setupEventListeners();
        await this.loadPlaces();
        await this.loadNonCustomPlacesVisits();
        this.loadingManager.finish();
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
      }
    }

    initializeMap() {
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
        // Create a layer group for custom places
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

      this.visitsChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: [],
          datasets: [
            {
              label: "Visits per Place",
              data: [],
              backgroundColor: "#BB86FC",
            },
          ],
        },
        options: {
          responsive: true,
          scales: {
            y: {
              beginAtZero: true,
              ticks: { stepSize: 1 },
            },
          },
        },
      });
    }

    initializeTables() {
      const visitsTableEl = document.getElementById("visits-table");
      if (visitsTableEl && window.$) {
        this.visitsTable = $(visitsTableEl).DataTable({
          responsive: true,
          order: [[3, "desc"]], // Sort by last visit (index 3) descending
          columns: [
            {
              data: "name",
              render: (data, type, row) =>
                type === "display"
                  ? `<a href="#" class="place-link" data-place-id="${row._id}">${data}</a>`
                  : data,
            },
            { data: "totalVisits" },
            {
              data: "firstVisit",
              render: (data, type) =>
                type === "display" || type === "filter"
                  ? data
                    ? new Date(data).toLocaleDateString("en-US")
                    : "N/A"
                  : data,
            },
            {
              data: "lastVisit",
              render: (data, type) =>
                type === "display" || type === "filter"
                  ? data
                    ? new Date(data).toLocaleDateString("en-US")
                    : "N/A"
                  : data,
            },
            { data: "avgTimeSpent", render: (data) => data || "N/A" },
          ],
          language: { emptyTable: "No visits recorded for custom places" },
        });
      }

      const nonCustomTableEl = document.getElementById(
        "non-custom-visits-table"
      );
      if (nonCustomTableEl && window.$) {
        this.nonCustomVisitsTable = $(nonCustomTableEl).DataTable({
          responsive: true,
          order: [[3, "desc"]],
          columns: [
            { data: "name" },
            { data: "totalVisits" },
            {
              data: "firstVisit",
              render: (data, type) =>
                type === "display" || type === "filter"
                  ? data
                    ? new Date(data).toLocaleDateString("en-US")
                    : "N/A"
                  : data,
            },
            {
              data: "lastVisit",
              render: (data, type) =>
                type === "display" || type === "filter"
                  ? data
                    ? new Date(data).toLocaleDateString("en-US")
                    : "N/A"
                  : data,
            },
          ],
          language: { emptyTable: "No visits recorded for non-custom places" },
        });
      }

      const tripsTableEl = document.getElementById("trips-for-place-table");
      if (tripsTableEl && window.$) {
        this.tripsTable = $(tripsTableEl).DataTable({
          responsive: true,
          order: [[1, "desc"]], // Sort by endTime descending
          columns: [
            { data: "transactionId" },
            {
              data: "endTime",
              render: (data, type) =>
                type === "display" || type === "filter"
                  ? DateUtils.formatForDisplay(data, {
                      dateStyle: "medium",
                      timeStyle: null,
                    })
                  : data,
            },
            {
              data: "endTime",
              render: (data, type, row) =>
                type === "display" || type === "filter"
                  ? DateUtils.formatForDisplay(data, {
                      dateStyle: null,
                      timeStyle: "short",
                    })
                  : data,
            },
            { data: "duration" },
            { data: "timeSinceLastVisit" },
          ],
          language: { emptyTable: "No trips found for this place" },
        });
      }
    }

    setupEventListeners() {
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

      this.map.on(L.Draw.Event.CREATED, (e) => {
        this.currentPolygon = e.layer;
        this.map.addLayer(this.currentPolygon);
        document.getElementById("save-place").disabled = false;
      });

      // Handle clicks on place links in both tables
      $("#visits-table, #non-custom-visits-table").on(
        "click",
        ".place-link",
        (event) => {
          event.preventDefault();
          const placeId = $(event.target).data("place-id");
          this.toggleView(placeId);
        }
      );

      // Toggle view button listener
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
        if (window.notificationManager) {
          window.notificationManager.show("Failed to load places", "danger");
        }
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

      for (const [id, place] of this.places) {
        try {
          const response = await fetch(`/api/places/${id}/statistics`);
          if (!response.ok)
            throw new Error(`Failed to fetch statistics for place ${id}`);
          const stats = await response.json();
          visitsData.push({
            _id: id,
            name: place.name,
            totalVisits: stats.totalVisits,
            firstVisit: stats.firstVisit,
            lastVisit: stats.lastVisit,
            avgTimeSpent: stats.averageTimeSpent,
          });
        } catch (error) {
          console.error(
            `Error fetching statistics for place ${place.name}:`,
            error
          );
        }
      }

      if (this.visitsChart) {
        this.visitsChart.data.labels = visitsData.map((d) => d.name);
        this.visitsChart.data.datasets[0].data = visitsData.map(
          (d) => d.totalVisits
        );
        this.visitsChart.update();
      }

      if (this.visitsTable) {
        this.visitsTable.clear().rows.add(visitsData).draw();
      }
    }

    async savePlace() {
      const placeName = document.getElementById("place-name")?.value.trim();
      if (!placeName || !this.currentPolygon) {
        if (window.notificationManager) {
          window.notificationManager.show(
            "Please enter a name for this place",
            "warning"
          );
        }
        return;
      }

      const placeData = {
        name: placeName,
        geometry: this.currentPolygon.toGeoJSON().geometry,
      };

      try {
        const response = await fetch("/api/places", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(placeData),
        });

        if (!response.ok) throw new Error("Failed to save place");
        const savedPlace = await response.json();

        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);
        this.resetDrawing();
        this.updateVisitsData();

        if (window.notificationManager) {
          window.notificationManager.show(
            `Place "${placeName}" saved successfully`,
            "success"
          );
        }
      } catch (error) {
        console.error("Error saving place:", error);
        if (window.notificationManager) {
          window.notificationManager.show("Failed to save place", "danger");
        }
      }
    }

    async deletePlace(placeId) {
      if (window.confirmationDialog) {
        const confirmed = await window.confirmationDialog.show({
          title: "Delete Place",
          message: "Are you sure you want to delete this place?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });

        if (!confirmed) return;
      } else if (!confirm("Are you sure you want to delete this place?")) {
        return;
      }

      try {
        const response = await fetch(`/api/places/${placeId}`, {
          method: "DELETE",
        });

        if (!response.ok) throw new Error("Failed to delete place");

        this.places.delete(placeId);
        this.map.eachLayer((layer) => {
          if (layer.feature && layer.feature.properties.placeId === placeId) {
            this.map.removeLayer(layer);
          }
        });

        this.updateVisitsData();

        if (window.notificationManager) {
          window.notificationManager.show(
            "Place deleted successfully",
            "success"
          );
        }
      } catch (error) {
        console.error("Error deleting place:", error);
        if (window.notificationManager) {
          window.notificationManager.show("Failed to delete place", "danger");
        }
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
        const popupContent = `
            <div class="custom-place-popup">
              <h6>${this.places.get(placeId).name}</h6>
              <p>Total Visits: ${stats.totalVisits}</p>
              <p>First Visit: ${stats.firstVisit ? new Date(stats.firstVisit).toLocaleDateString() : "N/A"}</p>
              <p>Last Visit: ${stats.lastVisit ? new Date(stats.lastVisit).toLocaleDateString() : "N/A"}</p>
              <p>Avg Time Spent: ${stats.averageTimeSpent || "N/A"}</p>
              <p>Avg Time Since Last Visit: ${stats.averageTimeSinceLastVisit ? stats.averageTimeSinceLastVisit.toFixed(2) + " hours" : "N/A"}</p>
            </div>
          `;

        this.customPlacesLayer.eachLayer((layer) => {
          if (layer.feature && layer.feature.properties.placeId === placeId) {
            layer.setPopupContent(popupContent);
          }
        });
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        if (window.notificationManager) {
          window.notificationManager.show(
            "Failed to fetch place statistics",
            "danger"
          );
        }
      }
    }

    async toggleView(placeId = null) {
      this.isDetailedView = !this.isDetailedView;
      const visitsChartEl = document.getElementById("visitsChart");
      const visitsTableContainer = document.getElementById(
        "visits-table-container"
      );
      const tripsForPlaceContainer = document.getElementById(
        "trips-for-place-container"
      );
      const toggleViewBtn = document.getElementById("toggle-view-btn");

      if (this.isDetailedView) {
        if (visitsChartEl) visitsChartEl.style.display = "none";
        if (!placeId) {
          console.error("Place ID is undefined");
          this.isDetailedView = false;
          return;
        }
        await this.showTripsForPlace(placeId);
        if (visitsTableContainer) visitsTableContainer.style.display = "none";
        if (tripsForPlaceContainer)
          tripsForPlaceContainer.style.display = "block";
        if (toggleViewBtn) toggleViewBtn.textContent = "Show All Places";
      } else {
        if (visitsChartEl) visitsChartEl.style.display = "block";
        if (visitsTableContainer) visitsTableContainer.style.display = "block";
        if (tripsForPlaceContainer)
          tripsForPlaceContainer.style.display = "none";
        if (toggleViewBtn)
          toggleViewBtn.textContent = "Show Trips for Selected Place";
      }
    }

    async showTripsForPlace(placeId) {
      try {
        const response = await fetch(`/api/places/${placeId}/trips`);
        if (!response.ok) throw new Error("Failed to fetch trips for place");
        const trips = await response.json();
        trips.sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
        if (this.tripsTable) {
          this.tripsTable.clear().rows.add(trips).draw();
        }
      } catch (error) {
        console.error("Error fetching trips for place:", error);
        if (window.notificationManager) {
          window.notificationManager.show(
            "Failed to fetch trips for place",
            "danger"
          );
        }
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
        if (window.notificationManager) {
          window.notificationManager.show(
            "Failed to load non-custom places visits",
            "danger"
          );
        }
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.visitsManager = new VisitsManager();
  });
})();
