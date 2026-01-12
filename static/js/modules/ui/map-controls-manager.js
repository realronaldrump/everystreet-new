import { CONFIG } from "../config.js";
import state from "../state.js";
import uiState from "../ui-state.js";
import { utils } from "../utils.js";
import eventManager from "./event-manager.js";

const mapControlsManager = {
  init() {
    const mapTypeSelect = uiState.getElement(CONFIG.UI.selectors.mapTypeSelect);
    if (mapTypeSelect) {
      // Default to dark mode, but respect user's stored preference
      const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
      const defaultMapType = utils.getStorage(CONFIG.STORAGE_KEYS.mapType) || theme;
      mapTypeSelect.value = defaultMapType;
      mapTypeSelect.addEventListener("change", (e) =>
        this.updateMapType(e.target.value)
      );
    }

    // Apply persisted settings on load - wait for map to be initialized
    let settingsApplied = false;
    const applySettings = () => {
      if (settingsApplied) {
        return;
      }
      if (
        state.map
        && state.mapInitialized
        && typeof state.map.setStyle === "function"
      ) {
        settingsApplied = true;
        this.updateMapType(mapTypeSelect?.value);
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
    const panel = uiState.getElement(CONFIG.UI.selectors.mapControls);
    if (!panel) {
      return;
    }
    panel.classList.toggle(CONFIG.UI.classes.open);
    const isOpen = panel.classList.contains(CONFIG.UI.classes.open);
    utils.setStorage(CONFIG.STORAGE_KEYS.mapControlsOpen, isOpen);
    eventManager.emit("mapControlsToggled", { open: isOpen });
  },

  updateMapType(type = "dark") {
    const map = state.map || window.map;
    if (!map || !state.mapInitialized) {
      return;
    }
    if (typeof map.setStyle !== "function") {
      console.warn("Map setStyle method not available yet");
      return;
    }
    utils.setStorage(CONFIG.STORAGE_KEYS.mapType, type);
    let onStyleLoaded = null;
    try {
      const currentView = {
        center: map.getCenter?.(),
        zoom: map.getZoom?.(),
        bearing: map.getBearing?.(),
        pitch: map.getPitch?.(),
      };
      const styleChangeId = (this._styleChangeId = (this._styleChangeId || 0) + 1);
      onStyleLoaded = () => {
        if (this._styleChangeId !== styleChangeId) {
          return;
        }
        if (currentView.center) {
          map.jumpTo({
            center: currentView.center,
            zoom: currentView.zoom,
            bearing: currentView.bearing,
            pitch: currentView.pitch,
          });
        }
        if (typeof map.resize === "function") {
          setTimeout(() => map.resize(), 100);
        }
        document.dispatchEvent(
          new CustomEvent("mapStyleLoaded", { detail: { mapType: type } })
        );
      };

      if (typeof map.once === "function") {
        map.once("styledata", onStyleLoaded);
      }
      // Use style from CONFIG if available, fallback to default pattern
      const styleUrl = CONFIG.MAP.styles[type] || `mapbox://styles/mapbox/${type}-v11`;
      map.setStyle(styleUrl);
      eventManager.emit("mapTypeChanged", { type });
    } catch (error) {
      if (typeof map.off === "function" && onStyleLoaded) {
        map.off("styledata", onStyleLoaded);
      }
      console.error("Error updating map type:", error);
    }
  },
};

export default mapControlsManager;
