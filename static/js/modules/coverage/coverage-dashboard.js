/**
 * Coverage Dashboard
 * Handles the dashboard view, charts, and stats for a specific coverage area
 */
/* global mapboxgl */
import COVERAGE_API from "./coverage-api.js";

export class CoverageDashboard {
  constructor(
    notificationManager,
    uiModule,
    coverageMapModule,
    navigationModule,
    selectionModule,
  ) {
    this.notificationManager = notificationManager;
    this.ui = uiModule;
    this.coverageMap = coverageMapModule;
    this.navigation = navigationModule;
    this.selection = selectionModule;

    // State
    this.currentDashboardLocationId = null;
    this.selectedLocation = null;
    this.showTripsActive = false;
    this.dataCache = new Map();
  }

  getCachedData(key) {
    return this.dataCache.get(key);
  }

  setCachedData(key, data) {
    this.dataCache.set(key, data);
  }

  /**
   * Display coverage dashboard
   */
  async displayCoverageDashboard(locationId, extraContext = {}) {
    this.currentDashboardLocationId = locationId;

    const dashboardElement = document.getElementById("coverage-dashboard");
    const locationNameElement = document.getElementById(
      "dashboard-location-name",
    );
    const mapContainer = document.getElementById("coverage-map");

    if (!dashboardElement || !locationNameElement || !mapContainer) {
      console.error("Essential dashboard elements not found.");
      this.notificationManager.show(
        "UI Error: Dashboard components missing.",
        "danger",
      );
      return;
    }

    this.ui.clearDashboardUI();
    dashboardElement.style.display = "block";
    dashboardElement.classList.add("fade-in-up");

    locationNameElement.innerHTML =
      '<span class="loading-skeleton" style="width: 150px; display: inline-block;"></span>';

    const chartContainer = document.getElementById("street-type-chart");
    if (chartContainer)
      chartContainer.innerHTML = this.ui.createLoadingSkeleton(180);
    const coverageEl = document.getElementById("street-type-coverage");
    if (coverageEl)
      coverageEl.innerHTML = this.ui.createLoadingSkeleton(100, 3);
    mapContainer.innerHTML = this.ui.createLoadingIndicator(
      "Loading map data...",
    );

    try {
      const cachedData = this.getCachedData(`dashboard-${locationId}`);
      let coverageData = null;

      if (cachedData) {
        coverageData = cachedData;
      } else {
        coverageData = await COVERAGE_API.getArea(locationId);
        const streetsGeoJson = await COVERAGE_API.getStreets(locationId, true);
        coverageData.streets_geojson = streetsGeoJson;
        this.setCachedData(`dashboard-${locationId}`, coverageData);
      }

      this.selectedLocation = coverageData;
      locationNameElement.textContent =
        coverageData.location.display_name || "Unnamed Area";

      // Pass context helpers if needed, or bind them in the manager.
      // Assuming extraContext provides necessary formatters.
      const { distanceFormatter, timeFormatter, streetTypeFormatter } =
        extraContext;

      this.ui.updateDashboardStats(
        coverageData,
        distanceFormatter,
        timeFormatter,
      );
      this.ui.updateStreetTypeCoverage(
        coverageData.street_types || [],
        distanceFormatter,
        streetTypeFormatter,
      );
      this.ui.createStreetTypeChart(
        coverageData.street_types || [],
        streetTypeFormatter,
        distanceFormatter,
      );

      this.updateFilterButtonStates();

      this.coverageMap.initializeCoverageMap(coverageData);

      // Initialize bulk action toolbar after map is ready
      this.selection.createBulkActionToolbar();

      // Load any existing optimal route
      this.navigation.loadExistingOptimalRoute(locationId);

      // Update undriven streets list
      if (coverageData.streets_geojson) {
        this.ui.updateUndrivenStreetsList(
          coverageData.streets_geojson,
          distanceFormatter,
        );
      }

      this.showTripsActive =
        localStorage.getItem("showTripsOverlay") === "true";
      const tripToggle = document.getElementById("toggle-trip-overlay");
      if (tripToggle) tripToggle.checked = this.showTripsActive;

      // If trip overlay was active, ensure it's loaded
      if (this.showTripsActive) {
        this.coverageMap.showTripsActive = true;
        this.coverageMap.setupTripLayers();
        this.coverageMap.loadTripsForView();
      }
    } catch (error) {
      console.error("Error displaying coverage dashboard:", error);
      locationNameElement.textContent = "Error loading data";
      this.notificationManager.show(
        `Error loading dashboard: ${error.message}`,
        "danger",
      );
      mapContainer.innerHTML = this.ui.createAlertMessage(
        "Dashboard Load Error",
        error.message,
        "danger",
      );
    } finally {
      // Optional: Initialize tooltips if needed here or in manager
      // this.ui.initTooltips(); // Assuming UI has this or manager calls it
    }
  }

