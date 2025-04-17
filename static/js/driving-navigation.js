/* global L, notificatonManager, DateUtils, Chart */


"use strict";

class DrivingNavigation {
  constructor() {
    this.map = null;
    this.areaSelect = document.getElementById("area-select");
    this.findBtn = document.getElementById("find-next-street-btn");
    this.calcCoverageBtn = document.getElementById(
      "calculate-coverage-route-btn",
    );
    this.statusMsg = document.getElementById("status-message");
    this.targetInfo = document.getElementById("target-info");
    this.routeInfo = document.getElementById("route-info");
    this.autoFollowToggle = document.getElementById("auto-follow-toggle");

    // New UI elements
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
    this.selectedLocation = null;
    this.undrivenStreetsLayer = L.layerGroup();
    this.routeLayer = L.layerGroup();
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

    this.initialize();
  }

  async initialize() {
    this.setupEventListeners();
    this.initMap();
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

      this.map = L.map("driving-map").setView([37.8, -96], 4);

      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: "",
          maxZoom: 19,
        },
      ).addTo(this.map);

      this.undrivenStreetsLayer.addTo(this.map);
      this.routeLayer.addTo(this.map);

      this.setStatus("Map initialized. Select an area.");

      setTimeout(() => {
        if (this.map) {
          console.log("Invalidating map size...");
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

    console.log("Live tracking initialized for navigation.");
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

    const sortedCoords = [...trip.coordinates];
    sortedCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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

        if (speed === 0) {
          markerClass += " vehicle-stopped";
        } else if (speed < 10) {
          markerClass += " vehicle-slow";
        } else if (speed < 35) {
          markerClass += " vehicle-medium";
        } else {
          markerClass += " vehicle-fast";
        }

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

    if (trip.currentSpeed !== undefined) {
      const speedMph = Math.round(trip.currentSpeed);
      this.setStatus(`Live tracking active. Current speed: ${speedMph} mph`);
    } else {
      this.setStatus("Live tracking active.");
    }

    if (
      this.findBtn?.disabled &&
      this.findBtn.dataset.disabledReason === "no-location" &&
      this.selectedLocation
    ) {
      this.findBtn.disabled = false;
      delete this.findBtn.dataset.disabledReason;
    }
  }

  handleLiveTripClear() {
    if (this.clearTripTimeout) {
      return;
    }

    const CLEAR_DELAY_MS = 7000;

    this.clearTripTimeout = setTimeout(() => {
      console.log("Executing debounced live trip clear.");
      this.lastKnownLocation = null;

      if (this.liveTracker?.marker) {
        this.liveTracker.marker.setOpacity(0);
      }

      if (this.liveTracker?.polyline) {
        this.liveTracker.polyline.setLatLngs([]);
      }

      this.clearTripTimeout = null;
    }, CLEAR_DELAY_MS);
  }

  setupEventListeners() {
    if (this.areaSelect) {
      this.areaSelect.addEventListener("change", () => this.handleAreaChange());
    }
    if (this.findBtn) {
      this.findBtn.addEventListener("click", () => this.findAndDisplayRoute());
    }
    if (this.calcCoverageBtn) {
      this.calcCoverageBtn.addEventListener("click", () =>
        this.calculateAndDisplayCoverageRoute(),
      );
    }
    if (this.autoFollowToggle) {
      this.autoFollowToggle.addEventListener("change", (e) => {
        this.saveAutoFollowState(e.target.checked);
        if (e.target.checked && this.lastKnownLocation) {
          this.map?.panTo([
            this.lastKnownLocation.lat,
            this.lastKnownLocation.lon,
          ]);
        }
      });
    }

    if (this.map) {
      this.map.on("layeradd", () => {
        setTimeout(() => this.bringLiveElementsToFront(), 50);
      });

      this.map.on("zoomend", () => this.bringLiveElementsToFront());

      this.map.on("moveend", () => this.bringLiveElementsToFront());
    }

    document.addEventListener("mapUpdated", () =>
      this.bringLiveElementsToFront(),
    );
  }

  loadAutoFollowState() {
    if (!this.autoFollowToggle) return;
    const savedState = localStorage.getItem("drivingNavAutoFollow") === "true";
    this.autoFollowToggle.checked = savedState;
  }

  saveAutoFollowState(isEnabled) {
    localStorage.setItem("drivingNavAutoFollow", isEnabled);
  }

  getAutoFollowState() {
    return this.autoFollowToggle ? this.autoFollowToggle.checked : false;
  }

  async loadCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");
      if (!response.ok) throw new Error("Failed to fetch areas");
      const data = await response.json();

      if (data.success && data.areas) {
        this.coverageAreas = data.areas;
        this.populateAreaDropdown();
      } else {
        throw new Error(data.error || "Invalid response format");
      }
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.setStatus("Error loading areas.", true);
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
        option.value = JSON.stringify(area.location);
        option.textContent = area.location.display_name;
        this.areaSelect.appendChild(option);
      }
    });
  }

  async handleAreaChange() {
    const selectedValue = this.areaSelect.value;
    if (!selectedValue) {
      this.selectedLocation = null;
      this.findBtn.disabled = true;
      this.calcCoverageBtn.disabled = true;
      this.undrivenStreetsLayer.clearLayers();
      this.routeLayer.clearLayers();
      this.clearTargetStreetHighlight();
      this.setStatus("Select an area.");
      return;
    }

    try {
      this.selectedLocation = JSON.parse(selectedValue);
      this.setStatus(
        `Area selected: ${this.selectedLocation.display_name}. Loading streets...`,
      );
      this.findBtn.disabled = false;
      this.calcCoverageBtn.disabled = false;

      this.undrivenStreetsLayer.clearLayers();
      this.routeLayer.clearLayers();
      this.clearTargetStreetHighlight();
      this.targetInfo.innerHTML = "";
      this.routeInfo.innerHTML = "";

      await this.fetchAndDisplayUndrivenStreets();
    } catch (error) {
      console.error("Error parsing selected location:", error);
      this.selectedLocation = null;
      this.findBtn.disabled = true;
      this.calcCoverageBtn.disabled = true;
      this.setStatus("Invalid area selected.", true);
    }
  }

  async fetchAndDisplayUndrivenStreets() {
    if (!this.selectedLocation) return;

    this.setStatus(
      `Fetching undriven streets for ${this.selectedLocation.display_name}...`,
    );
    this.undrivenStreetsLayer.clearLayers();
    this.hideRouteDetails();

    try {
      // Show progress for street loading
      this.showProgressContainer();
      this.updateProgress(20, "Fetching undriven streets from database...");

      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.selectedLocation),
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
        if (bounds.isValid()) {
          this.map.fitBounds(bounds, { padding: [50, 50] });
        }

        // Complete progress
        this.updateProgress(100, "Loaded undriven streets!");
        setTimeout(() => this.hideProgressContainer(), 1000);

        this.setStatus(
          `Loaded ${geojson.features.length} undriven streets in ${this.selectedLocation.display_name}.`,
        );
      } else {
        this.hideProgressContainer();
        this.setStatus(
          `No undriven streets found in ${this.selectedLocation.display_name}.`,
        );
        if (this.selectedLocation.boundingbox) {
          this.findBtn.disabled = false;
          this.calcCoverageBtn.disabled = false;
          if (!this.lastKnownLocation) {
            const reason = "no-location";
            if (this.findBtn) this.findBtn.dataset.disabledReason = reason;
            if (this.calcCoverageBtn)
              this.calcCoverageBtn.dataset.disabledReason = reason;
          }

          try {
            const bbox = this.selectedLocation.boundingbox.map(parseFloat);
            const bounds = L.latLngBounds([
              [bbox[0], bbox[2]],
              [bbox[1], bbox[3]],
            ]);
            if (bounds.isValid()) {
              this.map.fitBounds(bounds, { padding: [50, 50] });
            }
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

  async findAndDisplayRoute() {
    if (!this.selectedLocation) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (this.isFetchingRoute || this.isFetchingCoverageRoute) {
      console.log("Route fetch already in progress.");
      return;
    }

    this.isFetchingRoute = true;
    this.findBtn.disabled = true;
    this.findBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin me-2"></i>Finding Route...';
    this.setStatus("Calculating route to nearest undriven street...");
    this.routeLayer.clearLayers();
    this.clearTargetStreetHighlight();
    this.targetInfo.innerHTML = "";
    this.routeInfo.innerHTML = "";
    this.hideRouteDetails();

    // Show progress container and set initial state
    this.showProgressContainer();
    this.setActiveStep("clustering");

    try {
      const requestPayload = {
        location: this.selectedLocation,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };

      console.log("Sending route request with payload:", requestPayload);

      // Update progress to show request is being sent
      this.updateProgress(30, "Finding the nearest undriven street...");

      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      // Update progress to show we're processing the response
      this.setActiveStep("optimizing");

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || `HTTP error ${response.status}`);
      }

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
        // Update progress to show we're rendering the route
        this.setActiveStep("rendering");

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
          </div>
        `;

        const locationSource = data.location_source || "unknown";
        console.log(`Route calculated using '${locationSource}' location data`);

        this.setStatus(`Route calculated. Head towards ${streetName}.`);

        const durationMinutes = Math.round(data.route_duration_seconds / 60);
        const distanceMiles = (
          data.route_distance_meters * 0.000621371
        ).toFixed(1);

        this.routeInfo.innerHTML = `
          <div class="card bg-dark p-2 mt-2">
            <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Route Information</h6>
            <div class="route-info-detail">
              <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
              <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
              <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
            </div>
          </div>
        `;

        // Show route details with simplified information
        this.showRouteDetails({
          clusters: 1,
          segments: 1,
          duration: data.route_duration_seconds,
          distance: data.route_distance_meters,
        });

        this.bringLiveElementsToFront();

        // Complete progress
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => {
          this.hideProgressContainer();
        }, 1000);

        try {
          let boundsToFit;
          if (this.lastKnownLocation) {
            const routeStart = [
              this.lastKnownLocation.lat,
              this.lastKnownLocation.lon,
            ];
            const targetStart = [
              data.target_street.start_coords[1],
              data.target_street.start_coords[0],
            ];
            boundsToFit = L.latLngBounds([routeStart, targetStart]);

            if (
              this.liveTracker?.marker &&
              this.liveTracker.marker.getLatLng()
            ) {
              boundsToFit.extend(this.liveTracker.marker.getLatLng());
            }
          } else if (routeLayer && typeof routeLayer.getBounds === "function") {
            boundsToFit = routeLayer.getBounds();
          }

          if (boundsToFit?.isValid()) {
            this.map.fitBounds(boundsToFit, { padding: [70, 70] });
          } else {
            console.warn("Could not determine valid bounds to fit the map.");
            if (data.target_street?.start_coords) {
              this.map.setView(
                [
                  data.target_street.start_coords[1],
                  data.target_street.start_coords[0],
                ],
                16,
              );
            }
          }
        } catch (boundsError) {
          console.error(
            "Error calculating or fitting map bounds:",
            boundsError,
          );
        }
      } else {
        throw new Error(
          data.message || "Received unexpected success response.",
        );
      }
    } catch (error) {
      console.error("Error finding/displaying route:", error);
      this.hideProgressContainer();
      this.setStatus(`Error: ${error.message}`, true);
      if (notificationManager)
        notificationManager.show(`Routing Error: ${error.message}`, "danger");
    } finally {
      this.findBtn.disabled = false;
      this.findBtn.innerHTML =
        '<i class="fas fa-route me-2"></i>Find Nearest Undriven Street';
      this.isFetchingRoute = false;
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

        // Add a pulsing effect to make the target street more noticeable
        if (!document.getElementById("pulsing-target-style")) {
          const style = document.createElement("style");
          style.id = "pulsing-target-style";
          style.innerHTML = `
            @keyframes pulse-target {
              0% { stroke-opacity: 1; }
              50% { stroke-opacity: 0.6; }
              100% { stroke-opacity: 1; }
            }
            .target-street-segment {
              animation: pulse-target 2s infinite;
            }
          `;
          document.head.appendChild(style);
        }

        // If the map view doesn't include the target street, pan to it
        const bounds = layer.getBounds();
        if (bounds && !this.map.getBounds().contains(bounds)) {
          this.map.panTo(bounds.getCenter());
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
    if (this.liveTracker?.polyline) {
      this.liveTracker.polyline.bringToFront();
    }
  }

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;

    // Format the message with more visual cues
    const icon = isError
      ? '<i class="fas fa-exclamation-triangle text-warning me-2"></i>'
      : '<i class="fas fa-info-circle me-2"></i>';

    this.statusMsg.innerHTML = `${icon}${message}`;
    this.statusMsg.classList.toggle("text-danger", isError);
    this.statusMsg.classList.toggle("text-info", !isError);

    // Also show a notification for important status changes
    if (isError && notificationManager) {
      notificationManager.show(message, "danger");
    }
  }

  async calculateAndDisplayCoverageRoute() {
    if (!this.selectedLocation) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (this.isFetchingRoute || this.isFetchingCoverageRoute) {
      console.log("Another route fetch is already in progress.");
      return;
    }

    this.isFetchingCoverageRoute = true;
    this.calcCoverageBtn.disabled = true;
    this.calcCoverageBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin me-2"></i>Calculating Coverage...';
    this.findBtn.disabled = true;
    this.setStatus("Calculating full coverage route...");
    this.routeLayer.clearLayers();
    this.clearTargetStreetHighlight();
    this.targetInfo.innerHTML = "";
    this.routeInfo.innerHTML = "";
    this.hideRouteDetails();

    // Show progress container and set initial state
    this.showProgressContainer();
    this.setActiveStep("clustering");

    try {
      const requestPayload = {
        location: this.selectedLocation,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };

      console.log(
        "Sending coverage route request with payload:",
        requestPayload,
      );

      // Update progress to show we're grouping segments
      this.updateProgress(20, "Clustering street segments...");

      const response = await fetch("/api/driving-navigation/coverage-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      // Update progress to show we're optimizing routes
      this.setActiveStep("optimizing");

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || `HTTP error ${response.status}`);
      }

      if (data.status === "completed") {
        this.hideProgressContainer();
        this.setStatus(data.message);
        if (notificationManager) notificationManager.show(data.message, "info");
      } else if (data.status === "success" && data.route_geometry) {
        // Update progress to show we're rendering the route
        this.setActiveStep("rendering");

        const fullRouteLayer = L.layerGroup().addTo(this.routeLayer);
        let routeBounds = L.latLngBounds();

        const connectingRouteStyle = {
          color: "#76ff03",
          weight: 5,
          opacity: 0.8,
          className: "calculated-route",
        };

        // The message contains the info about clusters and segments
        const clusterInfo = data.message.match(
          /(\d+) segments across (\d+) clusters/,
        );
        const segmentCount = clusterInfo ? parseInt(clusterInfo[1]) : 0;
        const clusterCount = clusterInfo ? parseInt(clusterInfo[2]) : 0;

        if (data.route_geometry.type === "GeometryCollection") {
          // Create a more visually appealing representation of clusters
          const geometries = data.route_geometry.geometries;
          let clusterIndex = 0;
          let isConnectingRoute = true;

          geometries.forEach((geom, index) => {
            let style = {};

            if (isConnectingRoute) {
              // This is a connecting route
              style = connectingRouteStyle;
              isConnectingRoute = false;
            } else {
              // This is a cluster or segment within a cluster
              // Use a different color for each cluster to make them visually distinguishable
              style = {
                color:
                  this.clusterColors[clusterIndex % this.clusterColors.length],
                weight: 6,
                opacity: 0.9,
                className: `coverage-cluster-${clusterIndex}`,
              };
              clusterIndex++;
              isConnectingRoute = true;
            }

            const layer = L.geoJSON(geom, { style });
            fullRouteLayer.addLayer(layer);
            routeBounds.extend(layer.getBounds());

            // Add a marker at the start of each cluster to show the sequence
            if (
              !isConnectingRoute &&
              geom.coordinates &&
              geom.coordinates.length > 0
            ) {
              const startCoord = geom.coordinates[0];
              const clusterMarker = L.marker([startCoord[1], startCoord[0]], {
                icon: L.divIcon({
                  className: "cluster-marker",
                  html: `<div style="background-color:${style.color};color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;">${clusterIndex}</div>`,
                  iconSize: [24, 24],
                  iconAnchor: [12, 12],
                }),
              });
              fullRouteLayer.addLayer(clusterMarker);
            }
          });
        } else {
          console.warn(
            "Received unexpected geometry type for coverage route:",
            data.route_geometry.type,
          );
          const layer = L.geoJSON(data.route_geometry, {
            style: connectingRouteStyle,
          });
          fullRouteLayer.addLayer(layer);
          routeBounds.extend(layer.getBounds());
        }

        if (routeBounds.isValid()) {
          this.map.fitBounds(routeBounds, { padding: [50, 50] });
        }

        const durationMinutes = Math.round(data.total_duration_seconds / 60);
        const durationHours = Math.floor(durationMinutes / 60);
        const remainingMinutes = durationMinutes % 60;
        const distanceMiles = (
          data.total_distance_meters * 0.000621371
        ).toFixed(1);

        // Complete progress
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => {
          this.hideProgressContainer();
        }, 1000);

        this.setStatus(
          `Full coverage route calculated for ${segmentCount} segments across ${clusterCount} clusters.`,
        );

        const locationSource = data.location_source || "unknown";
        this.routeInfo.innerHTML = `
          <div class="card bg-dark p-2 mt-2">
            <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Coverage Route</h6>
            <div class="route-info-detail">
              <div><i class="fas fa-clock"></i> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div>
              <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
              <div><i class="fas fa-layer-group"></i> ${clusterCount} clusters</div>
              <div class="w-100 text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
            </div>
          </div>
        `;

        // Add detailed route information
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
      console.error("Error calculating/displaying coverage route:", error);
      this.hideProgressContainer();
      this.setStatus(`Error: ${error.message}`, true);
      if (notificationManager)
        notificationManager.show(
          `Coverage Routing Error: ${error.message}`,
          "danger",
        );
    } finally {
      this.calcCoverageBtn.disabled = false;
      this.calcCoverageBtn.innerHTML =
        '<i class="fas fa-road me-2"></i>Calculate Full Coverage Route';
      this.findBtn.disabled = false;
      this.isFetchingCoverageRoute = false;
    }
  }

  formatLocationSource(source) {
    switch (source) {
      case "client-provided":
        return '<span class="badge bg-info">current live position</span>';
      case "live-tracking":
        return '<span class="badge bg-info">current live position</span>';
      case "last-trip-end":
        return '<span class="badge bg-warning">last trip end position</span>';
      default:
        return `<span class="badge bg-secondary">${source}</span>`;
    }
  }

  // New methods for progress feedback
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
      if (status) {
        this.processingStatus.textContent = status;
      }
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

    if (step === "clustering") {
      if (this.stepClustering) this.stepClustering.className = "step active";
      this.updateProgress(15, "Grouping street segments into clusters...");
    } else if (step === "optimizing") {
      if (this.stepClustering) this.stepClustering.className = "step completed";
      if (this.stepOptimizing) this.stepOptimizing.className = "step active";
      this.updateProgress(45, "Optimizing routes between clusters...");
    } else if (step === "rendering") {
      if (this.stepClustering) this.stepClustering.className = "step completed";
      if (this.stepOptimizing) this.stepOptimizing.className = "step completed";
      if (this.stepRendering) this.stepRendering.className = "step active";
      this.updateProgress(85, "Rendering route on map...");
    }
  }

  showRouteDetails(routeData) {
    if (!this.routeDetails || !routeData) return;

    this.routeDetails.style.display = "block";

    // Generate route statistics
    if (this.routeStats) {
      const clusterCount = routeData.clusters || 1;
      const segmentCount = routeData.segments || 1;
      const durationHours = Math.floor(routeData.duration / 3600);
      const durationMinutes = Math.floor((routeData.duration % 3600) / 60);
      const distanceMiles = (routeData.distance * 0.000621371).toFixed(1);

      this.routeStats.innerHTML = `
        <div><strong>Clusters:</strong> ${clusterCount}</div>
        <div><strong>Street Segments:</strong> ${segmentCount}</div>
        <div><strong>Estimated Time:</strong> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div>
        <div><strong>Total Distance:</strong> ${distanceMiles} miles</div>
      `;
    }

    // Generate route legend
    if (this.routeLegend) {
      this.routeLegend.innerHTML = `
        <div class="legend-item">
          <span class="legend-color" style="background-color: #76ff03;"></span>
          <span>Connecting Routes</span>
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background-color: #ffab00;"></span>
          <span>Target Street</span>
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background-color: #0dcaf0;"></span>
          <span>Current Position</span>
        </div>
      `;

      // Add cluster colors to legend if there are multiple clusters
      if (routeData.clusters && routeData.clusters > 1) {
        for (
          let i = 0;
          i < Math.min(routeData.clusters, this.clusterColors.length);
          i++
        ) {
          const clusterItem = document.createElement("div");
          clusterItem.className = "legend-item";
          clusterItem.innerHTML = `
            <span class="legend-color" style="background-color: ${this.clusterColors[i]};"></span>
            <span>Cluster ${i + 1}</span>
          `;
          this.routeLegend.appendChild(clusterItem);
        }
      }
    }
  }

  hideRouteDetails() {
    if (this.routeDetails) {
      this.routeDetails.style.display = "none";
    }
  }

  // Add a method to create a popup with segment information
  createSegmentPopup(segment) {
    if (!segment || !segment.properties) return null;

    const props = segment.properties;
    const streetName = props.street_name || "Unnamed Street";
    const segmentId = props.segment_id || "Unknown";

    const popupContent = `
      <div class="segment-popup">
        <h6>${streetName}</h6>
        <div class="small text-muted">Segment ID: ${segmentId}</div>
        <div class="mt-2">
          <button class="btn btn-sm btn-primary navigate-to-segment" 
            data-segment-id="${segmentId}">
            <i class="fas fa-route me-1"></i> Navigate Here
          </button>
        </div>
      </div>
    `;

    const popup = L.popup({
      className: "segment-info-popup",
      maxWidth: 200,
    }).setContent(popupContent);

    return popup;
  }

  // Add method to make the map more interactive
  setupMapInteractivity() {
    // Add hover effect for undriven streets
    this.undrivenStreetsLayer.on("mouseover", (e) => {
      const layer = e.layer;
      if (!layer.feature || layer === this.targetStreetLayer) return;

      layer.setStyle({
        weight: 4,
        color: "#4dabf7",
        opacity: 0.8,
      });

      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        layer.bringToFront();
      }
    });

    this.undrivenStreetsLayer.on("mouseout", (e) => {
      const layer = e.layer;
      if (!layer.feature || layer === this.targetStreetLayer) return;

      this.undrivenStreetsLayer.resetStyle(layer);
    });

    // Add click handler for undriven streets to show info and navigation option
    this.undrivenStreetsLayer.on("click", (e) => {
      const segment = e.layer.feature;
      const popup = this.createSegmentPopup(segment);
      if (popup) {
        e.layer.bindPopup(popup).openPopup();

        // Add event listener to the navigate button after popup is open
        setTimeout(() => {
          const navigateBtn = document.querySelector(".navigate-to-segment");
          if (navigateBtn) {
            navigateBtn.addEventListener("click", () => {
              const segmentId = navigateBtn.getAttribute("data-segment-id");
              this.highlightTargetStreet(segmentId);
              e.layer.closePopup();

              // Generate a route to this specific segment
              this.findRouteToSegment(segmentId);
            });
          }
        }, 100);
      }
    });
  }

  // Method to find a route to a specific segment
  async findRouteToSegment(segmentId) {
    if (!this.selectedLocation || !segmentId) return;

    this.setStatus(`Calculating route to segment #${segmentId}...`);
    this.findBtn.disabled = true;
    this.calcCoverageBtn.disabled = true;
    this.showProgressContainer();
    this.setActiveStep("optimizing");

    try {
      // We'll use the same endpoint but pass the specific segment ID
      const requestPayload = {
        location: this.selectedLocation,
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

      const data = await response.json();

      // Process response similar to findAndDisplayRoute method
      if (data.status === "success" && data.route_geometry) {
        this.setActiveStep("rendering");

        // Clear previous route and display new one
        this.routeLayer.clearLayers();

        const routeLayer = L.geoJSON(data.route_geometry, {
          style: {
            color: "#76ff03",
            weight: 5,
            opacity: 0.8,
            className: "calculated-route",
          },
        }).addTo(this.routeLayer);

        // Update UI with route info
        const streetName = data.target_street.street_name || "Selected Street";
        this.setStatus(`Route calculated to ${streetName}.`);

        const durationMinutes = Math.round(data.route_duration_seconds / 60);
        const distanceMiles = (
          data.route_distance_meters * 0.000621371
        ).toFixed(1);

        this.routeInfo.innerHTML = `
          <div class="card bg-dark p-2 mt-2">
            <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Route Information</h6>
            <div class="route-info-detail">
              <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
              <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
              <div class="w-100 text-muted small">(Using ${this.formatLocationSource(data.location_source || "unknown")} position)</div>
            </div>
          </div>
        `;

        // Zoom to show the route
        const bounds = routeLayer.getBounds();
        if (bounds?.isValid()) {
          this.map.fitBounds(bounds, { padding: [70, 70] });
        }

        // Complete progress
        this.updateProgress(100, "Route calculation complete!");
        setTimeout(() => this.hideProgressContainer(), 1000);
      } else {
        throw new Error(data.message || "Could not calculate route to segment");
      }
    } catch (error) {
      console.error("Error finding route to segment:", error);
      this.setStatus(`Error: ${error.message}`, true);
    } finally {
      this.findBtn.disabled = false;
      this.calcCoverageBtn.disabled = false;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof L === "undefined") {
    console.error(
      "Leaflet library not found. Driving Navigation cannot initialize.",
    );
    const mapDiv = document.getElementById("driving-map");
    if (mapDiv) {
      mapDiv.innerHTML =
        '<div class="alert alert-danger m-3">Error: Mapping library failed to load. Cannot display map.</div>';
    }
    const statusMsg = document.getElementById("status-message");
    if (statusMsg) {
      statusMsg.textContent = "Map library failed to load.";
      statusMsg.classList.add("text-danger");
    }
    return;
  }
  window.drivingNav = new DrivingNavigation();
});
