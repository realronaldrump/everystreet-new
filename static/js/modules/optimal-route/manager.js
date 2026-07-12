import { swupReady } from "../core/navigation.js";
import {
  clearCoverageRouteDraft,
  isDioramaDraftRequest,
  readCoverageRouteDraft,
} from "../features/coverage-diorama/draft.js";
import { buildLiveNavigationUrl } from "../live-navigation/live-navigation-api.js";
import confirmationDialog from "../ui/confirmation-dialog.js";
import { OptimalRouteAPI } from "./api.js";
import { OPTIMAL_ROUTES_DEFAULTS } from "./constants.js";
import { OptimalRouteMap } from "./map.js";
import { DriveSimulation } from "./simulation.js";
import { OptimalRouteUI } from "./ui.js";

export class OptimalRoutesManager {
  constructor(options = {}) {
    this.config = {
      ...OPTIMAL_ROUTES_DEFAULTS,
      ...options,
    };
    this.onCoverageAreasLoaded = options.onCoverageAreasLoaded || null;

    this.selectedAreaId = null;
    this.currentTaskId = null;
    this.currentRouteData = null;
    this.isClusterRoute = false;
    this.coverageAreas = [];
    this.lastSelectedAreaId = "";
    this.abortController = new AbortController();
    this.pendingDioramaDraft = this.readPendingDioramaDraft();

    // Initialize modules
    this.ui = new OptimalRouteUI(this.config);
    this.api = new OptimalRouteAPI({
      onProgress: (data) => this.onProgress(data),
      onComplete: (data) => this.onGenerationComplete(data),
      onError: (error) => this.onError(error),
      onCancel: () => this.onCancelled(),
    });

    this.map = new OptimalRouteMap(this.config.mapContainerId, {
      sharedMap: this.config.sharedMap,
      addNavigationControl: this.config.addNavigationControl,
      onLayerReady: () => this.onMapLayersReady(),
    });

    this.simulation = new DriveSimulation(this.map, {
      onStatsUpdate: (data) => this.onSimulationUpdate(data),
    });

    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.map.initialize();
    await this.loadCoverageAreas();
  }

  setupEventListeners() {
    const { signal } = this.abortController;
    // Area selection
    this.ui.areaSelect?.addEventListener(
      "change",
      (e) => {
        this.onAreaSelect(e.target.value);
      },
      signal ? { signal } : false
    );

    // Generate button
    document.getElementById("generate-route-btn")?.addEventListener(
      "click",
      () => {
        this.generateRoute();
      },
      signal ? { signal } : false
    );

    // Export GPX
    document.getElementById("export-gpx-btn")?.addEventListener(
      "click",
      () => {
        this.exportGPX();
      },
      signal ? { signal } : false
    );

    // Replay animation
    document.getElementById("replay-animation-btn")?.addEventListener(
      "click",
      () => {
        this.replayAnimation();
      },
      signal ? { signal } : false
    );

    // Start live navigation
    this.ui.liveNavigationBtn?.addEventListener(
      "click",
      () => {
        this.openLiveNavigation();
      },
      signal ? { signal } : false
    );

    // Delete saved route
    document.getElementById("delete-route-btn")?.addEventListener(
      "click",
      () => {
        this.deleteRoute();
      },
      signal ? { signal } : false
    );

    // Retry button
    document.getElementById("retry-btn")?.addEventListener(
      "click",
      () => {
        this.generateRoute();
      },
      signal ? { signal } : false
    );

    // Cancel button
    document.getElementById("cancel-task-btn")?.addEventListener(
      "click",
      () => {
        this.cancelTask();
      },
      signal ? { signal } : false
    );

    // Cluster route generation (dispatched from DrivingNavigation)
    document.addEventListener(
      "generateClusterRoute",
      (e) => {
        const { areaId, segmentIds } = e.detail || {};
        if (areaId && segmentIds?.length) {
          this.generateClusterRoute(areaId, segmentIds);
        }
      },
      signal ? { signal } : false
    );

    // Simulation toggle
    document.getElementById("sim-toggle-btn")?.addEventListener(
      "click",
      () => {
        this.toggleSimulation();
      },
      signal ? { signal } : false
    );

    // Simulation clear
    document.getElementById("sim-clear-btn")?.addEventListener(
      "click",
      () => {
        this.simulation.clearSelection();
        this.updateSimulationPanel(null);
      },
      signal ? { signal } : false
    );

    this.setupLayerControls();
  }

