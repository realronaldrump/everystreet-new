import apiClient from "../core/api-client.js";

async function fetchPlaces() {
  return apiClient.get("/api/places");
}

async function fetchPlaceStatistics(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/places/statistics${query ? `?${query}` : ""}`);
}

async function fetchPlaceDetailStatistics(placeId) {
  return apiClient.get(`/api/places/${placeId}/statistics`);
}

async function fetchPlaceTrips(placeId) {
  return apiClient.get(`/api/places/${placeId}/trips`);
}

async function fetchNonCustomVisits(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/non_custom_places_visits${query ? `?${query}` : ""}`);
}

async function fetchVisitSuggestions(params = {}) {
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/api/visit_suggestions${query ? `?${query}` : ""}`);
}

async function fetchTrip(tripId) {
  return apiClient.get(`/api/trips/${tripId}`);
}

async function deletePlace(placeId) {
  return apiClient.delete(`/api/places/${placeId}`);
}

async function createPlace(payload) {
  return apiClient.post("/api/places", payload);
}

async function updatePlace(placeId, payload) {
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
