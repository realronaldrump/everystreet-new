/**
 * API service for Driving Navigation.
 * Handles all fetch requests to the backend driving navigation endpoints.
 */

export class DrivingNavigationAPI {
  constructor() {
    this.lastParsedErrorMessage = null;
  }

  /**
   * Load all coverage areas from the API.
   * Uses cached data from window if available.
   * @returns {Promise<Array>} Array of coverage area objects
   */
  async loadCoverageAreas() {
    if (Array.isArray(window.coverageNavigatorAreas)) {
      return window.coverageNavigatorAreas;
    }

    const response = await fetch("/api/coverage_areas");
    if (!response.ok) {
      throw new Error(`Failed to fetch areas: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success || !data.areas) {
      throw new Error(data.error || "Invalid response format");
    }

    window.coverageNavigatorAreas = data.areas;
    return data.areas;
  }

  /**
   * Fetch undriven streets for a given location.
   * @param {Object} location - The location object with area details
   * @returns {Promise<Object>} GeoJSON FeatureCollection of undriven streets
   */
  async fetchUndrivenStreets(location) {
    const response = await fetch("/api/undriven_streets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || `HTTP error ${response.status}`);
    }

    return response.json();
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

    const response = await fetch("/api/driving-navigation/next-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      throw response;
    }

    return response.json();
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
    { currentLat, currentLon, topN = 3, minClusterSize = 2 },
  ) {
    const params = new URLSearchParams({
      current_lat: currentLat,
      current_lon: currentLon,
      top_n: topN,
      min_cluster_size: minClusterSize,
    });

    const url = `/api/driving-navigation/suggest-next-street/${areaId}?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw response;
    }

    return response.json();
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
