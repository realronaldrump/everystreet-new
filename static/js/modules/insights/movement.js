/**
 * Insights Movement Module
 * Renders most-driven street areas and route links with deck.gl.
 */

import { escapeHtml } from "../utils.js";

let movementDeck = null;
let activeLayerMode = "both";
let latestMovementPayload = null;
let selectedStreetKey = "";
let selectedSegmentKey = "";
const hexPolygonCache = new Map();

const MAX_STREETS_IN_LIST = 14;
const MAX_SEGMENTS_IN_LIST = 12;

function normalizeStreetName(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function pluralize(value, unit) {
  const amount = Number(value || 0);
  return `${formatInt(amount)} ${unit}${amount === 1 ? "" : "s"}`;
}

function formatMiles(value) {
  const numeric = Number(value || 0);
  return `${numeric.toFixed(1)} mi`;
}

function formatInt(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric).toLocaleString() : "0";
}

function getCurrentTheme() {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.getAttribute("data-bs-theme") === "light"
    ? "light"
    : "dark";
}

function getMapboxToken() {
  if (typeof document === "undefined") {
    return "";
  }
  const tokenMeta = document.querySelector('meta[name="mapbox-access-token"]');
  return tokenMeta?.content?.trim() || "";
}

function getBasemapTileUrl() {
  const theme = getCurrentTheme();
  const token = getMapboxToken();
  if (token) {
    const styleId = theme === "light" ? "light-v11" : "dark-v11";
    return (
      `https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}@2x` +
      `?access_token=${encodeURIComponent(token)}`
    );
  }
  return theme === "light"
    ? "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
    : "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
}

function getTooltipStyle() {
  const isLight = getCurrentTheme() === "light";
  if (isLight) {
    return {
      backgroundColor: "rgba(255, 255, 255, 0.96)",
      color: "#102133",
      border: "1px solid rgba(14, 36, 56, 0.15)",
      borderRadius: "10px",
      fontSize: "12px",
      lineHeight: "1.4",
      padding: "8px 10px",
    };
  }
  return {
    backgroundColor: "rgba(9, 15, 24, 0.94)",
    color: "#dbe8f4",
    border: "1px solid rgba(111, 151, 188, 0.25)",
    borderRadius: "10px",
    fontSize: "12px",
    lineHeight: "1.4",
    padding: "8px 10px",
  };
}

function setLayerToggleState(mode) {
  const container = document.getElementById("movement-layer-toggle");
  if (!container) {
    return;
  }
  container.querySelectorAll("[data-movement-layer]").forEach((button) => {
    const isActive = button.dataset.movementLayer === mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function updateRankSelectionState() {
  const streetButtons = document.querySelectorAll(
    "#movement-top-streets .movement-rank-btn[data-street-key]"
  );
  streetButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.streetKey === selectedStreetKey);
  });

  const segmentButtons = document.querySelectorAll(
    "#movement-top-segments .movement-rank-btn[data-segment-key]"
  );
  segmentButtons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.segmentKey === selectedSegmentKey
    );
  });
}

function updateSummaryPills(payload) {
  const tripCountEl = document.getElementById("movement-trip-count");
  const hexCountEl = document.getElementById("movement-hex-count");
  const syncStateEl = document.getElementById("movement-sync-state");

  const tripCount = Number(payload?.trip_count || 0);
  const profiled = Number(payload?.profiled_trip_count || 0);
  const hexCount = Array.isArray(payload?.hex_cells) ? payload.hex_cells.length : 0;
  const synced = Number(payload?.synced_trips_this_request || 0);
  const pending = Number(payload?.pending_trip_sync_count || 0);

  if (tripCountEl) {
    if (tripCount <= 0) {
      tripCountEl.textContent = "No trips in this range yet";
    } else if (profiled < tripCount) {
      tripCountEl.textContent = `Route detail ready for ${formatInt(profiled)} of ${formatInt(
        tripCount
      )} trips`;
    } else {
      tripCountEl.textContent = `Route detail ready for ${formatInt(profiled)} trips`;
    }
  }

  if (hexCountEl) {
    hexCountEl.textContent = `${pluralize(hexCount, "high-use area")} highlighted`;
  }

  if (syncStateEl) {
    if (pending > 0) {
      syncStateEl.textContent = `Background update running (${formatInt(
        pending
      )} trips remaining)`;
    } else if (synced > 0) {
      syncStateEl.textContent = `Updated with ${pluralize(synced, "new trip")} this load`;
    } else {
      syncStateEl.textContent = "Auto-updating (up to date)";
    }
  }
}

