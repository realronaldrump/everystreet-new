/**
 * API service for Driving Navigation.
 * Handles all fetch requests to the backend driving navigation endpoints.
 */

import apiClient from "../api-client.js";

export class DrivingNavigationAPI {
  constructor() {
    this.lastParsedErrorMessage = null;
  }

  /**
   * Clear the cached coverage areas to force a fresh fetch.
   * Useful after areas are added/deleted in coverage management.
   */
  clearCoverageAreasCache() {
    if (window.coverageNavigatorAreas) {
      window.coverageNavigatorAreas = undefined;
    }
  }

  /**
   * Load all coverage areas from the API.
   * Uses cached data from window if available (but only if non-empty).
   * @returns {Promise<Array>} Array of coverage area objects
   */
  async loadCoverageAreas() {
    // Check cache, but only use it if it has data
    // This prevents empty arrays from being permanently cached
    if (
      Array.isArray(window.coverageNavigatorAreas) &&
      window.coverageNavigatorAreas.length > 0
    ) {
      return window.coverageNavigatorAreas;
    }

    const data = await apiClient.get("/api/coverage/areas");
    if (!data.success || !data.areas) {
      throw new Error(data.error || "Invalid response format");
    }

    // Only cache non-empty arrays to allow fresh fetches when areas are added
    if (data.areas.length > 0) {
      window.coverageNavigatorAreas = data.areas;
    }
    return data.areas;
  }

  /**
   * Fetch undriven streets for a given area.
   * @param {string} areaId - Coverage area ID
   * @returns {Promise<Object>} GeoJSON FeatureCollection of undriven streets
   */
  async fetchUndrivenStreets(areaId) {
    return apiClient.get(`/api/coverage/areas/${areaId}/streets/all?status=undriven`);
  }

  /**
   * Find the next route to an undriven street.
   * @param {Object} params - Request parameters
   * @param {Object} params.location - The location object
   * @param {Object} [params.currentPosition] - Current user position {lat, lon}
   * @param {string} [params.segmentId] - Optional specific segment to navigate to
   * @returns {Promise<Object>} Route data with geometry and target street info
   */
  async findNextRoute({ location, currentPosition, segmentId }) {
    const requestPayload = {
      location,
      ...(currentPosition && { current_position: currentPosition }),
      ...(segmentId && { segment_id: segmentId }),
    };

    return apiClient.post("/api/driving-navigation/next-route", requestPayload);
  }

  /**
   * Find efficient street clusters to navigate to.
   * @param {string} areaId - The coverage area ID
   * @param {Object} params - Query parameters
   * @param {number} params.currentLat - Current latitude
   * @param {number} params.currentLon - Current longitude
   * @param {number} [params.topN=3] - Number of top clusters to return
   * @param {number} [params.minClusterSize=2] - Minimum cluster size
   * @returns {Promise<Object>} Cluster suggestions data
   */
  async findEfficientClusters(
    areaId,
    { currentLat, currentLon, topN = 3, minClusterSize = 2 }
  ) {
    const params = new URLSearchParams({
      current_lat: currentLat,
      current_lon: currentLon,
      top_n: topN,
      min_cluster_size: minClusterSize,
    });

    const url = `/api/driving-navigation/suggest-next-street/${areaId}?${params.toString()}`;
    return apiClient.get(url);
  }

  /**
   * Parse an error response into a human-readable message.
   * @param {Error|Response} error - The error to parse
   * @returns {Promise<string>} Error message string
   */
  async parseError(error) {
    let message = "An unknown error occurred.";

    if (error instanceof Error) {
      message = error.message;
    } else if (error instanceof Response) {
      try {
        const err = await error.json();
        message = err.detail || JSON.stringify(err);
      } catch {
        message = error.statusText || `HTTP ${error.status}`;
      }
    }

    this.lastParsedErrorMessage = message;
    return message;
  }
}
