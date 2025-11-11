/**
 * Coverage Selection Module
 * Handles multi-select and bulk actions for street segments
 */

class CoverageSelection {
  constructor(coverageMap, notificationManager) {
    this.coverageMap = coverageMap;
    this.notificationManager = notificationManager;
    this.selectedSegmentIds = new Set();
    this.bulkToolbar = null;
  }

  /**
   * Create bulk action toolbar
   */
  createBulkActionToolbar() {
    if (document.getElementById("bulk-action-toolbar")) return;
    const mapContainer = document.getElementById("coverage-map");
    if (!mapContainer) return;

    const toolbar = document.createElement("div");
    toolbar.id = "bulk-action-toolbar";
    toolbar.className =
      "bulk-action-toolbar d-flex align-items-center bg-dark bg-opacity-75 rounded shadow-sm";
    toolbar.style.cssText =
      "position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:2;gap:6px;padding:6px 10px;display:none;";

    toolbar.innerHTML = `
      <span id="bulk-selected-count" class="badge bg-info">0 Selected</span>
      <button class="btn btn-sm btn-success bulk-mark-btn" data-action="driven" disabled title="Mark Driven"><i class="fas fa-check"></i></button>
      <button class="btn btn-sm btn-danger bulk-mark-btn" data-action="undriven" disabled title="Mark Undriven"><i class="fas fa-times"></i></button>
      <button class="btn btn-sm btn-warning bulk-mark-btn" data-action="undriveable" disabled title="Mark Undriveable"><i class="fas fa-ban"></i></button>
      <button class="btn btn-sm btn-info text-white bulk-mark-btn" data-action="driveable" disabled title="Mark Driveable"><i class="fas fa-road"></i></button>
      <button class="btn btn-sm btn-secondary bulk-clear-selection-btn" disabled title="Clear Selection"><i class="fas fa-eraser"></i></button>
    `;

    toolbar.addEventListener("click", (e) => {
      const markBtn = e.target.closest(".bulk-mark-btn");
      if (markBtn) {
        const { action } = markBtn.dataset;
        if (action) {
          document.dispatchEvent(
            new CustomEvent("coverageBulkAction", { detail: action })
          );
        }
        return;
      }
      if (e.target.closest(".bulk-clear-selection-btn")) {
        this.clearSelection();
      }
    });

    mapContainer.appendChild(toolbar);
    this.bulkToolbar = toolbar;
  }

  /**
   * Toggle segment selection
   */
  toggleSegmentSelection(segmentId) {
    if (!segmentId) return;
    if (this.selectedSegmentIds.has(segmentId))
      this.selectedSegmentIds.delete(segmentId);
    else this.selectedSegmentIds.add(segmentId);

    this._updateSelectionHighlight();
    this._updateBulkToolbar();
  }

  /**
   * Update selection highlight
   */
  _updateSelectionHighlight() {
    if (!this.coverageMap?.map || !this.coverageMap.map.getSource("streets")) return;

    const layerId = "streets-selection-highlight";
    if (!this.coverageMap.map.getLayer(layerId)) {
      this.coverageMap.map.addLayer(
        {
          id: layerId,
          type: "line",
          source: "streets",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#00bcd4",
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 7],
            "line-opacity": 1,
          },
          filter: ["in", "segment_id", ""],
        },
        "streets-layer"
      );
    }

    const ids = Array.from(this.selectedSegmentIds);
    if (ids.length === 0) {
      this.coverageMap.map.setFilter(layerId, ["in", "segment_id", ""]);
    } else {
      this.coverageMap.map.setFilter(layerId, ["in", "segment_id", ...ids]);
    }
  }

  /**
   * Update bulk toolbar
   */
  _updateBulkToolbar() {
    const toolbar = this.bulkToolbar || document.getElementById("bulk-action-toolbar");
    if (!toolbar) return;
    const countSpan = document.getElementById("bulk-selected-count");
    const count = this.selectedSegmentIds.size;
    if (countSpan) countSpan.textContent = `${count} Selected`;

    const disabled = count === 0;
    toolbar
      .querySelectorAll(".bulk-mark-btn, .bulk-clear-selection-btn")
      .forEach((btn) => {
        btn.disabled = disabled;
      });
    toolbar.style.display = count > 0 ? "flex" : "none";
  }

  /**
   * Clear selection
   */
  clearSelection() {
    if (this.selectedSegmentIds.size === 0) return;
    this.selectedSegmentIds.clear();
    this._updateSelectionHighlight();
    this._updateBulkToolbar();
  }

  /**
   * Get selected segment IDs
   */
  getSelectedSegmentIds() {
    return Array.from(this.selectedSegmentIds);
  }
}

export default CoverageSelection;