  setupLayerControls() {
    const { signal } = this.abortController;
    // Visibility
    const toggles = {
      "toggle-route-layer": ["optimal-route-line", "optimal-route-arrows"],
      "toggle-driven-layer": ["streets-driven-layer"],
      "toggle-undriven-layer": ["streets-undriven-layer"],
    };

    Object.entries(toggles).forEach(([id, layers]) => {
      document.getElementById(id)?.addEventListener(
        "change",
        (e) => {
          this.map.toggleLayer(layers, e.target.checked);
        },
        signal ? { signal } : false
      );
    });

    // Opacity
    const opacitySliders = {
      "opacity-route-layer": ["optimal-route-line", "optimal-route-arrows"],
      "opacity-driven-layer": ["streets-driven-layer"],
      "opacity-undriven-layer": ["streets-undriven-layer"],
    };

    Object.entries(opacitySliders).forEach(([id, layers]) => {
      const slider = document.getElementById(id);
      slider?.addEventListener(
        "input",
        (e) => {
          const opacity = e.target.value / 100;
          const label = slider
            .closest(".layer-opacity")
            .querySelector(".opacity-value");
          if (label) {
            label.textContent = `${e.target.value}%`;
          }

          this.map.setLayerOpacity(layers, opacity);
        },
        signal ? { signal } : false
      );
    });
  }

  isCoverageCalculationActive(status) {
    const normalized = String(status || "").toLowerCase();
    return ["initializing", "processing", "rebuilding"].includes(normalized);
  }

  getAreaStatus(areaId) {
    if (!areaId) {
      return "";
    }
    const targetId = String(areaId);
    const match = this.coverageAreas.find(
      (area) => String(area._id || area.id || "") === targetId
    );
    if (match) {
      return match.status || match.location?.status || "";
    }
    const options = this.ui.areaSelect?.options || [];
    for (const option of options) {
      if (option.value === targetId) {
        return option.dataset.status || "";
      }
    }
    return "";
  }

  restoreAreaSelection() {
    if (this.ui.areaSelect) {
      this.ui.areaSelect.value = this.lastSelectedAreaId || "";
    }
  }

  async loadCoverageAreas() {
    try {
      const areas = await this.api.loadCoverageAreas();
      if (!areas) {
        this.ui.showNotification(
          "Unable to load coverage areas. Please check your connection and try again.",
          "warning"
        );
        return;
      }

      // Show informational message if no areas exist yet
      if (areas.length === 0) {
        this.ui.showNotification(
          "No coverage areas found. Create one in Coverage Management to get started.",
          "info"
        );
      }

      this.coverageAreas = areas;

      if (typeof this.onCoverageAreasLoaded === "function") {
        this.onCoverageAreasLoaded(areas);
      }

      if (this.config.emitCoverageAreasLoaded !== false) {
        document.dispatchEvent(
          new CustomEvent("coverageAreasLoaded", { detail: { areas } })
        );
      }

      this.ui.populateAreaSelect(areas);
      this.ui.updateSavedRoutes(areas, (areaId) => this.onAreaSelect(areaId));
      await this.openPendingDioramaDraft();
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      this.ui.showNotification("Failed to load coverage areas", "danger");
    }
  }

  /**
   * Refresh coverage areas by clearing cache and reloading.
   * Useful after navigating back from coverage management.
   */
  async refreshCoverageAreas() {
    this.api.clearCoverageAreasCache();
    await this.loadCoverageAreas();
  }

  async onAreaSelect(areaId) {
    const nextAreaId = areaId ? String(areaId) : "";
    if (nextAreaId) {
      const status = this.getAreaStatus(nextAreaId);
      if (this.isCoverageCalculationActive(status)) {
        this.restoreAreaSelection();
        this.ui.showNotification(
          "Coverage calculation is in progress for that area. Please wait until it finishes.",
          "warning"
        );
        return;
      }
    }

    this.selectedAreaId = nextAreaId || null;
    this.lastSelectedAreaId = nextAreaId;
    this.ui.setLiveNavigationEnabled(false);
    this.simulation.deactivate();

    // Enable/disable simulation toggle based on area selection
    const simToggle = document.getElementById("sim-toggle-btn");
    if (simToggle) {
      simToggle.disabled = !nextAreaId;
    }

    if (!nextAreaId) {
      const generateBtn = document.getElementById("generate-route-btn");
      if (generateBtn) {
        generateBtn.disabled = true;
      }
      this.ui.updateAreaStats(null);
      this.ui.setGenerateState("idle");
      document.getElementById("map-legend").style.display = "none";
      this.clearRouteDisplay();
      this.map.clearStreets();
      return;
    }

    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = false;
    }

