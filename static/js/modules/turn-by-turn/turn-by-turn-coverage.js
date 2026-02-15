/**
 * Turn-by-Turn Coverage Module
 * Real-time segment coverage tracking and gamification
 */

import TurnByTurnAPI from "./turn-by-turn-api.js";
import { DISTANCE_THRESHOLDS } from "./turn-by-turn-config.js";
import { distanceToLineString, toXY } from "./turn-by-turn-geo.js";

/**
 * Coverage tracking for real-time segment completion
 */
class TurnByTurnCoverage {
  constructor(config = {}) {
    this.config = {
      segmentMatchThresholdMeters: DISTANCE_THRESHOLDS.segmentMatch,
      spatialIndexCellSizeMeters: 160,
      persistDebounceMs: 2000,
      ...config,
    };

    // Segment data
    this.segmentsData = null;
    this.segmentIndex = new Map();
    this.drivenSegmentIds = new Set();
    this.undrivenSegmentIds = new Set();
    this.totalSegmentLength = 0;
    this.drivenSegmentLength = 0;

    // Spatial index of undriven segments for fast nearby matching.
    this._spatialGrid = new Map(); // cellKey -> Set(segmentId)
    this._segmentCells = new Map(); // segmentId -> Array(cellKey)
    this._refLat = null;

    // Live session tracking
    this.liveSegmentsCovered = new Set();
    this.liveCoverageIncrease = 0;
    this.sessionSegmentsCompleted = 0;

    // Persistence queue (debounced)
    this.pendingSegmentUpdates = new Set();
    this.persistSegmentsTimeout = null;
    this.selectedAreaId = null;
    this.activeMissionId = null;

    // UI feedback
    this.completionPopupTimeout = null;

    // Callbacks
    this.onMapUpdate = null;
    this.onCoverageUpdate = null;
    this.onMissionDelta = null;
  }

  _gridKey(cx, cy) {
    return `${cx},${cy}`;
  }

