/* global mapboxgl */
/**
 * Optimal Routes Page - JavaScript Module
 * Handles route generation with real-time SSE progress updates
 */

const OPTIMAL_ROUTES_DEFAULTS = {
  areaSelectId: "area-select",
  mapContainerId: "route-map",
  useSharedMap: false,
  addNavigationControl: true,
  populateAreaSelect: true,
};

const STAGE_COPY = {
  queued: {
    label: "Queued",
    message: "Standing by for a solver slot...",
  },
  waiting: {
    label: "Queued",
    message: "Standing by for a solver slot...",
  },
  initializing: {
    label: "Initializing",
    message: "Warming up the route engine...",
  },
  loading_area: {
    label: "Loading",
    message: "Locking onto your coverage area...",
  },
  loading_segments: {
    label: "Loading",
    message: "Gathering undriven segments...",
  },
  loading_graph: {
    label: "Network",
    message: "Loading the street network...",
  },
  fetching_osm: {
    label: "Network",
    message: "Fetching street network tiles...",
  },
  mapping_segments: {
    label: "Mapping",
    message: "Matching segments to real roads...",
  },
  connectivity_check: {
    label: "Linking",
    message: "Bridging gaps between clusters...",
  },
  routing: {
    label: "Routing",
    message: "Solving the best circuit...",
  },
  finalizing: {
    label: "Finalizing",
    message: "Finalizing route geometry...",
  },
  complete: {
    label: "Complete",
    message: "Route ready.",
  },
  error: {
    label: "Error",
    message: "Route solver hit an issue.",
  },
};

const SCANNER_STAGES = new Set([
  "initializing",
  "loading_area",
  "loading_segments",
  "loading_graph",
  "fetching_osm",
  "mapping_segments",
  "connectivity_check",
  "routing",
  "finalizing",
]);

class OptimalRoutesManager {
  constructor(options = {}) {
    const globalConfig = window.coverageNavigatorConfig?.optimalRoutes || {};
    this.config = {
      ...OPTIMAL_ROUTES_DEFAULTS,
      ...globalConfig,
      ...options,
    };

    this.map = null;
    this.mapLayersReady = false;
    this.mapReadyPromise = null;
    this.selectedAreaId = null;
    this.currentTaskId = null;
    this.eventSource = null;
    this.elapsedTimer = null;
    this.startTime = null;
    this.waitingCount = 0; // Track how long we've been waiting
    this.lastProgressTime = null; // Track last progress update
    this.coverageAreas = [];
    this.areaSelect = document.getElementById(this.config.areaSelectId);
    this.progressMessagePrimary = document.getElementById("progress-message-primary");
    this.progressMessageSecondary = document.getElementById("progress-message-secondary");
    this.hud = this.cacheHudElements();
    this.activityLog = [];
    this.lastActivityMessage = "";
    this.lastElapsedLabel = "0:00";
    this.currentStage = "initializing";
    this.currentMetrics = {};
    this.routeAnimationFrame = null;

    this.init();
  }

  async init() {
    await this.loadCoverageAreas();
    this.setupEventListeners();
    this.mapReadyPromise = this.initializeMap();
  }

  cacheHudElements() {
    return {
      container: document.getElementById("route-solver-hud"),
      scanner: document.getElementById("map-scanner-overlay"),
      stage: document.getElementById("hud-stage"),
      message: document.getElementById("hud-message"),
      submessage: document.getElementById("hud-submessage"),
      segments: document.getElementById("hud-segments"),
      matched: document.getElementById("hud-matched"),
      fallback: document.getElementById("hud-fallback"),
      elapsed: document.getElementById("hud-elapsed"),
      activity: document.getElementById("hud-activity"),
    };
  }

