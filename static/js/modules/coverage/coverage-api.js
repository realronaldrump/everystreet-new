/**
 * Coverage API Module
 * Handles all API calls related to coverage areas
 */

const COVERAGE_API = {
  /**
   * Fetch all coverage areas
   */
  async getAllAreas() {
    const response = await fetch("/api/coverage_areas");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || "API returned failure");
    }
    return data.areas || [];
  },

  /**
   * Fetch a specific coverage area by ID
   */
  async getArea(locationId) {
    const response = await fetch(`/api/coverage_areas/${locationId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    const data = await response.json();
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
    const response = await fetch(url);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Validate a location
   */
  async validateLocation(location, locationType) {
    const response = await fetch("/api/validate_location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location, locationType }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Validation failed");
    }
    return response.json();
  },

  /**
   * Validate a custom boundary
   */
  async validateCustomBoundary(areaName, geometry) {
    const response = await fetch("/api/validate_custom_boundary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ area_name: areaName, geometry }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Validation failed");
    }
    return response.json();
  },

  /**
   * Start preprocessing streets for a location
   */
  async preprocessStreets(location) {
    const response = await fetch("/api/preprocess_streets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to start preprocessing");
    }
    return response.json();
  },

  /**
   * Start preprocessing custom boundary
   */
  async preprocessCustomBoundary(location) {
    const response = await fetch("/api/preprocess_custom_boundary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to start preprocessing");
    }
    return response.json();
  },

  /**
   * Update coverage for an area (full or incremental)
   */
  async updateCoverage(location, mode = "full") {
    const endpoint =
      mode === "incremental"
        ? "/api/street_coverage/incremental"
        : "/api/street_coverage";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 422 && error.detail) {
        const errorMsg = Array.isArray(error.detail)
          ? error.detail
              .map((err) => `${err.loc?.join(".")}: ${err.msg}`)
              .join("; ")
          : error.detail;
        throw new Error(`Validation error: ${errorMsg}`);
      }
      throw new Error(error.detail || "Failed to start update");
    }
    return response.json();
  },

  /**
   * Get task progress
   */
  async getTaskProgress(taskId) {
    const response = await fetch(`/api/street_coverage/${taskId}`);
    if (response.status === 404) {
      throw new Error("Task not found (expired or invalid)");
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    const data = await response.json();
    if (!data || typeof data !== "object" || !data.stage) {
      throw new Error("Invalid data format received from server");
    }
    return data;
  },

  /**
   * Cancel processing for a location
   */
  async cancelProcessing(displayName) {
    const response = await fetch("/api/coverage_areas/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to send cancel request");
    }
    return response.json();
  },

  /**
   * Delete a coverage area
   */
  async deleteArea(displayName) {
    const response = await fetch("/api/coverage_areas/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to delete area");
    }
    return response.json();
  },

  /**
   * Refresh stats for a coverage area
   */
  async refreshStats(locationId) {
    const response = await fetch(
      `/api/coverage_areas/${locationId}/refresh_stats`,
      {
        method: "POST",
      },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to refresh stats");
    }
    return response.json();
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
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: locationId, segment_id: segmentId }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.detail || `API request failed (HTTP ${response.status})`,
      );
    }
    return response.json();
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
    const response = await fetch(
      `/api/driving-navigation/suggest-next-street/${locationId}?${params}`,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    return response.json();
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
    const response = await fetch(`/api/trips_in_bounds?${params}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP Error ${response.status}`);
    }
    const data = await response.json();
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
    if (startLon !== null) params.set("start_lon", startLon.toString());
    if (startLat !== null) params.set("start_lat", startLat.toString());

    const url = `/api/coverage_areas/${locationId}/generate-optimal-route${
      params.toString() ? `?${params}` : ""
    }`;
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get the generated optimal route for a coverage area
   */
  async getOptimalRoute(locationId) {
    const response = await fetch(
      `/api/coverage_areas/${locationId}/optimal-route`,
    );
    if (response.status === 404) {
      return null; // No route generated yet
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    return response.json();
  },

  /**
   * Delete the optimal route for a coverage area
   */
  async deleteOptimalRoute(locationId) {
    const response = await fetch(
      `/api/coverage_areas/${locationId}/optimal-route`,
      {
        method: "DELETE",
      },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    return response.json();
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
    const response = await fetch(`/api/tasks/${taskId}/status`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP error ${response.status}`);
    }
    return response.json();
  },
};

export default COVERAGE_API;
