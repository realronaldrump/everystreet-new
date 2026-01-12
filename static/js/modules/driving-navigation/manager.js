/* global mapboxgl, notificationManager */

/**
 * Main manager for Driving Navigation.
 * Coordinates between API, Map, and UI modules to provide
 * the complete driving navigation experience.
 */

import { DrivingNavigationAPI } from "./api.js";
import { DRIVING_NAV_DEFAULTS } from "./constants.js";
import { DrivingNavigationMap } from "./map.js";
import { DrivingNavigationUI } from "./ui.js";

export class DrivingNavigation {
  /**
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    const globalConfig =
      window.coverageNavigatorConfig?.drivingNavigation || {};
    this.config = {
      ...DRIVING_NAV_DEFAULTS,
      ...globalConfig,
      ...options,
    };

    // Initialize modules
    this.api = new DrivingNavigationAPI();
    this.mapManager = new DrivingNavigationMap(this.config.mapContainerId, {
      useSharedMap: this.config.useSharedMap,
    });
    this.ui = new DrivingNavigationUI(this.config);

    // State
    this.coverageAreas = [];
    this.selectedArea = null;
    this.lastKnownLocation = null;
    this.isFetchingRoute = false;
    this.suggestedClusters = [];
    this.currentRoute = null;

    this.initialize();
  }

  /**
   * Initialize the driving navigation system.
   */
  async initialize() {
    await this.initMap();
    this.setupEventListeners();
    await this.loadCoverageAreas();
    this.ui.loadAutoFollowState();
  }

  /**
   * Initialize the map.
   * @returns {Promise<void>}
   */
  async initMap() {
    try {
      await this.mapManager.initialize();
      this.ui.setStatus("Map initialized. Select an area.");

      // Set up map interactivity
      this.mapManager.setupInteractivity((feature) =>
        this.ui.createSegmentPopup(feature),
      );
    } catch (error) {
      console.error("Error initializing map:", error);
      this.ui.setStatus("Error initializing map.", true);
      throw error;
    }
  }

  /**
   * Set up all event listeners.
   */
  setupEventListeners() {
    this.ui.areaSelect?.addEventListener("change", () =>
      this.handleAreaChange(),
    );
    this.ui.findBtn?.addEventListener("click", () =>
      this.findAndDisplayRoute(),
    );
    this.ui.findEfficientBtn?.addEventListener("click", () =>
      this.findEfficientStreetClusters(),
    );
    this.ui.autoFollowToggle?.addEventListener("change", (e) =>
      this.ui.saveAutoFollowState(e.target.checked),
    );
    this.ui.openGoogleMapsBtn?.addEventListener("click", () =>
      this.openInGoogleMaps(),
    );
    this.ui.openAppleMapsBtn?.addEventListener("click", () =>
      this.openInAppleMaps(),
    );

    // Listen for updates from LiveTripTracker
    document.addEventListener(
      "liveTrackingUpdated",
      this.handleLiveTrackingUpdate.bind(this),
    );

    // Listen for coverage areas being loaded by OptimalRoutesManager
    document.addEventListener("coverageAreasLoaded", (e) => {
      if (e.detail?.areas) {
        this.coverageAreas = e.detail.areas;
      }
    });

    // Delegate click for dynamically created popup buttons
    document.addEventListener("click", (event) => {
      if (event.target.matches(".navigate-to-segment")) {
        const { segmentId } = event.target.dataset;
        // Close all popups
        document.querySelectorAll(".mapboxgl-popup").forEach((p) => {
          p.remove();
        });
        this.mapManager.highlightTargetStreet(segmentId);
        this.findRouteToSegment(segmentId);
      }
    });
  }

