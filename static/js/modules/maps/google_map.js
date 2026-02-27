/**
 * Google Maps Wrapper Module
 *
 * Exposes a Mapbox-like API surface so the rest of the app can interact with Google Maps
 * without needing a complete rewrite of every map manager function.
 */

import { CONFIG } from "../core/config.js";
import state from "../core/store.js";
import loadingManager from "../ui/loading-manager.js";
import notificationManager from "../ui/notifications.js";
import { utils } from "../utils.js";

const MAPBOX_EVENT_TO_GOOGLE_EVENT = {
  click: "click",
  dblclick: "dblclick",
  dragend: "dragend",
  load: "idle",
  mouseenter: "mouseover",
  mouseleave: "mouseout",
  move: "bounds_changed",
  moveend: "idle",
  zoom: "zoom_changed",
  zoomend: "idle",
};

const parseNumber = (value, context = null) => {
  let normalized = value;
  if (typeof value === "function") {
    try {
      normalized = value.call(context);
    } catch {
      return null;
    }
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const toLngLat = (value) => {
  if (Array.isArray(value) && value.length >= 2) {
    const lng = parseNumber(value[0]);
    const lat = parseNumber(value[1]);
    if (lng !== null && lat !== null) {
      return { lng, lat };
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const lng = parseNumber(value.lng ?? value.lon ?? value.longitude, value);
  const lat = parseNumber(value.lat ?? value.latitude, value);
  if (lng === null || lat === null) {
    return null;
  }
  return { lng, lat };
};

const toGoogleLatLngBounds = (boundsInput) => {
  if (
    typeof google === "undefined" ||
    typeof google.maps === "undefined" ||
    typeof google.maps.LatLngBounds !== "function" ||
    !boundsInput
  ) {
    return null;
  }

  if (boundsInput instanceof google.maps.LatLngBounds) {
    return boundsInput;
  }

  const bounds = new google.maps.LatLngBounds();
  let hasPoint = false;

  const extend = (candidate) => {
    const lngLat = toLngLat(candidate);
    if (!lngLat) {
      return;
    }
    bounds.extend(lngLat);
    hasPoint = true;
  };

  if (Array.isArray(boundsInput) && boundsInput.length >= 2) {
    extend(boundsInput[0]);
    extend(boundsInput[1]);
  } else if (
    typeof boundsInput.getSouthWest === "function" &&
    typeof boundsInput.getNorthEast === "function"
  ) {
    extend(boundsInput.getSouthWest());
    extend(boundsInput.getNorthEast());
  } else {
    extend(boundsInput.southwest ?? boundsInput.sw);
    extend(boundsInput.northeast ?? boundsInput.ne);
  }

  return hasPoint ? bounds : null;
};

const toGoogleEventName = (eventName) =>
  MAPBOX_EVENT_TO_GOOGLE_EVENT[eventName] || eventName;

const HARD_CODED_GOOGLE_MAP_IDS = Object.freeze({
  dark: "913996d7028f0a557c531012",
  light: "",
});

const getCurrentDocumentTheme = () => {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement?.getAttribute("data-bs-theme") === "light"
    ? "light"
    : "dark";
};

const getHardcodedGoogleMapId = (theme = getCurrentDocumentTheme()) => {
  const normalizedTheme = theme === "light" ? "light" : "dark";
  const configured = HARD_CODED_GOOGLE_MAP_IDS[normalizedTheme];
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return (HARD_CODED_GOOGLE_MAP_IDS.dark || "").trim();
};

const hasHardcodedLightMapId = () =>
  typeof HARD_CODED_GOOGLE_MAP_IDS.light === "string" &&
  HARD_CODED_GOOGLE_MAP_IDS.light.trim().length > 0;

const getGoogleColorScheme = (theme = "dark") => {
  const normalizedTheme = theme === "light" ? "light" : "dark";
  const colorScheme = globalThis?.google?.maps?.ColorScheme;
  if (normalizedTheme === "light") {
    return colorScheme?.LIGHT || "LIGHT";
  }
  return colorScheme?.DARK || "DARK";
};

const DEFAULT_LINE_COLOR = "#d4943c";
const DEFAULT_LINE_OPACITY = 0.85;
const DEFAULT_LINE_WIDTH = 2.5;
const DEFAULT_CIRCLE_COLOR = "#b87a4a";
const DEFAULT_CIRCLE_OPACITY = 0.85;
const DEFAULT_CIRCLE_RADIUS = 5;
const DEFAULT_CIRCLE_STROKE_COLOR = "#ffffff";
const DEFAULT_CIRCLE_STROKE_OPACITY = 1;
const DEFAULT_CIRCLE_STROKE_WIDTH = 0;
const DEFAULT_FILL_COLOR = "#b87a4a";
const DEFAULT_FILL_OPACITY = 0.28;
const DEFAULT_FILL_OUTLINE_COLOR = "#b87a4a";
const DEFAULT_HIT_TOLERANCE_PX = 8;
const LINE_PAINT_PROPERTIES = new Set([
  "line-color",
  "line-gradient",
  "line-opacity",
  "line-width",
]);
const CIRCLE_PAINT_PROPERTIES = new Set([
  "circle-color",
  "circle-opacity",
  "circle-radius",
  "circle-stroke-color",
  "circle-stroke-opacity",
  "circle-stroke-width",
]);
const FILL_PAINT_PROPERTIES = new Set([
  "fill-color",
  "fill-opacity",
  "fill-outline-color",
]);
const INTERACTION_NOOP = {
  disable() {},
  enable() {},
  isEnabled() {
    return true;
  },
  disableRotation() {},
  enableRotation() {},
};

const GOOGLE_DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "poi",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#263c3f" }],
  },
  {
    featureType: "poi.park",
    elementType: "labels.text.fill",
    stylers: [{ color: "#6b9a76" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#38414e" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#212a37" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#9ca5b3" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#746855" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry.stroke",
    stylers: [{ color: "#1f2835" }],
  },
  {
    featureType: "road.highway",
    elementType: "labels.text.fill",
    stylers: [{ color: "#f3d19c" }],
  },
  {
    featureType: "transit",
    elementType: "geometry",
    stylers: [{ color: "#2f3948" }],
  },
  {
    featureType: "transit.station",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#17263c" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#515c6d" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#17263c" }],
  },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const isColorLike = (value) =>
  typeof value === "string" &&
  (/^#/.test(value) ||
    /^rgb[a]?\(/i.test(value) ||
    /^hsl[a]?\(/i.test(value) ||
    /^transparent$/i.test(value));

const evaluateNumericExpression = (expression, zoom) => {
  if (!Array.isArray(expression) || expression.length < 6) {
    return null;
  }
  if (expression[0] !== "interpolate") {
    return null;
  }

  const interpolation = expression[1];
  const inputExpr = expression[2];
  if (!Array.isArray(inputExpr) || inputExpr[0] !== "zoom") {
    return null;
  }

  const stops = [];
  for (let i = 3; i < expression.length - 1; i += 2) {
    const stop = parseNumber(expression[i]);
    const value = parseNumber(expression[i + 1]);
    if (stop === null || value === null) {
      continue;
    }
    stops.push([stop, value]);
  }
  if (stops.length === 0) {
    return null;
  }

  const zoomValue = Number.isFinite(zoom) ? zoom : stops[0][0];
  if (zoomValue <= stops[0][0]) {
    return stops[0][1];
  }
  if (zoomValue >= stops[stops.length - 1][0]) {
    return stops[stops.length - 1][1];
  }

  let leftStop = stops[0];
  let rightStop = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (zoomValue >= a[0] && zoomValue <= b[0]) {
      leftStop = a;
      rightStop = b;
      break;
    }
  }

  const [z0, v0] = leftStop;
  const [z1, v1] = rightStop;
  if (z0 === z1) {
    return v1;
  }

  let t = (zoomValue - z0) / (z1 - z0);
  t = clamp(t, 0, 1);

  // Mapbox exponential interpolation approximation for numeric values.
  if (
    Array.isArray(interpolation) &&
    interpolation[0] === "exponential" &&
    parseNumber(interpolation[1]) !== null
  ) {
    const base = parseNumber(interpolation[1]);
    if (base !== null && base > 0 && base !== 1) {
      t = (Math.pow(base, t) - 1) / (base - 1);
    }
  }

  return v0 + (v1 - v0) * t;
};

const evaluateStyleExpression = (expression, feature, zoom) => {
  if (!Array.isArray(expression) || expression.length === 0) {
    return expression;
  }

  const [operator, ...args] = expression;

  switch (operator) {
    case "literal":
      return args[0];
    case "get":
      return typeof args[0] === "string" ? feature?.properties?.[args[0]] : null;
    case "id":
      return feature?.id;
    case "feature-state":
      return typeof args[0] === "string" ? feature?.state?.[args[0]] : null;
    case "coalesce": {
      for (const arg of args) {
        const candidate = evaluateStyleExpression(arg, feature, zoom);
        if (candidate !== null && candidate !== undefined) {
          return candidate;
        }
      }
      return null;
    }
    case "to-string": {
      const value = evaluateStyleExpression(args[0], feature, zoom);
      return value === null || value === undefined ? "" : String(value);
    }
    case "==":
      return (
        evaluateStyleExpression(args[0], feature, zoom) ===
        evaluateStyleExpression(args[1], feature, zoom)
      );
    case "!=":
      return (
        evaluateStyleExpression(args[0], feature, zoom) !==
        evaluateStyleExpression(args[1], feature, zoom)
      );
    case ">":
      return (
        Number(evaluateStyleExpression(args[0], feature, zoom)) >
        Number(evaluateStyleExpression(args[1], feature, zoom))
      );
    case "<":
      return (
        Number(evaluateStyleExpression(args[0], feature, zoom)) <
        Number(evaluateStyleExpression(args[1], feature, zoom))
      );
    case ">=":
      return (
        Number(evaluateStyleExpression(args[0], feature, zoom)) >=
        Number(evaluateStyleExpression(args[1], feature, zoom))
      );
    case "<=":
      return (
        Number(evaluateStyleExpression(args[0], feature, zoom)) <=
        Number(evaluateStyleExpression(args[1], feature, zoom))
      );
    case "case": {
      for (let i = 0; i < args.length - 1; i += 2) {
        const condition = Boolean(evaluateStyleExpression(args[i], feature, zoom));
        if (condition) {
          return evaluateStyleExpression(args[i + 1], feature, zoom);
        }
      }
      if (args.length % 2 === 1) {
        return evaluateStyleExpression(args[args.length - 1], feature, zoom);
      }
      return null;
    }
    case "zoom":
      return zoom;
    case "interpolate": {
      const numeric = evaluateNumericExpression(expression, zoom);
      return numeric !== null ? numeric : null;
    }
    default:
      return expression;
  }
};

const resolveNumericStyle = (value, fallback, zoom, feature = null) => {
  const direct = parseNumber(value);
  if (direct !== null) {
    return direct;
  }

  const evaluated = evaluateStyleExpression(value, feature, zoom);
  const evaluatedNumeric = parseNumber(evaluated);
  if (evaluatedNumeric !== null) {
    return evaluatedNumeric;
  }

  const exprValue = evaluateNumericExpression(value, zoom);
  if (exprValue !== null) {
    return exprValue;
  }

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const parsed = parseNumber(value[i]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return fallback;
};

const resolveColorStyle = (value, fallback, feature = null, zoom = CONFIG.MAP.defaultZoom) => {
  if (isColorLike(value)) {
    return value;
  }

  const evaluated = evaluateStyleExpression(value, feature, zoom);
  if (isColorLike(evaluated)) {
    return evaluated;
  }

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      if (isColorLike(value[i])) {
        return value[i];
      }
    }
  }

  return fallback;
};

const normalizeGeoJsonFeatureCollection = (data) => {
  if (!data) {
    return { type: "FeatureCollection", features: [] };
  }
  if (Array.isArray(data)) {
    return { type: "FeatureCollection", features: data };
  }
  if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
    return data;
  }
  if (data.type === "Feature") {
    return { type: "FeatureCollection", features: [data] };
  }
  return { type: "FeatureCollection", features: [] };
};

const toPathFromCoordinates = (coordinates) => {
  if (!Array.isArray(coordinates)) {
    return [];
  }
  const path = [];
  coordinates.forEach((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      return;
    }
    const lng = parseNumber(coordinate[0]);
    const lat = parseNumber(coordinate[1]);
    if (lng === null || lat === null) {
      return;
    }
    path.push({ lat, lng });
  });
  return path;
};

const cloneBaseFeature = (feature) => ({
  id: feature?.id,
  type: "Feature",
  properties: feature?.properties || {},
  geometry: null,
  source: feature?.source,
  state: feature?.state,
});

const collectLineSegments = (featureCollection) => {
  const features = Array.isArray(featureCollection?.features)
    ? featureCollection.features
    : [];
  const segments = [];

  features.forEach((feature) => {
    const geometry = feature?.geometry;
    if (!geometry || typeof geometry !== "object") {
      return;
    }

    const baseFeature = cloneBaseFeature(feature);

    if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
      const path = toPathFromCoordinates(geometry.coordinates);
      if (path.length >= 2) {
        segments.push({
          path,
          feature: {
            ...baseFeature,
            geometry: {
              type: "LineString",
              coordinates: geometry.coordinates,
            },
          },
        });
      }
      return;
    }

    if (
      geometry.type === "MultiLineString" &&
      Array.isArray(geometry.coordinates)
    ) {
      geometry.coordinates.forEach((lineCoords) => {
        const path = toPathFromCoordinates(lineCoords);
        if (path.length >= 2) {
          segments.push({
            path,
            feature: {
              ...baseFeature,
              geometry: {
                type: "LineString",
                coordinates: lineCoords,
              },
            },
          });
        }
      });
    }
  });

  return segments;
};

const collectPointFeatures = (featureCollection) => {
  const features = Array.isArray(featureCollection?.features)
    ? featureCollection.features
    : [];
  const points = [];

  features.forEach((feature) => {
    const geometry = feature?.geometry;
    if (!geometry || typeof geometry !== "object") {
      return;
    }

    const baseFeature = cloneBaseFeature(feature);

    if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
      const lngLat = toLngLat(geometry.coordinates);
      if (!lngLat) {
        return;
      }
      points.push({
        lngLat,
        feature: {
          ...baseFeature,
          geometry: {
            type: "Point",
            coordinates: [lngLat.lng, lngLat.lat],
          },
        },
      });
      return;
    }

    if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
      geometry.coordinates.forEach((coordinates) => {
        const lngLat = toLngLat(coordinates);
        if (!lngLat) {
          return;
        }
        points.push({
          lngLat,
          feature: {
            ...baseFeature,
            geometry: {
              type: "Point",
              coordinates: [lngLat.lng, lngLat.lat],
            },
          },
        });
      });
    }
  });

  return points;
};

