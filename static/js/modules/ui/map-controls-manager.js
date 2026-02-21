/**
 * MapControlsManager - Map Style and Display Controls
 *
 * This module handles:
 * - Map style switching (dark/light/satellite/streets)
 * - View preservation during style changes
 * - Style preference persistence
 *
 * Initialization is coordinated by app-controller via mapInitialized event.
 * No polling defaults - relies on deterministic event-based initialization.
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
  _styleSyncBound: false,
  _mapTypeSelect: null,
  _onMapStyleChanged: null,

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

    this._mapTypeSelect = mapTypeSelect;
    this._initialized = true;
    this._bindStyleSyncListener();

    // Set initial value from stored preference or theme
    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const storedMapType = utils.getStorage(CONFIG.STORAGE_KEYS.mapType);
    const defaultMapType =
      typeof storedMapType === "string" &&
      Object.prototype.hasOwnProperty.call(CONFIG.MAP.styles, storedMapType)
        ? storedMapType
        : theme;
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
    if (!map || typeof mapType !== "string") {
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
   * Keep the selector synchronized with externally-triggered style changes.
   * @private
   */
  _bindStyleSyncListener() {
    if (this._styleSyncBound) {
      return;
    }

    this._onMapStyleChanged = (event) => {
      const styleType = event?.detail?.styleType;
      if (typeof styleType !== "string" || !this._mapTypeSelect) {
        return;
      }

      if (this._mapTypeSelect.value !== styleType) {
        this._mapTypeSelect.value = styleType;
      }
    };

    this._styleSyncBound = true;
    document.addEventListener("mapStyleChanged", this._onMapStyleChanged);
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
    const normalizedType =
      typeof type === "string" ? type.trim().toLowerCase() : "dark";
    const map = store.map || window.map;

    if (!Object.prototype.hasOwnProperty.call(CONFIG.MAP.styles, normalizedType)) {
      console.warn("Unsupported map style type:", normalizedType);
      return;
    }

    if (!map || !store.mapInitialized) {
      console.warn("Map not ready for style change");
      return;
    }

    if (typeof map.setStyle !== "function") {
      console.warn("Map setStyle method not available");
      return;
    }

    // Save preference
    utils.setStorage(CONFIG.STORAGE_KEYS.mapType, normalizedType);

    // Track style change to prevent stale callbacks
    this._styleChangeId += 1;
    const styleChangeId = this._styleChangeId;

    try {
      void mapCore
        .setStyle(normalizedType)
        .then(() => {
          // Ignore if a newer style change was initiated
          if (this._styleChangeId !== styleChangeId) {
            return;
          }
          eventManager.emit("mapTypeChanged", { type: normalizedType });
        })
        .catch((error) => {
          console.error("Error updating map type:", error);
        });
    } catch (error) {
      console.error("Error updating map type:", error);
    }
  },

  /**
   * Reset initialization state (for testing)
   */
  reset() {
    if (this._onMapStyleChanged) {
      document.removeEventListener("mapStyleChanged", this._onMapStyleChanged);
    }
    this._initialized = false;
    this._styleChangeId = 0;
    this._styleSyncBound = false;
    this._mapTypeSelect = null;
    this._onMapStyleChanged = null;
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