  /**
   * Handle live tracking updates from the LiveTripTracker.
   * @param {CustomEvent} event - The liveTrackingUpdated event
   */
  handleLiveTrackingUpdate(event) {
    const { detail } = event;
    if (detail.trip?.coordinates && detail.trip.coordinates.length > 0) {
      const lastCoord =
        detail.trip.coordinates[detail.trip.coordinates.length - 1];
      this.lastKnownLocation = { lat: lastCoord.lat, lon: lastCoord.lon };

      if (this.ui.getAutoFollowState()) {
        this.mapManager.panTo([
          this.lastKnownLocation.lon,
          this.lastKnownLocation.lat,
        ]);
      }

      // Enable buttons if they were disabled due to no location
      const buttonsToEnable = [this.ui.findBtn, this.ui.findEfficientBtn];
      buttonsToEnable.forEach((btn) => {
        if (
          btn?.disabled &&
          btn.dataset.disabledReason === "no-location" &&
          this.selectedArea
        ) {
          btn.disabled = false;
          delete btn.dataset.disabledReason;
        }
      });
    }
  }

  /**
   * Load coverage areas from the API.
   */
  async loadCoverageAreas() {
    try {
      this.coverageAreas = await this.api.loadCoverageAreas();
      if (this.config.populateAreaSelect) {
        this.ui.populateAreaDropdown(this.coverageAreas);
      }
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.ui.setStatus(`Error loading areas: ${error.message}`, true);
      if (this.ui.areaSelect) {
        this.ui.areaSelect.innerHTML =
          '<option value="">Error loading areas</option>';
      }
    }
  }

  /**
   * Handle area selection change.
   */
  async handleAreaChange() {
    const selectedValue = this.ui.areaSelect?.value || "";

    // Clear all map layers
    this.mapManager.clearSources([
      "undriven-streets",
      "route",
      "target-street",
      "efficient-clusters",
    ]);
    this.mapManager.clearEfficientClusters();

    if (!selectedValue) {
      this.selectedArea = null;
      this.ui.setNavigationButtonsEnabled(false);
      this.ui.setStatus("Select an area.");
      this.ui.clearRouteUI();
      this.ui.setMapLinkButtonsEnabled(false);
      this.currentRoute = null;
      return;
    }

    try {
      const areaMatch = this.coverageAreas.find(
        (area) => String(area.id || area._id || "") === selectedValue,
      );

      if (areaMatch) {
        this.selectedArea = areaMatch;
      } else {
        // Fallback: try parsing if it looks like a JSON object
        if (selectedValue.trim().startsWith("{")) {
          this.selectedArea = JSON.parse(selectedValue);
        } else {
          console.warn("Could not find area for ID:", selectedValue);
          this.selectedArea = null;
        }
      }

      if (!this.selectedArea) {
        this.ui.setStatus("Invalid area selected.", true);
        return;
      }

      this.ui.setStatus(
        `Area selected: ${this.selectedArea.display_name || "Unknown"}. Loading streets...`,
      );
      this.ui.setNavigationButtonsEnabled(true);
      this.ui.clearRouteUI();
      this.ui.setMapLinkButtonsEnabled(false);
      this.currentRoute = null;

      await this.fetchAndDisplayUndrivenStreets();
    } catch (error) {
      console.error("Error parsing selected area:", error);
      this.selectedArea = null;
      this.ui.setNavigationButtonsEnabled(false);
      this.ui.setStatus("Invalid area selected.", true);
    }
  }

