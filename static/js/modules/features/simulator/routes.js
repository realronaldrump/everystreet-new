/**
 * Route data for the Bouncie Simulator.
 *
 * Provides preset routes (Dallas, TX area) and Mapbox Directions API
 * integration for generating custom routes from map clicks.
 */

import { getMapboxToken } from "../../mapbox-token.js";

// ---------------------------------------------------------------------------
// Preset Routes — Dallas, TX area
// ---------------------------------------------------------------------------

const PRESET_ROUTES = [
  {
    id: "downtown-loop",
    name: "Downtown Loop",
    description: "Mixed-speed loop through downtown Dallas (~3 mi)",
    coordinates: [
      { lat: 32.7814, lon: -96.7972 },
      { lat: 32.7818, lon: -96.7951 },
      { lat: 32.7823, lon: -96.7928 },
      { lat: 32.7831, lon: -96.7905 },
      { lat: 32.7839, lon: -96.7882 },
      { lat: 32.7845, lon: -96.7861 },
      { lat: 32.7852, lon: -96.7839 },
      { lat: 32.7843, lon: -96.7821 },
      { lat: 32.7831, lon: -96.7808 },
      { lat: 32.7818, lon: -96.7798 },
      { lat: 32.7803, lon: -96.7791 },
      { lat: 32.7788, lon: -96.7786 },
      { lat: 32.7773, lon: -96.7793 },
      { lat: 32.7761, lon: -96.7808 },
      { lat: 32.7752, lon: -96.7828 },
      { lat: 32.7748, lon: -96.7851 },
      { lat: 32.7749, lon: -96.7876 },
      { lat: 32.7755, lon: -96.7899 },
      { lat: 32.7764, lon: -96.7919 },
      { lat: 32.7775, lon: -96.7935 },
      { lat: 32.7788, lon: -96.7948 },
      { lat: 32.7800, lon: -96.7959 },
      { lat: 32.7814, lon: -96.7972 },
    ],
  },
  {
    id: "highway-run",
    name: "Highway Run",
    description: "I-35E northbound stretch (~8 mi, high speed)",
    coordinates: [
      { lat: 32.7490, lon: -96.8200 },
      { lat: 32.7525, lon: -96.8195 },
      { lat: 32.7560, lon: -96.8188 },
      { lat: 32.7598, lon: -96.8180 },
      { lat: 32.7635, lon: -96.8172 },
      { lat: 32.7670, lon: -96.8163 },
      { lat: 32.7710, lon: -96.8155 },
      { lat: 32.7748, lon: -96.8148 },
      { lat: 32.7785, lon: -96.8140 },
      { lat: 32.7822, lon: -96.8131 },
      { lat: 32.7860, lon: -96.8122 },
      { lat: 32.7900, lon: -96.8112 },
      { lat: 32.7940, lon: -96.8103 },
      { lat: 32.7980, lon: -96.8094 },
      { lat: 32.8020, lon: -96.8085 },
      { lat: 32.8058, lon: -96.8076 },
      { lat: 32.8095, lon: -96.8065 },
      { lat: 32.8132, lon: -96.8054 },
      { lat: 32.8170, lon: -96.8043 },
      { lat: 32.8208, lon: -96.8032 },
      { lat: 32.8245, lon: -96.8022 },
      { lat: 32.8282, lon: -96.8012 },
      { lat: 32.8320, lon: -96.8002 },
      { lat: 32.8358, lon: -96.7992 },
      { lat: 32.8395, lon: -96.7983 },
      { lat: 32.8430, lon: -96.7975 },
      { lat: 32.8468, lon: -96.7965 },
      { lat: 32.8505, lon: -96.7955 },
      { lat: 32.8542, lon: -96.7944 },
      { lat: 32.8580, lon: -96.7934 },
      { lat: 32.8618, lon: -96.7924 },
      { lat: 32.8655, lon: -96.7914 },
      { lat: 32.8690, lon: -96.7905 },
      { lat: 32.8728, lon: -96.7896 },
      { lat: 32.8765, lon: -96.7888 },
      { lat: 32.8800, lon: -96.7880 },
    ],
  },
  {
    id: "neighborhood",
    name: "Neighborhood Cruise",
    description: "Residential streets in Lakewood (~2 mi, slow)",
    coordinates: [
      { lat: 32.8142, lon: -96.7538 },
      { lat: 32.8148, lon: -96.7518 },
      { lat: 32.8155, lon: -96.7498 },
      { lat: 32.8162, lon: -96.7478 },
      { lat: 32.8155, lon: -96.7458 },
      { lat: 32.8142, lon: -96.7445 },
      { lat: 32.8128, lon: -96.7438 },
      { lat: 32.8112, lon: -96.7435 },
      { lat: 32.8098, lon: -96.7442 },
      { lat: 32.8085, lon: -96.7455 },
      { lat: 32.8078, lon: -96.7475 },
      { lat: 32.8075, lon: -96.7498 },
      { lat: 32.8078, lon: -96.7518 },
      { lat: 32.8085, lon: -96.7535 },
      { lat: 32.8095, lon: -96.7548 },
      { lat: 32.8108, lon: -96.7555 },
      { lat: 32.8122, lon: -96.7555 },
      { lat: 32.8135, lon: -96.7548 },
      { lat: 32.8142, lon: -96.7538 },
    ],
  },
];

export function getPresetRoutes() {
  return PRESET_ROUTES.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    pointCount: r.coordinates.length,
  }));
}

export function getPresetRouteById(id) {
  return PRESET_ROUTES.find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Mapbox Directions API
// ---------------------------------------------------------------------------

/**
 * Fetch a driving route between two points via Mapbox Directions API.
 * Returns { coordinates: [{lat, lon}], distance (meters), duration (seconds) }.
 */
export async function fetchDirectionsRoute(startLngLat, endLngLat) {
  const token = getMapboxToken();
  const coords = `${startLngLat[0]},${startLngLat[1]};${endLngLat[0]},${endLngLat[1]}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Directions API error: ${res.status}`);

  const data = await res.json();
  if (!data.routes?.length) throw new Error("No route found");

  const route = data.routes[0];
  const coordinates = route.geometry.coordinates.map(([lon, lat]) => ({
    lat,
    lon,
  }));

  return {
    coordinates,
    distance: route.distance,
    duration: route.duration,
  };
}

// ---------------------------------------------------------------------------
// Map Route Picker — click start & end points, fetch Directions route
// ---------------------------------------------------------------------------

/**
 * Enable route picker mode on the map.
 * User clicks two points, a Directions route is fetched between them.
 *
 * @param {mapboxgl.Map} map
 * @param {(route: {coordinates, distance, duration}) => void} onRouteSelected
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
    if (cancelled) return;

    clickCount++;
    const lngLat = [e.lngLat.lng, e.lngLat.lat];

    // Create marker
    const el = document.createElement("div");
    el.className = "sim-route-marker";
    el.textContent = clickCount === 1 ? "A" : "B";

    /* global mapboxgl */
    const marker = new mapboxgl.Marker({ element: el })
      .setLngLat(lngLat)
      .addTo(map);
    markers.push(marker);

    if (clickCount === 1) {
      startLngLat = lngLat;
      return;
    }

    // Second click — fetch route
    map.getCanvas().style.cursor = "wait";
    try {
      const route = await fetchDirectionsRoute(startLngLat, lngLat);
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