const toPolygonPathsFromCoordinates = (coordinates) => {
  if (!Array.isArray(coordinates)) {
    return [];
  }
  return coordinates
    .map((ringCoordinates) => toPathFromCoordinates(ringCoordinates))
    .filter((ringPath) => ringPath.length >= 3);
};

const collectPolygonFeatures = (featureCollection) => {
  const features = Array.isArray(featureCollection?.features)
    ? featureCollection.features
    : [];
  const polygons = [];

  features.forEach((feature) => {
    const geometry = feature?.geometry;
    if (!geometry || typeof geometry !== "object") {
      return;
    }

    const baseFeature = cloneBaseFeature(feature);

    if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
      const paths = toPolygonPathsFromCoordinates(geometry.coordinates);
      if (!paths.length) {
        return;
      }
      polygons.push({
        paths,
        feature: {
          ...baseFeature,
          geometry: {
            type: "Polygon",
            coordinates: geometry.coordinates,
          },
        },
      });
      return;
    }

    if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
      geometry.coordinates.forEach((polygonCoordinates) => {
        const paths = toPolygonPathsFromCoordinates(polygonCoordinates);
        if (!paths.length) {
          return;
        }
        polygons.push({
          paths,
          feature: {
            ...baseFeature,
            geometry: {
              type: "Polygon",
              coordinates: polygonCoordinates,
            },
          },
        });
      });
    }
  });

  return polygons;
};

const toEventPoint = (domEvent, googleMap) => {
  const offsetX = parseNumber(domEvent?.offsetX);
  const offsetY = parseNumber(domEvent?.offsetY);
  if (offsetX !== null && offsetY !== null) {
    return { x: offsetX, y: offsetY };
  }

  const clientX = parseNumber(domEvent?.clientX);
  const clientY = parseNumber(domEvent?.clientY);
  const mapDiv = googleMap?.getDiv?.();
  const rect =
    mapDiv && typeof mapDiv.getBoundingClientRect === "function"
      ? mapDiv.getBoundingClientRect()
      : null;
  if (clientX !== null && clientY !== null && rect) {
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  return { x: 0, y: 0 };
};

const resolveFilterValue = (expression, feature) => {
  if (expression === "$type") {
    return feature?.geometry?.type || null;
  }
  if (Array.isArray(expression)) {
    if (expression[0] === "get" && typeof expression[1] === "string") {
      return feature?.properties?.[expression[1]];
    }
    if (expression[0] === "feature-state" && typeof expression[1] === "string") {
      return feature?.state?.[expression[1]];
    }
    if (expression[0] === "id") {
      return feature?.id;
    }
    if (expression[0] === "literal") {
      return expression[1];
    }
    if (expression[0] === "geometry-type") {
      return feature?.geometry?.type || null;
    }
  }
  return expression;
};

const resolveFilterOperand = (
  expression,
  feature,
  { preferLegacyProperty = false } = {}
) => {
  if (
    preferLegacyProperty &&
    typeof expression === "string" &&
    expression !== "$type" &&
    Object.hasOwn(feature?.properties || {}, expression)
  ) {
    return feature?.properties?.[expression];
  }

  return resolveFilterValue(expression, feature);
};

const evaluateLayerFilter = (filterExpression, feature) => {
  if (!filterExpression) {
    return true;
  }
  if (!Array.isArray(filterExpression) || filterExpression.length === 0) {
    return Boolean(filterExpression);
  }

  const [operator, ...args] = filterExpression;
  if (operator === "all") {
    return args.every((expr) => evaluateLayerFilter(expr, feature));
  }
  if (operator === "any") {
    return args.some((expr) => evaluateLayerFilter(expr, feature));
  }
  if (operator === "!") {
    return !evaluateLayerFilter(args[0], feature);
  }
  if (operator === "has" && args.length >= 1) {
    const key = resolveFilterValue(args[0], feature);
    return typeof key === "string" && Object.hasOwn(feature?.properties || {}, key);
  }
  if (operator === "!has" && args.length >= 1) {
    const key = resolveFilterValue(args[0], feature);
    return !(
      typeof key === "string" && Object.hasOwn(feature?.properties || {}, key)
    );
  }

  if (args.length >= 2) {
    const left = resolveFilterOperand(args[0], feature, {
      preferLegacyProperty: true,
    });
    const right = resolveFilterOperand(args[1], feature);
    if (operator === "==") {
      return left === right;
    }
    if (operator === "!=") {
      return left !== right;
    }
    if (operator === ">") {
      return Number(left) > Number(right);
    }
    if (operator === "<") {
      return Number(left) < Number(right);
    }
    if (operator === ">=") {
      return Number(left) >= Number(right);
    }
    if (operator === "<=") {
      return Number(left) <= Number(right);
    }
  }

  if (args.length >= 1 && (operator === "in" || operator === "!in")) {
    const needle = resolveFilterOperand(args[0], feature, {
      preferLegacyProperty: true,
    });
    const haystack = args.slice(1).flatMap((value) => {
      const resolved = resolveFilterOperand(value, feature);
      return Array.isArray(resolved) ? resolved : [resolved];
    });
    const exists = haystack.includes(needle);
    return operator === "in" ? exists : !exists;
  }

  return true;
};

const createProjectionBridge = (googleMap) => {
  if (
    typeof google === "undefined" ||
    typeof google.maps === "undefined" ||
    typeof google.maps.OverlayView !== "function"
  ) {
    return {
      getProjection: () => null,
      destroy() {},
    };
  }

  class ProjectionBridge extends google.maps.OverlayView {
    onAdd() {}
    draw() {}
    onRemove() {}
  }

  const overlay = new ProjectionBridge();
  overlay.setMap(googleMap);

  return {
    getProjection() {
      return overlay.getProjection?.() || null;
    },
    destroy() {
      try {
        overlay.setMap(null);
      } catch {
        // Ignore teardown failures.
      }
    },
  };
};

const pointDistanceToSegment = (point, start, end) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const tRaw =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
  const t = clamp(tRaw, 0, 1);
  const projectionX = start.x + t * dx;
  const projectionY = start.y + t * dy;
  return Math.hypot(point.x - projectionX, point.y - projectionY);
};