  /**
   * Refresh dashboard data
   */
  async refreshDashboardData(locationId, extraContext = {}) {
    try {
      const refreshData = await COVERAGE_API.refreshStats(locationId);
      if (refreshData.coverage) {
        this.selectedLocation = refreshData.coverage;

        const { distanceFormatter, timeFormatter, streetTypeFormatter } =
          extraContext;

        this.ui.updateDashboardStats(
          refreshData.coverage,
          distanceFormatter,
          timeFormatter,
        );
        this.coverageMap.addCoverageSummary(refreshData.coverage);
        this.ui.updateStreetTypeCoverage(
          refreshData.coverage.street_types || [],
          distanceFormatter,
          streetTypeFormatter,
        );
        if (this.ui.streetTypeChartInstance)
          this.ui.streetTypeChartInstance.destroy();
        this.ui.createStreetTypeChart(
          refreshData.coverage.street_types || [],
          streetTypeFormatter,
          distanceFormatter,
        );
      } else {
        this.notificationManager.show(
          `Failed to refresh stats: ${refreshData.detail || "Unknown error"}`,
          "warning",
        );
      }
    } catch (e) {
      console.error("Error refreshing stats:", e);
      this.notificationManager.show(
        `Error fetching updated stats: ${e.message}`,
        "danger",
      );
    }
  }

  /**
   * Close coverage dashboard
   */
  closeCoverageDashboard() {
    const dashboard = document.getElementById("coverage-dashboard");
    if (dashboard) {
      dashboard.style.opacity = "0";
      dashboard.style.transform = "translateY(20px)";

      setTimeout(() => {
        dashboard.style.display = "none";
        dashboard.style.opacity = "";
        dashboard.style.transform = "";
        this.ui.clearDashboardUI();
        this.coverageMap.cleanup();
        this.navigation.clearEfficientStreetMarkers();
      }, 300);
    }
  }

  /**
   * Update filter button states
   */
  updateFilterButtonStates(filterType = null) {
    const currentFilter = filterType || this.coverageMap.currentFilter;
    const filterButtons = document.querySelectorAll(
      ".map-controls button[data-filter]",
    );
    filterButtons.forEach((btn) => {
      btn.classList.remove(
        "active",
        "btn-primary",
        "btn-outline-primary",
        "btn-success",
        "btn-outline-success",
        "btn-danger",
        "btn-outline-danger",
        "btn-warning",
        "btn-outline-warning",
      );

      let buttonClass = "";
      if (btn.dataset.filter === currentFilter) {
        btn.classList.add("active");
        if (currentFilter === "driven") buttonClass = "btn-success";
        else if (currentFilter === "undriven") buttonClass = "btn-danger";
        else if (currentFilter === "undriveable") buttonClass = "btn-warning";
        else buttonClass = "btn-primary";
      } else {
        if (btn.dataset.filter === "driven")
          buttonClass = "btn-outline-success";
        else if (btn.dataset.filter === "undriven")
          buttonClass = "btn-outline-danger";
        else if (btn.dataset.filter === "undriveable")
          buttonClass = "btn-outline-warning";
        else buttonClass = "btn-outline-primary";
      }

      btn.classList.add(buttonClass);
    });
  }

  /**
   * Show street on map
   */
  showStreetOnMap(streetName) {
    if (!this.coverageMap.map || !this.coverageMap.streetsGeoJson) return;

    const matchingFeatures = this.coverageMap.streetsGeoJson.features.filter(
      (f) => (f.properties?.street_name || "Unnamed") === streetName,
    );

    if (!matchingFeatures.length) {
      this.notificationManager?.show(
        `No geometry found for '${streetName}'.`,
        "warning",
      );
      return;
    }

    const selSource = "selected-street";
    const selLayer = "selected-street-layer";
    if (this.coverageMap.map.getLayer(selLayer))
      this.coverageMap.map.removeLayer(selLayer);
    if (this.coverageMap.map.getSource(selSource))
      this.coverageMap.map.removeSource(selSource);

    this.coverageMap.map.addSource(selSource, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: matchingFeatures,
      },
    });

    this.coverageMap.map.addLayer({
      id: selLayer,
      type: "line",
      source: selSource,
      paint: {
        "line-color": "#00e5ff",
        "line-width": 6,
        "line-opacity": 0.9,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    const bounds = new mapboxgl.LngLatBounds();
    matchingFeatures.forEach((f) => {
      const geom = f.geometry;
      if (!geom) return;
      const extendCoord = (coord) => bounds.extend(coord);
      if (geom.type === "LineString") geom.coordinates.forEach(extendCoord);
      else if (geom.type === "MultiLineString")
        geom.coordinates.forEach((line) => {
          line.forEach(extendCoord);
        });
    });
    if (!bounds.isEmpty()) {
      this.coverageMap.map.fitBounds(bounds, {
        padding: 40,
        maxZoom: 18,
        duration: 800,
      });
    }
  }

  /**
   * Handle trip overlay toggle
   */
  handleTripOverlayToggle(enabled) {
    this.showTripsActive = enabled;
    this.coverageMap.showTripsActive = enabled;

    if (enabled) {
      this.coverageMap.setupTripLayers();
      this.coverageMap.loadTripsForView();
    } else {
      this.coverageMap.clearTripOverlay();
    }

    localStorage.setItem("showTripsOverlay", enabled.toString());
  }
}
