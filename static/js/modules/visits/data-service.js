(() => {
  async function parseJsonResponse(response, context) {
    if (!response.ok) {
      throw new Error(context || `Request failed with status ${response.status}`);
    }
    return await response.json();
  }

  async function fetchPlaces() {
    const response = await fetch("/api/places");
    return parseJsonResponse(response, "Failed to fetch places");
  }

  async function fetchPlaceStatistics(params = {}) {
    const search = new URLSearchParams(params);
    const query = search.toString();
    const response = await fetch(`/api/places/statistics${query ? `?${query}` : ""}`);
    return parseJsonResponse(response, "Failed to fetch place statistics");
  }

  async function fetchPlaceDetailStatistics(placeId) {
    const response = await fetch(`/api/places/${placeId}/statistics`);
    return parseJsonResponse(response, "Failed to fetch place detail statistics");
  }

  async function fetchPlaceTrips(placeId) {
    const response = await fetch(`/api/places/${placeId}/trips`);
    return parseJsonResponse(response, "Failed to fetch trips for place");
  }

  async function fetchNonCustomVisits(params = {}) {
    const search = new URLSearchParams(params);
    const query = search.toString();
    const response = await fetch(
      `/api/non_custom_places_visits${query ? `?${query}` : ""}`
    );
    return parseJsonResponse(response, "Failed to fetch non-custom place visits");
  }

  async function fetchVisitSuggestions(params = {}) {
    const search = new URLSearchParams(params);
    const query = search.toString();
    const response = await fetch(`/api/visit_suggestions${query ? `?${query}` : ""}`);
    return parseJsonResponse(response, "Failed to fetch visit suggestions");
  }

  async function fetchTrip(tripId) {
    const response = await fetch(`/api/trips/${tripId}`);
    return parseJsonResponse(response, "Failed to fetch trip");
  }

  async function deletePlace(placeId) {
    const response = await fetch(`/api/places/${placeId}`, { method: "DELETE" });
    return parseJsonResponse(response, "Failed to delete place");
  }

  async function createPlace(payload) {
    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return parseJsonResponse(response, "Failed to create place");
  }

  async function updatePlace(placeId, payload) {
    const response = await fetch(`/api/places/${placeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return parseJsonResponse(response, "Failed to update place");
  }

  window.VisitsDataService = {
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
})();