const normalizeMapboxBoundsPixels = (boundsLike) => {
  if (!Array.isArray(boundsLike) || boundsLike.length < 2) {
    return null;
  }
  const first = boundsLike[0];
  const second = boundsLike[1];
  const ax = parseNumber(first?.x ?? first?.[0]);
  const ay = parseNumber(first?.y ?? first?.[1]);
  const bx = parseNumber(second?.x ?? second?.[0]);
  const by = parseNumber(second?.y ?? second?.[1]);
  if (ax === null || ay === null || bx === null || by === null) {
    return null;
  }
  return {
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by),
  };
};

const pointWithinPixelBounds = (point, bounds) =>
  point.x >= bounds.minX &&
  point.x <= bounds.maxX &&
  point.y >= bounds.minY &&
  point.y <= bounds.maxY;

const createMapProxy = (googleMap, { usesCloudMapStyling = false } = {}) => {
  const sourceRegistry = new Map(); // sourceId -> { definition, data, layerIds:Set, sourceApi }
  const layerRegistry = new Map(); // layerId -> { ...layerDefinition, overlays, renderedFeatures, drawOrder }
  const sourceFeatureStateRegistry = new Map(); // sourceId -> Map(featureId -> state)
  const imageRegistry = new Map();
  const layerOrder = [];
  let mapListenerRegistry = [];
  let layerListenerRegistry = [];
  let proxyMap = null;
  let activeStyleName = "dark";
  const projectionBridge = createProjectionBridge(googleMap);

  const buildMapEvent = (event = {}) => {
    const lngLat = toLngLat(event.latLng);
    return {
      ...event,
      lngLat,
      point: toEventPoint(event?.domEvent, googleMap),
    };
  };

  const getSourceFeatureStateMap = (sourceId, { create = false } = {}) => {
    if (!sourceId || typeof sourceId !== "string") {
      return null;
    }
    const existing = sourceFeatureStateRegistry.get(sourceId);
    if (existing || !create) {
      return existing || null;
    }
    const stateMap = new Map();
    sourceFeatureStateRegistry.set(sourceId, stateMap);
    return stateMap;
  };

  const readFeatureState = (sourceId, featureId) => {
    if (featureId === undefined || featureId === null) {
      return {};
    }
    const stateMap = getSourceFeatureStateMap(sourceId);
    if (!stateMap) {
      return {};
    }
    return stateMap.get(String(featureId)) || {};
  };

  const getLayerRecord = (layerId) =>
    typeof layerId === "string" ? layerRegistry.get(layerId) || null : null;

  const clearLayerOverlays = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord) {
      return;
    }
    if (Array.isArray(layerRecord.overlays)) {
      layerRecord.overlays.forEach((overlay) => {
        try {
          overlay?.setMap?.(null);
        } catch {
          // Ignore overlay cleanup errors.
        }
      });
    }
    layerRecord.overlays = [];
    layerRecord.renderedFeatures = [];
  };

  const getLayerZIndex = (layerId) => {
    const index = layerOrder.indexOf(layerId);
    return index >= 0 ? index + 1 : 1;
  };

  const getLayerVisibility = (layerDefinition) =>
    layerDefinition?.layout?.visibility === "none" ? "none" : "visible";

  const resolveLineStyleForLayer = (layerDefinition, feature = null) => {
    const zoom = parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
    const paint = layerDefinition?.paint || {};
    const color = resolveColorStyle(
      paint["line-color"] ?? paint["line-gradient"],
      DEFAULT_LINE_COLOR,
      feature,
      zoom
    );
    const blur = Math.max(
      0,
      resolveNumericStyle(paint["line-blur"], 0, zoom, feature)
    );
    const opacity = clamp(
      resolveNumericStyle(paint["line-opacity"], DEFAULT_LINE_OPACITY, zoom, feature),
      0,
      1
    );
    const width = Math.max(
      0.5,
      resolveNumericStyle(paint["line-width"], DEFAULT_LINE_WIDTH, zoom, feature) +
        blur * 2
    );

    return {
      strokeColor: color,
      strokeOpacity: opacity,
      strokeWeight: width,
    };
  };

  const resolveCircleStyleForLayer = (layerDefinition) => {
    const zoom = parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
    const paint = layerDefinition?.paint || {};
    const color = resolveColorStyle(paint["circle-color"], DEFAULT_CIRCLE_COLOR);
    const opacity = clamp(
      resolveNumericStyle(paint["circle-opacity"], DEFAULT_CIRCLE_OPACITY, zoom),
      0,
      1
    );
    const radius = Math.max(
      1,
      resolveNumericStyle(paint["circle-radius"], DEFAULT_CIRCLE_RADIUS, zoom)
    );
    const strokeColor = resolveColorStyle(
      paint["circle-stroke-color"],
      DEFAULT_CIRCLE_STROKE_COLOR
    );
    const strokeOpacity = clamp(
      resolveNumericStyle(
        paint["circle-stroke-opacity"],
        DEFAULT_CIRCLE_STROKE_OPACITY,
        zoom
      ),
      0,
      1
    );
    const strokeWeight = Math.max(
      0,
      resolveNumericStyle(
        paint["circle-stroke-width"],
        DEFAULT_CIRCLE_STROKE_WIDTH,
        zoom
      )
    );

    return {
      fillColor: color,
      fillOpacity: opacity,
      scale: radius,
      strokeColor,
      strokeOpacity,
      strokeWeight,
    };
  };

  const resolveFillStyleForLayer = (layerDefinition) => {
    const zoom = parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
    const paint = layerDefinition?.paint || {};
    const fillColor = resolveColorStyle(paint["fill-color"], DEFAULT_FILL_COLOR);
    const fillOpacity = clamp(
      resolveNumericStyle(paint["fill-opacity"], DEFAULT_FILL_OPACITY, zoom),
      0,
      1
    );
    const strokeColor = resolveColorStyle(
      paint["fill-outline-color"],
      DEFAULT_FILL_OUTLINE_COLOR
    );

    return {
      fillColor,
      fillOpacity,
      strokeColor,
      strokeOpacity: fillOpacity,
      strokeWeight: 1,
    };
  };

  const createCircleSymbolIcon = (style) => {
    if (!google?.maps?.SymbolPath?.CIRCLE) {
      return null;
    }

    return {
      path: google.maps.SymbolPath.CIRCLE,
      ...style,
    };
  };

  const applyLayerStyle = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord) {
      return;
    }
    const zIndex = getLayerZIndex(layerId);

    if (layerRecord.type === "line") {
      (layerRecord.overlays || []).forEach((overlay) => {
        try {
          const feature = overlay?.__esFeature || null;
          const style = resolveLineStyleForLayer(layerRecord, feature);
          overlay?.setOptions?.({
            ...style,
            zIndex,
          });
        } catch {
          // Ignore per-overlay styling failures.
        }
      });
      return;
    }

    if (layerRecord.type === "circle") {
      const style = resolveCircleStyleForLayer(layerRecord);
      (layerRecord.overlays || []).forEach((overlay) => {
        try {
          overlay.__esCircleRadiusPx = style.scale;
          overlay?.setZIndex?.(zIndex);
          const icon = createCircleSymbolIcon(style);
          if (icon) {
            overlay?.setIcon?.(icon);
          }
        } catch {
          // Ignore per-overlay styling failures.
        }
      });
      return;
    }

    if (layerRecord.type === "fill") {
      const style = resolveFillStyleForLayer(layerRecord);
      (layerRecord.overlays || []).forEach((overlay) => {
        try {
          overlay?.setOptions?.({
            ...style,
            zIndex,
          });
        } catch {
          // Ignore per-overlay styling failures.
        }
      });
    }
  };

  const applyLayerVisibility = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord) {
      return;
    }
    const isVisible = getLayerVisibility(layerRecord) !== "none";
    (layerRecord.overlays || []).forEach((overlay) => {
      try {
        overlay?.setMap?.(isVisible ? googleMap : null);
      } catch {
        // Ignore per-overlay visibility failures.
      }
    });
  };

  const clearLayerBindings = (layerListenerRecord) => {
    if (!layerListenerRecord || !Array.isArray(layerListenerRecord.bindings)) {
      return;
    }
    layerListenerRecord.bindings.forEach((binding) => {
      try {
        binding?.listener?.remove?.();
      } catch {
        // Ignore listener cleanup failures.
      }
    });
    layerListenerRecord.bindings = [];
  };

  const fallbackLngLatFromFeature = (feature) => {
    const geometry = feature?.geometry;
    if (!geometry || typeof geometry !== "object") {
      return null;
    }

    if (geometry.type === "Point") {
      return toLngLat(geometry.coordinates);
    }
    if (geometry.type === "LineString" || geometry.type === "MultiPoint") {
      return toLngLat(geometry.coordinates?.[0]);
    }
    if (geometry.type === "Polygon" || geometry.type === "MultiLineString") {
      return toLngLat(geometry.coordinates?.[0]?.[0]);
    }
    if (geometry.type === "MultiPolygon") {
      return toLngLat(geometry.coordinates?.[0]?.[0]?.[0]);
    }

    return null;
  };

  const bindLayerListenerRecord = (layerListenerRecord) => {
    if (
      !layerListenerRecord ||
      !layerListenerRecord.layerId ||
      typeof layerListenerRecord.handler !== "function"
    ) {
      return;
    }

    clearLayerBindings(layerListenerRecord);

    const layerRecord = getLayerRecord(layerListenerRecord.layerId);
    if (!layerRecord || !Array.isArray(layerRecord.overlays)) {
      return;
    }

    layerRecord.overlays.forEach((overlay) => {
      if (!overlay?.addListener) {
        return;
      }
      const listener = overlay.addListener(layerListenerRecord.googleEvent, (event) => {
        const lngLat =
          toLngLat(event?.latLng) || fallbackLngLatFromFeature(overlay?.__esFeature);
        const domEvent = event?.domEvent || null;
        const point = toEventPoint(domEvent, googleMap);
        const mappedEvent = {
          ...event,
          lngLat,
          point,
          features: overlay?.__esFeature ? [overlay.__esFeature] : [],
          originalEvent:
            domEvent ||
            ({
              button: 0,
              stopPropagation() {},
            }),
        };
        layerListenerRecord.handler(mappedEvent);
      });
      layerListenerRecord.bindings.push({ listener });
    });
  };

  const rebindLayerListeners = (layerId) => {
    layerListenerRegistry.forEach((record) => {
      if (record.layerId === layerId) {
        bindLayerListenerRecord(record);
      }
    });
  };

  const enrichLayerFeature = (renderableFeature, layerRecord, sourceId, layerId) => {
    const featureState = {
      ...(renderableFeature?.feature?.state || {}),
      ...readFeatureState(sourceId, renderableFeature?.feature?.id),
    };

    return {
      ...renderableFeature.feature,
      state: featureState,
      layer: {
        id: layerId,
        type: layerRecord.type,
      },
      source: sourceId,
    };
  };

  const rerenderLineLayer = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord || layerRecord.type !== "line") {
      return;
    }

    const sourceId = layerRecord.source;
    const sourceRecord =
      typeof sourceId === "string" ? sourceRegistry.get(sourceId) || null : null;
    if (!sourceRecord) {
      clearLayerOverlays(layerId);
      return;
    }

    const featureCollection = normalizeGeoJsonFeatureCollection(sourceRecord.data);
    const filterExpression = layerRecord.filter;
    const segments = collectLineSegments(featureCollection).filter((segment) =>
      evaluateLayerFilter(filterExpression, segment.feature)
    );
    clearLayerOverlays(layerId);

    if (segments.length === 0) {
      rebindLayerListeners(layerId);
      return;
    }

    const isVisible = getLayerVisibility(layerRecord) !== "none";
    const zIndex = getLayerZIndex(layerId);

    segments.forEach((segment) => {
      const feature = enrichLayerFeature(segment, layerRecord, sourceId, layerId);
      const style = resolveLineStyleForLayer(layerRecord, feature);
      const overlay = new google.maps.Polyline({
        path: segment.path,
        map: isVisible ? googleMap : null,
        geodesic: true,
        clickable: true,
        strokeColor: style.strokeColor,
        strokeOpacity: style.strokeOpacity,
        strokeWeight: style.strokeWeight,
        zIndex,
      });
      overlay.__esFeature = feature;

      layerRecord.overlays.push(overlay);
      layerRecord.renderedFeatures.push(feature);
    });

    rebindLayerListeners(layerId);
  };

  const rerenderCircleLayer = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord || layerRecord.type !== "circle") {
      return;
    }

    const sourceId = layerRecord.source;
    const sourceRecord =
      typeof sourceId === "string" ? sourceRegistry.get(sourceId) || null : null;
    if (!sourceRecord) {
      clearLayerOverlays(layerId);
      return;
    }

    const featureCollection = normalizeGeoJsonFeatureCollection(sourceRecord.data);
    const filterExpression = layerRecord.filter;
    const points = collectPointFeatures(featureCollection).filter((pointFeature) =>
      evaluateLayerFilter(filterExpression, pointFeature.feature)
    );
    clearLayerOverlays(layerId);

    if (points.length === 0) {
      rebindLayerListeners(layerId);
      return;
    }

    const style = resolveCircleStyleForLayer(layerRecord);
    const isVisible = getLayerVisibility(layerRecord) !== "none";
    const zIndex = getLayerZIndex(layerId);

    points.forEach((pointFeature) => {
      const feature = enrichLayerFeature(pointFeature, layerRecord, sourceId, layerId);
      const icon = createCircleSymbolIcon(style);
      const overlay = new google.maps.Marker({
        map: isVisible ? googleMap : null,
        position: pointFeature.lngLat,
        clickable: true,
        icon: icon || undefined,
        zIndex,
      });
      overlay.__esFeature = feature;
      overlay.__esCircleRadiusPx = style.scale;

      layerRecord.overlays.push(overlay);
      layerRecord.renderedFeatures.push(feature);
    });

    rebindLayerListeners(layerId);
  };

  const rerenderFillLayer = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord || layerRecord.type !== "fill") {
      return;
    }

    const sourceId = layerRecord.source;
    const sourceRecord =
      typeof sourceId === "string" ? sourceRegistry.get(sourceId) || null : null;
    if (!sourceRecord) {
      clearLayerOverlays(layerId);
      return;
    }

    const featureCollection = normalizeGeoJsonFeatureCollection(sourceRecord.data);
    const filterExpression = layerRecord.filter;
    const polygons = collectPolygonFeatures(featureCollection).filter(
      (polygonFeature) => evaluateLayerFilter(filterExpression, polygonFeature.feature)
    );
    clearLayerOverlays(layerId);

    if (polygons.length === 0) {
      rebindLayerListeners(layerId);
      return;
    }

    const style = resolveFillStyleForLayer(layerRecord);
    const isVisible = getLayerVisibility(layerRecord) !== "none";
    const zIndex = getLayerZIndex(layerId);

    polygons.forEach((polygonFeature) => {
      const feature = enrichLayerFeature(polygonFeature, layerRecord, sourceId, layerId);
      const overlay = new google.maps.Polygon({
        paths: polygonFeature.paths,
        map: isVisible ? googleMap : null,
        clickable: true,
        ...style,
        zIndex,
      });
      overlay.__esFeature = feature;

      layerRecord.overlays.push(overlay);
      layerRecord.renderedFeatures.push(feature);
    });

    rebindLayerListeners(layerId);
  };

  const rerenderLayer = (layerId) => {
    const layerRecord = getLayerRecord(layerId);
    if (!layerRecord) {
      return;
    }

    if (layerRecord.type === "line") {
      rerenderLineLayer(layerId);
      return;
    }
    if (layerRecord.type === "circle") {
      rerenderCircleLayer(layerId);
      return;
    }
    if (layerRecord.type === "fill") {
      rerenderFillLayer(layerId);
      return;
    }

    clearLayerOverlays(layerId);
    rebindLayerListeners(layerId);
  };

  const rerenderSourceLayers = (sourceId) => {
    const sourceRecord = sourceRegistry.get(sourceId);
    if (!sourceRecord) {
      return;
    }
    sourceRecord.layerIds.forEach((layerId) => {
      rerenderLayer(layerId);
    });
  };

  const updateAllLayerZIndices = () => {
    layerOrder.forEach((layerId) => {
      applyLayerStyle(layerId);
    });
  };

  const addSourceRecord = (id, sourceDefinition = {}) => {
    const definition = {
      ...sourceDefinition,
      data: normalizeGeoJsonFeatureCollection(sourceDefinition?.data),
    };
    const sourceRecord = {
      definition,
      data: definition.data,
      layerIds: new Set(),
      sourceApi: null,
    };
    const sourceApi = {
      setData(data) {
        sourceRecord.data = normalizeGeoJsonFeatureCollection(data);
        sourceRecord.definition.data = sourceRecord.data;
        rerenderSourceLayers(id);
        return sourceApi;
      },
    };
    sourceRecord.sourceApi = sourceApi;
    sourceRegistry.set(id, sourceRecord);
    sourceFeatureStateRegistry.delete(id);
  };

  const applyCameraOptions = (options = {}, { animated = true } = {}) => {
    const center = toLngLat(options.center);
    if (center) {
      if (animated && typeof googleMap.panTo === "function") {
        googleMap.panTo(center);
      } else if (typeof googleMap.setCenter === "function") {
        googleMap.setCenter(center);
      }
    }

    const zoom = parseNumber(options.zoom);
    if (zoom !== null && typeof googleMap.setZoom === "function") {
      googleMap.setZoom(zoom);
    }

    return proxyMap;
  };

  const getProjection = () => projectionBridge.getProjection();

  const projectLngLatToPixel = (lngLat) => {
    const projection = getProjection();
    if (!projection) {
      return null;
    }
    if (typeof projection.fromLatLngToDivPixel === "function") {
      return projection.fromLatLngToDivPixel(lngLat);
    }
    if (typeof projection.fromLatLngToContainerPixel === "function") {
      return projection.fromLatLngToContainerPixel(lngLat);
    }
    return null;
  };

  const unprojectPixelToLngLat = (point) => {
    const projection = getProjection();
    if (!projection) {
      return null;
    }
    if (typeof projection.fromDivPixelToLatLng === "function") {
      return projection.fromDivPixelToLatLng(point);
    }
    if (typeof projection.fromContainerPixelToLatLng === "function") {
      return projection.fromContainerPixelToLatLng(point);
    }
    return null;
  };

  const extractLngLatsFromPath = (pathInput) => {
    const entries = [];
    if (pathInput?.getArray) {
      pathInput.getArray().forEach((entry) => entries.push(entry));
    } else if (Array.isArray(pathInput)) {
      pathInput.forEach((entry) => entries.push(entry));
    }

    return entries
      .map((entry) => toLngLat(entry))
      .filter((lngLat) => lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat));
  };

  const toPixelPoints = (lngLats) =>
    (Array.isArray(lngLats) ? lngLats : [])
      .map((lngLat) => projectLngLatToPixel(lngLat))
      .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));

  const linePixelsForOverlay = (overlay) => {
    let latLngs = extractLngLatsFromPath(overlay?.getPath?.());

    if (!latLngs.length) {
      const coords = overlay?.__esFeature?.geometry?.coordinates || [];
      latLngs = (Array.isArray(coords) ? coords : [])
        .map((coord) => toLngLat(coord))
        .filter((lngLat) => lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat));
    }

    return toPixelPoints(latLngs);
  };

  const polygonPixelRingsForOverlay = (overlay) => {
    const rings = [];
    const paths = overlay?.getPaths?.();

    if (paths?.getArray) {
      paths.getArray().forEach((path) => {
        const ringPixels = toPixelPoints(extractLngLatsFromPath(path));
        if (ringPixels.length >= 3) {
          rings.push(ringPixels);
        }
      });
    } else {
      const ringPixels = toPixelPoints(extractLngLatsFromPath(overlay?.getPath?.()));
      if (ringPixels.length >= 3) {
        rings.push(ringPixels);
      }
    }

    if (!rings.length) {
      const geometryCoordinates = overlay?.__esFeature?.geometry?.coordinates;
      (Array.isArray(geometryCoordinates) ? geometryCoordinates : []).forEach(
        (ringCoordinates) => {
          const ringLngLats = (Array.isArray(ringCoordinates) ? ringCoordinates : [])
            .map((coord) => toLngLat(coord))
            .filter(
              (lngLat) =>
                lngLat && Number.isFinite(lngLat.lng) && Number.isFinite(lngLat.lat)
            );
          const ringPixels = toPixelPoints(ringLngLats);
          if (ringPixels.length >= 3) {
            rings.push(ringPixels);
          }
        }
      );
    }

    return rings;
  };

  const circlePixelsForOverlay = (overlay) => {
    const centerLngLat =
      toLngLat(overlay?.getPosition?.()) ||
      toLngLat(overlay?.__esFeature?.geometry?.coordinates);
    if (!centerLngLat) {
      return null;
    }

    const center = projectLngLatToPixel(centerLngLat);
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      return null;
    }

    const radiusPx = Math.max(
      0,
      parseNumber(overlay?.__esCircleRadiusPx) ??
        parseNumber(overlay?.getIcon?.()?.scale) ??
        DEFAULT_CIRCLE_RADIUS
    );

    return { center, radiusPx };
  };

  const pointInPixelRing = (point, ring) => {
    if (!Array.isArray(ring) || ring.length < 3) {
      return false;
    }

    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      const intersects =
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
      if (intersects) {
        inside = !inside;
      }
    }

    return inside;
  };

  const pointInPolygonWithHoles = (point, rings) => {
    if (!Array.isArray(rings) || !rings.length) {
      return false;
    }

    if (!pointInPixelRing(point, rings[0])) {
      return false;
    }

    for (let i = 1; i < rings.length; i += 1) {
      if (pointInPixelRing(point, rings[i])) {
        return false;
      }
    }

    return true;
  };

  const segmentIntersectsSegment = (startA, endA, startB, endB) => {
    const denominator =
      (endA.x - startA.x) * (endB.y - startB.y) -
      (endA.y - startA.y) * (endB.x - startB.x);
    if (Math.abs(denominator) < 1e-9) {
      return false;
    }

    const t =
      ((startB.x - startA.x) * (endB.y - startB.y) -
        (startB.y - startA.y) * (endB.x - startB.x)) /
      denominator;
    const u =
      ((startB.x - startA.x) * (endA.y - startA.y) -
        (startB.y - startA.y) * (endA.x - startA.x)) /
      denominator;

    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };

  const boundsCorners = (bounds) => [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];

  const boundsEdges = (bounds) => {
    const corners = boundsCorners(bounds);
    return [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]],
    ];
  };

  const pathIntersectsBounds = (pixelPath, bounds) => {
    if (!Array.isArray(pixelPath) || pixelPath.length === 0) {
      return false;
    }

    if (pixelPath.some((point) => pointWithinPixelBounds(point, bounds))) {
      return true;
    }

    const edges = boundsEdges(bounds);
    for (let i = 1; i < pixelPath.length; i += 1) {
      const start = pixelPath[i - 1];
      const end = pixelPath[i];
      for (let j = 0; j < edges.length; j += 1) {
        const [edgeStart, edgeEnd] = edges[j];
        if (segmentIntersectsSegment(start, end, edgeStart, edgeEnd)) {
          return true;
        }
      }
    }

    return false;
  };

  const polygonIntersectsBounds = (rings, bounds) => {
    if (!Array.isArray(rings) || !rings.length) {
      return false;
    }

    if (
      rings.some((ring) => {
        if (!Array.isArray(ring) || ring.length < 2) {
          return false;
        }
        return pathIntersectsBounds([...ring, ring[0]], bounds);
      })
    ) {
      return true;
    }

    return boundsCorners(bounds).some((corner) => pointInPolygonWithHoles(corner, rings));
  };

  const overlayLayerType = (overlay) => overlay?.__esFeature?.layer?.type || "line";

  const overlayHitsPoint = (overlay, point) => {
    const layerType = overlayLayerType(overlay);

    if (layerType === "circle") {
      const circle = circlePixelsForOverlay(overlay);
      if (!circle) {
        return false;
      }
      const distance = Math.hypot(point.x - circle.center.x, point.y - circle.center.y);
      return distance <= circle.radiusPx + 2;
    }

    if (layerType === "fill") {
      const rings = polygonPixelRingsForOverlay(overlay);
      return pointInPolygonWithHoles(point, rings);
    }

    const pixelPath = linePixelsForOverlay(overlay);
    if (pixelPath.length < 2) {
      return false;
    }

    const strokeWeight = parseNumber(overlay?.get?.("strokeWeight"));
    const tolerance = Math.max(
      DEFAULT_HIT_TOLERANCE_PX,
      (strokeWeight ?? DEFAULT_LINE_WIDTH) / 2 + 2
    );

    for (let i = 1; i < pixelPath.length; i += 1) {
      const distance = pointDistanceToSegment(point, pixelPath[i - 1], pixelPath[i]);
      if (distance <= tolerance) {
        return true;
      }
    }

    return false;
  };

  const overlayIntersectsBounds = (overlay, bounds) => {
    const layerType = overlayLayerType(overlay);

    if (layerType === "circle") {
      const circle = circlePixelsForOverlay(overlay);
      if (!circle) {
        return false;
      }
      const nearestX = clamp(circle.center.x, bounds.minX, bounds.maxX);
      const nearestY = clamp(circle.center.y, bounds.minY, bounds.maxY);
      const distance = Math.hypot(circle.center.x - nearestX, circle.center.y - nearestY);
      return distance <= circle.radiusPx;
    }

    if (layerType === "fill") {
      const rings = polygonPixelRingsForOverlay(overlay);
      return polygonIntersectsBounds(rings, bounds);
    }

    const pixelPath = linePixelsForOverlay(overlay);
    return pathIntersectsBounds(pixelPath, bounds);
  };

  const mapboxLikeMethods = {
    on(eventName, layerIdOrHandler, maybeHandler) {
      if (typeof layerIdOrHandler === "string" && typeof maybeHandler === "function") {
        const layerListenerRecord = {
          eventName,
          googleEvent: toGoogleEventName(eventName),
          layerId: layerIdOrHandler,
          handler: maybeHandler,
          bindings: [],
        };
        layerListenerRegistry.push(layerListenerRecord);
        bindLayerListenerRecord(layerListenerRecord);
        return proxyMap;
      }

      const handler =
        typeof layerIdOrHandler === "function" ? layerIdOrHandler : maybeHandler;
      if (typeof handler !== "function") {
        return proxyMap;
      }

      const googleEvent = toGoogleEventName(eventName);
      const wrappedHandler = (event) => handler(buildMapEvent(event));
      const listener = googleMap.addListener(googleEvent, wrappedHandler);

      mapListenerRegistry.push({
        eventName,
        handler,
        listener,
      });
      return proxyMap;
    },

    once(eventName, layerIdOrHandler, maybeHandler) {
      if (typeof layerIdOrHandler === "string" && typeof maybeHandler === "function") {
        const layerId = layerIdOrHandler;
        const handler = maybeHandler;
        const onceHandler = (event) => {
          mapboxLikeMethods.off(eventName, layerId, onceHandler);
          handler(event);
        };
        return mapboxLikeMethods.on(eventName, layerId, onceHandler);
      }

      const handler =
        typeof layerIdOrHandler === "function" ? layerIdOrHandler : maybeHandler;
      if (typeof handler !== "function") {
        return proxyMap;
      }

      const googleEvent = toGoogleEventName(eventName);
      const wrappedHandler = (event) => handler(buildMapEvent(event));
      const listener = google.maps.event.addListenerOnce(
        googleMap,
        googleEvent,
        wrappedHandler
      );

      mapListenerRegistry.push({
        eventName,
        handler,
        listener,
      });
      return proxyMap;
    },

    off(eventName, layerIdOrHandler, maybeHandler) {
      if (typeof layerIdOrHandler === "string") {
        const layerId = layerIdOrHandler;
        const handler = maybeHandler;
        layerListenerRegistry = layerListenerRegistry.filter((record) => {
          const eventMatches = !eventName || record.eventName === eventName;
          const layerMatches = record.layerId === layerId;
          const handlerMatches =
            typeof handler !== "function" || record.handler === handler;
          if (eventMatches && layerMatches && handlerMatches) {
            clearLayerBindings(record);
            return false;
          }
          return true;
        });
        return proxyMap;
      }

      const hasEventName = typeof eventName === "string" && eventName.length > 0;
      const handler =
        typeof layerIdOrHandler === "function" ? layerIdOrHandler : maybeHandler;

      mapListenerRegistry = mapListenerRegistry.filter((record) => {
        const eventMatches = !hasEventName || record.eventName === eventName;
        const handlerMatches = typeof handler !== "function" || record.handler === handler;
        if (eventMatches && handlerMatches) {
          record.listener?.remove?.();
          return false;
        }
        return true;
      });

      return proxyMap;
    },

    addSource(id, sourceDefinition = {}) {
      if (!id) {
        return proxyMap;
      }
      addSourceRecord(id, sourceDefinition);
      return proxyMap;
    },

    getSource(id) {
      return sourceRegistry.get(id)?.sourceApi || null;
    },

    removeSource(id) {
      const sourceRecord = sourceRegistry.get(id);
      if (sourceRecord) {
        sourceRecord.layerIds.forEach((layerId) => clearLayerOverlays(layerId));
      }
      sourceRegistry.delete(id);
      sourceFeatureStateRegistry.delete(id);
      return proxyMap;
    },

    addLayer(layerDefinition = {}, beforeId) {
      const layerId = layerDefinition?.id;
      if (!layerId) {
        return proxyMap;
      }

      if (layerRegistry.has(layerId)) {
        mapboxLikeMethods.removeLayer(layerId);
      }

      const sourceId =
        typeof layerDefinition.source === "string" ? layerDefinition.source : null;
      const layerRecord = {
        ...layerDefinition,
        source: sourceId,
        overlays: [],
        renderedFeatures: [],
      };
      layerRegistry.set(layerId, layerRecord);

      if (sourceId) {
        const sourceRecord = sourceRegistry.get(sourceId);
        if (sourceRecord) {
          sourceRecord.layerIds.add(layerId);
        }
      }

      if (beforeId && layerOrder.includes(beforeId)) {
        const index = layerOrder.indexOf(beforeId);
        layerOrder.splice(index, 0, layerId);
      } else {
        layerOrder.push(layerId);
      }

      rerenderLayer(layerId);
      updateAllLayerZIndices();

      return proxyMap;
    },

    getLayer(id) {
      return layerRegistry.get(id) || null;
    },

    removeLayer(id) {
      const layerRecord = layerRegistry.get(id);
      if (!layerRecord) {
        return proxyMap;
      }

      clearLayerOverlays(id);

      if (layerRecord.source) {
        const sourceRecord = sourceRegistry.get(layerRecord.source);
        sourceRecord?.layerIds?.delete(id);
      }

      layerRegistry.delete(id);

      const orderIndex = layerOrder.indexOf(id);
      if (orderIndex >= 0) {
        layerOrder.splice(orderIndex, 1);
      }

      // Drop all layer-scoped listeners.
      layerListenerRegistry = layerListenerRegistry.filter((record) => {
        if (record.layerId === id) {
          clearLayerBindings(record);
          return false;
        }
        return true;
      });

      updateAllLayerZIndices();
      return proxyMap;
    },

    setLayoutProperty(layerId, property, value) {
      const layer = layerRegistry.get(layerId);
      if (!layer) {
        return proxyMap;
      }
      layer.layout = { ...(layer.layout || {}), [property]: value };
      if (property === "visibility") {
        applyLayerVisibility(layerId);
      }
      return proxyMap;
    },

    setPaintProperty(layerId, property, value) {
      const layer = layerRegistry.get(layerId);
      if (!layer) {
        return proxyMap;
      }
      layer.paint = { ...(layer.paint || {}), [property]: value };
      const shouldApplyStyle =
        (layer.type === "line" && LINE_PAINT_PROPERTIES.has(property)) ||
        (layer.type === "circle" && CIRCLE_PAINT_PROPERTIES.has(property)) ||
        (layer.type === "fill" && FILL_PAINT_PROPERTIES.has(property));
      if (shouldApplyStyle) {
        applyLayerStyle(layerId);
      }
      return proxyMap;
    },

    setFilter(layerId, filterExpression) {
      const layer = layerRegistry.get(layerId);
      if (!layer) {
        return proxyMap;
      }
      layer.filter = filterExpression || null;
      rerenderLayer(layerId);
      return proxyMap;
    },

    getFilter(layerId) {
      const layer = layerRegistry.get(layerId);
      return layer?.filter || null;
    },

    moveLayer(layerId, beforeId) {
      if (!layerRegistry.has(layerId)) {
        return proxyMap;
      }
      const currentIndex = layerOrder.indexOf(layerId);
      if (currentIndex < 0) {
        return proxyMap;
      }

      layerOrder.splice(currentIndex, 1);
      if (beforeId && layerOrder.includes(beforeId)) {
        const nextIndex = layerOrder.indexOf(beforeId);
        layerOrder.splice(nextIndex, 0, layerId);
      } else {
        layerOrder.push(layerId);
      }

      updateAllLayerZIndices();
      return proxyMap;
    },

    queryRenderedFeatures(areaOrOptions, maybeOptions) {
      let options = null;
      let queryPoint = null;
      let queryBounds = null;

      if (
        areaOrOptions &&
        typeof areaOrOptions === "object" &&
        !Array.isArray(areaOrOptions) &&
        Array.isArray(areaOrOptions.layers)
      ) {
        options = areaOrOptions;
      } else if (
        maybeOptions &&
        typeof maybeOptions === "object" &&
        Array.isArray(maybeOptions.layers)
      ) {
        options = maybeOptions;
        const x = parseNumber(areaOrOptions?.x ?? areaOrOptions?.[0]);
        const y = parseNumber(areaOrOptions?.y ?? areaOrOptions?.[1]);
        if (x !== null && y !== null) {
          queryPoint = { x, y };
        } else {
          queryBounds = normalizeMapboxBoundsPixels(areaOrOptions);
        }
      }

      if (!options?.layers?.length) {
        return [];
      }

      const features = [];
      options.layers.forEach((layerId) => {
        const layerRecord = getLayerRecord(layerId);
        if (!layerRecord || getLayerVisibility(layerRecord) === "none") {
          return;
        }

        if (!Array.isArray(layerRecord.renderedFeatures) || !layerRecord.renderedFeatures.length) {
          return;
        }

        if (!queryPoint && !queryBounds) {
          features.push(...layerRecord.renderedFeatures);
          return;
        }

        (layerRecord.overlays || []).forEach((overlay) => {
          const feature = overlay?.__esFeature;
          if (!feature) {
            return;
          }
          if (queryPoint && overlayHitsPoint(overlay, queryPoint)) {
            features.push(feature);
            return;
          }
          if (queryBounds && overlayIntersectsBounds(overlay, queryBounds)) {
            features.push(feature);
          }
        });
      });

      return features;
    },

    querySourceFeatures(sourceId, options = {}) {
      const sourceRecord =
        typeof sourceId === "string" ? sourceRegistry.get(sourceId) || null : null;
      if (!sourceRecord) {
        return [];
      }

      const featureCollection = normalizeGeoJsonFeatureCollection(sourceRecord.data);
      return (featureCollection.features || [])
        .filter((feature) => evaluateLayerFilter(options.filter, feature))
        .map((feature) => ({
          ...feature,
          source: sourceId,
          state: {
            ...(feature?.state || {}),
            ...readFeatureState(sourceId, feature?.id),
          },
        }));
    },

    getCanvas() {
      return googleMap.getDiv?.() || null;
    },

    getCanvasContainer() {
      return googleMap.getDiv?.() || null;
    },

    isMoving() {
      return false;
    },

    hasImage(id) {
      return imageRegistry.has(id);
    },

    addImage(id, image, options = {}) {
      if (!id) {
        return proxyMap;
      }
      imageRegistry.set(id, { image, options });
      return proxyMap;
    },

    removeImage(id) {
      imageRegistry.delete(id);
      return proxyMap;
    },

    loadImage(url, callback) {
      if (typeof callback !== "function") {
        return proxyMap;
      }
      const img = new Image();
      img.onload = () => callback(null, img);
      img.onerror = () => callback(new Error(`Failed to load image: ${url}`));
      img.src = url;
      return proxyMap;
    },

    getStyle() {
      const sources = {};
      sourceRegistry.forEach((sourceRecord, sourceId) => {
        sources[sourceId] = {
          type: sourceRecord.definition?.type || "geojson",
          data: sourceRecord.data,
        };
      });
      return {
        name: activeStyleName,
        layers: layerOrder
          .map((layerId) => layerRegistry.get(layerId))
          .filter(Boolean)
          .map((layer) => ({
            id: layer.id,
            type: layer.type,
            source: layer.source,
            filter: layer.filter || null,
            layout: { ...(layer.layout || {}) },
            paint: { ...(layer.paint || {}) },
          })),
        sources,
      };
    },

    setStyle(styleValue) {
      const styleText =
        typeof styleValue === "string" ? styleValue.toLowerCase() : "";
      if (styleText.includes("satellite")) {
        activeStyleName = "satellite";
        googleMap.setMapTypeId?.("satellite");
        if (!usesCloudMapStyling) {
          googleMap.setOptions?.({ styles: null });
        }
      } else if (styleText.includes("streets")) {
        activeStyleName = "streets";
        googleMap.setMapTypeId?.("roadmap");
        if (!usesCloudMapStyling) {
          googleMap.setOptions?.({ styles: null });
        }
      } else if (styleText.includes("light")) {
        activeStyleName = "light";
        googleMap.setMapTypeId?.("roadmap");
        if (usesCloudMapStyling) {
          const cloudTheme = hasHardcodedLightMapId() ? "light" : "dark";
          googleMap.setOptions?.({ colorScheme: getGoogleColorScheme(cloudTheme) });
        } else {
          googleMap.setOptions?.({ styles: null });
        }
      } else {
        activeStyleName = "dark";
        googleMap.setMapTypeId?.("roadmap");
        if (usesCloudMapStyling) {
          googleMap.setOptions?.({ colorScheme: getGoogleColorScheme("dark") });
        } else {
          googleMap.setOptions?.({ styles: GOOGLE_DARK_STYLE });
        }
      }
      return proxyMap;
    },

    isStyleLoaded() {
      return true;
    },

    fitBounds(boundsInput, options = {}) {
      const bounds = toGoogleLatLngBounds(boundsInput);
      if (!bounds) {
        return proxyMap;
      }

      const padding = parseNumber(options.padding);
      if (padding !== null) {
        googleMap.fitBounds(bounds, padding);
      } else {
        googleMap.fitBounds(bounds);
      }

      const maxZoom = parseNumber(options.maxZoom);
      if (maxZoom !== null) {
        const clampListener = googleMap.addListener("idle", () => {
          const currentZoom = parseNumber(googleMap.getZoom?.());
          if (currentZoom !== null && currentZoom > maxZoom) {
            googleMap.setZoom(maxZoom);
          }
          clampListener.remove();
        });
      }

      return proxyMap;
    },

    jumpTo(options = {}) {
      return applyCameraOptions(options, { animated: false });
    },

    flyTo(options = {}) {
      return applyCameraOptions(options, { animated: true });
    },

    easeTo(options = {}) {
      return applyCameraOptions(options, { animated: true });
    },

    getCenter() {
      const center = googleMap.getCenter?.();
      return {
        lng: parseNumber(center?.lng, center) ?? CONFIG.MAP.defaultCenter[0],
        lat: parseNumber(center?.lat, center) ?? CONFIG.MAP.defaultCenter[1],
      };
    },

    getZoom() {
      return parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
    },

    getBearing() {
      return 0;
    },

    getPitch() {
      return 0;
    },

    project(lngLatInput) {
      const lngLat = toLngLat(lngLatInput);
      if (!lngLat) {
        return { x: 0, y: 0 };
      }
      const point = projectLngLatToPixel(lngLat);
      return {
        x: parseNumber(point?.x) ?? 0,
        y: parseNumber(point?.y) ?? 0,
      };
    },

    unproject(pointInput) {
      const x = parseNumber(pointInput?.x ?? pointInput?.[0]);
      const y = parseNumber(pointInput?.y ?? pointInput?.[1]);
      if (x === null || y === null) {
        return {
          lng: CONFIG.MAP.defaultCenter[0],
          lat: CONFIG.MAP.defaultCenter[1],
        };
      }
      const latLng = unprojectPixelToLngLat({ x, y });
      const lng = parseNumber(latLng?.lng, latLng);
      const lat = parseNumber(latLng?.lat, latLng);
      return {
        lng: lng ?? CONFIG.MAP.defaultCenter[0],
        lat: lat ?? CONFIG.MAP.defaultCenter[1],
      };
    },

    zoomIn() {
      const zoom = parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
      googleMap.setZoom?.(zoom + 1);
      return proxyMap;
    },

    zoomOut() {
      const zoom = parseNumber(googleMap.getZoom?.()) ?? CONFIG.MAP.defaultZoom;
      googleMap.setZoom?.(zoom - 1);
      return proxyMap;
    },

    resize() {
      google.maps.event.trigger(googleMap, "resize");
      return proxyMap;
    },

    addControl() {
      return proxyMap;
    },

    loaded() {
      return true;
    },

    setFeatureState(target = {}, featureState = {}) {
      const sourceId = target?.source;
      const featureId = target?.id;
      if (
        typeof sourceId !== "string" ||
        (featureId === undefined || featureId === null)
      ) {
        return proxyMap;
      }

      const stateMap = getSourceFeatureStateMap(sourceId, { create: true });
      const key = String(featureId);
      const previous = stateMap.get(key) || {};
      stateMap.set(key, { ...previous, ...(featureState || {}) });
      rerenderSourceLayers(sourceId);
      return proxyMap;
    },

    getFeatureState(target = {}) {
      const sourceId = target?.source;
      const featureId = target?.id;
      if (
        typeof sourceId !== "string" ||
        (featureId === undefined || featureId === null)
      ) {
        return {};
      }
      return readFeatureState(sourceId, featureId);
    },

    removeFeatureState(target = {}, key) {
      const sourceId = target?.source;
      if (typeof sourceId !== "string") {
        return proxyMap;
      }
      const stateMap = getSourceFeatureStateMap(sourceId);
      if (!stateMap) {
        return proxyMap;
      }

      const featureId = target?.id;
      if (featureId === undefined || featureId === null) {
        stateMap.clear();
      } else if (!key) {
        stateMap.delete(String(featureId));
      } else {
        const current = { ...(stateMap.get(String(featureId)) || {}) };
        delete current[key];
        stateMap.set(String(featureId), current);
      }

      rerenderSourceLayers(sourceId);
      return proxyMap;
    },

    scrollZoom: INTERACTION_NOOP,
    boxZoom: INTERACTION_NOOP,
    doubleClickZoom: INTERACTION_NOOP,
    dragRotate: INTERACTION_NOOP,
    touchZoomRotate: INTERACTION_NOOP,
    dragPan: INTERACTION_NOOP,
    keyboard: INTERACTION_NOOP,

    remove() {
      mapListenerRegistry.forEach((record) => record.listener?.remove?.());
      mapListenerRegistry = [];
      layerListenerRegistry.forEach((record) => clearLayerBindings(record));
      layerListenerRegistry = [];
      layerRegistry.forEach((_value, layerId) => clearLayerOverlays(layerId));
      layerOrder.splice(0, layerOrder.length);
      sourceRegistry.clear();
      sourceFeatureStateRegistry.clear();
      imageRegistry.clear();
      layerRegistry.clear();
      projectionBridge.destroy();
      return proxyMap;
    },
  };

  googleMap.addListener("zoom_changed", () => {
    layerOrder.forEach((layerId) => applyLayerStyle(layerId));
  });

  proxyMap = new Proxy(googleMap, {
    get(target, prop) {
      if (prop === "__esGoogleMap") {
        return googleMap;
      }
      if (prop === "__esMapProxy") {
        return proxyMap;
      }

      if (prop in mapboxLikeMethods) {
        return mapboxLikeMethods[prop];
      }

      if (prop in target) {
        const value = target[prop];
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      }

      return () => proxyMap;
    },
  });

  try {
    googleMap.__esMapProxy = proxyMap;
  } catch {
    // Ignore readonly assignment failures.
  }

  return proxyMap;
};

