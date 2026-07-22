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
   * Load all places from the server
   * @param {Function} onPlacesLoaded - Callback with places array
   * @returns {Promise<Map>} Map of place ID to place data
   */
  async loadPlaces(onPlacesLoaded) {
    this.loadingManager?.show("Loading Places");

    try {
      const places = await this.dataService.fetchPlaces();
      const placesMap = new Map(
        places
          .map((place) => {
            const placeId = place?._id ?? place?.id;
            if (placeId === undefined || placeId === null) {
              return null;
            }
            return [String(placeId), place];
          })
          .filter(Boolean)
      );

      if (onPlacesLoaded) {
        await onPlacesLoaded(places);
      }

      this.loadingManager?.hide();
      return placesMap;
    } catch (error) {
      console.error("Error loading places:", error);
      this.notificationManager?.show("Failed to load custom places", "danger");
      this.loadingManager?.hide();
      return new Map();
    }
  }

  /**
   * Load place statistics
   * @param {Object} params - Query parameters
   * @returns {Promise<Array>} Array of statistics
   */
  async loadPlaceStatistics(params = {}) {
    try {
      return await this.dataService.fetchPlaceStatistics(params);
    } catch (error) {
      console.error("Error loading place statistics:", error);
      throw error;
    }
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
      return tripResponse.trip || tripResponse;
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