    const selectedArea = this.coverageAreas.find(
      (area) => String(area?._id || area?.id || "") === nextAreaId
    );
    this.clearRouteDisplay();
    this.ui.updateAreaStats(selectedArea || null);
    this.ui.setGenerateState(selectedArea?.has_optimal_route ? "done" : "ready");

    // Wait for map
    await this.map.bindMapLoad();

    // Load streets
    let undrivenFeatures = [];
    try {
      const streetNetwork = await this.api.loadStreetNetwork(nextAreaId);
      const { drivenFeatures, undrivenFeatures: loadedUndrivenFeatures } =
        streetNetwork;
      undrivenFeatures = loadedUndrivenFeatures;
      this.map.updateStreets(drivenFeatures, undrivenFeatures);
    } catch {
      // already logged in api
    }

    // Check for existing route only when metadata says one is saved.
    // This avoids expected 404 noise for areas that have never generated a route.
    if (selectedArea?.has_optimal_route) {
      try {
        const routeData = await this.api.loadExistingRoute(nextAreaId);
        if (routeData?.coordinates) {
          this.currentRouteData = routeData;
          this.map.displayRoute(routeData.coordinates, routeData);
          this.ui.showResults(routeData);
        }
      } catch {
        // ignore
      }
    }

    // Check for active task
    const activeTask = await this.api.checkForActiveTask(nextAreaId);
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
      this.ui.showNotification("Reconnected to in-progress route generation", "info");
    }

    // Fly to area
    const bounds = await this.api.getAreaBounds(nextAreaId);
    if (bounds) {
      this.map.flyToBounds(bounds);
      document.getElementById("map-legend").style.display = "block";
    }

    this.hydratePendingDioramaDraft(nextAreaId, undrivenFeatures);
  }

  readPendingDioramaDraft() {
    if (!isDioramaDraftRequest()) {
      return null;
    }
    try {
      return readCoverageRouteDraft(window.sessionStorage);
    } catch {
      return null;
    }
  }

  async openPendingDioramaDraft() {
    const draft = this.pendingDioramaDraft;
    if (!draft) {
      return;
    }
    const areaExists = this.coverageAreas.some(
      (area) => String(area?._id || area?.id || "") === draft.areaId
    );
    if (!areaExists) {
      this.ui.showNotification(
        "The Diorama route draft references an unavailable area.",
        "warning"
      );
      this.clearPendingDioramaDraft();
      return;
    }
    if (this.ui.areaSelect) {
      this.ui.areaSelect.value = draft.areaId;
    }
    await this.onAreaSelect(draft.areaId);
  }

  hydratePendingDioramaDraft(areaId, undrivenFeatures) {
    const draft = this.pendingDioramaDraft;
    if (!draft || String(areaId) !== draft.areaId) {
      return;
    }
    const requested = new Set(draft.segmentIds);
    const validFeatures = (undrivenFeatures || []).filter((feature) =>
      requested.has(String(feature?.properties?.segment_id || ""))
    );
    const selectedCount = this.simulation.hydrateSelection(areaId, validFeatures);
    const legend = document.getElementById("legend-simulated");
    if (legend) {
      legend.style.display = selectedCount > 0 ? "" : "none";
    }
    if (selectedCount > 0) {
      this.ui.showNotification(
        `Loaded ${selectedCount} street segment${selectedCount === 1 ? "" : "s"} from Coverage Diorama.`,
        "success"
      );
    } else {
      this.ui.showNotification(
        "None of the Diorama draft streets are currently available to plan.",
        "warning"
      );
    }
    this.clearPendingDioramaDraft();
  }

  clearPendingDioramaDraft() {
    this.pendingDioramaDraft = null;
    try {
      clearCoverageRouteDraft(window.sessionStorage);
    } catch {
      // Browser storage can be disabled; the in-memory draft is still cleared.
    }
  }

  onMapLayersReady() {
    // Re-apply current data if any?
    // Usually logic flows from selection, so this might just be a hook.
  }

  async generateRoute() {
    if (!this.selectedAreaId) {
      return;
    }

    this.ui.showProgressSection();

    try {
      // Check workers
      const workerStatus = await this.api.checkWorkerStatus();
      if (workerStatus.status === "no_workers") {
        this.ui.showNotification(
          "No workers available. Task will be queued.",
          "warning"
        );
      }

      const taskId = await this.api.generateRoute(this.selectedAreaId);
      this.currentTaskId = taskId;
      this.api.connectSSE(taskId);
    } catch (error) {
      this.onError(error.message);
    }
  }

  async generateClusterRoute(areaId, segmentIds) {
    this.isClusterRoute = true;
    this.ui.showProgressSection();

    try {
      const workerStatus = await this.api.checkWorkerStatus();
      if (workerStatus.status === "no_workers") {
        this.ui.showNotification(
          "No workers available. Task will be queued.",
          "warning"
        );
      }

      const taskId = await this.api.generateClusterRoute(areaId, segmentIds);
      this.currentTaskId = taskId;
      this.api.connectSSE(taskId);
    } catch (error) {
      this.isClusterRoute = false;
      this.onError(error.message);
    }
  }

  onProgress(data) {
    this.ui.updateProgress(data);
  }

  async onGenerationComplete(progressData = {}) {
    const taskId = this.currentTaskId;
    this.currentTaskId = null;
    const isCluster = this.isClusterRoute;
    this.isClusterRoute = false;

    let routeData = null;

    if (isCluster && taskId) {
      // Cluster routes are stored in the job result, not on the CoverageArea
      try {
        routeData = await this.api.loadTaskResult(taskId);
      } catch {
        // fall through to error
      }
    } else {
      routeData = await this.api.loadExistingRoute(this.selectedAreaId);
    }

    if (routeData?.coordinates) {
      if (!isCluster) {
        const selectedArea = this.coverageAreas.find(
          (area) => String(area?._id || area?.id || "") === String(this.selectedAreaId)
        );
        if (selectedArea) {
          selectedArea.has_optimal_route = true;
          selectedArea.optimal_route_generated_at =
            routeData.generated_at || routeData.created_at || new Date().toISOString();
        }
      }
      this.currentRouteData = routeData;
      this.map.displayRoute(routeData.coordinates, routeData, true); // animate=true
      this.ui.showResults(routeData);
      this.ui.updateSavedRoutes(this.coverageAreas, (areaId) =>
        this.onAreaSelect(areaId)
      );
    } else {
      this.ui.showError(
        progressData?.error ||
          progressData?.message ||
          "Route completed but failed to load route data"
      );
    }
  }

  onError(message) {
    this.currentTaskId = null;
    this.isClusterRoute = false;
    this.ui.showError(message);
    this.ui.hideReplayButton();
    const selectedArea = this.coverageAreas.find(
      (area) => String(area?._id || area?.id || "") === String(this.selectedAreaId)
    );
    this.ui.setGenerateState(selectedArea?.has_optimal_route ? "done" : "ready");
  }

  async cancelTask() {
    if (!this.currentTaskId) {
      return;
    }
    try {
      await this.api.cancelTask(this.currentTaskId);
      this.onCancelled();
    } catch {
      this.ui.showNotification("Failed to cancel task", "danger");
    }
  }

  onCancelled() {
    this.currentTaskId = null;
    this.isClusterRoute = false;
    this.ui.hideProgressSection();
    const generateBtn = document.getElementById("generate-route-btn");
    if (generateBtn) {
      generateBtn.disabled = false;
    }
    const selectedArea = this.coverageAreas.find(
      (area) => String(area?._id || area?.id || "") === String(this.selectedAreaId)
    );
    this.ui.setGenerateState(selectedArea?.has_optimal_route ? "done" : "ready");
    this.ui.showNotification("Task cancelled", "info");
  }

  clearRouteDisplay() {
    this.map.clearRoute();
    this.ui.hideProgressSection();
    const resultsSection = document.getElementById("results-section");
    const errorSection = document.getElementById("error-section");
    if (resultsSection) {
      resultsSection.style.display = "none";
    }
    if (errorSection) {
      errorSection.style.display = "none";
    }
    this.ui.setLiveNavigationEnabled(false);
    this.ui.hideReplayButton();
    this.currentRouteData = null;
  }

  async deleteRoute() {
    if (!this.selectedAreaId) {
      return;
    }

    const selectedArea = this.coverageAreas.find(
      (area) => String(area?._id || area?.id || "") === String(this.selectedAreaId)
    );
    const areaName =
      selectedArea?.display_name || selectedArea?.location?.display_name || "this area";
    const confirmed = await confirmationDialog.show({
      title: "Delete Saved Route",
      message: `Delete the saved optimal route for ${areaName}? This cannot be undone.`,
      confirmText: "Delete Route",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) {
      return;
    }

    try {
      await this.api.clearRoute(this.selectedAreaId);
      if (selectedArea) {
        selectedArea.has_optimal_route = false;
        selectedArea.optimal_route_generated_at = null;
      }
      this.clearRouteDisplay();
      this.ui.setGenerateState("ready");
      this.ui.updateSavedRoutes(this.coverageAreas, (areaId) =>
        this.onAreaSelect(areaId)
      );
      this.ui.showNotification("Saved route deleted", "info");
    } catch {
      this.ui.showNotification("Failed to delete saved route", "danger");
    }
  }

  openLiveNavigation() {
    if (!this.selectedAreaId) {
      this.ui.showNotification("Select a coverage area first.", "warning");
      return;
    }
    if (this.ui.liveNavigationBtn?.disabled) {
      this.ui.showNotification(
        "Generate a route before starting navigation.",
        "warning"
      );
      return;
    }
    window.localStorage.setItem("liveNavigationAreaId", this.selectedAreaId);
    const href = buildLiveNavigationUrl({ areaId: this.selectedAreaId });
    swupReady.then((swup) => {
      swup.navigate(href);
    });
  }

  exportGPX() {
    if (!this.selectedAreaId) {
      return;
    }
    const url = `/api/coverage/areas/${this.selectedAreaId}/optimal-route/gpx`;
    window.open(url, "_blank");
  }

  replayAnimation() {
    if (!this.currentRouteData?.coordinates) {
      return;
    }
    this.map.displayRoute(
      this.currentRouteData.coordinates,
      this.currentRouteData,
      true
    );
  }

  destroy() {
    try {
      this.abortController.abort();
    } catch {
      // Ignore abort errors.
    }
    this.simulation?.destroy?.();
    this.map?.destroy?.();
  }

  // ---------------------------------------------------------------------------
  // Drive Simulation
  // ---------------------------------------------------------------------------

  toggleSimulation() {
    if (!this.selectedAreaId) {
      this.ui.showNotification("Select a coverage area first.", "warning");
      return;
    }

    if (this.simulation.active) {
      this.simulation.deactivate();
      document.getElementById("legend-simulated").style.display = "none";
    } else {
      this.simulation.activate(this.selectedAreaId);
      document.getElementById("legend-simulated").style.display = "";
    }
  }

  onSimulationUpdate(data) {
    this.updateSimulationPanel(data);
  }

  updateSimulationPanel(data) {
    const countEl = document.getElementById("sim-selected-count");
    const addedEl = document.getElementById("sim-added-distance");
    const currentEl = document.getElementById("sim-current-pct");
    const projectedEl = document.getElementById("sim-projected-pct");
    const deltaEl = document.getElementById("sim-delta-pct");
    const currentBar = document.getElementById("sim-current-bar");
    const projectedBar = document.getElementById("sim-projected-bar");
    const badge = document.getElementById("sim-count-badge");

    if (!data) {
      if (countEl) {
        countEl.textContent = "0";
      }
      if (addedEl) {
        addedEl.textContent = "--";
      }
      if (currentEl) {
        currentEl.textContent = "--";
      }
      if (projectedEl) {
        projectedEl.textContent = "--";
      }
      if (deltaEl) {
        deltaEl.textContent = "+0.00%";
      }
      if (currentBar) {
        currentBar.style.width = "0%";
      }
      if (projectedBar) {
        projectedBar.style.width = "0%";
      }
      if (badge) {
        badge.textContent = "";
        badge.style.display = "none";
      }
      return;
    }

    const { current, projected, simulated_length_miles, selectedCount } = data;
    const delta = projected.coverage_percentage - current.coverage_percentage;
    const fmtDist = (mi) => `${mi.toFixed(2)} mi`;

    if (countEl) {
      countEl.textContent = selectedCount;
    }
    if (addedEl) {
      addedEl.textContent = fmtDist(simulated_length_miles);
    }
    if (currentEl) {
      currentEl.textContent = `${current.coverage_percentage}%`;
    }
    if (projectedEl) {
      projectedEl.textContent = `${projected.coverage_percentage}%`;
    }
    if (deltaEl) {
      deltaEl.textContent = `+${delta.toFixed(2)}%`;
    }
    if (currentBar) {
      currentBar.style.width = `${current.coverage_percentage}%`;
    }
    if (projectedBar) {
      projectedBar.style.width = `${projected.coverage_percentage}%`;
    }
    if (badge) {
      badge.textContent = selectedCount;
      badge.style.display = selectedCount > 0 ? "inline-flex" : "none";
    }
  }
}
