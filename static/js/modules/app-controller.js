/**
 * AppController - Application Orchestration Module
 *
 * This module coordinates:
 * - Map initialization via mapManager
 * - Layer controls setup via layerManager
 * - Data loading via dataManager
 * - UI event handling
 * - Module communication via callbacks and events
 *
 * Initialization Flow:
 * 1. mapManager.initialize() → creates map via mapCore
 * 2. layerManager.initializeControls() → sets up layer UI
 * 3. layerManager.bindHeatmapEvents() → sets up heatmap refresh
 * 4. Wire up callbacks for cross-module communication
 * 5. Fetch initial data
 * 6. Set up UI event listeners
 */

/* global bootstrap */

import { CONFIG } from "./config.js";
import dataManager from "./data-manager.js";
import layerManager from "./layer-manager.js";
import mapCore from "./map-core.js";
import mapManager from "./map-manager.js";
import searchManager from "./search-manager.js";
import state from "./state.js";
import { utils } from "./utils.js";

const dateUtils = window.DateUtils;

// ============================================================
// Helper Functions
// ============================================================

/**
 * Initialize live trip tracker if available
 */
const initializeLiveTracker = () => {
  if (window.LiveTripTracker && state.map && !state.liveTracker) {
    // Respect user preference to hide live tracking
    try {
      const show = window.localStorage.getItem("showLiveTracking") !== "false";
      if (!show) {
        console.info("Live tracking disabled by user setting");
        return;
      }
    } catch {
      // Ignore storage errors
    }

    try {
      state.liveTracker = new window.LiveTripTracker(state.map);
    } catch (err) {
      console.error("LiveTripTracker init error:", err);
    }
  }
};

/**
 * Initialize the location dropdown for street coverage
 */
const initializeLocationDropdown = async () => {
  const dropdown = utils.getElement("streets-location");
  if (!dropdown) {
    return;
  }

  try {
    const response = await utils.fetchWithRetry("/api/coverage/areas");
    const areas = response.areas || [];

    dropdown.innerHTML = '<option value="">Select a location...</option>';

    const frag = document.createDocumentFragment();
    areas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area.id || area._id;
      option.textContent =
        area.display_name ||
        area.location?.display_name ||
        area.name ||
        "Unknown Location";
      frag.appendChild(option);
    });
    dropdown.appendChild(frag);

    const savedId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (savedId) {
      dropdown.value = savedId;
    }
  } catch (err) {
    console.error("Location dropdown error:", err);
    window.notificationManager?.show(
      "Failed to load coverage areas",
      "warning",
    );
  }
};

/**
 * Restore layer visibility from saved settings
 */
const restoreLayerVisibility = () => {
  const saved = utils.getStorage(CONFIG.STORAGE_KEYS.layerVisibility) || {};

  Object.keys(state.mapLayers).forEach((layerName) => {
    const toggle = document.getElementById(`${layerName}-toggle`);

    if (layerName === "trips") {
      // Trips layer is always visible by default
      state.mapLayers[layerName].visible = true;
      if (toggle) {
        toggle.checked = true;
      }
    } else if (saved[layerName] !== undefined) {
      // Restore saved visibility state
      state.mapLayers[layerName].visible = saved[layerName];
      if (toggle) {
        toggle.checked = saved[layerName];
      }
    }
  });
};

// ============================================================
// Main Controller
// ============================================================

