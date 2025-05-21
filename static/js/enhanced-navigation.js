/* global L, NavigationService */

"use strict";

class EnhancedNavigation {
  constructor() {
    // Core elements
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
    this.centerPositionBtn = document.getElementById("center-position-btn");

    // Navigation panel elements
    this.navigationPanel = document.getElementById("navigation-panel");
    this.directionInstruction = document.getElementById(
      "direction-instruction",
    );
    this.directionDistance = document.getElementById("direction-distance");
    this.navProgressBar = document.getElementById("nav-progress-bar");
    this.stopNavigationBtn = document.getElementById("stop-navigation-btn");
    this.recalculateBtn = document.getElementById("recalculate-btn");
    this.maneuverIcon = document.getElementById("maneuver-icon");

    // Options
    this.avoidHighwaysToggle = document.getElementById("avoid-highways-toggle");
    this.prioritizeConnectivityToggle = document.getElementById(
      "prioritize-connectivity-toggle",
    );

    // Progress elements
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

    // Overlay
    this.reconnectingOverlay = document.getElementById("reconnecting-overlay");

    // State variables
    this.coverageAreas = [];
    this.selectedLocation = null;
    this.isFetchingRoute = false;
    this.isFetchingCoverageRoute = false;
    this.isNavigating = false;
    this.currentStep = null;

    // Leaflet layers
    this.undrivenStreetsLayer = L.layerGroup();
    this.routeLayer = L.layerGroup();
    this.userLocationLayer = L.layerGroup();
    this.targetStreetLayer = L.layerGroup();

    // High accuracy positioning
    this.accuracyCircle = null;
    this.positionMarker = null;
    this.headingIndicator = null;

    // Navigation service
    this.navigationService = new NavigationService();
    this.setupNavigationService();

    // Initialize the UI
    this.initialize();
  }

  setupNavigationService() {
    this.navigationService.onPositionUpdate = (position) => {
      this.handlePositionUpdate(position);
    };

    this.navigationService.onNavigationUpdate = (update) => {
      this.handleNavigationUpdate(update);
    };

    this.navigationService.onRouteRecalculation = (route) => {
      this.handleRouteRecalculation(route);
    };

    this.navigationService.onNavigationError = (error) => {
      this.handleNavigationError(error);
    };

    this.navigationService.onDirectionChange = (direction) => {
      this.handleDirectionChange(direction);
    };
  }

  async initialize() {
    this.setupEventListeners();
    this.initMap();
    await this.loadCoverageAreas();
    this.startLocationTracking();
  }