  setupEventListeners() {
    // Area selection
    this.areaSelect?.addEventListener("change", (e) => {
      this.onAreaSelect(e.target.value);
    });

    // Generate button
    document.getElementById("generate-route-btn")?.addEventListener("click", () => {
      this.generateRoute();
    });

    // Export GPX
    document.getElementById("export-gpx-btn")?.addEventListener("click", () => {
      this.exportGPX();
    });

    // Clear route
    document.getElementById("clear-route-btn")?.addEventListener("click", () => {
      this.clearRoute();
    });

    // Retry button
    document.getElementById("retry-btn")?.addEventListener("click", () => {
      this.generateRoute();
    });

    this.setupLayerControls();
  }

  setupLayerControls() {
    // Visibility
    const toggles = {
      "toggle-route-layer": ["optimal-route-line", "optimal-route-arrows"],
      "toggle-driven-layer": ["streets-driven-layer"],
      "toggle-undriven-layer": ["streets-undriven-layer"],
    };

    Object.entries(toggles).forEach(([id, layers]) => {
      document.getElementById(id)?.addEventListener("change", (e) => {
        this.toggleLayer(layers, e.target.checked);
      });
    });

    // Opacity
    const opacitySliders = {
      "opacity-route-layer": ["optimal-route-line", "optimal-route-arrows"],
      "opacity-driven-layer": ["streets-driven-layer"],
      "opacity-undriven-layer": ["streets-undriven-layer"],
    };

    Object.entries(opacitySliders).forEach(([id, layers]) => {
      const slider = document.getElementById(id);
      slider?.addEventListener("input", (e) => {
        const opacity = e.target.value / 100;
        // Update label
        const label = slider.closest(".layer-opacity").querySelector(".opacity-value");
        if (label) label.textContent = `${e.target.value}%`;

        this.setLayerOpacity(layers, opacity);
      });
    });

    // Ordering
    document.querySelectorAll(".layer-up").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const item = e.target.closest(".layer-item");
        if (item.previousElementSibling) {
          item.parentNode.insertBefore(item, item.previousElementSibling);
          this.updateLayerOrder();
        }
      });
    });

    document.querySelectorAll(".layer-down").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const item = e.target.closest(".layer-item");
        if (item.nextElementSibling) {
          item.parentNode.insertBefore(item.nextElementSibling, item);
          this.updateLayerOrder();
        }
      });
    });
  }

  toggleLayer(layerIds, isVisible) {
    if (!this.map || !this.mapLayersReady) return;
    layerIds.forEach((id) => {
      try {
        if (this.map.getLayer(id)) {
          this.map.setLayoutProperty(id, "visibility", isVisible ? "visible" : "none");
        }
      } catch (e) {
        console.warn(`Could not toggle layer ${id}:`, e.message);
      }
    });
  }

  setLayerOpacity(layerIds, opacity) {
    if (!this.map || !this.mapLayersReady) return;
    layerIds.forEach((id) => {
      try {
        const layer = this.map.getLayer(id);
        if (layer) {
          const layerType = layer.type;
          if (layerType === "symbol") {
            this.map.setPaintProperty(id, "icon-opacity", opacity);
            this.map.setPaintProperty(id, "text-opacity", opacity);
          } else if (layerType === "line") {
            this.map.setPaintProperty(id, "line-opacity", opacity);
          } else if (layerType === "fill") {
            this.map.setPaintProperty(id, "fill-opacity", opacity);
          }
        }
      } catch (e) {
        console.warn(`Could not set opacity for layer ${id}:`, e.message);
      }
    });
  }

  updateLayerOrder() {
    if (!this.map || !this.mapLayersReady) return;

    const items = Array.from(document.querySelectorAll(".layer-item"));
    const layerGroups = {
      route: ["optimal-route-line", "optimal-route-arrows"],
      driven: ["streets-driven-layer"],
      undriven: ["streets-undriven-layer"],
    };

    // Reverse: bottom of list = bottom of map stack
    items.reverse().forEach((item) => {
      const groupId = item.dataset.layerId;
      const layers = layerGroups[groupId];

      layers?.forEach((layerId) => {
        try {
          if (this.map.getLayer(layerId)) {
            this.map.moveLayer(layerId);
          }
        } catch (e) {
          console.warn(`Could not move layer ${layerId}:`, e.message);
        }
      });
    });
  }

  initializeMap() {
    if (this.config.useSharedMap && window.coverageMasterMap) {
      this.map = window.coverageMasterMap;
      return this.bindMapLoad();
    }

    const container = document.getElementById(this.config.mapContainerId);
    if (!container || !window.MAPBOX_ACCESS_TOKEN) return Promise.resolve();

    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

    this.map = new mapboxgl.Map({
      container: this.config.mapContainerId,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-98.5795, 39.8283], // Center of US
      zoom: 4,
    });

    if (this.config.addNavigationControl) {
      this.map.addControl(new mapboxgl.NavigationControl(), "top-right");
    }

    return this.bindMapLoad();
  }

  bindMapLoad() {
    if (!this.map) return Promise.resolve();
    return new Promise((resolve) => {
      const handleLoad = () => {
        // Add arrow image for route direction
        if (!this.map.hasImage("arrow")) {
          // Create a simple arrow icon using Canvas
          const width = 24;
          const height = 24;
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");

          // Draw arrow
          ctx.fillStyle = "#9333ea"; // Purple
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(width * 0.2, height * 0.8);
          ctx.lineTo(width * 0.5, height * 0.2);
          ctx.lineTo(width * 0.8, height * 0.8);
          ctx.stroke();
          ctx.fill();

          const imageData = ctx.getImageData(0, 0, width, height);
          this.map.addImage("arrow", imageData, { pixelRatio: 2 });
        }

        this.setupMapLayers();
        resolve();
      };
      if (typeof this.map.isStyleLoaded === "function" && this.map.isStyleLoaded()) {
        handleLoad();
      } else {
        this.map.on("load", handleLoad);
      }
    });
  }

  setupMapLayers() {
    if (!this.map || this.mapLayersReady) return;

    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    if (!this.map.getSource("streets-driven")) {
      this.map.addSource("streets-driven", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    if (!this.map.getSource("streets-undriven")) {
      this.map.addSource("streets-undriven", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    if (!this.map.getLayer("streets-driven-layer")) {
      this.map.addLayer({
        id: "streets-driven-layer",
        type: "line",
        source: "streets-driven",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#10b981",
          "line-width": 2,
          "line-opacity": 0.6,
        },
      });
    }

    if (!this.map.getLayer("streets-undriven-layer")) {
      this.map.addLayer({
        id: "streets-undriven-layer",
        type: "line",
        source: "streets-undriven",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#ef4444",
          "line-width": 2.5,
          "line-opacity": 0.8,
        },
      });

      // Add cursor interaction for undriven streets
      this.map.on("mouseenter", "streets-undriven-layer", () => {
        this.map.getCanvas().style.cursor = "pointer";
      });
      this.map.on("mouseleave", "streets-undriven-layer", () => {
        this.map.getCanvas().style.cursor = "";
      });
    }

    if (!this.map.getSource("optimal-route")) {
      this.map.addSource("optimal-route", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    if (!this.map.getLayer("optimal-route-line")) {
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
          "line-width": 5,
          "line-opacity": 0.9,
        },
      });
    }

    if (!this.map.getLayer("optimal-route-arrows")) {
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
    }

    this.mapLayersReady = true;
  }

  ensureMapLayers() {
    if (!this.map) return false;
    if (this.map.getSource("streets-driven")) return true;
    if (typeof this.map.isStyleLoaded === "function" && !this.map.isStyleLoaded()) {
      return false;
    }
    this.setupMapLayers();
    return !!this.map.getSource("streets-driven");
  }

  async loadStreetNetwork(areaId) {
    try {
      // Load streets for this area
      const response = await fetch(`/api/coverage_areas/${areaId}/streets`);
      if (!response.ok) {
        console.error("Failed to load streets");
        return;
      }

      const data = await response.json();
      // API returns GeoJSON FeatureCollection directly (type: "FeatureCollection", features: [...])
      if (!data.features || !Array.isArray(data.features)) {
        console.error("Invalid street data format", data);
        return;
      }

      // Separate driven and undriven streets
      const drivenFeatures = [];
      const undrivenFeatures = [];

      data.features.forEach((feature) => {
        if (feature.properties?.driven) {
          drivenFeatures.push(feature);
        } else if (!feature.properties?.undriveable) {
          undrivenFeatures.push(feature);
        }
      });

      if (!this.ensureMapLayers()) return;

      // Update map sources
      const drivenSource = this.map.getSource("streets-driven");
      const undrivenSource = this.map.getSource("streets-undriven");

      if (drivenSource) {
        drivenSource.setData({
          type: "FeatureCollection",
          features: drivenFeatures,
        });
      }

      if (undrivenSource) {
        undrivenSource.setData({
          type: "FeatureCollection",
          features: undrivenFeatures,
        });
      }

      console.log(
        `Loaded ${drivenFeatures.length} driven, ${undrivenFeatures.length} undriven streets`
      );
    } catch (error) {
      console.error("Error loading street network:", error);
    }
  }

  async loadCoverageAreas() {
    try {
      const areas =
        window.coverageNavigatorAreas ||
        (await (async () => {
          const response = await fetch("/api/coverage_areas");
          const data = await response.json();

          if (!data.success || !data.areas) {
            console.error("Failed to load coverage areas");
            return null;
          }
          window.coverageNavigatorAreas = data.areas;
          return data.areas;
        })());

      if (!areas) return;
      this.coverageAreas = areas;

      // Dispatch event so DrivingNavigation can sync with the loaded areas
      document.dispatchEvent(
        new CustomEvent("coverageAreasLoaded", { detail: { areas } })
      );

      if (this.areaSelect && this.config.populateAreaSelect) {
        // Clear existing options except placeholder
        this.areaSelect.innerHTML =
          '<option value="">Select a coverage area...</option>';

        areas.forEach((area) => {
          const option = document.createElement("option");
          option.value = String(area._id || area.id || "");
          const coverage = area.coverage_percentage?.toFixed(1) || 0;
          option.textContent = `${area.location?.display_name || "Unknown"} (${coverage}%)`;
          option.dataset.coverage = coverage;
          const totalLength = area.total_length || area.total_length_m || 0;
          const drivenLength = area.driven_length || area.driven_length_m || 0;
          option.dataset.remaining = this.formatDistance(totalLength - drivenLength);
          this.areaSelect.appendChild(option);
        });
      }

      // Also load any existing saved routes
      this.loadSavedRoutes(areas);
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
        const { areaId } = item.dataset;
        if (this.areaSelect) {
          this.areaSelect.value = areaId;
        }
        this.onAreaSelect(areaId);
        this.loadExistingRoute(areaId);
      });
    });
  }

  async onAreaSelect(areaId) {
    this.selectedAreaId = areaId;
    const generateBtn = document.getElementById("generate-route-btn");
    const areaStats = document.getElementById("area-stats");
    const mapLegend = document.getElementById("map-legend");

    if (!areaId) {
      if (generateBtn) generateBtn.disabled = true;
      if (areaStats) areaStats.style.display = "none";
      if (mapLegend) mapLegend.style.display = "none";
      this.clearRoute();
      this.clearStreetNetwork();
      return;
    }

    // Enable generate button
    if (generateBtn) generateBtn.disabled = false;

    if (this.mapReadyPromise) {
      await this.mapReadyPromise;
    }

    // Show area stats
    const selectedOption = this.areaSelect?.querySelector(`option[value="${areaId}"]`);
    if (selectedOption) {
      document.getElementById("area-coverage").textContent =
        `${selectedOption.dataset.coverage}%`;
      document.getElementById("area-remaining").textContent =
        selectedOption.dataset.remaining;
      areaStats.style.display = "block";
    }

    // Load street network for visualization
    await this.loadStreetNetwork(areaId);

    // Check for existing route
    await this.loadExistingRoute(areaId);

    // Check for active/in-progress route generation task (e.g., after page refresh)
    await this.checkForActiveTask(areaId);

    // Fly to area bounds and show legend
    await this.flyToArea(areaId);
    document.getElementById("map-legend").style.display = "block";
  }

  clearStreetNetwork() {
    const drivenSource = this.map?.getSource("streets-driven");
    const undrivenSource = this.map?.getSource("streets-undriven");

    if (drivenSource) {
      drivenSource.setData({ type: "FeatureCollection", features: [] });
    }
    if (undrivenSource) {
      undrivenSource.setData({ type: "FeatureCollection", features: [] });
    }
  }

  async loadExistingRoute(areaId, options = {}) {
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}/optimal-route`);

      if (response.status === 404) {
        // No route yet
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to load route");
      }

      const data = await response.json();

      if (data.coordinates && data.coordinates.length > 0) {
        this.displayRoute(data.coordinates, data, { animate: options.animate });
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

      const { location } = data.coverage;
      if (location?.boundingbox) {
        const [south, north, west, east] = location.boundingbox.map(parseFloat);
        this.map?.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 50, duration: 1000 }
        );
      }
    } catch (error) {
      console.error("Error flying to area:", error);
    }
  }

  async checkForActiveTask(areaId) {
    /**
     * Check if there's an active route generation task for this area.
     * This handles page refresh/navigation scenarios where a task is running
     * but the frontend lost the task_id.
     */
    try {
      const response = await fetch(`/api/coverage_areas/${areaId}/active-task`);
      if (!response.ok) return;

      const data = await response.json();

      if (data.active && data.task_id) {
        console.log("Found active task:", data.task_id, "stage:", data.stage);

        // Store task ID
        this.currentTaskId = data.task_id;

        // Show progress UI
        this.showProgressSection();

        // Pre-populate with current progress state
        this.updateProgress({
          status: data.status,
          stage: data.stage,
          progress: data.progress,
          message: data.message || "Reconnecting to task...",
          metrics: data.metrics,
        });

        // Connect to SSE for live updates
        this.connectSSE(data.task_id);

        this.showNotification("Reconnected to in-progress route generation", "info");
      }
    } catch (error) {
      // Silently fail - this is just a nice-to-have check
      console.debug("Could not check for active task:", error);
    }
  }

  async generateRoute() {
    if (!this.selectedAreaId) return;

    // Show progress section
    this.showProgressSection();

    try {
      // First, check if workers are available
      try {
        const workerCheck = await fetch("/api/optimal-routes/worker-status");
        const workerStatus = await workerCheck.json();

        if (workerStatus.status === "no_workers") {
          const meta = this.getStageMeta("queued");
          this.setStatusMessage(
            meta.message,
            "⚠️ No Celery workers detected. Task will be queued but may not be processed.",
            "queued",
            this.currentMetrics,
            meta.label
          );
          console.warn("No workers available:", workerStatus);
        } else if (workerStatus.status === "error") {
          console.warn("Worker status check failed:", workerStatus.message);
        } else {
          console.log("Worker status:", workerStatus);
        }
      } catch (workerError) {
        console.warn("Could not check worker status:", workerError);
      }

      // Start the generation task
      const response = await fetch(
        `/api/coverage_areas/${this.selectedAreaId}/generate-optimal-route`,
        { method: "POST" }
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

    // Reset waiting counter
    this.waitingCount = 0;
    this.lastProgressTime = Date.now();

    this.eventSource = new EventSource(`/api/optimal-routes/${taskId}/progress/sse`);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Track waiting state - both "queued" (task submitted) and "waiting" (no task doc yet)
        const isWaiting =
          data.stage === "waiting" ||
          data.stage === "queued" ||
          data.status === "pending" ||
          data.status === "queued";

        if (isWaiting) {
          this.waitingCount++;
          if (this.waitingCount <= 30) {
            data.message = `Task queued, waiting for worker to pick it up... (${this.waitingCount}s)`;
          } else if (this.waitingCount <= 59) {
            data.message =
              "Worker hasn't picked up task yet. Checking Celery worker status...";
          } else if (this.waitingCount <= 119) {
            data.message =
              "⚠️ Worker not responding after 60s. Is the Celery worker running on the mini PC?";
          } else {
            data.message =
              "❌ Worker appears to be offline. Please check that Celery is running: ssh mini-pc 'docker ps | grep celery'";
          }
        } else {
          // Got actual progress, reset waiting counter
          this.waitingCount = 0;
          this.lastProgressTime = Date.now();
        }

        this.updateProgress(data);

        // Check for completion (case-insensitive)
        const status = (data.status || "").toLowerCase();
        const stage = (data.stage || "").toLowerCase();

        if (status === "completed" || stage === "complete" || data.progress >= 100) {
          this.eventSource.close();
          this.onGenerationComplete();
        } else if (status === "failed") {
          this.eventSource.close();
          this.showError(data.error || data.message || "Route generation failed");
        }
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    this.eventSource.addEventListener("done", () => {
      this.eventSource.close();
    });

    this.eventSource.onerror = (error) => {
      console.error("SSE connection error:", error);
      this.eventSource.close();

      // If we never got past waiting, show a helpful error
      if (this.waitingCount > 0) {
        this.showError(
          "Connection lost while waiting for task. Ensure the Celery worker is running."
        );
      }
      // Otherwise it might just be normal connection close after completion
    };
  }

  updateProgress(data) {
    const stage = (data.stage || "initializing").toLowerCase();
    const rawMetrics = data.metrics || {};
    const metrics =
      Object.keys(rawMetrics).length > 0 ? rawMetrics : this.currentMetrics || {};
    this.currentStage = stage;
    this.currentMetrics = metrics;
    this.setHudActive(true);

    // Update progress bar
    const progressBar = document.getElementById("progress-bar");
    if (progressBar) {
      progressBar.style.width = `${data.progress}%`;
    }

    const { primary, secondary, label } = this.buildProgressMessages(stage, data.message);
    this.setStatusMessage(primary, secondary, stage, metrics, label);

    // Update stage indicators
    const stages = document.querySelectorAll(".progress-stages .stage");
    stages.forEach((stageEl) => {
      const stageNames = stageEl.dataset.stage
        .split(",")
        .map((name) => name.trim().toLowerCase());
      stageEl.classList.remove("active", "completed");

      if (stageNames.includes(stage)) {
        stageEl.classList.add("active");
      } else if (this.isStageComplete(stage, stageNames)) {
        stageEl.classList.add("completed");
      }
    });

    this.setScannerActive(SCANNER_STAGES.has(stage));
  }

  buildProgressMessages(stage, message) {
    const meta = this.getStageMeta(stage);
    const primary = meta.message || message || "Processing...";
    const secondary = message && message !== primary ? message : "";
    return { primary, secondary, label: meta.label || "Working" };
  }

  getStageMeta(stage) {
    return STAGE_COPY[stage] || { label: "Working", message: "Processing..." };
  }

  setStatusMessage(primary, secondary, stage, metrics, labelOverride) {
    if (stage) {
      this.currentStage = stage;
    }
    if (metrics) {
      this.currentMetrics = metrics;
    }
    this.updateProgressMessage(primary, secondary);
    this.updateHud(stage, primary, secondary, metrics, labelOverride);
    this.appendActivity(secondary || primary);
  }

  updateProgressMessage(primary, secondary = "") {
    if (this.progressMessagePrimary) {
      this.progressMessagePrimary.textContent = primary;
    }
    if (this.progressMessageSecondary) {
      this.progressMessageSecondary.textContent = secondary;
    }
  }

  updateHud(stage, primary, secondary, metrics, labelOverride) {
    if (!this.hud?.container) return;
    const meta = this.getStageMeta(stage);
    if (this.hud.stage) {
      this.hud.stage.textContent = labelOverride || meta.label || "Working";
    }
    if (this.hud.message) {
      this.hud.message.textContent = primary || meta.message || "Processing...";
    }
    if (this.hud.submessage) {
      this.hud.submessage.textContent = secondary || "";
    }
    this.updateHudMetrics(metrics || {});
  }

  updateHudMetrics(metrics = {}) {
    const hasMetrics = Object.keys(metrics).length > 0;
    const total = metrics.total_segments ?? metrics.segment_count ?? null;
    const processed = metrics.processed_segments ?? null;
    const osmMatched = metrics.osm_matched ?? null;
    const fallbackTotal = metrics.fallback_total ?? null;
    const fallbackMatched = metrics.fallback_matched ?? null;
    const mappedSegments =
      metrics.mapped_segments ??
      (Number(osmMatched || 0) + Number(fallbackMatched || 0));

    if (this.hud.segments) {
      this.hud.segments.textContent = hasMetrics
        ? this.formatMetricRatio(processed, total)
        : "--";
    }
    if (this.hud.matched) {
      this.hud.matched.textContent = hasMetrics
        ? total
          ? `${this.formatCount(mappedSegments)}/${this.formatCount(total)}`
          : this.formatCount(mappedSegments)
        : "--";
    }
    if (this.hud.fallback) {
      this.hud.fallback.textContent = hasMetrics
        ? fallbackTotal
          ? `${this.formatCount(fallbackMatched || 0)}/${this.formatCount(fallbackTotal)}`
          : fallbackMatched != null
            ? this.formatCount(fallbackMatched)
            : "--"
        : "--";
    }
  }

  formatMetricRatio(value, total) {
    if (
      typeof value !== "number" ||
      typeof total !== "number" ||
      total <= 0 ||
      value < 0
    ) {
      return "--";
    }
    return `${this.formatCount(value)}/${this.formatCount(total)}`;
  }

  formatCount(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return "--";
    return value.toLocaleString();
  }

  appendActivity(text) {
    if (!this.hud?.activity) return;
    if (!text || text === this.lastActivityMessage) return;

    const entry = {
      time: this.lastElapsedLabel || "0:00",
      text,
    };

    this.activityLog.push(entry);
    if (this.activityLog.length > 4) {
      this.activityLog.shift();
    }

    this.hud.activity.replaceChildren(
      ...this.activityLog.map((item) => {
        const row = document.createElement("div");
        row.className = "hud-activity-item";

        const time = document.createElement("span");
        time.className = "hud-activity-time";
        time.textContent = item.time;

        const message = document.createElement("span");
        message.className = "hud-activity-text";
        message.textContent = item.text;

        row.append(time, message);
        return row;
      })
    );

    this.lastActivityMessage = text;
  }

  setHudActive(isActive) {
    if (!this.hud?.container) return;
    this.hud.container.classList.toggle("active", isActive);
  }

  setScannerActive(isActive) {
    if (!this.hud?.scanner) return;
    this.hud.scanner.classList.toggle("active", isActive);
  }

  resetHud() {
    this.activityLog = [];
    this.lastActivityMessage = "";
    if (this.hud?.activity) {
      this.hud.activity.replaceChildren();
    }
    this.updateHudMetrics({});
  }

  isStageComplete(currentStage, stageNames) {
    const stageOrder = [
      "queued",
      "waiting",
      "initializing",
      "loading_area",
      "loading_segments",
      "loading_graph",
      "fetching_osm",
      "mapping_segments",
      "connectivity_check",
      "routing",
      "finalizing",
      "complete",
      "error",
    ];

    const currentIndex = stageOrder.indexOf(currentStage);
    if (currentIndex === -1) return false;
    return stageNames.every((name) => {
      const stageIndex = stageOrder.indexOf(name);
      return stageIndex !== -1 && stageIndex < currentIndex;
    });
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
    this.currentStage = "initializing";
    this.currentMetrics = {};
    this.resetHud();
    const { primary, secondary, label } = this.buildProgressMessages(
      "initializing",
      ""
    );
    this.setStatusMessage(primary, secondary, "initializing", {}, label);
    this.setHudActive(true);
    this.setScannerActive(true);

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
    const elapsedLabel = `${minutes}:${seconds.toString().padStart(2, "0")}`;

    const elapsedValue = document.getElementById("elapsed-value");
    if (elapsedValue) {
      elapsedValue.textContent = elapsedLabel;
    }
    if (this.hud?.elapsed) {
      this.hud.elapsed.textContent = elapsedLabel;
    }
    this.lastElapsedLabel = elapsedLabel;
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
    await this.loadExistingRoute(this.selectedAreaId, { animate: true });

    // Hide progress, show results
    document.getElementById("progress-section").style.display = "none";
    document.getElementById("generate-route-btn").disabled = false;
    this.setHudActive(false);
    this.setScannerActive(false);

    this.showNotification("Route generated successfully!", "success");
  }

  displayRoute(coordinates, stats, options = {}) {
    if (!this.map || !coordinates || coordinates.length < 2) return;
    if (!this.ensureMapLayers()) return;
    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }

    // Create GeoJSON line
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates,
          },
          properties: stats,
        },
      ],
    };

    // Update source
    const source = this.map.getSource("optimal-route");
    if (source) {
      if (options.animate) {
        source.setData({ type: "FeatureCollection", features: [] });
        this.animateRouteDrawing(geojson);
      } else {
        source.setData(geojson);
      }
    }

    // Show legend
    document.getElementById("map-legend").style.display = "block";

    // Fit bounds to route
    const bounds = coordinates.reduce(
      (bounds, coord) => bounds.extend(coord),
      new mapboxgl.LngLatBounds(coordinates[0], coordinates[0])
    );

    this.map.fitBounds(bounds, { padding: 50, duration: 1000 });
  }

  animateRouteDrawing(geojson) {
    const source = this.map?.getSource("optimal-route");
    const coordinates = geojson?.features?.[0]?.geometry?.coordinates;
    const properties = geojson?.features?.[0]?.properties || {};

    if (!source || !coordinates || coordinates.length < 2) {
      if (source) source.setData(geojson);
      return;
    }

    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }

    const total = coordinates.length;
    const step = Math.max(2, Math.round(total / 160));
    let index = 2;

    const drawFrame = () => {
      const slice = coordinates.slice(0, index);
      source.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: slice,
            },
            properties,
          },
        ],
      });

      if (index < total) {
        index = Math.min(total, index + step);
        this.routeAnimationFrame = requestAnimationFrame(drawFrame);
      } else {
        source.setData(geojson);
        this.routeAnimationFrame = null;
      }
    };

    this.routeAnimationFrame = requestAnimationFrame(drawFrame);
  }

  showResults(data) {
    // Update stats
    document.getElementById("stat-total-distance").textContent = this.formatDistance(
      data.total_distance_m
    );
    document.getElementById("stat-required-distance").textContent = this.formatDistance(
      data.required_distance_m
    );
    document.getElementById("stat-deadhead-distance").textContent = this.formatDistance(
      data.deadhead_distance_m
    );
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
    this.setHudActive(false);
    this.setScannerActive(false);
  }

  async clearRoute() {
    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }

    // Clear optimal route from map
    const source = this.map?.getSource("optimal-route");
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }

    // Hide route-related sections but NOT the legend if streets are still loaded
    const resultsSection = document.getElementById("results-section");
    const errorSection = document.getElementById("error-section");
    if (resultsSection) resultsSection.style.display = "none";
    if (errorSection) errorSection.style.display = "none";

    // Call backend to delete the route
    if (this.selectedAreaId) {
      try {
        await fetch(`/api/coverage_areas/${this.selectedAreaId}/optimal-route`, {
          method: "DELETE",
        });
        console.log("Route cleared from backend");
      } catch (error) {
        console.warn("Failed to clear route from backend:", error);
      }
    }

    // Don't hide legend here - it should stay visible if streets are loaded
    // Legend visibility is managed by onAreaSelect
  }

  exportGPX() {
    if (!this.selectedAreaId) return;

    const url = `/api/coverage_areas/${this.selectedAreaId}/optimal-route/gpx`;
    window.open(url, "_blank");
  }

  formatDistance(meters) {
    if (!meters && meters !== 0) return "--";
    return `${(meters / 1609.344).toFixed(2)} mi`;
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