const resolveGoogleMapInstance = (mapCandidate) => {
  if (!mapCandidate || typeof mapCandidate !== "object") {
    return null;
  }
  if (mapCandidate.__esGoogleMap) {
    return mapCandidate.__esGoogleMap;
  }
  if (mapCandidate.__esMapProxy?.__esGoogleMap) {
    return mapCandidate.__esMapProxy.__esGoogleMap;
  }
  if (typeof mapCandidate.getDiv === "function" && typeof mapCandidate.addListener === "function") {
    return mapCandidate;
  }
  return null;
};

const createMarkerIconFromColor = (color) => {
  if (
    typeof google === "undefined" ||
    typeof google.maps === "undefined" ||
    !google.maps.SymbolPath
  ) {
    return undefined;
  }
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 7,
    fillColor: color || "#d09868",
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 2,
  };
};

const ensureMapboxCompatibility = () => {
  if (
    typeof globalThis === "undefined" ||
    typeof google === "undefined" ||
    typeof google.maps === "undefined"
  ) {
    return;
  }

  const mapboxgl = globalThis.mapboxgl || {};

  if (typeof mapboxgl.LngLatBounds !== "function") {
    mapboxgl.LngLatBounds = class LngLatBounds {
      constructor(sw, ne) {
        this._sw = null;
        this._ne = null;
        if (sw) {
          this.extend(sw);
        }
        if (ne) {
          this.extend(ne);
        }
      }

      extend(value) {
        const lngLat = toLngLat(value);
        if (!lngLat) {
          return this;
        }
        if (!this._sw || !this._ne) {
          this._sw = { ...lngLat };
          this._ne = { ...lngLat };
          return this;
        }
        this._sw = {
          lng: Math.min(this._sw.lng, lngLat.lng),
          lat: Math.min(this._sw.lat, lngLat.lat),
        };
        this._ne = {
          lng: Math.max(this._ne.lng, lngLat.lng),
          lat: Math.max(this._ne.lat, lngLat.lat),
        };
        return this;
      }

      getSouthWest() {
        const sw = this._sw || {
          lng: CONFIG.MAP.defaultCenter[0],
          lat: CONFIG.MAP.defaultCenter[1],
        };
        return {
          lng: () => sw.lng,
          lat: () => sw.lat,
        };
      }

      getNorthEast() {
        const ne = this._ne || {
          lng: CONFIG.MAP.defaultCenter[0],
          lat: CONFIG.MAP.defaultCenter[1],
        };
        return {
          lng: () => ne.lng,
          lat: () => ne.lat,
        };
      }

      isEmpty() {
        return !this._sw || !this._ne;
      }
    };
  }

  if (typeof mapboxgl.Popup !== "function") {
    // Track the active popup globally so we can auto-close on new opens
    let _activePopupInstance = null;

    mapboxgl.Popup = class Popup {
      constructor(options = {}) {
        this.options = options;
        this._content = "";
        this._position = null;
        this._map = null;
        this._anchor = null;
        this._mapClickListener = null;
        this._domReadyListener = null;
        this._eventHandlers = {};
        this._element =
          typeof document !== "undefined" ? document.createElement("div") : null;
        this._contentElement =
          typeof document !== "undefined" ? document.createElement("div") : null;
        if (this._element && this._contentElement) {
          this._element.className = "mapboxgl-popup";
          this._contentElement.className = "mapboxgl-popup-content";
          this._element.appendChild(this._contentElement);
        }
        this._infoWindow =
          typeof google.maps.InfoWindow === "function"
            ? new google.maps.InfoWindow({
                disableAutoPan: false,
                maxWidth: parseNumber(options.maxWidth) || 400,
              })
            : null;
      }

      _syncInfoWindowContent() {
        if (!this._infoWindow) {
          return;
        }
        this._infoWindow.setContent?.(this._element || this._content || "");
      }

      _styleInfoWindow() {
        if (!this._infoWindow) {
          return;
        }
        // Remove previous domready listener to avoid stacking
        this._domReadyListener?.remove?.();
        // Style the Google InfoWindow container to match the app's dark theme
        // after opening (domready fires once the InfoWindow DOM is attached).
        this._domReadyListener = this._infoWindow.addListener("domready", () => {
          try {
            const iwOuter = this._element?.closest?.(".gm-style-iw");
            if (iwOuter) {
              iwOuter.style.backgroundColor = "transparent";
              iwOuter.style.boxShadow = "none";
              iwOuter.style.padding = "0";
              iwOuter.style.overflow = "visible";
            }
            // Remove the default white background container
            const iwBackground = iwOuter?.previousElementSibling;
            if (iwBackground) {
              iwBackground.style.display = "none";
            }
            // Also target the outer wrapper that adds a background
            const iwContainer = iwOuter?.parentElement;
            if (iwContainer) {
              iwContainer.style.backgroundColor = "transparent";
              iwContainer.style.boxShadow = "none";
            }
            // Hide the default close button (we use the mapboxgl-popup-content one)
            const iwClose = iwOuter?.nextElementSibling;
            if (iwClose?.classList?.contains("gm-ui-hover-effect")) {
              iwClose.style.display = "none";
            }
            // Remove the arrow/tail background
            const iwTail = iwOuter?.parentElement?.querySelector?.(".gm-style-iw-tc");
            if (iwTail) {
              iwTail.style.display = "none";
            }
          } catch {
            // Ignore DOM traversal failures; InfoWindow still works.
          }
        });
      }

      setLngLat(value) {
        this._position = toLngLat(value);
        if (this._infoWindow && this._position) {
          this._infoWindow.setPosition(this._position);
        }
        return this;
      }

      setHTML(html) {
        this._content = String(html || "");
        if (this._contentElement) {
          this._contentElement.innerHTML = this._content;
        }
        this._syncInfoWindowContent();
        return this;
      }

      setText(text) {
        const container = document.createElement("div");
        container.textContent = String(text || "");
        return this.setDOMContent(container);
      }

      setDOMContent(node) {
        if (!node) {
          return this;
        }
        this._content = node;
        if (this._contentElement) {
          this._contentElement.innerHTML = "";
          this._contentElement.appendChild(node);
        }
        this._syncInfoWindowContent();
        return this;
      }

      getElement() {
        return this._element;
      }

      setOffset() {
        return this;
      }

      on(eventName, handler) {
        if (typeof handler !== "function") {
          return this;
        }
        if (!this._eventHandlers[eventName]) {
          this._eventHandlers[eventName] = [];
        }
        this._eventHandlers[eventName].push(handler);
        return this;
      }

      off(eventName, handler) {
        const handlers = this._eventHandlers[eventName];
        if (!handlers) {
          return this;
        }
        if (typeof handler === "function") {
          this._eventHandlers[eventName] = handlers.filter((h) => h !== handler);
        } else {
          this._eventHandlers[eventName] = [];
        }
        return this;
      }

      fire(eventName, data) {
        const handlers = this._eventHandlers[eventName];
        if (!handlers) {
          return this;
        }
        handlers.forEach((h) => {
          try {
            h(data);
          } catch {
            // Ignore handler errors.
          }
        });
        return this;
      }

      _open(mapCandidate, anchor = null) {
        if (!this._infoWindow) {
          return this;
        }
        const googleMap = resolveGoogleMapInstance(mapCandidate || this._map);
        if (!googleMap) {
          return this;
        }

        // Close previously active popup
        if (_activePopupInstance && _activePopupInstance !== this) {
          _activePopupInstance.remove();
        }
        _activePopupInstance = this;

        this._map = googleMap;
        this._anchor = anchor;

        this._styleInfoWindow();

        if (anchor) {
          this._syncInfoWindowContent();
          this._infoWindow.open({
            map: googleMap,
            anchor,
          });
        } else {
          if (this._position) {
            this._infoWindow.setPosition(this._position);
          }
          this._syncInfoWindowContent();
          this._infoWindow.open({
            map: googleMap,
          });
        }

        // closeOnClick: close when user clicks the map background
        if (this.options.closeOnClick !== false) {
          // Defer to avoid the current click also triggering this
          setTimeout(() => {
            this._mapClickListener = googleMap.addListener("click", () => {
              this.remove();
            });
          }, 0);
        }

        // Fire 'open' event for parity with Mapbox
        this.fire("open");

        return this;
      }

      addTo(mapCandidate) {
        return this._open(mapCandidate);
      }

      remove() {
        this._mapClickListener?.remove?.();
        this._mapClickListener = null;
        this._domReadyListener?.remove?.();
        this._domReadyListener = null;
        this._infoWindow?.close?.();
        if (_activePopupInstance === this) {
          _activePopupInstance = null;
        }
        this.fire("close");
        return this;
      }
    };
  }

  if (typeof mapboxgl.Marker !== "function") {
    mapboxgl.Marker = class Marker {
      constructor(options = {}) {
        const normalizedOptions =
          options && options.nodeType === 1 ? { element: options } : options;
        this.options = normalizedOptions || {};
        this._lngLat = null;
        this._map = null;
        this._marker = null;
        this._popup = null;
        this._popupClickListener = null;
      }

      setLngLat(value) {
        this._lngLat = toLngLat(value);
        if (this._marker && this._lngLat) {
          this._marker.setPosition(this._lngLat);
        }
        return this;
      }

      setPopup(popup) {
        this._popup = popup || null;
        if (this._marker) {
          this._bindPopupClick();
        }
        return this;
      }

      getPopup() {
        return this._popup;
      }

      _bindPopupClick() {
        if (!this._marker) {
          return;
        }
        this._popupClickListener?.remove?.();
        if (!this._popup || typeof this._marker.addListener !== "function") {
          this._popupClickListener = null;
          return;
        }
        this._popupClickListener = this._marker.addListener("click", () => {
          this._popup?._open?.(this._map, this._marker);
        });
      }

      addTo(mapCandidate) {
        const googleMap = resolveGoogleMapInstance(mapCandidate);
        if (!googleMap || typeof google.maps.Marker !== "function") {
          return this;
        }

        const markerOptions = {
          map: googleMap,
        };
        if (this._lngLat) {
          markerOptions.position = this._lngLat;
        }
        if (this.options?.title) {
          markerOptions.title = this.options.title;
        }
        if (this.options?.color) {
          markerOptions.icon = createMarkerIconFromColor(this.options.color);
        }

        this._map = googleMap;
        this._marker = new google.maps.Marker(markerOptions);
        this._bindPopupClick();
        return this;
      }

      setRotation(value) {
        const rotation = parseNumber(value);
        if (rotation === null || !this._marker) {
          return this;
        }
        const icon = this._marker.getIcon?.() || createMarkerIconFromColor();
        if (icon && typeof icon === "object") {
          this._marker.setIcon({
            ...icon,
            rotation,
          });
        }
        return this;
      }

      remove() {
        this._popupClickListener?.remove?.();
        this._popupClickListener = null;
        if (this._marker) {
          this._marker.setMap(null);
        }
        this._marker = null;
        this._map = null;
        return this;
      }
    };
  }

  const controlClass = class {
    onAdd() {
      return document.createElement("div");
    }

    onRemove() {}
  };

  if (typeof mapboxgl.NavigationControl !== "function") {
    mapboxgl.NavigationControl = controlClass;
  }
  if (typeof mapboxgl.AttributionControl !== "function") {
    mapboxgl.AttributionControl = controlClass;
  }
  if (typeof mapboxgl.FullscreenControl !== "function") {
    mapboxgl.FullscreenControl = controlClass;
  }
  if (typeof mapboxgl.GeolocateControl !== "function") {
    mapboxgl.GeolocateControl = controlClass;
  }
  if (typeof mapboxgl.ScaleControl !== "function") {
    mapboxgl.ScaleControl = controlClass;
  }
  if (typeof mapboxgl.supported !== "function") {
    mapboxgl.supported = () => true;
  }
  if (!Object.hasOwn(mapboxgl, "accessToken")) {
    mapboxgl.accessToken = "";
  }
  if (typeof mapboxgl.setTelemetryEnabled !== "function") {
    mapboxgl.setTelemetryEnabled = () => {};
  }

  globalThis.mapboxgl = mapboxgl;
};

