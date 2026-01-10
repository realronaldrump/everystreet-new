/**
 * Coverage Segment Actions
 * Handles marking segments as driven/undriven/undriveable
 */
import COVERAGE_API from "./coverage-api.js";
import { createFormatterContext } from "./coverage-utils.js";

/**
 * Class to manage segment marking actions for coverage functionality
 */
export class CoverageSegmentActions {
  /**
   * @param {Object} manager - Reference to the CoverageManager instance
   */
  constructor(manager) {
    this.manager = manager;
  }

  /**
   * Handle single segment mark action
   * @param {string} action - Action to perform (driven, undriven, undriveable, driveable)
   * @param {string} segmentId - ID of the segment to mark
   */
  async handleMarkSegmentAction(action, segmentId) {
    const activeLocationId = this._getActiveLocationId();

    if (!activeLocationId || !segmentId) {
      this.manager.notificationManager.show(
        "Cannot perform action: Missing ID.",
        "warning",
      );
      return;
    }

    try {
      await COVERAGE_API.markSegment(activeLocationId, segmentId, action);
      this.manager.notificationManager.show(
        `Segment marked as ${action}. Refreshing...`,
        "success",
        2000,
      );

      // Optimistic UI update
      this._updateSegmentInGeoJson(segmentId, action);

      // Refresh dashboard and table
      await this._refreshAfterAction(activeLocationId);
    } catch (error) {
      this.manager.notificationManager.show(
        `Failed to mark segment: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Handle bulk segment mark action
   * @param {string} action - Action to perform on all selected segments
   */
  async handleBulkMarkSegments(action) {
    const segmentIds = this.manager.selection.getSelectedSegmentIds();
    if (segmentIds.length === 0) return;

    const activeLocationId = this._getActiveLocationId();

    if (!activeLocationId) {
      this.manager.notificationManager.show(
        "Cannot perform bulk action: No active location.",
        "warning",
      );
      return;
    }

    // Mark all segments in parallel
    await Promise.allSettled(
      segmentIds.map((segId) =>
        COVERAGE_API.markSegment(activeLocationId, segId, action),
      ),
    );

    // Optimistic update for all segments
    segmentIds.forEach((segId) => {
      this._updateSegmentInGeoJson(segId, action);
    });

    // Update map source
    if (this.manager.coverageMap.map?.getSource("streets")) {
      this.manager.coverageMap.map
        .getSource("streets")
        .setData(this.manager.coverageMap.streetsGeoJson);
    }

    this.manager.notificationManager.show(
      `${segmentIds.length} segments marked as ${action}.`,
      "success",
      2500,
    );

    // Refresh and clear selection
    await this._refreshAfterAction(activeLocationId);
    this.manager.selection.clearSelection();
  }

  /**
   * Get the active location ID from dashboard state
   * @returns {string|null} Active location ID or null
   */
  _getActiveLocationId() {
    return (
      this.manager.dashboard.selectedLocation?._id ||
      this.manager.dashboard.currentDashboardLocationId
    );
  }

  /**
   * Update a segment's properties in the GeoJSON data
   * @param {string} segmentId - Segment ID to update
   * @param {string} action - Action that was performed
   */
  _updateSegmentInGeoJson(segmentId, action) {
    const streetsGeoJson = this.manager.coverageMap.streetsGeoJson;
    if (!streetsGeoJson?.features) return;

    const featureIndex = streetsGeoJson.features.findIndex(
      (f) => f.properties.segment_id === segmentId,
    );

    if (featureIndex === -1) return;

    const feature = streetsGeoJson.features[featureIndex];

    switch (action) {
      case "driven":
        feature.properties.driven = true;
        feature.properties.undriveable = false;
        break;
      case "undriven":
        feature.properties.driven = false;
        break;
      case "undriveable":
        feature.properties.undriveable = true;
        feature.properties.driven = false;
        break;
      case "driveable":
        feature.properties.undriveable = false;
        break;
      default:
        console.warn(`Unknown segment action: ${action}`);
        return;
    }

    // Create new references to trigger map update
    const newGeoJson = {
      ...streetsGeoJson,
      features: [...streetsGeoJson.features],
    };
    newGeoJson.features[featureIndex] = { ...feature };

    // Update map source
    if (this.manager.coverageMap.map?.getSource("streets")) {
      this.manager.coverageMap.map.getSource("streets").setData(newGeoJson);
    }

    this.manager.coverageMap.streetsGeoJson = newGeoJson;

    // Update undriven streets list
    const { distanceFormatter } = createFormatterContext();
    this.manager.ui.updateUndrivenStreetsList(newGeoJson, distanceFormatter);
  }

  /**
   * Refresh dashboard and table after segment action
   * @param {string} locationId - Location ID to refresh
   */
  async _refreshAfterAction(locationId) {
    const formatterContext = createFormatterContext();

    await this.manager.dashboard.refreshDashboardData(
      locationId,
      formatterContext,
    );
    await this.manager.loadCoverageAreas();
  }
}
