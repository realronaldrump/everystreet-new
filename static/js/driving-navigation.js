/* global L, MAPBOX_ACCESS_TOKEN, LiveTripTracker, notificationManager */
"use strict";

class DrivingNavigation {
  constructor() {
    this.map = null;
    this.areaSelect = document.getElementById("area-select");
    this.findBtn = document.getElementById("find-next-street-btn");
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

    const latestCoord = trip.coordinates[trip.coordinates.length - 1];
    const latLng = [latestCoord.lat, latestCoord.lon];
    this.lastKnownLocation = { lat: latestCoord.lat, lon: latestCoord.lon };

    if (this.liveLocationMarker) {
      this.liveLocationMarker.setLatLng(latLng);
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
    // Optionally update status or other UI elements based on live data
    // e.g., display current speed if available in 'trip' object
  }

  handleLiveTripClear() {
    this.lastKnownLocation = null;
    if (this.liveLocationMarker) {
      this.liveLocationMarker.setOpacity(0); // Hide marker
    }
    this.setStatus("Live location unavailable.", true);
  }

  setupEventListeners() {
    if (this.areaSelect) {
      this.areaSelect.addEventListener("change", () => this.handleAreaChange());
    }
    if (this.findBtn) {
      this.findBtn.addEventListener("click", () => this.findAndDisplayRoute());
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
    if (this.isFetchingRoute) {
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
      const response = await fetch("/api/driving-navigation/next-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.selectedLocation), // Send the full location object
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
        // Display the route
        L.geoJSON(data.route_geometry, {
          style: {
            color: "#76ff03", // Bright Green
            weight: 5,
            opacity: 0.8,
            className: "calculated-route",
          },
        }).addTo(this.routeLayer);

        // Highlight the target street segment
        this.highlightTargetStreet(data.target_street.segment_id);

        // Display target info
        const streetName = data.target_street.street_name || "Unnamed Street";
        this.targetInfo.innerHTML = `<strong>Target:</strong> ${streetName} (ID: ${data.target_street.segment_id})`;
        this.setStatus(`Route calculated. Head towards ${streetName}.`);

        // Display route info
        const durationMinutes = Math.round(data.route_duration_seconds / 60);
        const distanceMiles = (
          data.route_distance_meters * 0.000621371
        ).toFixed(1);
        this.routeInfo.innerHTML = `Est. Time: ${durationMinutes} min, Distance: ${distanceMiles} mi`;

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
        layer.bringToFront();
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

  setStatus(message, isError = false) {
    if (!this.statusMsg) return;
    this.statusMsg.textContent = message;
    this.statusMsg.classList.toggle("text-danger", isError);
    this.statusMsg.classList.toggle("text-info", !isError);
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
