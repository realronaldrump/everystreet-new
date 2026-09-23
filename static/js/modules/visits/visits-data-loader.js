/**
 * Visits Data Loader Module
 * Handles data fetching and loading operations for places and visits
 */

import loadingManager from "../ui/loading-manager.js";
import notificationManager from "../ui/notifications.js";
import VisitsDataService from "./data-service.js";

class VisitsDataLoader {
  constructor(options = {}) {
    this.dataService = options.dataService || VisitsDataService;
    this.loadingManager = options.loadingManager || loadingManager;
    this.notificationManager = options.notificationManager || notificationManager;
  }

  /**
   * Load detailed statistics for a specific place
   * @param {string} placeId - Place ID
   * @returns {Promise<Object>} Place statistics
   */
  async loadPlaceDetailStatistics(placeId) {
    try {
      return await this.dataService.fetchPlaceDetailStatistics(placeId);
    } catch (error) {
      console.error("Error fetching place statistics:", error);
      throw error;
    }
  }

  /**
   * Load trips for a specific place
   * @param {string} placeId - Place ID
   * @returns {Promise<Object>} Trips data with trips array and place name
   */
  async loadPlaceTrips(placeId) {
    this.loadingManager?.show("Loading Trips");

    try {
      const data = await this.dataService.fetchPlaceTrips(placeId);
      this.loadingManager?.hide();
      return data;
    } catch (error) {
      console.error(`Error fetching trips for place ${placeId}:`, error);
      this.notificationManager?.show(
        "Failed to fetch trips for the selected place.",
        "danger"
      );
      this.loadingManager?.hide();
      return { trips: [], name: null };
    }
  }

  /**
   * Load a specific trip
   * @param {string} tripId - Trip ID
   * @returns {Promise<Object>} Trip data
   */
  async loadTrip(tripId) {
    this.loadingManager?.show("Loading Trip");

    try {
      const tripResponse = await this.dataService.fetchTrip(tripId);
      this.loadingManager?.hide();
      return tripResponse.trip;
    } catch (error) {
      console.error("Error fetching trip data:", error);
      this.loadingManager?.hide();
      this.notificationManager?.show(
        "Error loading trip data. Please try again.",
        "danger"
      );
      throw error;
    }
  }
}

export default VisitsDataLoader;