const createGoogleMap = (containerElement, options = {}) => {
  const center = toLngLat(options.center || CONFIG.MAP.defaultCenter) || {
    lng: CONFIG.MAP.defaultCenter[0],
    lat: CONFIG.MAP.defaultCenter[1],
  };
  const zoom = parseNumber(options.zoom) ?? CONFIG.MAP.defaultZoom;
  const preferredTheme = getCurrentDocumentTheme();
  const mapTheme =
    preferredTheme === "light" && hasHardcodedLightMapId() ? "light" : "dark";
  const mapId = getHardcodedGoogleMapId(mapTheme);
  const mapOptions = {
    center: { lat: center.lat, lng: center.lng },
    zoom,
    disableDefaultUI: true,
    keyboardShortcuts: false,
    mapTypeId: "roadmap",
    backgroundColor: "#111113",
  };
  if (mapId) {
    mapOptions.mapId = mapId;
    mapOptions.colorScheme = getGoogleColorScheme(mapTheme);
  } else {
    mapOptions.styles = GOOGLE_DARK_STYLE;
  }

  const googleMap = new google.maps.Map(containerElement, mapOptions);

  const proxyMap = createMapProxy(googleMap, {
    usesCloudMapStyling: Boolean(mapId),
  });
  ensureMapboxCompatibility();
  return proxyMap;
};

