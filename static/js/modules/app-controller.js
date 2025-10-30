import utils from "./utils.js";
import { CONFIG } from "./config.js";
import state from "./state.js";
import mapManager from "./map-manager.js";
import layerManager from "./layer-manager.js";
import dataManager from "./data-manager.js";
import metricsManager from "./metrics-manager.js";
import dateUtils from "./date-utils.js";
import searchManager from "./search-manager.js";

// --- Helper functions --------------------------------------------------
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

const initializeLocationDropdown = async () => {
  const dropdown = utils.getElement("streets-location");
  if (!dropdown) return;
  try {
    const response = await utils.fetchWithRetry("/api/coverage_areas");
    const areas = response.areas || [];
    dropdown.innerHTML = '<option value="">Select a location...</option>';
    const frag = document.createDocumentFragment();
    areas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area._id || area.id;
      option.textContent =
        area.location?.display_name ||
        area.location?.city ||
        area.name ||
        area.city ||
        "Unknown Location";
      frag.appendChild(option);
    });
    dropdown.appendChild(frag);
    const savedId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (savedId) dropdown.value = savedId;
  } catch (err) {
    console.error("Location dropdown error:", err);
    window.notificationManager.show("Failed to load coverage areas", "warning");
  }
};

const restoreLayerVisibility = () => {
  const saved = utils.getStorage(CONFIG.STORAGE_KEYS.layerVisibility) || {};
  Object.keys(state.mapLayers).forEach((layerName) => {
    const toggle = document.getElementById(`${layerName}-toggle`);
    if (layerName === "trips") {
      // Trips layer is always visible by default
      state.mapLayers[layerName].visible = true;
      if (toggle) toggle.checked = true;
    } else if (saved[layerName] !== undefined) {
      // Restore saved visibility state
      state.mapLayers[layerName].visible = saved[layerName];
      if (toggle) toggle.checked = saved[layerName];
    }
    // Note: Visibility will be applied after data is loaded in initialize()
  });
};

