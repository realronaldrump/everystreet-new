import state from "../state.js";
import { UI_CONFIG as CONFIG } from "../ui-config.js";
import uiState from "../ui-state.js";
import utils from "../ui-utils.js";
import eventManager from "./event-manager.js";

// panelManager is not used directly in this module

const mapControlsManager = {
  init() {
    const mapTypeSelect = uiState.getElement(CONFIG.selectors.mapTypeSelect);
    const opacityRange = uiState.getElement(
      CONFIG.selectors.basemapOpacityRange,
    );
    if (mapTypeSelect) {
      mapTypeSelect.value =
        utils.getStorage(CONFIG.storage.mapType) || "satellite";
      mapTypeSelect.addEventListener("change", (e) =>
        this.updateMapType(e.target.value),
      );
    }
    if (opacityRange) {
      opacityRange.value =
        utils.getStorage(CONFIG.storage.basemapOpacity) || 0.75;
      opacityRange.addEventListener("input", (e) =>
        this.updateOpacity(parseFloat(e.target.value)),
      );
    }
    // Note: controls-toggle is handled in app-controller.js using Bootstrap Collapse API
    // const toggleBtn = uiState.getElement(CONFIG.selectors.controlsToggle);
    // if (toggleBtn) toggleBtn.addEventListener("click", () => this.toggleControlPanel());

    // Apply persisted settings on load - wait for map to be initialized
    let settingsApplied = false;
    const applySettings = () => {
      if (settingsApplied) return;
      if (
        state.map &&
        state.mapInitialized &&
        typeof state.map.setStyle === "function"
      ) {
        settingsApplied = true;
        this.updateMapType(mapTypeSelect?.value);
        this.updateOpacity(parseFloat(opacityRange?.value || 0.75), false);
      }
    };

    // Try immediately if map is already ready
    applySettings();

    // Listen for mapInitialized event
    document.addEventListener("mapInitialized", applySettings, { once: true });

    // Fallback: check periodically (max 5 seconds)
    let attempts = 0;
    const maxAttempts = 50;
    const checkInterval = setInterval(() => {
      attempts++;
      applySettings();
      if (settingsApplied || attempts >= maxAttempts) {
        clearInterval(checkInterval);
      }
    }, 100);
  },

  toggleControlPanel() {
    const panel = uiState.getElement(CONFIG.selectors.mapControls);
    if (!panel) return;
    panel.classList.toggle(CONFIG.classes.open);
    const isOpen = panel.classList.contains(CONFIG.classes.open);
    utils.setStorage(CONFIG.storage.mapControlsOpen, isOpen);
    eventManager.emit("mapControlsToggled", { open: isOpen });
  },

  updateMapType(type = "satellite") {
    const map = state.map || window.map;
    if (!map || !state.mapInitialized) return;
    if (typeof map.setStyle !== "function") {
      console.warn("Map setStyle method not available yet");
      return;
    }
    utils.setStorage(CONFIG.storage.mapType, type);
    try {
      map.setStyle(`mapbox://styles/mapbox/${type}-v12`);
      eventManager.emit("mapTypeChanged", { type });
    } catch (error) {
      console.error("Error updating map type:", error);
    }
  },

  updateOpacity(value = 0.75, persist = true) {
    const map = state.map || window.map;
    if (!map || !state.mapInitialized) return;
    if (
      typeof map.getLayer !== "function" ||
      typeof map.setPaintProperty !== "function"
    ) {
      console.warn("Map methods not available yet");
      return;
    }
    const basemapLayers = ["satellite", "background", "land", "water"];
    basemapLayers.forEach((id) => {
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", value);
    });
    if (persist) utils.setStorage(CONFIG.storage.basemapOpacity, value);
    eventManager.emit("basemapOpacityChanged", { value });
  },
};

if (!window.mapControlsManager) window.mapControlsManager = mapControlsManager;
export { mapControlsManager as default };
