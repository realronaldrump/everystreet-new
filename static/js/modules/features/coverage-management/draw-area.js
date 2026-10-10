/**
 * The Add Area form's drawing mode: a small map where the user outlines an
 * area, such as a neighborhood, to add as a custom coverage area.
 */

import apiClient from "../../core/api-client.js";
import { ensureLibraries } from "../../core/library-loader.js";
import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { createMap, isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";
import { buildDrawStyles } from "../../map-draw-styles.js";
import { isGoogleProvider } from "../map/map-style.js";

const MAP_CONTAINER_ID = "draw-area-map";
const US_CENTER = [-98.57, 39.82];
const EARTH_RADIUS_M = 6371008.8;
const SQ_METERS_PER_SQ_MILE = 2589988.110336;

const drawState = {
  map: null,
  draw: null,
  loading: null,
  onChange: null,
  // Bumped when the page leaves, so a map still loading is never created.
  generation: 0,
};

// =============================================================================
// Geometry
// =============================================================================

/** Area of a lon/lat ring on the sphere, in square meters. */
function ringAreaSqMeters(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    return 0;
  }
  const radians = (degrees) => (degrees * Math.PI) / 180;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    total +=
      (radians(lon2) - radians(lon1)) *
      (2 + Math.sin(radians(lat1)) + Math.sin(radians(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

function polygonAreaSqMeters(rings) {
  const [outer, ...holes] = rings || [];
  return holes.reduce(
    (area, hole) => area - ringAreaSqMeters(hole),
    ringAreaSqMeters(outer)
  );
}

/** Square miles inside a GeoJSON Polygon or MultiPolygon. */
export function boundaryAreaSqMiles(geometry) {
  if (geometry?.type === "Polygon") {
    return polygonAreaSqMeters(geometry.coordinates) / SQ_METERS_PER_SQ_MILE;
  }
  if (geometry?.type === "MultiPolygon") {
    return (
      geometry.coordinates.reduce(
        (area, rings) => area + polygonAreaSqMeters(rings),
        0
      ) / SQ_METERS_PER_SQ_MILE
    );
  }
  return 0;
}

/** One Polygon or MultiPolygon from the finished shapes on the drawing map. */
export function boundaryFromFeatures(features) {
  const polygons = (features || [])
    .filter(
      (feature) =>
        feature?.geometry?.type === "Polygon" &&
        feature.geometry.coordinates?.[0]?.length >= 4
    )
    .map((feature) => feature.geometry.coordinates);
  if (!polygons.length) {
    return null;
  }
  if (polygons.length === 1) {
    return { type: "Polygon", coordinates: polygons[0] };
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

export function formatSquareMiles(sqMiles) {
  if (sqMiles < 0.1) {
    return `${Math.round(sqMiles * 640)} acres`;
  }
  return `${sqMiles < 10 ? sqMiles.toFixed(2) : Math.round(sqMiles)} sq mi`;
}

// =============================================================================
// Map
// =============================================================================

export function getDrawnBoundary() {
  return boundaryFromFeatures(drawState.draw?.getAll()?.features);
}

function setStatus(message, tone = "neutral") {
  const status = document.getElementById("draw-area-status");
  if (!status) {
    return;
  }
  status.className = `validation-status mt-2 text-${tone === "neutral" ? "secondary" : tone}`;
  status.textContent = message;
}

function updateDrawStatus() {
  const boundary = getDrawnBoundary();
  if (boundary) {
    setStatus(
      `Outlined about ${formatSquareMiles(boundaryAreaSqMiles(boundary))}. Drag points to adjust, or start over.`,
      "success"
    );
  } else {
    setStatus(
      "Tap points around the area, then tap the first point again to close it."
    );
  }
  drawState.onChange?.();
}

async function createDrawMap(bounds) {
  const { generation } = drawState;
  await ensureLibraries(["map", "mapDraw"]);
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  const accessToken = isMapboxStyleUrl(styleUrl)
    ? await waitForMapboxToken({ timeoutMs: 5000 })
    : undefined;
  if (generation !== drawState.generation) {
    return;
  }

  const map = createMap(MAP_CONTAINER_ID, {
    style: styleUrl,
    accessToken,
    center: US_CENTER,
    zoom: 3,
    dragRotate: false,
    pitchWithRotate: false,
    navigationControl: { showCompass: false, position: "bottom-right" },
  });
  map.touchZoomRotate?.disableRotation();
  map.addControl(
    new globalThis.mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      fitBoundsOptions: { maxZoom: 15 },
    }),
    "bottom-right"
  );

  const draw = new globalThis.MapboxDraw({
    displayControlsDefault: false,
    controls: { polygon: true, trash: true },
    defaultMode: "draw_polygon",
    styles: buildDrawStyles(),
  });
  map.addControl(draw, "top-left");
  ["draw.create", "draw.update", "draw.delete"].forEach((event) => {
    map.on(event, updateDrawStatus);
  });
  map.on("load", () => {
    if (bounds) {
      map.fitBounds(bounds, { padding: 30, duration: 0 });
    }
    map.resize();
  });

  drawState.map = map;
  drawState.draw = draw;
}

/**
 * Show the drawing map, creating it the first time. ``bounds`` frames a
 * new map, as [[west, south], [east, north]].
 */
export async function openDrawMap({ bounds = null } = {}) {
  if (isGoogleProvider()) {
    setStatus(
      "Drawing areas needs the self-hosted map. Switch the map provider in Settings to draw one.",
      "warning"
    );
    document.getElementById(MAP_CONTAINER_ID)?.classList.add("d-none");
    return;
  }
  if (!drawState.map) {
    drawState.loading ??= createDrawMap(bounds).finally(() => {
      drawState.loading = null;
    });
    try {
      await drawState.loading;
    } catch (error) {
      setStatus(`Couldn't load the map: ${error.message}`, "danger");
      return;
    }
  }
  requestAnimationFrame(() => drawState.map?.resize());
  updateDrawStatus();
}

/** Clear the outline and wait for a new one. */
export function resetDrawnArea() {
  if (drawState.draw) {
    drawState.draw.deleteAll();
    drawState.draw.changeMode("draw_polygon");
  }
  updateDrawStatus();
}

async function goToPlace(query) {
  const text = query.trim();
  if (text.length < 2 || !drawState.map) {
    return;
  }
  try {
    const params = new URLSearchParams({ query: text, limit: "1" });
    const { results = [] } = await apiClient.get(`/api/search/geocode?${params}`);
    const [place] = results;
    if (!place) {
      setStatus(`Couldn't find “${text}”.`, "warning");
      return;
    }
    if (Array.isArray(place.bbox) && place.bbox.length === 4) {
      const [west, south, east, north] = place.bbox;
      drawState.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 30, maxZoom: 16 }
      );
    } else if (Array.isArray(place.center)) {
      drawState.map.flyTo({ center: place.center, zoom: 14 });
    }
  } catch (error) {
    setStatus(`Couldn't search for “${text}”: ${error.message}`, "danger");
  }
}

export function initDrawAreaUI({ signal, onChange } = {}) {
  const opt = signal ? { signal } : false;
  drawState.onChange = onChange;
  const gotoInput = document.getElementById("draw-area-goto-input");
  gotoInput?.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToPlace(gotoInput.value);
      }
    },
    opt
  );
  document
    .getElementById("draw-area-goto-btn")
    ?.addEventListener("click", () => goToPlace(gotoInput?.value || ""), opt);
  document
    .getElementById("draw-area-clear")
    ?.addEventListener("click", resetDrawnArea, opt);
}

export function destroyDrawMap() {
  drawState.generation += 1;
  drawState.map?.remove();
  drawState.map = null;
  drawState.draw = null;
  drawState.loading = null;
  drawState.onChange = null;
}