function renderTopStreets(payload) {
  const list = document.getElementById("movement-top-streets");
  if (!list) {
    return;
  }
  const streets = Array.isArray(payload?.top_streets) ? payload.top_streets : [];
  if (!streets.length) {
    list.innerHTML = '<li class="story-empty">No street names are available for this range yet.</li>';
    return;
  }

  list.innerHTML = streets
    .slice(0, MAX_STREETS_IN_LIST)
    .map((street) => {
      const name = String(street.street_name || "Unnamed street");
      const normalized = normalizeStreetName(name);
      const traversals = pluralize(street.traversals, "pass");
      const distance = formatMiles(street.distance_miles);
      const cells = pluralize(street.cells, "area");
      return `
        <li class="movement-rank-item">
          <button
            type="button"
            class="movement-rank-btn"
            data-street-key="${escapeHtml(normalized)}"
            title="Focus ${escapeHtml(name)} on map"
          >
            <strong>${escapeHtml(name)}</strong>
            <span class="movement-rank-meta">${traversals} • ${distance} • ${cells}</span>
          </button>
        </li>
      `;
    })
    .join("");
}

function renderTopSegments(payload) {
  const list = document.getElementById("movement-top-segments");
  if (!list) {
    return;
  }
  const segments = Array.isArray(payload?.top_segments) ? payload.top_segments : [];
  if (!segments.length) {
    list.innerHTML = '<li class="story-empty">No repeated road links in this range yet.</li>';
    return;
  }

  list.innerHTML = segments
    .slice(0, MAX_SEGMENTS_IN_LIST)
    .map((segment) => {
      const traversals = pluralize(segment.traversals, "pass");
      const distance = formatMiles(segment.distance_miles);
      const label = String(segment.label || "Frequent route link");
      const segmentKey = String(segment.segment_key || "");
      return `
        <li class="movement-rank-item">
          <button
            type="button"
            class="movement-rank-btn"
            data-segment-key="${escapeHtml(segmentKey)}"
            title="Focus ${escapeHtml(label)} on map"
          >
            <strong>${escapeHtml(label)}</strong>
            <span class="movement-rank-meta">${traversals} • ${distance}</span>
          </button>
        </li>
      `;
    })
    .join("");
}

