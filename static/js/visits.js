/* global L, Chart, DateUtils, bootstrap, $, MapboxDraw, mapboxgl */

"use strict";
(() => {
  class VisitsManager {
    constructor() {
      this.map = null;
      this.places = new Map();
      this.placeLayers = new Map();
      this.drawControl = null;
      this.currentPolygon = null;
      this.visitsChart = null;
      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.drawingEnabled = false;
      this.customPlacesLayer = null;
      this.loadingManager = window.loadingManager;
      this.isDetailedView = false;
      this.placeBeingEdited = null;
      this.tripViewMap = null;
      this.tripViewLayerGroup = null;
      this.isCustomPlacesVisible = true;
      // Mapbox specific state
      this.customPlacesData = { type: "FeatureCollection", features: [] };
      this.placeFeatures = new Map(); // Map placeId -> feature id
      this.activePopup = null; // Currently open popup instance
      this.startMarker = null;
      this.endMarker = null;

      this.setupDurationSorting();
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
        await Promise.all([
          this.loadPlaces(),
          this.loadNonCustomPlacesVisits(),
        ]);
        this.loadingManager.finish("Initializing Visits Page");
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
      }
    }

    initializeMap() {
      return new Promise((resolve, reject) => {
        try {
          const theme =
            document.documentElement.getAttribute("data-bs-theme") || "dark";

          // Create Mapbox map instance (helper supports both libs)
          this.map = window.mapBase.createMap("map", {
            library: "mapbox",
            style:
              theme === "light"
                ? "mapbox://styles/mapbox/light-v11"
                : "mapbox://styles/mapbox/dark-v11",
            center: [-95.7129, 37.0902], // USA centroid as default
            zoom: 4,
            attributionControl: false,
          });

          // Wait for map load before continuing
          this.map.on("load", () => {
            // GeoJSON source that will hold ALL custom places
            if (this.map.getSource("custom-places")) {
              this.map.removeLayer("custom-places-fill");
              this.map.removeLayer("custom-places-outline");
              this.map.removeSource("custom-places");
            }

            this.map.addSource("custom-places", {
              type: "geojson",
              data: this.customPlacesData,
            });

            // Fill layer
            this.map.addLayer({
              id: "custom-places-fill",
              type: "fill",
              source: "custom-places",
              paint: {
                "fill-color": "#BB86FC",
                "fill-opacity": 0.15,
              },
            });

            // Outline layer
            this.map.addLayer({
              id: "custom-places-outline",
              type: "line",
              source: "custom-places",
              paint: {
                "line-color": "#BB86FC",
                "line-width": 2,
              },
            });

            // Cursor feedback
            this.map.on("mouseenter", "custom-places-fill", () => {
              this.map.getCanvas().style.cursor = "pointer";
            });
            this.map.on("mouseleave", "custom-places-fill", () => {
              this.map.getCanvas().style.cursor = "";
            });

            // Click interaction – show statistics
            this.map.on("click", "custom-places-fill", (e) => {
              const feature = e.features?.[0];
              if (!feature) return;
              const placeId = feature.properties?.placeId;
              if (placeId) {
                this.showPlaceStatistics(placeId, e.lngLat);
              }
            });

            resolve();
          });
        } catch (err) {
          console.error("VisitsManager: Map initialization error", err);
          reject(err);
        }
      });
    }

    updateMapTheme(theme) {
      if (!this.map) return;

      const styleUrl =
        theme === "light"
          ? "mapbox://styles/mapbox/light-v11"
          : "mapbox://styles/mapbox/dark-v11";

      this.map.setStyle(styleUrl);

      // After style reload we need to re-add our custom places source/layers
      this.map.once("styledata", () => {
        if (!this.map.getSource("custom-places")) {
          this.map.addSource("custom-places", {
            type: "geojson",
            data: this.customPlacesData,
          });

          this.map.addLayer({
            id: "custom-places-fill",
            type: "fill",
            source: "custom-places",
            paint: {
              "fill-color": "#BB86FC",
              "fill-opacity": 0.15,
            },
          });

          this.map.addLayer({
            id: "custom-places-outline",
            type: "line",
            source: "custom-places",
            paint: {
              "line-color": "#BB86FC",
              "line-width": 2,
            },
          });
        }
      });
    }

    initializeDrawControls() {
      if (typeof MapboxDraw === "undefined") {
        console.error("MapboxDraw library not loaded");
        return;
      }

      this.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true,
        },
        defaultMode: "draw_polygon",
        styles: [
          // Fill
          {
            id: "gl-draw-polygon-fill-inactive",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "false"]],
            paint: {
              "fill-color": "#BB86FC",
              "fill-opacity": 0.15,
            },
          },
          {
            id: "gl-draw-polygon-fill-active",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
            paint: {
              "fill-color": "#F59E0B",
              "fill-opacity": 0.1,
            },
          },
          // Outline
          {
            id: "gl-draw-polygon-stroke-inactive",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "false"]],
            paint: {
              "line-color": "#BB86FC",
              "line-width": 2,
            },
          },
          {
            id: "gl-draw-polygon-stroke-active",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
            paint: {
              "line-color": "#F59E0B",
              "line-width": 2,
            },
          },
        ],
      });

      if (this.map) {
        this.map.addControl(this.draw, "top-left");

        this.map.on("draw.create", (e) => this.onPolygonCreated(e));
      }
    }

    initializeChart() {
      const ctx = document.getElementById("visitsChart")?.getContext("2d");
      if (!ctx) {
        console.warn("Visits chart canvas not found.");
        return;
      }

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
          maintainAspectRatio: false,
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
              grid: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
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
          onClick: (event, elements) => {
            if (elements.length > 0) {
              const chartElement = elements[0];
              const placeName =
                this.visitsChart.data.labels[chartElement.index];
              const placeEntry = Array.from(this.places.entries()).find(
                ([, placeData]) => placeData.name === placeName,
              );
              if (placeEntry) {
                const [placeId] = placeEntry;
                this.toggleView(placeId);
              }
            }
          },
        },
      });
    }

    initializeTables() {
      this.initVisitsTable();
      this.initNonCustomVisitsTable();
      this.initTripsTable();
    }

    static convertDurationToSeconds(duration) {
      if (!duration || duration === "N/A" || duration === "Unknown") return 0;
      let seconds = 0;
      const dayMatch = duration.match(/(\d+)\s*d/);
      const hourMatch = duration.match(/(\d+)\s*h/);
      const minuteMatch = duration.match(/(\d+)\s*m/);
      const secondMatch = duration.match(/(\d+)\s*s/);

      if (dayMatch) seconds += parseInt(dayMatch[1]) * 86400;
      if (hourMatch) seconds += parseInt(hourMatch[1]) * 3600;
      if (minuteMatch) seconds += parseInt(minuteMatch[1]) * 60;
      if (secondMatch) seconds += parseInt(secondMatch[1]);
      return seconds;
    }

    setupDurationSorting() {
      if (window.$ && $.fn.dataTable) {
        $.fn.dataTable.ext.type.order["duration-pre"] = (data) => {
          return VisitsManager.convertDurationToSeconds(data);
        };
      } else {
        window.notificationManager?.show(
          "jQuery DataTables not available for duration sorting setup.",
          "warning",
        );
      }
    }

    initVisitsTable() {
      const el = document.getElementById("visits-table");
      if (!el || !window.$) return;

      const headers = [
        "Place",
        "Total Visits",
        "First Visit",
        "Last Visit",
        "Avg Time Spent",
      ];

      this.visitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]],
        columns: [
          {
            data: "name",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="place-link" data-place-id="${row._id}">${data}</a>`
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-end",
            render: (data) => data || 0,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                  : "N/A"
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "lastVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                  : "N/A"
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "avgTimeSpent",
            className: "numeric-cell text-end",
            type: "duration",
            render: (data) => data || "N/A",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable: "No visits recorded for custom places",
          info: "_START_ to _END_ of _TOTAL_ places",
          search: "",
          placeholder: "Filter places...",
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
        columnDefs: [{ type: "duration", targets: 4 }],
      });
    }

    initNonCustomVisitsTable() {
      const el = document.getElementById("non-custom-visits-table");
      if (!el || !window.$) return;

      const headers = ["Place", "Total Visits", "First Visit", "Last Visit"];

      this.nonCustomVisitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]],
        columns: [
          {
            data: "name",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-end",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                  : "N/A"
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "lastVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                  : "N/A"
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable: "No visits recorded for non-custom places",
          info: "_START_ to _END_ of _TOTAL_ places",
          search: "",
          placeholder: "Filter places...",
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

      const headers = [
        "Trip ID",
        "Date",
        "Time",
        "Departure Time",
        "Time Spent",
        "Time Since Last Visit",
        "Actions",
      ];

      this.tripsTable = $(el).DataTable({
        responsive: true,
        order: [[1, "desc"]],
        columns: [
          {
            data: "transactionId",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="trip-id-link" data-trip-id="${row.id}">${data}</a>`
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "endTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "endTime", // Intentionally duplicated for time part
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
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
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "timeSpent",
            className: "numeric-cell text-end",
            type: "duration",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "timeSinceLastVisit",
            className: "numeric-cell text-end",
            type: "duration",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: null,
            className: "action-cell",
            orderable: false,
            render: (data, type, row) =>
              type === "display"
                ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}"><i class="fas fa-map-marker-alt me-1"></i> View</button>`
                : "",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable: "No trips found for this place",
          info: "_START_ to _END_ of _TOTAL_ trips",
          search: "",
          placeholder: "Filter trips...",
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
        columnDefs: [{ type: "duration", targets: [4, 5] }],
      });

      $(el)
        .find("tbody")
        .on("mousedown", ".view-trip-btn, .trip-id-link", (e) => {
          if (e.button !== 0) return;
          const tripId = $(e.currentTarget).data("trip-id");
          if (tripId) {
            this.confirmViewTripOnMap(tripId);
          } else {
            console.warn(
              "Could not find trip-id data attribute on clicked element.",
            );
          }
        });
    }

    setupEventListeners() {
      document
        .getElementById("start-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.startDrawing();
        });
      document
        .getElementById("save-place")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.savePlace();
        });
      document
        .getElementById("clear-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.clearCurrentDrawing();
        });

      document
        .getElementById("zoom-to-fit")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.zoomToFitAllPlaces();
        });

      document
        .getElementById("manage-places")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.showManagePlacesModal();
        });
      document
        .getElementById("edit-place-form")
        ?.addEventListener("submit", (e) => {
          e.preventDefault();
          this.saveEditedPlace();
        });
      document
        .getElementById("edit-place-boundary")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.startEditingPlaceBoundary();
        });
      document
        .getElementById("toggle-custom-places")
        ?.addEventListener("change", (e) =>
          this.toggleCustomPlacesVisibility(e.target.checked),
        );

      document
        .getElementById("back-to-places-btn")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.toggleView();
        });
      $("#visits-table").on("mousedown", ".place-link", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const placeId = $(event.target).data("place-id");
        if (placeId) {
          this.toggleView(placeId);
        }
      });
    }

    async loadPlaces() {
      this.loadingManager.startOperation("Initializing Visits Page");
      try {
        const response = await fetch("/api/places");
        if (!response.ok)
          throw new Error(`Failed to fetch places: ${response.statusText}`);
        const places = await response.json();

        this.places.clear();
        this.placeLayers.clear?.(); // Legacy no-op if not used
        this.customPlacesData.features = [];
        this.placeFeatures.clear();
        if (this.map && this.map.getSource("custom-places")) {
          this.map.getSource("custom-places").setData(this.customPlacesData);
        }

        places.forEach((place) => {
          this.places.set(place._id, place);
          this.displayPlace(place);
        });

        await this.updateVisitsData();
        this.loadingManager.updateSubOperation(
          "Initializing Visits Page",
          "Loading Places",
          100,
        );
      } catch (error) {
        console.error("Error loading places:", error);
        window.notificationManager?.show(
          "Failed to load custom places",
          "danger",
        );
        this.loadingManager.error("Failed during Loading Places sub-operation");
      }
    }

    displayPlace(place) {
      if (!place || !place.geometry || !place._id) {
        console.warn("Attempted to display invalid place:", place);
        return;
      }

      // Build feature
      const feature = {
        type: "Feature",
        geometry: place.geometry,
        properties: {
          placeId: place._id,
          name: place.name,
        },
      };

      // Store mapping for quick removal later
      this.placeFeatures.set(place._id, feature);

      // Push to collection and update source
      this.customPlacesData.features.push(feature);

      if (this.map && this.map.getSource("custom-places")) {
        this.map.getSource("custom-places").setData(this.customPlacesData);
      }
    }

    async updateVisitsData() {
      this.loadingManager.startOperation("Fetching Stats");
      const placeEntries = Array.from(this.places.entries());
      if (placeEntries.length === 0) {
        if (this.visitsChart) {
          this.visitsChart.data.labels = [];
          this.visitsChart.data.datasets[0].data = [];
          this.visitsChart.update();
        }
        if (this.visitsTable) {
          this.visitsTable.clear().draw();
        }
        this.loadingManager.updateSubOperation(
          "Initializing Visits Page",
          "Fetching Stats",
          100,
        );
        return;
      }
      try {
        const response = await fetch("/api/places/statistics");
        if (!response.ok) throw new Error("Failed to fetch place statistics");
        const statsList = await response.json();
        statsList.sort((a, b) => a.name.localeCompare(b.name));
        const validResults = statsList.map((d) => ({
          _id: d._id,
          name: d.name,
          totalVisits: d.totalVisits,
          firstVisit: d.firstVisit,
          lastVisit: d.lastVisit,
          avgTimeSpent: d.averageTimeSpent || "N/A",
        }));
        if (this.visitsChart) {
          this.visitsChart.data.labels = validResults.map((d) => d.name);
          this.visitsChart.data.datasets[0].data = validResults.map(
            (d) => d.totalVisits,
          );
          this.visitsChart.update();
        }
        if (this.visitsTable) {
          this.visitsTable.clear().rows.add(validResults).draw();
        }
      } catch (error) {
        console.error("Error updating place statistics:", error);
        window.notificationManager?.show(
          "Error updating place statistics",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Fetching Stats");
      }
    }

    async savePlace() {
      const placeNameInput = document.getElementById("place-name");
      const placeName = placeNameInput?.value.trim();

      if (!placeName) {
        window.notificationManager?.show(
          "Please enter a name for the place.",
          "warning",
        );
        placeNameInput?.focus();
        return;
      }
      if (!this.currentPolygon) {
        window.notificationManager?.show(
          "Please draw a boundary for the place first.",
          "warning",
        );
        return;
      }

      this.loadingManager.startOperation("Saving Place");
      try {
        const geoJsonGeometry = this.currentPolygon.geometry;

        const response = await fetch("/api/places", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: placeName, geometry: geoJsonGeometry }),
        });

        if (!response.ok)
          throw new Error(`Failed to save place: ${response.statusText}`);

        const savedPlace = await response.json();

        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);
        await this.updateVisitsData();
        this.resetDrawing();

        window.notificationManager?.show(
          `Place "${placeName}" saved successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error saving place:", error);
        window.notificationManager?.show(
          "Failed to save place. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Saving Place");
      }
    }

    async deletePlace(placeId) {
      const placeToDelete = this.places.get(placeId);
      if (!placeToDelete) {
        window.notificationManager?.show(
          "Attempted to delete non-existent place.",
          "warning",
        );
        return;
      }

      let confirmed = false;
      if (window.confirmationDialog) {
        confirmed = await window.confirmationDialog.show({
          title: "Delete Place",
          message: `Are you sure you want to delete the place "<strong>${placeToDelete.name}</strong>"? This cannot be undone.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
      } else {
        confirmed = true;
      }

      if (!confirmed) return;

      this.loadingManager.startOperation("Deleting Place");
      try {
        const response = await fetch(`/api/places/${placeId}`, {
          method: "DELETE",
        });
        if (!response.ok)
          throw new Error(`Failed to delete place: ${response.statusText}`);

        this.places.delete(placeId);

        // Remove feature from map source
        if (this.placeFeatures.has(placeId)) {
          const feature = this.placeFeatures.get(placeId);
          this.customPlacesData.features = this.customPlacesData.features.filter(
            (f) => f !== feature,
          );
          this.placeFeatures.delete(placeId);
          if (this.map && this.map.getSource("custom-places")) {
            this.map.getSource("custom-places").setData(this.customPlacesData);
          }
        }

        await this.updateVisitsData();

        this.refreshManagePlacesModal();

        window.notificationManager?.show(
          `Place "${placeToDelete.name}" deleted successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting place:", error);
        window.notificationManager?.show(
          "Failed to delete place. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Deleting Place");
      }
    }

    startDrawing() {
      if (this.drawingEnabled || !this.draw) return;

      this.resetDrawing(false);

      // Enter draw mode
      this.draw.changeMode("draw_polygon");

      this.drawingEnabled = true;

      document.getElementById("start-drawing")?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", true);

      window.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point to finish.",
        "info",
      );
    }

    onPolygonCreated(event) {
      if (!event?.features || event.features.length === 0) return;

      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
      }

      this.currentPolygon = event.features[0];

      // Switch to select mode, keep the new polygon selected so it's still visible
      this.draw.changeMode("simple_select", { featureIds: [this.currentPolygon.id] });

      this.drawingEnabled = false;

      document.getElementById("start-drawing")?.classList.remove("active");
      document.getElementById("save-place")?.removeAttribute("disabled");

      window.notificationManager?.show(
        "Boundary drawn. Enter a name and click Save Place.",
        "info",
      );
    }

    clearCurrentDrawing() {
      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
        document.getElementById("save-place")?.setAttribute("disabled", true);
        window.notificationManager?.show("Drawing cleared.", "info");
      }

      if (this.drawingEnabled) {
        this.draw.changeMode("simple_select");
        this.drawingEnabled = false;
        document.getElementById("start-drawing")?.classList.remove("active");
      }
    }

    resetDrawing(removeControl = true) {
      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
      }

      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) placeNameInput.value = "";
      if (savePlaceBtn) savePlaceBtn.setAttribute("disabled", true);
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      if (this.drawingEnabled && removeControl) {
        this.draw.changeMode("simple_select");
      }
      this.drawingEnabled = false;
      this.placeBeingEdited = null;
    }

    startEditingPlaceBoundary() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const place = this.places.get(placeId);
      if (!place) {
        window.notificationManager?.show(
          "Could not find place to edit.",
          "warning",
        );
        return;
      }

      const editModalEl = document.getElementById("edit-place-modal");
      if (editModalEl) {
        const editModal = bootstrap.Modal.getInstance(editModalEl);
        editModal?.hide();
      }

      this.resetDrawing(false);

      if (place.geometry && this.map) {
        // Simple fit bounds to existing geometry
        try {
          const coords = place.geometry.coordinates.flat(2);
          if (coords.length >= 2) {
            let minX = coords[0][0],
              minY = coords[0][1],
              maxX = coords[0][0],
              maxY = coords[0][1];
            coords.forEach((c) => {
              if (!Array.isArray(c)) return;
              const [lng, lat] = c;
              if (lng < minX) minX = lng;
              if (lng > maxX) maxX = lng;
              if (lat < minY) minY = lat;
              if (lat > maxY) maxY = lat;
            });
            this.map.fitBounds(
              [
                [minX, minY],
                [maxX, maxY],
              ],
              { padding: 20 },
            );
          }
        } catch (e) {
          console.warn("Failed to compute bounds for existing geometry", e);
        }
      }

      this.placeBeingEdited = placeId;

      this.startDrawing();

      window.notificationManager?.show(
        `Draw the new boundary for "${place.name}". The previous boundary is shown dashed. Finish drawing, then save changes via the Manage Places modal.`,
        "info",
        10000,
      );
    }

    /* eslint-disable-next-line complexity */
    async saveEditedPlace() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const newNameInput = document.getElementById("edit-place-name");
      const newName = newNameInput?.value.trim();

      if (!placeId || !newName) {
        window.notificationManager?.show(
          "Place ID or Name is missing.",
          "warning",
        );
        newNameInput?.focus();
        return;
      }

      const placeToUpdate = this.places.get(placeId);
      if (!placeToUpdate) {
        window.notificationManager?.show(
          "Cannot find place to update.",
          "danger",
        );
        return;
      }

      this.loadingManager.startOperation("Updating Place");
      try {
        const requestBody = { name: newName };

        if (this.currentPolygon && this.placeBeingEdited === placeId) {
          requestBody.geometry = this.currentPolygon.geometry;
        }

        const response = await fetch(`/api/places/${placeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok)
          throw new Error(`Failed to update place: ${response.statusText}`);

        const updatedPlace = await response.json();

        this.places.set(placeId, updatedPlace);

        // Replace feature in source
        if (this.placeFeatures.has(placeId)) {
          const oldFeature = this.placeFeatures.get(placeId);
          this.customPlacesData.features = this.customPlacesData.features.filter(
            (f) => f !== oldFeature,
          );
          this.placeFeatures.delete(placeId);
        }

        this.displayPlace(updatedPlace);

        // Update source data
        if (this.map && this.map.getSource("custom-places")) {
          this.map.getSource("custom-places").setData(this.customPlacesData);
        }

        await this.updateVisitsData();

        const modalEl = document.getElementById("edit-place-modal");
        if (modalEl) {
          const modal = bootstrap.Modal.getInstance(modalEl);
          modal?.hide();
        }

        if (requestBody.geometry) {
          this.resetDrawing();
        }
        this.placeBeingEdited = null;

        window.notificationManager?.show(
          `Place "${newName}" updated successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error updating place:", error);
        window.notificationManager?.show(
          "Failed to update place. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Updating Place");
      }
    }

    showManagePlacesModal() {
      const modalElement = document.getElementById("manage-places-modal");
      if (!modalElement) return;

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      this.refreshManagePlacesModal();
      modal.show();
    }

    refreshManagePlacesModal() {
      const tableBody = document.querySelector("#manage-places-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = "";

      const placesArray = Array.from(this.places.values());
      placesArray.sort((a, b) => a.name.localeCompare(b.name));

      if (placesArray.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="2">No custom places defined yet.</td></tr>';
        return;
      }

      placesArray.forEach((place) => {
        const row = tableBody.insertRow();
        row.innerHTML = `
                <td>${place.name}</td>
                <td>
                    <div class="btn-group btn-group-sm" role="group">
                    <button type="button" class="btn btn-primary edit-place-btn" data-place-id="${place._id}" title="Edit Name/Boundary">
                        <i class="fas fa-edit"></i> Edit
                    </button>
                    <button type="button" class="btn btn-danger delete-place-btn" data-place-id="${place._id}" title="Delete Place">
                        <i class="fas fa-trash-alt"></i> Delete
                    </button>
                    </div>
                </td>
            `;

        row.querySelector(".edit-place-btn").addEventListener("click", (e) => {
          const placeId = e.currentTarget.getAttribute("data-place-id");
          bootstrap.Modal.getInstance(
            document.getElementById("manage-places-modal"),
          )?.hide();
          this.showEditPlaceModal(placeId);
        });

        row
          .querySelector(".delete-place-btn")
          .addEventListener("click", (e) => {
            const placeId = e.currentTarget.getAttribute("data-place-id");
            bootstrap.Modal.getInstance(
              document.getElementById("manage-places-modal"),
            )?.hide();
            this.deletePlace(placeId);
          });
      });
    }

    showEditPlaceModal(placeId) {
      const place = this.places.get(placeId);
      if (!place) return;

      const modalElement = document.getElementById("edit-place-modal");
      if (!modalElement) return;

      document.getElementById("edit-place-id").value = placeId;
      document.getElementById("edit-place-name").value = place.name;

      this.placeBeingEdited = null;
      if (this.currentPolygon) {
        this.resetDrawing();
      }

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      modal.show();
    }

    confirmViewTripOnMap(tripId) {
      if (!tripId) {
        return;
      }
      this.fetchAndShowTrip(tripId);
    }

    async fetchAndShowTrip(tripId) {
      this.loadingManager.startOperation("Fetching Trip Data");
      try {
        const response = await fetch(`/api/trips/${tripId}`);
        if (!response.ok)
          throw new Error(
            `Failed to fetch trip ${tripId}: ${response.statusText}`,
          );

        const tripResponse = await response.json();
        const trip = tripResponse.trip || tripResponse;

        VisitsManager.extractTripGeometry(trip);
        this.showTripOnMap(trip);
      } catch (error) {
        console.error("Error fetching or showing trip data:", error);
        this.loadingManager.error("Failed to fetch trip data");
        window.notificationManager?.show(
          "Error loading trip data. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Fetching Trip Data");
      }
    }

    /* eslint-disable-next-line complexity */
    static extractTripGeometry(trip) {
      // Prioritize using trip.gps if it's already a valid GeoJSON object
      if (
        trip.gps &&
        typeof trip.gps === "object" &&
        trip.gps.type === "LineString" &&
        trip.gps.coordinates &&
        trip.gps.coordinates.length > 0
      ) {
        trip.geometry = trip.gps;
        return;
      }

      if (trip.geometry?.coordinates && trip.geometry.coordinates.length > 0) {
        return; // Already has geometry
      }
      if (
        trip.matchedGps?.coordinates &&
        trip.matchedGps.coordinates.length > 0
      ) {
        trip.geometry = trip.matchedGps;
        return;
      }
      // Fallback for older data where trip.gps might be a string
      if (typeof trip.gps === "string" && trip.gps) {
        try {
          const gpsData = JSON.parse(trip.gps);
          if (gpsData?.coordinates && gpsData.coordinates.length > 0) {
            trip.geometry = gpsData;
            return;
          }
        } catch (e) {
          console.error("Failed to parse gps JSON", e);
          window.notificationManager?.show(
            "Failed to parse gps JSON.",
            "danger",
          );
        }
      }
      if (
        trip.startGeoPoint?.coordinates &&
        trip.destinationGeoPoint?.coordinates
      ) {
        trip.geometry = {
          type: "LineString",
          coordinates: [
            trip.startGeoPoint.coordinates,
            trip.destinationGeoPoint.coordinates,
          ],
        };
        return;
      }
    }

    showTripOnMap(trip) {
      const modalElement = document.getElementById("view-trip-modal");
      const tripInfoContainer = document.getElementById("trip-info");
      if (!modalElement || !tripInfoContainer) {
        console.error("Trip view modal elements not found.");
        return;
      }

      const startTime = trip.startTime
        ? DateUtils.formatForDisplay(trip.startTime, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "Unknown";
      const endTime = trip.endTime
        ? DateUtils.formatForDisplay(trip.endTime, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "Unknown";

      let formattedDistance = "Unknown";
      if (trip.distance) {
        let distanceValue =
          typeof trip.distance === "object" && trip.distance.value !== undefined
            ? trip.distance.value
            : trip.distance;
        distanceValue = parseFloat(distanceValue);
        if (!isNaN(distanceValue) && distanceValue >= 0) {
          formattedDistance = `${distanceValue.toFixed(2)} miles`;
        }
      }
      const transactionId = trip.transactionId || trip.id || trip._id;
      const startLocation =
        trip.startLocation?.formatted_address || trip.startPlace || "Unknown";
      const endLocation =
        trip.destination?.formatted_address ||
        trip.destinationPlace ||
        "Unknown";

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

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);

      modalElement.removeEventListener(
        "shown.bs.modal",
        this._handleTripModalShown,
      );
      this._handleTripModalShown = () => this.initializeOrUpdateTripMap(trip);
      modalElement.addEventListener(
        "shown.bs.modal",
        this._handleTripModalShown,
        { once: true },
      );

      modal.show();
    }

    initializeOrUpdateTripMap(trip) {
      const mapContainer = document.getElementById("trip-map-container");
      if (!mapContainer) {
        console.error("Trip map container not found in modal.");
        return;
      }

      if (!this.tripViewMap) {
        const mapElement = document.createElement("div");
        mapElement.id = "trip-map-instance";
        mapElement.style.height = "100%";
        mapElement.style.width = "100%";
        mapContainer.innerHTML = "";
        mapContainer.appendChild(mapElement);

        const theme =
          document.documentElement.getAttribute("data-bs-theme") || "dark";

        this.tripViewMap = new mapboxgl.Map({
          container: mapElement.id,
          style:
            theme === "light"
              ? "mapbox://styles/mapbox/light-v11"
              : "mapbox://styles/mapbox/dark-v11",
          center: [-95.7129, 37.0902],
          zoom: 4,
          attributionControl: false,
        });

        this.tripViewMap.on("load", () => {
          this.updateTripMapData(trip);
        });
      } else {
        this.updateTripMapData(trip);
      }
    }

    updateTripMapData(trip) {
      if (!this.tripViewMap) {
        console.error("Trip view map not ready");
        return;
      }

      // Remove existing layers/sources
      if (this.tripViewMap.getLayer("trip-path")) {
        this.tripViewMap.removeLayer("trip-path");
      }
      if (this.tripViewMap.getSource("trip")) {
        this.tripViewMap.removeSource("trip");
      }

      this.startMarker?.remove();
      this.endMarker?.remove();

      document.getElementById("trip-info").querySelector(".alert")?.remove();

      if (trip.geometry?.coordinates && trip.geometry.coordinates.length > 0) {
        try {
          this.tripViewMap.addSource("trip", { type: "geojson", data: trip.geometry });

          this.tripViewMap.addLayer({
            id: "trip-path",
            type: "line",
            source: "trip",
            paint: { "line-color": "#BB86FC", "line-width": 4 },
          });

          const coordinates = trip.geometry.coordinates;
          const startCoord = coordinates[0];
          const endCoord = coordinates[coordinates.length - 1];

          if (Array.isArray(startCoord) && startCoord.length >= 2) {
            this.startMarker = new mapboxgl.Marker({ color: "#22c55e" })
              .setLngLat(startCoord)
              .setPopup(new mapboxgl.Popup().setText("Start"))
              .addTo(this.tripViewMap);
          }

          if (Array.isArray(endCoord) && endCoord.length >= 2) {
            this.endMarker = new mapboxgl.Marker({ color: "#ef4444" })
              .setLngLat(endCoord)
              .setPopup(new mapboxgl.Popup().setText("End"))
              .addTo(this.tripViewMap);
          }

          // Fit bounds
          const bounds = coordinates.reduce(
            (b, c) => b.extend(c),
            new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]),
          );
          this.tripViewMap.fitBounds(bounds, { padding: 25, maxZoom: 17 });
        } catch (error) {
          console.error("Error processing trip geometry:", error);
          document.getElementById("trip-info").innerHTML +=
            '<div class="alert alert-danger mt-2">Error displaying trip route.</div>';
        }
      } else {
        document.getElementById("trip-info").innerHTML +=
          '<div class="alert alert-warning mt-2">No route data available for this trip.</div>';
        this.tripViewMap.setCenter([-95.7129, 37.0902]);
        this.tripViewMap.setZoom(4);
      }

      this.tripViewMap.resize();
    }

    async showPlaceStatistics(placeId, lngLat = null) {
      const place = this.places.get(placeId);
      if (!place || !this.map) return;

      // Close any existing popup
      if (this.activePopup) {
        this.activePopup.remove();
      }

      // Determine popup location if not provided (fallback to first coordinate)
      if (!lngLat && place.geometry?.coordinates) {
        const first = place.geometry.coordinates[0][0];
        lngLat = { lng: first[0], lat: first[1] };
      }

      this.activePopup = new mapboxgl.Popup({ offset: 8 })
        .setLngLat(lngLat)
        .setHTML(`<h6>${place.name}</h6><p><i>Fetching details...</i></p>`)
        .addTo(this.map);

      try {
        const response = await fetch(`/api/places/${placeId}/statistics`);
        if (!response.ok)
          throw new Error(`Failed to fetch stats: ${response.statusText}`);

        const stats = await response.json();

        const formatDate = (dateStr) =>
          dateStr
            ? DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" })
            : "N/A";
        const formatAvg = (value) => value || "N/A";

        const popupContent = `
              <div class="custom-place-popup">
              <h6>${place.name}</h6>
              <p>Total Visits: <strong>${stats.totalVisits || 0}</strong></p>
              <p>First Visit: ${formatDate(stats.firstVisit)}</p>
              <p>Last Visit: ${formatDate(stats.lastVisit)}</p>
              <p>Avg Time Spent: ${formatAvg(stats.averageTimeSpent)}</p>
              <p>Avg Time Since Last: ${formatAvg(stats.averageTimeSinceLastVisit)}</p>
               <hr style="margin: 5px 0;">
               <button class="btn btn-sm btn-outline-primary w-100 view-trips-btn" data-place-id="${placeId}">
                  <i class="fas fa-list-ul me-1"></i> View Trips
               </button>
              </div>`;

        this.activePopup.setHTML(popupContent);

        // Attach event listener once contents rendered
        setTimeout(() => {
          const popupNode = this.activePopup.getElement();
          popupNode
            ?.querySelector(".view-trips-btn")
            ?.addEventListener("click", (e) => {
              e.preventDefault();
              const id = e.currentTarget.getAttribute("data-place-id");
              if (id) {
                this.activePopup?.remove();
                this.toggleView(id);
              }
            });
        }, 100);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        this.activePopup.setHTML(
          `<h6>${place.name}</h6><p><i>Error loading statistics.</i></p>`,
        );
        window.notificationManager?.show(
          "Failed to fetch place statistics",
          "danger",
        );
      }
    }

    async toggleView(placeId = null) {
      const mainViewContainer = document.getElementById(
        "visits-table-container",
      );
      const detailViewContainer = document.getElementById(
        "trips-for-place-container",
      );

      if (placeId) {
        const place = this.places.get(placeId);
        if (!place) {
          console.error(
            `Cannot switch to detail view: Place ID ${placeId} not found.`,
          );
          window.notificationManager?.show(
            "Could not find the selected place.",
            "warning",
          );
          return;
        }

        this.isDetailedView = true;
        mainViewContainer.style.display = "none";
        detailViewContainer.style.display = "block";

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement) placeNameElement.textContent = place.name;

        await this.showTripsForPlace(placeId);
      } else {
        this.isDetailedView = false;
        detailViewContainer.style.display = "none";
        mainViewContainer.style.display = "block";

        if (this.visitsChart) {
          this.visitsChart.resize();
        }
        if (this.visitsTable?.responsive?.recalc) {
          this.visitsTable.columns.adjust().responsive.recalc();
        }
        if (this.nonCustomVisitsTable?.responsive?.recalc) {
          this.nonCustomVisitsTable.columns.adjust().responsive.recalc();
        }
      }
    }

    async showTripsForPlace(placeId) {
      if (!this.tripsTable) {
        console.error("Trips table not initialized.");
        return;
      }
      this.loadingManager.startOperation("Loading Trips for Place");
      this.tripsTable.clear().draw();

      try {
        const response = await fetch(`/api/places/${placeId}/trips`);
        if (!response.ok)
          throw new Error(`Failed to fetch trips: ${response.statusText}`);

        const data = await response.json();
        const trips = data.trips || [];

        this.tripsTable.rows.add(trips).draw();

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement && data.name)
          placeNameElement.textContent = data.name;
      } catch (error) {
        console.error(`Error fetching trips for place ${placeId}:`, error);
        window.notificationManager?.show(
          "Failed to fetch trips for the selected place.",
          "danger",
        );
        this.tripsTable.clear().draw();
      } finally {
        this.loadingManager.finish("Loading Trips for Place");
      }
    }

    async loadNonCustomPlacesVisits() {
      if (!this.nonCustomVisitsTable) return;
      this.loadingManager.addSubOperation(
        "Initializing Visits Page",
        "Loading Non-Custom Visits",
      );
      try {
        const response = await fetch("/api/non_custom_places_visits");
        if (!response.ok)
          throw new Error(
            `Failed to fetch non-custom visits: ${response.statusText}`,
          );
        const visitsData = await response.json();
        this.nonCustomVisitsTable.clear().rows.add(visitsData).draw();
        this.loadingManager.updateSubOperation(
          "Initializing Visits Page",
          "Loading Non-Custom Visits",
          100,
        );
      } catch (error) {
        console.error("Error fetching non-custom places visits:", error);
        window.notificationManager?.show(
          "Failed to load non-custom places visits",
          "danger",
        );
        this.loadingManager.error(
          "Failed during Loading Non-Custom Visits sub-operation",
        );
      }
    }

    toggleCustomPlacesVisibility(isVisible) {
      this.isCustomPlacesVisible = isVisible;

      if (this.map) {
        const visibility = isVisible ? "visible" : "none";
        ["custom-places-fill", "custom-places-outline"].forEach((layerId) => {
          if (this.map.getLayer(layerId)) {
            this.map.setLayoutProperty(layerId, "visibility", visibility);
          }
        });
      }

      const customContent = document.getElementById("custom-places-content");
      const customTabButton = document.getElementById("custom-places-tab");

      if (isVisible) {
        customContent?.classList.remove("hidden");
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = "";
        }

        if (!customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab?.classList.contains("active")) {
            bootstrap.Tab.getOrCreateInstance(customTabButton)?.show();
          }
        }
      } else {
        customContent?.classList.add("hidden");
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = "none";
        }

        if (customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab) {
            bootstrap.Tab.getOrCreateInstance(nonCustomTab)?.show();
          }
        }
      }
    }

    zoomToFitAllPlaces() {
      if (!this.map || this.customPlacesData.features.length === 0) {
        window.notificationManager?.show(
          "No custom places found to zoom to.",
          "info",
        );
        return;
      }

      let minX, minY, maxX, maxY;
      this.customPlacesData.features.forEach((feature) => {
        const coords = feature.geometry.coordinates.flat(2);
        coords.forEach(([lng, lat]) => {
          if (minX === undefined) {
            minX = maxX = lng;
            minY = maxY = lat;
          } else {
            if (lng < minX) minX = lng;
            if (lng > maxX) maxX = lng;
            if (lat < minY) minY = lat;
            if (lat > maxY) maxY = lat;
          }
        });
      });

      if (minX !== undefined) {
        this.map.fitBounds(
          [
            [minX, minY],
            [maxX, maxY],
          ],
          { padding: 20 },
        );
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (
      typeof L !== "undefined" &&
      typeof Chart !== "undefined" &&
      typeof $ !== "undefined" &&
      typeof bootstrap !== "undefined" &&
      typeof DateUtils !== "undefined" &&
      typeof window.mapBase !== "undefined" &&
      typeof window.mapBase.createMap === "function"
    ) {
      window.visitsManager = new VisitsManager();
    } else {
      const missingLibraries = [];
      if (typeof L === "undefined") missingLibraries.push("Leaflet");
      if (typeof Chart === "undefined") missingLibraries.push("Chart.js");
      if (typeof $ === "undefined") missingLibraries.push("jQuery");
      if (typeof bootstrap === "undefined") missingLibraries.push("Bootstrap");
      if (typeof DateUtils === "undefined") missingLibraries.push("DateUtils");
      if (typeof window.mapBase === "undefined")
        missingLibraries.push("mapBase (window.mapBase)");
      else if (typeof window.mapBase.createMap !== "function")
        missingLibraries.push("mapBase.createMap (function missing)");

      const errorMessage = `One or more critical libraries not loaded or improperly configured: ${missingLibraries.join(", ")}. Visits page cannot initialize.`;
      console.error(errorMessage);
      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.textContent =
        "Error: Could not load necessary components for the Visits page. Please check the console for details, try refreshing the page, or contact support.";
      document.body.prepend(errorDiv);
    }
  });
})();
