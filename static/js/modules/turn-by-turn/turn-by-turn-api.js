/**
 * Turn-by-Turn API Module
 * Handles all network/API calls
 */

import apiClient from "../core/api-client.js";

export function buildTurnByTurnUrl({ areaId, missionId = null, autoStart = false } = {}) {
  const params = new URLSearchParams();
  if (areaId) {
    params.set("areaId", String(areaId));
  }
  if (missionId) {
    params.set("missionId", String(missionId));
  }
  if (autoStart) {
    params.set("autoStart", "true");
  }
  const query = params.toString();
  return query ? `/turn-by-turn?${query}` : "/turn-by-turn";
}

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
   * Fetch optimal route details/metrics for a coverage area.
   * @param {string} areaId
   * @returns {Promise<Object|null>}
   */
  async fetchOptimalRoute(areaId) {
    try {
      return await apiClient.get(`/api/coverage/areas/${areaId}/optimal-route`);
    } catch {
      return null;
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

  /**
   * Persist driven segments with mission context.
   * @param {Array<string>} segmentIds
   * @param {string} locationId
   * @param {string|null} missionId
   * @returns {Promise<Object>}
   */
  persistDrivenSegmentsForMission(segmentIds, locationId, missionId) {
    return apiClient.post(`/api/coverage/areas/${locationId}/streets/mark-driven`, {
      segment_ids: segmentIds,
      mission_id: missionId || null,
    });
  },

  /**
   * Create mission (or resume existing active mission for area).
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  createMission(payload) {
    return apiClient.post("/api/coverage/missions", payload);
  },

  /**
   * Fetch currently active mission for area.
   * @param {string} areaId
   * @returns {Promise<Object|null>}
   */
  async fetchActiveMission(areaId) {
    const data = await apiClient.get(
      `/api/coverage/missions/active?area_id=${encodeURIComponent(areaId)}`
    );
    return data?.mission || null;
  },

  /**
   * Fetch mission by ID.
   * @param {string} missionId
   * @returns {Promise<Object>}
   */
  async fetchMission(missionId) {
    const data = await apiClient.get(`/api/coverage/missions/${missionId}`);
    return data?.mission;
  },

  /**
   * List missions for an area.
   * @param {Object} opts
   * @returns {Promise<Object>}
   */
  listMissions({ areaId, status = null, limit = 20, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (areaId) {
      params.set("area_id", String(areaId));
    }
    if (status) {
      params.set("status", String(status));
    }
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return apiClient.get(`/api/coverage/missions?${params.toString()}`);
  },

  /**
   * Send mission heartbeat.
   * @param {string} missionId
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async heartbeatMission(missionId, payload = {}) {
    const data = await apiClient.post(`/api/coverage/missions/${missionId}/heartbeat`, payload);
    return data?.mission;
  },

  /**
   * Pause mission.
   * @param {string} missionId
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async pauseMission(missionId, payload = {}) {
    const data = await apiClient.post(`/api/coverage/missions/${missionId}/pause`, payload);
    return data?.mission;
  },

  /**
   * Resume mission.
   * @param {string} missionId
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async resumeMission(missionId, payload = {}) {
    const data = await apiClient.post(`/api/coverage/missions/${missionId}/resume`, payload);
    return data?.mission;
  },

  /**
   * Complete mission.
   * @param {string} missionId
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async completeMission(missionId, payload = {}) {
    const data = await apiClient.post(
      `/api/coverage/missions/${missionId}/complete`,
      payload
    );
    return data?.mission;
  },

  /**
   * Cancel mission.
   * @param {string} missionId
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async cancelMission(missionId, payload = {}) {
    const data = await apiClient.post(`/api/coverage/missions/${missionId}/cancel`, payload);
    return data?.mission;
  },
};

export default TurnByTurnAPI;