  /**
   * Fetch and display undriven streets on the map.
   */
  async fetchAndDisplayUndrivenStreets() {
    if (!this.selectedArea) {
      this.ui.setStatus("Please select an area first.", true);
      return;
    }
    if (!this.mapManager.isReady()) {
      this.ui.setStatus("Map not initialized.", true);
      return;
    }

    this.ui.showProgressContainer();
    this.ui.updateProgress(0, "Loading undriven streets...");

    // Clear map sources
    this.mapManager.clearSources(["route", "target-street"]);
    this.ui.clearRouteUI();
    this.ui.setMapLinkButtonsEnabled(false);
    this.currentRoute = null;

    try {
      this.ui.updateProgress(20, "Fetching undriven streets from database...");

      const areaId = this.selectedArea.id || this.selectedArea._id;
      const geojson = await this.api.fetchUndrivenStreets(areaId);

      this.ui.updateProgress(60, "Processing street data...");

      if (geojson?.features?.length > 0) {
        const driveableFeatures = geojson.features.filter(
          (feature) => feature.properties?.status !== "undriveable",
        );
        const driveableGeoJSON = {
          type: "FeatureCollection",
          features: driveableFeatures,
        };

        this.ui.updateProgress(80, "Rendering streets on map...");

        this.mapManager.setSourceData("undriven-streets", driveableGeoJSON);

        // Calculate bounds
        const bounds = new mapboxgl.LngLatBounds();
        driveableFeatures.forEach((feature) => {
          if (feature.geometry.type === "LineString") {
            feature.geometry.coordinates.forEach((coord) => {
              bounds.extend(coord);
            });
          }
        });

        this.mapManager.fitBounds(bounds, { padding: 50 });

        this.ui.updateProgress(100, "Loaded undriven streets!");
        setTimeout(() => this.ui.hideProgressContainer(), 1000);
        this.ui.setStatus(
          `Loaded ${driveableFeatures.length} undriven streets in ${this.selectedArea.display_name || "Unknown"}.`,
        );
      } else {
        this.ui.hideProgressContainer();
        this.ui.setStatus(
          `No undriven streets found in ${this.selectedArea.display_name || "Unknown"}.`,
        );
      }
    } catch (error) {
      console.error("Error fetching/displaying undriven streets:", error);
      this.ui.hideProgressContainer();
      this.ui.setStatus(`Error loading streets: ${error.message}`, true);
    }
  }

