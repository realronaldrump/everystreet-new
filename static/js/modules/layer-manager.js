import { CONFIG } from "./config.js";
import dataManager from "./data-manager.js";
import heatmapUtils from "./heatmap-utils.js";
import mapManager from "./map-manager.js";
import store from "./spa/store.js";
import state from "./state.js";
import { utils } from "./utils.js";

const INTERACTIVE_TRIP_LAYERS = new Set(["trips", "matchedTrips"]);

// Extracted from app.js – unchanged except minimal path updates.
const layerManager = {
  // Track event handlers for cleanup
  _layerCleanupMap: new Map(),
  _heatmapEventsBound: false,
  _heatmapRefreshHandler: null,

  _shouldEnableTripInteractions(layerName) {
    return INTERACTIVE_TRIP_LAYERS.has(layerName);
  },

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

  _getTripHitboxOpacity() {
    const deviceProfile = utils.getDeviceProfile?.() || {};
    return deviceProfile.isMobile ? 0.03 : 0.02;
  },

  _removeTripHitboxLayer(layerName) {
    if (!state.map) {
      return;
    }
    const hitboxLayerId = `${layerName}-hitbox`;
    if (state.map.getLayer(hitboxLayerId)) {
      ["click", "mouseenter", "mouseleave"].forEach((event) => {
        state.map.off(event, hitboxLayerId);
      });
      state.map.removeLayer(hitboxLayerId);
    }
    this._layerCleanupMap?.delete(hitboxLayerId);
  },

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
      // Ensure hitbox is on top for interactivity - layers added later may have buried it
      state.map.moveLayer(hitboxLayerId);
    }

    const tripInteractions = (await import("./trip-interactions.js")).default;
    const clickHandler = (e) => {
      if (
        typeof e.originalEvent?.button === "number" &&
        e.originalEvent.button !== 0
      ) {
        return;
      }
      if (typeof state.map?.isMoving === "function" && state.map.isMoving()) {
        return;
      }
      if (layerName === "trips" && state.map.getLayer("matchedTrips-hitbox")) {
        const matchedHits = state.map.queryRenderedFeatures(e.point, {
          layers: ["matchedTrips-hitbox"],
        });
        if (matchedHits.length > 0) {
          return;
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

    ["click", "mouseenter", "mouseleave"].forEach((event) => {
      state.map.off(event, hitboxLayerId);
    });
    state.map.on("click", hitboxLayerId, clickHandler);
    state.map.on("mouseenter", hitboxLayerId, mouseEnterHandler);
    state.map.on("mouseleave", hitboxLayerId, mouseLeaveHandler);

    if (!this._layerCleanupMap) {
      this._layerCleanupMap = new Map();
    }
    this._layerCleanupMap.set(hitboxLayerId, {
      handlers: {
        click: clickHandler,
        mouseenter: mouseEnterHandler,
        mouseleave: mouseLeaveHandler,
      },
      sourceId,
      removeSource: false,
    });

    requestAnimationFrame(() => {
      try {
        mapManager.refreshTripStyles();
      } catch (e) {
        console.warn("Failed to refresh trip styles after hitbox add", e);
      }
    });
  },

  initializeControls() {
    const container = utils.getElement("layer-toggles");
    if (!container) {
      return;
    }

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

    // Sort layers by order before creating elements
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

      const controlsMarkup = controls.join("");

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
          ${controlsMarkup}
        `;

      fragment.appendChild(div);
    });

    container.appendChild(fragment);
    this.setupEventListeners(container);
    this.setupDragAndDropForLayers(container);
    this.syncVisibilityToStore();
  },

  bindHeatmapEvents() {
    if (this._heatmapEventsBound || !state.map) {
      return;
    }

    const refreshHeatmaps = utils.debounce(() => {
      if (!state.map || !state.mapInitialized) {
        return;
      }
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

  setupEventListeners(container) {
    container.addEventListener(
      "change",
      utils.debounce((e) => {
        const input = e.target;
        const layerName = input.closest(".layer-control")?.dataset.layerName;
        if (!layerName) {
          return;
        }

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

  setupDragAndDropForLayers(container) {
    let draggedElement = null;

    container.addEventListener("dragstart", (e) => {
      const { target } = e;
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
        this.reorderLayersFromVisible();
      }
    });

    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (!draggedElement) {
        return;
      }

      const afterElement = this.getDragAfterElementForLayers(
        container,
        e.clientY,
      );
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

  getDragAfterElementForLayers(container, y) {
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

  reorderLayersFromVisible() {
    const container = utils.getElement("layer-toggles");
    if (!container) {
      return;
    }

    Array.from(container.children).forEach((item, index) => {
      const { layerName } = item.dataset;
      if (state.mapLayers[layerName]) {
        state.mapLayers[layerName].order = index;
      }
    });

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

  async toggleLayer(name, visible) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) {
      return;
    }

    layerInfo.visible = visible;

    const loadingEl = document.getElementById(`${name}-loading`);
    if (loadingEl) {
      loadingEl.classList.remove("d-none");
    }

    if (visible) {
      await this._loadLayerDataIfNeeded(name, layerInfo);
    }

    if (layerInfo.isHeatmap) {
      await this._toggleHeatmapLayer(name, layerInfo, visible);
    } else {
      await this._toggleStandardLayer(name, layerInfo, visible);
    }

    if (loadingEl) {
      loadingEl.classList.add("d-none");
    }

    this.syncVisibilityToStore();
  },

  syncVisibilityToStore() {
    const visibility = {};
    Object.entries(state.mapLayers).forEach(([layerName, info]) => {
      visibility[layerName] = info.visible;
    });
    store.updateLayerVisibility(visibility, { source: "layers" });
  },

  async _loadLayerDataIfNeeded(name, layerInfo) {
    if (name === "matchedTrips" && !layerInfo.layer) {
      await dataManager.fetchMatchedTrips();
    } else if (name === "undrivenStreets" && !state.undrivenStreetsLoaded) {
      await dataManager.fetchUndrivenStreets();
    } else if (name === "drivenStreets" && !state.drivenStreetsLoaded) {
      await dataManager.fetchDrivenStreets();
    } else if (name === "allStreets" && !state.allStreetsLoaded) {
      await dataManager.fetchAllStreets();
    }
  },

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

  async _toggleStandardLayer(name, layerInfo, visible) {
    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      this._fadeLayer(layerId, visible, layerInfo.opacity);
    } else if (visible && layerInfo.layer) {
      await this.updateMapLayer(name, layerInfo.layer);
    }
    this._updateHitboxVisibility(name, visible);
  },

  _fadeLayer(layerId, visible, fallbackOpacity = 1) {
    if (!state.map?.getLayer(layerId)) {
      return;
    }
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

    const transition = { duration: 320, delay: 0 };
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
      window.setTimeout(() => {
        if (state.map?.getLayer(layerId)) {
          state.map.setLayoutProperty(layerId, "visibility", "none");
        }
      }, transition.duration);
    }
  },

  _getOpacityProperty(layerType) {
    switch (layerType) {
      case "line":
        return "line-opacity";
      case "fill":
        return "fill-opacity";
      case "circle":
        return "circle-opacity";
      case "symbol":
        return "icon-opacity";
      default:
        return null;
    }
  },

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

  updateLayerStyle(name, property, value) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) {
      return;
    }

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

    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      const paintProperty =
        property === "color" ? "line-color" : "line-opacity";
      state.map.setPaintProperty(layerId, paintProperty, value);
    }
  },

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

  _getHeatmapTripCountInView(layerName, fallbackCount) {
    if (!state.map || !state.mapInitialized) {
      return fallbackCount;
    }
    const layerId = `${layerName}-layer-1`;
    if (!state.map.getLayer(layerId)) {
      return fallbackCount;
    }

    const rendered = state.map.queryRenderedFeatures({ layers: [layerId] });
    if (!rendered?.length) {
      return 0;
    }

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

  _refreshHeatmapStyle(layerName) {
    const layerInfo = state.mapLayers[layerName];
    if (!layerInfo?.isHeatmap || !layerInfo.layer || !state.map) {
      return;
    }

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
      if (!state.map.getLayer(glowLayerId)) {
        return;
      }

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

  _scheduleHeatmapRefresh(layerName) {
    if (!state.map) {
      return;
    }
    const refresh = () => this._refreshHeatmapStyle(layerName);
    requestAnimationFrame(refresh);
    state.map.once("idle", refresh);
  },

  async updateMapLayer(layerName, data) {
    if (!state.map || !state.mapInitialized || !data) {
      return;
    }

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

      if (existingSource && existingLayer) {
        const updateSuccess = await this._tryUpdateExistingLayer(
          layerName,
          layerId,
          sourceId,
          layerInfo,
          data,
        );
        if (updateSuccess) {
          return;
        }
      }

      await this._rebuildLayer(layerName, layerId, sourceId, layerInfo, data);
    } catch (error) {
      console.error(`Error updating ${layerName} layer:`, error);
      window.notificationManager.show(
        `Failed to update ${layerName} layer`,
        "warning",
      );
    }
  },

  async _ensureStyleLoaded() {
    if (!state.map.isStyleLoaded()) {
      await new Promise((resolve) => {
        state.map.once("styledata", resolve);
        setTimeout(resolve, 1000);
      });
    }
  },

  async _tryUpdateExistingLayer(layerName, layerId, sourceId, layerInfo, data) {
    try {
      const existingSource = state.map.getSource(sourceId);
      existingSource.setData(data);

      this._updateLayerStyles(layerId, layerInfo);
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

  _updateLayerStyles(layerId, layerInfo) {
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

  async _rebuildLayer(layerName, layerId, sourceId, layerInfo, data) {
    this._removeExistingLayerAndSource(layerName, layerId, sourceId);
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

  _removeExistingLayerAndSource(layerName, layerId, sourceId) {
    const existingSource = state.map.getSource(sourceId);
    const existingLayer = state.map.getLayer(layerId);

    if (existingLayer || existingSource) {
      if (this._shouldEnableTripInteractions(layerName)) {
        this._removeTripHitboxLayer(layerName);
      }
    }

    if (existingLayer) {
      const events = ["click", "mouseenter", "mouseleave"];
      events.forEach((event) => {
        state.map.off(event, layerId);
      });
      state.map.removeLayer(layerId);
    }
    if (existingSource) {
      state.map.removeSource(sourceId);
    }
  },

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

  /**
   * Update or create a Strava-style heatmap using 2 stacked glow line layers.
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

    // Clean up existing glow layers (2 layers)
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

      const layerConfig = {
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
      };

      state.map.addLayer(layerConfig);
    });

    layerInfo.layer = data;
    this._scheduleHeatmapRefresh(layerName);
    if (this._shouldEnableTripInteractions(layerName)) {
      await this._setupTripInteractions(layerName, sourceId, layerInfo);
    }
  },

  cleanup() {
    if (!state.map) {
      return;
    }

    if (this._heatmapRefreshHandler) {
      state.map.off("moveend", this._heatmapRefreshHandler);
      this._heatmapRefreshHandler = null;
      this._heatmapEventsBound = false;
    }

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
