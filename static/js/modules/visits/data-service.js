import apiClient from "../core/api-client.js";

function buildQuery(params = {}) {
  const query = new URLSearchParams(params).toString();
  return query ? `?${query}` : "";
}

export function createVisitsDataService(client = apiClient) {
  return {
    fetchPlaces(options = {}) {
      return client.get("/api/places", options);
    },

    fetchPlaceStatistics(params = {}, options = {}) {
      return client.get(`/api/places/statistics${buildQuery(params)}`, options);
    },

    fetchPlaceDetailStatistics(placeId, options = {}) {
      return client.get(`/api/places/${placeId}/statistics`, options);
    },

    fetchPlaceTrips(placeId, options = {}) {
      return client.get(`/api/places/${placeId}/trips`, options);
    },

    fetchNonCustomVisits(params = {}, options = {}) {
      return client.get(`/api/non_custom_places_visits${buildQuery(params)}`, options);
    },

    fetchVisitSuggestions(params = {}, options = {}) {
      return client.get(`/api/visit_suggestions${buildQuery(params)}`, options);
    },

    fetchTrip(tripId, options = {}) {
      return client.get(`/api/trips/${tripId}`, options);
    },

    deletePlace(placeId, options = {}) {
      return client.delete(`/api/places/${placeId}`, options);
    },

    createPlace(payload, options = {}) {
      return client.post("/api/places", payload, options);
    },

    updatePlace(placeId, payload, options = {}) {
      return client.patch(`/api/places/${placeId}`, payload, options);
    },
  };
}

const visitsDataService = createVisitsDataService(apiClient);

const fetchPlaces = (...args) => visitsDataService.fetchPlaces(...args);
const fetchPlaceStatistics = (...args) => visitsDataService.fetchPlaceStatistics(...args);
const fetchPlaceDetailStatistics = (...args) =>
  visitsDataService.fetchPlaceDetailStatistics(...args);
const fetchPlaceTrips = (...args) => visitsDataService.fetchPlaceTrips(...args);
const fetchNonCustomVisits = (...args) => visitsDataService.fetchNonCustomVisits(...args);
const fetchVisitSuggestions = (...args) => visitsDataService.fetchVisitSuggestions(...args);
const fetchTrip = (...args) => visitsDataService.fetchTrip(...args);
const deletePlace = (...args) => visitsDataService.deletePlace(...args);
const createPlace = (...args) => visitsDataService.createPlace(...args);
const updatePlace = (...args) => visitsDataService.updatePlace(...args);

export {
  createPlace,
  deletePlace,
  fetchNonCustomVisits,
  fetchPlaceDetailStatistics,
  fetchPlaceStatistics,
  fetchPlaceTrips,
  fetchPlaces,
  fetchTrip,
  fetchVisitSuggestions,
  updatePlace,
};

export default visitsDataService;
