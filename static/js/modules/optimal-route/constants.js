export const OPTIMAL_ROUTES_DEFAULTS = {
  areaSelectId: "area-select",
  mapContainerId: "route-map",
  sharedMap: null,
  addNavigationControl: true,
  populateAreaSelect: true,
  emitCoverageAreasLoaded: true,
};

export const STAGE_COPY = {
  queued: {
    label: "Queued",
    message: "Standing by for a solver slot...",
  },
  waiting: {
    label: "Queued",
    message: "Standing by for a solver slot...",
  },
  initializing: {
    label: "Initializing",
    message: "Warming up the route engine...",
  },
  loading_area: {
    label: "Loading",
    message: "Locking onto your coverage area...",
  },
  loading_segments: {
    label: "Loading",
    message: "Gathering undriven segments...",
  },
  loading_graph: {
    label: "Network",
    message: "Loading the street network...",
  },
  fetching_osm: {
    label: "Network",
    message: "Fetching street network tiles...",
  },
  mapping_segments: {
    label: "Mapping",
    message: "Matching segments to real roads...",
  },
  connectivity_check: {
    label: "Linking",
    message: "Bridging gaps between clusters...",
  },
  routing: {
    label: "Routing",
    message: "Solving the best circuit...",
  },
  finalizing: {
    label: "Finalizing",
    message: "Finalizing route geometry...",
  },
  complete: {
    label: "Complete",
    message: "Route ready.",
  },
  error: {
    label: "Error",
    message: "Route solver hit an issue.",
  },
};

export const SCANNER_STAGES = new Set([
  "initializing",
  "loading_area",
  "loading_segments",
  "loading_graph",
  "fetching_osm",
  "mapping_segments",
  "connectivity_check",
  "routing",
  "finalizing",
]);
