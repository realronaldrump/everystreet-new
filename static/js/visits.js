/* global L, Chart, DateUtils, bootstrap, $ */

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
      return new Promise((resolve) => {
        // Use shared map factory
        this.map = window.mapBase.createMap("map", {
          library: "leaflet",
          center: [37.0902, -95.7129],
          zoom: 4,
          zoomControl: true,
          tileLayer:
            "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          tileOptions: { maxZoom: 19 },
        });
        this.customPlacesLayer = L.featureGroup().addTo(this.map);
        document.addEventListener("themeChanged", (e) =>
          this.updateMapTheme(e.detail.theme),
        );
        resolve();
      });
    }

    updateMapTheme(theme) {
      if (!this.map) return;

      this.map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
          this.map.removeLayer(layer);
        }
      });

      const tileUrls = {
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      };

      const tileUrl = tileUrls[theme] || tileUrls.dark;
      L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(this.map);
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
            shapeOptions: { color: "#BB86FC", weight: 2 },
          },
          circle: false,
          rectangle: false,
          circlemarker: false,
          marker: false,
          polyline: false,
        },
        edit: {
          featureGroup: this.customPlacesLayer,
          remove: false,
        },
      });
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
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-center",
            render: (data) => data || 0,
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

      this.nonCustomVisitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]],
        columns: [
          { data: "name" },
          { data: "totalVisits", className: "numeric-cell text-center" },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
                  : "N/A"
                : data,
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
          { data: "timeSpent", className: "numeric-cell", type: "duration" },
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
                ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}"><i class="fas fa-map-marker-alt me-1"></i> View</button>`
                : "",
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

      this.map.on(L.Draw.Event.CREATED, (e) => this.onPolygonCreated(e));
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
        this.placeLayers.clear();
        this.customPlacesLayer.clearLayers();

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
      if (!this.customPlacesLayer) {
        console.error("customPlacesLayer is not initialized!");
        return;
      }

      try {
        const polygon = L.geoJSON(place.geometry, {
          style: {
            color: "#BB86FC",
            fillColor: "#BB86FC",
            fillOpacity: 0.15,
            weight: 2,
          },
          onEachFeature(feature) {
            feature.properties = feature.properties || {};
            feature.properties.placeId = place._id;
            feature.properties.placeName = place.name;
          },
        });

        polygon.bindPopup(`<h6>${place.name}</h6><p>Loading statistics...</p>`);

        polygon.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          this.showPlaceStatistics(place._id);
        });

        this.customPlacesLayer.addLayer(polygon);
        this.placeLayers.set(place._id, polygon);
      } catch (error) {
        console.error(
          `Error creating GeoJSON layer for place ${place.name} (${place._id}):`,
          error,
        );
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
        const geoJsonGeometry = this.currentPolygon.toGeoJSON().geometry;

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

        const layerToRemove = this.placeLayers.get(placeId);
        if (layerToRemove) {
          this.customPlacesLayer.removeLayer(layerToRemove);
          this.placeLayers.delete(placeId);
        } else {
          this.customPlacesLayer.eachLayer((layer) => {
            if (layer.feature?.properties?.placeId === placeId) {
              this.customPlacesLayer.removeLayer(layer);
            }
          });
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
      if (this.drawingEnabled) {
        return;
      }
      this.resetDrawing(false);

      this.map.addControl(this.drawControl);
      new L.Draw.Polygon(
        this.map,
        this.drawControl.options.draw.polygon,
      ).enable();

      this.drawingEnabled = true;
      document.getElementById("start-drawing")?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", true);
      window.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point to finish.",
        "info",
      );
    }

    onPolygonCreated(event) {
      if (this.currentPolygon) {
        this.map.removeLayer(this.currentPolygon);
      }
      this.currentPolygon = event.layer;
      this.map.addLayer(this.currentPolygon);

      this.map.removeControl(this.drawControl);
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
        this.map.removeLayer(this.currentPolygon);
        this.currentPolygon = null;
        document.getElementById("save-place")?.setAttribute("disabled", true);
        window.notificationManager?.show("Drawing cleared.", "info");
      }
      if (this.drawingEnabled) {
        this.map.eachLayer((layer) => {
          if (layer instanceof L.Draw.Polygon && layer.editing?._enabled) {
            layer.disableEdit?.();
          }
        });
        this.map.removeControl(this.drawControl);
        this.drawingEnabled = false;
        document.getElementById("start-drawing")?.classList.remove("active");
      }
    }

    resetDrawing(removeControl = true) {
      if (this.currentPolygon) {
        this.map.removeLayer(this.currentPolygon);
        this.currentPolygon = null;
      }

      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) placeNameInput.value = "";
      if (savePlaceBtn) savePlaceBtn.setAttribute("disabled", true);
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      if (this.drawingEnabled && removeControl) {
        try {
          this.map.removeControl(this.drawControl);
        } catch (e) {
          console.warn(
            "Could not remove draw control (might not have been added):",
            e,
          );
        }
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

      if (place.geometry) {
        try {
          const existingPolygon = L.geoJSON(place.geometry, {
            style: {
              color: "#FFC107",
              fillOpacity: 0.1,
              weight: 1,
              dashArray: "5, 5",
            },
          }).addTo(this.map);
          this.map.fitBounds(existingPolygon.getBounds().pad(0.1));

          this._tempOldBoundary = existingPolygon;
        } catch (e) {
          console.error("Error displaying existing geometry for editing:", e);
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
          requestBody.geometry = this.currentPolygon.toGeoJSON().geometry;
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

        const oldLayer = this.placeLayers.get(placeId);
        if (oldLayer) {
          this.customPlacesLayer.removeLayer(oldLayer);
          this.placeLayers.delete(placeId);
        }
        this.displayPlace(updatedPlace);

        if (this._tempOldBoundary) {
          this.map.removeLayer(this._tempOldBoundary);
          this._tempOldBoundary = null;
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

        this.tripViewMap = L.map(mapElement.id, { attributionControl: false });
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", // Use current theme? Needs access or event
          { maxZoom: 19 },
        ).addTo(this.tripViewMap);
        this.tripViewLayerGroup = L.layerGroup().addTo(this.tripViewMap);
      }

      this.updateTripMapData(trip);
    }

    updateTripMapData(trip) {
      if (!this.tripViewMap || !this.tripViewLayerGroup) {
        console.error("Trip view map or layer group not ready for update.");
        return;
      }

      this.tripViewLayerGroup.clearLayers();
      document.getElementById("trip-info").querySelector(".alert")?.remove();

      if (trip.geometry?.coordinates && trip.geometry.coordinates.length > 0) {
        try {
          const tripPath = L.geoJSON(trip.geometry, {
            style: { color: "#BB86FC", weight: 4, opacity: 0.8 },
          });
          this.tripViewLayerGroup.addLayer(tripPath);

          const coordinates = trip.geometry.coordinates;
          if (coordinates.length > 0) {
            const startCoord = coordinates[0];
            const endCoord = coordinates[coordinates.length - 1];

            if (
              Array.isArray(startCoord) &&
              startCoord.length >= 2 &&
              !isNaN(startCoord[0]) &&
              !isNaN(startCoord[1])
            ) {
              L.marker([startCoord[1], startCoord[0]], {
                icon: L.divIcon({
                  className: "trip-marker start-marker",
                  html: '<i class="fas fa-play-circle"></i>',
                  iconSize: [20, 20],
                  iconAnchor: [10, 10],
                }),
              })
                .bindTooltip("Start")
                .addTo(this.tripViewLayerGroup);
            } else {
              console.warn("Invalid start coordinate:", startCoord);
            }

            if (
              Array.isArray(endCoord) &&
              endCoord.length >= 2 &&
              !isNaN(endCoord[0]) &&
              !isNaN(endCoord[1])
            ) {
              L.marker([endCoord[1], endCoord[0]], {
                icon: L.divIcon({
                  className: "trip-marker end-marker",
                  html: '<i class="fas fa-stop-circle"></i>',
                  iconSize: [20, 20],
                  iconAnchor: [10, 10],
                }),
              })
                .bindTooltip("End")
                .addTo(this.tripViewLayerGroup);
            } else {
              console.warn("Invalid end coordinate:", endCoord);
            }

            this.tripViewMap.fitBounds(tripPath.getBounds(), {
              padding: [25, 25],
              maxZoom: 17,
            });
          }
        } catch (error) {
          console.error("Error processing trip geometry for map:", error);
          document.getElementById("trip-info").innerHTML +=
            '<div class="alert alert-danger mt-2">Error displaying trip route.</div>';
        }
      } else {
        document.getElementById("trip-info").innerHTML +=
          '<div class="alert alert-warning mt-2">No route data available for this trip.</div>';
        this.tripViewMap.setView([37.0902, -95.7129], 4);
      }

      this.tripViewMap.invalidateSize();
    }

    async showPlaceStatistics(placeId) {
      const place = this.places.get(placeId);
      const layer = this.placeLayers.get(placeId);
      if (!place || !layer) return;

      layer
        .setPopupContent(
          `<h6>${place.name}</h6><p><i>Fetching details...</i></p>`,
        )
        .openPopup();

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
                </div>
            `;

        layer.setPopupContent(popupContent);

        setTimeout(() => {
          const popupNode = layer.getPopup()?.getElement();
          if (popupNode) {
            popupNode
              .querySelector(".view-trips-btn")
              ?.addEventListener("click", (e) => {
                e.preventDefault();
                const id = e.currentTarget.getAttribute("data-place-id");
                if (id) {
                  layer.closePopup();
                  this.toggleView(id);
                }
              });
          }
        }, 100);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        layer.setPopupContent(
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
      const customContent = document.getElementById("custom-places-content");
      const customTabButton = document.getElementById("custom-places-tab");

      if (isVisible) {
        if (this.customPlacesLayer) this.map.addLayer(this.customPlacesLayer);
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
        if (this.customPlacesLayer)
          this.map.removeLayer(this.customPlacesLayer);
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
      if (!this.customPlacesLayer || !this.map) return;

      const bounds = this.customPlacesLayer.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds.pad(0.1));
      } else {
        window.notificationManager?.show(
          "No custom places found to zoom to.",
          "info",
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
      typeof DateUtils !== "undefined"
    ) {
      window.visitsManager = new VisitsManager();
    } else {
      console.error(
        "One or more critical libraries (Leaflet, Chart.js, jQuery, Bootstrap, DateUtils) not loaded. Visits page cannot initialize.",
      );
      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.textContent =
        "Error: Could not load necessary components for the Visits page. Please try refreshing the page or contact support.";
      document.body.prepend(errorDiv);
    }
  });
})();
