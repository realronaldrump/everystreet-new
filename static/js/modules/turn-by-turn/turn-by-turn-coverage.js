/**
 * Turn-by-Turn Coverage Module
 * Real-time segment coverage tracking and gamification
 */

import TurnByTurnAPI from "./turn-by-turn-api.js";
import { DISTANCE_THRESHOLDS } from "./turn-by-turn-config.js";
import { distanceToLineString } from "./turn-by-turn-geo.js";

/**
 * Coverage tracking for real-time segment completion
 */
class TurnByTurnCoverage {
  constructor(config = {}) {
    this.config = {
      segmentMatchThresholdMeters: DISTANCE_THRESHOLDS.segmentMatch,
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

    // Live session tracking
    this.liveSegmentsCovered = new Set();
    this.liveCoverageIncrease = 0;
    this.sessionSegmentsCompleted = 0;

    // Persistence queue (debounced)
    this.pendingSegmentUpdates = new Set();
    this.persistSegmentsTimeout = null;
    this.selectedAreaId = null;

    // UI feedback
    this.completionPopupTimeout = null;

    // Callbacks
    this.onMapUpdate = null;
    this.onCoverageUpdate = null;
  }

  /**
   * Set callbacks for UI updates
   * @param {Object} callbacks
   */
  setCallbacks({ onMapUpdate, onCoverageUpdate }) {
    this.onMapUpdate = onMapUpdate;
    this.onCoverageUpdate = onCoverageUpdate;
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

      const drivenFeatures = [];
      const undrivenFeatures = [];

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

        this.segmentIndex.set(segmentId, feature);
        this.totalSegmentLength += length;

        if (isDriven) {
          this.drivenSegmentIds.add(segmentId);
          this.drivenSegmentLength += length;
          drivenFeatures.push(feature);
        } else {
          this.undrivenSegmentIds.add(segmentId);
          undrivenFeatures.push(feature);
        }
      }

      // Notify map to update layers
      if (this.onMapUpdate) {
        this.onMapUpdate(drivenFeatures, undrivenFeatures, []);
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

    // Check each undriven segment
    for (const segmentId of this.undrivenSegmentIds) {
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
    const newlyDrivenFeatures = [];

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

      // Track length
      const lengthMiles = feature.properties?.length_miles || 0;
      const length = lengthMiles * 1609.344;
      this.drivenSegmentLength += length;
      this.liveCoverageIncrease += length;

      newlyDrivenFeatures.push(feature);
    }

    if (newlyDrivenFeatures.length === 0) {
      return;
    }

    // Rebuild feature arrays for map update
    const drivenFeatures = [];
    const undrivenFeatures = [];

    for (const [segmentId, feature] of this.segmentIndex) {
      if (this.drivenSegmentIds.has(segmentId)) {
        drivenFeatures.push(feature);
      } else if (this.undrivenSegmentIds.has(segmentId)) {
        undrivenFeatures.push(feature);
      }
    }

    // Update map with glow effect on newly driven
    if (this.onMapUpdate) {
      this.onMapUpdate(drivenFeatures, undrivenFeatures, newlyDrivenFeatures);
    }

    // Update coverage stats in real-time
    if (this.onCoverageUpdate) {
      this.onCoverageUpdate(this.getCoverageStats());
    }

    // Trigger satisfaction feedback
    this.onSegmentsCompleted(newlyDrivenFeatures.length);

    // Persist to server (debounced)
    this.queueSegmentPersistence(segmentIds);

    // Clear the "just driven" glow after animation
    setTimeout(() => {
      if (this.onMapUpdate) {
        this.onMapUpdate(drivenFeatures, undrivenFeatures, []);
      }
    }, 1500);
  }

  /**
   * Get current coverage statistics
   * @returns {{percentage: number, drivenLength: number, totalLength: number}}
   */
  getCoverageStats() {
    const percentage
      = this.totalSegmentLength > 0
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
    if (navigator.vibrate) {
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
      await TurnByTurnAPI.persistDrivenSegments(segmentIds, this.selectedAreaId);
    } catch {
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
    this.liveSegmentsCovered.clear();
    this.liveCoverageIncrease = 0;
    this.sessionSegmentsCompleted = 0;
    this.pendingSegmentUpdates.clear();
    clearTimeout(this.persistSegmentsTimeout);
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
