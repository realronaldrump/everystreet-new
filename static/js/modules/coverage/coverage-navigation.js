/**
 * Coverage Navigation Module
 * Handles efficient street finding and navigation features
 */

/* global mapboxgl */

import COVERAGE_API from "./coverage-api.js";

class CoverageNavigation {
  constructor(coverageMap, notificationManager) {
    this.coverageMap = coverageMap;
    this.notificationManager = notificationManager;
    this.efficientStreetMarkers = [];
    this.suggestedEfficientStreets = [];
  }

  /**
   * Find most efficient streets
   */
  async findMostEfficientStreets(locationId) {
    if (!locationId) {
      this.notificationManager.show(
        "Please select a coverage area first.",
        "warning",
      );
      return;
    }

    let currentLat = null;
    let currentLon = null;
    let positionSource = "unknown";

    try {
      const position = await this.getCurrentPosition();
      currentLat = position.coords.latitude;
      currentLon = position.coords.longitude;
      positionSource = "browser";
    } catch {
      try {
        const activeTripResponse = await fetch("/api/trip/active");
        if (activeTripResponse.ok) {
          const activeTripData = await activeTripResponse.json();
          if (
            activeTripData.trip?.coordinates &&
            activeTripData.trip.coordinates.length > 0
          ) {
            const lastCoord =
              activeTripData.trip.coordinates[
                activeTripData.trip.coordinates.length - 1
              ];
            currentLat = lastCoord.lat;
            currentLon = lastCoord.lon;
            positionSource = "active-trip";
          }
        }
      } catch {
        try {
          const lastTripResponse = await fetch("/api/trips?limit=1");
          if (lastTripResponse.ok) {
            const tripsData = await lastTripResponse.json();
            if (tripsData.trips?.length > 0) {
              const lastTrip = tripsData.trips[0];
              if (lastTrip.destinationGeoPoint?.coordinates) {
                currentLon = lastTrip.destinationGeoPoint.coordinates[0];
                currentLat = lastTrip.destinationGeoPoint.coordinates[1];
                positionSource = "last-trip";
              }
            }
          }
        } catch {
          this.notificationManager.show(
            "Unable to determine current position. Please enable location services or start a trip.",
            "warning",
          );
          return;
        }
      }
    }

    if (currentLat === undefined || currentLon === undefined) {
      this.notificationManager.show(
        "Unable to determine current position. Please enable location services or start/complete a trip.",
        "warning",
      );
      return;
    }

    const btn = document.getElementById("find-efficient-street-btn");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Finding...';
    }

