/**
 * Route data for the Bouncie Simulator.
 *
 * ALL routes are resolved via Mapbox Directions API so they follow the
 * real road network.  Presets are just well-known start/end pairs that
 * get fetched on demand.  The Directions response includes per-segment
 * speed, duration and distance annotations which the simulation engine
 * uses for realistic pacing.
 */

import { getMapboxToken } from "../../mapbox-token.js";

// ---------------------------------------------------------------------------
// Preset route definitions — start / end coordinates (Dallas, TX area)
// ---------------------------------------------------------------------------

const PRESET_ROUTES = [
  {
    id: "downtown-loop",
    name: "Downtown Loop",
    description: "City streets through downtown Dallas",
    // Dealey Plaza → Deep Ellum → back via Commerce St
    waypoints: [
      [-96.8088, 32.7787],
      [-96.7834, 32.7833],
      [-96.7652, 32.7847],
      [-96.7834, 32.7762],
      [-96.8088, 32.7787],
    ],
  },
  {
    id: "highway-run",
    name: "Highway Run",
    description: "US-75 northbound, Richardson to Plano",
    waypoints: [
      [-96.7503, 32.9482],
      [-96.7149, 33.0198],
    ],
  },
  {
    id: "neighborhood",
    name: "Neighborhood Cruise",
    description: "Residential streets through Lakewood",
    waypoints: [
      [-96.7561, 32.8124],
      [-96.7381, 32.8217],
      [-96.7278, 32.8094],
      [-96.7426, 32.8024],
      [-96.7561, 32.8124],
    ],
  },
  {
    id: "errand-run",
    name: "Errand Run",
    description: "Mixed driving: neighborhood → highway → shopping → back",
    waypoints: [
      [-96.7701, 32.8342],
      [-96.7503, 32.9482],
      [-96.7228, 32.9868],
      [-96.7503, 32.9482],
      [-96.7701, 32.8342],
    ],
  },
];

export function getPresetRoutes() {
  return PRESET_ROUTES.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
  }));
}

export function getPresetById(id) {
  return PRESET_ROUTES.find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Mapbox Directions API — returns real road-following coordinates with
// per-segment speed / duration / distance annotations
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RouteSegment
 * @property {number} lat
 * @property {number} lon
 * @property {number} speedMps  — speed for the segment ENDING at this coord (m/s)
 * @property {number} durationS — time to traverse from previous coord (seconds)
 * @property {number} distanceM — distance from previous coord (meters)
 */

/**
 * @typedef {Object} ResolvedRoute
 * @property {RouteSegment[]} segments — one entry per coordinate; first has 0 speed/dur/dist
 * @property {number} totalDistance — total route distance in meters
 * @property {number} totalDuration — total route duration in seconds
 */

/**
 * Build a Directions API URL for a list of [lng, lat] waypoints.
 * Requests full-precision geometry + speed/duration/distance annotations.
 */
function buildDirectionsUrl(waypoints) {
  const token = getMapboxToken();
  const coords = waypoints.map((w) => `${w[0]},${w[1]}`).join(";");
  return (
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
    `?geometries=geojson&overview=full` +
    `&annotations=speed,duration,distance` +
    `&access_token=${token}`
  );
}

/**
 * Parse a Directions API response into a flat array of RouteSegments.
 * The annotations arrays are per-leg and each has N-1 entries where N is the
 * number of coordinates in that leg.  We stitch legs together into one
 * continuous segment array.
 */
function parseDirectionsResponse(data) {
  const route = data.routes[0];
  const allCoords = route.geometry.coordinates; // [[lon,lat], ...]

  // Stitch leg annotations into flat arrays aligned with coordinate pairs
  const speeds = [];
  const durations = [];
  const distances = [];

  for (const leg of route.legs) {
    const ann = leg.annotation || {};
    if (ann.speed) {
      speeds.push(...ann.speed);
    }
    if (ann.duration) {
      durations.push(...ann.duration);
    }
    if (ann.distance) {
      distances.push(...ann.distance);
    }
  }

  // Build segments: first coord has zeroes, subsequent coords carry the
  // annotation for the pair (prev → current).
  const segments = allCoords.map(([lon, lat], i) => ({
    lat,
    lon,
    speedMps: i > 0 ? (speeds[i - 1] ?? 0) : 0,
    durationS: i > 0 ? (durations[i - 1] ?? 0) : 0,
    distanceM: i > 0 ? (distances[i - 1] ?? 0) : 0,
  }));

  return {
    segments,
    totalDistance: route.distance,
    totalDuration: route.duration,
  };
}

/**
 * Fetch a driving route between waypoints via Mapbox Directions API.
 *
 * @param {number[][]} waypoints — array of [lng, lat] pairs (2–25 points)
 * @returns {Promise<ResolvedRoute>}
 */
export async function fetchRoute(waypoints) {
  const url = buildDirectionsUrl(waypoints);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Directions API ${res.status}`);
  }

  const data = await res.json();
  if (!data.routes?.length) {
    throw new Error("No route found");
  }

  return parseDirectionsResponse(data);
}

/**
 * Resolve a preset route by fetching it from the Directions API.
 * @param {string} presetId
 * @returns {Promise<ResolvedRoute>}
 */
export function fetchPresetRoute(presetId) {
  const preset = getPresetById(presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }
  return fetchRoute(preset.waypoints);
}

// ---------------------------------------------------------------------------
// Map Route Picker — click start & end points, fetch Directions route
// ---------------------------------------------------------------------------

/**
 * Enable route picker mode on the map.
 * User clicks two points, a Directions route is fetched between them.
 *
 * @param {mapboxgl.Map} map
 * @param {(route: ResolvedRoute | null) => void} onRouteSelected
 * @returns {{ cancel: () => void }}
 */
export function enableRoutePickerMode(map, onRouteSelected) {
  let clickCount = 0;
  let startLngLat = null;
  const markers = [];
  let cancelled = false;

  const cleanup = () => {
    cancelled = true;
    map.getCanvas().style.cursor = "";
    markers.forEach((m) => m.remove());
    markers.length = 0;
    map.off("click", handleClick);
  };

  const handleClick = async (e) => {
    if (cancelled) {
      return;
    }

    clickCount++;
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    const el = document.createElement("div");
    el.className = "sim-route-marker";
    el.textContent = clickCount === 1 ? "A" : "B";

    /* global mapboxgl */
    const marker = new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    markers.push(marker);

    if (clickCount === 1) {
      startLngLat = lngLat;
      return;
    }

    // Second click — fetch route
    map.getCanvas().style.cursor = "wait";
    try {
      const route = await fetchRoute([startLngLat, lngLat]);
      cleanup();
      onRouteSelected(route);
    } catch (err) {
      console.error("Route fetch failed:", err);
      cleanup();
      onRouteSelected(null);
    }
  };

  map.getCanvas().style.cursor = "crosshair";
  map.on("click", handleClick);

  return { cancel: cleanup };
}
