/**
 * Turn-by-Turn GPS Module
 * Handles geolocation, speed calculation, and progress smoothing
 */

import geolocationService from "../geolocation-service.js";
import { bearing, distanceMeters } from "./turn-by-turn-geo.js";

/**
 * GPS handler class for turn-by-turn navigation
 */
class TurnByTurnGPS {
  constructor(config = {}) {
    this.config = {
      maxProgressHistoryLength: 5,
      maxBackwardJumpMeters: 50,
      maxSpeedMps: 50, // ~112 mph
      maxSpeedSamples: 6,
      ...config,
    };

    this.watchId = null;
    this.lastPosition = null;
    this.lastPositionTime = null;
    this.lastHeading = null;
    this.speedSamples = [];

    // Progress smoothing
    this.progressHistory = [];
    this.lastValidProgress = 0;
    this.lastProgressTime = Date.now();
  }

  /**
   * Check if geolocation is available
   * @returns {boolean}
   */
  static isAvailable() {
    return geolocationService.isSupported();
  }

  /**
   * Start watching user position
   * @param {Function} onPosition - Called with position data
   * @param {Function} onError - Called with GeolocationPositionError
   */
  startGeolocation(onPosition, onError) {
    this.stopGeolocation();

    if (!TurnByTurnGPS.isAvailable()) {
      onError(new Error("Geolocation not available"));
      return;
    }

    this.watchId = geolocationService.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, heading, speed } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return;
        }

        const fix = {
          lat: latitude,
          lon: longitude,
          accuracy,
          heading,
          speed,
          timestamp: position.timestamp || Date.now(),
        };

        onPosition(fix);
      },
      onError,
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 1000,
      }
    );
  }

  /**
   * Stop watching user position
   */
  stopGeolocation() {
    if (this.watchId !== null) {
      geolocationService.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  /**
   * Get current position once
   * @returns {Promise<{lat: number, lon: number}>}
   */
  async getCurrentPosition() {
    if (!TurnByTurnGPS.isAvailable()) {
      throw new Error("Geolocation not available");
    }

    const position = await geolocationService.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 5000,
    });

    return {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
    };
  }

  /**
   * Resolve heading from fix or calculate from last position
   * @param {Object} fix - Current position fix
   * @param {Object} closest - Closest point on route info
   * @param {Array<[number, number]>} routeCoords - Route coordinates for default
   * @returns {number|null}
   */
  resolveHeading(fix, closest, routeCoords) {
    let heading = Number.isFinite(fix.heading) ? fix.heading : null;

    if (!heading && this.lastPosition) {
      heading = bearing(
        [this.lastPosition.lon, this.lastPosition.lat],
        [fix.lon, fix.lat]
      );
    }

    if (!heading && closest && closest.index < routeCoords.length - 1) {
      heading = bearing(routeCoords[closest.index], routeCoords[closest.index + 1]);
    }

    this.lastHeading = heading;
    return heading;
  }

  /**
   * Resolve speed from fix or calculate from movement
   * @param {Object} fix - Current position fix
   * @returns {number|null} Speed in m/s
   */
  resolveSpeed(fix) {
    let speedMps = Number.isFinite(fix.speed) ? fix.speed : null;

    if (!speedMps && this.lastPosition && this.lastPositionTime) {
      const now = fix.timestamp;
      const last = this.lastPositionTime;
      const deltaTime = (now - last) / 1000;

      if (deltaTime > 0) {
        const distance = distanceMeters(
          [this.lastPosition.lon, this.lastPosition.lat],
          [fix.lon, fix.lat]
        );
        speedMps = distance / deltaTime;
      }
    }

    if (speedMps) {
      this.speedSamples.push(speedMps);
      if (this.speedSamples.length > this.config.maxSpeedSamples) {
        this.speedSamples.shift();
      }
    }

    // Update last position
    this.lastPosition = { lat: fix.lat, lon: fix.lon };
    this.lastPositionTime = fix.timestamp;

    return this.getAverageSpeed();
  }

  /**
   * Get average speed from samples
   * @returns {number|null}
   */
  getAverageSpeed() {
    if (this.speedSamples.length === 0) {
      return null;
    }
    const sum = this.speedSamples.reduce((acc, v) => acc + v, 0);
    return sum / this.speedSamples.length;
  }

  /**
   * Progress smoothing algorithm - reduces GPS jitter
   * @param {number} rawProgress - Raw progress distance
   * @returns {number} Smoothed progress
   */
  smoothProgress(rawProgress) {
    const now = Date.now();
    const timeDelta = (now - this.lastProgressTime) / 1000;

    // Add to history
    this.progressHistory.push(rawProgress);
    if (this.progressHistory.length > this.config.maxProgressHistoryLength) {
      this.progressHistory.shift();
    }

    // Rule 1: Reject large backward jumps unless confirmed by multiple samples
    if (this.lastValidProgress - rawProgress > this.config.maxBackwardJumpMeters) {
      const backwardCount = this.progressHistory.filter(
        (p) => p < this.lastValidProgress - this.config.maxBackwardJumpMeters
      ).length;

      // Require 3+ confirmations before accepting regression
      if (backwardCount < 3) {
        return this.lastValidProgress;
      }
    }

    // Rule 2: Clamp forward jumps to physically possible speed
    const maxForward = this.config.maxSpeedMps * timeDelta;
    let clampedProgress = rawProgress;
    if (rawProgress - this.lastValidProgress > maxForward && timeDelta > 0) {
      clampedProgress = this.lastValidProgress + maxForward;
    }

    // Rule 3: Weighted moving average for smoothness
    const avg =
      this.progressHistory.reduce((a, b) => a + b, 0) / this.progressHistory.length;

    // Blend: 70% current, 30% average
    const smoothed = clampedProgress * 0.7 + avg * 0.3;

    this.lastValidProgress = smoothed;
    this.lastProgressTime = now;

    return smoothed;
  }

  /**
   * Reset smoothing state
   */
  resetSmoothing() {
    this.progressHistory = [];
    this.lastValidProgress = 0;
    this.lastProgressTime = Date.now();
  }

  /**
   * Reset all state
   */
  reset() {
    this.stopGeolocation();
    this.lastPosition = null;
    this.lastPositionTime = null;
    this.lastHeading = null;
    this.speedSamples = [];
    this.resetSmoothing();
  }
}

export default TurnByTurnGPS;
