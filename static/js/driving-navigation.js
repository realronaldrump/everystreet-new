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
    this.targetStreetLayer = null;

    this.liveTracker = null;
    this.lastKnownLocation = null;
    this.isFetchingRoute = false;
    this.isFetchingCoverageRoute = false;
    this.clearTripTimeout = null;

    this.initialize();
  }

  async initialize() {
    this.setupEventListeners();
    this.initMap();
    await this.loadCoverageAreas();
    this.initLiveTracking();
    this.loadAutoFollowState();
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
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
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
      this.findBtn &&
      this.findBtn.disabled &&
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
      if (area.location && area.location.display_name) {
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
        this.setStatus(`Loaded ${geojson.features.length} undriven streets.`);
      } else {
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

    try {
      const requestPayload = {
        location: this.selectedLocation,
        ...(this.lastKnownLocation && {
          current_position: this.lastKnownLocation,
        }),
      };

      console.log("Sending route request with payload:", requestPayload);

      const response = await fetch("/api/driving-navigation/next-route", {
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
        if (notificationManager)
          notificationManager.show(data.message, "success");
      } else if (
        data.status === "success" &&
        data.route_geometry &&
        data.target_street
      ) {
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
        this.targetInfo.innerHTML = `<strong>Target:</strong> ${streetName} (ID: ${data.target_street.segment_id})`;

        const locationSource = data.location_source || "unknown";
        console.log(`Route calculated using '${locationSource}' location data`);

        this.setStatus(`Route calculated. Head towards ${streetName}.`);

        const durationMinutes = Math.round(data.route_duration_seconds / 60);
        const distanceMiles = (
          data.route_distance_meters * 0.000621371
        ).toFixed(1);

        this.routeInfo.innerHTML = `
          <div class="route-info-detail">
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
            <div class="text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
          </div>
        `;

        this.bringLiveElementsToFront();

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

          if (boundsToFit && boundsToFit.isValid()) {
            this.map.fitBounds(boundsToFit, { padding: [70, 70] });
          } else {
            console.warn("Could not determine valid bounds to fit the map.");
            if (data.target_street && data.target_street.start_coords) {
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
    this.statusMsg.textContent = message;
    this.statusMsg.classList.toggle("text-danger", isError);
    this.statusMsg.classList.toggle("text-info", !isError);
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
        const fullRouteLayer = L.layerGroup().addTo(this.routeLayer);
        let routeBounds = L.latLngBounds();

        const connectingRouteStyle = {
          color: "#76ff03",
          weight: 5,
          opacity: 0.8,
          className: "calculated-route",
        };

        const streetSegmentStyle = {
          color: "#007bff",
          weight: 6,
          opacity: 0.9,
          className: "coverage-street-segment",
        };

        if (data.route_geometry.type === "GeometryCollection") {
          data.route_geometry.geometries.forEach((geom, index) => {
            let style = {};
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
        const distanceMiles = (
          data.total_distance_meters * 0.000621371
        ).toFixed(1);
        const segmentCount = data.message.match(/\d+/)?.[0] || "?";

        this.setStatus(
          `Full coverage route calculated (${segmentCount} segments).`,
        );
        const locationSource = data.location_source || "unknown";
        this.routeInfo.innerHTML = `
          <div class="route-info-detail">
            <div><strong>Total Est:</strong></div>
            <div><i class="fas fa-clock"></i> ${durationMinutes} min</div>
            <div><i class="fas fa-road"></i> ${distanceMiles} mi</div>
            <div class="text-muted small">(Using ${this.formatLocationSource(locationSource)} position)</div>
          </div>
        `;
        this.targetInfo.innerHTML = "";

        this.bringLiveElementsToFront();
      } else {
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
      this.findBtn.disabled = false;
      this.isFetchingCoverageRoute = false;
    }
  }

  formatLocationSource(source) {
    switch (source) {
      case "client-provided":
        return "current live";
      case "live-tracking":
        return "current live";
      case "last-trip-end":
        return "last trip end";
      default:
        return source;
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
