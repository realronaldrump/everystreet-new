/**
 * Coverage API Module (New Unified API)
 * Handles all API calls related to coverage areas using the new /api/areas/* endpoints
 */

const COVERAGE_API = {
  /**
   * Fetch all coverage areas
   */
  async getAllAreas() {
    const response = await fetch("/api/areas");
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
  async getArea(areaId) {
    const response = await fetch(`/api/areas/${areaId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data.success || !data.area) {
      throw new Error(data.error || "Failed to fetch coverage area");
    }
    return data.area;
  },

  /**
   * Create a new coverage area
   */
  async createArea(areaConfig) {
    const response = await fetch("/api/areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(areaConfig),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Delete a coverage area
   */
  async deleteArea(areaId) {
    const response = await fetch(`/api/areas/${areaId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to delete area");
    }
    return response.json();
  },

  /**
   * Trigger area rebuild
   */
  async rebuildArea(areaId) {
    const response = await fetch(`/api/areas/${areaId}/rebuild`, {
      method: "POST",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to trigger rebuild");
    }
    return response.json();
  },

  /**
   * Fetch streets in viewport with coverage status
   */
  async getStreetsInViewport(areaId, bounds, zoom = 14, includeCoverage = true) {
    const params = new URLSearchParams({
      west: bounds.west.toFixed(6),
      south: bounds.south.toFixed(6),
      east: bounds.east.toFixed(6),
      north: bounds.north.toFixed(6),
      zoom: zoom.toString(),
      include_coverage: includeCoverage.toString(),
    });
    const response = await fetch(`/api/areas/${areaId}/streets/viewport?${params}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Fetch coverage status in viewport (lightweight, no geometry)
   */
  async getCoverageInViewport(areaId, bounds) {
    const params = new URLSearchParams({
      west: bounds.west.toFixed(6),
      south: bounds.south.toFixed(6),
      east: bounds.east.toFixed(6),
      north: bounds.north.toFixed(6),
    });
    const response = await fetch(`/api/areas/${areaId}/coverage/viewport?${params}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get area statistics
   */
  async getAreaStats(areaId) {
    const response = await fetch(`/api/areas/${areaId}/stats`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get segment details
   */
  async getSegmentDetails(areaId, segmentId) {
    const response = await fetch(`/api/areas/${areaId}/segments/${segmentId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Set manual override for a segment
   */
  async setSegmentOverride(areaId, segmentId, status, note = null) {
    const response = await fetch(`/api/areas/${areaId}/segments/${segmentId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Clear manual override for a segment
   */
  async clearSegmentOverride(areaId, segmentId) {
    const response = await fetch(`/api/areas/${areaId}/segments/${segmentId}/override`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Bulk override segments
   */
  async bulkOverrideSegments(areaId, segmentIds, status, note = null) {
    const response = await fetch(`/api/areas/${areaId}/segments/bulk-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_ids: segmentIds, status, note }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Generate optimal route for undriven streets
   */
  async generateRoute(areaId, startLon = null, startLat = null) {
    const body = {};
    if (startLon !== null) body.start_lon = startLon;
    if (startLat !== null) body.start_lat = startLat;

    const response = await fetch(`/api/areas/${areaId}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get GPX download URL for route
   */
  getRouteGpxUrl(areaId, startLon = null, startLat = null) {
    const params = new URLSearchParams();
    if (startLon !== null) params.set("start_lon", startLon.toString());
    if (startLat !== null) params.set("start_lat", startLat.toString());
    const queryString = params.toString();
    return `/api/areas/${areaId}/route/gpx${queryString ? `?${queryString}` : ""}`;
  },

  /**
   * Clear route cache
   */
  async clearRouteCache(areaId) {
    const response = await fetch(`/api/areas/${areaId}/route/cache`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get jobs for an area
   */
  async getAreaJobs(areaId, limit = 10) {
    const response = await fetch(`/api/areas/${areaId}/jobs?limit=${limit}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get active job for an area
   */
  async getActiveJob(areaId) {
    const response = await fetch(`/api/areas/${areaId}/active-job`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId) {
    const response = await fetch(`/api/areas/jobs/${jobId}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Run sanity check on an area
   */
  async sanityCheck(areaId, repair = true) {
    const response = await fetch(`/api/areas/${areaId}/sanity-check?repair=${repair}`, {
      method: "POST",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * Get trips within bounds (unchanged - still uses old endpoint)
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
   * Search for OSM places (for area creation)
   */
  async searchPlaces(query) {
    const response = await fetch(`/api/search/places?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }
    return response.json();
  },
};

export default COVERAGE_API;
