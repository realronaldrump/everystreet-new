/* global mapboxgl, notificationManager, confirmationDialog */

const DRIVING_NAV_DEFAULTS = {
  areaSelectId: "area-select",
  mapContainerId: "driving-map",
  populateAreaSelect: true,
  useSharedMap: false,
};

class DrivingNavigation {
  constructor(options = {}) {
    const globalConfig = window.coverageNavigatorConfig?.drivingNavigation || {};
    this.config = {
      ...DRIVING_NAV_DEFAULTS,
      ...globalConfig,
      ...options,
    };

    this.map = null;

    // DOM Elements
    this.areaSelect = document.getElementById(this.config.areaSelectId);
    this.findBtn = document.getElementById("find-next-street-btn");
    this.findEfficientBtn = document.getElementById("find-efficient-street-btn");
    this.statusMsg = document.getElementById("status-message");
    this.targetInfo = document.getElementById("target-info");
    this.autoFollowToggle = document.getElementById("auto-follow-toggle");
    this.openGoogleMapsBtn = document.getElementById("open-google-maps-btn");
    this.openAppleMapsBtn = document.getElementById("open-apple-maps-btn");
    this.progressContainer = document.getElementById("route-progress-container");
    this.progressBar = document.getElementById("route-progress-bar");
    this.processingStatus = document.getElementById("processing-status");
    this.routeDetails = document.getElementById("route-details");
    this.routeStats = document.getElementById("route-stats");
    this.stepClustering = document.getElementById("step-clustering");
    this.stepOptimizing = document.getElementById("step-optimizing");
    this.stepRendering = document.getElementById("step-rendering");

    // State
    this.coverageAreas = [];
    this.selectedArea = null;
    this.lastKnownLocation = null;
    this.isFetchingRoute = false;
    this.currentStep = null;
    this.suggestedClusters = [];
    this.clusterMarkers = [];
    this.currentRoute = null;

    // Default cluster colors if MapStyles not yet loaded
    this.clusterColors = window.MapStyles?.MAP_LAYER_COLORS?.clusters || [
      "#6366f1",
      "#8b5cf6",
      "#3b82f6",
      "#ef4444",
      "#f59e0b",
      "#a78bfa",
      "#10b981",
      "#06b6d4",
      "#d946ef",
      "#84cc16",
    ];

    this.initialize();
  }

  async initialize() {
    await this.initMap();
    this.setupEventListeners();
    await this.loadCoverageAreas();
    this.loadAutoFollowState();
  }

  initMap() {
    if (this.config.useSharedMap && window.coverageMasterMap) {
      this.map = window.coverageMasterMap;
      return new Promise((resolve, reject) => {
        this.attachMapHandlers(resolve, reject);
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const mapContainer = document.getElementById(this.config.mapContainerId);
        if (!mapContainer) {
          throw new Error(`Map container #${this.config.mapContainerId} not found!`);
        }

        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
        this.map = new mapboxgl.Map({
          container: this.config.mapContainerId,
          style: "mapbox://styles/mapbox/dark-v11",
          center: [-96, 37.8],
          zoom: 3,
        });

        this.map.on("load", () => {
          this.setStatus("Map initialized. Select an area.");
          this.setupMapLayers();

          // Note: LiveTripTracker is instantiated centrally in app-controller.js
          // This page listens for liveTrackingUpdated events instead of creating its own instance

          resolve();
        });

        this.map.on("error", (e) => {
          console.error("Mapbox error:", e);
          this.setStatus("Error initializing map.", true);
          reject(e);
        });
      } catch (error) {
        console.error("Error initializing map:", error);
        this.setStatus("Error initializing map.", true);
        reject(error);
      }
    });
  }

  attachMapHandlers(resolve, reject) {
    if (!this.map) {
      if (resolve) resolve();
      return;
    }
    const handleLoad = () => {
      this.setStatus("Map initialized. Select an area.");
      this.setupMapLayers();
      if (resolve) resolve();
    };

    if (typeof this.map.isStyleLoaded === "function" && this.map.isStyleLoaded()) {
      handleLoad();
    } else {
      this.map.on("load", handleLoad);
    }

    this.map.on("error", (e) => {
      console.error("Mapbox error:", e);
      this.setStatus("Error initializing map.", true);
      if (reject) reject(e);
    });
  }

