/**
 * Visits Data Loader Module
 * Handles data fetching and loading operations for places and visits
 */

(() => {
  class VisitsDataLoader {
    constructor(options = {}) {
      this.loadingManager = options.loadingManager || window.loadingManager;
      this.notificationManager
        = options.notificationManager || window.notificationManager;
    }

    /**
     * Load all places from the server
     * @param {Function} onPlacesLoaded - Callback with places array
     * @returns {Promise<Map>} Map of place ID to place data
     */
    async loadPlaces(onPlacesLoaded) {
      this.loadingManager?.startOperation("Loading Places");

      try {
        const places = await window.VisitsDataService.fetchPlaces();
        const placesMap = new Map(places.map((place) => [place._id, place]));

        if (onPlacesLoaded) {
          await onPlacesLoaded(places);
        }

        this.loadingManager?.finish("Loading Places");
        return placesMap;
      } catch (error) {
        console.error("Error loading places:", error);
        this.notificationManager?.show("Failed to load custom places", "danger");
        this.loadingManager?.error("Failed during Loading Places");
        return new Map();
      }
    }

    /**
     * Load non-custom places visits
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} Array of visit data
     */
    async loadNonCustomPlacesVisits(params = {}) {
      this.loadingManager?.updateMessage("Loading other locations...");

      try {
        return await window.VisitsDataService.fetchNonCustomVisits(params);
      } catch (error) {
        console.error("Error fetching non-custom places visits:", error);
        this.notificationManager?.show(
          "Failed to load non-custom places visits",
          "danger"
        );
        return [];
      }
    }

    /**
     * Load visit suggestions
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} Array of suggestions
     */
    async loadSuggestions(params = {}) {
      try {
        const tfSelect = document.getElementById("time-filter");
        if (tfSelect?.value !== "all" && tfSelect?.value) {
          params.timeframe = tfSelect.value;
        }

        return await window.VisitsDataService.fetchVisitSuggestions(params);
      } catch (error) {
        console.error("Error loading visit suggestions", error);
        return [];
      }
    }

    /**
     * Load place statistics
     * @param {Object} params - Query parameters
     * @returns {Promise<Array>} Array of statistics
     */
    async loadPlaceStatistics(params = {}) {
      try {
        return await window.VisitsDataService.fetchPlaceStatistics(params);
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
        return await window.VisitsDataService.fetchPlaceDetailStatistics(placeId);
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
      this.loadingManager?.startOperation("Loading Trips");

      try {
        const data = await window.VisitsDataService.fetchPlaceTrips(placeId);
        this.loadingManager?.finish("Loading Trips");
        return data;
      } catch (error) {
        console.error(`Error fetching trips for place ${placeId}:`, error);
        this.notificationManager?.show(
          "Failed to fetch trips for the selected place.",
          "danger"
        );
        this.loadingManager?.finish("Loading Trips");
        return { trips: [], name: null };
      }
    }

    /**
     * Load a specific trip
     * @param {string} tripId - Trip ID
     * @returns {Promise<Object>} Trip data
     */
    async loadTrip(tripId) {
      this.loadingManager?.startOperation("Loading Trip");

      try {
        const tripResponse = await window.VisitsDataService.fetchTrip(tripId);
        this.loadingManager?.finish("Loading Trip");
        return tripResponse.trip || tripResponse;
      } catch (error) {
        console.error("Error fetching trip data:", error);
        this.loadingManager?.error("Failed to fetch trip data");
        this.notificationManager?.show(
          "Error loading trip data. Please try again.",
          "danger"
        );
        throw error;
      }
    }

    /**
     * Filter data by timeframe and reload relevant tables
     * @param {string} timeframe - Timeframe filter value
     * @returns {Promise<Object>} Object containing customStats and otherStats
     */
    async filterByTimeframe(timeframe) {
      try {
        const [customStats, otherStats] = await Promise.all([
          window.VisitsDataService.fetchPlaceStatistics({ timeframe }),
          window.VisitsDataService.fetchNonCustomVisits({ timeframe }),
        ]);

        return { customStats, otherStats };
      } catch (error) {
        console.error("Error filtering by timeframe:", error);
        this.notificationManager?.show("Error filtering data", "danger");
        throw error;
      }
    }
  }

  window.VisitsDataLoader = VisitsDataLoader;
})();
