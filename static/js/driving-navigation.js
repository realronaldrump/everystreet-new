/* global L, MAPBOX_ACCESS_TOKEN, LiveTripTracker, notificationManager */
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

    this.coverageAreas = [];
    this.selectedLocation = null;
    this.undrivenStreetsLayer = L.layerGroup();
    this.routeLayer = L.layerGroup();
    this.liveLocationMarker = null;
    this.targetStreetLayer = null; // To highlight the target segment

    this.liveTracker = null; // Instance of LiveTripTracker
    this.lastKnownLocation = null; // Store {lat, lon}
    this.isFetchingRoute = false; // Prevent concurrent requests
    this.isFetchingCoverageRoute = false; // Prevent concurrent coverage requests

    this.initialize();
  }

  async initialize() {
    this.setupEventListeners();
    this.initMap(); // initMap will now handle invalidateSize
    await this.loadCoverageAreas();
    this.initLiveTracking();
    this.loadAutoFollowState(); // Load saved auto-follow preference
  }

  initMap() {
    try {
      const mapContainer = document.getElementById("driving-map"); // Get container reference
      if (!mapContainer) {
        console.error("Map container #driving-map not found!");
        this.setStatus("Map container not found.", true);
        return; // Stop if container doesn't exist
      }
      // Ensure container is not empty (remove spinner if present)
      mapContainer.innerHTML = "";

      this.map = L.map("driving-map").setView([37.8, -96], 4); // Default view

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

      // Initialize live location marker (invisible initially)
      this.liveLocationMarker = L.marker([0, 0], {
        icon: L.divIcon({
          className: "live-location-marker",
          iconSize: [16, 16],
        }),
        opacity: 0, // Start hidden
        zIndexOffset: 1000, // Ensure it's on top
      }).addTo(this.map);

      this.setStatus("Map initialized. Select an area.");

      // --- FIX: Add invalidateSize after a short delay ---
      setTimeout(() => {
        if (this.map) {
          // Check if map still exists
          console.log("Invalidating map size...");
          this.map.invalidateSize();
        }
      }, 150); // 150ms delay should be sufficient
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

    // Create our trip path layer for showing the full path
    this.liveTripPathLayer = L.polyline([], {
      color: "#00FF00", // Green path to show it's live
      weight: 3,
      opacity: 0.8,
      zIndex: 1000, // High z-index to keep on top
    }).addTo(this.map);

    // Use a custom handler for trip updates instead of the default map updates
    this.liveTracker = new LiveTripTracker(this.map); // Pass map, though we override updates

    // Override the default update behavior
    this.liveTracker.setActiveTrip = (trip) => {
      this.handleLiveTripUpdate(trip);
    };
    this.liveTracker.clearActiveTrip = () => {
      this.handleLiveTripClear();
    };

    // Start polling (the LiveTripTracker's initialize method does this)
    // We don't need to call startPolling explicitly if initialize is called
    console.log("Live tracking initialized for navigation.");
  }

  handleLiveTripUpdate(trip) {
    if (!trip || !trip.coordinates || trip.coordinates.length === 0) {
      this.handleLiveTripClear();
      return;
    }

    // Sort coordinates by timestamp to ensure proper path drawing
    const sortedCoords = [...trip.coordinates];
    sortedCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Create array of LatLng points for the full path
    const latLngs = sortedCoords.map((coord) => [coord.lat, coord.lon]);

    // Get the last point for marker positioning
    const latestCoord = sortedCoords[sortedCoords.length - 1];
    const latLng = [latestCoord.lat, latestCoord.lon];

    // Store the last known location for route finding
    this.lastKnownLocation = { lat: latestCoord.lat, lon: latestCoord.lon };

    // Update trip path polyline
    if (this.liveTripPathLayer) {
      this.liveTripPathLayer.setLatLngs(latLngs);
      this.liveTripPathLayer.bringToFront();
    }

    // Update location marker
    if (this.liveLocationMarker) {
      this.liveLocationMarker.setLatLng(latLng);

      // Update marker icon based on speed (if available)
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

        this.liveLocationMarker.setIcon(
          L.divIcon({
            className: markerClass,
            iconSize: [16, 16],
            html: `<div class="vehicle-marker-inner" data-speed="${Math.round(speed)}"></div>`,
          }),
        );
      }

      // Handle visibility and map positioning
      if (this.liveLocationMarker.options.opacity === 0) {
        this.liveLocationMarker.setOpacity(1); // Make visible
        if (this.map && this.getAutoFollowState()) {
          this.map.setView(latLng, 16); // Zoom in on first location update if auto-follow is on
        }
      } else if (this.map && this.getAutoFollowState()) {
        // Smoothly pan if auto-follow is on
        this.map.panTo(latLng, { animate: true, duration: 0.5 });
      }
    }

    // Update status message with live data
    if (trip.currentSpeed !== undefined) {
      const speedMph = Math.round(trip.currentSpeed);
      this.setStatus(`Live tracking active. Current speed: ${speedMph} mph`);
    } else {
      this.setStatus("Live tracking active.");
    }

    // Re-enable find button if it was disabled due to missing location
    if (
      this.findBtn &&
      this.findBtn.disabled &&
      this.findBtn.dataset.disabledReason === "no-location"
    ) {
      this.findBtn.disabled = false;
      delete this.findBtn.dataset.disabledReason;
    }
  }

  handleLiveTripClear() {
    this.lastKnownLocation = null;

    // Hide marker
    if (this.liveLocationMarker) {
      this.liveLocationMarker.setOpacity(0);
    }

    // Clear path
    if (this.liveTripPathLayer) {
      this.liveTripPathLayer.setLatLngs([]);
    }

    this.setStatus("Live location unavailable.", true);

    // Disable find button if it depends on location
    if (this.findBtn && !this.findBtn.disabled) {
      this.findBtn.disabled = true;
      this.findBtn.dataset.disabledReason = "no-location";
    }
    // Also handle the coverage button
    if (
      this.calcCoverageBtn &&
      this.calcCoverageBtn.disabled &&
      this.calcCoverageBtn.dataset.disabledReason === "no-location"
    ) {
      this.calcCoverageBtn.disabled = false;
      delete this.calcCoverageBtn.dataset.disabledReason;
    }
  }

  setupEventListeners() {
    if (this.areaSelect) {
      this.areaSelect.addEventListener("change", () => this.handleAreaChange());
    }
    if (this.findBtn) {
      this.findBtn.addEventListener("click", () => this.findAndDisplayRoute());
    }
    // Add listener for the new coverage route button
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

    // Add map-related event listeners to ensure live elements stay on top
    if (this.map) {
      // When any other layers are added, ensure live elements stay on top
      this.map.on("layeradd", () => {
        // Use setTimeout to ensure this runs after the layer is fully added
        setTimeout(() => this.bringLiveElementsToFront(), 50);
      });

      // When zoom ends, ensure live elements stay visible
      this.map.on("zoomend", () => this.bringLiveElementsToFront());

      // When panning ends, ensure live elements stay visible
      this.map.on("moveend", () => this.bringLiveElementsToFront());
    }

    // Listen for document-level events that might affect the map
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
    this.areaSelect.innerHTML = '<option value="">Select an area...</option>'; // Clear existing

    this.coverageAreas.forEach((area) => {
      if (area.location && area.location.display_name) {
        const option = document.createElement("option");
        // Store the full location object as JSON string in the value
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
      this.calcCoverageBtn.disabled = true; // Disable coverage button too
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
      this.findBtn.disabled = false; // Enable button once area is selected
      this.calcCoverageBtn.disabled = false; // Enable coverage button too

      // Clear previous layers
      this.undrivenStreetsLayer.clearLayers();
      this.routeLayer.clearLayers();
      this.clearTargetStreetHighlight();
      this.targetInfo.innerHTML = ""; // Clear target info
      this.routeInfo.innerHTML = ""; // Clear route info

      // Fetch and display undriven streets for the selected area
      await this.fetchAndDisplayUndrivenStreets();
    } catch (error) {
      console.error("Error parsing selected location:", error);
      this.selectedLocation = null;
      this.findBtn.disabled = true;
      this.calcCoverageBtn.disabled = true; // Disable coverage button too
      this.setStatus("Invalid area selected.", true);
    }
  }

  async fetchAndDisplayUndrivenStreets() {
    if (!this.selectedLocation) return;

    this.setStatus(
      `Fetching undriven streets for ${this.selectedLocation.display_name}...`,
    );
    this.undrivenStreetsLayer.clearLayers(); // Clear previous streets

    try {
      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.selectedLocation),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error ${response.status}`);
      }

      const geojson = await response.json();

      if (geojson && geojson.features && geojson.features.length > 0) {
        // --- Create the GeoJSON layer ---
        const geoJsonLayer = L.geoJSON(geojson, {
          style: {
            color: "#00BFFF", // Deep Sky Blue
            weight: 3,
            opacity: 0.6,
            dashArray: "4, 4",
            className: "undriven-street-nav", // Add class for potential future use
          },
          // Optional: Add popups if needed
          // onEachFeature: (feature, layer) => {
          //     if (feature.properties && feature.properties.street_name) {
          //         layer.bindPopup(feature.properties.street_name);
          //     }
          // }
        });

        // --- Add it to the layer group ---
        this.undrivenStreetsLayer.addLayer(geoJsonLayer);

        // --- Get bounds from the created GeoJSON layer ---
        const bounds = geoJsonLayer.getBounds();
        if (bounds.isValid()) {
          this.map.fitBounds(bounds, { padding: [50, 50] });
        }
        this.setStatus(`Loaded ${geojson.features.length} undriven streets.`);
      } else {
        this.setStatus(
          `No undriven streets found in ${this.selectedLocation.display_name}.`,
        );
        // Optionally zoom to the general area if no streets are found
        if (this.selectedLocation.boundingbox) {
          // Enable buttons even if no streets are found, as long as area is valid
          this.findBtn.disabled = !this.lastKnownLocation;
          this.calcCoverageBtn.disabled = !this.lastKnownLocation;
          if (!this.lastKnownLocation) {
            const reason = "no-location";
            if (this.findBtn) this.findBtn.dataset.disabledReason = reason;
            if (this.calcCoverageBtn)
              this.calcCoverageBtn.dataset.disabledReason = reason;
          }

          try {
            const bbox = this.selectedLocation.boundingbox.map(parseFloat);
            // Leaflet bounds format: [[south, west], [north, east]]
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
      this.setStatus(`Error loading streets: ${error.message}`, true);
    }
  }

  async findAndDisplayRoute() {
    if (!this.selectedLocation) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (!this.lastKnownLocation) {
      this.setStatus("Waiting for current location...", true);
      // Optionally try to fetch location again or wait for next update
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
    this.routeLayer.clearLayers(); // Clear previous route
    this.clearTargetStreetHighlight(); // Clear previous target highlight
    this.targetInfo.innerHTML = ""; // Clear target info
    this.routeInfo.innerHTML = ""; // Clear route info

    try {
      // Create the request payload with both the current location and target area
      const requestPayload = {
        location: this.selectedLocation,
        current_position: this.lastKnownLocation,
      };

      console.log("Sending route request with payload:", requestPayload);

      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload), // Send both location and current position
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || `HTTP error ${response.status}`);
      }

      if (data.status === "completed") {
        this.setStatus(data.message);
        if (notificationManager)
          notificationManager.show(data.message, "success");
      } else if (
        data.status === "success" &&
        data.route_geometry &&
        data.target_street
      ) {
        // Display the route with better styling
        const routeLayer = L.geoJSON(data.route_geometry, {
          style: {
            color: "#76ff03", // Bright Green
            weight: 5,
            opacity: 0.8,
            className: "calculated-route",
          },
        }).addTo(this.routeLayer);

        // Highlight the target street segment
        this.highlightTargetStreet(data.target_street.segment_id);

        // Display target info with more detail
        const streetName = data.target_street.street_name || "Unnamed Street";
        this.targetInfo.innerHTML = `<strong>Target:</strong> ${streetName} (ID: ${data.target_street.segment_id})`;

        // Log location source for debugging
        const locationSource = data.location_source || "unknown";
        console.log(`Route calculated using ${locationSource} location data`);

        // Update status with more detail
        this.setStatus(`Route calculated. Head towards ${streetName}.`);

        // Display route info with nicer formatting
        const durationMinutes = Math.round(data.route_duration_seconds / 60);
        const distanceMiles = (
          data.route_distance_meters * 0.000621371
        ).toFixed(1);

        this.routeInfo.innerHTML = `
          <div class="route-info-detail">
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
            <div class="text-muted small">(Using ${locationSource} position)</div>
          </div>
        `;

        // Ensure live elements stay on top of the new route
        this.bringLiveElementsToFront();

        // Fit map to route start and target start
        const routeStart = [
          this.lastKnownLocation.lat,
          this.lastKnownLocation.lon,
        ];
        const targetStart = [
          data.target_street.start_coords[1],
          data.target_street.start_coords[0],
        ]; // Lat, Lon
        const bounds = L.latLngBounds([routeStart, targetStart]);

        // Check if live location marker is within the calculated bounds
        if (this.liveLocationMarker && this.liveLocationMarker.getLatLng()) {
          bounds.extend(this.liveLocationMarker.getLatLng());
        }

        if (bounds.isValid()) {
          this.map.fitBounds(bounds, { padding: [70, 70] }); // Add more padding
        }
      } else {
        // Handle unexpected success response format
        throw new Error(
          data.message || "Received unexpected success response.",
        );
      }
    } catch (error) {
      console.error("Error finding/displaying route:", error);
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
    this.clearTargetStreetHighlight(); // Clear previous highlight first

    this.undrivenStreetsLayer.eachLayer((layer) => {
      if (layer.feature?.properties?.segment_id === segmentId) {
        this.targetStreetLayer = layer; // Store reference
        layer.setStyle({
          color: "#ffab00", // Amber/Orange
          weight: 6,
          opacity: 1,
          dashArray: null, // Make it solid
          className: "target-street-segment", // Add class
        });
        layer.bringToFront(); // Ensure the highlighted segment is on top
      }
    });
  }

  clearTargetStreetHighlight() {
    if (this.targetStreetLayer) {
      // Reset style to the default undriven style
      this.targetStreetLayer.setStyle({
        color: "#00BFFF",
        weight: 3,
        opacity: 0.6,
        dashArray: "4, 4",
        className: "undriven-street-nav", // Reset class
      });
      this.targetStreetLayer = null;
    }
  }

  /**
   * Brings the live trip path and marker to the front
   * Call this method after any map updates that might affect layer order
   */
  bringLiveElementsToFront() {
    if (this.liveTripPathLayer) {
      this.liveTripPathLayer.bringToFront();
    }
    if (
      this.liveLocationMarker &&
      this.liveLocationMarker.options.opacity > 0
    ) {
      // REMOVED: this.liveLocationMarker.bringToFront(); // L.Marker does not have this method; rely on zIndexOffset.
    }
  }

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;
    this.statusMsg.textContent = message;
    this.statusMsg.classList.toggle("text-danger", isError);
    this.statusMsg.classList.toggle("text-info", !isError);
  }

  // --- New function for calculating and displaying the full coverage route ---
  async calculateAndDisplayCoverageRoute() {
    if (!this.selectedLocation) {
      this.setStatus("Please select an area first.", true);
      return;
    }
    if (!this.lastKnownLocation) {
      this.setStatus("Waiting for current location...", true);
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
    this.findBtn.disabled = true; // Disable other button during calculation
    this.setStatus("Calculating full coverage route...");
    this.routeLayer.clearLayers(); // Clear previous route (single or coverage)
    this.clearTargetStreetHighlight(); // Clear previous target highlight
    this.targetInfo.innerHTML = ""; // Clear target info
    this.routeInfo.innerHTML = ""; // Clear route info

    try {
      const requestPayload = {
        location: this.selectedLocation,
        current_position: this.lastKnownLocation,
      };

      console.log(
        "Sending coverage route request with payload:",
        requestPayload,
      );

      const response = await fetch("/api/driving-navigation/coverage-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || `HTTP error ${response.status}`);
      }

      if (data.status === "completed") {
        this.setStatus(data.message);
        if (notificationManager) notificationManager.show(data.message, "info");
      } else if (data.status === "success" && data.route_geometry) {
        // Route is a GeometryCollection
        const fullRouteLayer = L.layerGroup().addTo(this.routeLayer);
        let routeBounds = L.latLngBounds(); // To fit map later

        // Style for connecting route segments (calculated by Mapbox)
        const connectingRouteStyle = {
          color: "#76ff03", // Bright Green (same as single route)
          weight: 5,
          opacity: 0.8,
          className: "calculated-route", // Can reuse class
        };

        // Style for the actual undriven street segments included in the route
        const streetSegmentStyle = {
          color: "#007bff", // Primary Blue
          weight: 6,
          opacity: 0.9,
          // dashArray: "5, 5", // Optional: Dashed to distinguish
          className: "coverage-street-segment",
        };

        // The response geometry is a GeometryCollection
        if (data.route_geometry.type === "GeometryCollection") {
          data.route_geometry.geometries.forEach((geom, index) => {
            let style = {};
            // Alternate styles: Even indices are connecting routes, odd are street segments
            // (Assumes backend sends [route0, segment0, route1, segment1, ...])
            if (index % 2 === 0) {
              style = connectingRouteStyle;
            } else {
              style = streetSegmentStyle;
            }

            const layer = L.geoJSON(geom, {
              style: style,
            });
            fullRouteLayer.addLayer(layer);
            routeBounds.extend(layer.getBounds());
          });
        } else {
          // Fallback if geometry is not a collection (shouldn't happen)
          console.warn(
            "Received unexpected geometry type for coverage route:",
            data.route_geometry.type,
          );
          const layer = L.geoJSON(data.route_geometry, {
            style: connectingRouteStyle, // Default to route style
          });
          fullRouteLayer.addLayer(layer);
          routeBounds.extend(layer.getBounds());
        }

        // Fit map to the bounds of the entire route
        if (routeBounds.isValid()) {
          this.map.fitBounds(routeBounds, { padding: [50, 50] });
        }

        // Display total route info
        const durationMinutes = Math.round(data.total_duration_seconds / 60);
        const distanceMiles = (
          data.total_distance_meters * 0.000621371
        ).toFixed(1);
        const segmentCount = data.message.match(/\d+/)?.[0] || "?"; // Extract count from message

        this.setStatus(
          `Full coverage route calculated (${segmentCount} segments).`,
        );
        this.routeInfo.innerHTML = `
          <div class="route-info-detail">
            <div><strong>Total Est:</strong></div>
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
            <div class="text-muted small">(Using ${data.location_source} position)</div>
          </div>
        `;
        this.targetInfo.innerHTML = ""; // Clear specific target info

        // Ensure live elements stay on top of the new route
        this.bringLiveElementsToFront();
      } else {
        // Handle unexpected success response format
        throw new Error(
          data.message ||
            "Received unexpected success response from coverage route.",
        );
      }
    } catch (error) {
      console.error("Error calculating/displaying coverage route:", error);
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
      // Re-enable find button only if location is available
      this.findBtn.disabled = !this.lastKnownLocation;
      if (!this.lastKnownLocation && this.findBtn) {
        this.findBtn.dataset.disabledReason = "no-location";
      }
      this.isFetchingCoverageRoute = false;
    }
  }
}

// Initialize when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Check if Leaflet is loaded
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
