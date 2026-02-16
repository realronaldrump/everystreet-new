/**
 * Insights Movement Module
 * Renders H3 street/segment movement visuals via deck.gl.
 */

import { escapeHtml } from "../utils.js";

let movementDeck = null;
let activeLayerMode = "both";
let latestMovementPayload = null;

function formatMiles(value) {
  const numeric = Number(value || 0);
  return `${numeric.toFixed(1)} mi`;
}

function formatInt(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric).toLocaleString() : "0";
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

  if (tripCountEl) {
    const tripCount = Number(payload?.trip_count || 0);
    const profiled = Number(payload?.profiled_trip_count || 0);
    tripCountEl.textContent = `${formatInt(profiled)}/${formatInt(tripCount)} trips analyzed`;
  }

  if (hexCountEl) {
    const hexCount = Array.isArray(payload?.hex_cells) ? payload.hex_cells.length : 0;
    hexCountEl.textContent = `${formatInt(hexCount)} active H3 cells`;
  }

  if (syncStateEl) {
    const synced = Number(payload?.synced_trips_this_request || 0);
    const pending = Number(payload?.pending_trip_sync_count || 0);
    if (pending > 0) {
      syncStateEl.textContent = `Auto-sync: +${formatInt(synced)} this load, ${formatInt(pending)} pending`;
    } else {
      syncStateEl.textContent = synced > 0 ? `Auto-sync: +${formatInt(synced)} this load` : "Auto-sync active";
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
    list.innerHTML = '<li class="story-empty">No streets resolved yet for this range.</li>';
    return;
  }

  list.innerHTML = streets
    .map((street) => {
      const name = escapeHtml(street.street_name || "Unknown street");
      const traversals = formatInt(street.traversals);
      const distance = formatMiles(street.distance_miles);
      const cells = formatInt(street.cells);
      return `
        <li class="movement-rank-item">
          <strong>${name}</strong>
          <span class="movement-rank-meta">${traversals} traversals • ${distance} • ${cells} cells</span>
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
    list.innerHTML = '<li class="story-empty">No segment traversals in this range yet.</li>';
    return;
  }

  list.innerHTML = segments
    .slice(0, 20)
    .map((segment, index) => {
      const traversals = formatInt(segment.traversals);
      const distance = formatMiles(segment.distance_miles);
      const id = escapeHtml(segment.segment_key || `segment-${index + 1}`);
      return `
        <li class="movement-rank-item">
          <strong>#${index + 1} ${id}</strong>
          <span class="movement-rank-meta">${traversals} traversals • ${distance}</span>
        </li>
      `;
    })
    .join("");
}

function makeBaseTileLayer(deckGlobal) {
  return new deckGlobal.TileLayer({
    id: "movement-osm-base",
    data: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props) => {
      const {
        bbox: { west, south, east, north },
      } = props.tile;
      return new deckGlobal.BitmapLayer(props, {
        id: `movement-osm-${props.tile.index.x}-${props.tile.index.y}-${props.tile.index.z}`,
        data: null,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });
}

function makeH3Layer(deckGlobal, hexCells) {
  const maxTraversals = Math.max(...hexCells.map((cell) => Number(cell.traversals || 0)), 1);
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
      return [
        Math.round(50 + ratio * 190),
        Math.round(140 + ratio * 90),
        Math.round(210 - ratio * 100),
        Math.round(70 + ratio * 140),
      ];
    },
    updateTriggers: {
      getFillColor: [maxTraversals],
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
      return 1 + ratio * 4.5;
    },
    widthUnits: "pixels",
    widthMinPixels: 1,
    widthMaxPixels: 8,
    getColor: (d) => {
      const ratio = Math.min(1, Number(d.traversals || 0) / maxTraversals);
      return [
        Math.round(255 - ratio * 40),
        Math.round(130 + ratio * 60),
        Math.round(80 + ratio * 30),
        Math.round(110 + ratio * 120),
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
    return {
      html: `
        <div>
          <strong>H3 Cell</strong><br />
          ${escapeHtml(object.hex)}<br />
          ${formatInt(object.traversals)} traversals<br />
          ${formatMiles(object.distance_miles)}
        </div>
      `,
    };
  }

  if (object.segment_key) {
    return {
      html: `
        <div>
          <strong>Segment</strong><br />
          ${escapeHtml(object.segment_key)}<br />
          ${formatInt(object.traversals)} traversals<br />
          ${formatMiles(object.distance_miles)}
        </div>
      `,
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
  if (activeLayerMode === "both" || activeLayerMode === "cells") {
    if (hexCells.length) {
      layers.push(makeH3Layer(deckGlobal, hexCells));
    }
  }
  if (activeLayerMode === "both" || activeLayerMode === "segments") {
    if (segments.length) {
      layers.push(makeSegmentLayer(deckGlobal, segments));
    }
  }

  const center = payload?.map_center || {};
  const initialViewState = {
    longitude: Number(center.lon) || -95.7,
    latitude: Number(center.lat) || 37.09,
    zoom: Number(center.zoom) || 10.5,
    pitch: 30,
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