const waitForGoogleMaps = (timeoutMs = 10000) => {
  if (typeof google !== "undefined" && google.maps) {
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let intervalId = null;
    let timeoutId = null;

    const checkReady = () => {
      if (typeof google !== "undefined" && typeof google.maps !== "undefined") {
        settled = true;
        clearTimeout(timeoutId);
        clearInterval(intervalId);
        resolve(true);
      }
    };

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(intervalId);
        reject(new Error("Google Maps JS not loaded"));
      }
    }, timeoutMs);

    intervalId = setInterval(checkReady, 50);
  });
};

const googleMapCore = {
  isReady() {
    return state.map !== null && state.mapInitialized === true;
  },

  getMap() {
    return state.map;
  },

  async initialize(options = {}) {
    try {
      loadingManager?.show("Initializing Google Maps...");

      const mapCanvas = utils.getElement("map-canvas");
      if (!mapCanvas) {
        throw new Error("Map container element not found");
      }

      await this._waitForGoogleMaps();

      if (state.map) {
        loadingManager?.hide();
        return true;
      }

      // Determine initial view (URL params > saved state > defaults)
      const initialView = this._getInitialView(options);

      if (mapCanvas.hasChildNodes()) {
        mapCanvas.innerHTML = "";
      }

      const proxyMap = createGoogleMap(mapCanvas, {
        center: initialView.center,
        zoom: initialView.zoom,
      });

      state.map = proxyMap;
      window.map = proxyMap;

      state.mapInitialized = true;
      state.metrics.mapLoadTime = Date.now() - state.metrics.loadStartTime;

      loadingManager?.hide();

      document.dispatchEvent(
        new CustomEvent("mapInitialized", {
          detail: { map: proxyMap },
        })
      );

      return true;
    } catch (error) {
      console.error("Google Maps initialization error:", error);
      loadingManager?.hide();
      notificationManager.show(`Map initialization failed: ${error.message}`, "danger");
      return false;
    }
  },

  _waitForGoogleMaps(timeoutMs = 10000) {
    return waitForGoogleMaps(timeoutMs);
  },

  _getInitialView(options) {
    const urlParams = new URLSearchParams(window.location.search);
    const latParam = parseFloat(urlParams.get("lat"));
    const lngParam = parseFloat(urlParams.get("lng"));
    const zoomParam = parseFloat(urlParams.get("zoom"));

    if (!Number.isNaN(latParam) && !Number.isNaN(lngParam)) {
      return {
        center: [lngParam, latParam],
        zoom: !Number.isNaN(zoomParam) ? zoomParam : CONFIG.MAP.defaultZoom,
      };
    }

    const savedView = utils.getStorage(CONFIG.STORAGE_KEYS.mapView);
    if (savedView?.center && savedView?.zoom) {
      return savedView;
    }

    return {
      center: options.center || CONFIG.MAP.defaultCenter,
      zoom: options.zoom || CONFIG.MAP.defaultZoom,
    };
  }
};

export {
  createMapProxy,
  createGoogleMap,
  ensureMapboxCompatibility,
  waitForGoogleMaps,
};
export default googleMapCore;
