"use strict";

// Classic script: centralized API calls for coverage.
// Exposes: window.CoverageAPI

(() => {
  const headers = { "Content-Type": "application/json" };

  async function request(url, options = {}) {
    const resp = await fetch(url, options);
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      /* ignore non-JSON */
    }
    if (!resp.ok) {
      const detail = data?.detail || resp.statusText || `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return data;
  }

  const CoverageAPI = {
    getCoverageAreas() {
      return request("/api/coverage_areas");
    },
    cancelCoverage(display_name) {
      return request("/api/coverage_areas/cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({ display_name }),
      });
    },
    deleteCoverage(display_name) {
      return request("/api/coverage_areas/delete", {
        method: "POST",
        headers,
        body: JSON.stringify({ display_name }),
      });
    },
    __validateLocation(payload) {
      return request("/api/validate_location", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },
    getCoverageArea(locationId) {
      return request(`/api/coverage_areas/${locationId}`);
    },
    getCoverageAreaStreets(locationId) {
      return request(
        `/api/coverage_areas/${locationId}/streets?cache_bust=${Date.now()}`,
      );
    },
    refreshCoverageStats(locationId) {
      return request(`/api/coverage_areas/${locationId}/refresh_stats`, {
        method: "POST",
      });
    },
    preprocessStreets(locationPayload) {
      return request("/api/preprocess_streets", {
        method: "POST",
        headers,
        body: JSON.stringify(locationPayload),
      });
    },
    preprocessCustomBoundary(payload) {
      return request("/api/preprocess_custom_boundary", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },
    reprocess(locationPayload) {
      const endpoint =
        locationPayload?.osm_type === "custom"
          ? "/api/preprocess_custom_boundary"
          : "/api/preprocess_streets";
      return request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(locationPayload),
      });
    },
    validateCustomBoundary(payload) {
      return request("/api/validate_custom_boundary", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },
    markSegment(endpoint, payload) {
      return request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    },
    startCoverageUpdate(locationPayload, mode = "full") {
      const endpoint =
        mode === "incremental"
          ? "/api/street_coverage/incremental"
          : "/api/street_coverage";
      return request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(locationPayload),
      });
    },
    tripsInBounds(params) {
      return request(`/api/trips_in_bounds?${new URLSearchParams(params)}`);
    },
  };

  window.CoverageAPI = CoverageAPI;
})();
