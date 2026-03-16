import apiClient from "../core/api-client.js";
import notificationManager from "../ui/notifications.js";

/**
 * Drive simulation — lets users click undriven streets on the map to see
 * how their coverage percentage would change without actually modifying data.
 */
export class DriveSimulation {
  constructor(map, options = {}) {
    this.map = map; // OptimalRouteMap instance
    this.areaId = null;
    this.active = false;
    this.selectedSegments = new Map(); // segmentId → feature
    this.debounceTimer = null;

    this.onStatsUpdate = options.onStatsUpdate || (() => {});

    this._handleClick = this._handleClick.bind(this);
    this._handleMouseMove = this._handleMouseMove.bind(this);
    this._handleMouseLeave = this._handleMouseLeave.bind(this);
  }

  /** Activate simulation mode for a given area. */
  activate(areaId) {
    if (this.active && this.areaId === areaId) return;
    this.areaId = areaId;
    this.active = true;
    this.selectedSegments.clear();
    this._ensureMapLayer();
    this._updateSourceData();
    this._bindMapEvents();
    this._updateUI();
  }

  /** Deactivate simulation mode and clean up. */
  deactivate() {
    this.active = false;
    this._unbindMapEvents();
    this.selectedSegments.clear();
    this._updateSourceData();
    this._updateUI();
    this.onStatsUpdate(null);
  }

  /** Clear the current selection without deactivating. */
  clearSelection() {
    this.selectedSegments.clear();
    this._updateSourceData();
    this.onStatsUpdate(null);
  }

  /** Toggle a segment on/off by its feature. */
  toggleSegment(feature) {
    const segId = feature.properties?.segment_id;
    if (!segId) return;

    if (this.selectedSegments.has(segId)) {
      this.selectedSegments.delete(segId);
    } else {
      this.selectedSegments.set(segId, feature);
    }

    this._updateSourceData();
    this._debouncedSimulate();
  }

  /** Set the area for the simulation (e.g. on area change). */
  setArea(areaId) {
    if (this.active) {
      this.deactivate();
    }
    this.areaId = areaId;
  }

  destroy() {
    this.deactivate();
  }

  // ---------------------------------------------------------------------------
  // Map Layer
  // ---------------------------------------------------------------------------

  _ensureMapLayer() {
    const mapgl = this.map.map;
    if (!mapgl) return;

    if (!mapgl.getSource("simulation-selected")) {
      mapgl.addSource("simulation-selected", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!mapgl.getLayer("simulation-selected-layer")) {
      mapgl.addLayer({
        id: "simulation-selected-layer",
        type: "line",
        source: "simulation-selected",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#3b82f6",
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [2, 1],
        },
      });
    }
  }

  _updateSourceData() {
    const mapgl = this.map.map;
    const source = mapgl?.getSource("simulation-selected");
    if (!source) return;

    source.setData({
      type: "FeatureCollection",
      features: Array.from(this.selectedSegments.values()),
    });
  }

  // ---------------------------------------------------------------------------
  // Map Event Handlers
  // ---------------------------------------------------------------------------

  _bindMapEvents() {
    const mapgl = this.map.map;
    if (!mapgl) return;

    mapgl.on("click", "streets-undriven-layer", this._handleClick);
    mapgl.on("click", "simulation-selected-layer", this._handleClick);
    mapgl.on("mousemove", "streets-undriven-layer", this._handleMouseMove);
    mapgl.on("mouseleave", "streets-undriven-layer", this._handleMouseLeave);
  }

  _unbindMapEvents() {
    const mapgl = this.map.map;
    if (!mapgl) return;

    mapgl.off("click", "streets-undriven-layer", this._handleClick);
    mapgl.off("click", "simulation-selected-layer", this._handleClick);
    mapgl.off("mousemove", "streets-undriven-layer", this._handleMouseMove);
    mapgl.off("mouseleave", "streets-undriven-layer", this._handleMouseLeave);
  }

  _handleClick(e) {
    if (!this.active || !e.features?.length) return;
    // Prevent normal map behavior
    e.originalEvent?.stopPropagation?.();
    this.toggleSegment(e.features[0]);
  }

  _handleMouseMove() {
    if (!this.active) return;
    const mapgl = this.map.map;
    if (mapgl) mapgl.getCanvas().style.cursor = "crosshair";
  }

  _handleMouseLeave() {
    if (!this.active) return;
    const mapgl = this.map.map;
    if (mapgl) mapgl.getCanvas().style.cursor = "";
  }

  // ---------------------------------------------------------------------------
  // API Call (with debounce)
  // ---------------------------------------------------------------------------

  _debouncedSimulate() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._simulate(), 300);
  }

  async _simulate() {
    if (!this.areaId || this.selectedSegments.size === 0) {
      this.onStatsUpdate(null);
      return;
    }

    const segmentIds = Array.from(this.selectedSegments.keys());

    try {
      const data = await apiClient.post(
        `/api/coverage/areas/${this.areaId}/streets/simulate`,
        { segment_ids: segmentIds }
      );

      if (data.success) {
        this.onStatsUpdate({
          ...data,
          selectedCount: this.selectedSegments.size,
        });
      }
    } catch (err) {
      console.error("Simulation API error:", err);
      notificationManager.show("Failed to simulate drive", "danger");
    }
  }

  // ---------------------------------------------------------------------------
  // UI Updates (toggle button, panel state)
  // ---------------------------------------------------------------------------

  _updateUI() {
    const toggleBtn = document.getElementById("sim-toggle-btn");
    const panel = document.getElementById("sim-results-panel");
    const badge = document.getElementById("sim-count-badge");

    if (toggleBtn) {
      toggleBtn.classList.toggle("active", this.active);
      toggleBtn.setAttribute("aria-pressed", this.active ? "true" : "false");
    }

    if (panel) {
      panel.style.display = this.active ? "block" : "none";
    }

    if (badge) {
      badge.textContent = this.selectedSegments.size || "";
      badge.style.display = this.selectedSegments.size > 0 ? "inline-flex" : "none";
    }
  }
}
