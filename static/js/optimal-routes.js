/**
 * Optimal Routes Page - JavaScript Module
 * Handles route generation with real-time SSE progress updates
 */

class OptimalRoutesManager {
  constructor() {
    this.map = null;
    this.selectedAreaId = null;
    this.currentTaskId = null;
    this.eventSource = null;
    this.elapsedTimer = null;
    this.startTime = null;

    this.init();
  }

  async init() {
    await this.loadCoverageAreas();
    this.setupEventListeners();
    this.initializeMap();
  }

  setupEventListeners() {
    // Area selection
    document.getElementById("area-select")?.addEventListener("change", (e) => {
      this.onAreaSelect(e.target.value);
    });

    // Generate button
    document
      .getElementById("generate-route-btn")
      ?.addEventListener("click", () => {
        this.generateRoute();
      });

    // Export GPX
    document.getElementById("export-gpx-btn")?.addEventListener("click", () => {
      this.exportGPX();
    });

    // Clear route
    document
      .getElementById("clear-route-btn")
      ?.addEventListener("click", () => {
        this.clearRoute();
      });

    // Retry button
    document.getElementById("retry-btn")?.addEventListener("click", () => {
      this.generateRoute();
    });
  }

  initializeMap() {
    const container = document.getElementById("route-map");
    if (!container || !window.MAPBOX_ACCESS_TOKEN) return;

    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

    this.map = new mapboxgl.Map({
      container: "route-map",
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-98.5795, 39.8283], // Center of US
      zoom: 4,
    });

    this.map.addControl(new mapboxgl.NavigationControl(), "top-right");

