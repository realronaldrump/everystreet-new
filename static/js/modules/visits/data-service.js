import apiClient from "../core/api-client.js";

function buildQuery(params = {}) {
  const query = new URLSearchParams(params).toString();
  return query ? `?${query}` : "";
}

export function createVisitsDataService(client = apiClient) {
  // The shared client disables its own timeout when given a lifecycle signal.
  // Combine both here so navigation cancellation never creates an endless read.
  const get = (url, options = {}) => {
    const timeout = AbortSignal.timeout(options.timeout ?? 20000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    return client.get(url, { ...options, signal, retry: false });
  };
  return {
    fetchPlaces(options = {}) {
      return get("/api/places", options);
    },

    fetchPlaceStatistics(params = {}, options = {}) {
      return get(`/api/places/statistics${buildQuery(params)}`, options);
    },

    fetchPlaceDetailStatistics(placeId, options = {}) {
      return get(`/api/places/${encodeURIComponent(placeId)}/statistics`, options);
    },

    fetchPlaceTrips(placeId, options = {}) {
      return get(`/api/places/${encodeURIComponent(placeId)}/trips`, options);
    },

    fetchNonCustomVisits(params = {}, options = {}) {
      return get(`/api/non_custom_places_visits${buildQuery(params)}`, options);
    },

    fetchVisitSuggestions(params = {}, options = {}) {
      return get(`/api/visit_suggestions${buildQuery(params)}`, options);
    },

    fetchTrip(tripId, options = {}) {
      return get(`/api/trips/${encodeURIComponent(tripId)}`, options);
    },

    deletePlace(placeId, options = {}) {
      return client.delete(`/api/places/${placeId}`, options);
    },

    createPlace(payload, options = {}) {
      return client.post("/api/places", payload, options);
    },

    backfillPlacePreviews(params = {}, options = {}) {
      return client.post(
        `/api/places/previews/backfill${buildQuery(params)}`,
        null,
        options
      );
    },

    updatePlace(placeId, payload, options = {}) {
      return client.patch(`/api/places/${placeId}`, payload, options);
    },
  };
}

const visitsDataService = createVisitsDataService(apiClient);

export default visitsDataService;