  startLocationTracking() {
    const success = this.navigationService.startTracking();
    if (success) {
      this.setStatus("Obtaining your location...");
    } else {
      this.setStatus(
        "Unable to access your location. Navigation features may be limited.",
        true,
      );
    }
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

      // Create Leaflet map
      this.map = L.map("driving-map", {
        center: [37.8, -96],
        zoom: 4,
        zoomControl: true,
      });

      // Add dark base layer
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: "",
          maxZoom: 19,
        },
      ).addTo(this.map);

      // Add our layers
      this.undrivenStreetsLayer.addTo(this.map);
      this.routeLayer.addTo(this.map);
      this.targetStreetLayer.addTo(this.map);
      this.userLocationLayer.addTo(this.map);

      this.setStatus("Map initialized. Select an area to begin navigation.");

      // Invalidate map size after a short delay to ensure proper rendering
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

  setupEventListeners() {
    // Area selection
    if (this.areaSelect) {
      this.areaSelect.addEventListener("change", () => this.handleAreaChange());
    }

    // Find nearest undriven street
    if (this.findBtn) {
      this.findBtn.addEventListener("click", () => this.findAndDisplayRoute());
    }

    // Calculate coverage route
    if (this.calcCoverageBtn) {
      this.calcCoverageBtn.addEventListener("click", () =>
        this.calculateCoverageRoute(),
      );
    }

    // Center position button
    if (this.centerPositionBtn) {
      this.centerPositionBtn.addEventListener("click", () =>
        this.centerOnUserLocation(),
      );
    }

    // Stop navigation button
    if (this.stopNavigationBtn) {
      this.stopNavigationBtn.addEventListener("click", () =>
        this.stopNavigation(),
      );
    }

    // Recalculate button
    if (this.recalculateBtn) {
      this.recalculateBtn.addEventListener("click", () =>
        this.recalculateRoute(),
      );
    }

    // Auto-follow toggle
    if (this.autoFollowToggle) {
      this.autoFollowToggle.addEventListener("change", (e) => {
        const enabled = e.target.checked;
        localStorage.setItem("navigation_auto_follow", JSON.stringify(enabled));

        if (enabled && this.navigationService.currentPosition) {
          this.centerOnUserLocation();
        }
      });

      // Load saved setting
      const savedAutoFollow = localStorage.getItem("navigation_auto_follow");
      if (savedAutoFollow !== null) {
        this.autoFollowToggle.checked = JSON.parse(savedAutoFollow);
      }
    }
  }

  async loadCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "API returned failure");
      }

      this.coverageAreas = data.areas;
      this.populateAreaDropdown();

      return data.areas;
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.setStatus("Error loading coverage areas.", true);
      // Update the dropdown to show error
      if (this.areaSelect) {
        this.areaSelect.innerHTML =
          '<option value="">Error loading areas</option>';
      }
      return [];
    }
  }

  populateAreaDropdown() {
    if (!this.areaSelect || !this.coverageAreas.length) return;

    // Clear existing options
    this.areaSelect.innerHTML = "";

    // Add default option
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select an area...";
    this.areaSelect.appendChild(defaultOption);

    // Add each coverage area
    this.coverageAreas.forEach((area) => {
      const option = document.createElement("option");
      const displayName = area.location?.display_name || area._id;
      option.value = displayName;
      option.textContent = displayName;
      this.areaSelect.appendChild(option);
    });

    // Enable the area select
    this.areaSelect.disabled = false;
  }

  async handleAreaChange() {
    if (!this.areaSelect) return;

    const selectedAreaName = this.areaSelect.value;
    if (!selectedAreaName) {
      this.findBtn.disabled = true;
      this.calcCoverageBtn.disabled = true;
      this.setStatus("Please select an area.");
      return;
    }

    // Find the selected area details
    const selectedArea = this.coverageAreas.find(
      (area) => area.location?.display_name === selectedAreaName,
    );

    if (!selectedArea) {
      this.setStatus("Selected area not found.", true);
      return;
    }

    this.selectedLocation = selectedArea;
    this.setStatus(`Selected area: ${selectedAreaName}`);

    // Enable buttons
    this.findBtn.disabled = false;
    this.calcCoverageBtn.disabled = false;

    // Fetch and display undriven streets
    await this.fetchAndDisplayUndrivenStreets();
  }

  async fetchAndDisplayUndrivenStreets() {
    if (!this.selectedLocation || !this.selectedLocation.location) {
      this.setStatus(
        "Please select an area first or selected area has no location data.",
        true,
      );
      return;
    }

    const locationData = this.selectedLocation.location;
    const displayName = locationData.display_name;

    this.setStatus(`Loading undriven streets for ${displayName}...`);
    this.undrivenStreetsLayer.clearLayers();

    const requestPayload = {
      display_name: displayName,
      boundary: locationData.boundary_geojson || null,
      osm_id: locationData.osm_id,
      osm_type: locationData.osm_type,
      licence: locationData.licence,
      lat: locationData.lat,
      lon: locationData.lon,
      boundingbox: locationData.boundingbox,
      place_id: locationData.place_id,
      category: locationData.category,
      type: locationData.type,
      importance: locationData.importance,
      icon: locationData.icon,
      geojson: locationData.geojson,
    };

    Object.keys(requestPayload).forEach((key) => {
      if (requestPayload[key] === undefined) {
        delete requestPayload[key];
      }
    });

    console.log(
      "Request body for /api/undriven_streets:",
      JSON.stringify(requestPayload, null, 2),
    );
    console.log(
      "Value of boundary_geojson being sent as 'boundary':",
      locationData.boundary_geojson,
    );

    try {
      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        let errorDetail = `HTTP error ${response.status}`;
        try {
          const errorData = await response.json();
          console.error(
            "Server Error Data for /api/undriven_streets:",
            errorData,
          );
          if (errorData && errorData.detail) {
            if (Array.isArray(errorData.detail)) {
              errorDetail +=
                ": " +
                errorData.detail
                  .map((err) => {
                    const loc = err.loc ? err.loc.join(" -> ") : "N/A";
                    return `${loc}: ${err.msg} (type: ${err.type})`;
                  })
                  .join("; ");
            } else {
              errorDetail += ": " + JSON.stringify(errorData.detail);
            }
          } else {
            errorDetail += " - Server response: " + (await response.text());
          }
        } catch (e) {
          console.error(
            "Could not parse error response as JSON or get text:",
            e,
          );
          errorDetail += " (could not parse server error response)";
        }
        throw new Error(errorDetail);
      }

      const data = await response.json();

      if (
        data &&
        data.features &&
        Array.isArray(data.features) &&
        data.features.length > 0
      ) {
        try {
          L.geoJSON(data, {
            style: {
              color: "#00bfff",
              weight: 3,
              opacity: 0.6,
              dashArray: "4, 4",
              className: "undriven-street-nav",
            },
            onEachFeature: (feature, layer) => {
              if (feature.properties && feature.properties.segment_id) {
                layer.on("click", () => {
                  this.findRouteToSegment(feature.properties.segment_id);
                });

                const streetName =
                  feature.properties.street_name || "Unnamed Street";
                layer.bindPopup(`
                  <div>
                    <strong>${streetName}</strong><br>
                    <small>Segment ID: ${feature.properties.segment_id}</small><br>
                    <button class="btn btn-sm btn-primary mt-2" 
                            onclick="window.enhancedNavigation.findRouteToSegment('${feature.properties.segment_id}')">
                      Navigate Here
                    </button>
                  </div>
                `);
              }
            },
          }).addTo(this.undrivenStreetsLayer);

          if (this.undrivenStreetsLayer.getLayers().length > 0) {
            const bounds = this.undrivenStreetsLayer.getBounds();
            if (bounds && bounds.isValid()) {
              this.map.fitBounds(bounds);
            } else {
              console.warn(
                "Undriven streets layer bounds are not valid. Cannot fit map.",
              );
            }
          } else {
            console.warn(
              "No layers added to undrivenStreetsLayer after L.geoJSON. Cannot get bounds.",
            );
          }
        } catch (e) {
          console.error("Error processing GeoJSON data with Leaflet:", e);
          console.error("Problematic GeoJSON data:", data);
          this.setStatus(
            `Error displaying undriven streets on map: ${e.message}`,
            true,
          );
        }

        this.setStatus(
          `Loaded ${data.features.length} undriven street segments.`,
        );
      } else {
        console.warn(
          "No features found in /api/undriven_streets response or data is malformed. Data:",
          data,
        );
        this.setStatus(
          "No undriven streets found in this area or data format issue.",
        );
      }
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      this.setStatus(`Error fetching undriven streets: ${error.message}`, true);
    }
  }

  async findAndDisplayRoute() {
    if (!this.selectedLocation || !this.selectedLocation.location) {
      this.setStatus(
        "Please select an area first or selected area has no location data.",
        true,
      );
      return;
    }

    if (this.isFetchingRoute) {
      this.setStatus("Route calculation already in progress.", true);
      return;
    }

    this.isFetchingRoute = true;
    this.findBtn.disabled = true;
    this.findBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin me-2"></i>Finding Route...';
    this.setStatus("Calculating route to nearest undriven street...");

    // Clear previous route and target
    this.routeLayer.clearLayers();
    this.targetStreetLayer.clearLayers();
    this.targetInfo.innerHTML = "";
    this.routeInfo.innerHTML = "";
    this.hideRouteDetails();

    this.showProgressContainer();
    this.setActiveStep("clustering");
    this.updateProgress(30, "Finding the nearest undriven street...");

    try {
      // Request route using the navigation service
      const routeOptions = {
        avoidHighways: this.avoidHighwaysToggle.checked,
        prioritizeConnectivity: this.prioritizeConnectivityToggle.checked,
        routeType: "nearest",
      };

      const route = await this.navigationService.requestRoute(
        this.selectedLocation.location,
        routeOptions,
      );

      if (!route) {
        // This could be because there are no more undriven streets
        this.hideProgressContainer();
        this.findBtn.disabled = false;
        this.findBtn.innerHTML =
          '<i class="fas fa-route me-2"></i>Find Nearest Undriven Street';
        this.isFetchingRoute = false;
        return;
      }

      this.setActiveStep("rendering");

      // Display the route on the map
      const routeLayer = L.geoJSON(route.geometry, {
        style: {
          color: "#76ff03",
          weight: 5,
          opacity: 0.8,
          className: "calculated-route",
        },
      }).addTo(this.routeLayer);

      // Highlight the target street
      this.highlightTargetStreet(route.targetStreet);

      // Update UI with route information
      const streetName = route.targetStreet.street_name || "Unnamed Street";
      this.targetInfo.innerHTML = `
        <div class="alert alert-info p-2 mb-2">
          <i class="fas fa-map-pin me-2"></i>
          <strong>Target:</strong> ${streetName}
          <div class="mt-1 small text-light">Segment ID: ${route.targetStreet.segment_id}</div>
        </div>
      `;

      const durationMinutes = Math.round(route.duration / 60);
      const distanceMiles = (route.distance * 0.000621371).toFixed(1);

      this.routeInfo.innerHTML = `
        <div class="card bg-dark p-2 mt-2">
          <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Route Information</h6>
          <div class="route-info-detail">
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
          </div>
          <div class="mt-2">
            <button id="start-navigation-btn" class="btn btn-success btn-sm w-100">
              <i class="fas fa-play me-1"></i>Start Navigation
            </button>
          </div>
        </div>
      `;

      // Add click handler for the start navigation button
      document
        .getElementById("start-navigation-btn")
        .addEventListener("click", () => {
          this.startNavigation();
        });

      this.showRouteDetails({
        segments: 1,
        duration: route.duration,
        distance: route.distance,
      });

      // Fit map to include both the route and the user's location
      try {
        let boundsToFit = routeLayer.getBounds();

        if (this.positionMarker) {
          boundsToFit.extend(this.positionMarker.getLatLng());
        }

        if (boundsToFit.isValid()) {
          this.map.fitBounds(boundsToFit, { padding: [70, 70] });
        }
      } catch (error) {
        console.error("Error fitting map bounds:", error);
      }

      this.updateProgress(100, "Route calculation complete!");
      setTimeout(() => {
        this.hideProgressContainer();
      }, 1000);

      this.setStatus(`Route calculated. Head towards ${streetName}.`);
    } catch (error) {
      console.error("Error finding route:", error);
      this.setStatus(`Error finding route: ${error.message}`, true);
    } finally {
      this.findBtn.disabled = false;
      this.findBtn.innerHTML =
        '<i class="fas fa-route me-2"></i>Find Nearest Undriven Street';
      this.isFetchingRoute = false;
    }
  }

  highlightTargetStreet(targetStreet) {
    if (!targetStreet || !targetStreet.start_coords) {
      console.error("Invalid target street data");
      return;
    }

    this.targetStreetLayer.clearLayers();

    // We'll make a simple marker at the start of the target street
    const startCoords = [
      targetStreet.start_coords[1],
      targetStreet.start_coords[0],
    ];

    // Create a custom destination marker
    const destinationIcon = L.divIcon({
      className: "destination-marker",
      html: '<i class="fas fa-flag-checkered" style="color:#ffab00; font-size: 24px;"></i>',
      iconSize: [24, 24],
      iconAnchor: [12, 24],
    });

    L.marker(startCoords, { icon: destinationIcon }).addTo(
      this.targetStreetLayer,
    ).bindPopup(`
        <strong>${targetStreet.street_name || "Unnamed Street"}</strong><br>
        <small>Your destination</small>
      `);
  }

  async calculateCoverageRoute() {
    // This would be enhanced to calculate a full coverage route
    this.setStatus(
      "Full coverage route calculation is not implemented in this version",
    );
  }

  startNavigation() {
    if (!this.navigationService.currentRoute) {
      this.setStatus("No route available for navigation", true);
      return;
    }

    // Start navigation
    const success = this.navigationService.startNavigation();

    if (!success) {
      this.setStatus("Failed to start navigation", true);
      return;
    }

    // Update UI for navigation mode
    this.isNavigating = true;
    this.navigationPanel.classList.add("active");

    // Turn on auto-follow
    this.autoFollowToggle.checked = true;
    localStorage.setItem("navigation_auto_follow", "true");

    this.setStatus("Navigation started");

    // Center on user's location
    this.centerOnUserLocation();
  }

  stopNavigation() {
    this.navigationService.stopNavigation();
    this.isNavigating = false;
    this.navigationPanel.classList.remove("active");
    this.setStatus("Navigation stopped");
  }

  recalculateRoute() {
    if (
      !this.isNavigating ||
      !this.selectedLocation ||
      !this.selectedLocation.location
    )
      return;

    this.setStatus("Recalculating route...");

    // Use the same target street
    const options = {};
    if (this.navigationService.targetStreet) {
      options.segmentId = this.navigationService.targetStreet.segment_id;
    }

    options.avoidHighways = this.avoidHighwaysToggle.checked;
    options.prioritizeConnectivity = this.prioritizeConnectivityToggle.checked;

    this.navigationService.requestRoute(
      this.selectedLocation.location,
      options,
    );
  }

  centerOnUserLocation() {
    if (!this.navigationService.currentPosition) {
      this.setStatus("No location available", true);
      return;
    }

    const position = this.navigationService.currentPosition;
    const latLng = L.latLng(
      position.coords.latitude,
      position.coords.longitude,
    );

    // Set appropriate zoom level based on accuracy
    let zoomLevel = 17;
    if (position.coords.accuracy > 100) {
      zoomLevel = 16;
    } else if (position.coords.accuracy < 20) {
      zoomLevel = 18;
    }

    this.map.setView(latLng, zoomLevel);

    // Visual feedback on the center button
    this.centerPositionBtn.classList.add("tracking");
    setTimeout(() => {
      this.centerPositionBtn.classList.remove("tracking");
    }, 1000);
  }

  // Handle updates from the NavigationService

  handlePositionUpdate(position) {
    // Update map with new position
    this.updatePositionOnMap(position);

    // Auto-follow if enabled
    if (this.autoFollowToggle && this.autoFollowToggle.checked) {
      // Only center the map if we're in navigation mode or the map hasn't been centered yet
      if (this.isNavigating || !this._hasInitialCentering) {
        this.centerOnUserLocation();
        this._hasInitialCentering = true;
      }
    }

    // Hide reconnecting overlay if it was showing
    this.reconnectingOverlay.classList.remove("active");
  }

  updatePositionOnMap(position) {
    // Clear previous markers
    this.userLocationLayer.clearLayers();

    const coords = position.coords;
    const latLng = L.latLng(coords.latitude, coords.longitude);

    // Add accuracy circle
    this.accuracyCircle = L.circle(latLng, {
      radius: coords.accuracy,
      color: "#0dcaf0",
      fillColor: "#0dcaf0",
      fillOpacity: 0.15,
      weight: 1,
    }).addTo(this.userLocationLayer);

    // Add position marker with heading
    let markerHtml = '<div class="position-marker-inner"></div>';

    // If we have heading information, create a heading indicator
    if (coords.heading && !isNaN(coords.heading)) {
      const headingRotation = coords.heading;
      markerHtml = `
        <div class="position-marker-inner"></div>
        <div class="heading-indicator" style="transform: rotate(${headingRotation}deg)">
          <i class="fas fa-caret-up"></i>
        </div>
      `;
    }

    // Create marker
    this.positionMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "live-location-marker",
        iconSize: [16, 16],
        html: markerHtml,
      }),
    }).addTo(this.userLocationLayer);

    // Add a popup with coordinates and accuracy
    this.positionMarker.bindPopup(`
      <strong>Your Location</strong><br>
      Lat: ${coords.latitude.toFixed(6)}<br>
      Lon: ${coords.longitude.toFixed(6)}<br>
      Accuracy: ${Math.round(coords.accuracy)} m
      ${coords.heading ? `<br>Heading: ${Math.round(coords.heading)}°` : ""}
      ${coords.speed ? `<br>Speed: ${Math.round(coords.speed * 2.23694)} mph` : ""}
    `);
  }

  handleNavigationUpdate(update) {
    if (!update) return;

    switch (update.type) {
      case "started":
        this.setStatus("Navigation started");
        break;

      case "stopped":
        this.navigationPanel.classList.remove("active");
        this.setStatus("Navigation stopped");
        break;

      case "completed":
        this.navigationPanel.classList.remove("active");
        this.setStatus(update.message);
        break;

      case "arrived":
        this.navigationPanel.classList.remove("active");
        this.setStatus("You have arrived at your destination!");
        break;

      case "progress":
        // Update progress in the navigation panel
        if (update.remainingDistance && update.remainingDuration) {
          const distanceMiles = (
            update.remainingDistance * 0.000621371
          ).toFixed(1);
          const timeMinutes = Math.round(update.remainingDuration / 60);

          this.directionDistance.textContent = `${distanceMiles} miles - ${timeMinutes} min`;

          // Update progress bar
          if (this.navigationService.currentRoute) {
            const totalDistance = this.navigationService.currentRoute.distance;
            const progress =
              100 - (update.remainingDistance / totalDistance) * 100;
            this.navProgressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
          }
        }
        break;
    }
  }

  handleRouteRecalculation(route) {
    if (!route) return;

    // Update the map with the new route
    this.routeLayer.clearLayers();

    L.geoJSON(route.geometry, {
      style: {
        color: "#76ff03",
        weight: 5,
        opacity: 0.8,
        className: "calculated-route",
      },
    }).addTo(this.routeLayer);

    // Highlight the target street
    this.highlightTargetStreet(route.targetStreet);

    // Update route info on the UI
    const streetName = route.targetStreet.street_name || "Unnamed Street";
    const durationMinutes = Math.round(route.duration / 60);
    const distanceMiles = (route.distance * 0.000621371).toFixed(1);

    this.setStatus(`Route recalculated to ${streetName}`);

    if (this.isNavigating) {
      // Update the navigation panel
      this.directionInstruction.textContent = `Continue to ${streetName}`;
      this.directionDistance.textContent = `${distanceMiles} miles - ${durationMinutes} min`;
    }
  }

  handleNavigationError(error) {
    console.error("Navigation error:", error.message);
    this.setStatus(`Navigation error: ${error.message}`, true);

    // Show reconnecting overlay for location errors
    if (
      error.message.includes("location") ||
      error.message.includes("position") ||
      error.message.includes("GPS")
    ) {
      this.reconnectingOverlay.classList.add("active");
    }
  }

  handleDirectionChange(direction) {
    if (!direction) return;

    // Update the navigation panel with the new direction
    this.directionInstruction.textContent = direction.instruction;

    if (direction.distance) {
      const distanceMiles = (direction.distance * 0.000621371).toFixed(1);
      this.directionDistance.textContent = `${distanceMiles} miles`;
    }

    // Update the maneuver icon
    let iconClass = "fa-arrow-alt-circle-up"; // Default icon

    switch (direction.type) {
      case "START":
        iconClass = "fa-play-circle";
        break;
      case "STRAIGHT":
        iconClass = "fa-arrow-alt-circle-up";
        break;
      case "LEFT":
        iconClass = "fa-arrow-alt-circle-left";
        break;
      case "RIGHT":
        iconClass = "fa-arrow-alt-circle-right";
        break;
      case "ARRIVE":
        iconClass = "fa-flag-checkered";
        break;
    }

    // Update the icon
    this.maneuverIcon.className = `fas ${iconClass}`;
  }

  // UI utility methods

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;

    this.statusMsg.className = isError
      ? "info-panel alert alert-danger"
      : "info-panel";

    this.statusMsg.textContent = message;

    console.log(`Status: ${message}${isError ? " (ERROR)" : ""}`);
  }

  showProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.add("active");
    }
  }

  hideProgressContainer() {
    if (this.progressContainer) {
      this.progressContainer.classList.remove("active");
    }
  }

  updateProgress(percent, status) {
    if (this.progressBar) {
      this.progressBar.style.width = `${percent}%`;
    }

    if (this.processingStatus) {
      this.processingStatus.textContent = status;
    }
  }

  resetSteps() {
    [this.stepClustering, this.stepOptimizing, this.stepRendering].forEach(
      (step) => {
        if (step) {
          step.classList.remove("active", "completed");
        }
      },
    );
    this.currentStep = null;
  }

  setActiveStep(step) {
    if (!step) return;

    // First, make all previous steps completed
    if (step === "optimizing" && this.stepClustering) {
      this.stepClustering.classList.remove("active");
      this.stepClustering.classList.add("completed");
    } else if (step === "rendering") {
      if (this.stepClustering) {
        this.stepClustering.classList.remove("active");
        this.stepClustering.classList.add("completed");
      }
      if (this.stepOptimizing) {
        this.stepOptimizing.classList.remove("active");
        this.stepOptimizing.classList.add("completed");
      }
    }

    // Set the active step
    const stepElement =
      this[`step${step.charAt(0).toUpperCase() + step.slice(1)}`];
    if (stepElement) {
      stepElement.classList.add("active");
    }

    this.currentStep = step;
  }

  showRouteDetails(routeData) {
    if (!this.routeDetails || !routeData) return;

    this.routeDetails.style.display = "block";

    if (this.routeStats) {
      const segmentCount = routeData.segments || 1;
      const durationHours = Math.floor(routeData.duration / 3600);
      const durationMinutes = Math.floor((routeData.duration % 3600) / 60);
      const distanceMiles = (routeData.distance * 0.000621371).toFixed(1);

      this.routeStats.innerHTML = `
        <div><strong>Street Segments:</strong> ${segmentCount}</div>
        <div><strong>Estimated Time:</strong> ${durationHours > 0 ? `${durationHours}h ` : ""}${durationMinutes}min</div>
        <div><strong>Total Distance:</strong> ${distanceMiles} miles</div>
      `;
    }

    // Add legend
    if (this.routeLegend) {
      this.routeLegend.innerHTML = `
        <div class="legend-item">
          <div class="legend-color" style="background-color: #76ff03;"></div>
          <span>Route</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background-color: #ffab00;"></div>
          <span>Destination</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background-color: #0dcaf0;"></div>
          <span>Your Position</span>
        </div>
      `;
    }
  }

  hideRouteDetails() {
    if (this.routeDetails) {
      this.routeDetails.style.display = "none";
    }
  }

  async findRouteToSegment(segmentId) {
    if (!this.selectedLocation || !this.selectedLocation.location || !segmentId)
      return;

    // Disable buttons during route calculation
    this.findBtn.disabled = true;
    this.calcCoverageBtn.disabled = true;

    this.setStatus(`Calculating route to segment #${segmentId}...`);
    this.showProgressContainer();
    this.setActiveStep("optimizing");

    try {
      // Request route using the navigation service
      const routeOptions = {
        segmentId,
        avoidHighways: this.avoidHighwaysToggle.checked,
        prioritizeConnectivity: this.prioritizeConnectivityToggle.checked,
      };

      const route = await this.navigationService.requestRoute(
        this.selectedLocation.location,
        routeOptions,
      );

      if (!route) {
        this.setStatus("Failed to calculate route to segment", true);
        this.hideProgressContainer();
        return;
      }

      // Display the route on the map
      this.routeLayer.clearLayers();
      this.targetStreetLayer.clearLayers();

      L.geoJSON(route.geometry, {
        style: {
          color: "#76ff03",
          weight: 5,
          opacity: 0.8,
          className: "calculated-route",
        },
      }).addTo(this.routeLayer);

      // Highlight the target street
      this.highlightTargetStreet(route.targetStreet);

      // Update UI with route information
      const streetName = route.targetStreet.street_name || "Unnamed Street";
      this.targetInfo.innerHTML = `
        <div class="alert alert-info p-2 mb-2">
          <i class="fas fa-map-pin me-2"></i>
          <strong>Target:</strong> ${streetName}
          <div class="mt-1 small text-light">Segment ID: ${route.targetStreet.segment_id}</div>
        </div>
      `;

      const durationMinutes = Math.round(route.duration / 60);
      const distanceMiles = (route.distance * 0.000621371).toFixed(1);

      this.routeInfo.innerHTML = `
        <div class="card bg-dark p-2 mt-2">
          <h6 class="mb-2"><i class="fas fa-info-circle me-2"></i>Route Information</h6>
          <div class="route-info-detail">
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
          </div>
          <div class="mt-2">
            <button id="start-navigation-btn" class="btn btn-success btn-sm w-100">
              <i class="fas fa-play me-1"></i>Start Navigation
            </button>
          </div>
        </div>
      `;

      // Add click handler for the start navigation button
      document
        .getElementById("start-navigation-btn")
        .addEventListener("click", () => {
          this.startNavigation();
        });

      this.showRouteDetails({
        segments: 1,
        duration: route.duration,
        distance: route.distance,
      });

      // Fit bounds to include route and user location
      try {
        const routeBounds = L.geoJSON(route.geometry).getBounds();
        let boundsToFit = routeBounds;

        if (this.positionMarker) {
          boundsToFit.extend(this.positionMarker.getLatLng());
        }

        if (boundsToFit.isValid()) {
          this.map.fitBounds(boundsToFit, { padding: [70, 70] });
        }
      } catch (error) {
        console.error("Error fitting map bounds:", error);
      }

      this.setStatus(`Route calculated to ${streetName}.`);

      this.updateProgress(100, "Route calculation complete!");
      setTimeout(() => this.hideProgressContainer(), 1000);
    } catch (error) {
      console.error("Error finding route to segment:", error);
      this.setStatus(`Error finding route: ${error.message}`, true);
    } finally {
      this.findBtn.disabled = false;
      this.calcCoverageBtn.disabled = false;
    }
  }
}

// Initialize the enhanced navigation when the document is ready
document.addEventListener("DOMContentLoaded", () => {
  // Create and store an instance globally
  window.enhancedNavigation = new EnhancedNavigation();
});
