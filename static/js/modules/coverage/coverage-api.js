/**
 * Coverage API Module
 * Handles all API calls related to coverage areas
 */

import apiClient from "../api-client.js";

const COVERAGE_API = {
  /**
   * Invalidate all coverage-related caches
   * Call this after any mutation to ensure fresh data is fetched
   */
  invalidateCache() {
    apiClient.clearCache("/api/coverage_areas");
  },

  /**
   * Fetch all coverage areas
   * @param {boolean} bypassCache - Force fresh fetch from server
   */
  async getAllAreas(bypassCache = false) {
    if (bypassCache) {
      this.invalidateCache();
    }
    const data = await apiClient.get("/api/coverage_areas", {
      cache: !bypassCache,
    });
    if (!data.success) {
      throw new Error(data.error || "API returned failure");
    }
    return data.areas || [];
  },

  /**
   * Fetch a specific coverage area by ID
   */
  async getArea(locationId) {
    const data = await apiClient.get(`/api/coverage_areas/${locationId}`);
    if (!data.success || !data.coverage) {
      throw new Error(data.error || "Failed to fetch coverage area");
    }
    return data.coverage;
  },

  /**
   * Fetch streets GeoJSON for a coverage area
   */
  async getStreets(locationId, cacheBust = false) {
    const url = `/api/coverage_areas/${locationId}/streets${
      cacheBust ? `?cache_bust=${Date.now()}` : ""
    }`;
    return apiClient.get(url);
  },

  /**
   * Validate a location
   */
  async validateLocation(location, locationType) {
    return apiClient.post("/api/validate_location", { location, locationType });
  },

  /**
   * Validate a custom boundary
   */
  async validateCustomBoundary(areaName, geometry) {
    return apiClient.post("/api/validate_custom_boundary", {
      area_name: areaName,
      geometry,
    });
  },

  /**
   * Start preprocessing streets for a location
   */
  async preprocessStreets(location) {
    const result = await apiClient.post("/api/preprocess_streets", location);
    this.invalidateCache();
    return result;
  },

  /**
   * Start preprocessing custom boundary
   */
  async preprocessCustomBoundary(location) {
    const result = await apiClient.post(
      "/api/preprocess_custom_boundary",
      location,
    );
    this.invalidateCache();
    return result;
  },

  /**
   * Update coverage for an area (full or incremental)
   */
  async updateCoverage(location, mode = "full") {
    const endpoint =
      mode === "incremental"
        ? "/api/street_coverage/incremental"
        : "/api/street_coverage";
    const result = await apiClient.post(endpoint, location);
    this.invalidateCache();
    return result;
  },

  /**
   * Get task progress
   */
  async getTaskProgress(taskId) {
    const data = await apiClient.get(`/api/street_coverage/${taskId}`);
    if (!data || typeof data !== "object" || !data.stage) {
      throw new Error("Invalid data format received from server");
    }
    return data;
  },

  /**
   * Cancel processing for a location
   */
  async cancelProcessing(displayName) {
    const result = await apiClient.post("/api/coverage_areas/cancel", {
      display_name: displayName,
    });
    this.invalidateCache();
    return result;
  },

  /**
   * Delete a coverage area
   */
  async deleteArea(displayName) {
    const result = await apiClient.post("/api/coverage_areas/delete", {
      display_name: displayName,
    });
    this.invalidateCache();
    return result;
  },

  /**
   * Refresh stats for a coverage area
   */
  async refreshStats(locationId) {
    const result = await apiClient.post(
      `/api/coverage_areas/${locationId}/refresh_stats`,
    );
    this.invalidateCache();
    return result;
  },

  /**
   * Mark a segment as driven/undriven/undriveable/driveable
   */
  async markSegment(locationId, segmentId, action) {
    const endpointMap = {
      driven: "/api/street_segments/mark_driven",
      undriven: "/api/street_segments/mark_undriven",
      undriveable: "/api/street_segments/mark_undriveable",
      driveable: "/api/street_segments/mark_driveable",
    };
    const endpoint = endpointMap[action];
    if (!endpoint) {
      throw new Error(`Unknown action: ${action}`);
    }
    const result = await apiClient.post(endpoint, {
      location_id: locationId,
      segment_id: segmentId,
    });
    this.invalidateCache();
    return result;
  },

  /**
   * Get efficient street suggestions
   */
  async getEfficientStreets(locationId, currentLat, currentLon, topN = 3) {
    const params = new URLSearchParams({
      current_lat: currentLat.toString(),
      current_lon: currentLon.toString(),
      top_n: topN.toString(),
    });
    return apiClient.get(
      `/api/driving-navigation/suggest-next-street/${locationId}?${params}`,
    );
  },

  /**
   * Get trips within bounds
   */
  async getTripsInBounds(bounds) {
    const params = new URLSearchParams({
      min_lat: bounds.sw.lat.toFixed(6),
      min_lon: bounds.sw.lng.toFixed(6),
      max_lat: bounds.ne.lat.toFixed(6),
      max_lon: bounds.ne.lng.toFixed(6),
    });
    const data = await apiClient.get(`/api/trips_in_bounds?${params}`);
    if (!data || !Array.isArray(data.trips)) {
      throw new Error("Invalid trip data received");
    }
    return data.trips;
  },

  /**
   * Start optimal route generation for a coverage area
   */
  async generateOptimalRoute(locationId, startLon = null, startLat = null) {
    const params = new URLSearchParams();
    if (startLon !== null) {
      params.set("start_lon", startLon.toString());
    }
    if (startLat !== null) {
      params.set("start_lat", startLat.toString());
    }

    const url = `/api/coverage_areas/${locationId}/generate-optimal-route${
      params.toString() ? `?${params}` : ""
    }`;
    return apiClient.post(url);
  },

  /**
   * Get the generated optimal route for a coverage area
   */
  async getOptimalRoute(locationId) {
    try {
      return await apiClient.get(
        `/api/coverage_areas/${locationId}/optimal-route`,
      );
    } catch (error) {
      if (error.message.includes("404")) {
        return null; // No route generated yet
      }
      throw error;
    }
  },

  /**
   * Delete the optimal route for a coverage area
   */
  async deleteOptimalRoute(locationId) {
    return apiClient.delete(`/api/coverage_areas/${locationId}/optimal-route`);
  },

  /**
   * Get GPX download URL for optimal route
   */
  getOptimalRouteGpxUrl(locationId) {
    return `/api/coverage_areas/${locationId}/optimal-route/gpx`;
  },

  /**
   * Get Celery task status (for polling route generation progress)
   */
  async getTaskStatus(taskId) {
    return apiClient.get(`/api/tasks/${taskId}/status`);
  },
};

export default COVERAGE_API;
