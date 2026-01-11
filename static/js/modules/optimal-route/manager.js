import { OptimalRouteAPI } from "./api.js";
import { OPTIMAL_ROUTES_DEFAULTS } from "./constants.js";
import { OptimalRouteMap } from "./map.js";
import { OptimalRouteUI } from "./ui.js";

export class OptimalRoutesManager {
  constructor(options = {}) {
    const globalConfig = window.coverageNavigatorConfig?.optimalRoutes || {};
    this.config = {
      ...OPTIMAL_ROUTES_DEFAULTS,
      ...globalConfig,
      ...options,
    };

    this.selectedAreaId = null;
    this.currentTaskId = null;

    // Initialize modules
    this.ui = new OptimalRouteUI(this.config);
    this.api = new OptimalRouteAPI({
      onProgress: (data) => this.onProgress(data),
      onComplete: (data) => this.onGenerationComplete(data),
      onError: (error) => this.onError(error),
      onCancel: () => this.onCancelled(),
    });

    this.map = new OptimalRouteMap(this.config.mapContainerId, {
      useSharedMap: this.config.useSharedMap,
      addNavigationControl: this.config.addNavigationControl,
      onLayerReady: () => this.onMapLayersReady(),
    });

    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.map.initialize();
    await this.loadCoverageAreas();
  }

  setupEventListeners() {
    // Area selection
    this.ui.areaSelect?.addEventListener("change", (e) => {
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

    // Start turn-by-turn navigation
    this.ui.turnByTurnBtn?.addEventListener("click", () => {
      this.openTurnByTurn();
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

    // Cancel button
    document
      .getElementById("cancel-task-btn")
      ?.addEventListener("click", () => {
        this.cancelTask();
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
        this.map.toggleLayer(layers, e.target.checked);
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
        const label = slider
          .closest(".layer-opacity")
          .querySelector(".opacity-value");
        if (label) label.textContent = `${e.target.value}%`;

        this.map.setLayerOpacity(layers, opacity);
      });
    });

    // Ordering logic (basic moving)
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

  updateLayerOrder() {
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
      this.map.moveLayers(layers || []);
    });
  }

  async loadCoverageAreas() {
    try {
      const areas = await this.api.loadCoverageAreas();
      if (!areas) return;

      // Dispatch event
      document.dispatchEvent(
        new CustomEvent("coverageAreasLoaded", { detail: { areas } }),
      );

      this.ui.populateAreaSelect(areas);
      this.ui.updateSavedRoutes(areas, (areaId) => this.onAreaSelect(areaId));
    } catch {
      this.ui.showNotification("Failed to load coverage areas", "danger");
    }
  }

  async onAreaSelect(areaId) {
    this.selectedAreaId = areaId;
    this.ui.setTurnByTurnEnabled(false);

    if (!areaId) {
      const generateBtn = document.getElementById("generate-route-btn");
      if (generateBtn) generateBtn.disabled = true;
      document.getElementById("area-stats").style.display = "none";
      document.getElementById("map-legend").style.display = "none";
      this.clearRoute();
      this.map.clearStreets();
      return;
    }

    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) generateBtn.disabled = false;

    // Wait for map
    await this.map.bindMapLoad();

    this.ui.updateAreaStats(areaId);

    // Load streets
    try {
      const { drivenFeatures, undrivenFeatures } =
        await this.api.loadStreetNetwork(areaId);
      this.map.updateStreets(drivenFeatures, undrivenFeatures);
    } catch {
      // already logged in api
    }

    // Check for existing route
    try {
      const routeData = await this.api.loadExistingRoute(areaId);
      if (routeData?.coordinates) {
        this.map.displayRoute(routeData.coordinates, routeData);
        this.ui.showResults(routeData);
      }
    } catch {
      // ignore
    }

    // Check for active task
    const activeTask = await this.api.checkForActiveTask(areaId);
    if (activeTask) {
      this.currentTaskId = activeTask.task_id;

      let startTime = Date.now();
      if (activeTask.started_at) {
        startTime = new Date(activeTask.started_at).getTime();
      }

      this.ui.showProgressSection(startTime);

      this.ui.updateProgress({
        status: activeTask.status,
        stage: activeTask.stage,
        progress: activeTask.progress,
        message: activeTask.message || "Reconnecting to task...",
        metrics: activeTask.metrics,
      });

      this.api.connectSSE(activeTask.task_id);
      this.ui.showNotification(
        "Reconnected to in-progress route generation",
        "info",
      );
    }

    // Fly to area
    const bounds = await this.api.getAreaBounds(areaId);
    if (bounds) {
      this.map.flyToBounds(bounds);
      document.getElementById("map-legend").style.display = "block";
    }
  }

  onMapLayersReady() {
    // Re-apply current data if any?
    // Usually logic flows from selection, so this might just be a hook.
  }

  async generateRoute() {
    if (!this.selectedAreaId) return;

    this.ui.showProgressSection();

    try {
      // Check workers
      const workerStatus = await this.api.checkWorkerStatus();
      if (workerStatus.status === "no_workers") {
        this.ui.showNotification(
          "No workers available. Task will be queued.",
          "warning",
        );
      }

      const taskId = await this.api.generateRoute(this.selectedAreaId);
      this.currentTaskId = taskId;
      this.api.connectSSE(taskId);
    } catch (error) {
      this.ui.showError(error.message);
    }
  }

  onProgress(data) {
    this.ui.updateProgress(data);
  }

  async onGenerationComplete() {
    // Load the full route data now
    const routeData = await this.api.loadExistingRoute(this.selectedAreaId);
    if (routeData?.coordinates) {
      this.map.displayRoute(routeData.coordinates, routeData, true); // animate=true
      this.ui.showResults(routeData);
    } else {
      this.ui.showError("Route completed but failed to load data");
    }
  }

  onError(message) {
    this.ui.showError(message);
  }

  async cancelTask() {
    if (!this.currentTaskId) return;
    try {
      await this.api.cancelTask(this.currentTaskId);
      this.onCancelled();
    } catch {
      this.ui.showNotification("Failed to cancel task", "danger");
    }
  }

  onCancelled() {
    this.currentTaskId = null;
    this.ui.hideProgressSection();
    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) generateBtn.disabled = false;
    this.ui.showNotification("Task cancelled", "info");
  }

  async clearRoute() {
    this.map.clearRoute();
    document.getElementById("results-section").style.display = "none";
    document.getElementById("error-section").style.display = "none";
    this.ui.setTurnByTurnEnabled(false);

    if (this.selectedAreaId) {
      await this.api.clearRoute(this.selectedAreaId);
    }
  }

  openTurnByTurn() {
    if (!this.selectedAreaId) {
      this.ui.showNotification("Select a coverage area first.", "warning");
      return;
    }
    if (this.ui.turnByTurnBtn?.disabled) {
      this.ui.showNotification(
        "Generate a route before starting navigation.",
        "warning",
      );
      return;
    }
    window.localStorage.setItem("turnByTurnAreaId", this.selectedAreaId);
    window.location.href = `/turn-by-turn?areaId=${encodeURIComponent(
      this.selectedAreaId,
    )}`;
  }

  exportGPX() {
    if (!this.selectedAreaId) return;
    const url = `/api/coverage_areas/${this.selectedAreaId}/optimal-route/gpx`;
    window.open(url, "_blank");
  }
}
