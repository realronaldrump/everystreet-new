/**
 * Turn-by-Turn API Module
 * Handles all network/API calls
 */

import apiClient from "../core/api-client.js";

export function buildTurnByTurnUrl({ areaId, autoStart = false } = {}) {
  const params = new URLSearchParams();
  if (areaId) {
    params.set("areaId", String(areaId));
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
   * Start route generation for a coverage area
   * @param {string} areaId
   * @returns {Promise<string>} task_id
   */
  async startRouteGeneration(areaId) {
    const data = await apiClient.post(`/api/coverage/areas/${areaId}/optimal-route`);
    return data.task_id;
  },

  /**
   * Check for an active route generation task
   * @param {string} areaId
   * @returns {Promise<Object|null>} {active, task_id, progress, stage} or null
   */
  async checkActiveTask(areaId) {
    try {
      const data = await apiClient.get(`/api/coverage/areas/${areaId}/active-task`);
      if (data.active && data.task_id) {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  },

  /**
   * Cancel a route generation task
   * @param {string} taskId
   * @returns {Promise<Object>}
   */
  async cancelRouteGeneration(taskId) {
    return await apiClient.delete(`/api/optimal-routes/${taskId}`);
  },

  /**
   * Connect to SSE stream for generation progress
   * @param {string} taskId
   * @param {Object} callbacks - {onProgress, onComplete, onError}
   * @returns {{close: Function, cancel: Function}}
   */
  connectProgressSSE(taskId, { onProgress, onComplete, onError }) {
    const es = new EventSource(`/api/optimal-routes/${taskId}/progress/sse`);
    let sseOpen = true;
    let pollHandle = null;

    const closeConnection = () => {
      if (sseOpen) {
        es.close();
        sseOpen = false;
      }
      if (pollHandle && typeof pollHandle.cancel === "function") {
        pollHandle.cancel();
        pollHandle = null;
      }
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const status = (data.status || "").toLowerCase();
        const stage = (data.stage || "").toLowerCase();

        if (status === "completed" || stage === "complete" || data.progress >= 100) {
          closeConnection();
          onComplete(data);
          return;
        }

        if (status === "failed" || status === "error") {
          closeConnection();
          onError(data.error || data.message || "Route generation failed");
          return;
        }

        if (status === "cancelled") {
          closeConnection();
          onError("Generation cancelled");
          return;
        }

        onProgress(data);
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };

    es.addEventListener("done", () => {
      closeConnection();
    });

    es.onerror = () => {
      if (pollHandle) {
        return;
      }
      if (sseOpen) {
        es.close();
        sseOpen = false;
      }
      // Fall back to polling
      pollHandle = TurnByTurnAPI._pollProgress(taskId, {
        onProgress,
        onComplete: (data) => {
          closeConnection();
          onComplete(data);
        },
        onError: (err) => {
          closeConnection();
          onError(err);
        },
      });
    };

    return {
      close: closeConnection,
      cancel: closeConnection,
    };
  },

  /**
   * Fallback polling when SSE fails
   * @private
   */
  _pollProgress(taskId, { onProgress, onComplete, onError }) {
    let cancelled = false;
    let failures = 0;
    const timer = setInterval(async () => {
      if (cancelled) {
        return;
      }
      try {
        const data = await apiClient.get(`/api/optimal-routes/${taskId}/progress`);
        if (cancelled) {
          return;
        }
        const status = (data.status || "").toLowerCase();
        const stage = (data.stage || "").toLowerCase();

        if (status === "completed" || stage === "complete" || data.progress >= 100) {
          cancelled = true;
          clearInterval(timer);
          onComplete(data);
          return;
        }
        if (status === "failed" || status === "error") {
          cancelled = true;
          clearInterval(timer);
          onError(data.error || "Generation failed");
          return;
        }
        if (status === "cancelled") {
          cancelled = true;
          clearInterval(timer);
          onError("Generation cancelled");
          return;
        }
        failures = 0;
        onProgress(data);
      } catch {
        if (cancelled) {
          return;
        }
        failures++;
        if (failures >= 15) {
          cancelled = true;
          clearInterval(timer);
          onError("Connection lost");
        }
      }
    }, 2500);
    return {
      cancel: () => {
        cancelled = true;
        clearInterval(timer);
      },
    };
  },
};

export default TurnByTurnAPI;
