import utils from "./utils.js";
import { CONFIG } from "./config.js";
import state from "./state.js";
import dataManager from "./data-manager.js";
import mapManager from "./map-manager.js";

// Extracted from app.js – unchanged except minimal path updates.
const layerManager = {
  // Add cleanup tracking
  _layerCleanupMap: new Map(),

  initializeControls() {
    const container = utils.getElement("layer-toggles");
    if (!container) return;

    // Load saved layer settings
    const settings = utils.getStorage(CONFIG.STORAGE_KEYS.layerSettings) || {};
    Object.entries(settings).forEach(([name, settings]) => {
      if (state.mapLayers[name]) {
        Object.assign(state.mapLayers[name], settings);
      }
    });

    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    // Exclude street layers - they're controlled by radio buttons
    const streetLayers = ["undrivenStreets", "drivenStreets", "allStreets"];

    Object.entries(state.mapLayers).forEach(([name, info]) => {
      // Skip street layers as they have dedicated radio button controls
      if (streetLayers.includes(name)) return;

      const div = document.createElement("div");
      div.className =
        "layer-control d-flex align-items-center mb-2 p-2 rounded";
      div.dataset.layerName = name;

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
      const badgeMarkup =
        !supportsColorPicker && name !== "customPlaces"
          ? '<span class="badge bg-warning-subtle text-warning-emphasis ms-2 text-uppercase" style="font-size: 0.65rem;">Heatmap</span>'
          : "";

      div.innerHTML = `
          <div class="form-check form-switch me-auto">
            <input class="form-check-input" type="checkbox" id="${checkboxId}"
                   ${info.visible ? "checked" : ""} role="switch">
            <label class="form-check-label" for="${checkboxId}">
              ${info.name || name}
              <span class="layer-loading d-none" id="${name}-loading"></span>
              ${badgeMarkup}
            </label>
          </div>
          ${controlsMarkup}
        `;

      fragment.appendChild(div);
    });

    container.appendChild(fragment);
    this.setupEventListeners(container);
    this.updateLayerOrder();
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
      }, 200),
    );
  },

  async toggleLayer(name, visible) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;

    const loadingEl = document.getElementById(`${name}-loading`);
    if (loadingEl) loadingEl.classList.remove("d-none");

    if (visible) {
      // Fetch data if needed
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

    // Apply visibility - ensure map is ready and layer exists
    const layerId = `${name}-layer`;
    if (state.map?.getLayer(layerId)) {
      state.map.setLayoutProperty(
        layerId,
        "visibility",
        visible ? "visible" : "none",
      );
    } else if (visible && layerInfo.layer) {
      // If layer data exists but layer isn't on map yet, update it
      await this.updateMapLayer(name, layerInfo.layer);
    }

    if (loadingEl) loadingEl.classList.add("d-none");
  },

  updateLayerStyle(name, property, value) {
    const layerInfo = state.mapLayers[name];
    if (!layerInfo) return;

    layerInfo[property] = value;

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

  updateLayerOrder() {
    const container = utils.getElement("layer-order-list");
    if (!container) return;

    // Exclude street layers - they're controlled by radio buttons
    const streetLayers = ["undrivenStreets", "drivenStreets", "allStreets"];

    const sortedLayers = Object.entries(state.mapLayers)
      .filter(([name]) => !streetLayers.includes(name))
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

    container.innerHTML = sortedLayers
      .map(
        ([name, info]) => `
          <li class="list-group-item d-flex justify-content-between align-items-center"
              data-layer-name="${name}" draggable="true">
            <span>${info.name || name}</span>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-secondary move-up" title="Move Up">
                <i class="fas fa-arrow-up"></i>
              </button>
              <button class="btn btn-outline-secondary move-down" title="Move Down">
                <i class="fas fa-arrow-down"></i>
              </button>
            </div>
          </li>
        `,
      )
      .join("");

    this.setupDragAndDrop(container);

    container.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;

      const li = button.closest("li");
      const layerName = li?.dataset.layerName;
      if (!layerName) return;

      if (button.classList.contains("move-up") && li.previousElementSibling) {
        container.insertBefore(li, li.previousElementSibling);
      } else if (
        button.classList.contains("move-down") &&
        li.nextElementSibling
      ) {
        container.insertBefore(li.nextElementSibling, li);
      }

      this.reorderLayers();
    });
  },

  setupDragAndDrop(container) {
    let draggedElement = null;

    container.addEventListener("dragstart", (e) => {
      draggedElement = e.target.closest("li");
      if (draggedElement) {
        draggedElement.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      }
    });

    container.addEventListener("dragend", () => {
      if (draggedElement) {
        draggedElement.classList.remove("dragging");
        draggedElement = null;
        this.reorderLayers();
      }
    });

    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      const afterElement = this.getDragAfterElement(container, e.clientY);
      if (afterElement == null) {
        container.appendChild(draggedElement);
      } else {
        container.insertBefore(draggedElement, afterElement);
      }
    });
  },

  getDragAfterElement(container, y) {
    const draggableElements = [
      ...container.querySelectorAll("li:not(.dragging)"),
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

  reorderLayers() {
    const container = utils.getElement("layer-order-list");
    if (!container) return;

    Array.from(container.children).forEach((item, index) => {
      const {layerName} = item.dataset;
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

  async updateMapLayer(layerName, data) {
    if (!state.map || !state.mapInitialized || !data) return;

    const sourceId = `${layerName}-source`;
    const layerId = `${layerName}-layer`;
    const layerInfo = state.mapLayers[layerName];

    try {
      // Wait for map to be fully ready
      if (!state.map.isStyleLoaded()) {
        await new Promise((resolve) => {
          state.map.once("styledata", resolve);
          // Fallback timeout
          setTimeout(resolve, 1000);
        });
      }

      // Clean up existing layer and source completely
      if (state.map.getLayer(layerId)) {
        const events = ["click", "mouseenter", "mouseleave"];
        events.forEach((event) => state.map.off(event, layerId));
        state.map.removeLayer(layerId);
      }
      if (state.map.getSource(sourceId)) {
        state.map.removeSource(sourceId);
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));

      state.map.addSource(sourceId, {
        type: "geojson",
        data,
        tolerance: 0.5,
        buffer: 128,
        maxzoom: 14,
        generateId: true,
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
          "line-color": layerInfo.color,
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

      // Special handling for different street layers
      if (layerName === "undrivenStreets") {
        layerConfig.paint["line-dasharray"] = [2, 2];
      }
      // allStreets uses single color - no conditional coloring

      state.map.addLayer(layerConfig);

      // Ensure visibility is correctly applied after layer is added
      if (state.map.getLayer(layerId)) {
        state.map.setLayoutProperty(
          layerId,
          "visibility",
          layerInfo.visible ? "visible" : "none",
        );
      }

      if (layerName === "trips" || layerName === "matchedTrips") {
        const tripInteractions = (await import("./trip-interactions.js"))
          .default;
        const clickHandler = (e) => {
          e.originalEvent.stopPropagation();
          if (e.features?.length > 0) {
            tripInteractions.handleTripClick(e, e.features[0]);
          }
        };
        const mouseEnterHandler = () =>
          (state.map.getCanvas().style.cursor = "pointer");
        const mouseLeaveHandler = () =>
          (state.map.getCanvas().style.cursor = "");

        state.map.on("click", layerId, clickHandler);
        state.map.on("mouseenter", layerId, mouseEnterHandler);
        state.map.on("mouseleave", layerId, mouseLeaveHandler);

        if (!this._layerCleanupMap) this._layerCleanupMap = new Map();
        this._layerCleanupMap.set(layerId, {
          click: clickHandler,
          mouseenter: mouseEnterHandler,
          mouseleave: mouseLeaveHandler,
        });

        // After adding trip layers, apply dynamic styling (selected/recent)
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
      window.notificationManager.show(
        `Failed to update ${layerName} layer`,
        "warning",
      );
    }
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

// global exposure for backwards-compat
if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.LayerManager = layerManager;

export default layerManager;
