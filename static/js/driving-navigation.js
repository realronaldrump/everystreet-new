/* global L, notificationManager, LiveTripTracker, window */

"use strict";

class DrivingNavigation {
  constructor() {
    this.map = null;
    this.areaSelect = document.getElementById("area-select");
    this.findBtn = document.getElementById("find-next-street-btn");
    this.calcCoverageBtn = document.getElementById(
      "calculate-coverage-route-btn",
    );
    this.findEfficientBtn = document.getElementById(
      "find-efficient-street-btn",
    );
    this.statusMsg = document.getElementById("status-message");
    this.targetInfo = document.getElementById("target-info");
    this.routeInfo = document.getElementById("route-info");
    this.autoFollowToggle = document.getElementById("auto-follow-toggle");

    this.exportCoverageRouteBtn = document.getElementById(
      "export-coverage-route-btn",
    );
    this.coverageRouteFormatSelect = document.getElementById(
      "coverage-route-format-select",
    );

    this.progressContainer = document.getElementById(
      "route-progress-container",
    );
    this.progressBar = document.getElementById("route-progress-bar");
    this.processingStatus = document.getElementById("processing-status");
    this.routeDetails = document.getElementById("route-details");
    this.routeStats = document.getElementById("route-stats");
    this.routeLegend = document.getElementById("route-legend");
    this.stepClustering = document.getElementById("step-clustering");
    this.stepOptimizing = document.getElementById("step-optimizing");
    this.stepRendering = document.getElementById("step-rendering");

    this.coverageAreas = [];
    this.selectedArea = null; // Will hold the full area object, including _id and location
    this.undrivenStreetsLayer = L.layerGroup();
    this.routeLayer = L.layerGroup();
    this.efficientClustersLayer = L.layerGroup();
    this.targetStreetLayer = null;

    this.liveTracker = null;
    this.lastKnownLocation = null;
    this.isFetchingRoute = false;
    this.isFetchingCoverageRoute = false;
    this.clearTripTimeout = null;
    this.currentStep = null;
    this.clusterColors = [
      "#ff6b6b",
      "#48dbfb",
      "#1dd1a1",
      "#feca57",
      "#ff9ff3",
      "#54a0ff",
      "#5f27cd",
      "#ff9f43",
      "#00d2d3",
      "#c8d6e5",
    ];

    this.currentCoverageRouteGeoJSON = null;
    this.suggestedClusters = [];
    this.clusterMarkers = [];
    this.clusterHighlights = [];

    this.initialize();
  }

  async initialize() {
    this.initMap();
    this.setupEventListeners();
    await this.loadCoverageAreas();
    this.initLiveTracking();
    this.loadAutoFollowState();
    this.setupMapInteractivity();
  }

  initMap() {
    try {
      const mapContainer = document.getElementById("driving-map");
      if (!mapContainer) {
        console.error("Map container #driving-map not found!");
        this.setStatus("Map container not found.", true);
        return;
      }
      mapContainer.innerHTML = "";
      this.map = L.map(mapContainer, {
        center: [37.8, -96],
        zoom: 4,
        zoomControl: true,
      });

      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 19,
        },
      ).addTo(this.map);

      this.undrivenStreetsLayer.addTo(this.map);
      this.routeLayer.addTo(this.map);
      this.efficientClustersLayer.addTo(this.map);