    try {
      const data = await COVERAGE_API.getEfficientStreets(
        locationId,
        currentLat,
        currentLon,
        3,
      );

      if (
        data.status === "no_streets" ||
        data.status === "no_valid_streets" ||
        data.status === "no_clusters"
      ) {
        this.notificationManager.show(data.message, "info");
        this.clearEfficientStreetMarkers();
        return;
      }

      if (
        data.status === "success" &&
        data.suggested_clusters &&
        data.suggested_clusters.length > 0
      ) {
        this.suggestedEfficientStreets = data.suggested_clusters;
        this.displayEfficientStreets(data.suggested_clusters, positionSource);

        const topCluster = data.suggested_clusters[0];
        const distanceMiles = (
          topCluster.distance_to_cluster_m / 1609.34
        ).toFixed(1);
        const lengthMiles = (topCluster.total_length_m / 1609.34).toFixed(2);
        const startingStreetName = topCluster.nearest_segment.street_name;

        this.notificationManager.show(
          `Found ${data.suggested_clusters.length} efficient street clusters. ` +
            `Top cluster (starts with ${startingStreetName}): ${distanceMiles} mi away, ${lengthMiles} mi total length.`,
          "success",
          7000,
        );
      } else {
        this.notificationManager.show(
          "No efficient street clusters found matching criteria.",
          "info",
        );
        this.clearEfficientStreetMarkers();
      }
    } catch (error) {
      console.error("Error finding efficient streets:", error);
      this.notificationManager.show(
        `Error finding efficient streets: ${error.message}`,
        "danger",
      );
      this.clearEfficientStreetMarkers();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          '<i class="fas fa-bullseye me-2"></i>Find Most Efficient Streets';
      }
    }
  }

  /**
   * Get current position
   */
  async getCurrentPosition() {
    this.lastGeolocationRequest = Date.now();
    const geolocationService = (await import("../geolocation-service.js"))
      .default;
    return geolocationService.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  }

  /**
   * Display efficient streets
   */
  displayEfficientStreets(clusters, positionSource) {
    if (!this.coverageMap?.map || !this.coverageMap.map.isStyleLoaded()) return;

    this.clearEfficientStreetMarkers(false);

    this.suggestedEfficientStreets = clusters;

    const colors = ["#ffd700", "#c0c0c0", "#cd7f32"];
    const defaultClusterColor = "#9467bd";

    clusters.forEach((cluster, index) => {
      const rank = index + 1;
      const markerColor = colors[index] || defaultClusterColor;

      if (
        cluster.segments &&
        Array.isArray(cluster.segments) &&
        this.coverageMap.map.getSource("streets")
      ) {
        cluster.segments.forEach((segment) => {
          const segmentId =
            segment.segment_id || segment.properties?.segment_id;
          if (segmentId) {
            this.coverageMap.map.setFeatureState(
              { source: "streets", id: segmentId },
              { efficientRank: rank },
            );
          }
        });
      }

      if (cluster.nearest_segment?.start_coords) {
        const startPoint = cluster.nearest_segment.start_coords;
        const el = document.createElement("div");
        el.className = "efficient-street-marker-mapbox";
        el.innerHTML = `
          <div style="background-color: ${markerColor}; border: 2px solid white; 
               border-radius: 50%; width: 30px; height: 30px; display: flex; 
               align-items: center; justify-content: center; font-weight: bold; 
               color: ${index === 0 ? "black" : "white"}; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
            ${rank}
          </div>
        `;

        const marker = new mapboxgl.Marker(el)
          .setLngLat(startPoint)
          .setPopup(this.createEfficientStreetPopup(cluster, index))
          .addTo(this.coverageMap.map);

        this.efficientStreetMarkers.push(marker);
      }
    });

    this.showEfficientStreetsPanel(clusters, positionSource);

    const bounds = new mapboxgl.LngLatBounds();
    clusters.forEach((cluster) => {
      if (Array.isArray(cluster?.segments)) {
        cluster.segments.forEach((segment) => {
          if (
            segment.geometry &&
            segment.geometry.type === "LineString" &&
            segment.geometry.coordinates
          ) {
            segment.geometry.coordinates.forEach((coord) => {
              bounds.extend(coord);
            });
          } else if (
            segment.geometry &&
            segment.geometry.type === "MultiLineString" &&
            segment.geometry.coordinates
          ) {
            segment.geometry.coordinates.forEach((line) => {
              line.forEach((coord) => {
                bounds.extend(coord);
              });
            });
          }
        });
      } else if (cluster.nearest_segment?.start_coords) {
        bounds.extend(cluster.nearest_segment.start_coords);
      }
    });

    if (!bounds.isEmpty()) {
      this.coverageMap.map.fitBounds(bounds, {
        padding: { top: 100, bottom: 50, left: 50, right: 400 },
        maxZoom: 17,
      });
    }
  }

  /**
   * Create efficient street popup
   */
  createEfficientStreetPopup(cluster, rank) {
    const nearestSegment = cluster.nearest_segment;
    const streetName = nearestSegment.street_name || "Unnamed Street";

    const totalLengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
    const distanceToClusterMiles = (
      cluster.distance_to_cluster_m / 1609.34
    ).toFixed(1);
    const efficiencyScore = cluster.efficiency_score.toFixed(2);
    const segmentCount = cluster.segment_count;

    const popup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "320px",
    });

    const content = `
      <div class="efficient-street-popup p-3">
        <h6 class="mb-2 fw-bold text-primary">#${rank + 1} Efficient Cluster</h6>
        <div class="mb-1"><strong>Starts with:</strong> ${streetName}</div>
        <div class="small text-muted mb-2">Cluster ID: ${cluster.cluster_id.substring(
          0,
          8,
        )}...</div>
        
        <div class="efficiency-metrics small">
          <div><i class="fas fa-ruler text-info me-1"></i> Total Length: ${totalLengthMiles} mi</div>
          <div><i class="fas fa-road text-info me-1"></i> Segments: ${segmentCount}</div>
          <div><i class="fas fa-location-arrow text-warning me-1"></i> Approx. Distance: ${distanceToClusterMiles} mi</div>
          <div><i class="fas fa-chart-line text-success me-1"></i> Efficiency Score: ${efficiencyScore}</div>
        </div>
        
        <hr class="my-2">
        <div class="text-center">
          <button class="btn btn-sm btn-outline-light copy-segment-id-btn" data-segment-id="${
            nearestSegment.segment_id
          }" title="Copy ID of starting segment">
            <i class="fas fa-copy me-1"></i> Copy Start Segment ID
          </button>
        </div>
      </div>
    `;

    popup.setHTML(content);

    popup.on("open", () => {
      const copyButton = popup
        .getElement()
        .querySelector(".copy-segment-id-btn");
      if (copyButton) {
        copyButton.addEventListener("click", (e) => {
          e.stopPropagation();
          const { segmentId } = e.target.dataset;
          navigator.clipboard.writeText(segmentId).then(() => {
            this.notificationManager.show(
              "Segment ID copied to clipboard",
              "success",
              2000,
            );
          });
        });
      }
    });

    return popup;
  }

  /**
   * Show efficient streets panel
   */
  showEfficientStreetsPanel(clusters, positionSource) {
    let panel = document.getElementById("efficient-streets-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "efficient-streets-panel";
      panel.className = "efficient-streets-panel-overlay";
      const dashboard =
        document.getElementById("coverage-dashboard") || document.body;
      dashboard.appendChild(panel);
    }

    let html = `
      <div class="card bg-dark text-white">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="fas fa-bullseye me-2"></i>Most Efficient Street Clusters
          </h6>
          <button type="button" class="btn-close btn-close-white" 
                  onclick="document.getElementById('efficient-streets-panel').remove(); document.dispatchEvent(new CustomEvent('coverageClearEfficientMarkers'));">
          </button>
        </div>
        <div class="card-body" style="max-height: 300px; overflow-y: auto;">
          <small class="text-muted d-block mb-2">Position source: ${positionSource}</small>
    `;

    clusters.forEach((cluster, index) => {
      const nearestSegment = cluster.nearest_segment;
      const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(
        1,
      );
      const totalLengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
      const score = cluster.efficiency_score.toFixed(2);
      const colors = ["#ffd700", "#c0c0c0", "#cd7f32"];
      const borderColor = colors[index] || "#9467bd";

      html += `
        <div class="efficient-street-item mb-2 p-2" style="border-left: 4px solid ${borderColor};">
          <div class="d-flex justify-content-between align-items-start">
            <div class="flex-grow-1">
              <div class="d-flex align-items-center mb-1">
                <span class="badge bg-secondary me-2">#${index + 1}</span>
                <strong>Starts with: ${nearestSegment.street_name}</strong>
              </div>
              <div class="small">
                <span class="me-3" title="Total length of segments in cluster"><i class="fas fa-ruler"></i> ${totalLengthMiles} mi (${
                  cluster.segment_count
                } segs)</span>
                <span class="me-3" title="Approx. distance to cluster centroid"><i class="fas fa-location-arrow"></i> ${distanceMiles} mi</span>
                <span title="Efficiency score"><i class="fas fa-chart-line"></i> Score: ${score}</span>
              </div>
            </div>
            <button class="btn btn-sm btn-outline-light focus-street-btn" 
                    title="Focus map on start of this cluster"
                    data-coords="${nearestSegment.start_coords.join(",")}"
                    data-segment-id="${nearestSegment.segment_id}">
              <i class="fas fa-crosshairs"></i>
            </button>
          </div>
        </div>
      `;
    });

    html += `
          <div class="mt-3 text-muted small">
            <i class="fas fa-info-circle"></i> Higher score = longer, more compact cluster, closer to you.
          </div>
        </div>
      </div>
    `;

    panel.innerHTML = html;

    panel.querySelectorAll(".focus-street-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const coords = btn.dataset.coords.split(",").map(Number);
        if (this.coverageMap?.map) {
          this.coverageMap.map.flyTo({ center: coords, zoom: 17 });
        }
      });
    });
  }

  /**
   * Clear efficient street markers
   */
  clearEfficientStreetMarkers(removePanel = true) {
    this.efficientStreetMarkers.forEach((marker) => {
      marker.remove();
    });
    this.efficientStreetMarkers = [];

    if (
      this.coverageMap?.map &&
      this.suggestedEfficientStreets &&
      this.coverageMap.map.getSource("streets")
    ) {
      this.suggestedEfficientStreets.forEach((cluster) => {
        if (Array.isArray(cluster?.segments)) {
          cluster.segments.forEach((segment) => {
            const segmentId =
              segment.segment_id || segment.properties?.segment_id;
            if (segmentId && this.coverageMap.map.getSource("streets")) {
              try {
                this.coverageMap.map.removeFeatureState(
                  { source: "streets", id: segmentId },
                  "efficientRank",
                );
              } catch {
                // Silently ignore feature state removal errors
              }
            }
          });
        }
      });
    }

    this.suggestedEfficientStreets = [];

    if (removePanel) {
      const panel = document.getElementById("efficient-streets-panel");
      if (panel) panel.remove();
    }
  }

  // =========================================================================
  // Optimal Route Generation Methods
  // =========================================================================

  /**
   * Generate optimal completion route for the current coverage area
   */
  async generateOptimalRoute(locationId) {
    if (!locationId) {
      this.notificationManager.show(
        "Please select a coverage area first.",
        "warning",
      );
      return;
    }

    const btn = document.getElementById("generate-optimal-route-btn");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-1"></i>Generating...';
    }

    try {
      // Start the route generation task
      const response = await COVERAGE_API.generateOptimalRoute(locationId);
      const taskId = response.task_id;

      this.notificationManager.show(
        "Route generation started. This may take a few minutes...",
        "info",
        5000,
      );

      // Poll for completion
      const result = await this.pollTaskCompletion(taskId);

      if (result.status === "COMPLETED" || result.status === "SUCCESS") {
        // Fetch and display the generated route
        await this.displayOptimalRoute(locationId);
        this.notificationManager.show(
          "Optimal route generated successfully!",
          "success",
        );
      } else if (result.status === "FAILED") {
        throw new Error(result.error || "Route generation failed");
      }
    } catch (error) {
      console.error("Error generating optimal route:", error);
      this.notificationManager.show(
        `Error generating route: ${error.message}`,
        "danger",
      );
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-route me-1"></i>Optimal Route';
      }
    }
  }

  /**
   * Poll for task completion
   */
  async pollTaskCompletion(taskId, maxAttempts = 120, intervalMs = 2000) {
    this.lastPolledTaskId = taskId;
    this.lastPollIntervalMs = intervalMs;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await COVERAGE_API.getTaskStatus(taskId);

        if (status.status === "COMPLETED" || status.status === "SUCCESS") {
          return status;
        }

        if (status.status === "FAILED") {
          return status;
        }

        // Still running, wait and try again
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      } catch (error) {
        console.warn("Error polling task status:", error);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    throw new Error("Task timed out");
  }

  /**
   * Display the optimal route on the map
   */
  async displayOptimalRoute(locationId) {
    if (!this.coverageMap?.map) return;

    try {
      const route = await COVERAGE_API.getOptimalRoute(locationId);

      if (!route || !route.coordinates || route.coordinates.length === 0) {
        this.notificationManager.show("No route data available.", "warning");
        return;
      }

      // Store location ID for later use (GPX export, etc.)
      this.currentOptimalRouteLocationId = locationId;

      // Create GeoJSON for the route
      const geojson = {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: route.coordinates,
        },
        properties: {
          total_distance_m: route.total_distance_m,
          deadhead_distance_m: route.deadhead_distance_m,
          deadhead_percentage: route.deadhead_percentage,
        },
      };

      // Add or update the route source and layer
      const { map } = this.coverageMap;

      if (map.getSource("optimal-route")) {
        map.getSource("optimal-route").setData(geojson);
      } else {
        map.addSource("optimal-route", { type: "geojson", data: geojson });

        map.addLayer({
          id: "optimal-route-layer",
          type: "line",
          source: "optimal-route",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": "#9333ea",
            "line-width": 5,
            "line-opacity": 0.85,
          },
        });

        // Add directional arrows
        map.addLayer({
          id: "optimal-route-arrows",
          type: "symbol",
          source: "optimal-route",
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 100,
            "icon-image": "arrow-right",
            "icon-size": 0.6,
            "icon-allow-overlap": true,
          },
          paint: {
            "icon-opacity": 0.7,
          },
        });
      }

      // Show stats panel
      this.showOptimalRoutePanel(route);

      // Fit map to route bounds
      const bounds = new mapboxgl.LngLatBounds();
      for (const coord of route.coordinates) {
        bounds.extend(coord);
      }

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          padding: { top: 80, bottom: 50, left: 50, right: 350 },
          maxZoom: 16,
        });
      }
    } catch (error) {
      console.error("Error displaying optimal route:", error);
      if (error.message.includes("404")) {
        // No route available yet
        this.notificationManager.show(
          "No optimal route available. Generate one first.",
          "info",
        );
      } else {
        this.notificationManager.show(
          `Error loading route: ${error.message}`,
          "danger",
        );
      }
    }
  }

  /**
   * Show optimal route stats panel
   */
  showOptimalRoutePanel(route) {
    let panel = document.getElementById("optimal-route-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "optimal-route-panel";
      panel.className = "optimal-route-panel-overlay";
      const dashboard =
        document.getElementById("coverage-dashboard") || document.body;
      dashboard.appendChild(panel);
    }

    const totalMi = (route.total_distance_m / 1609.34).toFixed(2);
    const requiredMi = ((route.required_distance_m || 0) / 1609.34).toFixed(2);
    const deadheadMi = (route.deadhead_distance_m / 1609.34).toFixed(2);
    const deadheadPct = route.deadhead_percentage.toFixed(1);

    const html = `
      <div class="card bg-dark text-white">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="fas fa-route me-2" style="color: #9333ea;"></i>Optimal Completion Route
          </h6>
          <button type="button" class="btn-close btn-close-white" 
                  onclick="document.getElementById('optimal-route-panel').remove(); document.dispatchEvent(new CustomEvent('coverageClearOptimalRoute'));">
          </button>
        </div>
        <div class="card-body">
          <div class="row g-2 mb-3">
            <div class="col-6">
              <div class="stat-box p-2 rounded" style="background: rgba(147, 51, 234, 0.2);">
                <div class="small text-muted">Total Route</div>
                <div class="fw-bold">${totalMi} mi</div>
              </div>
            </div>
            <div class="col-6">
              <div class="stat-box p-2 rounded" style="background: rgba(234, 179, 8, 0.2);">
                <div class="small text-muted">Deadhead</div>
                <div class="fw-bold">${deadheadMi} mi <span class="text-warning">(${deadheadPct}%)</span></div>
              </div>
            </div>
          </div>
          
          <div class="small text-muted mb-3">
            <i class="fas fa-info-circle me-1"></i>
            Streets to cover: ${requiredMi} mi. Lower deadhead = more efficient route.
          </div>
          
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-outline-light flex-grow-1" id="export-gpx-btn">
              <i class="fas fa-download me-1"></i>Export GPX
            </button>
            <button class="btn btn-sm btn-outline-danger" id="clear-optimal-route-btn">
              <i class="fas fa-times me-1"></i>Clear
            </button>
          </div>
        </div>
      </div>
    `;

    panel.innerHTML = html;

    // Attach event listeners
    panel.querySelector("#export-gpx-btn")?.addEventListener("click", () => {
      this.exportOptimalRouteGpx();
    });

    panel
      .querySelector("#clear-optimal-route-btn")
      ?.addEventListener("click", () => {
        this.clearOptimalRoute();
      });
  }

  /**
   * Export optimal route as GPX
   */
  exportOptimalRouteGpx() {
    if (!this.currentOptimalRouteLocationId) {
      this.notificationManager.show("No route to export.", "warning");
      return;
    }

    const url = COVERAGE_API.getOptimalRouteGpxUrl(
      this.currentOptimalRouteLocationId,
    );
    window.open(url, "_blank");
  }

  /**
   * Clear optimal route from map
   */
  clearOptimalRoute() {
    if (!this.coverageMap?.map) return;

    const { map } = this.coverageMap;

    // Remove layers
    if (map.getLayer("optimal-route-arrows")) {
      map.removeLayer("optimal-route-arrows");
    }
    if (map.getLayer("optimal-route-layer")) {
      map.removeLayer("optimal-route-layer");
    }

    // Remove source
    if (map.getSource("optimal-route")) {
      map.removeSource("optimal-route");
    }

    // Remove panel
    const panel = document.getElementById("optimal-route-panel");
    if (panel) panel.remove();

    this.currentOptimalRouteLocationId = null;
  }

  /**
   * Load existing optimal route if available
   */
  async loadExistingOptimalRoute(locationId) {
    try {
      const route = await COVERAGE_API.getOptimalRoute(locationId);
      if (route?.coordinates && route.coordinates.length > 0) {
        this.currentOptimalRouteLocationId = locationId;
        await this.displayOptimalRoute(locationId);
      }
    } catch {
      // No existing route, which is fine
    }
  }
}

export default CoverageNavigation;