// --- Main controller ---------------------------------------------------
const AppController = {
  async initialize() {
    try {
      window.loadingManager?.show("Initializing application...");

      if (utils.getElement("map") && !document.getElementById("visits-page")) {
        const ok = await mapManager.initialize();
        if (!ok) throw new Error("Map init failed");

        layerManager.initializeControls();
        await initializeLocationDropdown();
        initializeLiveTracker();
        searchManager.initialize();
        this.setupEventListeners();
        restoreLayerVisibility();

        // Restore street view modes if location is selected
        const selectedLocationId = utils.getStorage(
          CONFIG.STORAGE_KEYS.selectedLocation,
        );
        if (selectedLocationId) {
          let savedStates = utils.getStorage(
            CONFIG.STORAGE_KEYS.streetViewMode,
          );
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

          setTimeout(() => {
            Object.entries(savedStates).forEach(([mode, isActive]) => {
              if (isActive) {
                this.handleStreetViewModeChange(mode, false);
              }
            });
          }, 500);
        }

        const mapStage = window.loadingManager.startStage(
          "map",
          "Loading map data...",
        );
        
        // Fetch all visible layers during initialization
        const fetchPromises = [
          dataManager.fetchTrips(),
          dataManager.fetchMetrics(),
        ];
        
        // Fetch matched trips if visible
        if (state.mapLayers.matchedTrips.visible) {
          fetchPromises.push(dataManager.fetchMatchedTrips());
        }
        
        await Promise.all(fetchPromises);
        mapStage.complete();

        // Ensure all visible layers have their visibility applied after data loads
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            Object.entries(state.mapLayers).forEach(([name, info]) => {
              if (info.visible && info.layer) {
                const layerId = `${name}-layer`;
                if (state.map?.getLayer(layerId)) {
                  state.map.setLayoutProperty(
                    layerId,
                    "visibility",
                    "visible",
                  );
                }
              }
            });
            resolve();
          });
        });

        if (state.mapLayers.trips?.layer?.features?.length) {
          requestAnimationFrame(() => mapManager.zoomToLastTrip());
        }

        document.dispatchEvent(new CustomEvent("initialDataLoaded"));
      }

      document.dispatchEvent(new CustomEvent("appReady"));
      setTimeout(() => window.loadingManager.finish(), 300);
    } catch (err) {
      console.error("App initialization error:", err);
      window.loadingManager.error(`Initialization failed: ${err.message}`);
    }
  },

  /* ------------------------------------------------------------------ */
  setupEventListeners() {
    // Controls toggle collapse icon
    const controlsToggle = utils.getElement("controls-toggle");
    if (controlsToggle) {
      controlsToggle.addEventListener("click", () => {
        const content = utils.getElement("controls-content");
        const icon = controlsToggle.querySelector("i");
        if (content && icon) {
          content.addEventListener(
            "transitionend",
            () => {
              const collapsed = !content.classList.contains("show");
              icon.className = collapsed
                ? "fas fa-chevron-down"
                : "fas fa-chevron-up";
            },
            { once: true },
          );
        }
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
    const streetToggleButtons = document.querySelectorAll(".street-toggle-btn");
    if (streetToggleButtons.length > 0) {
      // Restore saved states - handle migration from old string format
      let savedStates = utils.getStorage(CONFIG.STORAGE_KEYS.streetViewMode);
      if (typeof savedStates === "string") {
        // Migrate from old format (single string) to new format (object)
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

          // Save state - ensure we always work with an object
          let currentStates = utils.getStorage(
            CONFIG.STORAGE_KEYS.streetViewMode,
          );
          if (typeof currentStates !== "object" || currentStates === null) {
            currentStates = {};
          }
          currentStates[mode] = !isCurrentlyActive;
          utils.setStorage(CONFIG.STORAGE_KEYS.streetViewMode, currentStates);

          // Toggle the layer
          await this.handleStreetViewModeChange(mode, isCurrentlyActive);
        });
      });
    }

    // Center-on-location button (geolocation)
    const centerBtn = utils.getElement("center-on-location");
    if (centerBtn) {
      centerBtn.addEventListener("click", () => {
        if (!navigator.geolocation) {
          window.notificationManager.show(
            "Geolocation is not supported",
            "warning",
          );
          return;
        }
        centerBtn.disabled = true;
        centerBtn.classList.add("btn-loading");
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => {
            state.map?.flyTo({
              center: [coords.longitude, coords.latitude],
              zoom: 14,
              duration: 1000,
            });
            centerBtn.disabled = false;
            centerBtn.classList.remove("btn-loading");
          },
          (err) => {
            console.error("Geolocation error:", err);
            window.notificationManager.show(
              `Error getting location: ${err.message}`,
              "danger",
            );
            centerBtn.disabled = false;
            centerBtn.classList.remove("btn-loading");
          },
        );
      });
    }

    // Map style reload event – re-apply layers
    document.addEventListener("mapStyleLoaded", async () => {
      if (!state.map || !state.mapInitialized) return;
      window.loadingManager.pulse("Applying new map style...");
      
      // Wait for map style to be fully loaded
      await new Promise((resolve) => {
        if (state.map.isStyleLoaded()) {
          resolve();
        } else {
          state.map.once("styledata", resolve);
          setTimeout(resolve, 2000); // Fallback timeout
        }
      });
      
      // Re-apply all visible layers with their data
      for (const [name, info] of Object.entries(state.mapLayers)) {
        if (info.visible && info.layer) {
          await layerManager.updateMapLayer(name, info.layer);
        }
      }
      window.loadingManager.hide();
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
    if (fitBoundsBtn)
      fitBoundsBtn.addEventListener("click", () => mapManager.fitBounds());

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
      )
        return;
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
        window.notificationManager.show("Refreshing data...", "info", 2000);
        dataManager.updateMap(false);
      }
    });

    // Save layer visibility + cleanup on unload
    window.addEventListener("beforeunload", () => {
      state.cancelAllRequests();
      const visibility = {};
      Object.entries(state.mapLayers).forEach(
        ([name, info]) => (visibility[name] = info.visible),
      );
      utils.setStorage(CONFIG.STORAGE_KEYS.layerVisibility, visibility);
      layerManager.cleanup();
    });

    // Basic global error / rejection logging
    window.addEventListener("error", () => {
      // Intentionally no-op to avoid unused parameter warnings while preserving handler registration
      // Detailed logging handled elsewhere
    });
    window.addEventListener("unhandledrejection", () => {
      // Intentionally no-op to avoid unused parameter warnings while preserving handler registration
    });
  },

  // Public proxy (retro-compat) ---------------------------------------
  async mapMatchTrips() {
    try {
      const confirmed = await window.confirmationDialog.show({
        title: "Map Match Trips",
        message:
          "This will process all trips in the selected date range. This may take several minutes for large date ranges. Continue?",
        confirmText: "Start Map Matching",
        confirmButtonClass: "btn-primary",
      });
      if (!confirmed) return;
      window.loadingManager.show("Starting map matching process...");
      const res = await utils.fetchWithRetry("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: dateUtils.getStartDate(),
          end_date: dateUtils.getEndDate(),
        }),
      });
      if (res) {
        window.notificationManager.show(
          `Map matching completed: ${res.message}`,
          "success",
        );
        await dataManager.updateMap();
      }
    } catch (err) {
      console.error("Map match error:", err);
      window.notificationManager.show(
        `Map matching error: ${err.message}`,
        "danger",
      );
    } finally {
      window.loadingManager.hide();
    }
  },

  async handleStreetViewModeChange(mode, shouldHide = false) {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (!selectedLocationId && !shouldHide) {
      window.notificationManager.show(
        "Please select a location first",
        "warning",
      );
      return;
    }

    // Map mode to layer names
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
    if (!config) return;

    if (shouldHide) {
      // Hide the layer
      state.mapLayers[config.layer].visible = false;
      if (state.map?.getLayer(config.layerId)) {
        state.map.setLayoutProperty(config.layerId, "visibility", "none");
      }
    } else {
      // Show the layer and fetch data if needed
      state.mapLayers[config.layer].visible = true;
      await config.fetch.call(dataManager);
      if (state.map?.getLayer(config.layerId)) {
        state.map.setLayoutProperty(config.layerId, "visibility", "visible");
      }
    }
  },

  async refreshStreetLayers() {
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

    for (const [mode, isActive] of Object.entries(savedStates)) {
      if (isActive) {
        await this.handleStreetViewModeChange(mode, false);
      }
    }
  },
};

// Make controller globally accessible for legacy scripts
if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.App = {
  fetchTrips: dataManager.fetchTrips.bind(dataManager),
  updateMap: dataManager.updateMap.bind(dataManager),
  refreshTripStyles: mapManager.refreshTripStyles.bind(mapManager),
  updateTripsTable: metricsManager.updateTripsTable.bind(metricsManager),
  toggleLayer: layerManager.toggleLayer.bind(layerManager),
  fetchMetrics: dataManager.fetchMetrics.bind(dataManager),
  initializeMap: mapManager.initialize.bind(mapManager),
  getStartDate: dateUtils.getStartDate,
  getEndDate: dateUtils.getEndDate,
  fitMapBounds: mapManager.fitBounds.bind(mapManager),
  mapMatchTrips: AppController.mapMatchTrips.bind(AppController),
  AppState: state,
  CONFIG,
  utils,
};

export default AppController;
