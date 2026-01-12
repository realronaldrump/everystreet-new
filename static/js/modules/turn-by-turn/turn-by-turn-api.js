/**
 * Turn-by-Turn API Module
 * Handles all network/API calls
 */

import apiClient from "../api-client.js";
import { DIRECTIONS_GEOMETRY, DIRECTIONS_PROFILE } from "./turn-by-turn-config.js";

const TurnByTurnAPI = {
  /**
   * Fetch all coverage areas
   * @returns {Promise<Array>}
   */
  async fetchCoverageAreas() {
    const data = await apiClient.get("/api/coverage_areas");
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
    const data = await apiClient.get(`/api/coverage_areas/${areaId}`);
    if (!data.success || !data.coverage) {
      throw new Error(data.error || "Failed to fetch coverage area");
    }
    return data.coverage;
  },

  /**
   * Fetch optimal route GPX for a coverage area
   * @param {string} areaId
   * @returns {Promise<string>} GPX text
   */
  async fetchOptimalRouteGpx(areaId) {
    try {
      return await apiClient.get(`/api/coverage_areas/${areaId}/optimal-route/gpx`, {
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
    const data = await apiClient.get(`/api/coverage_areas/${areaId}/streets`);
    if (!data.geojson || !data.geojson.features) {
      throw new Error("No segment data in response");
    }
    return data.geojson;
  },

  /**
   * Fetch route ETA via Mapbox Directions API
   * @param {Array<[number, number]>} waypoints - Array of [lon, lat] coordinates
   * @param {string} accessToken - Mapbox access token
   * @returns {Promise<number|null>} Duration in seconds or null
   */
  async fetchRouteETA(waypoints, accessToken) {
    if (waypoints.length < 2) {
      return null;
    }

    try {
      // Sample up to 25 waypoints for Directions API
      const maxWaypoints = 25;
      let sampled = waypoints;
      if (waypoints.length > maxWaypoints) {
        const lastIndex = waypoints.length - 1;
        const stride = lastIndex / (maxWaypoints - 1);
        sampled = [];
        for (let i = 0; i < maxWaypoints; i++) {
          const index = Math.floor(i * stride);
          sampled.push(waypoints[index]);
        }
      }

      const coordsString = sampled.map((c) => `${c[0]},${c[1]}`).join(";");
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsString}?access_token=${accessToken}&overview=false`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
          return data.routes[0].duration;
        }
      }
    } catch {
      // Fall back to simple calculation
    }
    return null;
  },

  /**
   * Fetch directions from one point to another via Mapbox Directions API
   * @param {[number, number]} origin - [lon, lat]
   * @param {[number, number]} destination - [lon, lat]
   * @param {string} accessToken - Mapbox access token
   * @returns {Promise<{duration: number, distance: number, geometry: Object}|null>}
   */
  async fetchDirectionsToPoint(origin, destination, accessToken) {
    const isValidCoord = (coord) =>
      Array.isArray(coord)
      && coord.length === 2
      && Number.isFinite(coord[0])
      && Number.isFinite(coord[1]);

    if (!accessToken || !isValidCoord(origin) || !isValidCoord(destination)) {
      return null;
    }

    try {
      const url = `https://api.mapbox.com/directions/v5/${DIRECTIONS_PROFILE}/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?access_token=${accessToken}&geometries=${DIRECTIONS_GEOMETRY}&overview=full`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
          return {
            duration: data.routes[0].duration,
            distance: data.routes[0].distance,
            geometry: data.routes[0].geometry,
          };
        }
      }
    } catch {
      // Silently fail - caller will handle null return
    }
    return null;
  },

  /**
   * Persist driven segments to server
   * @param {Array<string>} segmentIds
   * @param {string} locationId
   * @returns {Promise<void>}
   */
  async persistDrivenSegments(segmentIds, locationId) {
    await apiClient.post("/api/street_segments/mark_driven", {
      segment_ids: segmentIds,
      location_id: locationId,
    });
  },
};

export default TurnByTurnAPI;
