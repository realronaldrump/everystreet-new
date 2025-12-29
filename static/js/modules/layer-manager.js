import { CONFIG } from "./config.js";
import dataManager from "./data-manager.js";
import heatmapUtils from "./heatmap-utils.js";
import mapManager from "./map-manager.js";
import state from "./state.js";
import utils from "./utils.js";

// Extracted from app.js – unchanged except minimal path updates.
const layerManager = {
  // Track event handlers for cleanup
  _layerCleanupMap: new Map(),

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

    // Sort layers by order before creating elements
    const sortedLayers = Object.entries(state.mapLayers)
      .filter(([name]) => !streetLayers.includes(name))
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

    sortedLayers.forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className = "layer-control d-flex align-items-center mb-2 p-2 rounded";
      div.dataset.layerName = name;
      div.draggable = true;
      div.style.cursor = "move";

      const checkboxId = `${name}-toggle`;
      const supportsColorPicker =
        info.supportsColorPicker !== false && name !== "customPlaces";
      const supportsOpacitySlider =
        info.supportsOpacitySlider !== false && name !== "customPlaces";
      const colorValue = typeof info.color === "string" ? info.color : "#ffffff";

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
  },

  setupEventListeners(container) {
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
      }, 200)
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

      if (!draggedElement) return;

      const afterElement = this.getDragAfterElementForLayers(container, e.clientY);
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
      { offset: Number.NEGATIVE_INFINITY }
    ).element;
  },

  reorderLayersFromVisible() {
    const container = utils.getElement("layer-toggles");
    if (!container) return;

    Array.from(container.children).forEach((item, index) => {
      const { layerName } = item.dataset;
      if (state.mapLayers[layerName]) {
        state.mapLayers[layerName].order = index;
      }
    });

    if (state.map && state.mapInitialized) {
      const sortedLayers = Object.entries(state.mapLayers).sort(
        ([, a], [, b]) => (b.order || 0) - (a.order || 0)
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
    if (!layerInfo) return;

    layerInfo.visible = visible;

    const loadingEl = document.getElementById(`${name}-loading`);
    if (loadingEl) loadingEl.classList.remove("d-none");

    if (visible) {
      if (name === "matchedTrips" && !layerInfo.layer) {
        await dataManager.fetchMatchedTrips();
      } else if (name === "undrivenStreets" && !state.undrivenStreetsLoaded) {
        await dataManager.fetchUndrivenStreets();
      } else if (name === "drivenStreets" && !state.drivenStreetsLoaded) {
        await dataManager.fetchDrivenStreets();
      } else if (name === "allStreets" && !state.allStreetsLoaded) {
        await dataManager.fetchAllStreets();
      }
    }

    // Handle heatmap layers (2 stacked glow layers)
    if (layerInfo.isHeatmap) {
      const firstGlowLayer = `${name}-layer-0`;
      if (state.map?.getLayer(firstGlowLayer)) {
        for (let i = 0; i < 2; i++) {
          const glowLayerId = `${name}-layer-${i}`;
          if (state.map.getLayer(glowLayerId)) {
            state.map.setLayoutProperty(
              glowLayerId,
              "visibility",
              visible ? "visible" : "none"
            );
          }
        }
      } else if (visible && layerInfo.layer) {
        await this.updateMapLayer(name, layerInfo.layer);
      }
      if (loadingEl) loadingEl.classList.add("d-none");
      return;
    }

    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      state.map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    } else if (visible && layerInfo.layer) {
      await this.updateMapLayer(name, layerInfo.layer);
    }

    if (loadingEl) loadingEl.classList.add("d-none");
  },

  updateLayerStyle(name, property, value) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) return;

    layerInfo[property] = value;

    // Handle heatmap layers (2 stacked glow layers)
    if (layerInfo.isHeatmap) {
      if (property === "opacity") {
        const tripCount = layerInfo.layer?.features?.length || 0;
        const opacities = heatmapUtils.getUpdatedOpacities(tripCount, value);

        for (let i = 0; i < 2; i++) {
          const glowLayerId = `${name}-layer-${i}`;
          if (state.map?.getLayer(glowLayerId)) {
            state.map.setPaintProperty(glowLayerId, "line-opacity", opacities[i]);
          }
        }
      }
      return;
    }

    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      const paintProperty = property === "color" ? "line-color" : "line-opacity";
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

  async updateMapLayer(layerName, data) {
    if (!state.map || !state.mapInitialized || !data) return;

    const sourceId = `${layerName}-source`;
    const layerId = `${layerName}-layer`;
    const layerInfo = state.mapLayers[layerName];

    try {
      if (!state.map.isStyleLoaded()) {
        await new Promise((resolve) => {
          state.map.once("styledata", resolve);
          setTimeout(resolve, 1000);
        });
      }

      // Handle heatmap layers
      if (layerInfo.isHeatmap) {
        await this._updateHeatmapLayer(layerName, data, sourceId, layerId, layerInfo);
        return;
      }

      const existingSource = state.map.getSource(sourceId);
      const existingLayer = state.map.getLayer(layerId);

      if (existingSource && existingLayer) {
        try {
          existingSource.setData(data);

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

          state.map.setLayoutProperty(
            layerId,
            "visibility",
            layerInfo.visible ? "visible" : "none"
          );

          layerInfo.layer = data;
          return;
        } catch (updateError) {
          console.warn(`Falling back to layer rebuild for ${layerName}:`, updateError);
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

      await new Promise((resolve) => requestAnimationFrame(resolve));

      state.map.addSource(sourceId, {
        type: "geojson",
        data,
        tolerance: 0.375,
        buffer: 64,
        maxzoom: 18,
        generateId: true,
        promoteId: "transactionId",
      });

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

      if (state.map.getLayer(layerId)) {
        state.map.setLayoutProperty(
          layerId,
          "visibility",
          layerInfo.visible ? "visible" : "none"
        );
      }

      if (layerName === "matchedTrips") {
        const tripInteractions = (await import("./trip-interactions.js")).default;
        const clickHandler = (e) => {
          e.originalEvent.stopPropagation();
          if (e.features?.length > 0) {
            tripInteractions.handleTripClick(e, e.features[0]);
          }
        };
        const mouseEnterHandler = () => {
          state.map.getCanvas().style.cursor = "pointer";
        };
        const mouseLeaveHandler = () => {
          state.map.getCanvas().style.cursor = "";
        };

        state.map.on("click", layerId, clickHandler);
        state.map.on("mouseenter", layerId, mouseEnterHandler);
        state.map.on("mouseleave", layerId, mouseLeaveHandler);

        if (!this._layerCleanupMap) this._layerCleanupMap = new Map();
        this._layerCleanupMap.set(layerId, {
          click: clickHandler,
          mouseenter: mouseEnterHandler,
          mouseleave: mouseLeaveHandler,
        });

        requestAnimationFrame(() => {
          try {
            mapManager.refreshTripStyles();
          } catch (e) {
            console.warn("Failed to refresh trip styles after layer add", e);
          }
        });
      }

      layerInfo.layer = data;
    } catch (error) {
      console.error(`Error updating ${layerName} layer:`, error);
      window.notificationManager.show(`Failed to update ${layerName} layer`, "warning");
    }
  },

  /**
   * Update or create a Strava-style heatmap using 2 stacked glow line layers.
   */
  async _updateHeatmapLayer(layerName, data, sourceId, _layerId, layerInfo) {
    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";

    const heatmapConfig = heatmapUtils.generateHeatmapConfig(data, {
      theme,
      opacity: layerInfo.opacity,
    });

    const { tripCount, glowLayers } = heatmapConfig;

    console.log(
      `Heatmap: ${tripCount} trips, creating ${glowLayers.length} glow layers`
    );

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
              glowConfig.paint["line-color"]
            );
            state.map.setPaintProperty(
              glowLayerId,
              "line-width",
              glowConfig.paint["line-width"]
            );
            state.map.setPaintProperty(
              glowLayerId,
              "line-opacity",
              glowConfig.paint["line-opacity"]
            );
            if (glowConfig.paint["line-blur"] !== undefined) {
              state.map.setPaintProperty(
                glowLayerId,
                "line-blur",
                glowConfig.paint["line-blur"]
              );
            }
            state.map.setLayoutProperty(
              glowLayerId,
              "visibility",
              layerInfo.visible ? "visible" : "none"
            );
          }
        });

        layerInfo.layer = data;
        return;
      } catch (updateError) {
        console.warn(
          `Falling back to heatmap layer rebuild for ${layerName}:`,
          updateError
        );
      }
    }

    // Clean up existing glow layers (2 layers)
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
  },

  cleanup() {
    if (!state.map) return;

    if (this._layerCleanupMap) {
      for (const [layerId, handlers] of this._layerCleanupMap) {
        if (state.map.getLayer(layerId)) {
          Object.entries(handlers).forEach(([event, handler]) => {
            state.map.off(event, layerId, handler);
          });
          state.map.removeLayer(layerId);
        }
        const sourceId = layerId.replace("-layer", "-source");
        if (state.map.getSource(sourceId)) {
          state.map.removeSource(sourceId);
        }
      }
      this._layerCleanupMap.clear();
    }
  },
};

export default layerManager;
