// static/js/coverage/api-manager.js
class ApiManager {
    constructor(notificationManager) {
      this.notificationManager = notificationManager;
      this.baseHeaders = { 'Content-Type': 'application/json' };
    }
  
    async request(url, options = {}) {
      const config = {
        method: 'GET',
        headers: { ...this.baseHeaders, ...options.headers },
        ...options
      };
  
      if (config.body && typeof config.body === 'object') {
        config.body = JSON.stringify(config.body);
      }
  
      try {
        const response = await fetch(url, config);
        const data = await response.json();
  
        if (!response.ok) {
          throw new Error(data.detail || `HTTP ${response.status}`);
        }
  
        return data;
      } catch (error) {
        console.error(`API Error (${config.method} ${url}):`, error);
        throw error;
      }
    }
  
    // Coverage Areas
    async getCoverageAreas() {
      return this.request('/api/coverage_areas');
    }
  
    async getCoverageArea(id) {
      return this.request(`/api/coverage_areas/${id}`);
    }
  
    async getStreets(id, params = {}) {
      const query = new URLSearchParams(params).toString();
      return this.request(`/api/coverage_areas/${id}/streets?${query}`);
    }
  
    async refreshStats(id) {
      return this.request(`/api/coverage_areas/${id}/refresh_stats`, { method: 'POST' });
    }
  
    async deleteArea(location) {
      return this.request('/api/coverage_areas/delete', {
        method: 'POST',
        body: { display_name: location.display_name }
      });
    }
  
    async cancelProcessing(location) {
      return this.request('/api/coverage_areas/cancel', {
        method: 'POST',
        body: { display_name: location.display_name }
      });
    }
  
    // Location and Validation
    async validateLocation(location, locationType) {
      return this.request('/api/validate_location', {
        method: 'POST',
        body: { location, locationType }
      });
    }
  
    async validateCustomBoundary(areaName, geometry) {
      return this.request('/api/validate_custom_boundary', {
        method: 'POST',
        body: { area_name: areaName, geometry }
      });
    }
  
    // Processing
    async preprocessStreets(location) {
      return this.request('/api/preprocess_streets', {
        method: 'POST',
        body: location
      });
    }
  
    async preprocessCustomBoundary(location) {
      return this.request('/api/preprocess_custom_boundary', {
        method: 'POST',
        body: location
      });
    }
  
    async updateCoverage(location, mode = 'full') {
      const endpoint = mode === 'incremental' 
        ? '/api/street_coverage/incremental' 
        : '/api/street_coverage';
      
      return this.request(endpoint, {
        method: 'POST',
        body: location
      });
    }
  
    async getTaskStatus(taskId) {
      return this.request(`/api/street_coverage/${taskId}`);
    }
  
    // Street Segments
    async markSegment(locationId, segmentId, action) {
      const endpoints = {
        driven: '/api/street_segments/mark_driven',
        undriven: '/api/street_segments/mark_undriven',
        undriveable: '/api/street_segments/mark_undriveable',
        driveable: '/api/street_segments/mark_driveable'
      };
  
      return this.request(endpoints[action], {
        method: 'POST',
        body: { location_id: locationId, segment_id: segmentId }
      });
    }
  
    // Navigation
    async getSuggestedStreets(locationId, lat, lon, topN = 3) {
      const params = new URLSearchParams({
        current_lat: lat,
        current_lon: lon,
        top_n: topN
      });
      return this.request(`/api/driving-navigation/suggest-next-street/${locationId}?${params}`);
    }
  
    // Trips
    async getTripsInBounds(bounds) {
      const params = new URLSearchParams(bounds);
      return this.request(`/api/trips_in_bounds?${params}`);
    }
  }