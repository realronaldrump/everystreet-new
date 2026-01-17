/**
 * Turn-by-Turn API Module
 * Handles all network/API calls
 */

import apiClient from "../api-client.js";

const TurnByTurnAPI = {
  /**
   * Fetch all coverage areas
   * @returns {Promise<Array>}
   */
  async fetchCoverageAreas() {
    const data = await apiClient.get("/api/coverage/areas");
    if (!data.success || !data.areas) {
      throw new Error(data.error || "Invalid coverage areas response.");
    }
    return data.areas;
  },

  /**
   * Fetch a specific coverage area with stats
   * @param {string} areaId
   * @returns {Promise<Object>}
   */
  async fetchCoverageArea(areaId) {
    const data = await apiClient.get(`/api/coverage/areas/${areaId}`);
    if (!data.success || !data.area) {
      throw new Error(data.error || "Failed to fetch coverage area");
    }
    return data.area;
  },

  /**
   * Fetch optimal route GPX for a coverage area
   * @param {string} areaId
   * @returns {Promise<string>} GPX text
   */
  async fetchOptimalRouteGpx(areaId) {
    try {
      return await apiClient.get(`/api/coverage/areas/${areaId}/optimal-route/gpx`, {
        parseResponse: (response) => response.text(),
      });
    } catch (error) {
      if (error.message?.includes("404")) {
        throw new Error("No optimal route found. Generate one first.");
      }
      throw error;
    }
  },

  /**
   * Fetch coverage segments for a coverage area
   * @param {string} areaId
   * @returns {Promise<Object>} GeoJSON data
   */
  async fetchCoverageSegments(areaId) {
    const data = await apiClient.get(`/api/coverage/areas/${areaId}/streets/all`);
    if (!data.features || !Array.isArray(data.features)) {
      throw new Error("No segment data in response");
    }
    return data;
  },

  /**
   * Fetch route ETA via backend routing API
   * @param {Array<[number, number]>} waypoints - Array of [lon, lat] coordinates
   * @returns {Promise<number|null>} Duration in seconds or null
   */
  async fetchRouteETA(waypoints) {
    if (waypoints.length < 2) {
      return null;
    }

    try {
      const response = await apiClient.post("/api/routing/eta", {
        waypoints,
      });
      return response?.duration ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Fetch directions from one point to another via backend routing API
   * @param {[number, number]} origin - [lon, lat]
   * @param {[number, number]} destination - [lon, lat]
   * @returns {Promise<{duration: number, distance: number, geometry: Object}|null>}
   */
  async fetchDirectionsToPoint(origin, destination) {
    const isValidCoord = (coord) =>
      Array.isArray(coord) &&
      coord.length === 2 &&
      Number.isFinite(coord[0]) &&
      Number.isFinite(coord[1]);

    if (!isValidCoord(origin) || !isValidCoord(destination)) {
      return null;
    }

    try {
      const response = await apiClient.post("/api/routing/route", {
        origin,
        destination,
      });
      return response?.route || null;
    } catch {
      return null;
    }
  },

  /**
   * Persist driven segments to server
   * @param {Array<string>} segmentIds
   * @param {string} locationId
   * @returns {Promise<void>}
   */
  async persistDrivenSegments(segmentIds, locationId) {
    await apiClient.post(`/api/coverage/areas/${locationId}/streets/mark-driven`, {
      segment_ids: segmentIds,
    });
  },
};

export default TurnByTurnAPI;
