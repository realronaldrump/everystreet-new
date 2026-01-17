/**
 * LayerManager - Map Layer Rendering and Controls
 *
 * This module handles:
 * - Layer creation and updates on the map
 * - Layer visibility toggling with fade animations
 * - Layer controls UI (toggles, color pickers, opacity sliders)
 * - Heatmap rendering with dynamic opacity
 * - Drag-and-drop layer reordering
 * - Trip interaction hitbox layers
 *
 * Note: This module does NOT fetch data - it only renders provided data.
 * Data fetching is handled by data-manager.js
 */

import { CONFIG } from "./config.js";
import heatmapUtils from "./heatmap-utils.js";
import mapCore from "./map-core.js";
import store from "./spa/store.js";
import state from "./state.js";
import { utils } from "./utils.js";

// Layers that support trip click interactions
const INTERACTIVE_TRIP_LAYERS = new Set(["trips", "matchedTrips"]);

// Animation constants
const FADE_DURATION = 320;

const layerManager = {
  // Event handler tracking for proper cleanup
  _layerCleanupMap: new Map(),
  _heatmapEventsBound: false,
  _heatmapRefreshHandler: null,

  // Callbacks for trip style refresh (set by app-controller to avoid circular deps)
  _onTripStyleRefresh: null,

  /**
   * Register callback for trip style refresh
   * This avoids circular dependency with map-manager
   * @param {Function} callback
   */
  setTripStyleRefreshCallback(callback) {
    this._onTripStyleRefresh = callback;
  },

  /**
   * Trigger trip style refresh if callback is registered
   * @private
   */
  _triggerTripStyleRefresh() {
    if (typeof this._onTripStyleRefresh === "function") {
      try {
        this._onTripStyleRefresh();
      } catch (err) {
        console.warn("Trip style refresh callback error:", err);
      }
    }
  },

  // ============================================================
  // Trip Interaction Hitbox Management
  // ============================================================

  /**
   * Check if layer supports trip interactions
   * @private
   */
  _shouldEnableTripInteractions(layerName) {
    return INTERACTIVE_TRIP_LAYERS.has(layerName);
  },

  /**
   * Get hitbox width expression based on device
   * @private
   */
  _getTripHitboxWidth() {
    const deviceProfile = utils.getDeviceProfile?.() || {};
    const baseWidth = deviceProfile.isMobile ? 14 : 10;
    return [
      "interpolate",
      ["linear"],
      ["zoom"],
      6,
      baseWidth * 0.6,
      10,
      baseWidth,
      14,
      baseWidth * 1.3,
      18,
      baseWidth * 1.6,
      22,
      baseWidth * 2,
    ];
  },

  /**
   * Get hitbox opacity based on device
   * @private
   */
  _getTripHitboxOpacity() {
    const deviceProfile = utils.getDeviceProfile?.() || {};
    return deviceProfile.isMobile ? 0.03 : 0.02;
  },

  /**
   * Remove trip hitbox layer and its event handlers
   * @private
   */
  _removeTripHitboxLayer(layerName) {
    if (!state.map) return;

    const hitboxLayerId = `${layerName}-hitbox`;

    if (state.map.getLayer(hitboxLayerId)) {
      // Remove event handlers first
      ["click", "mouseenter", "mouseleave"].forEach((event) => {
        state.map.off(event, hitboxLayerId);
      });
      state.map.removeLayer(hitboxLayerId);
    }

    this._layerCleanupMap.delete(hitboxLayerId);
  },

  /**
   * Set up trip interaction hitbox layer with click/hover handlers
   * @private
   */
  async _setupTripInteractions(layerName, sourceId, layerInfo) {
    if (!state.map || !this._shouldEnableTripInteractions(layerName)) {
      return;
    }

    const hitboxLayerId = `${layerName}-hitbox`;

    const hitboxConfig = {
      id: hitboxLayerId,
      type: "line",
      source: sourceId,
      minzoom: layerInfo.minzoom || 0,
      maxzoom: layerInfo.maxzoom || 22,
      layout: {
        visibility: layerInfo.visible ? "visible" : "none",
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": "#000000",
        "line-opacity": this._getTripHitboxOpacity(),
        "line-width": this._getTripHitboxWidth(),
      },
    };

    // Create or update hitbox layer
    if (!state.map.getLayer(hitboxLayerId)) {
      state.map.addLayer(hitboxConfig);
    } else {
      state.map.setLayoutProperty(
        hitboxLayerId,
        "visibility",
        layerInfo.visible ? "visible" : "none",
      );
      state.map.setPaintProperty(
        hitboxLayerId,
        "line-width",
        this._getTripHitboxWidth(),
      );
      // Ensure hitbox is on top for interactivity
      state.map.moveLayer(hitboxLayerId);
    }

    // Set up event handlers
    const tripInteractions = (await import("./trip-interactions.js")).default;

    const clickHandler = (e) => {
      // Ignore non-primary mouse buttons
      if (
        typeof e.originalEvent?.button === "number" &&
        e.originalEvent.button !== 0
      ) {
        return;
      }
      // Ignore if map is being dragged
      if (typeof state.map?.isMoving === "function" && state.map.isMoving()) {
        return;
      }
      // For trips layer, check if matchedTrips hitbox is being clicked instead
      if (layerName === "trips" && state.map.getLayer("matchedTrips-hitbox")) {
        const matchedHits = state.map.queryRenderedFeatures(e.point, {
          layers: ["matchedTrips-hitbox"],
        });
        if (matchedHits.length > 0) {
          return; // Let matchedTrips handler handle it
        }
      }

      e.originalEvent?.stopPropagation?.();

      if (e.features?.length > 0) {
        tripInteractions.handleTripClick(e, e.features[0], layerName);
      }
    };

    const mouseEnterHandler = () => {
      state.map.getCanvas().style.cursor = "pointer";
    };

    const mouseLeaveHandler = () => {
      state.map.getCanvas().style.cursor = "";
    };

    // Remove existing handlers before adding new ones
    ["click", "mouseenter", "mouseleave"].forEach((event) => {
      state.map.off(event, hitboxLayerId);
    });

    // Add new handlers
    state.map.on("click", hitboxLayerId, clickHandler);
    state.map.on("mouseenter", hitboxLayerId, mouseEnterHandler);
    state.map.on("mouseleave", hitboxLayerId, mouseLeaveHandler);

    // Track handlers for cleanup
    this._layerCleanupMap.set(hitboxLayerId, {
      handlers: {
        click: clickHandler,
        mouseenter: mouseEnterHandler,
        mouseleave: mouseLeaveHandler,
      },
      sourceId,
      removeSource: false,
    });

    // Trigger trip style refresh after hitbox setup
    requestAnimationFrame(() => {
      this._triggerTripStyleRefresh();
    });
  },

  // ============================================================
  // Layer Controls UI
  // ============================================================

  /**
   * Initialize layer control UI elements
   */
  initializeControls() {
    const container = utils.getElement("layer-toggles");
    if (!container) return;

    // Load saved layer settings
    const settings = utils.getStorage(CONFIG.STORAGE_KEYS.layerSettings) || {};
    Object.entries(settings).forEach(([name, layerSettings]) => {
      if (state.mapLayers[name]) {
        Object.assign(state.mapLayers[name], layerSettings);
      }
    });

    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    // Exclude street layers - they're controlled by radio buttons
    const streetLayers = ["undrivenStreets", "drivenStreets", "allStreets"];

    // Sort layers by order
    const sortedLayers = Object.entries(state.mapLayers)
      .filter(([name]) => !streetLayers.includes(name))
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

    sortedLayers.forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className =
        "layer-control d-flex align-items-center mb-2 p-2 rounded";
      div.dataset.layerName = name;
      div.draggable = true;
      div.style.cursor = "move";

      const checkboxId = `${name}-toggle`;
      const supportsColorPicker =
        info.supportsColorPicker !== false && name !== "customPlaces";
      const supportsOpacitySlider =
        info.supportsOpacitySlider !== false && name !== "customPlaces";
      const colorValue =
        typeof info.color === "string" ? info.color : "#ffffff";

      const controls = [];

      if (supportsColorPicker) {
        controls.push(`
          <input type="color" id="${name}-color" value="${colorValue}"
                 class="form-control form-control-color me-2"
                 style="width: 30px; height: 30px; padding: 2px;"
                 title="Layer color">
        `);
      }

      if (supportsOpacitySlider) {
        controls.push(`
          <input type="range" id="${name}-opacity" min="0" max="1" step="0.1"
                 value="${info.opacity}" class="form-range" style="width: 80px;"
                 title="Layer opacity">
        `);
      }

      div.innerHTML = `
        <i class="fas fa-grip-vertical me-2 text-secondary" style="cursor: move;" aria-hidden="true"></i>
        <div class="form-check form-switch me-auto">
          <input class="form-check-input" type="checkbox" id="${checkboxId}"
                 ${info.visible ? "checked" : ""} role="switch">
          <label class="form-check-label" for="${checkboxId}">
            ${info.name || name}
            <span class="layer-loading d-none" id="${name}-loading"></span>
          </label>
        </div>
        ${controls.join("")}
      `;

      fragment.appendChild(div);
    });

    container.appendChild(fragment);
    this._setupControlEventListeners(container);
    this._setupDragAndDrop(container);
    this.syncVisibilityToStore();
  },

  /**
   * Set up event listeners for layer controls
   * @private
   */
  _setupControlEventListeners(container) {
    container.addEventListener(
      "change",
      utils.debounce((e) => {
        const input = e.target;
        const layerName = input.closest(".layer-control")?.dataset.layerName;
        if (!layerName) return;

        if (input.type === "checkbox") {
          this.toggleLayer(layerName, input.checked);
        } else if (input.type === "color") {
          this.updateLayerStyle(layerName, "color", input.value);
        } else if (input.type === "range") {
          this.updateLayerStyle(layerName, "opacity", parseFloat(input.value));
        }

        this.saveLayerSettings();
      }, 200),
    );
  },

  /**
   * Set up drag and drop for layer reordering
   * @private
   */
  _setupDragAndDrop(container) {
    let draggedElement = null;

    container.addEventListener("dragstart", (e) => {
      const { target } = e;
      // Prevent drag on interactive elements
      if (
        target.tagName === "INPUT" ||
        target.tagName === "LABEL" ||
        target.closest("input") ||
        target.closest("label") ||
        target.closest("button")
      ) {
        e.preventDefault();
        return;
      }

      draggedElement = target.closest(".layer-control");
      if (draggedElement) {
        draggedElement.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/html", draggedElement.outerHTML);
      }
    });

    container.addEventListener("dragend", () => {
      if (draggedElement) {
        draggedElement.classList.remove("dragging");
        draggedElement = null;
        this._reorderLayersFromUI();
      }
    });

    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (!draggedElement) return;

      const afterElement = this._getDragAfterElement(container, e.clientY);
      if (afterElement == null) {
        container.appendChild(draggedElement);
      } else {
        container.insertBefore(draggedElement, afterElement);
      }
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
    });
  },

  /**
   * Get element to insert dragged element after
   * @private
   */
  _getDragAfterElement(container, y) {
    const draggableElements = [
      ...container.querySelectorAll(".layer-control:not(.dragging)"),
    ];

    return draggableElements.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY },
    ).element;
  },

  /**
   * Reorder map layers based on UI order
   * @private
   */
  _reorderLayersFromUI() {
    const container = utils.getElement("layer-toggles");
    if (!container) return;

    // Update order in state
    Array.from(container.children).forEach((item, index) => {
      const { layerName } = item.dataset;
      if (state.mapLayers[layerName]) {
        state.mapLayers[layerName].order = index;
      }
    });

    // Reorder layers on map
    if (state.map && state.mapInitialized) {
      const sortedLayers = Object.entries(state.mapLayers).sort(
        ([, a], [, b]) => (b.order || 0) - (a.order || 0),
      );

      let beforeLayer = null;
      sortedLayers.forEach(([name]) => {
        const layerId = `${name}-layer`;
        if (state.map.getLayer(layerId)) {
          if (beforeLayer) {
            state.map.moveLayer(layerId, beforeLayer);
          }
          beforeLayer = layerId;
        }
      });
    }

    this.saveLayerSettings();
  },

  // ============================================================
  // Heatmap Event Management
  // ============================================================

  /**
   * Bind heatmap refresh events on map move
   */
  bindHeatmapEvents() {
    if (this._heatmapEventsBound || !state.map) return;

    const refreshHeatmaps = utils.debounce(() => {
      if (!state.map || !state.mapInitialized) return;

      Object.entries(state.mapLayers).forEach(([layerName, info]) => {
        if (info?.isHeatmap && info.visible) {
          this._refreshHeatmapStyle(layerName);
        }
      });
    }, 150);

    this._heatmapRefreshHandler = refreshHeatmaps;
    state.map.on("moveend", refreshHeatmaps);
    this._heatmapEventsBound = true;
  },

  // ============================================================
  // Layer Toggle and Visibility
  // ============================================================

  /**
   * Sync visibility state to store
   */
  syncVisibilityToStore() {
    const visibility = {};
    Object.entries(state.mapLayers).forEach(([layerName, info]) => {
      visibility[layerName] = info.visible;
    });
    store.updateLayerVisibility(visibility, { source: "layers" });
  },

  /**
   * Toggle layer visibility
   * @param {string} name - Layer name
   * @param {boolean} visible - Visibility state
   */
  async toggleLayer(name, visible) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;

    // Show loading indicator
    const loadingEl = document.getElementById(`${name}-loading`);
    if (loadingEl) {
      loadingEl.classList.remove("d-none");
    }

    try {
      // Load data if needed (emits event for data-manager to handle)
      if (visible && !layerInfo.layer) {
        document.dispatchEvent(
          new CustomEvent("layerDataNeeded", { detail: { layerName: name } }),
        );
      }

      if (layerInfo.isHeatmap) {
        await this._toggleHeatmapLayer(name, layerInfo, visible);
      } else {
        await this._toggleStandardLayer(name, layerInfo, visible);
      }
    } finally {
      if (loadingEl) {
        loadingEl.classList.add("d-none");
      }
      this.syncVisibilityToStore();
    }
  },

  /**
   * Toggle heatmap layer visibility
   * @private
   */
  async _toggleHeatmapLayer(name, layerInfo, visible) {
    const firstGlowLayer = `${name}-layer-0`;

    if (state.map?.getLayer(firstGlowLayer)) {
      this._updateHeatmapLayersVisibility(name, layerInfo, visible);
      if (visible) {
        this._scheduleHeatmapRefresh(name);
      }
    } else if (visible && layerInfo.layer) {
      await this.updateMapLayer(name, layerInfo.layer);
    }

    this._updateHitboxVisibility(name, visible);
  },

  /**
   * Update heatmap layer visibility with opacity animation
   * @private
   */
  _updateHeatmapLayersVisibility(name, layerInfo, visible) {
    const tripCount = layerInfo.layer?.features?.length || 0;
    const visibleTripCount = this._getHeatmapTripCountInView(name, tripCount);
    const opacities = heatmapUtils.getUpdatedOpacities(
      visibleTripCount,
      layerInfo.opacity ?? 1,
    );

    for (let i = 0; i < 2; i++) {
      const glowLayerId = `${name}-layer-${i}`;
      if (state.map.getLayer(glowLayerId)) {
        this._fadeLayer(glowLayerId, visible, opacities[i]);
      }
    }
  },

  /**
   * Toggle standard (non-heatmap) layer visibility
   * @private
   */
  async _toggleStandardLayer(name, layerInfo, visible) {
    const layerId = `${name}-layer`;

    if (state.map?.getLayer(layerId)) {
      this._fadeLayer(layerId, visible, layerInfo.opacity);
    } else if (visible && layerInfo.layer) {
      await this.updateMapLayer(name, layerInfo.layer);
    }

    this._updateHitboxVisibility(name, visible);
  },

  /**
   * Fade layer in/out with animation
   * @private
   */
  _fadeLayer(layerId, visible, fallbackOpacity = 1) {
    if (!state.map?.getLayer(layerId)) return;

    const layerType = state.map.getLayer(layerId).type;
    const opacityProp = this._getOpacityProperty(layerType);

    if (!opacityProp) {
      state.map.setLayoutProperty(
        layerId,
        "visibility",
        visible ? "visible" : "none",
      );
      return;
    }

    const transition = { duration: FADE_DURATION, delay: 0 };
    const targetOpacity = visible ? fallbackOpacity : 0;

    if (visible) {
      state.map.setLayoutProperty(layerId, "visibility", "visible");
    }

    state.map.setPaintProperty(
      layerId,
      `${opacityProp}-transition`,
      transition,
    );
    state.map.setPaintProperty(layerId, opacityProp, targetOpacity);

    if (!visible) {
      setTimeout(() => {
        if (state.map?.getLayer(layerId)) {
          state.map.setLayoutProperty(layerId, "visibility", "none");
        }
      }, transition.duration);
    }
  },

  /**
   * Get opacity property name for layer type
   * @private
   */
  _getOpacityProperty(layerType) {
    const opacityProps = {
      line: "line-opacity",
      fill: "fill-opacity",
      circle: "circle-opacity",
      symbol: "icon-opacity",
    };
    return opacityProps[layerType] || null;
  },

  /**
   * Update hitbox layer visibility
   * @private
   */
  _updateHitboxVisibility(name, visible) {
    const hitboxLayerId = `${name}-hitbox`;
    if (state.map?.getLayer(hitboxLayerId)) {
      state.map.setLayoutProperty(
        hitboxLayerId,
        "visibility",
        visible ? "visible" : "none",
      );
    }
  },

  // ============================================================
  // Layer Style Updates
  // ============================================================

  /**
   * Update layer style property
   * @param {string} name - Layer name
   * @param {string} property - Property to update (color, opacity)
   * @param {*} value - New value
   */
  updateLayerStyle(name, property, value) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) return;

    layerInfo[property] = value;

    // Handle heatmap layers (2 stacked glow layers)
    if (layerInfo.isHeatmap) {
      if (property === "opacity") {
        const tripCount = layerInfo.layer?.features?.length || 0;
        const visibleTripCount = this._getHeatmapTripCountInView(
          name,
          tripCount,
        );
        const opacities = heatmapUtils.getUpdatedOpacities(
          visibleTripCount,
          value,
        );

        for (let i = 0; i < 2; i++) {
          const glowLayerId = `${name}-layer-${i}`;
          if (state.map?.getLayer(glowLayerId)) {
            state.map.setPaintProperty(
              glowLayerId,
              "line-opacity",
              opacities[i],
            );
          }
        }
      }
      return;
    }

    // Handle standard layers
    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      const paintProperty =
        property === "color" ? "line-color" : "line-opacity";
      state.map.setPaintProperty(layerId, paintProperty, value);
    }
  },

  /**
   * Save layer settings to storage
   */
  saveLayerSettings() {
    const settings = {};
    Object.entries(state.mapLayers).forEach(([name, info]) => {
      settings[name] = {
        visible: info.visible,
        color: info.color,
        opacity: info.opacity,
        order: info.order,
      };
    });
    utils.setStorage(CONFIG.STORAGE_KEYS.layerSettings, settings);
  },

  // ============================================================
  // Heatmap Utilities
  // ============================================================

  /**
   * Get count of unique trips visible in current viewport
   * @private
   */
  _getHeatmapTripCountInView(layerName, fallbackCount) {
    if (!state.map || !state.mapInitialized) return fallbackCount;

    const layerId = `${layerName}-layer-1`;
    if (!state.map.getLayer(layerId)) return fallbackCount;

    const rendered = state.map.queryRenderedFeatures({ layers: [layerId] });
    if (!rendered?.length) return 0;

    const uniqueTrips = new Set();
    rendered.forEach((feature, index) => {
      const id =
        feature.properties?.transactionId ??
        feature.properties?.id ??
        feature.id ??
        `rendered-${index}`;
      uniqueTrips.add(String(id));
    });

    return uniqueTrips.size;
  },

  /**
   * Refresh heatmap style based on current view
   * @private
   */
  _refreshHeatmapStyle(layerName) {
    const layerInfo = state.mapLayers[layerName];
    if (!layerInfo?.isHeatmap || !layerInfo.layer || !state.map) return;

    const theme =
      document.documentElement.getAttribute("data-bs-theme") || "dark";
    const totalTripCount = layerInfo.layer?.features?.length || 0;
    const visibleTripCount = this._getHeatmapTripCountInView(
      layerName,
      totalTripCount,
    );

    const { glowLayers } = heatmapUtils.generateHeatmapConfig(layerInfo.layer, {
      theme,
      opacity: layerInfo.opacity,
      visibleTripCount,
    });

    glowLayers.forEach((glowConfig, index) => {
      const glowLayerId = `${layerName}-layer-${index}`;
      if (!state.map.getLayer(glowLayerId)) return;

      state.map.setPaintProperty(
        glowLayerId,
        "line-color",
        glowConfig.paint["line-color"],
      );
      state.map.setPaintProperty(
        glowLayerId,
        "line-width",
        glowConfig.paint["line-width"],
      );
      state.map.setPaintProperty(
        glowLayerId,
        "line-opacity",
        glowConfig.paint["line-opacity"],
      );

      if (glowConfig.paint["line-blur"] !== undefined) {
        state.map.setPaintProperty(
          glowLayerId,
          "line-blur",
          glowConfig.paint["line-blur"],
        );
      }
    });
  },

  /**
   * Schedule heatmap refresh on next idle
   * Fixed: Only use map.once('idle'), not both requestAnimationFrame AND idle
   * @private
   */
  _scheduleHeatmapRefresh(layerName) {
    if (!state.map) return;

    // Use only map idle event to prevent double refresh
    state.map.once("idle", () => {
      this._refreshHeatmapStyle(layerName);
    });
  },

  // ============================================================
  // Layer Update (Main Entry Point)
  // ============================================================

  /**
   * Update or create a map layer with new data
   * @param {string} layerName - Layer name
   * @param {Object} data - GeoJSON data
   */
  async updateMapLayer(layerName, data) {
    if (!state.map || !state.mapInitialized || !data) return;

    const sourceId = `${layerName}-source`;
    const layerId = `${layerName}-layer`;
    const layerInfo = state.mapLayers[layerName];

    try {
      await this._ensureStyleLoaded();

      if (layerInfo.isHeatmap) {
        await this._updateHeatmapLayer(
          layerName,
          data,
          sourceId,
          layerId,
          layerInfo,
        );
        return;
      }

      const existingSource = state.map.getSource(sourceId);
      const existingLayer = state.map.getLayer(layerId);

      // Try fast path: update existing source
      if (existingSource && existingLayer) {
        const updateSuccess = await this._tryUpdateExistingLayer(
          layerName,
          layerId,
          sourceId,
          layerInfo,
          data,
        );
        if (updateSuccess) return;
      }

      // Fallback: rebuild layer from scratch
      await this._rebuildLayer(layerName, layerId, sourceId, layerInfo, data);
    } catch (error) {
      console.error(`Error updating ${layerName} layer:`, error);
      window.notificationManager?.show(
        `Failed to update ${layerName} layer`,
        "warning",
      );
    }
  },

  /**
   * Wait for map style to be fully loaded
   * @private
   */
  async _ensureStyleLoaded() {
    if (!state.map.isStyleLoaded()) {
      await new Promise((resolve) => {
        const onStyleData = () => {
          if (state.map.isStyleLoaded()) {
            state.map.off("styledata", onStyleData);
            resolve();
          }
        };
        state.map.on("styledata", onStyleData);
        // Fallback timeout
        setTimeout(() => {
          state.map.off("styledata", onStyleData);
          resolve();
        }, 2000);
      });
    }
  },

  /**
   * Try to update existing layer (fast path)
   * @private
   */
  async _tryUpdateExistingLayer(layerName, layerId, sourceId, layerInfo, data) {
    try {
      const existingSource = state.map.getSource(sourceId);
      existingSource.setData(data);

      this._updateLayerPaintProperties(layerId, layerInfo);
      state.map.setLayoutProperty(
        layerId,
        "visibility",
        layerInfo.visible ? "visible" : "none",
      );

      layerInfo.layer = data;

      if (this._shouldEnableTripInteractions(layerName)) {
        await this._setupTripInteractions(layerName, sourceId, layerInfo);
      }

      return true;
    } catch (updateError) {
      console.warn(
        `Falling back to layer rebuild for ${layerName}:`,
        updateError,
      );
      return false;
    }
  },

  /**
   * Update layer paint properties
   * @private
   */
  _updateLayerPaintProperties(layerId, layerInfo) {
    const colorValue = Array.isArray(layerInfo.color)
      ? layerInfo.color
      : layerInfo.color || "#331107";

    state.map.setPaintProperty(layerId, "line-color", colorValue);
    state.map.setPaintProperty(layerId, "line-opacity", layerInfo.opacity);
    state.map.setPaintProperty(layerId, "line-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      layerInfo.weight * 0.5,
      15,
      layerInfo.weight,
      20,
      layerInfo.weight * 2,
    ]);
  },

  /**
   * Rebuild layer from scratch
   * @private
   */
  async _rebuildLayer(layerName, layerId, sourceId, layerInfo, data) {
    this._removeExistingLayerAndSource(layerName, layerId, sourceId);

    // Wait a frame for cleanup to complete
    await new Promise((resolve) => requestAnimationFrame(resolve));

    this._createSource(sourceId, data);
    this._createLayer(layerName, layerId, sourceId, layerInfo);

    if (state.map.getLayer(layerId)) {
      state.map.setLayoutProperty(
        layerId,
        "visibility",
        layerInfo.visible ? "visible" : "none",
      );
    }

    if (this._shouldEnableTripInteractions(layerName)) {
      await this._setupTripInteractions(layerName, sourceId, layerInfo);
    }

    layerInfo.layer = data;
  },

  /**
   * Remove existing layer and source
   * @private
   */
  _removeExistingLayerAndSource(layerName, layerId, sourceId) {
    const existingSource = state.map.getSource(sourceId);
    const existingLayer = state.map.getLayer(layerId);

    if (existingLayer || existingSource) {
      if (this._shouldEnableTripInteractions(layerName)) {
        this._removeTripHitboxLayer(layerName);
      }
    }

    if (existingLayer) {
      ["click", "mouseenter", "mouseleave"].forEach((event) => {
        state.map.off(event, layerId);
      });
      state.map.removeLayer(layerId);
    }

    if (existingSource) {
      state.map.removeSource(sourceId);
    }
  },

  /**
   * Create GeoJSON source
   * @private
   */
  _createSource(sourceId, data) {
    state.map.addSource(sourceId, {
      type: "geojson",
      data,
      tolerance: 0.375,
      buffer: 64,
      maxzoom: 18,
      generateId: true,
      promoteId: "transactionId",
    });
  },

  /**
   * Create line layer
   * @private
   */
  _createLayer(layerName, layerId, sourceId, layerInfo) {
    const layerConfig = {
      id: layerId,
      type: "line",
      source: sourceId,
      minzoom: layerInfo.minzoom || 0,
      maxzoom: layerInfo.maxzoom || 22,
      layout: {
        visibility: layerInfo.visible ? "visible" : "none",
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": Array.isArray(layerInfo.color)
          ? layerInfo.color
          : layerInfo.color || "#331107",
        "line-opacity": layerInfo.opacity,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          layerInfo.weight * 0.5,
          15,
          layerInfo.weight,
          20,
          layerInfo.weight * 2,
        ],
      },
    };

    if (layerName === "undrivenStreets") {
      layerConfig.paint["line-dasharray"] = [2, 2];
    }

    state.map.addLayer(layerConfig);
  },

  // ============================================================
  // Heatmap Layer Management
  // ============================================================

  /**
   * Update or create heatmap layer (2 stacked glow layers)
   * @private
   */
  async _updateHeatmapLayer(layerName, data, sourceId, _layerId, layerInfo) {
    const theme =
      document.documentElement.getAttribute("data-bs-theme") || "dark";
    const totalTripCount = data?.features?.length || 0;
    const visibleTripCount = this._getHeatmapTripCountInView(
      layerName,
      totalTripCount,
    );

    const heatmapConfig = heatmapUtils.generateHeatmapConfig(data, {
      theme,
      opacity: layerInfo.opacity,
      visibleTripCount,
    });

    const { glowLayers } = heatmapConfig;

    const existingSource = state.map.getSource(sourceId);
    const firstGlowLayerId = `${layerName}-layer-0`;
    const existingGlowLayer = state.map.getLayer(firstGlowLayerId);

    // Fast path: update existing source and layer paint properties
    if (existingSource && existingGlowLayer) {
      try {
        existingSource.setData(data);

        glowLayers.forEach((glowConfig, index) => {
          const glowLayerId = `${layerName}-layer-${index}`;
          if (state.map.getLayer(glowLayerId)) {
            state.map.setPaintProperty(
              glowLayerId,
              "line-color",
              glowConfig.paint["line-color"],
            );
            state.map.setPaintProperty(
              glowLayerId,
              "line-width",
              glowConfig.paint["line-width"],
            );
            state.map.setPaintProperty(
              glowLayerId,
              "line-opacity",
              glowConfig.paint["line-opacity"],
            );

            if (glowConfig.paint["line-blur"] !== undefined) {
              state.map.setPaintProperty(
                glowLayerId,
                "line-blur",
                glowConfig.paint["line-blur"],
              );
            }

            state.map.setLayoutProperty(
              glowLayerId,
              "visibility",
              layerInfo.visible ? "visible" : "none",
            );
          }
        });

        layerInfo.layer = data;
        this._scheduleHeatmapRefresh(layerName);

        if (this._shouldEnableTripInteractions(layerName)) {
          await this._setupTripInteractions(layerName, sourceId, layerInfo);
        }

        return;
      } catch (updateError) {
        console.warn(
          `Falling back to heatmap layer rebuild for ${layerName}:`,
          updateError,
        );
      }
    }

    // Cleanup existing layers
    if (this._shouldEnableTripInteractions(layerName)) {
      this._removeTripHitboxLayer(layerName);
    }

    for (let i = 0; i < 2; i++) {
      const glowLayerId = `${layerName}-layer-${i}`;
      if (state.map.getLayer(glowLayerId)) {
        state.map.removeLayer(glowLayerId);
      }
    }

    if (existingSource) {
      state.map.removeSource(sourceId);
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Create new source
    state.map.addSource(sourceId, {
      type: "geojson",
      data,
      tolerance: 0.375,
      buffer: 64,
      maxzoom: 18,
      lineMetrics: true,
    });

    // Create stacked glow layers
    glowLayers.forEach((glowConfig, index) => {
      const glowLayerId = `${layerName}-layer-${index}`;

      state.map.addLayer({
        id: glowLayerId,
        type: "line",
        source: sourceId,
        minzoom: layerInfo.minzoom || 0,
        maxzoom: layerInfo.maxzoom || 22,
        layout: {
          visibility: layerInfo.visible ? "visible" : "none",
          "line-join": "round",
          "line-cap": "round",
        },
        paint: glowConfig.paint,
      });
    });

    layerInfo.layer = data;
    this._scheduleHeatmapRefresh(layerName);

    if (this._shouldEnableTripInteractions(layerName)) {
      await this._setupTripInteractions(layerName, sourceId, layerInfo);
    }
  },

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Clean up all event handlers and layers
   */
  cleanup() {
    if (!state.map) return;

    // Remove heatmap refresh handler
    if (this._heatmapRefreshHandler) {
      state.map.off("moveend", this._heatmapRefreshHandler);
      this._heatmapRefreshHandler = null;
      this._heatmapEventsBound = false;
    }

    // Remove all tracked layer handlers
    if (this._layerCleanupMap) {
      for (const [layerId, entry] of this._layerCleanupMap) {
        const handlers = entry?.handlers || entry || {};

        if (state.map.getLayer(layerId)) {
          Object.entries(handlers).forEach(([event, handler]) => {
            state.map.off(event, layerId, handler);
          });
          state.map.removeLayer(layerId);
        }

        const sourceId =
          entry?.sourceId || layerId.replace("-layer", "-source");
        const removeSource = entry?.removeSource !== false;

        if (removeSource && sourceId && state.map.getSource(sourceId)) {
          state.map.removeSource(sourceId);
        }
      }

      this._layerCleanupMap.clear();
    }
  },
};

export default layerManager;
