import CONFIG from "../../core/config.js";
import { createMap } from "../../map-core.js";

const LINE_SOURCE_ID = "journey-event-line";
const LINE_LAYER_ID = "journey-event-line-layer";
const POINT_SOURCE_ID = "journey-event-point";
const POINT_LAYER_ID = "journey-event-point-layer";

let journeyMap = null;
let mapReadyPromise = null;
let mapContainerId = null;

function waitForMapLoad(map) {
  if (!map || typeof map.once !== "function") {
    return Promise.resolve();
  }

  if (typeof map.loaded === "function" && map.loaded()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    map.once("load", () => resolve());
  });
}

function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function ensureMapLayers() {
  if (!journeyMap || typeof journeyMap.getSource !== "function") {
    return;
  }

  if (!journeyMap.getSource(LINE_SOURCE_ID)) {
    journeyMap.addSource(LINE_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }

  if (!journeyMap.getLayer(LINE_LAYER_ID)) {
    journeyMap.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: LINE_SOURCE_ID,
      paint: {
        "line-color": "#d48f52",
        "line-width": 4,
        "line-opacity": 0.9,
      },
    });
  }

  if (!journeyMap.getSource(POINT_SOURCE_ID)) {
    journeyMap.addSource(POINT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }

  if (!journeyMap.getLayer(POINT_LAYER_ID)) {
    journeyMap.addLayer({
      id: POINT_LAYER_ID,
      type: "circle",
      source: POINT_SOURCE_ID,
      paint: {
        "circle-radius": 6,
        "circle-color": "#4da396",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#18181b",
      },
    });
  }
}

function toLineCoordinates(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return [];
  }

  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }

  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flat();
  }

  return [];
}

function toPointCoordinates(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }

  const lineCoords = toLineCoordinates(geometry);
  if (!lineCoords.length) {
    return null;
  }
  return lineCoords[lineCoords.length - 1] || null;
}

function toBounds(coords = []) {
  if (!Array.isArray(coords) || !coords.length) {
    return null;
  }

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  coords.forEach((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      return;
    }
    const [lng, lat] = pair;
    if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
      return;
    }

    minLng = Math.min(minLng, Number(lng));
    minLat = Math.min(minLat, Number(lat));
    maxLng = Math.max(maxLng, Number(lng));
    maxLat = Math.max(maxLat, Number(lat));
  });

  if (
    !Number.isFinite(minLng) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLng) ||
    !Number.isFinite(maxLat)
  ) {
    return null;
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

function setSourceData(sourceId, featureCollection) {
  if (!journeyMap || typeof journeyMap.getSource !== "function") {
    return;
  }
  const source = journeyMap.getSource(sourceId);
  if (!source || typeof source.setData !== "function") {
    return;
  }
  source.setData(featureCollection);
}

function fitToGeometry(lineCoords, pointCoords, followRoute = true) {
  if (!followRoute || !journeyMap) {
    return;
  }

  const bounds = toBounds(lineCoords.length ? lineCoords : pointCoords ? [pointCoords] : []);
  if (!bounds) {
    return;
  }

  if (typeof journeyMap.fitBounds === "function") {
    journeyMap.fitBounds(bounds, {
      padding: 80,
      duration: 700,
      maxZoom: 14,
      linear: false,
    });
  }
}

export async function ensureJourneyMap(containerId = "journey-map-canvas") {
  const target = document.getElementById(containerId);
  if (!target) {
    return null;
  }

  if (journeyMap && mapContainerId === containerId) {
    return journeyMap;
  }

  if (mapReadyPromise) {
    await mapReadyPromise;
    return journeyMap;
  }

  mapContainerId = containerId;
  mapReadyPromise = (async () => {
    journeyMap = createMap(containerId, {
      center: CONFIG.MAP.defaultCenter,
      zoom: Math.max(2, Number(CONFIG.MAP.defaultZoom) - 1),
    });

    await waitForMapLoad(journeyMap);
    ensureMapLayers();
    return journeyMap;
  })();

  try {
    await mapReadyPromise;
  } finally {
    mapReadyPromise = null;
  }

  return journeyMap;
}

export async function renderJourneyGeometry(event, { followRoute = true } = {}) {
  const map = await ensureJourneyMap();
  if (!map) {
    return;
  }

  ensureMapLayers();

  const geometry = event?.geometry;
  const lineCoords = toLineCoordinates(geometry);
  const pointCoords = toPointCoordinates(geometry);

  const lineCollection = lineCoords.length
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: lineCoords },
            properties: {},
          },
        ],
      }
    : emptyFeatureCollection();

  const pointCollection = pointCoords
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: pointCoords },
            properties: {},
          },
        ],
      }
    : emptyFeatureCollection();

  setSourceData(LINE_SOURCE_ID, lineCollection);
  setSourceData(POINT_SOURCE_ID, pointCollection);

  fitToGeometry(lineCoords, pointCoords, followRoute);
}

export function clearJourneyGeometry() {
  setSourceData(LINE_SOURCE_ID, emptyFeatureCollection());
  setSourceData(POINT_SOURCE_ID, emptyFeatureCollection());
}

export function resizeJourneyMap() {
  if (!journeyMap) {
    return;
  }
  if (typeof journeyMap.resize === "function") {
    journeyMap.resize();
  }
}

export function destroyJourneyMap() {
  if (!journeyMap) {
    return;
  }
  if (typeof journeyMap.remove === "function") {
    journeyMap.remove();
  }
  journeyMap = null;
  mapContainerId = null;
  mapReadyPromise = null;
}