  _indexUndrivenSegment(segmentId, coordinates) {
    if (!segmentId || !Array.isArray(coordinates) || coordinates.length < 2) {
      return;
    }

    if (!Number.isFinite(this._refLat)) {
      const first = coordinates[0];
      if (Array.isArray(first) && first.length >= 2 && Number.isFinite(first[1])) {
        this._refLat = first[1];
      } else {
        this._refLat = 0;
      }
    }

    // Compute a bbox in projected XY meters for grid indexing.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const coord of coordinates) {
      if (!Array.isArray(coord) || coord.length < 2) {
        continue;
      }
      const xy = toXY(coord, this._refLat);
      if (!Number.isFinite(xy?.x) || !Number.isFinite(xy?.y)) {
        continue;
      }
      minX = Math.min(minX, xy.x);
      minY = Math.min(minY, xy.y);
      maxX = Math.max(maxX, xy.x);
      maxY = Math.max(maxY, xy.y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return;
    }

    const cellSize = Math.max(40, this.config.spatialIndexCellSizeMeters || 160);
    const cx0 = Math.floor(minX / cellSize);
    const cy0 = Math.floor(minY / cellSize);
    const cx1 = Math.floor(maxX / cellSize);
    const cy1 = Math.floor(maxY / cellSize);

    const keys = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = this._gridKey(cx, cy);
        if (!this._spatialGrid.has(key)) {
          this._spatialGrid.set(key, new Set());
        }
        this._spatialGrid.get(key).add(segmentId);
        keys.push(key);
      }
    }

    this._segmentCells.set(segmentId, keys);
  }

  _unindexSegment(segmentId) {
    const keys = this._segmentCells.get(segmentId);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const bucket = this._spatialGrid.get(key);
      if (!bucket) {
        continue;
      }
      bucket.delete(segmentId);
      if (bucket.size === 0) {
        this._spatialGrid.delete(key);
      }
    }
    this._segmentCells.delete(segmentId);
  }

  /**
   * Set callbacks for UI updates
   * @param {Object} callbacks
   */
  setCallbacks({ onMapUpdate, onCoverageUpdate, onMissionDelta }) {
    this.onMapUpdate = onMapUpdate;
    this.onCoverageUpdate = onCoverageUpdate;
    this.onMissionDelta = onMissionDelta;
  }

  /**
   * Set mission context for persistence updates.
   * @param {string|null} missionId
   */
  setMissionContext(missionId) {
    this.activeMissionId = missionId ? String(missionId) : null;
  }

  /**
   * Load coverage segments from API
   * @param {string} areaId
   */
  async loadSegments(areaId) {
    this.selectedAreaId = areaId;
    this.reset();

    try {
      const geojson = await TurnByTurnAPI.fetchCoverageSegments(areaId);
      this.segmentsData = geojson;
      const driveableFeatures = [];

      // Index all segments and categorize
      for (const feature of geojson.features) {
        const segmentId = feature.properties?.segment_id;
        const status = feature.properties?.status;
        const isDriven = status === "driven";
        const isUndriveable = status === "undriveable";
        const lengthMiles = feature.properties?.length_miles || 0;
        const length = lengthMiles * 1609.344;

        if (!segmentId || isUndriveable) {
          continue;
        }

        // Mapbox feature-state requires a stable feature id.
        feature.id = segmentId;

        this.segmentIndex.set(segmentId, feature);
        this.totalSegmentLength += length;
        driveableFeatures.push(feature);

        if (isDriven) {
          this.drivenSegmentIds.add(segmentId);
          this.drivenSegmentLength += length;
        } else {
          this.undrivenSegmentIds.add(segmentId);
          this._indexUndrivenSegment(segmentId, feature.geometry?.coordinates);
        }
      }

      // Notify map to update layers
      if (this.onMapUpdate) {
        this.onMapUpdate({
          type: "init",
          features: driveableFeatures,
          drivenIds: Array.from(this.drivenSegmentIds),
        });
      }
    } catch {
      // Silently fail - coverage tracking is optional enhancement
    }
  }

  /**
   * Check if current position matches any undriven segments
   * @param {{lon: number, lat: number}} position
   */
  checkSegmentCoverage(position) {
    if (!this.segmentIndex.size || this.undrivenSegmentIds.size === 0) {
      return;
    }

    const current = [position.lon, position.lat];
    const newlyDriven = [];

    const cellSize = Math.max(40, this.config.spatialIndexCellSizeMeters || 160);
    if (!Number.isFinite(this._refLat)) {
      this._refLat = current[1] || 0;
    }
    const p = toXY(current, this._refLat);
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
      return;
    }
    const cx = Math.floor(p.x / cellSize);
    const cy = Math.floor(p.y / cellSize);
    const radiusCells = Math.max(
      1,
      Math.ceil(this.config.segmentMatchThresholdMeters / cellSize)
    );

    const candidates = new Set();
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const bucket = this._spatialGrid.get(this._gridKey(cx + dx, cy + dy));
        if (!bucket) {
          continue;
        }
        for (const segmentId of bucket) {
          candidates.add(segmentId);
        }
      }
    }

    for (const segmentId of candidates) {
      if (!this.undrivenSegmentIds.has(segmentId)) {
        continue;
      }
      const feature = this.segmentIndex.get(segmentId);
      if (!feature) {
        continue;
      }

      // Check if current position is close to this segment
      const distance = distanceToLineString(current, feature.geometry.coordinates);

      if (distance <= this.config.segmentMatchThresholdMeters) {
        newlyDriven.push(segmentId);
      }
    }

    // Process newly driven segments
    if (newlyDriven.length > 0) {
      this.markSegmentsDriven(newlyDriven);
    }
  }

  /**
   * Mark segments as driven and update UI
   * @param {Array<string>} segmentIds
   */
  markSegmentsDriven(segmentIds) {
    const newlyDrivenIds = [];

    for (const segmentId of segmentIds) {
      if (!this.undrivenSegmentIds.has(segmentId)) {
        continue;
      }

      const feature = this.segmentIndex.get(segmentId);
      if (!feature) {
        continue;
      }

      // Move from undriven to driven
      this.undrivenSegmentIds.delete(segmentId);
      this.drivenSegmentIds.add(segmentId);
      this.liveSegmentsCovered.add(segmentId);
      this._unindexSegment(segmentId);

      // Track length
      const lengthMiles = feature.properties?.length_miles || 0;
      const length = lengthMiles * 1609.344;
      this.drivenSegmentLength += length;
      this.liveCoverageIncrease += length;

      newlyDrivenIds.push(segmentId);
    }

    if (newlyDrivenIds.length === 0) {
      return;
    }

    // Update map with glow effect on newly driven segments
    if (this.onMapUpdate) {
      this.onMapUpdate({
        type: "segments-driven",
        segmentIds: newlyDrivenIds,
      });
    }

    // Update coverage stats in real-time
    if (this.onCoverageUpdate) {
      this.onCoverageUpdate(this.getCoverageStats());
    }

    // Trigger satisfaction feedback
    this.onSegmentsCompleted(newlyDrivenIds.length);

    // Persist to server (debounced)
    this.queueSegmentPersistence(newlyDrivenIds);
  }

  /**
   * Get current coverage statistics
   * @returns {{percentage: number, drivenLength: number, totalLength: number}}
   */
  getCoverageStats() {
    const percentage =
      this.totalSegmentLength > 0
        ? (this.drivenSegmentLength / this.totalSegmentLength) * 100
        : 0;

    return {
      percentage,
      drivenLength: this.drivenSegmentLength,
      totalLength: this.totalSegmentLength,
      sessionIncrease: this.liveCoverageIncrease,
      sessionSegments: this.sessionSegmentsCompleted,
    };
  }

  /**
   * Satisfaction feedback when segments are completed
   * @param {number} count
   */
  onSegmentsCompleted(count) {
    if (count === 0) {
      return;
    }

    this.sessionSegmentsCompleted += count;

    // Subtle haptic feedback if available
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(count > 1 ? [30, 20, 30] : 30);
    }

    // Show visual feedback for multiple segments
    if (count >= 2) {
      this.showSegmentCompletionPopup(count);
    }
  }

  /**
   * Show a brief popup when completing multiple segments at once
   * @param {number} count
   */
  showSegmentCompletionPopup(count) {
    // Don't spam popups
    if (this.completionPopupTimeout) {
      return;
    }

    const popup = document.createElement("div");
    popup.className = "nav-segment-counter";
    popup.textContent = `+${count} segments`;
    document.body.appendChild(popup);

    this.completionPopupTimeout = setTimeout(() => {
      popup.remove();
      this.completionPopupTimeout = null;
    }, 700);
  }

  /**
   * Queue segment persistence to server (debounced)
   * @param {Array<string>} segmentIds
   */
  queueSegmentPersistence(segmentIds) {
    for (const id of segmentIds) {
      this.pendingSegmentUpdates.add(id);
    }

    // Debounce: persist after configured delay
    clearTimeout(this.persistSegmentsTimeout);
    this.persistSegmentsTimeout = setTimeout(() => {
      this.persistDrivenSegments();
    }, this.config.persistDebounceMs);
  }

  /**
   * Persist driven segments to server
   */
  async persistDrivenSegments() {
    if (!this.pendingSegmentUpdates || this.pendingSegmentUpdates.size === 0) {
      return;
    }

    const segmentIds = Array.from(this.pendingSegmentUpdates);
    this.pendingSegmentUpdates.clear();

    try {
      const response = this.activeMissionId
        ? await TurnByTurnAPI.persistDrivenSegmentsForMission(
            segmentIds,
            this.selectedAreaId,
            this.activeMissionId
          )
        : await TurnByTurnAPI.persistDrivenSegments(segmentIds, this.selectedAreaId);

      if (response?.mission_delta && this.onMissionDelta) {
        this.onMissionDelta(response.mission_delta);
      }
    } catch {
      if (this.activeMissionId) {
        try {
          // Mission failures should not block base coverage persistence.
          await TurnByTurnAPI.persistDrivenSegments(segmentIds, this.selectedAreaId);
          this.activeMissionId = null;
          return;
        } catch {
          // Fall through to re-queue.
        }
      }
      // Re-queue failed segments
      for (const id of segmentIds) {
        this.pendingSegmentUpdates.add(id);
      }
    }
  }

  /**
   * Reset all tracking state
   */
  reset() {
    this.segmentsData = null;
    this.segmentIndex.clear();
    this.drivenSegmentIds.clear();
    this.undrivenSegmentIds.clear();
    this.totalSegmentLength = 0;
    this.drivenSegmentLength = 0;
    this._spatialGrid.clear();
    this._segmentCells.clear();
    this._refLat = null;
    this.liveSegmentsCovered.clear();
    this.liveCoverageIncrease = 0;
    this.sessionSegmentsCompleted = 0;
    this.pendingSegmentUpdates.clear();
    clearTimeout(this.persistSegmentsTimeout);
    this.activeMissionId = null;
  }

  /**
   * Cleanup on destroy
   */
  destroy() {
    // Flush pending updates
    this.persistDrivenSegments();
    this.reset();
    clearTimeout(this.completionPopupTimeout);
  }
}

export default TurnByTurnCoverage;
