/**
 * MapControlsManager - Map Style and Display Controls
 *
 * This module handles:
 * - Map style switching (dark/light/satellite/streets)
 * - View preservation during style changes
 * - Style preference persistence
 *
 * Initialization is coordinated by app-controller via mapInitialized event.
 * No polling fallbacks - relies on deterministic event-based initialization.
 */

import { CONFIG } from "../core/config.js";
import { swupReady } from "../core/navigation.js";
import store from "../core/store.js";
import mapCore from "../map-core.js";
import { utils } from "../utils.js";
import eventManager from "./event-manager.js";

const mapControlsManager = {
  _initialized: false,
  _styleChangeId: 0,

  /**
   * Initialize map controls
   * Should be called after map is initialized
   */
  init() {
    if (this._initialized) {
      return;
    }

    const mapTypeSelect = store.getElement(CONFIG.UI.selectors.mapTypeSelect);
    if (!mapTypeSelect) {
      return;
    }

    this._initialized = true;

    // Set initial value from stored preference or theme
    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const defaultMapType = utils.getStorage(CONFIG.STORAGE_KEYS.mapType) || theme;
    mapTypeSelect.value = defaultMapType;

    // Set up change handler
    mapTypeSelect.addEventListener("change", (e) => {
      this.updateMapType(e.target.value);
    });

    // Apply initial style if map is ready
    if (mapCore.isReady()) {
      this._applyInitialStyle(mapTypeSelect.value);
    }
  },

  /**
   * Apply initial map style
   * @private
   */
  _applyInitialStyle(mapType) {
    // Only apply if different from current
    const map = store.map || window.map;
    if (!map) {
      return;
    }

    const currentStyle = map.getStyle()?.name?.toLowerCase() || "";
    const requestedStyle = mapType.toLowerCase();

    // Style names may not match exactly, so we just ensure it's set
    if (!currentStyle.includes(requestedStyle)) {
      this.updateMapType(mapType);
    }
  },

  /**
   * Toggle control panel visibility
   */
  toggleControlPanel() {
    const panel = store.getElement(CONFIG.UI.selectors.mapControls);
    if (!panel) {
      return;
    }

    panel.classList.toggle(CONFIG.UI.classes.open);
    const isOpen = panel.classList.contains(CONFIG.UI.classes.open);
    utils.setStorage(CONFIG.STORAGE_KEYS.mapControlsOpen, isOpen);
    eventManager.emit("mapControlsToggled", { open: isOpen });
  },

  /**
   * Update map style/type
   * @param {string} type - Style type (dark, light, satellite, streets)
   */
  updateMapType(type = "dark") {
    const map = store.map || window.map;

    if (!map || !store.mapInitialized) {
      console.warn("Map not ready for style change");
      return;
    }

    if (typeof map.setStyle !== "function") {
      console.warn("Map setStyle method not available");
      return;
    }

    // Save preference
    utils.setStorage(CONFIG.STORAGE_KEYS.mapType, type);

    // Capture current view
    const currentView = {
      center: map.getCenter?.(),
      zoom: map.getZoom?.(),
      bearing: map.getBearing?.(),
      pitch: map.getPitch?.(),
    };

    // Track style change to prevent stale callbacks
    this._styleChangeId += 1;
    const styleChangeId = this._styleChangeId;

    // Set up style load handler
    const onStyleLoaded = () => {
      // Ignore if a newer style change was initiated
      if (this._styleChangeId !== styleChangeId) {
        return;
      }

      // Restore view
      if (currentView.center) {
        map.jumpTo({
          center: currentView.center,
          zoom: currentView.zoom,
          bearing: currentView.bearing,
          pitch: currentView.pitch,
        });
      }

      // Trigger resize to ensure proper rendering
      if (typeof map.resize === "function") {
        setTimeout(() => map.resize(), 100);
      }

      // Dispatch event for layer restoration
      document.dispatchEvent(
        new CustomEvent("mapStyleLoaded", { detail: { mapType: type } })
      );
    };

    try {
      // Listen for style data event
      if (typeof map.once === "function") {
        map.once("styledata", onStyleLoaded);
      }

      // Get style URL (no Mapbox-protocol fallbacks; styles are configured in CONFIG).
      const styleUrl = CONFIG.MAP.styles[type] || CONFIG.MAP.styles.dark;

      // Apply new style
      map.setStyle(styleUrl);

      // Emit event
      eventManager.emit("mapTypeChanged", { type });
    } catch (error) {
      // Clean up listener on error
      if (typeof map.off === "function") {
        map.off("styledata", onStyleLoaded);
      }
      console.error("Error updating map type:", error);
    }
  },

  /**
   * Reset initialization state (for testing)
   */
  reset() {
    this._initialized = false;
    this._styleChangeId = 0;
  },
};

swupReady
  .then((swup) => {
    swup.hooks.on("page:view", (visit) => {
      const toUrl = visit?.to?.url;
      let pathname = null;
      if (typeof toUrl === "string" && toUrl) {
        try {
          const { pathname: resolvedPathname } = new URL(toUrl, window.location.origin);
          pathname = resolvedPathname;
        } catch {
          pathname = null;
        }
      }

      if ((pathname || window.location.pathname) !== "/map") {
        return;
      }
      // Wait for map to be ready before initializing controls.
      mapCore.onReady(() => {
        mapControlsManager.init();
      });
    });
  })
  .catch(() => {});

export default mapControlsManager;
