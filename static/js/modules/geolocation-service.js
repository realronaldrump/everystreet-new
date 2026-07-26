/**
 * Unified Geolocation Service
 * Consolidates all navigator.geolocation usage with consistent error handling
 * Replaces 5+ scattered geolocation implementations
 */

class GeolocationService {
  constructor() {
    this.watchId = null;
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
    return typeof navigator !== "undefined" && "geolocation" in navigator;
  }

  /**
   * Get current position once
   */
  getCurrentPosition(options = {}) {
    if (!this.isSupported()) {
      throw new Error("Geolocation is not supported by this browser");
    }

    const mergedOptions = { ...this.defaultOptions, ...options };

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve(this._formatPosition(position));
        },
        (error) => {
          reject(this._handleError(error));
        },
        mergedOptions
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
      mergedOptions
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
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        altitudeAccuracy: position.coords.altitudeAccuracy,
        heading: position.coords.heading,
        speed: position.coords.speed,
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
}

// Create singleton instance
const geolocationService = new GeolocationService();

export default geolocationService;
