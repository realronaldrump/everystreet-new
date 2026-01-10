/**
 * Unified Geolocation Service
 * Consolidates all navigator.geolocation usage with consistent error handling
 * Replaces 5+ scattered geolocation implementations
 */

class GeolocationService {
  constructor() {
    this.watchId = null;
    this.lastPosition = null;
    this.isWatching = false;
    this.defaultOptions = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    };
  }

  /**
   * Check if geolocation is supported
   */
  isSupported() {
    return "geolocation" in navigator;
  }

  /**
   * Get current position once
   */
  async getCurrentPosition(options = {}) {
    if (!this.isSupported()) {
      throw new Error("Geolocation is not supported by this browser");
    }

    const mergedOptions = { ...this.defaultOptions, ...options };

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.lastPosition = position;
          resolve(this._formatPosition(position));
        },
        (error) => {
          reject(this._handleError(error));
        },
        mergedOptions,
      );
    });
  }

  /**
   * Watch position continuously
   */
  watchPosition(callback, errorCallback = null, options = {}) {
    if (!this.isSupported()) {
      throw new Error("Geolocation is not supported by this browser");
    }

    if (this.isWatching) {
      this.clearWatch();
    }

    const mergedOptions = { ...this.defaultOptions, ...options };

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.lastPosition = position;
        this.isWatching = true;
        callback(this._formatPosition(position));
      },
      (error) => {
        const formattedError = this._handleError(error);
        if (errorCallback) {
          errorCallback(formattedError);
        } else {
          console.error("Geolocation error:", formattedError);
        }
      },
      mergedOptions,
    );

    return this.watchId;
  }

  /**
   * Clear position watch
   */
  clearWatch() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      this.isWatching = false;
    }
  }

  /**
   * Get last known position
   */
  getLastPosition() {
    return this.lastPosition ? this._formatPosition(this.lastPosition) : null;
  }

  /**
   * Calculate distance between two positions (Haversine formula)
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }

  /**
   * Calculate bearing between two positions
   */
  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    const θ = Math.atan2(y, x);
    const bearing = ((θ * 180) / Math.PI + 360) % 360;

    return bearing;
  }

  /**
   * Get cardinal direction from bearing
   */
  getCardinalDirection(bearing) {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
  }

  /**
   * Check if position has acceptable accuracy
   */
  hasAcceptableAccuracy(position, maxAccuracy = 100) {
    return position.accuracy && position.accuracy <= maxAccuracy;
  }

  /**
   * Format position data consistently
   */
  _formatPosition(position) {
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: position.coords.altitude,
      altitudeAccuracy: position.coords.altitudeAccuracy,
      heading: position.coords.heading,
      speed: position.coords.speed,
      timestamp: position.timestamp,
      coords: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      },
    };
  }

  /**
   * Handle geolocation errors consistently
   */
  _handleError(error) {
    const errorMessages = {
      1: "Location access denied. Please enable location permissions.",
      2: "Location unavailable. Please check your device settings.",
      3: "Location request timeout. Please try again.",
    };

    const message =
      errorMessages[error.code] || "An unknown geolocation error occurred";

    return new Error(message);
  }

  /**
   * Request permission (if Permissions API is available)
   */
  async requestPermission() {
    if ("permissions" in navigator) {
      try {
        const result = await navigator.permissions.query({
          name: "geolocation",
        });
        return result.state; // 'granted', 'denied', or 'prompt'
      } catch (_error) {
        // Permissions API not fully supported, fall back to trying getCurrentPosition
        return "prompt";
      }
    }
    return "prompt";
  }

  /**
   * Get position with timeout and fallback
   */
  async getPositionWithFallback(primaryOptions = {}, fallbackOptions = {}) {
    try {
      return await this.getCurrentPosition(primaryOptions);
    } catch (_error) {
      // Try with less strict options as fallback
      const relaxedOptions = {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 60000, // Accept cached position up to 1 minute old
        ...fallbackOptions,
      };
      return await this.getCurrentPosition(relaxedOptions);
    }
  }
}

// Create singleton instance
const geolocationService = new GeolocationService();

// Export both class and singleton
export { GeolocationService, geolocationService };
export default geolocationService;
