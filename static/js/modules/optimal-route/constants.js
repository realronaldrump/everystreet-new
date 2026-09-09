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
    message: "Waiting for an available route worker…",
  },
  waiting: {
    label: "Queued",
    message: "Waiting for an available route worker…",
  },
  initializing: {
    label: "Initializing",
    message: "Preparing your route…",
  },
  loading_area: {
    label: "Loading",
    message: "Loading your coverage area…",
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
    message: "Your route could not be completed.",
  },
};
