/* global Chart, DateUtils, bootstrap, $, MapboxDraw, mapboxgl */

"use strict";
(() => {
  class VisitsManager {
    constructor() {
      this.map = null;
      this.places = new Map();
      this.draw = null;
      this.currentPolygon = null;
      this.visitsChart = null;
      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.suggestionsTable = null;
      this.drawingEnabled = false;
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

      // Enhanced state for UI improvements
      this.mapStyle = "dark";
      this.animationFrames = new Map();
      this.statsUpdateTimer = null;
      this.visitTrends = new Map();

      this.setupDurationSorting();
      this.initialize();
    }

    async initialize() {
      this.showInitialLoading();
      this.loadingManager.startOperation("Initializing Visits Page");
      try {
        await this.initializeMap();
        this.initializeDrawControls();
        this.initializeChart();
        this.initializeTables();
        this.setupEventListeners();
        this.setupEnhancedUI();
        await Promise.all([
          this.loadPlaces(),
          this.loadNonCustomPlacesVisits(),
          this.loadSuggestions(),
        ]);
        this.updateStatsCounts();
        this.startStatsAnimation();
        this.loadingManager.finish("Initializing Visits Page");
        this.hideInitialLoading();
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
        this.showErrorState();
      }
    }

    showInitialLoading() {
      const loadingOverlay = document.getElementById("map-loading");
      if (loadingOverlay) {
        loadingOverlay.style.display = "flex";
      }
    }

    hideInitialLoading() {
      const loadingOverlay = document.getElementById("map-loading");
      if (loadingOverlay) {
        setTimeout(() => {
          loadingOverlay.style.transition = "opacity 0.3s ease";
          loadingOverlay.style.opacity = "0";
          setTimeout(() => {
            loadingOverlay.style.display = "none";
          }, 300);
        }, 500);
      }
    }

    showErrorState() {
      const mapContainer = document.getElementById("map");
      if (mapContainer) {
        mapContainer.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-exclamation-triangle"></i>
            <h5>Unable to Load Map</h5>
            <p>Please refresh the page to try again</p>
          </div>
        `;
      }
    }

    setupEnhancedUI() {
      // Add smooth scroll to all internal links
      document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener("click", (e) => {
          e.preventDefault();
          const target = document.querySelector(anchor.getAttribute("href"));
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      });

      // Initialize tooltips with custom styling
      const tooltipTriggerList = [].slice.call(
        document.querySelectorAll('[data-bs-toggle="tooltip"]'),
      );
      tooltipTriggerList.map((tooltipTriggerEl) => {
        return new bootstrap.Tooltip(tooltipTriggerEl, {
          template:
            '<div class="tooltip" role="tooltip"><div class="tooltip-arrow"></div><div class="tooltip-inner bg-primary"></div></div>',
        });
      });

      // Add ripple effect to buttons
      document.querySelectorAll(".action-button").forEach((button) => {
        button.addEventListener("click", (e) => {
          const ripple = document.createElement("span");
          const rect = button.getBoundingClientRect();
          const size = Math.max(rect.width, rect.height);
          const x = e.clientX - rect.left - size / 2;
          const y = e.clientY - rect.top - size / 2;

          ripple.style.position = "absolute";
          ripple.style.width = ripple.style.height = size + "px";
          ripple.style.left = x + "px";
          ripple.style.top = y + "px";
          ripple.classList.add("ripple");

          button.appendChild(ripple);
          setTimeout(() => ripple.remove(), 600);
        });
      });

      // Enhance form inputs with floating labels effect
      document.querySelectorAll(".place-name-input").forEach((input) => {
        input.addEventListener("focus", () => {
          input.parentElement.classList.add("focused");
        });

        input.addEventListener("blur", () => {
          if (!input.value) {
            input.parentElement.classList.remove("focused");
          }
        });
      });
    }

    startStatsAnimation() {
      // Animate stats counters
      this.animateCounter("total-places-count", this.places.size, 1000);

      // Update monthly visits with animation
      this.updateMonthlyVisits();

      // Start periodic updates
      this.statsUpdateTimer = setInterval(() => {
        this.updateStatsCounts();
      }, 30000); // Update every 30 seconds
    }

    animateCounter(elementId, targetValue, duration = 1000) {
      const element = document.getElementById(elementId);
      if (!element) return;

      const startValue = parseInt(element.textContent) || 0;
      const increment = (targetValue - startValue) / (duration / 16);
      let currentValue = startValue;

      const animate = () => {
        currentValue += increment;
        if (
          (increment > 0 && currentValue >= targetValue) ||
          (increment < 0 && currentValue <= targetValue)
        ) {
          element.textContent = targetValue;
        } else {
          element.textContent = Math.round(currentValue);
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    }

    async updateStatsCounts() {
      // Update total places count
      document.getElementById("total-places-count").textContent =
        this.places.size;
      document.getElementById("active-places-stat").textContent =
        this.places.size;

      // Calculate total visits
      try {
        const [customRes, otherRes] = await Promise.all([
          fetch("/api/places/statistics"),
          fetch("/api/non_custom_places_visits"),
        ]);

        let totalVisits = 0;

        if (customRes.ok) {
          const customStats = await customRes.json();
          totalVisits += customStats.reduce(
            (sum, p) => sum + (p.totalVisits || 0),
            0,
          );
        }

        if (otherRes.ok) {
          const otherStats = await otherRes.json();
          totalVisits += otherStats.reduce(
            (sum, p) => sum + (p.totalVisits || 0),
            0,
          );
        }

        this.animateCounter("total-visits-count", totalVisits);
      } catch (error) {
        console.error("Error updating stats:", error);
      }
    }

    async updateMonthlyVisits() {
      try {
        const [customRes, otherRes] = await Promise.all([
          fetch("/api/places/statistics?timeframe=month"),
          fetch("/api/non_custom_places_visits?timeframe=month"),
        ]);

        let monthlyVisits = 0;

        if (customRes.ok) {
          const customStats = await customRes.json();
          monthlyVisits += customStats.reduce(
            (sum, p) => sum + (p.monthlyVisits || p.totalVisits || 0),
            0,
          );
        }

        if (otherRes.ok) {
          const otherStats = await otherRes.json();
          monthlyVisits += otherStats.reduce(
            (sum, p) => sum + (p.totalVisits || 0),
            0,
          );
        }

        this.animateCounter("month-visits-stat", monthlyVisits);
      } catch (error) {
        console.error("Error updating monthly visits:", error);
      }
    }

    initializeMap() {
      return new Promise((resolve, reject) => {
        try {
          const theme =
            document.documentElement.getAttribute("data-bs-theme") || "dark";
          this.mapStyle = theme;

          // Create Mapbox map instance with enhanced styling
          this.map = window.mapBase.createMap("map", {
            library: "mapbox",
            style:
              theme === "light"
                ? "mapbox://styles/mapbox/light-v11"
                : "mapbox://styles/mapbox/dark-v11",
            center: [-95.7129, 37.0902], // USA centroid as default
            zoom: 4,
            attributionControl: false,
            // Enhanced map options
            pitchWithRotate: false,
            dragRotate: false,
            touchZoomRotate: false,
          });

          // Add navigation controls with custom styling
          this.map.addControl(
            new mapboxgl.NavigationControl({
              showCompass: false,
            }),
            "bottom-right",
          );

          // Wait for map load before continuing
          this.map.on("load", () => {
            // Add custom map animations
            this.map.on("movestart", () => {
              document.getElementById("map").classList.add("map-moving");
            });

            this.map.on("moveend", () => {
              document.getElementById("map").classList.remove("map-moving");
            });

            // GeoJSON source that will hold ALL custom places
            if (this.map.getSource("custom-places")) {
              this.map.removeLayer("custom-places-fill");
              this.map.removeLayer("custom-places-outline");
              this.map.removeLayer("custom-places-highlight");
              this.map.removeSource("custom-places");
            }

            this.map.addSource("custom-places", {
              type: "geojson",
              data: this.customPlacesData,
            });

            // Enhanced fill layer with gradient effect
            this.map.addLayer({
              id: "custom-places-fill",
              type: "fill",
              source: "custom-places",
              paint: {
                "fill-color": [
                  "case",
                  ["boolean", ["feature-state", "hover"], false],
                  "#BB86FC",
                  "#BB86FC",
                ],
                "fill-opacity": [
                  "case",
                  ["boolean", ["feature-state", "hover"], false],
                  0.25,
                  0.15,
                ],
              },
            });

            // Enhanced outline layer
            this.map.addLayer({
              id: "custom-places-outline",
              type: "line",
              source: "custom-places",
              paint: {
                "line-color": [
                  "case",
                  ["boolean", ["feature-state", "hover"], false],
                  "#9965EB",
                  "#BB86FC",
                ],
                "line-width": [
                  "case",
                  ["boolean", ["feature-state", "hover"], false],
                  3,
                  2,
                ],
              },
            });

            // Highlight layer for selected places
            this.map.addLayer({
              id: "custom-places-highlight",
              type: "line",
              source: "custom-places",
              paint: {
                "line-color": "#F59E0B",
                "line-width": 4,
                "line-opacity": 0,
              },
            });

            // Enhanced hover effects
            let hoveredStateId = null;

            this.map.on("mousemove", "custom-places-fill", (e) => {
              if (e.features.length > 0) {
                if (hoveredStateId !== null) {
                  this.map.setFeatureState(
                    { source: "custom-places", id: hoveredStateId },
                    { hover: false },
                  );
                }
                hoveredStateId = e.features[0].id;
                this.map.setFeatureState(
                  { source: "custom-places", id: hoveredStateId },
                  { hover: true },
                );
                this.map.getCanvas().style.cursor = "pointer";
              }
            });

            this.map.on("mouseleave", "custom-places-fill", () => {
              if (hoveredStateId !== null) {
                this.map.setFeatureState(
                  { source: "custom-places", id: hoveredStateId },
                  { hover: false },
                );
              }
              hoveredStateId = null;
              this.map.getCanvas().style.cursor = "";
            });

            // Click interaction with animation
            this.map.on("click", "custom-places-fill", (e) => {
              const feature = e.features?.[0];
              if (!feature) return;

              // Add click animation
              this.animatePlaceClick(feature);

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

    animatePlaceClick(feature) {
      // Create a pulse animation on click
      const placeId = feature.properties?.placeId;
      if (!placeId) return;

      // Temporarily highlight the clicked place
      this.map.setPaintProperty("custom-places-highlight", "line-opacity", 0.8);

      setTimeout(() => {
        this.map.setPaintProperty("custom-places-highlight", "line-opacity", 0);
      }, 300);
    }

    setupMapStyleToggle() {
      const styleToggle = document.getElementById("map-style-toggle");
      if (styleToggle) {
        styleToggle.addEventListener("click", () => {
          this.mapStyle = this.mapStyle === "dark" ? "satellite" : "dark";
          const styleUrl =
            this.mapStyle === "satellite"
              ? "mapbox://styles/mapbox/satellite-streets-v12"
              : "mapbox://styles/mapbox/dark-v11";

          this.map.setStyle(styleUrl);

          // Re-add layers after style change
          this.map.once("styledata", () => {
            this.reloadCustomPlacesLayers();
          });

          // Animate button
          styleToggle.classList.add("rotating");
          setTimeout(() => {
            styleToggle.classList.remove("rotating");
          }, 500);
        });
      }
    }

    reloadCustomPlacesLayers() {
      if (!this.map.getSource("custom-places")) {
        this.map.addSource("custom-places", {
          type: "geojson",
          data: this.customPlacesData,
        });

        // Re-add all layers with enhanced styling
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

        this.map.addLayer({
          id: "custom-places-highlight",
          type: "line",
          source: "custom-places",
          paint: {
            "line-color": "#F59E0B",
            "line-width": 4,
            "line-opacity": 0,
          },
        });
      }
    }

    initializeChart() {
      const ctx = document.getElementById("visitsChart")?.getContext("2d");
      if (!ctx) {
        console.warn("Visits chart canvas not found.");
        return;
      }

      // Enhanced chart configuration
      Chart.defaults.color = "rgba(255, 255, 255, 0.8)";
      Chart.defaults.font.family =
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

      const gradient = ctx.createLinearGradient(0, 0, 0, 400);
      gradient.addColorStop(0, "rgba(187, 134, 252, 0.8)");
      gradient.addColorStop(1, "rgba(187, 134, 252, 0.1)");

      this.visitsChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: [],
          datasets: [
            {
              label: "Visits",
              data: [],
              backgroundColor: gradient,
              borderColor: "#9965EB",
              borderWidth: 2,
              borderRadius: 8,
              borderSkipped: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: {
            duration: 1000,
            easing: "easeInOutQuart",
          },
          interaction: {
            mode: "index",
            intersect: false,
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1,
                color: "rgba(255, 255, 255, 0.75)",
                font: { weight: "400", size: 11 },
                padding: 10,
              },
              grid: {
                color: "rgba(255, 255, 255, 0.08)",
                drawBorder: false,
              },
            },
            x: {
              ticks: {
                color: "rgba(255, 255, 255, 0.8)",
                font: { weight: "500", size: 12 },
                maxRotation: 45,
                minRotation: 45,
              },
              grid: {
                display: false,
                drawBorder: false,
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(30, 30, 30, 0.95)",
              titleColor: "#BB86FC",
              bodyColor: "rgba(255, 255, 255, 0.9)",
              borderColor: "#BB86FC",
              borderWidth: 1,
              padding: 12,
              cornerRadius: 8,
              titleFont: { weight: "600", size: 14 },
              bodyFont: { weight: "400", size: 13 },
              displayColors: false,
              callbacks: {
                label: (context) => {
                  return `Visits: ${context.parsed.y}`;
                },
              },
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

                // Add click animation
                this.visitsChart.options.animation.duration = 300;
                this.visitsChart.update();

                setTimeout(() => {
                  this.toggleView(placeId);
                }, 300);
              }
            }
          },
          onHover: (event, elements) => {
            ctx.canvas.style.cursor =
              elements.length > 0 ? "pointer" : "default";
          },
        },
      });
    }

    initializeTables() {
      this.initVisitsTable();
      this.initNonCustomVisitsTable();
      this.initTripsTable();
      this.initSuggestionsTable();
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
        pageLength: 10,
        columns: [
          {
            data: "name",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="place-link" data-place-id="${row._id}">
                    <i class="fas fa-map-marker-alt me-2"></i>${data}
                   </a>`
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-end",
            render: (data) => {
              const visits = data || 0;
              return `<span class="visits-badge">${visits}</span>`;
            },
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
                  ? `<i class="far fa-calendar me-1"></i>${DateUtils.formatForDisplay(data, { dateStyle: "medium" })}`
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
                  ? `<i class="far fa-calendar-check me-1"></i>${DateUtils.formatForDisplay(data, { dateStyle: "medium" })}`
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
            render: (data) =>
              data ? `<i class="far fa-clock me-1"></i>${data}` : "N/A",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable:
            '<div class="empty-state"><i class="fas fa-map-marked-alt"></i><h5>No Custom Places Yet</h5><p>Draw your first place on the map to start tracking visits</p></div>',
          info: "Showing _START_ to _END_ of _TOTAL_ places",
          search: "",
          searchPlaceholder: "Search places...",
        },
        dom:
          "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
          "<'row'<'col-sm-12'tr>>" +
          "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
        columnDefs: [{ type: "duration", targets: 4 }],
        drawCallback: function () {
          // Add fade-in animation to rows
          $("#visits-table tbody tr").each(function (i) {
            $(this)
              .delay(50 * i)
              .animate({ opacity: 1 }, 300);
          });
        },
      });

      // Custom search styling
      $("#visits-table_filter input").addClass("form-control-sm");
    }

    initNonCustomVisitsTable() {
      const el = document.getElementById("non-custom-visits-table");
      if (!el || !window.$) return;

      const headers = ["Place", "Total Visits", "First Visit", "Last Visit"];

      this.nonCustomVisitsTable = $(el).DataTable({
        responsive: true,
        order: [[3, "desc"]],
        pageLength: 10,
        columns: [
          {
            data: "name",
            render: (data) =>
              `<i class="fas fa-globe me-2 text-info"></i>${data}`,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-end",
            render: (data) => `<span class="badge bg-info">${data}</span>`,
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
          emptyTable:
            '<div class="empty-state"><i class="fas fa-globe"></i><h5>No Other Locations Visited</h5><p>Visit tracking data will appear here</p></div>',
          info: "Showing _START_ to _END_ of _TOTAL_ locations",
          search: "",
          searchPlaceholder: "Search locations...",
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
        pageLength: 15,
        columns: [
          {
            data: "transactionId",
            render: (data, type, row) =>
              type === "display"
                ? `<a href="#" class="trip-id-link" data-trip-id="${row.id}">
                    <i class="fas fa-hashtag me-1"></i>${data}
                   </a>`
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
            data: "endTime",
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
                  : '<span class="text-muted">Unknown</span>'
                : data,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "timeSpent",
            className: "numeric-cell text-end",
            type: "duration",
            render: (data) => `<span class="badge bg-success">${data}</span>`,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "timeSinceLastVisit",
            className: "numeric-cell text-end",
            type: "duration",
            render: (data) =>
              data || '<span class="text-muted">First visit</span>',
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: null,
            className: "action-cell text-center",
            orderable: false,
            render: (data, type, row) =>
              type === "display"
                ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}">
                    <i class="fas fa-map-marker-alt me-1"></i> View Route
                   </button>`
                : "",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable:
            '<div class="empty-state"><i class="fas fa-route"></i><h5>No Trips Found</h5><p>Trip history will appear here</p></div>',
          info: "Showing _START_ to _END_ of _TOTAL_ trips",
          search: "",
          searchPlaceholder: "Search trips...",
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
            // Add loading animation to button
            const $btn = $(e.currentTarget);
            $btn.addClass("loading");
            this.confirmViewTripOnMap(tripId);
          }
        });
    }

    initSuggestionsTable() {
      const el = document.getElementById("suggested-places-table");
      if (!el || !window.$) return;

      const headers = [
        "Suggested Name",
        "Total Visits",
        "First Visit",
        "Last Visit",
        "Actions",
      ];

      this.suggestionsTable = $(el).DataTable({
        responsive: true,
        order: [[1, "desc"]],
        pageLength: 10,
        columns: [
          {
            data: "suggestedName",
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "totalVisits",
            className: "numeric-cell text-end",
            render: (d) => `<span class="badge bg-info">${d}</span>`,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "firstVisit",
            className: "date-cell",
            render: (d, type) =>
              type === "display" || type === "filter"
                ? d
                  ? DateUtils.formatForDisplay(d, { dateStyle: "medium" })
                  : "N/A"
                : d,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: "lastVisit",
            className: "date-cell",
            render: (d, type) =>
              type === "display" || type === "filter"
                ? d
                  ? DateUtils.formatForDisplay(d, { dateStyle: "medium" })
                  : "N/A"
                : d,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
          {
            data: null,
            orderable: false,
            className: "action-cell text-center",
            render: () =>
              `<div class="btn-group btn-group-sm">
                 <button class="btn btn-outline-primary preview-suggestion-btn" title="Preview on Map"><i class="fas fa-eye"></i></button>
                 <button class="btn btn-primary create-place-btn" title="Create Place"><i class="fas fa-plus"></i></button>
               </div>`,
            createdCell: (td, cellData, rowData, row, col) => {
              $(td).attr("data-label", headers[col]);
            },
          },
        ],
        language: {
          emptyTable:
            '<div class="empty-state"><i class="fas fa-magic"></i><h5>No Suggestions Yet</h5><p>Drive around to gather data</p></div>',
        },
      });

      // Action handler
      $(el)
        .find("tbody")
        .on("click", ".create-place-btn", (e) => {
          const row = this.suggestionsTable.row(
            $(e.currentTarget).closest("tr"),
          );
          const data = row.data();
          if (data) {
            this.applySuggestion(data);
          }
        })
        .on("click", ".preview-suggestion-btn", (e) => {
          const row = this.suggestionsTable.row(
            $(e.currentTarget).closest("tr"),
          );
          const data = row.data();
          if (data) {
            this.previewSuggestion(data);
          }
        });
    }

    setupEventListeners() {
      // Enhanced button interactions
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
        const placeId = $(event.target).closest(".place-link").data("place-id");
        if (placeId) {
          this.toggleView(placeId);
        }
      });

      // Map style toggle
      this.setupMapStyleToggle();

      // Time filter
      document
        .getElementById("time-filter")
        ?.addEventListener("change", (e) => {
          this.filterByTimeframe(e.target.value);
        });

      // Enhanced keyboard shortcuts
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey) {
          switch (e.key) {
            case "d":
              e.preventDefault();
              document.getElementById("start-drawing")?.click();
              break;
            case "s":
              e.preventDefault();
              if (!document.getElementById("save-place")?.disabled) {
                document.getElementById("save-place")?.click();
              }
              break;
            case "z":
              e.preventDefault();
              document.getElementById("zoom-to-fit")?.click();
              break;
          }
        }
      });
    }

    async filterByTimeframe(timeframe) {
      // Add loading state to both tables
      const tables = [this.visitsTable, this.nonCustomVisitsTable];
      tables.forEach((table) => table?.processing?.(true));

      try {
        const params = new URLSearchParams({ timeframe });

        // ------------------------------------------------------------------
        // Request custom-place statistics
        // ------------------------------------------------------------------
        const [customRes, otherLocRes] = await Promise.all([
          fetch(`/api/places/statistics?${params}`),
          fetch(`/api/non_custom_places_visits?${params}`),
        ]);

        if (customRes.ok) {
          const customStats = await customRes.json();
          this.updateVisitsData(customStats);
        }

        if (otherLocRes.ok && this.nonCustomVisitsTable) {
          const otherStats = await otherLocRes.json();
          this.nonCustomVisitsTable.clear().rows.add(otherStats).draw();
        }

        // Reload suggestions separately
        await this.loadSuggestions();
      } catch (error) {
        console.error("Error filtering by timeframe:", error);
        window.notificationManager?.show("Error filtering data", "danger");
      } finally {
        tables.forEach((table) => table?.processing?.(false));
      }
    }

    async loadPlaces() {
      this.loadingManager.startOperation("Loading Places");
      try {
        const response = await fetch("/api/places");
        if (!response.ok)
          throw new Error(`Failed to fetch places: ${response.statusText}`);
        const places = await response.json();

        this.places.clear();
        this.placeFeatures.clear();
        this.customPlacesData.features = [];
        if (this.map && this.map.getSource("custom-places")) {
          this.map.getSource("custom-places").setData(this.customPlacesData);
        }

        // Add places with stagger animation
        places.forEach((place, index) => {
          setTimeout(() => {
            this.places.set(place._id, place);
            this.displayPlace(place);
          }, index * 50); // Stagger by 50ms
        });

        // Wait for all places to be added
        setTimeout(
          async () => {
            await this.updateVisitsData();
            this.updateStatsCounts();
            this.loadingManager.finish("Loading Places");
          },
          places.length * 50 + 100,
        );
      } catch (error) {
        console.error("Error loading places:", error);
        window.notificationManager?.show(
          "Failed to load custom places",
          "danger",
        );
        this.loadingManager.error("Failed during Loading Places");
      }
    }

    displayPlace(place) {
      if (!place || !place.geometry || !place._id) {
        console.warn("Attempted to display invalid place:", place);
        return;
      }

      // Build feature with unique ID
      const feature = {
        type: "Feature",
        id: place._id, // Important for hover states
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

    async updateVisitsData(statsData = null) {
      this.loadingManager.startOperation("Updating Statistics");
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
        this.updateInsights([]);
        this.loadingManager.finish("Updating Statistics");
        return;
      }
      try {
        let statsList = statsData;
        if (!statsList) {
          const response = await fetch("/api/places/statistics");
          if (!response.ok) throw new Error("Failed to fetch place statistics");
          statsList = await response.json();
        }

        statsList.sort((a, b) => b.totalVisits - a.totalVisits);

        const validResults = statsList.map((d) => ({
          _id: d._id,
          name: d.name,
          totalVisits: d.totalVisits,
          firstVisit: d.firstVisit,
          lastVisit: d.lastVisit,
          avgTimeSpent: d.averageTimeSpent || "N/A",
        }));

        // Update chart with animation
        if (this.visitsChart) {
          this.visitsChart.data.labels = validResults
            .slice(0, 10)
            .map((d) => d.name);
          this.visitsChart.data.datasets[0].data = validResults
            .slice(0, 10)
            .map((d) => d.totalVisits);
          this.visitsChart.update("active");
        }

        // Update table with fade effect
        if (this.visitsTable) {
          this.visitsTable.clear().rows.add(validResults).draw();
        }

        // Update insights
        this.updateInsights(statsList);
      } catch (error) {
        console.error("Error updating place statistics:", error);
        window.notificationManager?.show(
          "Error updating place statistics",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Updating Statistics");
      }
    }

    updateInsights(stats) {
      if (stats.length === 0) {
        document.getElementById("most-visited-place").textContent = "-";
        document.getElementById("avg-visit-duration").textContent = "-";
        document.getElementById("visit-frequency").textContent = "-";
        return;
      }

      // Most visited place
      const mostVisited = stats.reduce((max, place) =>
        place.totalVisits > max.totalVisits ? place : max,
      );
      document.getElementById("most-visited-place").textContent =
        `${mostVisited.name} (${mostVisited.totalVisits} visits)`;

      // Average visit duration across all places
      const avgDurations = stats
        .filter((s) => s.averageTimeSpent && s.averageTimeSpent !== "N/A")
        .map((s) => DateUtils.convertDurationToSeconds(s.averageTimeSpent));

      if (avgDurations.length > 0) {
        const overallAvg =
          avgDurations.reduce((a, b) => a + b, 0) / avgDurations.length;
        const formatted = DateUtils.formatDuration(overallAvg * 1000);
        document.getElementById("avg-visit-duration").textContent = formatted;
      }

      // Visit frequency (visits per week)
      const totalVisits = stats.reduce(
        (sum, place) => sum + place.totalVisits,
        0,
      );
      const firstVisitDate = stats
        .filter((s) => s.firstVisit)
        .map((s) => new Date(s.firstVisit))
        .reduce((min, date) => (date < min ? date : min), new Date());

      const weeksSinceFirst =
        (new Date() - firstVisitDate) / (1000 * 60 * 60 * 24 * 7);
      const visitsPerWeek = (
        totalVisits / Math.max(weeksSinceFirst, 1)
      ).toFixed(1);
      document.getElementById("visit-frequency").textContent =
        `${visitsPerWeek} visits/week`;
    }

    async savePlace() {
      const placeNameInput = document.getElementById("place-name");
      const placeName = placeNameInput?.value.trim();

      if (!placeName) {
        this.showInputError(
          placeNameInput,
          "Please enter a name for the place.",
        );
        return;
      }
      if (!this.currentPolygon) {
        window.notificationManager?.show(
          "Please draw a boundary for the place first.",
          "warning",
        );
        return;
      }

      // Add saving animation
      const saveBtn = document.getElementById("save-place");
      saveBtn.classList.add("loading");
      saveBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';

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

        // Add with animation
        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);

        // Animate to new place
        this.animateToPlace(savedPlace);

        await this.updateVisitsData();
        this.resetDrawing();

        window.notificationManager?.show(
          `Place "${placeName}" saved successfully!`,
          "success",
        );

        // Update stats
        this.updateStatsCounts();
      } catch (error) {
        console.error("Error saving place:", error);
        window.notificationManager?.show(
          "Failed to save place. Please try again.",
          "danger",
        );
      } finally {
        saveBtn.classList.remove("loading");
        saveBtn.innerHTML =
          '<i class="fas fa-save me-2"></i><span>Save Place</span>';
        this.loadingManager.finish("Saving Place");
      }
    }

    showInputError(input, message) {
      input.classList.add("is-invalid");
      window.notificationManager?.show(message, "warning");
      input.focus();

      // Remove error state after typing
      input.addEventListener(
        "input",
        () => {
          input.classList.remove("is-invalid");
        },
        { once: true },
      );
    }

    animateToPlace(place) {
      if (!place.geometry || !this.map) return;

      try {
        let coords = [];
        const geom = place.geometry;

        if (!geom) throw new Error("No geometry provided");

        switch (geom.type) {
          case "Point":
            coords = [geom.coordinates];
            break;
          case "LineString":
            coords = geom.coordinates;
            break;
          case "Polygon":
            // Polygon -> Array<Ring<Array<[lng,lat]>>>
            coords = geom.coordinates.flat(1);
            break;
          case "MultiPolygon":
            coords = geom.coordinates.flat(2);
            break;
          default:
            coords = [];
        }

        if (coords.length >= 2) {
          let minX = coords[0][0],
            minY = coords[0][1];
          let maxX = coords[0][0],
            maxY = coords[0][1];

          coords.forEach((c) => {
            if (!Array.isArray(c) || c.length < 2) return;
            const [lng, lat] = c;
            if (typeof lng !== "number" || typeof lat !== "number") return;
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
            { padding: 100, duration: 1000 },
          );
        }
      } catch (e) {
        console.warn("Failed to animate to new place", e);
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

        // Animate removal
        this.animatePlaceRemoval(placeId);

        this.places.delete(placeId);

        // Remove feature from map source
        if (this.placeFeatures.has(placeId)) {
          const feature = this.placeFeatures.get(placeId);
          this.customPlacesData.features =
            this.customPlacesData.features.filter((f) => f !== feature);
          this.placeFeatures.delete(placeId);
          if (this.map && this.map.getSource("custom-places")) {
            this.map.getSource("custom-places").setData(this.customPlacesData);
          }
        }

        await this.updateVisitsData();
        this.refreshManagePlacesModal();
        this.updateStatsCounts();

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

    animatePlaceRemoval(placeId) {
      // Add fade-out animation to map feature
      if (this.map && this.map.getLayer("custom-places-fill")) {
        // Temporarily change opacity for this feature
        this.map.setPaintProperty("custom-places-fill", "fill-opacity", [
          "case",
          ["==", ["get", "placeId"], placeId],
          0,
          0.15,
        ]);
      }
    }

    startDrawing() {
      if (this.drawingEnabled || !this.draw) return;

      this.resetDrawing(false);

      // Enter draw mode
      this.draw.changeMode("draw_polygon");

      this.drawingEnabled = true;

      const drawBtn = document.getElementById("start-drawing");
      drawBtn?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", true);

      // Show drawing instructions with animation
      const notification = window.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point or press Enter to finish.",
        "info",
        0,
      );

      // Store notification to dismiss later
      this.drawingNotification = notification;
    }

    onPolygonCreated(event) {
      if (!event?.features || event.features.length === 0) return;

      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
      }

      this.currentPolygon = event.features[0];
      this.drawingEnabled = false;

      document.getElementById("start-drawing")?.classList.remove("active");
      document.getElementById("save-place")?.removeAttribute("disabled");

      // Dismiss drawing notification
      if (this.drawingNotification) {
        this.drawingNotification.close();
      }

      window.notificationManager?.show(
        "Boundary drawn! Enter a name and click Save Place.",
        "success",
      );

      // Focus on name input
      document.getElementById("place-name")?.focus();
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

      if (placeNameInput) {
        placeNameInput.value = "";
        placeNameInput.classList.remove("is-invalid");
      }
      if (savePlaceBtn) savePlaceBtn.setAttribute("disabled", true);
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      if (this.drawingEnabled && removeControl) {
        this.draw.changeMode("simple_select");
      }
      this.drawingEnabled = false;
      this.placeBeingEdited = null;
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
        tableBody.innerHTML = `
          <tr>
            <td colspan="3" class="text-center">
              <div class="empty-state py-4">
                <i class="fas fa-map-marked-alt"></i>
                <h5>No Custom Places Yet</h5>
                <p>Draw your first place on the map to get started</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      placesArray.forEach((place, index) => {
        const row = tableBody.insertRow();
        const createdDate = place.createdAt
          ? DateUtils.formatForDisplay(place.createdAt, { dateStyle: "medium" })
          : "Unknown";

        row.innerHTML = `
          <td>
            <i class="fas fa-map-marker-alt me-2 text-primary"></i>
            ${place.name}
          </td>
          <td class="text-center text-muted">${createdDate}</td>
          <td class="text-center">
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

        // Add fade-in animation
        row.style.opacity = "0";
        setTimeout(() => {
          row.style.transition = "opacity 0.3s ease";
          row.style.opacity = "1";
        }, index * 50);

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

    async showPlaceStatistics(placeId, lngLat = null) {
      const place = this.places.get(placeId);
      if (!place || !this.map) return;

      // Close any existing popup
      if (this.activePopup) {
        this.activePopup.remove();
      }

      // Determine popup location if not provided
      if (!lngLat && place.geometry?.coordinates) {
        const first = place.geometry.coordinates[0][0];
        lngLat = { lng: first[0], lat: first[1] };
      }

      // Create enhanced popup with loading state
      this.activePopup = new mapboxgl.Popup({
        offset: 12,
        className: "custom-popup-enhanced",
        maxWidth: "320px",
      })
        .setLngLat(lngLat)
        .setHTML(
          `
          <div class="custom-place-popup">
            <h6><i class="fas fa-map-marker-alt me-2"></i>${place.name}</h6>
            <div class="text-center py-3">
              <div class="spinner-border spinner-border-sm text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
              </div>
              <p class="mb-0 mt-2 text-muted small">Fetching statistics...</p>
            </div>
          </div>
        `,
        )
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
            <h6><i class="fas fa-map-marker-alt me-2 text-primary"></i>${place.name}</h6>
            <div class="stats-grid">
              <p>
                <span class="stat-label">Total Visits</span>
                <strong class="stat-value text-primary">${stats.totalVisits || 0}</strong>
              </p>
              <p>
                <span class="stat-label">First Visit</span>
                <strong class="stat-value">${formatDate(stats.firstVisit)}</strong>
              </p>
              <p>
                <span class="stat-label">Last Visit</span>
                <strong class="stat-value">${formatDate(stats.lastVisit)}</strong>
              </p>
              <p>
                <span class="stat-label">Avg Duration</span>
                <strong class="stat-value text-success">${formatAvg(stats.averageTimeSpent)}</strong>
              </p>
              <p>
                <span class="stat-label">Time Since Last</span>
                <strong class="stat-value text-info">${formatAvg(stats.averageTimeSinceLastVisit)}</strong>
              </p>
            </div>
            <hr style="margin: 10px 0; opacity: 0.2;">
            <div class="d-grid gap-2">
              <button class="btn btn-sm btn-primary view-trips-btn" data-place-id="${placeId}">
                <i class="fas fa-list-ul me-1"></i> View All Trips
              </button>
              <button class="btn btn-sm btn-outline-primary zoom-to-place-btn" data-place-id="${placeId}">
                <i class="fas fa-search-plus me-1"></i> Zoom to Place
              </button>
            </div>
          </div>`;

        this.activePopup.setHTML(popupContent);

        // Attach event listeners once contents rendered
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

          popupNode
            ?.querySelector(".zoom-to-place-btn")
            ?.addEventListener("click", (e) => {
              e.preventDefault();
              const id = e.currentTarget.getAttribute("data-place-id");
              if (id) {
                const zoomPlace = this.places.get(id);
                if (zoomPlace) {
                  this.animateToPlace(zoomPlace);
                }
              }
            });
        }, 100);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        this.activePopup.setHTML(
          `<div class="custom-place-popup">
            <h6><i class="fas fa-map-marker-alt me-2"></i>${place.name}</h6>
            <div class="alert alert-danger mb-0">
              <i class="fas fa-exclamation-triangle me-2"></i>
              Error loading statistics
            </div>
          </div>`,
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

        // Animate transition
        mainViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = true;
          mainViewContainer.style.display = "none";
          detailViewContainer.style.display = "block";
          detailViewContainer.style.opacity = "0";

          setTimeout(() => {
            detailViewContainer.style.transition = "opacity 0.3s ease";
            detailViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement) placeNameElement.textContent = place.name;

        await this.showTripsForPlace(placeId);

        // Zoom to place on map
        this.animateToPlace(place);
      } else {
        // Animate back
        detailViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = false;
          detailViewContainer.style.display = "none";
          mainViewContainer.style.display = "block";
          mainViewContainer.style.opacity = "0";

          setTimeout(() => {
            mainViewContainer.style.transition = "opacity 0.3s ease";
            mainViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        if (this.visitsChart) {
          this.visitsChart.resize();
        }
        if (this.visitsTable?.responsive?.recalc) {
          this.visitsTable.columns.adjust().responsive.recalc();
        }
      }
    }

    async showTripsForPlace(placeId) {
      if (!this.tripsTable) {
        console.error("Trips table not initialized.");
        return;
      }
      this.loadingManager.startOperation("Loading Trips");
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
        this.loadingManager.finish("Loading Trips");
      }
    }

    async loadNonCustomPlacesVisits() {
      if (!this.nonCustomVisitsTable) return;
      this.loadingManager.addSubOperation(
        "Initializing Visits Page",
        "Loading Other Locations",
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
          "Loading Other Locations",
          100,
        );
      } catch (error) {
        console.error("Error fetching non-custom places visits:", error);
        window.notificationManager?.show(
          "Failed to load non-custom places visits",
          "danger",
        );
        this.loadingManager.error("Failed during Loading Other Locations");
      }
    }

    toggleCustomPlacesVisibility(isVisible) {
      this.isCustomPlacesVisible = isVisible;

      if (this.map) {
        const visibility = isVisible ? "visible" : "none";
        [
          "custom-places-fill",
          "custom-places-outline",
          "custom-places-highlight",
        ].forEach((layerId) => {
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
        let coords = [];
        // Handle both Polygon and MultiPolygon geometries safely
        if (feature.geometry.type === "Polygon") {
          // Polygon -> Array<Ring<Array<[lng,lat]>>> -> flatten one level to get coordinate pairs
          coords = feature.geometry.coordinates.flat(1);
        } else if (feature.geometry.type === "MultiPolygon") {
          // MultiPolygon -> Array<Polygon<Ring<Array<[lng,lat]>>>>
          coords = feature.geometry.coordinates.flat(2);
        }

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
          { padding: 50, duration: 1000 },
        );
      }
    }

    // Enhanced trip viewing methods
    confirmViewTripOnMap(tripId) {
      if (!tripId) return;
      this.fetchAndShowTrip(tripId);
    }

    async fetchAndShowTrip(tripId) {
      this.loadingManager.startOperation("Loading Trip");
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
        this.loadingManager.finish("Loading Trip");
        // Remove loading state from button
        document.querySelectorAll(".view-trip-btn.loading").forEach((btn) => {
          btn.classList.remove("loading");
        });
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
          <h6 class="mb-3">
            <i class="fas fa-hashtag me-2"></i>
            Trip ${transactionId}
          </h6>
          <div class="row g-3">
            <div class="col-md-6">
              <div class="info-card p-3 bg-surface-2 rounded">
                <h6 class="text-success mb-2">
                  <i class="fas fa-play-circle me-2"></i>Start
                </h6>
                <p class="mb-1"><strong>Time:</strong> ${startTime}</p>
                <p class="mb-0 text-truncate" title="${startLocation}">
                  <strong>Location:</strong> ${startLocation}
                </p>
              </div>
            </div>
            <div class="col-md-6">
              <div class="info-card p-3 bg-surface-2 rounded">
                <h6 class="text-danger mb-2">
                  <i class="fas fa-stop-circle me-2"></i>End
                </h6>
                <p class="mb-1"><strong>Time:</strong> ${endTime}</p>
                <p class="mb-0 text-truncate" title="${endLocation}">
                  <strong>Location:</strong> ${endLocation}
                </p>
              </div>
            </div>
          </div>
          <div class="mt-3 text-center">
            <span class="badge bg-primary px-3 py-2">
              <i class="fas fa-route me-2"></i>
              Distance: ${formattedDistance}
            </span>
          </div>
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
      if (this.tripViewMap.getLayer("trip-path-outline")) {
        this.tripViewMap.removeLayer("trip-path-outline");
      }
      if (this.tripViewMap.getSource("trip")) {
        this.tripViewMap.removeSource("trip");
      }

      this.startMarker?.remove();
      this.endMarker?.remove();

      document.getElementById("trip-info").querySelector(".alert")?.remove();

      if (trip.geometry?.coordinates && trip.geometry.coordinates.length > 0) {
        try {
          this.tripViewMap.addSource("trip", {
            type: "geojson",
            data: trip.geometry,
          });

          // Add outline for better visibility
          this.tripViewMap.addLayer({
            id: "trip-path-outline",
            type: "line",
            source: "trip",
            paint: {
              "line-color": "#9965EB",
              "line-width": 6,
              "line-opacity": 0.6,
            },
          });

          this.tripViewMap.addLayer({
            id: "trip-path",
            type: "line",
            source: "trip",
            paint: {
              "line-color": "#BB86FC",
              "line-width": 4,
              "line-dasharray": [2, 1],
            },
          });

          const coordinates = trip.geometry.coordinates;
          const startCoord = coordinates[0];
          const endCoord = coordinates[coordinates.length - 1];

          if (Array.isArray(startCoord) && startCoord.length >= 2) {
            this.startMarker = new mapboxgl.Marker({
              color: "#22c55e",
              scale: 1.2,
            })
              .setLngLat(startCoord)
              .setPopup(
                new mapboxgl.Popup({ offset: 25 }).setText("Trip Start"),
              )
              .addTo(this.tripViewMap);
          }

          if (Array.isArray(endCoord) && endCoord.length >= 2) {
            this.endMarker = new mapboxgl.Marker({
              color: "#ef4444",
              scale: 1.2,
            })
              .setLngLat(endCoord)
              .setPopup(new mapboxgl.Popup({ offset: 25 }).setText("Trip End"))
              .addTo(this.tripViewMap);
          }

          // Fit bounds with animation
          const bounds = coordinates.reduce(
            (b, c) => b.extend(c),
            new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]),
          );
          this.tripViewMap.fitBounds(bounds, {
            padding: 50,
            maxZoom: 16,
            duration: 1000,
          });
        } catch (error) {
          console.error("Error processing trip geometry:", error);
          document.getElementById("trip-info").innerHTML +=
            '<div class="alert alert-danger mt-3"><i class="fas fa-exclamation-triangle me-2"></i>Error displaying trip route.</div>';
        }
      } else {
        document.getElementById("trip-info").innerHTML +=
          '<div class="alert alert-warning mt-3"><i class="fas fa-info-circle me-2"></i>No route data available for this trip.</div>';
        this.tripViewMap.setCenter([-95.7129, 37.0902]);
        this.tripViewMap.setZoom(4);
      }

      this.tripViewMap.resize();
    }

    // Cleanup
    destroy() {
      // Clear timers
      if (this.statsUpdateTimer) {
        clearInterval(this.statsUpdateTimer);
      }

      // Clear animation frames
      this.animationFrames.forEach((frame) => cancelAnimationFrame(frame));

      // Remove event listeners
      document.removeEventListener("keydown", this.keyboardHandler);

      // Destroy maps
      this.map?.remove();
      this.tripViewMap?.remove();

      // Destroy charts
      this.visitsChart?.destroy();

      // Destroy datatables
      this.visitsTable?.destroy();
      this.nonCustomVisitsTable?.destroy();
      this.tripsTable?.destroy();
      this.suggestionsTable?.destroy();
    }

    setupDurationSorting() {
      if (window.$ && $.fn.dataTable) {
        $.fn.dataTable.ext.type.order["duration-pre"] = (data) => {
          return DateUtils.convertDurationToSeconds(data);
        };
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
          this.customPlacesData.features =
            this.customPlacesData.features.filter((f) => f !== oldFeature);
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
              if (!Array.isArray(c) || c.length < 2) return;
              const [lng, lat] = c;
              if (typeof lng !== "number" || typeof lat !== "number") return;
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
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "false"],
            ],
            paint: {
              "fill-color": "#BB86FC",
              "fill-opacity": 0.15,
            },
          },
          {
            id: "gl-draw-polygon-fill-active",
            type: "fill",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "true"],
            ],
            paint: {
              "fill-color": "#F59E0B",
              "fill-opacity": 0.1,
            },
          },
          // Outline
          {
            id: "gl-draw-polygon-stroke-inactive",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "false"],
            ],
            paint: {
              "line-color": "#BB86FC",
              "line-width": 2,
            },
          },
          {
            id: "gl-draw-polygon-stroke-active",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "true"],
            ],
            paint: {
              "line-color": "#F59E0B",
              "line-width": 2,
            },
          },
          // Vertices
          {
            id: "gl-draw-polygon-vertex-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "active", "true"]],
            paint: {
              "circle-radius": 6,
              "circle-color": "#F59E0B",
              "circle-stroke-width": 2,
              "circle-stroke-color": "#fff",
            },
          },
        ],
      });

      if (this.map) {
        this.map.addControl(this.draw, "top-left");
        this.map.on("draw.create", (e) => this.onPolygonCreated(e));
      }
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
        this.reloadCustomPlacesLayers();
      });
    }

    async loadSuggestions() {
      if (!this.suggestionsTable) return;

      if (this.suggestionsTable?.processing) {
        this.suggestionsTable.processing(true);
      }
      try {
        const params = new URLSearchParams();
        // default timeframe according to current filter selection
        const tfSelect = document.getElementById("time-filter");
        if (tfSelect && tfSelect.value && tfSelect.value !== "all") {
          params.append("timeframe", tfSelect.value);
        }

        const response = await fetch(`/api/visit_suggestions?${params}`);
        if (response.ok) {
          const data = await response.json();
          this.suggestionsTable.clear().rows.add(data).draw();
        }
      } catch (err) {
        console.error("Error loading visit suggestions", err);
      } finally {
        if (this.suggestionsTable?.processing) {
          this.suggestionsTable.processing(false);
        }
      }
    }

    applySuggestion(suggestion) {
      if (!suggestion || !suggestion.boundary) return;

      // Reset any current drawing
      this.resetDrawing(false);

      const feature = {
        type: "Feature",
        geometry: suggestion.boundary,
        properties: {},
      };

      // Add to Draw control
      if (this.draw) {
        this.draw.changeMode("simple_select");
        const [featId] = this.draw.add(feature);
        this.currentPolygon = { id: featId, ...feature };
      } else {
        this.currentPolygon = feature;
      }

      // Populate name input
      const nameInput = document.getElementById("place-name");
      if (nameInput && !nameInput.value) {
        nameInput.value = suggestion.suggestedName;
      }

      // Enable save button
      document.getElementById("save-place")?.removeAttribute("disabled");

      // Zoom to suggestion
      this.animateToPlace({ geometry: suggestion.boundary });

      // Switch to Custom Places tab for clarity
      const customTab = document.getElementById("custom-places-tab");
      if (customTab) {
        bootstrap.Tab.getOrCreateInstance(customTab).show();
      }

      // Ensure preview is visible first
      this.previewSuggestion(suggestion);

      window.notificationManager?.show(
        "Suggestion applied! Adjust boundary or name, then click Save Place.",
        "info",
      );
    }

    previewSuggestion(suggestion) {
      if (!this.map || !suggestion?.boundary) return;

      // Remove previous preview layer/source if they exist
      if (this.map.getLayer("suggestion-preview-fill")) {
        this.map.removeLayer("suggestion-preview-fill");
      }
      if (this.map.getSource("suggestion-preview")) {
        this.map.removeSource("suggestion-preview");
      }

      // Add source & layer
      this.map.addSource("suggestion-preview", {
        type: "geojson",
        data: suggestion.boundary,
      });

      this.map.addLayer({
        id: "suggestion-preview-fill",
        type: "fill",
        source: "suggestion-preview",
        paint: {
          "fill-color": "#F59E0B",
          "fill-opacity": 0.25,
        },
      });

      // Zoom to bounds
      this.animateToPlace({ geometry: suggestion.boundary });
    }
  }

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", () => {
    if (
      typeof Chart !== "undefined" &&
      typeof $ !== "undefined" &&
      typeof bootstrap !== "undefined" &&
      typeof DateUtils !== "undefined" &&
      typeof window.mapBase !== "undefined" &&
      typeof window.mapBase.createMap === "function"
    ) {
      window.visitsManager = new VisitsManager();

      // Handle theme changes
      const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === "data-bs-theme") {
            const newTheme =
              document.documentElement.getAttribute("data-bs-theme");
            window.visitsManager?.updateMapTheme(newTheme);
          }
        });
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });
    } else {
      const missingLibraries = [];
      if (typeof Chart === "undefined") missingLibraries.push("Chart.js");
      if (typeof $ === "undefined") missingLibraries.push("jQuery");
      if (typeof bootstrap === "undefined") missingLibraries.push("Bootstrap");
      if (typeof DateUtils === "undefined") missingLibraries.push("DateUtils");
      if (typeof window.mapBase === "undefined")
        missingLibraries.push("mapBase (window.mapBase)");
      else if (typeof window.mapBase.createMap !== "function")
        missingLibraries.push("mapBase.createMap (function missing)");

      const errorMessage = `Critical libraries not loaded: ${missingLibraries.join(", ")}`;
      console.error(errorMessage);

      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle me-2"></i>
        <strong>Error:</strong> Could not load necessary components for the Visits page. 
        Please refresh the page or contact support.
      `;
      document.body.prepend(errorDiv);
    }
  });
})();