const AppController = {
  _listenersInitialized: false,

  /**
   * Initialize the application
   */
  async initialize() {
    try {
      window.loadingManager?.show("Initializing application...");

      // Only initialize map if we're on the map page
      if (utils.getElement("map") && !document.getElementById("visits-page")) {
        // Phase 1: Initialize map
        const mapOk = await mapManager.initialize();
        if (!mapOk) {
          throw new Error("Map initialization failed");
        }

        // Phase 2: Set up layer manager
        layerManager.initializeControls();
        layerManager.bindHeatmapEvents();

        // Wire up callback for trip style refresh (avoids circular dependency)
        layerManager.setTripStyleRefreshCallback(() => {
          mapManager.refreshTripStyles();
        });

        // Phase 3: Initialize supporting modules
        await initializeLocationDropdown();
        initializeLiveTracker();
        searchManager.initialize();

        // Phase 4: Set up event listeners
        if (!this._listenersInitialized) {
          this.setupEventListeners();
          this._setupDataEventListeners();
          this._listenersInitialized = true;
        }

        // Phase 5: Restore saved state
        restoreLayerVisibility();
        await this._restoreStreetViewModes();

        // Phase 6: Load initial data
        window.loadingManager?.updateMessage("Loading map data...");
        await this._loadInitialData();

        // Phase 7: Post-initialization
        this._applyPostInitialization();

        document.dispatchEvent(new CustomEvent("initialDataLoaded"));
      }

      // Ensure page state is correct
      this._ensurePageState();

      document.dispatchEvent(new CustomEvent("appReady"));
      setTimeout(() => window.loadingManager?.hide(), 300);
    } catch (err) {
      console.error("App initialization error:", err);
      window.loadingManager?.error(`Initialization failed: ${err.message}`);
    }
  },

  /**
   * Restore street view mode selections
   * @private
   */
  async _restoreStreetViewModes() {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (!selectedLocationId) {
      return;
    }

    let savedStates = utils.getStorage(CONFIG.STORAGE_KEYS.streetViewMode);

    // Handle migration from old string format
    if (typeof savedStates === "string") {
      const oldMode = savedStates;
      savedStates = {};
      if (oldMode && oldMode !== "none") {
        savedStates[oldMode] = true;
      }
      utils.setStorage(CONFIG.STORAGE_KEYS.streetViewMode, savedStates);
    } else if (!savedStates || typeof savedStates !== "object") {
      savedStates = {};
    }

    // Delay to allow map to settle
    setTimeout(() => {
      Object.entries(savedStates).forEach(([mode, isActive]) => {
        if (isActive) {
          this.handleStreetViewModeChange(mode, false);
        }
      });
    }, 500);
  },

  /**
   * Load initial map data
   * @private
   */
  async _loadInitialData() {
    const fetchPromises = [
      dataManager.fetchTrips(),
      dataManager.fetchMetrics(),
    ];

    // Fetch matched trips if visible
    if (state.mapLayers.matchedTrips.visible) {
      fetchPromises.push(dataManager.fetchMatchedTrips());
    }

    await Promise.all(fetchPromises);

    // Ensure all visible layers have their visibility applied
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        Object.entries(state.mapLayers).forEach(([name, info]) => {
          if (info.visible && info.layer) {
            const layerId = `${name}-layer`;
            if (state.map?.getLayer(layerId)) {
              state.map.setLayoutProperty(layerId, "visibility", "visible");
            }
          }
        });
        resolve();
      });
    });
  },

  /**
   * Apply post-initialization actions
   * @private
   */
  _applyPostInitialization() {
    if (window.PRELOAD_TRIP_ID) {
      requestAnimationFrame(() =>
        mapManager.zoomToTrip(window.PRELOAD_TRIP_ID),
      );
    } else if (state.mapLayers.trips?.layer?.features?.length) {
      requestAnimationFrame(() => mapManager.zoomToLastTrip());
    }
  },

  /**
   * Ensure page state (CSS classes, data attributes) is correct
   * @private
   */
  _ensurePageState() {
    const currentRoute = document.body.dataset.route;

    if (currentRoute === "/map" || utils.getElement("map")) {
      document.body.dataset.route = "/map";
      document.body.classList.add("map-page");

      const persistentShell = document.getElementById("persistent-shell");
      if (persistentShell) {
        persistentShell.style.display = "flex";
      }

      const controlsPanel = document.getElementById("map-controls");
      if (controlsPanel) {
        controlsPanel.style.display = "";
        controlsPanel.style.visibility = "visible";
      }
    }
  },

  /**
   * Set up data-related event listeners
   * @private
   */
  _setupDataEventListeners() {
    // Handle trips data loaded - refresh styles
    document.addEventListener("tripsDataLoaded", () => {
      mapManager.refreshTripStyles();
    });

    // Handle map data loaded - fit bounds if requested
    document.addEventListener("mapDataLoaded", (e) => {
      if (e.detail?.fitBounds) {
        mapManager.fitBounds();
      }
    });
  },

  // ============================================================
  // Event Listeners Setup
  // ============================================================

  setupEventListeners() {
    // Controls toggle collapse icon
    const controlsToggle = utils.getElement("controls-toggle");
    const controlsContent = utils.getElement("controls-content");
    if (controlsToggle && controlsContent) {
      const collapse = new bootstrap.Collapse(controlsContent, {
        toggle: false,
      });

      controlsToggle.addEventListener("click", () => {
        collapse.toggle();
      });

      controlsContent.addEventListener("shown.bs.collapse", () => {
        const icon = controlsToggle.querySelector("i");
        if (icon) {
          icon.className = "fas fa-chevron-up";
        }
        controlsToggle.setAttribute("aria-expanded", "true");
      });

      controlsContent.addEventListener("hidden.bs.collapse", () => {
        const icon = controlsToggle.querySelector("i");
        if (icon) {
          icon.className = "fas fa-chevron-down";
        }
        controlsToggle.setAttribute("aria-expanded", "false");
      });
    }

    // Location dropdown change
    const locationDropdown = utils.getElement("streets-location");
    if (locationDropdown) {
      locationDropdown.addEventListener("change", async (e) => {
        utils.setStorage(CONFIG.STORAGE_KEYS.selectedLocation, e.target.value);
        if (e.target.value) {
          await this.refreshStreetLayers();
        } else {
          // Clear selection - hide all street layers
          await this.handleStreetViewModeChange("undriven", true);
          await this.handleStreetViewModeChange("driven", true);
          await this.handleStreetViewModeChange("all", true);
        }
      });
    }

    // Street view mode toggle buttons
    const streetToggleButtons = document.querySelectorAll(".street-mode-btn");
    if (streetToggleButtons.length > 0) {
      let savedStates = utils.getStorage(CONFIG.STORAGE_KEYS.streetViewMode);
      if (typeof savedStates === "string") {
        const oldMode = savedStates;
        savedStates = {};
        if (oldMode && oldMode !== "none") {
          savedStates[oldMode] = true;
        }
        utils.setStorage(CONFIG.STORAGE_KEYS.streetViewMode, savedStates);
      } else if (!savedStates || typeof savedStates !== "object") {
        savedStates = {};
      }

      streetToggleButtons.forEach((btn) => {
        const mode = btn.dataset.streetMode;
        const isActive = savedStates[mode] === true;

        if (isActive) {
          btn.classList.add("active");
        }

        btn.addEventListener("click", async () => {
          const isCurrentlyActive = btn.classList.contains("active");
          btn.classList.toggle("active");

          let currentStates = utils.getStorage(
            CONFIG.STORAGE_KEYS.streetViewMode,
          );
          if (typeof currentStates !== "object" || currentStates === null) {
            currentStates = {};
          }
          currentStates[mode] = !isCurrentlyActive;
          utils.setStorage(CONFIG.STORAGE_KEYS.streetViewMode, currentStates);

          await this.handleStreetViewModeChange(mode, isCurrentlyActive);
        });
      });
    }

    // Center-on-location button (geolocation)
    const centerBtn = utils.getElement("center-on-location");
    if (centerBtn) {
      centerBtn.addEventListener("click", async () => {
        const geolocationService = (await import("./geolocation-service.js"))
          .default;
        if (!geolocationService.isSupported()) {
          window.notificationManager?.show(
            "Geolocation is not supported",
            "warning",
          );
          return;
        }
        centerBtn.disabled = true;
        centerBtn.classList.add("btn-loading");
        try {
          const position = await geolocationService.getCurrentPosition();
          const { coords } = position;
          state.map?.flyTo({
            center: [coords.longitude, coords.latitude],
            zoom: 14,
            duration: 1000,
          });
        } catch (err) {
          console.error("Geolocation error:", err);
          window.notificationManager?.show(
            `Error getting location: ${err.message}`,
            "danger",
          );
        } finally {
          centerBtn.disabled = false;
          centerBtn.classList.remove("btn-loading");
        }
      });
    }

    // Map style reload event – re-apply layers
    document.addEventListener("mapStyleLoaded", async () => {
      if (!state.map || !state.mapInitialized) {
        return;
      }

      window.loadingManager?.pulse("Applying new map style...");

      // Wait for style to be fully loaded
      await mapCore.waitForStyleLoad();

      // Re-apply all visible layers with their data
      for (const [name, info] of Object.entries(state.mapLayers)) {
        if (info.visible && info.layer) {
          await layerManager.updateMapLayer(name, info.layer);
        }
      }
      window.loadingManager?.hide();
    });

    // Refresh map button
    const refreshBtn = utils.getElement("refresh-map");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        refreshBtn.classList.add("btn-loading");
        try {
          state.apiCache.clear();
          await dataManager.updateMap(false);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.classList.remove("btn-loading");
        }
      });
    }

    // Fit-bounds button
    const fitBoundsBtn = utils.getElement("fit-bounds");
    if (fitBoundsBtn) {
      fitBoundsBtn.addEventListener("click", () => mapManager.fitBounds());
    }

    // Highlight recent trips toggle
    const highlightToggle = utils.getElement("highlight-recent-trips");
    if (highlightToggle) {
      highlightToggle.addEventListener("change", (e) => {
        state.mapSettings.highlightRecentTrips = e.target.checked;
        mapManager.refreshTripStyles();
      });
    }

    // Filters applied (date-range etc.)
    document.addEventListener("filtersApplied", async () => {
      if (state.mapInitialized) {
        utils.setStorage("cached_date_range", null);
        await dataManager.updateMap(true);
      }
    });

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      if (
        !state.map ||
        document.activeElement.matches("input, textarea, select")
      ) {
        return;
      }
      const actions = {
        "+": () => state.map.zoomIn(),
        "=": () => state.map.zoomIn(),
        "-": () => state.map.zoomOut(),
        _: () => state.map.zoomOut(),
        f: () => mapManager.fitBounds(),
        r: () => refreshBtn?.click(),
        l: () => centerBtn?.click(),
      };
      if (actions[e.key]) {
        actions[e.key]();
        e.preventDefault();
      }
    });

    // Visibility change – pause auto-refresh
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        state.mapSettings.autoRefresh = false;
      } else if (state.hasPendingRequests()) {
        window.notificationManager?.show("Refreshing data...", "info", 2000);
        dataManager.updateMap(false);
      }
    });

    // Save layer visibility + cleanup on unload
    window.addEventListener("beforeunload", () => {
      state.cancelAllRequests();
      const visibility = {};
      Object.entries(state.mapLayers).forEach(([name, info]) => {
        visibility[name] = info.visible;
      });
      utils.setStorage(CONFIG.STORAGE_KEYS.layerVisibility, visibility);
      layerManager.cleanup();
    });
  },

  // ============================================================
  // Public Methods
  // ============================================================

  async mapMatchTrips() {
    try {
      const confirmed = await window.confirmationDialog?.show({
        title: "Map Match Trips",
        message:
          "This will process all trips in the selected date range. " +
          "This may take several minutes for large date ranges. Continue?",
        confirmText: "Start Map Matching",
        confirmButtonClass: "btn-primary",
      });
      if (!confirmed) {
        return;
      }

      window.loadingManager?.show("Starting map matching process...");
      const res = await utils.fetchWithRetry("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: dateUtils.getStartDate(),
          end_date: dateUtils.getEndDate(),
        }),
      });
      if (res) {
        window.notificationManager?.show(
          `Map matching completed: ${res.message}`,
          "success",
        );
        await dataManager.updateMap();
      }
    } catch (err) {
      console.error("Map match error:", err);
      window.notificationManager?.show(
        `Map matching error: ${err.message}`,
        "danger",
      );
    } finally {
      window.loadingManager?.hide();
    }
  },

  async handleStreetViewModeChange(mode, shouldHide = false) {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (!selectedLocationId && !shouldHide) {
      window.notificationManager?.show(
        "Please select a location first",
        "warning",
      );
      return;
    }

    const layerMap = {
      undriven: {
        layer: "undrivenStreets",
        layerId: "undrivenStreets-layer",
        fetch: dataManager.fetchUndrivenStreets,
      },
      driven: {
        layer: "drivenStreets",
        layerId: "drivenStreets-layer",
        fetch: dataManager.fetchDrivenStreets,
      },
      all: {
        layer: "allStreets",
        layerId: "allStreets-layer",
        fetch: dataManager.fetchAllStreets,
      },
    };

    const config = layerMap[mode];
    if (!config) {
      return;
    }

    if (shouldHide) {
      state.mapLayers[config.layer].visible = false;
      if (state.map?.getLayer(config.layerId)) {
        state.map.setLayoutProperty(config.layerId, "visibility", "none");
      }
    } else {
      state.mapLayers[config.layer].visible = true;
      await config.fetch.call(dataManager);
      if (state.map?.getLayer(config.layerId)) {
        state.map.setLayoutProperty(config.layerId, "visibility", "visible");
      }
    }
  },

  async refreshStreetLayers() {
    let savedStates = utils.getStorage(CONFIG.STORAGE_KEYS.streetViewMode);
    if (typeof savedStates === "string") {
      const oldMode = savedStates;
      savedStates = {};
      if (oldMode && oldMode !== "none") {
        savedStates[oldMode] = true;
      }
      utils.setStorage(CONFIG.STORAGE_KEYS.streetViewMode, savedStates);
    } else if (!savedStates || typeof savedStates !== "object") {
      savedStates = {};
    }

    for (const [mode, isActive] of Object.entries(savedStates)) {
      if (isActive) {
        await this.handleStreetViewModeChange(mode, false);
      }
    }
  },
};

document.addEventListener("es:page-load", (event) => {
  if (event.detail?.path === "/map") {
    AppController.initialize();
  }
});

export default AppController;