  setupMapLayers() {
    if (!this.map) return;
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // Get colors with fallbacks
    const streetColors = window.MapStyles?.MAP_LAYER_COLORS?.streets || {
      undriven: "#8b9dc3",
      driven: "#10b981",
    };
    const routeColors = window.MapStyles?.MAP_LAYER_COLORS?.routes || {
      calculated: "#3b82f6", // Changed to blue to stand out from green driven streets
      target: "#d4a574",
    };

    // Source and Layer for Undriven Streets
    if (!this.map.getSource("undriven-streets")) {
      this.map.addSource("undriven-streets", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    if (!this.map.getLayer("undriven-streets-layer")) {
      this.map.addLayer({
        id: "undriven-streets-layer",
        type: "line",
        source: "undriven-streets",
        paint: {
          "line-color": streetColors.undriven,
          "line-width": 3,
          "line-opacity": 0.6,
          "line-dasharray": [2, 2],
        },
      });
    }

    // Source and Layer for Calculated Route
    if (!this.map.getSource("route")) {
      this.map.addSource("route", { type: "geojson", data: emptyGeoJSON });
    }
    if (!this.map.getLayer("route-layer")) {
      this.map.addLayer({
        id: "route-layer",
        type: "line",
        source: "route",
        paint: {
          "line-color": routeColors.calculated,
          "line-width": 5,
          "line-opacity": 0.8,
        },
      });
    }

    // Source and Layer for Highlighted Target Street
    if (!this.map.getSource("target-street")) {
      this.map.addSource("target-street", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    if (!this.map.getLayer("target-street-layer")) {
      this.map.addLayer({
        id: "target-street-layer",
        type: "line",
        source: "target-street",
        paint: {
          "line-color": routeColors.target,
          "line-width": 6,
          "line-opacity": 1,
        },
      });
    }

    // Source and Layer for Efficient Clusters
    if (!this.map.getSource("efficient-clusters")) {
      this.map.addSource("efficient-clusters", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    this.clusterColors.forEach((color, index) => {
      const layerId = `efficient-cluster-layer-${index}`;
      if (this.map.getLayer(layerId)) return;
      this.map.addLayer({
        id: layerId,
        type: "line",
        source: "efficient-clusters",
        paint: { "line-color": color, "line-width": 5, "line-opacity": 0.7 },
        filter: ["==", "clusterIndex", index],
      });
    });
  }

  setupEventListeners() {
    this.areaSelect?.addEventListener("change", () => this.handleAreaChange());
    this.findBtn?.addEventListener("click", () => this.findAndDisplayRoute());
    this.findEfficientBtn?.addEventListener("click", () =>
      this.findEfficientStreetClusters()
    );
    this.autoFollowToggle?.addEventListener("change", (e) =>
      this.saveAutoFollowState(e.target.checked)
    );
    this.openGoogleMapsBtn?.addEventListener("click", () => this.openInGoogleMaps());
    this.openAppleMapsBtn?.addEventListener("click", () => this.openInAppleMaps());

    // Listen for updates from LiveTripTracker
    document.addEventListener(
      "liveTrackingUpdated",
      this.handleLiveTrackingUpdate.bind(this)
    );

    // Listen for coverage areas being loaded by OptimalRoutesManager
    document.addEventListener("coverageAreasLoaded", (e) => {
      if (e.detail?.areas) {
        this.coverageAreas = e.detail.areas;
      }
    });

    this.setupMapInteractivity();
  }

  handleLiveTrackingUpdate(event) {
    const { detail } = event;
    if (detail.trip?.coordinates && detail.trip.coordinates.length > 0) {
      const lastCoord = detail.trip.coordinates[detail.trip.coordinates.length - 1];
      this.lastKnownLocation = { lat: lastCoord.lat, lon: lastCoord.lon };

      if (this.getAutoFollowState()) {
        this.map.panTo([this.lastKnownLocation.lon, this.lastKnownLocation.lat]);
      }

      // Enable buttons if they were disabled due to no location
      const buttonsToEnable = [this.findBtn, this.findEfficientBtn];
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
    } else {
      // If trip ends or is lost, we can keep the last known location for a while
      // but should not clear it immediately. The routing functions will use it.
    }
  }

  loadAutoFollowState() {
    if (!this.autoFollowToggle) return;
    const savedState = window.localStorage.getItem("drivingNavAutoFollow") === "true";
    this.autoFollowToggle.checked = savedState;
  }

  saveAutoFollowState(isEnabled) {
    this.autoFollowState = isEnabled;
    window.localStorage.setItem("drivingNavAutoFollow", isEnabled);
  }

  getAutoFollowState() {
    return this.autoFollowToggle ? this.autoFollowToggle.checked : false;
  }

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;
    this.statusMsg.textContent = message;
    this.statusMsg.className = isError ? "text-danger" : "text-info";
  }

  async loadCoverageAreas() {
    try {
      if (Array.isArray(window.coverageNavigatorAreas)) {
        this.coverageAreas = window.coverageNavigatorAreas;
        if (this.config.populateAreaSelect) {
          this.populateAreaDropdown();
        }
        return;
      }

      const response = await fetch("/api/coverage_areas");
      if (!response.ok)
        throw new Error(`Failed to fetch areas: ${response.statusText}`);
      const data = await response.json();

      if (data.success && data.areas) {
        this.coverageAreas = data.areas;
        window.coverageNavigatorAreas = data.areas;
        if (this.config.populateAreaSelect) {
          this.populateAreaDropdown();
        }
      } else {
        throw new Error(data.error || "Invalid response format");
      }
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.setStatus(`Error loading areas: ${error.message}`, true);
      if (this.areaSelect)
        this.areaSelect.innerHTML = '<option value="">Error loading areas</option>';
    }
  }

  populateAreaDropdown() {
    if (!this.areaSelect) return;
    this.areaSelect.innerHTML = '<option value="">Select an area...</option>';
    this.coverageAreas.forEach((area) => {
      const areaId = area._id || area.id;
      if (area.location?.display_name && areaId) {
        const option = document.createElement("option");
        option.value = String(areaId);
        option.textContent = area.location.display_name;
        option.dataset.areaId = String(areaId);
        this.areaSelect.appendChild(option);
      }
    });
  }

  async handleAreaChange() {
    const selectedValue = this.areaSelect?.value || "";
    const buttons = [this.findBtn, this.findEfficientBtn];
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // Clear all map layers (with null checks)
    if (this.map) {
      const sources = [
        "undriven-streets",
        "route",
        "target-street",
        "efficient-clusters",
      ];
      sources.forEach((sourceId) => {
        const source = this.map.getSource(sourceId);
        if (source) source.setData(emptyGeoJSON);
      });
    }
    this.clearEfficientClusters(); // Also removes markers

    if (!selectedValue) {
      this.selectedArea = null;
      buttons.forEach((btn) => {
        if (btn) btn.disabled = true;
      });
      this.setStatus("Select an area.");
      const routeDetailsContent = document.getElementById("route-details-content");
      if (routeDetailsContent) routeDetailsContent.innerHTML = "";
      if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = true;
      if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = true;
      this.currentRoute = null;
      return;
    }

    try {
      const areaMatch = this.coverageAreas.find(
        (area) =>
          String(area._id || area.id || "") === selectedValue ||
          String(area.location?.id || "") === selectedValue
      );

      if (areaMatch) {
        this.selectedArea = areaMatch;
      } else {
        // Fallback: try parsing if it looks like a JSON object (starts with {)
        if (selectedValue.trim().startsWith("{")) {
          this.selectedArea = JSON.parse(selectedValue);
        } else {
          console.warn("Could not find area for ID:", selectedValue);
          this.selectedArea = null;
          // Don't throw here, just let the next check handle null
        }
      }

      if (!this.selectedArea) {
        this.setStatus("Invalid area selected.", true);
        return;
      }

      this.setStatus(
        `Area selected: ${this.selectedArea.location.display_name}. Loading streets...`
      );
      buttons.forEach((btn) => {
        if (btn) btn.disabled = false;
      });

      if (this.targetInfo) this.targetInfo.innerHTML = "";
      const routeDetailsContent = document.getElementById("route-details-content");
      if (routeDetailsContent) routeDetailsContent.innerHTML = "";
      if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = true;
      if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = true;
      this.currentRoute = null;

      await this.fetchAndDisplayUndrivenStreets();
    } catch (error) {
      console.error("Error parsing selected area:", error);
      this.selectedArea = null;
      buttons.forEach((btn) => {
        if (btn) btn.disabled = true;
      });
      this.setStatus("Invalid area selected.", true);
    }
  }

  async fetchAndDisplayUndrivenStreets() {
    if (!this.selectedArea) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (!this.map) {
      this.setStatus("Map not initialized.", true);
      return;
    }

    this.showProgressContainer();
    this.updateProgress(0, "Loading undriven streets...");

    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // Clear map sources with null checks
    const sourcesToClear = ["route", "target-street"];
    sourcesToClear.forEach((sourceId) => {
      const source = this.map.getSource(sourceId);
      if (source) source.setData(emptyGeoJSON);
    });

    if (this.targetInfo) this.targetInfo.innerHTML = "";
    const routeDetailsContent = document.getElementById("route-details-content");
    if (routeDetailsContent) routeDetailsContent.innerHTML = "";
    this.hideRouteDetails();
    if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = true;
    if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = true;
    this.currentRoute = null;

    try {
      this.showProgressContainer();
      this.updateProgress(20, "Fetching undriven streets from database...");

      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.selectedArea.location),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error ${response.status}`);
      }

      this.updateProgress(60, "Processing street data...");
      const geojson = await response.json();

      this.updateProgress(80, "Rendering streets on map...");

      if (geojson?.features?.length > 0) {
        const driveableFeatures = geojson.features.filter(
          (feature) => !feature.properties?.undriveable
        );
        const driveableGeoJSON = {
          type: "FeatureCollection",
          features: driveableFeatures,
        };

        const undrivenSource = this.map.getSource("undriven-streets");
        if (undrivenSource) {
          undrivenSource.setData(driveableGeoJSON);
        }

        const bounds = new mapboxgl.LngLatBounds();
        driveableFeatures.forEach((feature) => {
          if (feature.geometry.type === "LineString") {
            feature.geometry.coordinates.forEach((coord) => {
              bounds.extend(coord);
            });
          }
        });

        if (!bounds.isEmpty()) this.map.fitBounds(bounds, { padding: 50 });

        this.updateProgress(100, "Loaded undriven streets!");
        setTimeout(() => this.hideProgressContainer(), 1000);
        this.setStatus(
          `Loaded ${driveableFeatures.length} undriven streets in ${this.selectedArea.location.display_name}.`
        );
      } else {
        this.hideProgressContainer();
        this.setStatus(
          `No undriven streets found in ${this.selectedArea.location.display_name}.`
        );
      }
    } catch (error) {
      console.error("Error fetching/displaying undriven streets:", error);
      this.hideProgressContainer();
      this.setStatus(`Error loading streets: ${error.message}`, true);
    }
  }

  async findAndDisplayRoute() {
    if (!this.selectedArea) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (this.isFetchingRoute) return;

    this.isFetchingRoute = true;
    const originalHtml = this.findBtn.innerHTML;
    this.findBtn.disabled = true;
    this.findBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Finding Route...';

    this.setStatus("Calculating route to nearest undriven street...");
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // Clear map sources with null checks
    if (this.map) {
      const routeSource = this.map.getSource("route");
      const targetSource = this.map.getSource("target-street");
      if (routeSource) routeSource.setData(emptyGeoJSON);
      if (targetSource) targetSource.setData(emptyGeoJSON);
    }

    if (this.targetInfo) this.targetInfo.innerHTML = "";
    const routeDetailsContent = document.getElementById("route-details-content");
    if (routeDetailsContent) routeDetailsContent.innerHTML = "";
    this.hideRouteDetails();
    if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = true;
    if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = true;
    this.currentRoute = null;

    this.showProgressContainer();
    this.setActiveStep("clustering");

    try {
      const requestPayload = {
        location: this.selectedArea.location,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };

      this.updateProgress(30, "Finding the nearest undriven street...");
      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) throw response;

      this.setActiveStep("optimizing");
      const data = await response.json();

      if (data.status === "completed") {
        this.hideProgressContainer();
        this.setStatus(data.message);
        if (notificationManager) notificationManager.show(data.message, "success");
      } else if (
        data.status === "success" &&
        data.route_geometry &&
        data.target_street
      ) {
        this.setActiveStep("rendering");
        this.displayRoute(data);
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.hideProgressContainer(), 1000);
      } else {
        throw new Error(data.message || "Received unexpected success response.");
      }
    } catch (error) {
      const errorMessage = await this._parseError(error);
      console.error("Error finding/displaying route:", errorMessage);
      this.hideProgressContainer();
      this.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager)
        notificationManager.show(`Routing Error: ${errorMessage}`, "danger");
    } finally {
      this.findBtn.disabled = false;
      this.findBtn.innerHTML = originalHtml;
      this.isFetchingRoute = false;
    }
  }

  displayRoute(data) {
    if (!this.map) return;

    const routeSource = this.map.getSource("route");
    if (routeSource && data.route_geometry) {
      routeSource.setData(data.route_geometry);
    }
    this.highlightTargetStreet(data.target_street?.segment_id);

    const streetName = data.target_street?.street_name || "Unnamed Street";
    const segmentId = data.target_street?.segment_id || "Unknown";
    if (this.targetInfo) {
      this.targetInfo.innerHTML = `
        <div class="alert alert-info p-2 mb-2">
          <i class="fas fa-map-pin me-2"></i>
          <strong>Target:</strong> ${streetName}
          <div class="mt-1 small text-light">Segment ID: ${segmentId}</div>
        </div>`;
    }

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
      if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = false;
      if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = false;
    } else {
      this.currentRoute = null;
      if (this.openGoogleMapsBtn) this.openGoogleMapsBtn.disabled = true;
      if (this.openAppleMapsBtn) this.openAppleMapsBtn.disabled = true;
    }

    const routeDetailsContent = document.getElementById("route-details-content");
    if (routeDetailsContent) {
      routeDetailsContent.innerHTML = `
        <div class="route-info-detail">
          <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
          <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
          <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
        </div>`;
    }

    this.showRouteDetails({
      clusters: 1,
      segments: 1,
      duration: data.route_duration_seconds,
      distance: data.route_distance_meters,
    });

    const bounds = new mapboxgl.LngLatBounds();
    data.route_geometry.coordinates.forEach((coord) => {
      bounds.extend(coord);
    });
    if (this.lastKnownLocation) {
      bounds.extend([this.lastKnownLocation.lon, this.lastKnownLocation.lat]);
    }
    if (!bounds.isEmpty()) {
      this.map.fitBounds(bounds, { padding: 70 });
    }
  }

  highlightTargetStreet(segmentId) {
    if (!this.map) return;

    const targetSource = this.map.getSource("target-street");
    if (!targetSource) return;

    // Query the rendered features from the undriven-streets layer
    const features = this.map.querySourceFeatures("undriven-streets", {
      filter: ["==", ["get", "segment_id"], segmentId],
    });

    if (features && features.length > 0) {
      targetSource.setData({
        type: "FeatureCollection",
        features: [features[0]],
      });
    } else {
      // Fallback: search through all features
      const allFeatures = this.map.querySourceFeatures("undriven-streets");
      const targetFeature = allFeatures.find(
        (f) => f.properties?.segment_id === segmentId
      );
      if (targetFeature) {
        targetSource.setData({
          type: "FeatureCollection",
          features: [targetFeature],
        });
      } else {
        targetSource.setData({ type: "FeatureCollection", features: [] });
      }
    }
  }

  async findEfficientStreetClusters() {
    const areaId = this.selectedArea?._id || this.selectedArea?.id;
    if (!areaId) {
      this.setStatus("Please select an area first.", true);
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
        this.setStatus(
          "Unable to get current location. Please enable location services.",
          true
        );
        return;
      }
    }

    const originalHtml = this.findEfficientBtn.innerHTML;
    this.findEfficientBtn.disabled = true;
    this.findEfficientBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Finding...';
    this.setStatus("Finding efficient street clusters...");
    this.clearEfficientClusters();

    try {
      const params = new URLSearchParams({
        current_lat: currentLat,
        current_lon: currentLon,
        top_n: 3,
        min_cluster_size: 2,
      });
      const url = `/api/driving-navigation/suggest-next-street/${areaId}?${params.toString()}`;

      const response = await fetch(url);
      if (!response.ok) throw response;

      const data = await response.json();
      if (data.status === "no_streets" || data.status === "no_clusters") {
        this.setStatus(data.message, true);
        if (notificationManager) notificationManager.show(data.message, "info");
        return;
      }

      if (data.status === "success" && data.suggested_clusters?.length > 0) {
        this.suggestedClusters = data.suggested_clusters;
        this.displayEfficientClusters(data.suggested_clusters);

        const topCluster = data.suggested_clusters[0];
        const distanceMiles = (topCluster.distance_to_cluster_m / 1609.34).toFixed(1);
        this.setStatus(
          `Found ${data.suggested_clusters.length} efficient clusters. Top cluster: ${topCluster.segment_count} streets, ${distanceMiles} mi away.`
        );
        this.displayEfficientClustersInfo(data.suggested_clusters);

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
              this.highlightTargetStreet(topCluster.nearest_segment.segment_id);
              this.findRouteToSegment(topCluster.nearest_segment.segment_id);
            }
          } else {
            // Auto-navigate to the top cluster if no confirmation dialog
            this.highlightTargetStreet(topCluster.nearest_segment.segment_id);
            this.findRouteToSegment(topCluster.nearest_segment.segment_id);
          }
        }, 500);
      }
    } catch (error) {
      const errorMessage = await this._parseError(error);
      console.error("Error finding efficient clusters:", errorMessage);
      this.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager)
        notificationManager.show(
          `Error finding efficient clusters: ${errorMessage}`,
          "danger"
        );
    } finally {
      this.findEfficientBtn.disabled = false;
      this.findEfficientBtn.innerHTML = originalHtml;
    }
  }

  displayEfficientClusters(clusters) {
    this.clearEfficientClusters();
    const bounds = new mapboxgl.LngLatBounds();

    const features = [];
    clusters.forEach((cluster, index) => {
      cluster.segments.forEach((segment) => {
        if (segment.geometry?.type === "LineString") {
          features.push({
            type: "Feature",
            geometry: segment.geometry,
            properties: { clusterIndex: index },
          });
        }
      });
    });
    this.map
      .getSource("efficient-clusters")
      .setData({ type: "FeatureCollection", features });

    clusters.forEach((cluster, index) => {
      const el = document.createElement("div");
      el.className = "efficient-cluster-marker";
      el.innerHTML = `<div class="cluster-marker-wrapper"><div class="cluster-marker-inner" style="background-color: ${this.clusterColors[index]};"><div class="cluster-number">${index + 1}</div><div class="cluster-count">${cluster.segment_count}</div></div></div>`;

      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(
        this.createClusterPopup(cluster, index)
      );

      const marker = new mapboxgl.Marker(el)
        .setLngLat(cluster.centroid)
        .setPopup(popup)
        .addTo(this.map);

      this.clusterMarkers.push(marker);
      bounds.extend(cluster.centroid);
    });

    if (this.lastKnownLocation)
      bounds.extend([this.lastKnownLocation.lon, this.lastKnownLocation.lat]);
    if (!bounds.isEmpty()) this.map.fitBounds(bounds, { padding: 50 });
  }

  clearEfficientClusters() {
    this.clusterMarkers.forEach((marker) => {
      marker.remove();
    });
    this.clusterMarkers = [];
    if (this.map) {
      const source = this.map.getSource("efficient-clusters");
      if (source) {
        source.setData({ type: "FeatureCollection", features: [] });
      }
    }
    this.suggestedClusters = [];
  }

  setupMapInteractivity() {
    if (!this.map) return;

    this.map.on("mouseenter", "undriven-streets-layer", () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", "undriven-streets-layer", () => {
      this.map.getCanvas().style.cursor = "";
    });

    this.map.on("click", "undriven-streets-layer", (e) => {
      if (!e.features || e.features.length === 0) return;
      const feature = e.features[0];
      const popupContent = this.createSegmentPopup(feature);

      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(popupContent).addTo(this.map);
    });

    // Delegate click for dynamically created popup buttons
    document.addEventListener("click", (event) => {
      if (event.target.matches(".navigate-to-segment")) {
        const { segmentId } = event.target.dataset;
        // Close all popups
        document.querySelectorAll(".mapboxgl-popup").forEach((p) => {
          p.remove();
        });
        this.highlightTargetStreet(segmentId);
        this.findRouteToSegment(segmentId);
      }
    });
  }

  async _parseError(error) {
    let message = "An unknown error occurred.";

    if (error instanceof Error) {
      ({ message } = error);
    } else if (error instanceof Response) {
      try {
        const err = await error.json();
        message = err.detail || JSON.stringify(err);
      } catch {
        message = error.statusText || `HTTP ${error.status}`;
      }
    }

    this.lastParsedErrorMessage = message;
    return message;
  }

  showProgressContainer() {
    if (this.progressContainer) this.progressContainer.classList.add("active");
    this.resetSteps();
  }
  hideProgressContainer() {
    if (this.progressContainer) this.progressContainer.classList.remove("active");
  }
  updateProgress(percent, status) {
    if (this.progressBar) this.progressBar.style.width = `${percent}%`;
    if (this.processingStatus) this.processingStatus.textContent = status;
  }
  resetSteps() {
    this.currentStep = null;
    [this.stepClustering, this.stepOptimizing, this.stepRendering].forEach((s) => {
      s.className = "step";
    });
  }
  setActiveStep(step) {
    this.resetSteps();
    this.currentStep = step;
    const steps = {
      clustering: {
        el: this.stepClustering,
        progress: 15,
        text: "Grouping segments...",
      },
      optimizing: {
        el: this.stepOptimizing,
        progress: 45,
        text: "Optimizing routes...",
      },
      rendering: {
        el: this.stepRendering,
        progress: 85,
        text: "Rendering route...",
      },
    };
    if (steps[step]) {
      if (steps.clustering.el)
        steps.clustering.el.className =
          step === "clustering" ? "step active" : "step completed";
      if (steps.optimizing.el)
        steps.optimizing.el.className =
          step === "optimizing"
            ? "step active"
            : step === "rendering"
              ? "step completed"
              : "step";
      if (steps.rendering.el)
        steps.rendering.el.className = step === "rendering" ? "step active" : "step";
      this.updateProgress(steps[step].progress, steps[step].text);
    }
  }
  showRouteDetails(routeData) {
    if (!this.routeDetails || !routeData) return;
    this.routeDetails.style.display = "block";
    const durationHours = Math.floor(routeData.duration / 3600);
    const durationMinutes = Math.floor((routeData.duration % 3600) / 60);
    const distanceMiles = (routeData.distance * 0.000621371).toFixed(1);
    this.routeStats.innerHTML = `<div><strong>Clusters:</strong> ${routeData.clusters || 1}</div><div><strong>Segments:</strong> ${routeData.segments || 1}</div><div><strong>Time:</strong> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div><div><strong>Distance:</strong> ${distanceMiles} mi</div>`;
  }
  hideRouteDetails() {
    if (this.routeDetails) this.routeDetails.style.display = "none";
  }
  createSegmentPopup(segment) {
    const props = segment.properties;
    const streetName = props.street_name || "Unnamed Street";
    const segmentId = props.segment_id || "Unknown";
    const content = `<div class="segment-popup"><h6>${streetName}</h6><div class="small text-muted">Segment ID: ${segmentId}</div><div class="mt-2"><button class="btn btn-sm btn-primary navigate-to-segment" data-segment-id="${segmentId}"><i class="fas fa-route me-1"></i> Navigate Here</button></div></div>`;
    this.lastSegmentPopup = { segmentId, content };
    return content;
  }
  async findRouteToSegment(segmentId) {
    if (!this.selectedArea || !segmentId) return;
    this.setStatus(`Calculating route to segment #${segmentId}...`);
    this.findBtn.disabled = true;
    this.findEfficientBtn.disabled = true;
    this.showProgressContainer();
    this.setActiveStep("optimizing");
    try {
      const requestPayload = {
        location: this.selectedArea.location,
        segment_id: segmentId,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };
      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      if (!response.ok) throw response;
      const data = await response.json();
      if (data.status === "success" && data.route_geometry) {
        this.setActiveStep("rendering");
        this.displayRoute(data);
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.hideProgressContainer(), 1000);
      } else {
        throw new Error(data.message || "Could not calculate route to segment");
      }
    } catch (error) {
      const errorMessage = await this._parseError(error);
      this.setStatus(`Error: ${errorMessage}`, true);
      this.hideProgressContainer();
    } finally {
      this.findBtn.disabled = false;
      this.findEfficientBtn.disabled = false;
    }
  }
  createClusterPopup(cluster, rank) {
    const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(1);
    const lengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
    const score = cluster.efficiency_score.toFixed(2);
    const content = `<div class="efficient-cluster-popup"><h6>Cluster #${rank + 1}</h6><div class="cluster-stats small"><div><i class="fas fa-road"></i> ${cluster.segment_count} streets</div><div><i class="fas fa-ruler"></i> ${lengthMiles} mi total</div><div><i class="fas fa-location-arrow"></i> ${distanceMiles} mi away</div><div><i class="fas fa-chart-line"></i> Score: ${score}</div></div><button class="btn btn-sm btn-primary mt-2 navigate-to-segment" data-segment-id="${cluster.nearest_segment.segment_id}"><i class="fas fa-route me-1"></i> Navigate to Cluster</button></div>`;
    this.lastClusterPopup = { rank, content };
    return content;
  }
  displayEfficientClustersInfo(clusters) {
    const routeDetailsContent = document.getElementById("route-details-content");
    if (!routeDetailsContent || !clusters || clusters.length === 0) return;

    const totalSegments = clusters.reduce((sum, c) => sum + c.segment_count, 0);
    const totalLengthMiles =
      clusters.reduce((sum, c) => sum + c.total_length_m, 0) / 1609.34;

    routeDetailsContent.innerHTML = `
      <div class="cluster-summary mb-2">
        <div class="d-flex justify-content-between small">
          <span>Clusters found:</span>
          <strong>${clusters.length}</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Total segments:</span>
          <strong>${totalSegments}</strong>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Total length:</span>
          <strong>${totalLengthMiles.toFixed(1)} mi</strong>
        </div>
      </div>
      <div class="cluster-list small" style="max-height: 120px; overflow-y: auto;">
        ${clusters
          .map(
            (c, i) => `
          <div class="cluster-item py-1 border-bottom" style="border-color: ${this.clusterColors[i]};">
            <strong style="color: ${this.clusterColors[i]};">Cluster #${i + 1}</strong>
            - ${c.segment_count} streets, ${(c.distance_to_cluster_m / 1609.34).toFixed(1)} mi away
          </div>
        `
          )
          .join("")}
      </div>
    `;
    this.showRouteDetails({
      clusters: clusters.length,
      segments: totalSegments,
      duration: 0,
      distance: totalLengthMiles * 1609.34,
    });
  }
  getCurrentPosition() {
    this.lastGeolocationRequestTime = Date.now();
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
  }
  openInGoogleMaps() {
    if (!this.currentRoute) return;
    const { start, end } = this.currentRoute;
    window.open(
      `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lng}&destination=${end.lat},${end.lng}&travelmode=driving`,
      "_blank"
    );
  }
  openInAppleMaps() {
    if (!this.currentRoute) return;
    const { start, end } = this.currentRoute;
    window.open(
      `maps://maps.apple.com/?daddr=${end.lat},${end.lng}&saddr=${start.lat},${start.lng}`,
      "_blank"
    );
  }
  formatLocationSource(source) {
    const sourceLabels = {
      "client-provided": "your device",
      "live-tracking": "live tracking",
      "last-trip-end": "last trip",
      "last-trip-end-multi": "last trip",
      "last-trip-end-point": "last trip",
    };
    const label = sourceLabels[source] || source || "unknown";
    this.lastLocationSourceLabel = label;
    return label;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof mapboxgl === "undefined") {
    console.error(
      "Mapbox GL JS library not found. Driving Navigation cannot initialize."
    );
    const mapContainerId =
      window.coverageNavigatorConfig?.drivingNavigation?.mapContainerId ||
      "driving-map";
    const mapDiv = document.getElementById(mapContainerId);
    if (mapDiv)
      mapDiv.innerHTML =
        '<div class="alert alert-danger m-3">Error: Mapping library failed to load.</div>';
    return;
  }
  window.drivingNav = new DrivingNavigation();

  const styleClusters = document.createElement("style");
  styleClusters.textContent = `
    .efficient-cluster-marker { cursor: pointer; transition: transform 0.2s; }
    .cluster-marker-wrapper { position: relative; width: 40px; height: 40px; }
    .cluster-marker-inner { position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; flex-direction: column; align-items: center; justify-content: center; color: white; font-weight: bold; }
    .cluster-number { font-size: 16px; line-height: 1; }
    .cluster-count { font-size: 10px; line-height: 1; opacity: 0.9; }
    .efficient-cluster-marker:hover { transform: scale(1.1); z-index: 1000 !important; }
  `;
  document.head.appendChild(styleClusters);
});
