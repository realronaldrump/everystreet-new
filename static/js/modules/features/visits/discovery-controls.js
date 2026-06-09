export const DEFAULT_DISCOVERY_SORT = "totalVisits-desc";
export const DEFAULT_DISCOVERY_MIN_VISITS = 5;

const SORT_CONFIGS = {
  "totalVisits-desc": { field: "totalVisits", direction: "desc", type: "number" },
  "totalVisits-asc": { field: "totalVisits", direction: "asc", type: "number" },
  "firstVisit-desc": { field: "firstVisit", direction: "desc", type: "date" },
  "firstVisit-asc": { field: "firstVisit", direction: "asc", type: "date" },
  "lastVisit-desc": { field: "lastVisit", direction: "desc", type: "date" },
  "lastVisit-asc": { field: "lastVisit", direction: "asc", type: "date" },
};

function getSortConfig(sortKey) {
  return SORT_CONFIGS[sortKey] || SORT_CONFIGS[DEFAULT_DISCOVERY_SORT];
}

function coerceSortableValue(suggestion, config) {
  const rawValue = suggestion?.[config.field];
  if (config.type === "number") {
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  const timestamp = new Date(rawValue).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function normalizeDiscoveryMinVisits(
  value,
  fallback = DEFAULT_DISCOVERY_MIN_VISITS
) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return fallback;
}

export function sortDiscoveries(suggestions, sortKey = DEFAULT_DISCOVERY_SORT) {
  const config = getSortConfig(sortKey);
  const directionMultiplier = config.direction === "asc" ? 1 : -1;
  const discoveryRows = Array.isArray(suggestions) ? suggestions : [];

  return discoveryRows
    .map((suggestion, index) => ({ suggestion, index }))
    .sort((left, right) => {
      const leftValue = coerceSortableValue(left.suggestion, config);
      const rightValue = coerceSortableValue(right.suggestion, config);

      if (leftValue === null && rightValue === null) {
        return left.index - right.index;
      }
      if (leftValue === null) {
        return 1;
      }
      if (rightValue === null) {
        return -1;
      }
      if (leftValue === rightValue) {
        return left.index - right.index;
      }

      return leftValue > rightValue ? directionMultiplier : -directionMultiplier;
    })
    .map(({ suggestion }) => suggestion);
}
