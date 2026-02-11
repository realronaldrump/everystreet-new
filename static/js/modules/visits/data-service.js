import apiClient from "../core/api-client.js";

function fetchPlaces() {
  return apiClient.get("/api/places");
}

function fetchPlaceStatistics(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/places/statistics${query ? `?${query}` : ""}`);
}

function fetchPlaceDetailStatistics(placeId) {
  return apiClient.get(`/api/places/${placeId}/statistics`);
}

function fetchPlaceTrips(placeId) {
  return apiClient.get(`/api/places/${placeId}/trips`);
}

function fetchNonCustomVisits(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/non_custom_places_visits${query ? `?${query}` : ""}`);
}

function fetchVisitSuggestions(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/visit_suggestions${query ? `?${query}` : ""}`);
}

function fetchTrip(tripId) {
  return apiClient.get(`/api/trips/${tripId}`);
}

function deletePlace(placeId) {
  return apiClient.delete(`/api/places/${placeId}`);
}

function createPlace(payload) {
  return apiClient.post("/api/places", payload);
}

function updatePlace(placeId, payload) {
  return apiClient.patch(`/api/places/${placeId}`, payload);
}

const VisitsDataService = {
  fetchPlaces,
  fetchPlaceStatistics,
  fetchPlaceDetailStatistics,
  fetchPlaceTrips,
  fetchNonCustomVisits,
  fetchVisitSuggestions,
  fetchTrip,
  deletePlace,
  createPlace,
  updatePlace,
};

export {
  VisitsDataService,
  fetchPlaces,
  fetchPlaceStatistics,
  fetchPlaceDetailStatistics,
  fetchPlaceTrips,
  fetchNonCustomVisits,
  fetchVisitSuggestions,
  fetchTrip,
  deletePlace,
  createPlace,
  updatePlace,
};

export default VisitsDataService;
