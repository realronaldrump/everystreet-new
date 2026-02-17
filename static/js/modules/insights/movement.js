/**
 * Insights Movement Module
 * Renders most-driven street areas and route links with deck.gl.
 */

import { escapeHtml } from "../utils.js";

let movementDeck = null;
let activeLayerMode = "both";
let latestMovementPayload = null;

const MAX_SEGMENTS_IN_LIST = 12;

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
      tripCountEl.textContent = `Route detail ready for ${formatInt(profiled)} of ${formatInt(tripCount)} trips`;
    } else {
      tripCountEl.textContent = `Route detail ready for ${formatInt(profiled)} trips`;
    }
  }

  if (hexCountEl) {
    hexCountEl.textContent = `${pluralize(hexCount, "high-use area")} highlighted`;
  }

  if (syncStateEl) {
    if (pending > 0) {
      syncStateEl.textContent = `Background update running (${formatInt(pending)} trips remaining)`;
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
    .map((street) => {
      const name = escapeHtml(street.street_name || "Unnamed street");
      const traversals = pluralize(street.traversals, "pass");
      const distance = formatMiles(street.distance_miles);
      const cells = pluralize(street.cells, "area");
      return `
        <li class="movement-rank-item">
          <strong>${name}</strong>
          <span class="movement-rank-meta">${traversals} • ${distance} • ${cells}</span>
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
      const label = escapeHtml(segment.label || "Frequent route link");
      return `
        <li class="movement-rank-item">
          <strong>${label}</strong>
          <span class="movement-rank-meta">${traversals} • ${distance}</span>
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

function makeH3Layer(deckGlobal, hexCells) {
  const maxTraversals = Math.max(...hexCells.map((cell) => Number(cell.traversals || 0)), 1);
  const isLight = getCurrentTheme() === "light";
  return new deckGlobal.H3HexagonLayer({
    id: "movement-h3-layer",
    data: hexCells,
    getHexagon: (d) => d.hex,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
    getFillColor: (d) => {
      const traversals = Number(d.traversals || 0);
      const ratio = Math.min(1, traversals / maxTraversals);
      if (isLight) {
        return [
          Math.round(28 + ratio * 86),
          Math.round(126 + ratio * 68),
          Math.round(176 + ratio * 44),
          Math.round(52 + ratio * 130),
        ];
      }
      return [
        Math.round(30 + ratio * 92),
        Math.round(118 + ratio * 74),
        Math.round(190 + ratio * 38),
        Math.round(58 + ratio * 132),
      ];
    },
    updateTriggers: {
      getFillColor: [maxTraversals, isLight],
    },
  });
}

function makeSegmentLayer(deckGlobal, topSegments) {
  const maxTraversals = Math.max(
    ...topSegments.map((segment) => Number(segment.traversals || 0)),
    1
  );
  return new deckGlobal.LineLayer({
    id: "movement-segment-layer",
    data: topSegments,
    pickable: true,
    getSourcePosition: (d) => d.coordinates?.[0],
    getTargetPosition: (d) => d.coordinates?.[1],
    getWidth: (d) => {
      const ratio = Math.min(1, Number(d.traversals || 0) / maxTraversals);
      return 1.25 + ratio * 4.75;
    },
    widthUnits: "pixels",
    widthMinPixels: 1,
    widthMaxPixels: 8,
    getColor: (d) => {
      const ratio = Math.min(1, Number(d.traversals || 0) / maxTraversals);
      return [
        Math.round(246 - ratio * 18),
        Math.round(145 + ratio * 54),
        Math.round(72 + ratio * 18),
        Math.round(112 + ratio * 124),
      ];
    },
    parameters: {
      depthTest: false,
    },
    updateTriggers: {
      getWidth: [maxTraversals],
      getColor: [maxTraversals],
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

  const hexCells = Array.isArray(payload?.hex_cells) ? payload.hex_cells : [];
  const segments = Array.isArray(payload?.top_segments) ? payload.top_segments : [];

  const layers = [makeBaseTileLayer(deckGlobal)];
  if ((activeLayerMode === "both" || activeLayerMode === "cells") && hexCells.length) {
    layers.push(makeH3Layer(deckGlobal, hexCells));
  }
  if (
    (activeLayerMode === "both" || activeLayerMode === "segments") &&
    segments.length
  ) {
    layers.push(makeSegmentLayer(deckGlobal, segments));
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

export function bindMovementControls(signal) {
  const toggle = document.getElementById("movement-layer-toggle");
  if (!toggle) {
    return;
  }

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
  setLayerToggleState(activeLayerMode);
  updateSummaryPills(payload || {});
  renderTopStreets(payload || {});
  renderTopSegments(payload || {});

  const hasCells = Array.isArray(payload?.hex_cells) && payload.hex_cells.length > 0;
  const hasSegments =
    Array.isArray(payload?.top_segments) && payload.top_segments.length > 0;
  const hasData = hasCells || hasSegments;

  setEmptyState(!hasData);
  if (!hasData) {
    if (movementDeck) {
      movementDeck.setProps({ layers: [] });
    }
    return;
  }

  applyDeckLayers(payload);
}

export function destroyMovementInsights() {
  latestMovementPayload = null;
  if (movementDeck) {
    movementDeck.finalize();
    movementDeck = null;
  }
}