      this.setStatus("Map initialized. Select an area.");
      setTimeout(() => {
        if (this.map) {
          this.map.invalidateSize();
        }
      }, 150);
    } catch (error) {
      console.error("Error initializing map:", error);
      this.setStatus("Error initializing map.", true);
      const mapContainer = document.getElementById("driving-map");
      if (mapContainer) {
        mapContainer.innerHTML =
          '<div class="alert alert-danger m-3">Failed to initialize map. Please refresh.</div>';
      }
    }
  }

  initLiveTracking() {
    if (typeof LiveTripTracker === "undefined") {
      console.error("LiveTripTracker class not found.");
      this.setStatus("Live tracking unavailable (script missing).", true);
      return;
    }

    this.liveTracker = new LiveTripTracker(this.map);

    this.liveTracker.setActiveTrip = (trip) => {
      this.handleLiveTripUpdate(trip);
    };
    this.liveTracker.clearActiveTrip = () => {
      this.handleLiveTripClear();
    };

    if (window.handleError) {
      window.handleError(
        "Live tracking initialized for navigation.",
        "initLiveTracking",
        "info",
      );
    }
  }

  handleLiveTripUpdate(trip) {
    if (this.clearTripTimeout) {
      clearTimeout(this.clearTripTimeout);
      this.clearTripTimeout = null;
    }

    if (!trip || !trip.coordinates || trip.coordinates.length === 0) {
      this.handleLiveTripClear();
      return;
    }

    const sortedCoords = [...trip.coordinates].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
    );
    const latLngs = sortedCoords.map((coord) => [coord.lat, coord.lon]);
    const latestCoord = sortedCoords[sortedCoords.length - 1];
    const latLng = [latestCoord.lat, latestCoord.lon];

    this.lastKnownLocation = { lat: latestCoord.lat, lon: latestCoord.lon };

    if (this.liveTracker?.polyline) {
      this.liveTracker.polyline.setLatLngs(latLngs);
      this.liveTracker.polyline.bringToFront();
    }

    if (this.liveTracker?.marker) {
      if (!this.map.hasLayer(this.liveTracker.marker)) {
        this.liveTracker.marker.addTo(this.map);
      }

      this.liveTracker.marker.setLatLng(latLng);

      if (trip.currentSpeed !== undefined) {
        const speed = trip.currentSpeed;
        let markerClass = "live-location-marker";

        if (speed === 0) markerClass += " vehicle-stopped";
        else if (speed < 10) markerClass += " vehicle-slow";
        else if (speed < 35) markerClass += " vehicle-medium";
        else markerClass += " vehicle-fast";

        this.liveTracker.marker.setIcon(
          L.divIcon({
            className: markerClass,
            iconSize: [16, 16],
            html: `<div class="vehicle-marker-inner" data-speed="${Math.round(speed)}"></div>`,
            iconAnchor: [8, 8],
          }),
        );
      }

      if (this.liveTracker.marker.options.opacity === 0) {
        this.liveTracker.marker.setOpacity(1);
        if (this.map && this.getAutoFollowState()) {
          this.map.setView(latLng, 16);
        }
      } else if (this.map && this.getAutoFollowState()) {
        this.map.panTo(latLng, { animate: true, duration: 0.5 });
      }
    }

    this.setStatus(
      `Live tracking active. Speed: ${Math.round(trip.currentSpeed ?? 0)} mph`,
    );

    const buttonsToEnable = [
      this.findBtn,
      this.calcCoverageBtn,
      this.findEfficientBtn,
    ];
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

  handleLiveTripClear() {
    if (this.clearTripTimeout) return;
    const CLEAR_DELAY_MS = 7000;

    this.clearTripTimeout = setTimeout(() => {
      this.lastKnownLocation = null;
      if (this.liveTracker?.marker) this.liveTracker.marker.setOpacity(0);
      if (this.liveTracker?.polyline) this.liveTracker.polyline.setLatLngs([]);
      this.clearTripTimeout = null;
      this.setStatus(
        "Live tracking signal lost. Using last known trip end for routing.",
        true,
      );
    }, CLEAR_DELAY_MS);
  }

  setupEventListeners() {
    this.areaSelect?.addEventListener("change", () => this.handleAreaChange());
    this.findBtn?.addEventListener("click", () => this.findAndDisplayRoute());
    this.calcCoverageBtn?.addEventListener("click", () =>
      this.calculateAndDisplayCoverageRoute(),
    );
    this.findEfficientBtn?.addEventListener("click", () =>
      this.findEfficientStreetClusters(),
    );
    this.autoFollowToggle?.addEventListener("change", (e) => {
      this.saveAutoFollowState(e.target.checked);
      if (e.target.checked && this.lastKnownLocation) {
        this.map?.panTo([
          this.lastKnownLocation.lat,
          this.lastKnownLocation.lon,
        ]);
      }
    });
    this.exportCoverageRouteBtn?.addEventListener("click", () =>
      this.handleExportCoverageRoute(),
    );

    this.map?.on("layeradd", () =>
      setTimeout(() => this.bringLiveElementsToFront(), 50),
    );
    this.map?.on("zoomend", () => this.bringLiveElementsToFront());
    this.map?.on("moveend", () => this.bringLiveElementsToFront());
    document.addEventListener("mapUpdated", () =>
      this.bringLiveElementsToFront(),
    );
  }

  loadAutoFollowState() {
    if (!this.autoFollowToggle) return;
    const savedState =
      window.localStorage.getItem("drivingNavAutoFollow") === "true";
    this.autoFollowToggle.checked = savedState;
  }

  saveAutoFollowState(isEnabled) {
    window.localStorage.setItem("drivingNavAutoFollow", isEnabled);
  }

  getAutoFollowState() {
    return this.autoFollowToggle ? this.autoFollowToggle.checked : false;
  }

  async loadCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");
      if (!response.ok)
        throw new Error(`Failed to fetch areas: ${response.statusText}`);
      const data = await response.json();

      if (data.success && data.areas) {
        this.coverageAreas = data.areas;
        this.populateAreaDropdown();
      } else {
        throw new Error(data.error || "Invalid response format");
      }
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.setStatus(`Error loading areas: ${error.message}`, true);
      if (this.areaSelect)
        this.areaSelect.innerHTML =
          '<option value="">Error loading areas</option>';
    }
  }

  populateAreaDropdown() {
    if (!this.areaSelect) return;
    this.areaSelect.innerHTML = '<option value="">Select an area...</option>';
    this.coverageAreas.forEach((area) => {
      if (area.location?.display_name) {
        const option = document.createElement("option");
        option.value = JSON.stringify(area); // Store the entire area object
        option.textContent = area.location.display_name;
        this.areaSelect.appendChild(option);
      }
    });
  }

  async handleAreaChange() {
    const selectedValue = this.areaSelect.value;
    this.currentCoverageRouteGeoJSON = null;
    if (this.exportCoverageRouteBtn)
      this.exportCoverageRouteBtn.disabled = true;

    const buttons = [this.findBtn, this.calcCoverageBtn, this.findEfficientBtn];

    if (!selectedValue) {
      this.selectedArea = null;
      buttons.forEach((btn) => {
        if (btn) btn.disabled = true;
      });
      this.undrivenStreetsLayer.clearLayers();
      this.routeLayer.clearLayers();
      this.clearTargetStreetHighlight();
      this.clearEfficientClusters();
      this.setStatus("Select an area.");
      return;
    }

    try {
      this.selectedArea = JSON.parse(selectedValue);
      this.setStatus(
        `Area selected: ${this.selectedArea.location.display_name}. Loading streets...`,
      );
      buttons.forEach((btn) => {
        if (btn) btn.disabled = false;
      });

      this.undrivenStreetsLayer.clearLayers();
      this.routeLayer.clearLayers();
      this.clearTargetStreetHighlight();
      this.clearEfficientClusters();
      if (this.targetInfo) this.targetInfo.innerHTML = "";
      if (this.routeInfo) this.routeInfo.innerHTML = "";

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
    if (!this.selectedArea?.location) return;

    this.setStatus(
      `Fetching undriven streets for ${this.selectedArea.location.display_name}...`,
    );
    this.undrivenStreetsLayer.clearLayers();
    this.hideRouteDetails();

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

      if (geojson?.features && geojson.features.length > 0) {
        const geoJsonLayer = L.geoJSON(geojson, {
          style: {
            color: "#00BFFF",
            weight: 3,
            opacity: 0.6,
            dashArray: "4, 4",
            className: "undriven-street-nav",
          },
        });

        this.undrivenStreetsLayer.addLayer(geoJsonLayer);
        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [50, 50] });
        this.updateProgress(100, "Loaded undriven streets!");
        setTimeout(() => this.hideProgressContainer(), 1000);
        this.setStatus(
          `Loaded ${geojson.features.length} undriven streets in ${this.selectedArea.location.display_name}.`,
        );
      } else {
        this.hideProgressContainer();
        this.setStatus(
          `No undriven streets found in ${this.selectedArea.location.display_name}.`,
        );
        if (this.selectedArea.location.boundingbox) {
          try {
            const bbox = this.selectedArea.location.boundingbox.map(parseFloat);
            const bounds = L.latLngBounds([
              [bbox[0], bbox[2]],
              [bbox[1], bbox[3]],
            ]);
            if (bounds.isValid())
              this.map.fitBounds(bounds, { padding: [50, 50] });
          } catch (e) {
            console.warn("Could not parse bounding box for fallback zoom.");
          }
        }
      }
    } catch (error) {
      console.error("Error fetching/displaying undriven streets:", error);
      this.hideProgressContainer();
      this.setStatus(`Error loading streets: ${error.message}`, true);
    }
  }

  async _fetchWithUI(button, fetchFunction) {
    if (!button) return;
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working...';

    try {
      await fetchFunction();
    } catch (error) {
      console.error(`Error during fetch operation for ${button.id}:`, error);
      const errorMessage = await this._parseError(error);
      this.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager)
        notificationManager.show(`Error: ${errorMessage}`, "danger");
    } finally {
      button.disabled = false;
      button.innerHTML = originalHtml;
    }
  }

  async _parseError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (error instanceof Response) {
      try {
        const errorData = await error.json();
        if (Array.isArray(errorData.detail)) {
          // FastAPI validation error
          return errorData.detail
            .map((err) => `${err.loc.join(".")} - ${err.msg}`)
            .join("; ");
        }
        return errorData.detail || JSON.stringify(errorData);
      } catch (e) {
        return error.statusText || "An unknown HTTP error occurred.";
      }
    }
    return "An unknown error occurred.";
  }

  async findAndDisplayRoute() {
    if (!this.selectedArea)
      return this.setStatus("Please select an area first.", true);
    if (this.isFetchingRoute || this.isFetchingCoverageRoute) return;

    this.isFetchingRoute = true;
    const originalHtml = this.findBtn.innerHTML;
    this.findBtn.disabled = true;
    this.findBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Finding Route...';

    this.setStatus("Calculating route to nearest undriven street...");
    this.routeLayer.clearLayers();
    this.clearTargetStreetHighlight();
    this.targetInfo.innerHTML = "";
    this.routeInfo.innerHTML = "";
    this.hideRouteDetails();
    this.currentCoverageRouteGeoJSON = null;
    if (this.exportCoverageRouteBtn)
      this.exportCoverageRouteBtn.disabled = true;

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

      if (!response.ok) throw response; // Throw the response object on HTTP error

      this.setActiveStep("optimizing");
      const data = await response.json();

      if (data.status === "completed") {
        this.hideProgressContainer();
        this.setStatus(data.message);
        if (notificationManager)
          notificationManager.show(data.message, "success");
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
        throw new Error(
          data.message || "Received unexpected success response.",
        );
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
    this.routeLayer.clearLayers();
    const routeLayer = L.geoJSON(data.route_geometry, {
      style: {
        color: "#76ff03",
        weight: 5,
        opacity: 0.8,
        className: "calculated-route",
      },
    }).addTo(this.routeLayer);

    this.highlightTargetStreet(data.target_street.segment_id);

    const streetName = data.target_street.street_name || "Unnamed Street";
    this.targetInfo.innerHTML = `
      <div class="alert alert-info p-2 mb-2">
        <i class="fas fa-map-pin me-2"></i>
        <strong>Target:</strong> ${streetName}
        <div class="mt-1 small text-light">Segment ID: ${data.target_street.segment_id}</div>
      </div>`;

    const durationMinutes = Math.round(data.route_duration_seconds / 60);
    const distanceMiles = (data.route_distance_meters * 0.000621371).toFixed(1);
    const locationSource = data.location_source || "unknown";

    this.routeInfo.innerHTML = `
      <div class="card bg-dark p-2 mt-2">
        <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Route Information</h6>
        <div class="route-info-detail">
          <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
          <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
          <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
        </div>
      </div>`;

    this.showRouteDetails({
      clusters: 1,
      segments: 1,
      duration: data.route_duration_seconds,
      distance: data.route_distance_meters,
    });

    this.bringLiveElementsToFront();

    let boundsToFit;
    if (this.lastKnownLocation && data.target_street.start_coords) {
      const routeStart = [
        this.lastKnownLocation.lat,
        this.lastKnownLocation.lon,
      ];
      const targetStart = [
        data.target_street.start_coords[1],
        data.target_street.start_coords[0],
      ];
      boundsToFit = L.latLngBounds([routeStart, targetStart]);
      if (this.liveTracker?.marker?.getLatLng()) {
        boundsToFit.extend(this.liveTracker.marker.getLatLng());
      }
    } else if (routeLayer?.getBounds) {
      boundsToFit = routeLayer.getBounds();
    }

    if (boundsToFit?.isValid()) {
      this.map.fitBounds(boundsToFit, { padding: [70, 70] });
    }
  }

  highlightTargetStreet(segmentId) {
    this.clearTargetStreetHighlight();
    this.undrivenStreetsLayer.eachLayer((layer) => {
      if (layer.feature?.properties?.segment_id === segmentId) {
        this.targetStreetLayer = layer;
        layer.setStyle({
          color: "#ffab00",
          weight: 6,
          opacity: 1,
          dashArray: null,
          className: "target-street-segment",
        });

        if (!document.getElementById("pulsing-target-style")) {
          const style = document.createElement("style");
          style.id = "pulsing-target-style";
          style.innerHTML = `
            @keyframes pulse-target {
              0% { stroke-opacity: 1; } 50% { stroke-opacity: 0.6; } 100% { stroke-opacity: 1; }
            }
            .target-street-segment { animation: pulse-target 2s infinite; }`;
          document.head.appendChild(style);
        }
        layer.bringToFront();
      }
    });
  }

  clearTargetStreetHighlight() {
    if (this.targetStreetLayer) {
      this.targetStreetLayer.setStyle({
        color: "#00BFFF",
        weight: 3,
        opacity: 0.6,
        dashArray: "4, 4",
        className: "undriven-street-nav",
      });
      this.targetStreetLayer = null;
    }
  }

  bringLiveElementsToFront() {
    this.liveTracker?.polyline?.bringToFront();
    this.liveTracker?.marker?.bringToFront();
  }

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;
    const icon = isError
      ? '<i class="fas fa-exclamation-triangle text-warning me-2"></i>'
      : '<i class="fas fa-info-circle me-2"></i>';
    this.statusMsg.innerHTML = `${icon}${message}`;
    this.statusMsg.classList.toggle("text-danger", isError);
    this.statusMsg.classList.toggle("text-info", !isError);
    if (isError && notificationManager)
      notificationManager.show(message, "danger");
  }

  async calculateAndDisplayCoverageRoute() {
    if (!this.selectedArea)
      return this.setStatus("Please select an area first.", true);
    if (this.isFetchingRoute || this.isFetchingCoverageRoute) return;

    this.isFetchingCoverageRoute = true;
    const originalHtml = this.calcCoverageBtn.innerHTML;
    this.calcCoverageBtn.disabled = true;
    this.findBtn.disabled = true;
    this.findEfficientBtn.disabled = true;
    this.calcCoverageBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Calculating...';

    this.setStatus("Calculating full coverage route...");
    this.routeLayer.clearLayers();
    this.clearTargetStreetHighlight();
    this.targetInfo.innerHTML = "";
    this.routeInfo.innerHTML = "";
    this.hideRouteDetails();
    this.currentCoverageRouteGeoJSON = null;
    if (this.exportCoverageRouteBtn)
      this.exportCoverageRouteBtn.disabled = true;

    this.showProgressContainer();
    this.setActiveStep("clustering");

    try {
      const requestPayload = {
        location: this.selectedArea.location,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };

      this.updateProgress(20, "Clustering street segments...");
      const response = await fetch("/api/driving-navigation/coverage-route", {
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
        if (notificationManager) notificationManager.show(data.message, "info");
      } else if (data.status === "success" && data.route_geometry) {
        this.currentCoverageRouteGeoJSON = data.route_geometry;
        if (this.exportCoverageRouteBtn)
          this.exportCoverageRouteBtn.disabled = false;
        this.setActiveStep("rendering");

        const fullRouteLayer = L.layerGroup().addTo(this.routeLayer);
        const routeBounds = L.latLngBounds();
        const connectingRouteStyle = {
          color: "#76ff03",
          weight: 5,
          opacity: 0.8,
          className: "calculated-route",
        };

        const segmentCount = data.segments_in_route_count || 0;
        const clusterCount = data.clusters_count || 0;

        if (data.route_geometry.type === "GeometryCollection") {
          const geometries = data.route_geometry.geometries;
          let clusterIndex = 0;
          let isConnectingRoute = true;

          geometries.forEach((geom) => {
            let style;
            if (isConnectingRoute) {
              style = connectingRouteStyle;
            } else {
              style = {
                color:
                  this.clusterColors[clusterIndex % this.clusterColors.length],
                weight: 6,
                opacity: 0.9,
                className: `coverage-cluster-${clusterIndex}`,
              };
              clusterIndex++;
            }
            isConnectingRoute = !isConnectingRoute;

            const layer = L.geoJSON(geom, { style });
            fullRouteLayer.addLayer(layer);
            routeBounds.extend(layer.getBounds());
          });
        } else {
          const layer = L.geoJSON(data.route_geometry, {
            style: connectingRouteStyle,
          });
          fullRouteLayer.addLayer(layer);
          routeBounds.extend(layer.getBounds());
        }

        if (routeBounds.isValid())
          this.map.fitBounds(routeBounds, { padding: [50, 50] });

        const durationMinutes = Math.round(data.total_duration_seconds / 60);
        const durationHours = Math.floor(durationMinutes / 60);
        const remainingMinutes = durationMinutes % 60;
        const distanceMiles = (
          data.total_distance_meters * 0.000621371
        ).toFixed(1);

        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.hideProgressContainer(), 1000);

        this.setStatus(
          `Full coverage route calculated for ${segmentCount} segments across ${clusterCount} clusters.`,
        );
        const locationSource = data.location_source || "unknown";
        this.routeInfo.innerHTML = `
          <div class="card bg-dark p-2 mt-2">
            <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Coverage Route</h6>
            <div class="route-info-detail">
              <div><i class="fas fa-clock"></i> ${durationHours > 0 ? `${durationHours}h ` : ""}${remainingMinutes}min</div>
              <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
              <div><i class="fas fa-layer-group"></i> ${clusterCount} clusters</div>
              <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
            </div>
          </div>`;

        this.showRouteDetails({
          clusters: clusterCount,
          segments: segmentCount,
          duration: data.total_duration_seconds,
          distance: data.total_distance_meters,
        });
        this.bringLiveElementsToFront();
      } else {
        throw new Error(
          data.message ||
            "Received unexpected success response from coverage route.",
        );
      }
    } catch (error) {
      const errorMessage = await this._parseError(error);
      console.error(
        "Error calculating/displaying coverage route:",
        errorMessage,
      );
      this.hideProgressContainer();
      this.setStatus(`Error: ${errorMessage}`, true);
      if (notificationManager)
        notificationManager.show(
          `Coverage Routing Error: ${errorMessage}`,
          "danger",
        );
    } finally {
      this.calcCoverageBtn.disabled = false;
      this.calcCoverageBtn.innerHTML = originalHtml;
      this.findBtn.disabled = false;
      this.findEfficientBtn.disabled = false;
      this.isFetchingCoverageRoute = false;
    }
  }

  async handleExportCoverageRoute() {
    if (!this.currentCoverageRouteGeoJSON) {
      notificationManager.show(
        "No coverage route available to export.",
        "warning",
      );
      return;
    }
    if (!this.coverageRouteFormatSelect || !this.exportCoverageRouteBtn) return;

    const format = this.coverageRouteFormatSelect.value;
    const originalBtnText = this.exportCoverageRouteBtn.innerHTML;
    this.exportCoverageRouteBtn.disabled = true;
    this.exportCoverageRouteBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Exporting...`;

    try {
      const response = await fetch("/api/export/coverage-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route_geometry: this.currentCoverageRouteGeoJSON,
          format: format,
          location_name:
            this.selectedArea?.location?.display_name || "coverage_route",
        }),
      });

      if (!response.ok) throw response;

      const blob = await response.blob();
      const contentDisposition = response.headers.get("content-disposition");
      let filename = "coverage-route";
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
        if (filenameMatch && filenameMatch.length === 2)
          filename = filenameMatch[1];
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      notificationManager.show(
        "Coverage route exported successfully.",
        "success",
      );
    } catch (error) {
      const errorMessage = await this._parseError(error);
      console.error("Error exporting coverage route:", errorMessage);
      notificationManager.show(
        `Error exporting route: ${errorMessage}`,
        "danger",
      );
    } finally {
      this.exportCoverageRouteBtn.disabled = false;
      this.exportCoverageRouteBtn.innerHTML = originalBtnText;
    }
  }

  formatLocationSource(source) {
    const sourceMap = {
      "client-provided":
        '<span class="badge bg-info">current live position</span>',
      "live-tracking":
        '<span class="badge bg-info">current live position</span>',
      "last-trip-end":
        '<span class="badge bg-warning">last trip end position</span>',
      "last-trip-end-point":
        '<span class="badge bg-warning">last trip end position</span>',
    };
    return (
      sourceMap[source] || `<span class="badge bg-secondary">${source}</span>`
    );
  }

  showProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.add("active");
      this.resetSteps();
    }
  }

  hideProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.remove("active");
      this.progressBar.style.width = "0%";
      this.processingStatus.textContent = "Preparing...";
    }
  }

  updateProgress(percent, status) {
    if (this.progressBar && this.processingStatus) {
      this.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      if (status) this.processingStatus.textContent = status;
    }
  }

  resetSteps() {
    this.currentStep = null;
    if (this.stepClustering) this.stepClustering.className = "step";
    if (this.stepOptimizing) this.stepOptimizing.className = "step";
    if (this.stepRendering) this.stepRendering.className = "step";
  }

  setActiveStep(step) {
    this.resetSteps();
    this.currentStep = step;
    const steps = {
      clustering: {
        el: this.stepClustering,
        progress: 15,
        text: "Grouping street segments...",
      },
      optimizing: {
        el: this.stepOptimizing,
        progress: 45,
        text: "Optimizing routes...",
      },
      rendering: {
        el: this.stepRendering,
        progress: 85,
        text: "Rendering route on map...",
      },
    };

    if (steps[step]) {
      if (steps.clustering.el)
        steps.clustering.className =
          step === "clustering" ? "step active" : "step completed";
      if (steps.optimizing.el)
        steps.optimizing.className =
          step === "optimizing"
            ? "step active"
            : step === "rendering"
              ? "step completed"
              : "step";
      if (steps.rendering.el)
        steps.rendering.className =
          step === "rendering" ? "step active" : "step";
      this.updateProgress(steps[step].progress, steps[step].text);
    }
  }

  showRouteDetails(routeData) {
    if (!this.routeDetails || !routeData) return;
    this.routeDetails.style.display = "block";

    if (this.routeStats) {
      const durationHours = Math.floor(routeData.duration / 3600);
      const durationMinutes = Math.floor((routeData.duration % 3600) / 60);
      const distanceMiles = (routeData.distance * 0.000621371).toFixed(1);
      this.routeStats.innerHTML = `
        <div><strong>Clusters:</strong> ${routeData.clusters || 1}</div>
        <div><strong>Segments:</strong> ${routeData.segments || 1}</div>
        <div><strong>Time:</strong> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div>
        <div><strong>Distance:</strong> ${distanceMiles} mi</div>`;
    }

    if (this.routeLegend) {
      this.routeLegend.innerHTML = `
        <div class="legend-item"><span class="legend-color" style="background-color: #76ff03;"></span><span>Connecting Routes</span></div>
        <div class="legend-item"><span class="legend-color" style="background-color: #ffab00;"></span><span>Target Street</span></div>
        <div class="legend-item"><span class="legend-color" style="background-color: #0dcaf0;"></span><span>Current Position</span></div>`;

      if (routeData.clusters > 1) {
        for (
          let i = 0;
          i < Math.min(routeData.clusters, this.clusterColors.length);
          i++
        ) {
          this.routeLegend.innerHTML += `<div class="legend-item"><span class="legend-color" style="background-color: ${this.clusterColors[i]};"></span><span>Cluster ${i + 1}</span></div>`;
        }
      }
    }
  }

  hideRouteDetails() {
    if (this.routeDetails) this.routeDetails.style.display = "none";
  }

  createSegmentPopup(segment) {
    if (!segment?.properties) return null;
    const props = segment.properties;
    const streetName = props.street_name || "Unnamed Street";
    const segmentId = props.segment_id || "Unknown";
    const popupContent = `
      <div class="segment-popup">
        <h6>${streetName}</h6>
        <div class="small text-muted">Segment ID: ${segmentId}</div>
        <div class="mt-2">
          <button class="btn btn-sm btn-primary navigate-to-segment" data-segment-id="${segmentId}">
            <i class="fas fa-route me-1"></i> Navigate Here
          </button>
        </div>
      </div>`;
    return L.popup({
      className: "segment-info-popup",
      maxWidth: 200,
    }).setContent(popupContent);
  }

  setupMapInteractivity() {
    this.undrivenStreetsLayer.on("mouseover", (e) => {
      if (e.layer.feature && e.layer !== this.targetStreetLayer) {
        e.layer.setStyle({ weight: 4, color: "#4dabf7", opacity: 0.8 });
        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge)
          e.layer.bringToFront();
      }
    });

    this.undrivenStreetsLayer.on("mouseout", (e) => {
      if (e.layer.feature && e.layer !== this.targetStreetLayer) {
        this.undrivenStreetsLayer.resetStyle(e.layer);
      }
    });

    this.undrivenStreetsLayer.on("click", (e) => {
      if (e.originalEvent?.button !== 0) return;
      const popup = this.createSegmentPopup(e.layer.feature);
      if (popup) e.layer.bindPopup(popup).openPopup();
    });

    this.map.on("popupopen", (e) => {
      const popupNode = e.popup.getElement();
      const navigateBtn = popupNode.querySelector(".navigate-to-segment");
      if (navigateBtn) {
        navigateBtn.onclick = (evt) => {
          if (evt.button !== 0) return;
          const segmentId = navigateBtn.dataset.segmentId;
          this.map.closePopup();
          this.highlightTargetStreet(segmentId);
          this.findRouteToSegment(segmentId);
        };
      }
    });
  }

  async findRouteToSegment(segmentId) {
    if (!this.selectedArea || !segmentId) return;

    this.setStatus(`Calculating route to segment #${segmentId}...`);
    this.findBtn.disabled = true;
    this.calcCoverageBtn.disabled = true;
    this.findEfficientBtn.disabled = true;
    this.showProgressContainer();
    this.setActiveStep("optimizing");
    this.currentCoverageRouteGeoJSON = null;
    if (this.exportCoverageRouteBtn)
      this.exportCoverageRouteBtn.disabled = true;

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
        this.currentCoverageRouteGeoJSON = data.route_geometry;
        if (this.exportCoverageRouteBtn)
          this.exportCoverageRouteBtn.disabled = false;
        this.setActiveStep("rendering");
        this.displayRoute(data);
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.hideProgressContainer(), 1000);
      } else {
        throw new Error(data.message || "Could not calculate route to segment");
      }
    } catch (error) {
      const errorMessage = await this._parseError(error);
      console.error("Error finding route to segment:", errorMessage);
      this.setStatus(`Error: ${errorMessage}`, true);
      this.hideProgressContainer();
    } finally {
      this.findBtn.disabled = false;
      this.calcCoverageBtn.disabled = false;
      this.findEfficientBtn.disabled = false;
    }
  }

  async findEfficientStreetClusters() {
    if (!this.selectedArea?._id) {
      this.setStatus("Please select an area first.", true);
      return;
    }

    let currentLat, currentLon;
    if (this.lastKnownLocation) {
      currentLat = this.lastKnownLocation.lat;
      currentLon = this.lastKnownLocation.lon;
    } else {
      try {
        const position = await this.getCurrentPosition();
        currentLat = position.coords.latitude;
        currentLon = position.coords.longitude;
        this.lastKnownLocation = { lat: currentLat, lon: currentLon };
      } catch (error) {
        this.setStatus(
          "Unable to get current location. Please enable location services.",
          true,
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
      const url = `/api/driving-navigation/suggest-next-street/${this.selectedArea._id}?${params.toString()}`;

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
        const distanceMiles = (
          topCluster.distance_to_cluster_m / 1609.34
        ).toFixed(1);
        this.setStatus(
          `Found ${data.suggested_clusters.length} efficient clusters. Top cluster: ${topCluster.segment_count} streets, ${distanceMiles} mi away.`,
        );
        this.displayEfficientClustersInfo(data.suggested_clusters);

        setTimeout(() => {
          if (
            confirm(
              `Navigate to the top cluster with ${topCluster.segment_count} streets?`,
            )
          ) {
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
          "danger",
        );
    } finally {
      this.findEfficientBtn.disabled = false;
      this.findEfficientBtn.innerHTML = originalHtml;
    }
  }

  displayEfficientClusters(clusters) {
    this.clearEfficientClusters();
    const bounds = L.latLngBounds();
    const clusterColors = [
      "#ff6b6b",
      "#4ecdc4",
      "#45b7d1",
      "#f9ca24",
      "#6c5ce7",
    ];

    clusters.forEach((cluster, index) => {
      const color = clusterColors[index % clusterColors.length];
      cluster.segments.forEach((segment) => {
        if (segment.geometry?.type === "LineString") {
          const segmentLayer = L.geoJSON(segment.geometry, {
            style: {
              color,
              weight: 5,
              opacity: 0.7,
              className: `efficient-cluster-${index}`,
            },
          }).addTo(this.efficientClustersLayer);
          this.clusterHighlights.push(segmentLayer);
          bounds.extend(segmentLayer.getBounds());
        }
      });

      const icon = L.divIcon({
        className: "efficient-cluster-marker",
        html: `<div class="cluster-marker-wrapper"><div class="cluster-marker-inner" style="background-color: ${color};"><div class="cluster-number">${index + 1}</div><div class="cluster-count">${cluster.segment_count}</div></div></div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      });
      const marker = L.marker([cluster.centroid[1], cluster.centroid[0]], {
        icon,
      })
        .bindPopup(this.createClusterPopup(cluster, index))
        .addTo(this.efficientClustersLayer);
      this.clusterMarkers.push(marker);
    });

    if (this.lastKnownLocation)
      bounds.extend([this.lastKnownLocation.lat, this.lastKnownLocation.lon]);
    if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [50, 50] });
  }

  createClusterPopup(cluster, rank) {
    const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(1);
    const lengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
    const score = cluster.efficiency_score.toFixed(2);
    return `
      <div class="efficient-cluster-popup">
        <h6>Cluster #${rank + 1}</h6>
        <div class="cluster-stats small">
          <div><i class="fas fa-road"></i> ${cluster.segment_count} streets</div>
          <div><i class="fas fa-ruler"></i> ${lengthMiles} mi total</div>
          <div><i class="fas fa-location-arrow"></i> ${distanceMiles} mi away</div>
          <div><i class="fas fa-chart-line"></i> Score: ${score}</div>
        </div>
        <button class="btn btn-sm btn-primary mt-2 navigate-to-cluster" data-segment-id="${cluster.nearest_segment.segment_id}">
          <i class="fas fa-route me-1"></i> Navigate to Cluster
        </button>
      </div>`;
  }

  displayEfficientClustersInfo(clusters) {
    if (!this.targetInfo) return;
    const colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#f9ca24", "#6c5ce7"];
    let html = `
      <div class="efficient-clusters-panel card bg-dark p-2 mt-2">
        <h6><i class="fas fa-layer-group me-2"></i>Efficient Clusters Found</h6>
        <div class="efficient-clusters-list">`;

    clusters.forEach((cluster, index) => {
      const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(
        1,
      );
      const lengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
      const color = colors[index % colors.length];
      html += `
        <div class="efficient-cluster-item" style="border-left: 4px solid ${color};">
          <div class="d-flex justify-content-between align-items-start">
            <div class="flex-grow-1">
              <div class="cluster-header"><span class="cluster-rank">#${index + 1}</span><span class="cluster-size">${cluster.segment_count} streets</span></div>
              <div class="cluster-name">${cluster.nearest_segment.street_name} area</div>
              <div class="cluster-metrics"><span><i class="fas fa-ruler"></i> ${lengthMiles} mi</span><span><i class="fas fa-location-arrow"></i> ${distanceMiles} mi</span></div>
            </div>
            <button class="btn btn-sm btn-outline-primary navigate-cluster-btn" data-segment-id="${cluster.nearest_segment.segment_id}" title="Navigate"><i class="fas fa-route"></i></button>
          </div>
        </div>`;
    });
    html += `</div></div>`;
    this.targetInfo.innerHTML = html;

    document
      .querySelectorAll(".navigate-cluster-btn, .navigate-to-cluster")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const segmentId = btn.dataset.segmentId;
          this.highlightTargetStreet(segmentId);
          this.findRouteToSegment(segmentId);
        });
      });
  }

  clearEfficientClusters() {
    this.efficientClustersLayer.clearLayers();
    this.clusterMarkers = [];
    this.clusterHighlights = [];
    this.suggestedClusters = [];
  }

  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported by your browser"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof L === "undefined") {
    console.error(
      "Leaflet library not found. Driving Navigation cannot initialize.",
    );
    const mapDiv = document.getElementById("driving-map");
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
    .efficient-clusters-panel { background: rgba(40, 40, 40, 0.9); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    .efficient-cluster-item { background: rgba(60, 60, 60, 0.8); border-radius: 4px; padding: 10px; margin-bottom: 10px; transition: background 0.2s; }
    .efficient-cluster-item:hover { background: rgba(80, 80, 80, 0.9); }
    .cluster-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .cluster-rank { font-weight: bold; font-size: 1.1em; color: #ffd700; }
    .cluster-size { background: rgba(100, 100, 100, 0.8); padding: 2px 8px; border-radius: 12px; font-size: 0.85em; }
    .cluster-name { font-weight: 600; margin-bottom: 4px; }
    .cluster-metrics { font-size: 0.85em; color: #adb5bd; display: flex; flex-wrap: wrap; gap: 12px; }
    .efficient-cluster-popup { min-width: 250px; }
  `;
  document.head.appendChild(styleClusters);
});