function makeBaseTileLayer(deckGlobal) {
  const basemapUrl = getBasemapTileUrl();
  const theme = getCurrentTheme();
  return new deckGlobal.TileLayer({
    id: `movement-base-${theme}`,
    data: basemapUrl,
    minZoom: 0,
    maxZoom: 20,
    tileSize: 256,
    renderSubLayers: (props) => {
      const {
        bbox: { west, south, east, north },
      } = props.tile;
      return new deckGlobal.BitmapLayer(props, {
        id: `movement-base-bitmap-${props.tile.index.x}-${props.tile.index.y}-${props.tile.index.z}`,
        data: null,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });
}

function getCellCenter(hexId) {
  if (typeof window === "undefined") {
    return null;
  }
  const h3 = window.h3;
  if (!h3) {
    return null;
  }

  try {
    if (typeof h3.cellToLatLng === "function") {
      const [lat, lon] = h3.cellToLatLng(hexId);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
    }
    if (typeof h3.cellToLatlng === "function") {
      const [lat, lon] = h3.cellToLatlng(hexId);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeLngLatPair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) {
    return null;
  }
  const a = Number(pair[0]);
  const b = Number(pair[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }

  // Most H3 APIs return [lat, lng]. Some variants may already be [lng, lat].
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    return [b, a];
  }
  if (Math.abs(a) <= 180 && Math.abs(b) <= 90) {
    return [a, b];
  }
  return null;
}

function getCellPolygon(hexId) {
  const key = String(hexId || "");
  if (!key) {
    return null;
  }

  if (hexPolygonCache.has(key)) {
    return hexPolygonCache.get(key) || null;
  }

  if (typeof window === "undefined" || !window.h3) {
    return null;
  }
  const h3 = window.h3;

  let boundary = null;
  try {
    if (typeof h3.cellToBoundary === "function") {
      boundary = h3.cellToBoundary(key);
    } else if (typeof h3.h3ToGeoBoundary === "function") {
      boundary = h3.h3ToGeoBoundary(key, false);
    }
  } catch {
    boundary = null;
  }

  if (!Array.isArray(boundary) || !boundary.length) {
    return null;
  }

  const polygon = boundary
    .map((pair) => normalizeLngLatPair(pair))
    .filter((pair) => Array.isArray(pair));

  if (polygon.length < 3) {
    return null;
  }

  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (!last || last[0] !== first[0] || last[1] !== first[1]) {
    polygon.push([first[0], first[1]]);
  }

  hexPolygonCache.set(key, polygon);
  return polygon;
}

function makeH3Layer(
  deckGlobal,
  hexCells,
  { idSuffix = "base", alphaScale = 1, selected = false } = {}
) {
  const polygonData = hexCells
    .map((cell) => {
      const polygon = getCellPolygon(cell.hex);
      return polygon ? { ...cell, polygon } : null;
    })
    .filter((cell) => Boolean(cell?.polygon));

  if (!polygonData.length) {
    return null;
  }

  const maxTraversals = Math.max(
    ...polygonData.map((cell) => Number(cell.traversals || 0)),
    1
  );
  const isLight = getCurrentTheme() === "light";

  return new deckGlobal.PolygonLayer({
    id: `movement-h3-layer-${idSuffix}`,
    data: polygonData,
    getPolygon: (d) => d.polygon,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
    getFillColor: (d) => {
      const traversals = Number(d.traversals || 0);
      const ratio = Math.min(1, traversals / maxTraversals);
      const alpha = Math.round((selected ? 220 : 180) * alphaScale);
      if (isLight) {
        return selected
          ? [26, 138, 210, alpha]
          : [
              Math.round(30 + ratio * 78),
              Math.round(126 + ratio * 62),
              Math.round(172 + ratio * 40),
              alpha,
            ];
      }
      return selected
        ? [44, 188, 242, alpha]
        : [
            Math.round(34 + ratio * 86),
            Math.round(118 + ratio * 68),
            Math.round(190 + ratio * 36),
            alpha,
          ];
    },
    updateTriggers: {
      getFillColor: [maxTraversals, isLight, alphaScale, selected],
    },
  });
}

function makeSegmentLayer(
  deckGlobal,
  topSegments,
  { idSuffix = "base", alphaScale = 1, widthScale = 1, selected = false } = {}
) {
  const maxTraversals = Math.max(
    ...topSegments.map((segment) => Number(segment.traversals || 0)),
    1
  );
  return new deckGlobal.LineLayer({
    id: `movement-segment-layer-${idSuffix}`,
    data: topSegments,
    pickable: true,
    getSourcePosition: (d) => d.coordinates?.[0],
    getTargetPosition: (d) => d.coordinates?.[1],
    getWidth: (d) => {
      const ratio = Math.min(1, Number(d.traversals || 0) / maxTraversals);
      return (selected ? 2.8 : 1.2 + ratio * 4.4) * widthScale;
    },
    widthUnits: "pixels",
    widthMinPixels: selected ? 2 : 1,
    widthMaxPixels: selected ? 10 : 8,
    getColor: (d) => {
      const ratio = Math.min(1, Number(d.traversals || 0) / maxTraversals);
      const alpha = Math.round((selected ? 244 : 220) * alphaScale);
      if (selected) {
        return [247, 182, 66, alpha];
      }
      return [
        Math.round(246 - ratio * 18),
        Math.round(145 + ratio * 54),
        Math.round(72 + ratio * 18),
        alpha,
      ];
    },
    parameters: {
      depthTest: false,
    },
    updateTriggers: {
      getWidth: [maxTraversals, widthScale, selected],
      getColor: [maxTraversals, alphaScale, selected],
    },
  });
}

function getTooltip(info) {
  const object = info?.object;
  if (!object) {
    return null;
  }

  if (object.hex) {
    const streetName = escapeHtml(object.street_name || "Street area");
    return {
      html: `
        <div>
          <strong>${streetName}</strong><br />
          ${pluralize(object.traversals, "pass")}<br />
          ${formatMiles(object.distance_miles)}
        </div>
      `,
      style: getTooltipStyle(),
    };
  }

  if (object.segment_key) {
    const label = escapeHtml(object.label || "Frequent route link");
    return {
      html: `
        <div>
          <strong>${label}</strong><br />
          ${pluralize(object.traversals, "pass")}<br />
          ${formatMiles(object.distance_miles)}
        </div>
      `,
      style: getTooltipStyle(),
    };
  }

  return null;
}

function getSelectionData(payload) {
  const allHexCells = Array.isArray(payload?.hex_cells) ? payload.hex_cells : [];
  const allSegments = Array.isArray(payload?.top_segments) ? payload.top_segments : [];

  if (selectedSegmentKey) {
    const matched = allSegments.filter(
      (segment) => String(segment.segment_key || "") === selectedSegmentKey
    );
    const hexIds = new Set();
    matched.forEach((segment) => {
      if (segment.h3_a) {
        hexIds.add(String(segment.h3_a));
      }
      if (segment.h3_b) {
        hexIds.add(String(segment.h3_b));
      }
    });
    const selectedHexCells = allHexCells.filter((cell) => hexIds.has(String(cell.hex || "")));
    return {
      allHexCells,
      allSegments,
      selectedHexCells,
      selectedSegments: matched,
    };
  }

  if (selectedStreetKey) {
    const selectedHexCells = allHexCells.filter(
      (cell) => normalizeStreetName(cell.street_name) === selectedStreetKey
    );
    const selectedSegments = allSegments.filter((segment) => {
      const a = normalizeStreetName(segment.street_a);
      const b = normalizeStreetName(segment.street_b);
      const label = normalizeStreetName(segment.label);
      return (
        a === selectedStreetKey ||
        b === selectedStreetKey ||
        (label && label.includes(selectedStreetKey))
      );
    });
    return {
      allHexCells,
      allSegments,
      selectedHexCells,
      selectedSegments,
    };
  }

  return {
    allHexCells,
    allSegments,
    selectedHexCells: [],
    selectedSegments: [],
  };
}

function applyDeckLayers(payload) {
  if (typeof window === "undefined") {
    return;
  }
  const deckGlobal = window.deck;
  if (!deckGlobal) {
    return;
  }

  const mapContainer = document.getElementById("movement-map");
  if (!mapContainer) {
    return;
  }

  const { allHexCells, allSegments, selectedHexCells, selectedSegments } =
    getSelectionData(payload);
  const hasSelection = selectedHexCells.length > 0 || selectedSegments.length > 0;

  const layers = [makeBaseTileLayer(deckGlobal)];
  const showCells = activeLayerMode === "both" || activeLayerMode === "cells";
  const showSegments = activeLayerMode === "both" || activeLayerMode === "segments";

  if (showCells && allHexCells.length) {
    if (hasSelection) {
      const contextLayer = makeH3Layer(deckGlobal, allHexCells, {
        idSuffix: "context",
        alphaScale: 0.2,
        selected: false,
      });
      if (contextLayer) {
        layers.push(contextLayer);
      }
      if (selectedHexCells.length) {
        const selectedLayer = makeH3Layer(deckGlobal, selectedHexCells, {
          idSuffix: "selected",
          alphaScale: 1,
          selected: true,
        });
        if (selectedLayer) {
          layers.push(selectedLayer);
        }
      }
    } else {
      const baseLayer = makeH3Layer(deckGlobal, allHexCells, {
        idSuffix: "base",
        alphaScale: 1,
        selected: false,
      });
      if (baseLayer) {
        layers.push(baseLayer);
      }
    }
  }

  if (showSegments && allSegments.length) {
    if (hasSelection) {
      layers.push(
        makeSegmentLayer(deckGlobal, allSegments, {
          idSuffix: "context",
          alphaScale: 0.2,
          widthScale: 0.9,
          selected: false,
        })
      );
      if (selectedSegments.length) {
        layers.push(
          makeSegmentLayer(deckGlobal, selectedSegments, {
            idSuffix: "selected",
            alphaScale: 1,
            widthScale: 1.2,
            selected: true,
          })
        );
      }
    } else {
      layers.push(
        makeSegmentLayer(deckGlobal, allSegments, {
          idSuffix: "base",
          alphaScale: 1,
          widthScale: 1,
          selected: false,
        })
      );
    }
  }

  const center = payload?.map_center || {};
  const initialViewState = {
    longitude: Number(center.lon) || -95.7,
    latitude: Number(center.lat) || 37.09,
    zoom: Number(center.zoom) || 10.5,
    pitch: 0,
    bearing: 0,
  };

  if (!movementDeck) {
    movementDeck = new deckGlobal.Deck({
      parent: mapContainer,
      controller: true,
      initialViewState,
      views: new deckGlobal.MapView({ repeat: true }),
      getTooltip,
      layers,
      onClick: ({ object }) => {
        if (!object) {
          return;
        }
        if (object.segment_key) {
          selectedSegmentKey = String(object.segment_key || "");
          selectedStreetKey = "";
        } else if (object.hex && object.street_name) {
          selectedStreetKey = normalizeStreetName(object.street_name);
          selectedSegmentKey = "";
        } else {
          return;
        }
        updateRankSelectionState();
        applyDeckLayers(latestMovementPayload || {});
        focusSelectionOnMap(latestMovementPayload || {});
      },
    });
    return;
  }

  movementDeck.setProps({
    layers,
    getTooltip,
  });
}

function setEmptyState(isEmpty) {
  const empty = document.getElementById("movement-map-empty");
  if (!empty) {
    return;
  }
  empty.classList.toggle("is-hidden", !isEmpty);
}

function collectSelectionPoints(payload) {
  const { selectedHexCells, selectedSegments } = getSelectionData(payload);
  const points = [];

  selectedSegments.forEach((segment) => {
    if (Array.isArray(segment.coordinates?.[0])) {
      points.push(segment.coordinates[0]);
    }
    if (Array.isArray(segment.coordinates?.[1])) {
      points.push(segment.coordinates[1]);
    }
  });

  selectedHexCells.forEach((cell) => {
    const center = getCellCenter(String(cell.hex || ""));
    if (center) {
      points.push(center);
    }
  });

  return points.filter(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
  );
}

function focusSelectionOnMap(payload) {
  if (!movementDeck || !payload) {
    return;
  }
  const points = collectSelectionPoints(payload);
  if (!points.length) {
    return;
  }

  const container = document.getElementById("movement-map");
  if (!container) {
    return;
  }
  const deckGlobal = window.deck;
  const lons = points.map((point) => Number(point[0]));
  const lats = points.map((point) => Number(point[1]));
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);

  if (points.length === 1 || (west === east && south === north)) {
    movementDeck.setProps({
      initialViewState: {
        longitude: lons[0],
        latitude: lats[0],
        zoom: 14,
        pitch: 0,
        bearing: 0,
        transitionDuration: 650,
      },
    });
    return;
  }

  try {
    if (deckGlobal?.WebMercatorViewport) {
      const viewport = new deckGlobal.WebMercatorViewport({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
      });
      const fitted = viewport.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 56 }
      );
      movementDeck.setProps({
        initialViewState: {
          longitude: fitted.longitude,
          latitude: fitted.latitude,
          zoom: Math.min(15.5, fitted.zoom),
          pitch: 0,
          bearing: 0,
          transitionDuration: 650,
        },
      });
    }
  } catch {
    // Keep current view if fit-bounds fails.
  }
}

function clearSelectionIfMissing(payload) {
  const streets = Array.isArray(payload?.top_streets) ? payload.top_streets : [];
  const segments = Array.isArray(payload?.top_segments) ? payload.top_segments : [];

  if (
    selectedStreetKey &&
    !streets.some(
      (street) => normalizeStreetName(street.street_name) === selectedStreetKey
    )
  ) {
    selectedStreetKey = "";
  }

  if (
    selectedSegmentKey &&
    !segments.some(
      (segment) => String(segment.segment_key || "") === selectedSegmentKey
    )
  ) {
    selectedSegmentKey = "";
  }
}

function handleStreetRankClick(event) {
  const button = event.target.closest(".movement-rank-btn[data-street-key]");
  if (!button) {
    return;
  }
  const key = button.dataset.streetKey || "";
  if (!key) {
    return;
  }
  selectedStreetKey = selectedStreetKey === key ? "" : key;
  selectedSegmentKey = "";
  updateRankSelectionState();
  if (latestMovementPayload) {
    applyDeckLayers(latestMovementPayload);
    focusSelectionOnMap(latestMovementPayload);
  }
}

function handleSegmentRankClick(event) {
  const button = event.target.closest(".movement-rank-btn[data-segment-key]");
  if (!button) {
    return;
  }
  const key = button.dataset.segmentKey || "";
  if (!key) {
    return;
  }
  selectedSegmentKey = selectedSegmentKey === key ? "" : key;
  selectedStreetKey = "";
  updateRankSelectionState();
  if (latestMovementPayload) {
    applyDeckLayers(latestMovementPayload);
    focusSelectionOnMap(latestMovementPayload);
  }
}

export function bindMovementControls(signal) {
  const toggle = document.getElementById("movement-layer-toggle");
  if (toggle) {
    toggle.querySelectorAll("[data-movement-layer]").forEach((button) => {
      button.addEventListener(
        "click",
        (event) => {
          const layerMode = event.currentTarget?.dataset?.movementLayer;
          if (!layerMode || layerMode === activeLayerMode) {
            return;
          }
          activeLayerMode = layerMode;
          setLayerToggleState(activeLayerMode);
          if (latestMovementPayload) {
            applyDeckLayers(latestMovementPayload);
          }
        },
        signal ? { signal } : false
      );
    });
  }

  const streetsList = document.getElementById("movement-top-streets");
  if (streetsList) {
    streetsList.addEventListener(
      "click",
      handleStreetRankClick,
      signal ? { signal } : false
    );
  }

  const segmentsList = document.getElementById("movement-top-segments");
  if (segmentsList) {
    segmentsList.addEventListener(
      "click",
      handleSegmentRankClick,
      signal ? { signal } : false
    );
  }

  document.addEventListener(
    "themeChanged",
    () => {
      if (latestMovementPayload) {
        applyDeckLayers(latestMovementPayload);
      }
    },
    signal ? { signal } : false
  );
}

export function renderMovementInsights(payload) {
  latestMovementPayload = payload || null;
  clearSelectionIfMissing(payload || {});
  setLayerToggleState(activeLayerMode);
  updateSummaryPills(payload || {});
  renderTopStreets(payload || {});
  renderTopSegments(payload || {});
  updateRankSelectionState();

  const hasCells = Array.isArray(payload?.hex_cells) && payload.hex_cells.length > 0;
  const hasSegments =
    Array.isArray(payload?.top_segments) && payload.top_segments.length > 0;
  const hasData = hasCells || hasSegments;

  setEmptyState(!hasData);
  if (!hasData) {
    selectedStreetKey = "";
    selectedSegmentKey = "";
    if (movementDeck) {
      movementDeck.setProps({ layers: [] });
    }
    return;
  }

  applyDeckLayers(payload);
}

export function destroyMovementInsights() {
  latestMovementPayload = null;
  selectedStreetKey = "";
  selectedSegmentKey = "";
  if (movementDeck) {
    movementDeck.finalize();
    movementDeck = null;
  }
}