  /**
   * Find and display route to the nearest undriven street.
   */
  async findAndDisplayRoute() {
    if (!this.selectedArea) {
      this.ui.setStatus("Please select an area first.", true);
      return;
    }
    if (this.isFetchingRoute) {
      return;
    }

    this.isFetchingRoute = true;
    const originalHtml = this.ui.setButtonLoading(
      this.ui.findBtn,
      "Finding Route...",
    );

    this.ui.setStatus("Calculating route to nearest undriven street...");

    // Clear map sources
    this.mapManager.clearSources(["route", "target-street"]);
    this.ui.clearRouteUI();
    this.ui.setMapLinkButtonsEnabled(false);
    this.currentRoute = null;

    this.ui.showProgressContainer();
    this.ui.setActiveStep("clustering");

    try {
      this.ui.updateProgress(30, "Finding the nearest undriven street...");

      const data = await this.api.findNextRoute({
        location: this.selectedArea.location,
        currentPosition: this.lastKnownLocation,
      });

      if (data.status === "completed") {
        this.ui.hideProgressContainer();
        this.ui.setStatus(data.message);
        if (notificationManager) {
          notificationManager.show(data.message, "success");
        }
      } else if (
        data.status === "success" &&
        data.route_geometry &&
        data.target_street
      ) {
        this.ui.setActiveStep("rendering");
        this.displayRoute(data);
        this.ui.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.ui.hideProgressContainer(), 1000);
      } else {
        throw new Error(
          data.message || "Received unexpected success response.",
        );
      }
    } catch (error) {
      const errorMessage = await this.api.parseError(error);
      console.error("Error finding/displaying route:", errorMessage);
      this.ui.hideProgressContainer();
      this.ui.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager) {
        notificationManager.show(`Routing Error: ${errorMessage}`, "danger");
      }
    } finally {
      this.ui.restoreButton(this.ui.findBtn, originalHtml);
      this.isFetchingRoute = false;
    }
  }

  /**
   * Display a calculated route on the map and UI.
   * @param {Object} data - Route data from API
   */
  displayRoute(data) {
    if (!this.mapManager.isReady()) {
      return;
    }

    // Set route data on map
    if (data.route_geometry) {
      this.mapManager.setSourceData("route", data.route_geometry);
    }
    this.mapManager.highlightTargetStreet(data.target_street?.segment_id);

    // Update UI
    const streetName = data.target_street?.street_name || "Unnamed Street";
    const segmentId = data.target_street?.segment_id || "Unknown";
    this.ui.displayTargetInfo(streetName, segmentId);

    const durationMinutes = Math.round(data.route_duration_seconds / 60);
    const distanceMiles = (data.route_distance_meters * 0.000621371).toFixed(1);
    const locationSource = data.location_source || "unknown";

    if (data.route_geometry?.coordinates) {
      const { coordinates } = data.route_geometry;
      this.currentRoute = {
        start: { lat: coordinates[0][1], lng: coordinates[0][0] },
        end: {
          lat: coordinates[coordinates.length - 1][1],
          lng: coordinates[coordinates.length - 1][0],
        },
      };
      this.ui.setMapLinkButtonsEnabled(true);
    } else {
      this.currentRoute = null;
      this.ui.setMapLinkButtonsEnabled(false);
    }

    this.ui.displayRouteDetailsContent(
      durationMinutes,
      distanceMiles,
      locationSource,
    );
    this.ui.showRouteDetails({
      clusters: 1,
      segments: 1,
      duration: data.route_duration_seconds,
      distance: data.route_distance_meters,
    });

    // Fit map to route
    const bounds = new mapboxgl.LngLatBounds();
    data.route_geometry.coordinates.forEach((coord) => {
      bounds.extend(coord);
    });
    if (this.lastKnownLocation) {
      bounds.extend([this.lastKnownLocation.lon, this.lastKnownLocation.lat]);
    }
    this.mapManager.fitBounds(bounds, { padding: 70 });
  }

  /**
   * Find efficient street clusters to navigate to.
   */
  async findEfficientStreetClusters() {
    const areaId = this.selectedArea?._id || this.selectedArea?.id;
    if (!areaId) {
      this.ui.setStatus("Please select an area first.", true);
      return;
    }

    let currentLat = null;
    let currentLon = null;

    if (this.lastKnownLocation) {
      currentLat = this.lastKnownLocation.lat;
      currentLon = this.lastKnownLocation.lon;
    } else {
      try {
        const position = await this.getCurrentPosition();
        currentLat = position.coords.latitude;
        currentLon = position.coords.longitude;
        this.lastKnownLocation = { lat: currentLat, lon: currentLon };
      } catch {
        this.ui.setStatus(
          "Unable to get current location. Please enable location services.",
          true,
        );
        return;
      }
    }

    const originalHtml = this.ui.setButtonLoading(
      this.ui.findEfficientBtn,
      "Finding...",
    );
    this.ui.setStatus("Finding efficient street clusters...");
    this.mapManager.clearEfficientClusters();

    try {
      const data = await this.api.findEfficientClusters(areaId, {
        currentLat,
        currentLon,
        topN: 3,
        minClusterSize: 2,
      });

      if (data.status === "no_streets" || data.status === "no_clusters") {
        this.ui.setStatus(data.message, true);
        if (notificationManager) {
          notificationManager.show(data.message, "info");
        }
        return;
      }

      if (data.status === "success" && data.suggested_clusters?.length > 0) {
        this.suggestedClusters = data.suggested_clusters;
        this.displayEfficientClusters(data.suggested_clusters);

        const topCluster = data.suggested_clusters[0];
        const distanceMiles = (
          topCluster.distance_to_cluster_m / 1609.34
        ).toFixed(1);
        this.ui.setStatus(
          `Found ${data.suggested_clusters.length} efficient clusters. Top cluster: ${topCluster.segment_count} streets, ${distanceMiles} mi away.`,
        );
        this.ui.displayEfficientClustersInfo(
          data.suggested_clusters,
          this.mapManager.clusterColors,
        );

        setTimeout(async () => {
          // If confirmationDialog exists, ask user; otherwise navigate directly
          if (window.confirmationDialog?.show) {
            const confirmed = await window.confirmationDialog.show({
              title: "Navigate to Cluster",
              message: `Navigate to the top cluster with ${topCluster.segment_count} streets?`,
              confirmText: "Navigate",
              confirmButtonClass: "btn-primary",
            });

            if (confirmed) {
              this.mapManager.highlightTargetStreet(
                topCluster.nearest_segment.segment_id,
              );
              this.findRouteToSegment(topCluster.nearest_segment.segment_id);
            }
          } else {
            // Auto-navigate to the top cluster if no confirmation dialog
            this.mapManager.highlightTargetStreet(
              topCluster.nearest_segment.segment_id,
            );
            this.findRouteToSegment(topCluster.nearest_segment.segment_id);
          }
        }, 500);
      }
    } catch (error) {
      const errorMessage = await this.api.parseError(error);
      console.error("Error finding efficient clusters:", errorMessage);
      this.ui.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager) {
        notificationManager.show(
          `Error finding efficient clusters: ${errorMessage}`,
          "danger",
        );
      }
    } finally {
      this.ui.restoreButton(this.ui.findEfficientBtn, originalHtml);
    }
  }

  /**
   * Display efficient clusters on the map.
   * @param {Array} clusters - Array of cluster objects
   */
  displayEfficientClusters(clusters) {
    const bounds = this.mapManager.displayEfficientClusters(
      clusters,
      (cluster, index) => this.ui.createClusterPopup(cluster, index),
    );

    if (this.lastKnownLocation) {
      bounds.extend([this.lastKnownLocation.lon, this.lastKnownLocation.lat]);
    }
    this.mapManager.fitBounds(bounds, { padding: 50 });
  }

  /**
   * Find route to a specific segment.
   * @param {string} segmentId - The segment ID to navigate to
   */
  async findRouteToSegment(segmentId) {
    if (!this.selectedArea || !segmentId) {
      return;
    }

    this.ui.setStatus(`Calculating route to segment #${segmentId}...`);
    this.ui.setNavigationButtonsEnabled(false);
    this.ui.showProgressContainer();
    this.ui.setActiveStep("optimizing");

    try {
      const data = await this.api.findNextRoute({
        location: this.selectedArea.location,
        currentPosition: this.lastKnownLocation,
        segmentId,
      });

      if (data.status === "success" && data.route_geometry) {
        this.ui.setActiveStep("rendering");
        this.displayRoute(data);
        this.ui.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.ui.hideProgressContainer(), 1000);
      } else {
        throw new Error(data.message || "Could not calculate route to segment");
      }
    } catch (error) {
      const errorMessage = await this.api.parseError(error);
      this.ui.setStatus(`Error: ${errorMessage}`, true);
      this.ui.hideProgressContainer();
    } finally {
      this.ui.setNavigationButtonsEnabled(true);
    }
  }

  /**
   * Get the current geolocation position.
   * @returns {Promise<GeolocationPosition>}
   */
  async getCurrentPosition() {
    const geolocationService = (await import("../geolocation-service.js"))
      .default;
    return geolocationService.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  }

  /**
   * Open the current route in Google Maps.
   */
  openInGoogleMaps() {
    if (!this.currentRoute) {
      return;
    }
    const { start, end } = this.currentRoute;
    window.open(
      `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lng}&destination=${end.lat},${end.lng}&travelmode=driving`,
      "_blank",
    );
  }

  /**
   * Open the current route in Apple Maps.
   */
  openInAppleMaps() {
    if (!this.currentRoute) {
      return;
    }
    const { start, end } = this.currentRoute;
    window.open(
      `maps://maps.apple.com/?daddr=${end.lat},${end.lng}&saddr=${start.lat},${start.lng}`,
      "_blank",
    );
  }
}
