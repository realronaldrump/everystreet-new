const MAP_FILTERS = ["all", "driven", "undriven"];
const STATUS_FILTERS = ["driven", "undriven"];

export function normalizeMapFilter(filter) {
  return MAP_FILTERS.includes(filter) ? filter : "all";
}

export function normalizeActiveMapFilters(filters) {
  const requestedFilters = Array.isArray(filters) ? filters : [filters];
  const normalizedFilters = requestedFilters
    .map((filter) => normalizeMapFilter(filter))
    .filter((filter, index, values) => values.indexOf(filter) === index);

  if (!normalizedFilters.length || normalizedFilters.includes("all")) {
    return ["all"];
  }

  return STATUS_FILTERS.filter((filter) => normalizedFilters.includes(filter));
}

export function isAllMapFilterActive(filters) {
  return normalizeActiveMapFilters(filters).includes("all");
}

export function getStatusFiltersForMapFilters(filters) {
  const normalizedFilters = normalizeActiveMapFilters(filters);
  return normalizedFilters.includes("all") ? [...STATUS_FILTERS] : normalizedFilters;
}

export function getNextActiveMapFilters(currentFilters, requestedFilter) {
  const normalizedRequested = normalizeMapFilter(requestedFilter);
  if (normalizedRequested === "all") {
    return ["all"];
  }

  const nextFilters = new Set(
    normalizeActiveMapFilters(currentFilters).filter((filter) => filter !== "all")
  );
  if (nextFilters.has(normalizedRequested)) {
    nextFilters.delete(normalizedRequested);
  } else {
    nextFilters.add(normalizedRequested);
  }

  if (nextFilters.size === 0) {
    return ["all"];
  }

  return STATUS_FILTERS.filter((filter) => nextFilters.has(filter));
}
