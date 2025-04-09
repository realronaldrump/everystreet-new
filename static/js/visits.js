/* global L, Chart, DateUtils, bootstrap, $ */

"use strict";
(() => {
  class VisitsManager {
    constructor() {
      this.map = null;
      this.places = new Map(); // Stores place data { _id: { name, geometry, ... } }
      this.placeLayers = new Map(); // Stores Leaflet layers { _id: polygonLayer }
      this.drawControl = null;
      this.currentPolygon = null; // The polygon currently being drawn/edited
      this.visitsChart = null;
      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.drawingEnabled = false;
      this.customPlacesLayer = null; // Layer group for custom place polygons
      this.loadingManager =
        window.loadingManager || this.createFallbackLoadingManager();
      this.isDetailedView = false; // Tracks if showing trips for a single place
      this.placeBeingEdited = null; // ID of place being edited (name or boundary)
      this.tripViewMap = null; // Leaflet map instance for the trip view modal
      this.tripViewLayerGroup = null; // Layer group for trip path/markers in modal
      this.isCustomPlacesVisible = true; // Tracks visibility state for toggle checkbox

      this.setupDurationSorting();
      this.initialize();
    }

    // --- Initialization & Setup ---

    createFallbackLoadingManager() {
      // ... (keep original fallback)
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
        this.setupEventListeners(); // Setup listeners after tables are initialized
        await Promise.all([
          this.loadPlaces(), // Loads places and populates map/table
          this.loadNonCustomPlacesVisits(),
        ]);
        this.loadingManager.finish("Initializing Visits Page");
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
          zoomControl: true, // Use Leaflet's default zoom control
        });

        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          { maxZoom: 19 },
        ).addTo(this.map);

        // Layer group to hold all custom place polygons - Use FeatureGroup for Leaflet.Draw compatibility
        this.customPlacesLayer = L.featureGroup().addTo(this.map);

        // Add listener for theme changes to update map tiles
        document.addEventListener("themeChanged", (e) => {
          this.updateMapTheme(e.detail.theme);
        });

        resolve();
      });
    }

    updateMapTheme(theme) {
      if (!this.map) return;

      // Remove existing tile layers
      this.map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
          this.map.removeLayer(layer);
        }
      });

      // Define tile URLs
      const tileUrls = {
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      };

      // Add the new tile layer
      const tileUrl = tileUrls[theme] || tileUrls.dark; // Default to dark
      L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(this.map);
    }

    initializeDrawControls() {
      // Initialize the draw control but don't add it to the map yet
      this.drawControl = new L.Control.Draw({
        draw: {
          polygon: {
            allowIntersection: false,
            drawError: {
              color: "#e1e100",
              message: "<strong>Error:</strong> Shape edges cannot cross!",
            },
            shapeOptions: { color: "#BB86FC", weight: 2 }, // Slightly thinner line
          },
          // Disable other drawing tools
          circle: false,
          rectangle: false,
          circlemarker: false,
          marker: false,
          polyline: false,
        },
        edit: {
          // Add edit options if needed later, but keep simple for now
          featureGroup: this.customPlacesLayer, // Required for editing existing layers
          remove: false, // Disable deleting via draw control, use Manage Places modal
        },
      });
    }

    initializeChart() {
      const ctx = document.getElementById("visitsChart")?.getContext("2d");
      if (!ctx) {
        console.warn("Visits chart canvas not found.");
        return;
      }

      // Ensure Chart.js defaults are set (might be set globally elsewhere)
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
          maintainAspectRatio: false, // Allow chart to fill container height better
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
            }, // Hide x-axis grid lines
          },
          plugins: {
            legend: { display: false }, // Hide legend if only one dataset
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
                ([id, place]) => place.name === placeName,
              );
              if (placeEntry) {
                const [placeId, place] = placeEntry;
                this.toggleView(placeId); // Switch to detailed view for this place
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

    // --- DataTable Initializations (with Duration Sorting) ---

    convertDurationToSeconds(duration) {
      // ... (keep original conversion logic)
      if (!duration || duration === "N/A" || duration === "Unknown") return 0;
      let seconds = 0;
      const dayMatch = duration.match(/(\d+)\s*d/); // Allow optional space
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
        // Custom sorting type for durations like "1h 30m", "2d", "45s"
        $.fn.dataTable.ext.type.order["duration-pre"] = (data) => {
          return this.convertDurationToSeconds(data);
        };
      } else {
        console.warn(
          "jQuery DataTables not available for duration sorting setup.",
        );
      }
    }

    initVisitsTable() {
      const el = document.getElementById("visits-table");
      if (!el || !window.$) return;

      this.visitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]], // Default sort by Last Visit (descending)
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
          }, // Center align counts
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
          }, // Use custom duration sort type
        ],
        language: {
          emptyTable: "No visits recorded for custom places",
          info: "_START_ to _END_ of _TOTAL_ places",
          search: "",
          placeholder: "Filter places...",
        }, // Use placeholder for search
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
        columnDefs: [
          { type: "duration", targets: 4 }, // Apply duration sorting to the 5th column (index 4)
        ],
      });
    }

    initNonCustomVisitsTable() {
      const el = document.getElementById("non-custom-visits-table");
      if (!el || !window.$) return;

      this.nonCustomVisitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]], // Default sort by Last Visit
        columns: [
          { data: "name" }, // Non-custom places are not clickable to detail view
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
        order: [[1, "desc"]], // Default sort by Arrival Date
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
          }, // Arrival Date
          {
            data: "endTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                : data,
          }, // Arrival Time
          {
            data: "departureTime",
            className: "date-cell",
            render: (data, type) =>
              type === "display" || type === "filter"
                ? data
                  ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                  : "Unknown"
                : data,
          }, // Departure Time
          { data: "timeSpent", className: "numeric-cell", type: "duration" }, // Duration of Stay
          {
            data: "timeSinceLastVisit",
            className: "numeric-cell",
            type: "duration",
          }, // Time Since Last
          {
            data: null,
            className: "action-cell",
            orderable: false,
            render: (data, type, row) =>
              type === "display"
                ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}"><i class="fas fa-map-marker-alt me-1"></i> View</button>`
                : "",
          }, // Actions
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
        columnDefs: [
          { type: "duration", targets: [4, 5] }, // Apply duration sort to columns 4 and 5
        ],
      });

      // Attach single delegated event listener to the table body
      $(el)
        .find("tbody")
        .on("click", ".view-trip-btn, .trip-id-link", (e) => {
          e.preventDefault();
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

    // --- Event Listeners ---

    setupEventListeners() {
      // Drawing Controls
      document
        .getElementById("start-drawing")
        ?.addEventListener("click", () => this.startDrawing());
      document
        .getElementById("save-place")
        ?.addEventListener("click", () => this.savePlace());
      document
        .getElementById("clear-drawing")
        ?.addEventListener("click", () => this.clearCurrentDrawing()); // Added listener

      // Map Interaction
      this.map.on(L.Draw.Event.CREATED, (e) => this.onPolygonCreated(e));
      document
        .getElementById("zoom-to-fit")
        ?.addEventListener("click", () => this.zoomToFitAllPlaces()); // Added listener

      // Place Management
      document
        .getElementById("manage-places")
        ?.addEventListener("click", () => this.showManagePlacesModal());
      document
        .getElementById("edit-place-form")
        ?.addEventListener("submit", (e) => {
          e.preventDefault();
          this.saveEditedPlace();
        });
      document
        .getElementById("edit-place-boundary")
        ?.addEventListener("click", () => this.startEditingPlaceBoundary());
      document
        .getElementById("toggle-custom-places")
        ?.addEventListener("change", (e) =>
          this.toggleCustomPlacesVisibility(e.target.checked),
        ); // Added listener

      // View Toggling & Details
      document
        .getElementById("back-to-places-btn")
        ?.addEventListener("click", () => this.toggleView()); // Back from trips view
      // Use event delegation for place links in the visits table
      $("#visits-table").on("click", ".place-link", (event) => {
        event.preventDefault();
        const placeId = $(event.target).data("place-id");
        if (placeId) {
          this.toggleView(placeId); // Switch to detailed view
        }
      });

      // Removed listener for non-functional #toggle-view-btn in main container
    }

    // --- Core Functionality: Places ---

    async loadPlaces() {
      this.loadingManager.addSubOperation(
        "Initializing Visits Page",
        "Loading Places",
      );
      try {
        const response = await fetch("/api/places");
        if (!response.ok)
          throw new Error(`Failed to fetch places: ${response.statusText}`);
        const places = await response.json();

        this.places.clear();
        this.placeLayers.clear();
        this.customPlacesLayer.clearLayers(); // Clear existing map layers

        places.forEach((place) => {
          this.places.set(place._id, place);
          this.displayPlace(place); // Add place to map
        });

        // Update statistics *after* loading all places
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
          }, // Adjusted style
          // Add properties to the feature for easier lookup later
          onEachFeature: function (feature, layer) {
            feature.properties = feature.properties || {};
            feature.properties.placeId = place._id;
            feature.properties.placeName = place.name;
          },
        });

        // Basic popup, content updated later by showPlaceStatistics
        polygon.bindPopup(`<h6>${place.name}</h6><p>Loading statistics...</p>`);

        // Click event to show detailed stats (could also open detail view)
        polygon.on("click", (e) => {
          L.DomEvent.stopPropagation(e); // Prevent map click
          this.showPlaceStatistics(place._id); // Fetch and update popup
          // Optionally: this.toggleView(place._id); // Or switch to trip view on click
        });

        this.customPlacesLayer.addLayer(polygon);
        this.placeLayers.set(place._id, polygon); // Store layer reference
      } catch (error) {
        console.error(
          `Error creating GeoJSON layer for place ${place.name} (${place._id}):`,
          error,
        );
      }
    }

    async updateVisitsData() {
      // --- N+1 Fetch Warning ---
      // This function currently makes one API call per custom place to get statistics.
      // For a large number of places, this is inefficient (N+1 problem).
      // Consider modifying the backend API (e.g., /api/places or a new /api/places/statistics)
      // to return all places with their statistics in a single call.
      // --- End Warning ---

      this.loadingManager.addSubOperation(
        "Initializing Visits Page",
        "Fetching Stats",
      );
      const placeEntries = Array.from(this.places.entries());
      if (placeEntries.length === 0) {
        // If no places, clear chart and table
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

      const statsPromises = placeEntries.map(async ([id, place], index) => {
        try {
          const response = await fetch(`/api/places/${id}/statistics`);
          if (!response.ok) {
            console.warn(
              `Failed to fetch statistics for place ${place.name} (${id}): ${response.statusText}`,
            );
            return null; // Return null on error for this place
          }
          const stats = await response.json();
          // Update progress (approximate)
          const progress = ((index + 1) / placeEntries.length) * 100;
          this.loadingManager.updateSubOperation(
            "Initializing Visits Page",
            "Fetching Stats",
            progress,
          );
          return {
            _id: id,
            name: place.name,
            totalVisits: stats.totalVisits || 0,
            firstVisit: stats.firstVisit,
            lastVisit: stats.lastVisit,
            avgTimeSpent: stats.averageTimeSpent || "N/A", // Use API response directly
            // Add other stats if needed by tables/chart
          };
        } catch (error) {
          console.error(
            `Error fetching statistics for place ${place.name} (${id}):`,
            error,
          );
          return null; // Return null on fetch error
        }
      });

      try {
        const results = await Promise.all(statsPromises);
        const validResults = results.filter((result) => result !== null); // Filter out errors

        // Sort results alphabetically by name for consistent chart/table order
        validResults.sort((a, b) => a.name.localeCompare(b.name));

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
        console.error("Error processing place statistics:", error);
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
        this.displayPlace(savedPlace); // Add the new place to the map
        await this.updateVisitsData(); // Refresh table/chart data
        this.resetDrawing(); // Clear the drawing state

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
        console.warn("Attempted to delete non-existent place ID:", placeId);
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
        confirmed = confirm(
          `Are you sure you want to delete the place "${placeToDelete.name}"?`,
        );
      }

      if (!confirmed) return;

      this.loadingManager.startOperation("Deleting Place");
      try {
        const response = await fetch(`/api/places/${placeId}`, {
          method: "DELETE",
        });
        if (!response.ok)
          throw new Error(`Failed to delete place: ${response.statusText}`);

        // Remove from internal state
        this.places.delete(placeId);

        // Remove from map
        const layerToRemove = this.placeLayers.get(placeId);
        if (layerToRemove) {
          this.customPlacesLayer.removeLayer(layerToRemove);
          this.placeLayers.delete(placeId);
        } else {
          // Fallback if layer wasn't in map cache (shouldn't happen often)
          this.customPlacesLayer.eachLayer((layer) => {
            if (layer.feature?.properties?.placeId === placeId) {
              this.customPlacesLayer.removeLayer(layer);
            }
          });
        }

        await this.updateVisitsData(); // Refresh table/chart

        // Refresh the manage places modal if it's open or might be opened soon
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

    // --- Drawing and Editing ---

    startDrawing() {
      if (this.drawingEnabled) {
        // If already drawing, perhaps cancel it or do nothing
        console.log("Drawing already enabled.");
        return;
      }
      // Ensure any previous drawing state is cleared
      this.resetDrawing(false); // Don't remove draw control yet

      this.map.addControl(this.drawControl);
      // Manually trigger the polygon drawing tool
      new L.Draw.Polygon(
        this.map,
        this.drawControl.options.draw.polygon,
      ).enable();

      this.drawingEnabled = true;
      document.getElementById("start-drawing")?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", true); // Disable save until drawn
      window.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point to finish.",
        "info",
      );
    }

    onPolygonCreated(event) {
      // Called when Leaflet.Draw finishes creating a polygon
      if (this.currentPolygon) {
        // If editing, replace the old polygon visually (save happens separately)
        this.map.removeLayer(this.currentPolygon);
      }
      this.currentPolygon = event.layer;
      this.map.addLayer(this.currentPolygon);

      // Disable the drawing tool after creation
      // Note: L.Draw doesn't have a simple 'disable' on the instance.
      // We remove the control and reset state.
      this.map.removeControl(this.drawControl);
      this.drawingEnabled = false;
      document.getElementById("start-drawing")?.classList.remove("active");
      document.getElementById("save-place")?.removeAttribute("disabled"); // Enable save button
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
      // If drawing was active, disable it
      if (this.drawingEnabled) {
        // Find the active draw handler and disable it (more robust way needed if available)
        this.map.eachLayer((layer) => {
          if (layer instanceof L.Draw.Polygon && layer.editing?._enabled) {
            layer.disableEdit?.(); // If editing was somehow enabled
          }
        });
        this.map.removeControl(this.drawControl); // Remove control to stop drawing mode
        this.drawingEnabled = false;
        document.getElementById("start-drawing")?.classList.remove("active");
      }
    }

    resetDrawing(removeControl = true) {
      // Clear polygon from map
      if (this.currentPolygon) {
        this.map.removeLayer(this.currentPolygon);
        this.currentPolygon = null;
      }

      // Reset UI elements
      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) placeNameInput.value = "";
      if (savePlaceBtn) savePlaceBtn.setAttribute("disabled", true);
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      // Disable drawing mode if active
      if (this.drawingEnabled && removeControl) {
        try {
          // Add try-catch as removing control might error if not added
          this.map.removeControl(this.drawControl);
        } catch (e) {
          console.warn(
            "Could not remove draw control (might not have been added):",
            e,
          );
        }
      }
      this.drawingEnabled = false;
      this.placeBeingEdited = null; // Ensure edit state is cleared
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

      // Hide the edit modal
      const editModalEl = document.getElementById("edit-place-modal");
      if (editModalEl) {
        const editModal = bootstrap.Modal.getInstance(editModalEl);
        editModal?.hide();
      }

      this.resetDrawing(false); // Clear previous drawing state, keep control reference

      // Add existing polygon to map temporarily for reference
      if (place.geometry) {
        try {
          const existingPolygon = L.geoJSON(place.geometry, {
            style: {
              color: "#FFC107",
              fillOpacity: 0.1,
              weight: 1,
              dashArray: "5, 5",
            }, // Style to indicate it's the old boundary
          }).addTo(this.map);
          // Remove it after a short delay or after drawing starts? For now, keep it.
          // Or maybe just fit bounds to it?
          this.map.fitBounds(existingPolygon.getBounds().pad(0.1)); // Zoom to the area

          // Store reference to remove later?
          this._tempOldBoundary = existingPolygon;
        } catch (e) {
          console.error("Error displaying existing geometry for editing:", e);
        }
      }

      this.placeBeingEdited = placeId; // Set the ID being edited

      // Enable drawing
      this.startDrawing(); // Re-use the start drawing logic

      // Update notification
      window.notificationManager?.show(
        `Draw the new boundary for "${place.name}". The previous boundary is shown dashed. Finish drawing, then save changes via the Manage Places modal.`,
        "info",
        10000, // Longer duration
      );
      // The save will happen via the modal's save button now (`saveEditedPlace`)
      // We need to ensure `this.currentPolygon` is set when drawing finishes.
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
        let requestBody = { name: newName };

        // Check if a new boundary was drawn *specifically for this place*
        if (this.currentPolygon && this.placeBeingEdited === placeId) {
          requestBody.geometry = this.currentPolygon.toGeoJSON().geometry;
          console.log("Including updated geometry in PATCH request.");
        } else {
          console.log("Geometry not updated or placeBeingEdited ID mismatch.");
        }

        const response = await fetch(`/api/places/${placeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok)
          throw new Error(`Failed to update place: ${response.statusText}`);

        const updatedPlace = await response.json();

        // Update internal state
        this.places.set(placeId, updatedPlace);

        // Update map: Remove old layer, add new one
        const oldLayer = this.placeLayers.get(placeId);
        if (oldLayer) {
          this.customPlacesLayer.removeLayer(oldLayer);
          this.placeLayers.delete(placeId);
        }
        this.displayPlace(updatedPlace); // Display the updated place

        // Remove the temporary dashed boundary if it exists
        if (this._tempOldBoundary) {
          this.map.removeLayer(this._tempOldBoundary);
          this._tempOldBoundary = null;
        }

        await this.updateVisitsData(); // Refresh table/chart

        // Close modal only if it's still open
        const modalEl = document.getElementById("edit-place-modal");
        if (modalEl) {
          const modal = bootstrap.Modal.getInstance(modalEl);
          modal?.hide();
        }

        // Reset drawing state if a geometry was updated
        if (requestBody.geometry) {
          this.resetDrawing();
        }
        this.placeBeingEdited = null; // Clear edit state

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

    // --- Manage Places Modal ---

    showManagePlacesModal() {
      const modalElement = document.getElementById("manage-places-modal");
      if (!modalElement) return;

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      this.refreshManagePlacesModal(); // Populate content
      modal.show();
    }

    refreshManagePlacesModal() {
      const tableBody = document.querySelector("#manage-places-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = ""; // Clear existing rows

      const placesArray = Array.from(this.places.values());
      placesArray.sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically

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

        // Add listeners directly here for simplicity since rows are recreated
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
            this.deletePlace(placeId); // deletePlace now handles confirmation
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

      // Reset potential leftover drawing state from previous edits
      this.placeBeingEdited = null; // Only set this when 'Edit Boundary' is clicked
      if (this.currentPolygon) {
        this.resetDrawing();
      }

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      modal.show();
    }

    // --- Trip Viewing ---

    confirmViewTripOnMap(tripId) {
      if (!tripId) {
        console.warn("confirmViewTripOnMap called with no tripId");
        return;
      }
      // Can add confirmation dialog here if needed, but currently just fetches directly
      this.fetchAndShowTrip(tripId);
    }

    async fetchAndShowTrip(tripId) {
      this.loadingManager.startOperation("Fetching Trip Data");
      try {
        console.log(`Fetching trip data for ID: ${tripId}`);
        const response = await fetch(`/api/trips/${tripId}`);
        if (!response.ok)
          throw new Error(
            `Failed to fetch trip ${tripId}: ${response.statusText}`,
          );

        const tripResponse = await response.json();
        console.log("Trip response received:", tripResponse);
        const trip = tripResponse.trip || tripResponse; // Adapt to potential API response structure

        this.extractTripGeometry(trip); // Ensure geometry is present or derived
        this.showTripOnMap(trip); // Display modal and prepare map data
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

    extractTripGeometry(trip) {
      // ... (keep original logic, seems reasonable)
      if (trip.geometry?.coordinates && trip.geometry.coordinates.length > 0) {
        console.log("Using existing geometry data");
        return;
      }
      if (
        trip.matchedGps?.coordinates &&
        trip.matchedGps.coordinates.length > 0
      ) {
        console.log("Using matchedGps data");
        trip.geometry = trip.matchedGps;
        return;
      }
      if (typeof trip.gps === "string" && trip.gps) {
        try {
          console.log("Parsing gps field from JSON string");
          const gpsData = JSON.parse(trip.gps);
          if (gpsData?.coordinates && gpsData.coordinates.length > 0) {
            console.log("Successfully parsed gps JSON data");
            trip.geometry = gpsData;
            return;
          }
        } catch (e) {
          console.error("Failed to parse gps JSON:", e);
        }
      }
      if (
        trip.startGeoPoint?.coordinates &&
        trip.destinationGeoPoint?.coordinates
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

    showTripOnMap(trip) {
      const modalElement = document.getElementById("view-trip-modal");
      const tripInfoContainer = document.getElementById("trip-info");
      if (!modalElement || !tripInfoContainer) {
        console.error("Trip view modal elements not found.");
        return;
      }

      // 1. Populate Trip Info
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
          // Allow 0 distance
          formattedDistance = `${distanceValue.toFixed(2)} miles`;
        }
      }
      const transactionId = trip.transactionId || trip.id || trip._id; // Use available ID
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

      // 2. Show Modal
      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);

      // 3. Initialize or Update Map on Modal Shown
      // Use 'shown.bs.modal' to ensure modal dimensions are ready for map rendering
      modalElement.removeEventListener(
        "shown.bs.modal",
        this._handleTripModalShown,
      ); // Remove previous listener
      this._handleTripModalShown = () => this.initializeOrUpdateTripMap(trip); // Store handler reference
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

      // Initialize map ONLY if it doesn't exist
      if (!this.tripViewMap) {
        // Create the map div dynamically ONLY ONCE
        const mapElement = document.createElement("div");
        mapElement.id = "trip-map-instance"; // Give it a unique ID
        mapElement.style.height = "100%";
        mapElement.style.width = "100%";
        mapContainer.innerHTML = ""; // Clear container
        mapContainer.appendChild(mapElement);

        this.tripViewMap = L.map(mapElement.id, { attributionControl: false });
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", // Use current theme? Needs access or event
          { maxZoom: 19 },
        ).addTo(this.tripViewMap);
        this.tripViewLayerGroup = L.layerGroup().addTo(this.tripViewMap); // Group for trip layers
        console.log("Trip view map initialized.");
      }

      // Always update the map data
      this.updateTripMapData(trip);
    }

    updateTripMapData(trip) {
      if (!this.tripViewMap || !this.tripViewLayerGroup) {
        console.error("Trip view map or layer group not ready for update.");
        return;
      }

      // Clear previous trip layers
      this.tripViewLayerGroup.clearLayers();
      document.getElementById("trip-info").querySelector(".alert")?.remove(); // Clear old warnings

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

            // Ensure coords are valid numbers
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

            // Fit bounds after adding layers
            this.tripViewMap.fitBounds(tripPath.getBounds(), {
              padding: [25, 25],
              maxZoom: 17,
            }); // Add padding
          }
        } catch (error) {
          console.error("Error processing trip geometry for map:", error);
          document.getElementById("trip-info").innerHTML +=
            `<div class="alert alert-danger mt-2">Error displaying trip route.</div>`;
        }
      } else {
        // No route data, maybe show start/end points if available?
        document.getElementById("trip-info").innerHTML +=
          `<div class="alert alert-warning mt-2">No route data available for this trip.</div>`;
        // Set a default view if no geometry
        this.tripViewMap.setView([37.0902, -95.7129], 4);
      }

      // Crucial step after adding/removing layers or showing modal
      this.tripViewMap.invalidateSize();
    }

    // --- Place Statistics Popups ---

    async showPlaceStatistics(placeId) {
      const place = this.places.get(placeId);
      const layer = this.placeLayers.get(placeId);
      if (!place || !layer) return;

      // Show basic info immediately
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
        const formatAvg = (value) => value || "N/A"; // Assuming API returns formatted string

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

        // Add listener for the button inside the popup (needs careful handling)
        // Use a timeout to ensure the popup DOM is ready
        setTimeout(() => {
          const popupNode = layer.getPopup()?.getElement();
          if (popupNode) {
            popupNode
              .querySelector(".view-trips-btn")
              ?.addEventListener("click", (e) => {
                e.preventDefault();
                const id = e.currentTarget.getAttribute("data-place-id");
                if (id) {
                  layer.closePopup(); // Close popup before switching view
                  this.toggleView(id);
                }
              });
          }
        }, 100); // Small delay
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

    // --- View Toggling ---

    async toggleView(placeId = null) {
      const mainViewContainer = document.getElementById(
        "visits-table-container",
      );
      const detailViewContainer = document.getElementById(
        "trips-for-place-container",
      );

      if (placeId) {
        // Switch TO detailed view
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

        await this.showTripsForPlace(placeId); // Load and display trips
      } else {
        // Switch BACK to main view
        this.isDetailedView = false;
        detailViewContainer.style.display = "none";
        mainViewContainer.style.display = "block";

        // Optional: Refresh main view data if needed
        // await this.updateVisitsData();

        // Ensure chart resizes correctly if it was hidden
        if (this.visitsChart) {
          this.visitsChart.resize();
        }
        // Ensure tables redraw correctly if they were hidden
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
      this.tripsTable.clear().draw(); // Clear previous data and show loading indicator potentially
      // Optionally add a processing indicator to the table:
      // $(this.tripsTable.table().container()).addClass('processing');

      try {
        const response = await fetch(`/api/places/${placeId}/trips`);
        if (!response.ok)
          throw new Error(`Failed to fetch trips: ${response.statusText}`);

        const data = await response.json();
        const trips = data.trips || []; // Expecting { trips: [], name: 'Place Name' }

        this.tripsTable.rows.add(trips).draw(); // Add new data

        // Update place name in header (already done in toggleView, but good practice)
        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement && data.name)
          placeNameElement.textContent = data.name;
      } catch (error) {
        console.error(`Error fetching trips for place ${placeId}:`, error);
        window.notificationManager?.show(
          "Failed to fetch trips for the selected place.",
          "danger",
        );
        // Show error in table
        this.tripsTable.clear().draw(); // Clear again before showing empty message
      } finally {
        // Remove processing indicator:
        // $(this.tripsTable.table().container()).removeClass('processing');
        this.loadingManager.finish("Loading Trips for Place");
      }
    }

    // --- Non-Custom Places ---

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

    // --- UI Helpers / Toggles ---

    toggleCustomPlacesVisibility(isVisible) {
      this.isCustomPlacesVisible = isVisible;
      const customContent = document.getElementById("custom-places-content");
      const customTabButton = document.getElementById("custom-places-tab");

      if (isVisible) {
        if (this.customPlacesLayer) this.map.addLayer(this.customPlacesLayer);
        customContent?.classList.remove("hidden"); // Or use Bootstrap classes if tabs handle hiding
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = ""; // Show tab
        }

        // If the non-custom tab was active, switch back to custom
        if (!customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab?.classList.contains("active")) {
            bootstrap.Tab.getOrCreateInstance(customTabButton)?.show();
          }
        }
      } else {
        if (this.customPlacesLayer)
          this.map.removeLayer(this.customPlacesLayer);
        customContent?.classList.add("hidden"); // Or use Bootstrap classes
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = "none"; // Hide tab
        }

        // If the custom tab was active, switch to non-custom if available
        if (customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab) {
            bootstrap.Tab.getOrCreateInstance(nonCustomTab)?.show();
          }
        }
      }
      // Optional: Refit map bounds if zoomToFit was used previously
      // this.zoomToFitAllPlaces();
    }

    zoomToFitAllPlaces() {
      if (!this.customPlacesLayer || !this.map) return;

      const bounds = this.customPlacesLayer.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds.pad(0.1)); // Add some padding
      } else {
        window.notificationManager?.show(
          "No custom places found to zoom to.",
          "info",
        );
      }
    }
  } // End VisitsManager Class

  // --- Global Instantiation ---
  document.addEventListener("DOMContentLoaded", () => {
    // Ensure dependencies like jQuery, Bootstrap, Leaflet, Chart are loaded
    // This might require more robust checking in a real app
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
      // Display an error message to the user on the page
      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.textContent =
        "Error: Could not load necessary components for the Visits page. Please try refreshing the page or contact support.";
      document.body.prepend(errorDiv); // Prepend to make it visible
    }
  });
})(); // End IIFE
