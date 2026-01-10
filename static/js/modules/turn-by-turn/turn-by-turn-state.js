/**
 * Turn-by-Turn State Module
 * Navigation state machine and transitions
 */

import { NAV_STATES } from "./turn-by-turn-config.js";
import { distanceMeters } from "./turn-by-turn-geo.js";

/**
 * State machine for turn-by-turn navigation
 */
class TurnByTurnState {
  constructor(config = {}) {
    this.config = {
      startThresholdMeters: 50,
      offRouteThresholdMeters: 60,
      resumeSearchRadiusMeters: 500,
      ...config,
    };

    this.currentState = NAV_STATES.SETUP;
    this.previousState = null;

    // Smart start data
    this.smartStartIndex = 0;
    this.smartStartPoint = null;
    this.smartStartDistance = null;

    // Resume ahead data
    this.resumeAheadData = null;

    // Callbacks
    this.onStateChange = null;
  }

  /**
   * Set state change callback
   * @param {Function} callback
   */
  setStateChangeCallback(callback) {
    this.onStateChange = callback;
  }

  /**
   * Get current state
   * @returns {string}
   */
  getState() {
    return this.currentState;
  }

  /**
   * Transition to a new state
   * @param {string} newState
   */
  transitionTo(newState) {
    if (this.currentState === newState) return;

    this.previousState = this.currentState;
    this.currentState = newState;

    if (this.onStateChange) {
      this.onStateChange(newState, this.previousState);
    }
  }

  /**
   * Handle navigation state transitions based on position
   * @param {number} progress - Current progress distance
   * @param {number} remaining - Remaining distance
   * @param {boolean} offRoute - Whether user is off route
   * @param {Object} closest - Closest point info
   * @param {Function} offerResumeCallback - Callback to offer resume
   */
  handleNavigationStateTransitions(
    _progress,
    remaining,
    offRoute,
    closest,
    offerResumeCallback
  ) {
    // Check for arrival
    if (remaining < 25 && this.currentState !== NAV_STATES.ARRIVED) {
      this.transitionTo(NAV_STATES.ARRIVED);
      return;
    }

    // Check for off-route condition
    if (offRoute && this.currentState === NAV_STATES.ACTIVE_NAVIGATION) {
      // Check if significantly off-route (potential for resume ahead)
      if (closest.distance > this.config.resumeSearchRadiusMeters) {
        if (offerResumeCallback) {
          offerResumeCallback();
        }
      } else {
        this.transitionTo(NAV_STATES.OFF_ROUTE);
      }
      return;
    }

    // Return to active navigation if back on route
    if (!offRoute && this.currentState === NAV_STATES.OFF_ROUTE) {
      this.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
    }
  }

  /**
   * Find the closest point on the route to the user's position (smart start)
   * @param {{lat: number, lon: number}} userPosition
   * @param {Array<[number, number]>} routeCoords
   * @returns {{index: number, point: [number, number], distanceFromUser: number, isAtStart: boolean}}
   */
  findSmartStartPoint(userPosition, routeCoords) {
    if (!userPosition || !routeCoords.length) {
      return {
        index: 0,
        point: routeCoords[0],
        distanceFromUser: Infinity,
        isAtStart: false,
      };
    }

    const userCoord = [userPosition.lon, userPosition.lat];
    let bestIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < routeCoords.length; i++) {
      const dist = distanceMeters(userCoord, routeCoords[i]);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestIndex = i;
      }
    }

    this.smartStartIndex = bestIndex;
    this.smartStartPoint = routeCoords[bestIndex];
    this.smartStartDistance = bestDistance;

    return {
      index: bestIndex,
      point: this.smartStartPoint,
      distanceFromUser: bestDistance,
      isAtStart: bestDistance <= this.config.startThresholdMeters,
    };
  }

  /**
   * Find the nearest point on the route that is AHEAD of current progress
   * @param {[number, number]} userCoord
   * @param {Array<[number, number]>} routeCoords
   * @param {number} lastClosestIndex
   * @returns {{index: number, point: [number, number], distance: number}|null}
   */
  findNearestPointAhead(userCoord, routeCoords, lastClosestIndex) {
    const searchStart = Math.max(0, lastClosestIndex);
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = searchStart; i < routeCoords.length; i++) {
      const dist = distanceMeters(userCoord, routeCoords[i]);
      if (dist < bestDistance && dist < this.config.resumeSearchRadiusMeters) {
        bestDistance = dist;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      return {
        index: bestIndex,
        point: routeCoords[bestIndex],
        distance: bestDistance,
      };
    }

    return null;
  }

  /**
   * Set resume ahead data
   * @param {Object} data
   */
  setResumeAheadData(data) {
    this.resumeAheadData = data;
  }

  /**
   * Get resume ahead data
   * @returns {Object|null}
   */
  getResumeAheadData() {
    return this.resumeAheadData;
  }

  /**
   * Clear resume ahead data
   */
  clearResumeAheadData() {
    this.resumeAheadData = null;
  }

  /**
   * Reset state machine
   */
  reset() {
    this.currentState = NAV_STATES.SETUP;
    this.previousState = null;
    this.smartStartIndex = 0;
    this.smartStartPoint = null;
    this.smartStartDistance = null;
    this.resumeAheadData = null;
  }
}

export default TurnByTurnState;