    this.map.on("load", () => {
      // Add empty route source
      this.map.addSource("optimal-route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Route line layer
      this.map.addLayer({
        id: "optimal-route-line",
        type: "line",
        source: "optimal-route",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#9333ea",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });

      // Directional arrows
      this.map.addLayer({
        id: "optimal-route-arrows",
        type: "symbol",
        source: "optimal-route",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 100,
          "icon-image": "arrow",
          "icon-size": 0.5,
          "icon-allow-overlap": true,
        },
      });
    });
  }

  async loadCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");
      const data = await response.json();

      if (!data.success || !data.areas) {
        console.error("Failed to load coverage areas");
        return;
      }

      const select = document.getElementById("area-select");
      if (!select) return;

      // Clear existing options except placeholder
      select.innerHTML = '<option value="">Select a coverage area...</option>';

      // Add areas
      data.areas
        .filter((area) => area.coverage_percentage < 100) // Only incomplete areas
        .forEach((area) => {
          const option = document.createElement("option");
          option.value = area._id;
          const coverage = area.coverage_percentage?.toFixed(1) || 0;
          option.textContent = `${area.location?.display_name || "Unknown"} (${coverage}%)`;
          option.dataset.coverage = coverage;
          option.dataset.remaining = this.formatDistance(
            (area.total_length_m || 0) - (area.driven_length_m || 0),
          );
          select.appendChild(option);
        });

      // Also load any existing saved routes
      this.loadSavedRoutes(data.areas);
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.showNotification("Failed to load coverage areas", "danger");
    }
  }

  loadSavedRoutes(areas) {
    const historyContainer = document.getElementById("route-history");
    if (!historyContainer) return;

    const areasWithRoutes = areas.filter((a) => a.optimal_route);

    if (areasWithRoutes.length === 0) {
      historyContainer.innerHTML =
        '<div class="text-muted small">No saved routes yet.</div>';
      return;
    }

    historyContainer.innerHTML = areasWithRoutes
      .map((area) => {
        const route = area.optimal_route;
        const date = route.generated_at
          ? new Date(route.generated_at).toLocaleDateString()
          : "Unknown";
        return `
          <div class="route-history-item" data-area-id="${area._id}">
            <div>
              <div class="route-name">${area.location?.display_name || "Unknown"}</div>
              <div class="route-date">${date}</div>
            </div>
            <i class="fas fa-chevron-right text-muted"></i>
          </div>
        `;
      })
      .join("");

    // Add click handlers
    historyContainer.querySelectorAll(".route-history-item").forEach((item) => {
      item.addEventListener("click", () => {
        const areaId = item.dataset.areaId;
        document.getElementById("area-select").value = areaId;
        this.onAreaSelect(areaId);
        this.loadExistingRoute(areaId);
      });
    });
  }

  async onAreaSelect(areaId) {
    this.selectedAreaId = areaId;
    const generateBtn = document.getElementById("generate-route-btn");
    const areaStats = document.getElementById("area-stats");

    if (!areaId) {
      generateBtn.disabled = true;
      areaStats.style.display = "none";
      this.clearRoute();
      return;
    }

    // Enable generate button
    generateBtn.disabled = false;

    // Show area stats
    const selectedOption = document.querySelector(
      `#area-select option[value="${areaId}"]`,
    );
    if (selectedOption) {
      document.getElementById("area-coverage").textContent =
        `${selectedOption.dataset.coverage}%`;
      document.getElementById("area-remaining").textContent =
        selectedOption.dataset.remaining;
      areaStats.style.display = "block";
    }

    // Check for existing route
    await this.loadExistingRoute(areaId);

    // Fly to area bounds
    await this.flyToArea(areaId);
  }

  async loadExistingRoute(areaId) {
    try {
      const response = await fetch(
        `/api/coverage_areas/${areaId}/optimal-route`,
      );

      if (response.status === 404) {
        // No route yet
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to load route");
      }

      const data = await response.json();

      if (data.coordinates && data.coordinates.length > 0) {
        this.displayRoute(data.coordinates, data);
        this.showResults(data);
      }
    } catch (error) {
      console.error("Error loading existing route:", error);
    }
  }

  async flyToArea(areaId) {
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}`);
      const data = await response.json();

      if (!data.success || !data.coverage) return;

      const location = data.coverage.location;
      if (location?.boundingbox) {
        const [south, north, west, east] = location.boundingbox.map(parseFloat);
        this.map?.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 50, duration: 1000 },
        );
      }
    } catch (error) {
      console.error("Error flying to area:", error);
    }
  }

  async generateRoute() {
    if (!this.selectedAreaId) return;

    // Show progress section
    this.showProgressSection();

    try {
      // Start the generation task
      const response = await fetch(
        `/api/coverage_areas/${this.selectedAreaId}/generate-optimal-route`,
        { method: "POST" },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Failed to start route generation");
      }

      const data = await response.json();
      this.currentTaskId = data.task_id;

      // Connect to SSE for progress updates
      this.connectSSE(data.task_id);
    } catch (error) {
      console.error("Error generating route:", error);
      this.showError(error.message);
    }
  }

  connectSSE(taskId) {
    // Close existing connection
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = new EventSource(
      `/api/optimal-routes/${taskId}/progress/sse`,
    );

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.updateProgress(data);

        if (data.status === "completed") {
          this.eventSource.close();
          this.onGenerationComplete();
        } else if (data.status === "failed") {
          this.eventSource.close();
          this.showError(
            data.error || data.message || "Route generation failed",
          );
        }
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    this.eventSource.addEventListener("done", () => {
      this.eventSource.close();
    });

    this.eventSource.onerror = (error) => {
      console.error("SSE error:", error);
      this.eventSource.close();
      // Don't show error immediately - might just be the connection closing normally
    };
  }

  updateProgress(data) {
    // Update progress bar
    const progressBar = document.getElementById("progress-bar");
    if (progressBar) {
      progressBar.style.width = `${data.progress}%`;
    }

    // Update message
    const progressMessage = document.getElementById("progress-message");
    if (progressMessage) {
      progressMessage.textContent = data.message || "Processing...";
    }

    // Update stage indicators
    const stages = document.querySelectorAll(".progress-stages .stage");
    stages.forEach((stage) => {
      const stageNames = stage.dataset.stage.split(",");
      stage.classList.remove("active", "completed");

      if (stageNames.includes(data.stage)) {
        stage.classList.add("active");
      } else if (this.isStageComplete(data.stage, stageNames)) {
        stage.classList.add("completed");
      }
    });
  }

  isStageComplete(currentStage, stageNames) {
    const stageOrder = [
      "initializing",
      "loading_area",
      "loading_segments",
      "fetching_osm",
      "mapping_segments",
      "finding_odd_nodes",
      "computing_matching",
      "building_circuit",
      "converting_coords",
      "complete",
    ];

    const currentIndex = stageOrder.indexOf(currentStage);
    return stageNames.every((name) => stageOrder.indexOf(name) < currentIndex);
  }

  showProgressSection() {
    // Hide other sections
    document.getElementById("results-section").style.display = "none";
    document.getElementById("error-section").style.display = "none";

    // Show progress
    const progressSection = document.getElementById("progress-section");
    progressSection.style.display = "block";

    // Reset progress
    document.getElementById("progress-bar").style.width = "0%";
    document.getElementById("progress-message").textContent = "Initializing...";

    // Reset stages
    document.querySelectorAll(".progress-stages .stage").forEach((stage) => {
      stage.classList.remove("active", "completed");
    });

    // Start elapsed timer
    this.startTime = Date.now();
    this.updateElapsedTime();
    this.elapsedTimer = setInterval(() => this.updateElapsedTime(), 1000);

    // Disable generate button
    document.getElementById("generate-route-btn").disabled = true;
  }

  updateElapsedTime() {
    if (!this.startTime) return;

    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const elapsedValue = document.getElementById("elapsed-value");
    if (elapsedValue) {
      elapsedValue.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }
  }

  stopElapsedTimer() {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  async onGenerationComplete() {
    this.stopElapsedTimer();

    // Load the generated route
    await this.loadExistingRoute(this.selectedAreaId);

    // Hide progress, show results
    document.getElementById("progress-section").style.display = "none";
    document.getElementById("generate-route-btn").disabled = false;

    this.showNotification("Route generated successfully!", "success");
  }

  displayRoute(coordinates, stats) {
    if (!this.map || !coordinates || coordinates.length < 2) return;

    // Create GeoJSON line
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: coordinates,
          },
          properties: stats,
        },
      ],
    };

    // Update source
    const source = this.map.getSource("optimal-route");
    if (source) {
      source.setData(geojson);
    }

    // Show legend
    document.getElementById("map-legend").style.display = "block";

    // Fit bounds to route
    const bounds = coordinates.reduce(
      (bounds, coord) => bounds.extend(coord),
      new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]),
    );

    this.map.fitBounds(bounds, { padding: 50, duration: 1000 });
  }

  showResults(data) {
    // Update stats
    document.getElementById("stat-total-distance").textContent =
      this.formatDistance(data.total_distance_m);
    document.getElementById("stat-required-distance").textContent =
      this.formatDistance(data.required_distance_m);
    document.getElementById("stat-deadhead-distance").textContent =
      this.formatDistance(data.deadhead_distance_m);
    document.getElementById("stat-deadhead-percent").textContent = `${(
      100 - (data.deadhead_percentage || 0)
    ).toFixed(1)}%`;

    // Show results section
    document.getElementById("results-section").style.display = "block";
  }

  showError(message) {
    this.stopElapsedTimer();

    document.getElementById("progress-section").style.display = "none";
    document.getElementById("error-section").style.display = "block";
    document.getElementById("error-message").textContent = message;
    document.getElementById("generate-route-btn").disabled = false;
  }

  clearRoute() {
    // Clear map
    const source = this.map?.getSource("optimal-route");
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }

    // Hide sections
    document.getElementById("results-section").style.display = "none";
    document.getElementById("error-section").style.display = "none";
    document.getElementById("map-legend").style.display = "none";
  }

  exportGPX() {
    if (!this.selectedAreaId) return;

    const url = `/api/coverage_areas/${this.selectedAreaId}/optimal-route/gpx`;
    window.open(url, "_blank");
  }

  formatDistance(meters) {
    if (!meters && meters !== 0) return "--";

    const userUnits = localStorage.getItem("distanceUnits") || "miles";

    if (userUnits === "km") {
      return `${(meters / 1000).toFixed(2)} km`;
    } else {
      return `${(meters / 1609.344).toFixed(2)} mi`;
    }
  }

  showNotification(message, type = "info") {
    // Use the global notification manager if available
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      console.log(`[${type}] ${message}`);
    }
  }
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  window.optimalRoutesManager = new OptimalRoutesManager();
});
