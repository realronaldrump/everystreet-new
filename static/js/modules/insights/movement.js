/**
 * Insights Movement Module
 * Renders matched-geometry street and segment paths with deck.gl.
 */

import { escapeHtml } from "../utils.js";

let movementDeck = null;
let activePanel = "streets";
let latestMovementPayload = null;
let selectedEntity = null;
let hoveredEntity = null;

const INITIAL_VISIBLE_COUNT = 10;
const VIEW_MORE_STEP = 10;
const DEFAULT_VIEW_STATE = {
  longitude: -95.7,
  latitude: 37.09,
  zoom: 10.5,
  pitch: 0,
  bearing: 0,
};
const visibleCounts = {
  streets: INITIAL_VISIBLE_COUNT,
  segments: INITIAL_VISIBLE_COUNT,
};

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatInt(value) {
  return Math.round(asNumber(value)).toLocaleString();
}

function pluralize(value, unit) {
  const amount = asNumber(value);
  return `${formatInt(amount)} ${unit}${amount === 1 ? "" : "s"}`;
}

function formatMiles(value) {
  return `${asNumber(value).toFixed(1)} mi`;
}

function normalizeStreetKey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resetVisibleCounts() {
  visibleCounts.streets = INITIAL_VISIBLE_COUNT;
  visibleCounts.segments = INITIAL_VISIBLE_COUNT;
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

function isValidPoint(point) {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(Number(point[0])) &&
    Number.isFinite(Number(point[1])) &&
    Math.abs(Number(point[0])) <= 180 &&
    Math.abs(Number(point[1])) <= 90
  );
}

function normalizePath(path) {
  if (!Array.isArray(path)) {
    return [];
  }
  const cleaned = [];
  path.forEach((point) => {
    if (!isValidPoint(point)) {
      return;
    }
    const normalized = [Number(point[0]), Number(point[1])];
    if (!cleaned.length || cleaned[cleaned.length - 1][0] !== normalized[0] || cleaned[cleaned.length - 1][1] !== normalized[1]) {
      cleaned.push(normalized);
    }
  });
  return cleaned.length >= 2 ? cleaned : [];
}

function getStreetKey(item) {
  return normalizeStreetKey(item?.street_key || item?.street_name);
}

function getSegmentKey(item) {
  return String(item?.segment_key || "").trim();
}

function getModeItems(payload, mode) {
  if (mode === "segments") {
    return Array.isArray(payload?.top_segments) ? payload.top_segments : [];
  }
  return Array.isArray(payload?.top_streets) ? payload.top_streets : [];
}

function getEntityKey(item, mode) {
  return mode === "segments" ? getSegmentKey(item) : getStreetKey(item);
}

function getEntityLabel(item, mode) {
  if (mode === "segments") {
    return String(item?.label || "Street segment");
  }
  return String(item?.street_name || "Unnamed street");
}

function getTimesDriven(item) {
  return asNumber(item?.times_driven || item?.traversals);
}

function getEntityBySelection(payload, selection) {
  if (!selection || !selection.key || !selection.type) {
    return null;
  }
  const items = getModeItems(payload, selection.type);
  return (
    items.find((item) => getEntityKey(item, selection.type) === selection.key) || null
  );
}

function setLayerToggleState(mode) {
  const toggle = document.getElementById("movement-layer-toggle");
  if (!toggle) {
    return;
  }

  toggle.querySelectorAll("[data-movement-layer]").forEach((button) => {
    const isActive = button.dataset.movementLayer === mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  document.querySelectorAll(".movement-rank-card[data-rank-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.rankPanel === mode);
  });
}

function updateRankSelectionState() {
  const streetButtons = document.querySelectorAll(
    "#movement-top-streets .movement-rank-btn[data-street-key]"
  );
  streetButtons.forEach((button) => {
    const key = button.dataset.streetKey || "";
    const isSelected = selectedEntity?.type === "streets" && selectedEntity?.key === key;
    const isHovered = hoveredEntity?.type === "streets" && hoveredEntity?.key === key;
    button.classList.toggle("is-active", Boolean(isSelected));
    button.classList.toggle("is-hover", Boolean(isHovered));
  });

  const segmentButtons = document.querySelectorAll(
    "#movement-top-segments .movement-rank-btn[data-segment-key]"
  );
  segmentButtons.forEach((button) => {
    const key = button.dataset.segmentKey || "";
    const isSelected = selectedEntity?.type === "segments" && selectedEntity?.key === key;
    const isHovered = hoveredEntity?.type === "segments" && hoveredEntity?.key === key;
    button.classList.toggle("is-active", Boolean(isSelected));
    button.classList.toggle("is-hover", Boolean(isHovered));
  });
}

function updateSummaryPills(payload) {
  const tripCountEl = document.getElementById("movement-trip-count");
  const featureCountEl = document.getElementById("movement-feature-count");
  const syncStateEl = document.getElementById("movement-sync-state");

  const analyzed = asNumber(payload?.analyzed_trip_count || payload?.profiled_trip_count);
  const totalTrips = asNumber(payload?.trip_count);
  const streets = getModeItems(payload, "streets").length;
  const segments = getModeItems(payload, "segments").length;
  const warnings = Array.isArray(payload?.validation?.warnings)
    ? payload.validation.warnings.length
    : 0;
  const synced = asNumber(payload?.synced_trips_this_request);
  const pending = asNumber(payload?.pending_trip_sync_count);

  if (tripCountEl) {
    if (analyzed <= 0) {
      if (totalTrips > 0) {
        tripCountEl.textContent = `${formatInt(totalTrips)} matched trips found, no movement geometry ready yet`;
      } else {
        tripCountEl.textContent = "No matched trips in this range";
      }
    } else {
      tripCountEl.textContent = `Analyzed ${pluralize(analyzed, "matched trip")}`;
    }
  }

  if (featureCountEl) {
    featureCountEl.textContent = `${formatInt(streets)} streets + ${formatInt(segments)} segments shown`;
  }

  if (syncStateEl) {
    if (pending > 0) {
      syncStateEl.textContent = `Sync in progress (${formatInt(pending)} trips remaining)`;
    } else if (synced > 0) {
      syncStateEl.textContent = `Updated with ${pluralize(synced, "trip")}`;
    } else if (warnings > 0) {
      syncStateEl.textContent = `${pluralize(warnings, "geometry warning")}`;
    } else {
      syncStateEl.textContent = "Matched trip geometry only";
    }
  }
}

function updateMovementCaption(payload) {
  const caption = document.getElementById("movement-map-caption");
  if (!caption) {
    return;
  }

  const geometrySource = String(payload?.analysis_scope?.geometry_source || "matchedGps");
  if (geometrySource === "matchedGps") {
    caption.textContent =
      "Showing matched trip street geometry. Line thickness reflects times driven. Hover to preview and click to lock details.";
    return;
  }

  caption.textContent =
    "Showing street geometry from your trips. Line thickness reflects times driven.";
}

function renderDetailPanel(payload) {
  const panel = document.getElementById("movement-detail-panel");
  if (!panel) {
    return;
  }

  const selected = getEntityBySelection(payload, selectedEntity);
  if (!selected) {
    panel.innerHTML =
      '<div class="movement-detail-empty">Select a street or segment to see times driven, trips, and distance.</div>';
    return;
  }

  const mode = selectedEntity?.type === "segments" ? "segments" : "streets";
  const label = getEntityLabel(selected, mode);
  const timesDriven = pluralize(getTimesDriven(selected), "time driven");
  const trips = pluralize(selected?.trip_count, "trip");
  const distance = formatMiles(selected?.distance_miles);
  const typeLabel = mode === "segments" ? "Street segment" : "Street";

  panel.innerHTML = `
    <div class="movement-detail-content">
      <p class="movement-detail-label">${escapeHtml(typeLabel)}</p>
      <h4 class="movement-detail-title">${escapeHtml(label)}</h4>
      <div class="movement-detail-stats">
        <div>
          <span>Times driven</span>
          <strong>${escapeHtml(timesDriven)}</strong>
        </div>
        <div>
          <span>Trips</span>
          <strong>${escapeHtml(trips)}</strong>
        </div>
        <div>
          <span>Distance driven</span>
          <strong>${escapeHtml(distance)}</strong>
        </div>
      </div>
    </div>
  `;
}

function renderRankingList(mode, payload) {
  const listId = mode === "segments" ? "movement-top-segments" : "movement-top-streets";
  const list = document.getElementById(listId);
  if (!list) {
    return;
  }

  const moreButtonId =
    mode === "segments" ? "movement-segments-more" : "movement-streets-more";
  const moreButton = document.getElementById(moreButtonId);
  const items = getModeItems(payload, mode);
  const visible = Math.min(visibleCounts[mode], items.length);

  if (!items.length) {
    list.innerHTML =
      mode === "segments"
        ? '<li class="story-empty">No ranked street segments for this range yet.</li>'
        : '<li class="story-empty">No ranked streets for this range yet.</li>';
    if (moreButton) {
      moreButton.hidden = true;
      moreButton.disabled = true;
    }
    return;
  }

  const keyAttr = mode === "segments" ? "data-segment-key" : "data-street-key";
  const keyName = mode === "segments" ? "segment" : "street";

  list.innerHTML = items
    .slice(0, visible)
    .map((item) => {
      const key = getEntityKey(item, mode);
      const label = getEntityLabel(item, mode);
      const timesDriven = pluralize(getTimesDriven(item), "time driven");
      const trips = pluralize(item?.trip_count, "trip");
      const distance = formatMiles(item?.distance_miles);
      return `
        <li class="movement-rank-item">
          <button
            type="button"
            class="movement-rank-btn"
            ${keyAttr}="${escapeHtml(key)}"
            title="Highlight ${escapeHtml(label)} on map"
          >
            <strong>${escapeHtml(label)}</strong>
            <span class="movement-rank-meta">${escapeHtml(
              `${timesDriven} • ${trips} • ${distance}`
            )}</span>
          </button>
        </li>
      `;
    })
    .join("");

  if (moreButton) {
    const canGrow = visible < items.length;
    moreButton.hidden = !canGrow;
    moreButton.disabled = !canGrow;
    if (canGrow) {
      moreButton.textContent =
        mode === "segments"
          ? `View ${Math.min(VIEW_MORE_STEP, items.length - visible)} more segments`
          : `View ${Math.min(VIEW_MORE_STEP, items.length - visible)} more streets`;
    }
  }

  updateRankSelectionState();
}

function setEmptyState(isEmpty) {
  const empty = document.getElementById("movement-map-empty");
  if (!empty) {
    return;
  }
  empty.classList.toggle("is-hidden", !isEmpty);
}

function flattenEntityPaths(payload, mode) {
  const items = getModeItems(payload, mode);
  const features = [];

  items.forEach((item) => {
    const key = getEntityKey(item, mode);
    const label = getEntityLabel(item, mode);
    const timesDriven = getTimesDriven(item);
    const tripCount = asNumber(item?.trip_count);
    const distanceMiles = asNumber(item?.distance_miles);
    const paths = Array.isArray(item?.paths) ? item.paths : [];

    paths.forEach((path, pathIndex) => {
      const normalizedPath = normalizePath(path);
      if (normalizedPath.length < 2) {
        return;
      }
      features.push({
        id: `${mode}-${key}-${pathIndex}`,
        entityType: mode,
        entityKey: key,
        label,
        timesDriven,
        tripCount,
        distanceMiles,
        path: normalizedPath,
      });
    });
  });

  return features;
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

function makePathLayer(
  deckGlobal,
  id,
  features,
  {
    mode,
    alpha = 220,
    widthScale = 1,
    minPixels = 1,
    maxPixels = 9,
    selected = false,
    hovered = false,
  } = {}
) {
  const maxTimesDriven = Math.max(...features.map((feature) => feature.timesDriven), 1);

  return new deckGlobal.PathLayer({
    id,
    data: features,
    pickable: true,
    capRounded: true,
    jointRounded: true,
    widthUnits: "pixels",
    widthMinPixels: minPixels,
    widthMaxPixels: maxPixels,
    getPath: (d) => d.path,
    getWidth: (d) => {
      const ratio = Math.min(1, d.timesDriven / maxTimesDriven);
      const base = mode === "segments" ? 1.6 : 1.8;
      const extra = mode === "segments" ? 4.4 : 5.0;
      const selectedBoost = selected ? 2.8 : hovered ? 1.6 : 1;
      return (base + ratio * extra) * widthScale * selectedBoost;
    },
    getColor: (d) => {
      const ratio = Math.min(1, d.timesDriven / maxTimesDriven);
      if (selected) {
        return mode === "segments" ? [255, 184, 71, 248] : [66, 210, 246, 248];
      }
      if (hovered) {
        return mode === "segments" ? [245, 162, 60, 240] : [48, 176, 236, 240];
      }
      if (mode === "segments") {
        return [
          Math.round(233 + ratio * 16),
          Math.round(122 + ratio * 48),
          Math.round(60 + ratio * 22),
          alpha,
        ];
      }
      return [
        Math.round(40 + ratio * 40),
        Math.round(124 + ratio * 70),
        Math.round(178 + ratio * 44),
        alpha,
      ];
    },
    parameters: {
      depthTest: false,
    },
    updateTriggers: {
      getWidth: [mode, maxTimesDriven, widthScale, selected, hovered],
      getColor: [mode, maxTimesDriven, alpha, selected, hovered],
    },
  });
}

function getTooltip(info) {
  const object = info?.object;
  if (!object) {
    return null;
  }

  return {
    html: `
      <div>
        <strong>${escapeHtml(object.label || "Street")}</strong><br />
        ${escapeHtml(pluralize(object.timesDriven, "time driven"))}<br />
        ${escapeHtml(pluralize(object.tripCount, "trip"))}<br />
        ${escapeHtml(formatMiles(object.distanceMiles))}
      </div>
    `,
    style: getTooltipStyle(),
  };
}

function selectionExists(payload, selection) {
  return Boolean(getEntityBySelection(payload, selection));
}

function clearSelectionIfMissing(payload) {
  if (selectedEntity && !selectionExists(payload, selectedEntity)) {
    selectedEntity = null;
  }
  if (hoveredEntity && !selectionExists(payload, hoveredEntity)) {
    hoveredEntity = null;
  }
}

function collectPointsForSelection(payload, selection) {
  const entity = getEntityBySelection(payload, selection);
  if (!entity || !Array.isArray(entity.paths)) {
    return [];
  }

  return entity.paths
    .flatMap((path) => normalizePath(path))
    .filter((point) => isValidPoint(point));
}

function collectPointsForMode(payload, mode) {
  return flattenEntityPaths(payload, mode)
    .flatMap((feature) => feature.path)
    .filter((point) => isValidPoint(point));
}

function fitMapToPoints(points) {
  if (!movementDeck || !Array.isArray(points) || points.length < 1) {
    return;
  }

  const container = document.getElementById("movement-map");
  if (!container) {
    return;
  }

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
    if (window.deck?.WebMercatorViewport) {
      const viewport = new window.deck.WebMercatorViewport({
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
          zoom: Math.min(16, fitted.zoom),
          pitch: 0,
          bearing: 0,
          transitionDuration: 650,
        },
      });
    }
  } catch {
    // Keep existing view if fit fails.
  }
}

function focusSelectionOnMap(payload) {
  if (!selectedEntity) {
    return;
  }
  const points = collectPointsForSelection(payload, selectedEntity);
  if (points.length) {
    fitMapToPoints(points);
  }
}

function focusModeOnMap(payload) {
  const points = collectPointsForMode(payload, activePanel);
  if (points.length) {
    fitMapToPoints(points);
  }
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

  const features = flattenEntityPaths(payload, activePanel);
  const layers = [makeBaseTileLayer(deckGlobal)];
  const hasData = features.length > 0;
  setEmptyState(!hasData);

  const selectedKey = selectedEntity?.type === activePanel ? selectedEntity.key : "";
  const hoveredKey = hoveredEntity?.type === activePanel ? hoveredEntity.key : "";

  if (hasData) {
    const selectedFeatures = selectedKey
      ? features.filter((feature) => feature.entityKey === selectedKey)
      : [];
    const hoveredFeatures = hoveredKey
      ? features.filter((feature) => feature.entityKey === hoveredKey)
      : [];

    if (selectedFeatures.length || hoveredFeatures.length) {
      layers.push(
        makePathLayer(deckGlobal, `movement-${activePanel}-context`, features, {
          mode: activePanel,
          alpha: 62,
          widthScale: 0.9,
          minPixels: 1,
          maxPixels: 6,
        })
      );

      if (hoveredFeatures.length && hoveredKey !== selectedKey) {
        layers.push(
          makePathLayer(deckGlobal, `movement-${activePanel}-hover`, hoveredFeatures, {
            mode: activePanel,
            alpha: 236,
            widthScale: 1.2,
            minPixels: 2,
            maxPixels: 10,
            hovered: true,
          })
        );
      }

      if (selectedFeatures.length) {
        layers.push(
          makePathLayer(deckGlobal, `movement-${activePanel}-selected`, selectedFeatures, {
            mode: activePanel,
            alpha: 246,
            widthScale: 1.35,
            minPixels: 2,
            maxPixels: 12,
            selected: true,
          })
        );
      }
    } else {
      layers.push(
        makePathLayer(deckGlobal, `movement-${activePanel}-base`, features, {
          mode: activePanel,
          alpha: 220,
          widthScale: 1,
          minPixels: 1,
          maxPixels: 10,
        })
      );
    }
  }

  const center = payload?.map_center || {};
  const initialViewState = {
    ...DEFAULT_VIEW_STATE,
    longitude: Number(center.lon) || DEFAULT_VIEW_STATE.longitude,
    latitude: Number(center.lat) || DEFAULT_VIEW_STATE.latitude,
    zoom: Number(center.zoom) || DEFAULT_VIEW_STATE.zoom,
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
          selectedEntity = null;
          hoveredEntity = null;
          updateRankSelectionState();
          renderDetailPanel(latestMovementPayload || {});
          applyDeckLayers(latestMovementPayload || {});
          return;
        }
        selectedEntity = {
          type: object.entityType,
          key: object.entityKey,
        };
        hoveredEntity = null;
        updateRankSelectionState();
        renderDetailPanel(latestMovementPayload || {});
        applyDeckLayers(latestMovementPayload || {});
        focusSelectionOnMap(latestMovementPayload || {});
      },
      onHover: ({ object }) => {
        const nextHovered = object
          ? {
              type: object.entityType,
              key: object.entityKey,
            }
          : null;
        const didChange =
          (nextHovered?.type || "") !== (hoveredEntity?.type || "") ||
          (nextHovered?.key || "") !== (hoveredEntity?.key || "");
        if (!didChange) {
          return;
        }
        hoveredEntity = nextHovered;
        updateRankSelectionState();
        applyDeckLayers(latestMovementPayload || {});
      },
    });
    return;
  }

  movementDeck.setProps({
    layers,
    getTooltip,
  });
}

function setSelection(type, key) {
  if (!key) {
    return;
  }
  if (selectedEntity?.type === type && selectedEntity?.key === key) {
    selectedEntity = null;
    return;
  }
  selectedEntity = { type, key };
}

function handleRankClick(event, type) {
  const selector =
    type === "segments"
      ? ".movement-rank-btn[data-segment-key]"
      : ".movement-rank-btn[data-street-key]";
  const button = event.target.closest(selector);
  if (!button) {
    return;
  }

  const key =
    type === "segments"
      ? String(button.dataset.segmentKey || "")
      : String(button.dataset.streetKey || "");
  if (!key) {
    return;
  }

  setSelection(type, key);
  hoveredEntity = null;
  updateRankSelectionState();
  renderDetailPanel(latestMovementPayload || {});
  if (latestMovementPayload) {
    applyDeckLayers(latestMovementPayload);
    focusSelectionOnMap(latestMovementPayload);
  }
}

function handleRankHover(event, type, entering) {
  const selector =
    type === "segments"
      ? ".movement-rank-btn[data-segment-key]"
      : ".movement-rank-btn[data-street-key]";
  const button = event.target.closest(selector);
  if (!button) {
    return;
  }

  if (!entering) {
    hoveredEntity = null;
    updateRankSelectionState();
    if (latestMovementPayload) {
      applyDeckLayers(latestMovementPayload);
    }
    return;
  }

  const key =
    type === "segments"
      ? String(button.dataset.segmentKey || "")
      : String(button.dataset.streetKey || "");
  if (!key) {
    return;
  }

  hoveredEntity = { type, key };
  updateRankSelectionState();
  if (latestMovementPayload) {
    applyDeckLayers(latestMovementPayload);
  }
}

function bindViewMoreButtons(signal) {
  const streetMore = document.getElementById("movement-streets-more");
  if (streetMore) {
    streetMore.addEventListener(
      "click",
      () => {
        visibleCounts.streets += VIEW_MORE_STEP;
        renderRankingList("streets", latestMovementPayload || {});
      },
      signal ? { signal } : false
    );
  }

  const segmentMore = document.getElementById("movement-segments-more");
  if (segmentMore) {
    segmentMore.addEventListener(
      "click",
      () => {
        visibleCounts.segments += VIEW_MORE_STEP;
        renderRankingList("segments", latestMovementPayload || {});
      },
      signal ? { signal } : false
    );
  }
}

export function bindMovementControls(signal) {
  const toggle = document.getElementById("movement-layer-toggle");
  if (toggle) {
    toggle.querySelectorAll("[data-movement-layer]").forEach((button) => {
      button.addEventListener(
        "click",
        (event) => {
          const nextMode = event.currentTarget?.dataset?.movementLayer;
          if (!nextMode || nextMode === activePanel) {
            return;
          }
          activePanel = nextMode;
          hoveredEntity = null;
          if (selectedEntity?.type !== activePanel) {
            selectedEntity = null;
          }
          setLayerToggleState(activePanel);
          updateRankSelectionState();
          renderDetailPanel(latestMovementPayload || {});
          if (latestMovementPayload) {
            applyDeckLayers(latestMovementPayload);
            if (selectedEntity) {
              focusSelectionOnMap(latestMovementPayload);
            } else {
              focusModeOnMap(latestMovementPayload);
            }
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
      (event) => handleRankClick(event, "streets"),
      signal ? { signal } : false
    );
    streetsList.addEventListener(
      "mouseover",
      (event) => handleRankHover(event, "streets", true),
      signal ? { signal } : false
    );
    streetsList.addEventListener(
      "mouseout",
      (event) => handleRankHover(event, "streets", false),
      signal ? { signal } : false
    );
  }

  const segmentsList = document.getElementById("movement-top-segments");
  if (segmentsList) {
    segmentsList.addEventListener(
      "click",
      (event) => handleRankClick(event, "segments"),
      signal ? { signal } : false
    );
    segmentsList.addEventListener(
      "mouseover",
      (event) => handleRankHover(event, "segments", true),
      signal ? { signal } : false
    );
    segmentsList.addEventListener(
      "mouseout",
      (event) => handleRankHover(event, "segments", false),
      signal ? { signal } : false
    );
  }

  bindViewMoreButtons(signal);

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
  latestMovementPayload = payload || {};
  resetVisibleCounts();
  clearSelectionIfMissing(latestMovementPayload);

  setLayerToggleState(activePanel);
  updateSummaryPills(latestMovementPayload);
  updateMovementCaption(latestMovementPayload);

  renderRankingList("streets", latestMovementPayload);
  renderRankingList("segments", latestMovementPayload);
  updateRankSelectionState();
  renderDetailPanel(latestMovementPayload);

  const hasStreetFeatures = flattenEntityPaths(latestMovementPayload, "streets").length > 0;
  const hasSegmentFeatures =
    flattenEntityPaths(latestMovementPayload, "segments").length > 0;
  const hasAnyData = hasStreetFeatures || hasSegmentFeatures;

  setEmptyState(!hasAnyData);
  if (!hasAnyData) {
    selectedEntity = null;
    hoveredEntity = null;
    if (movementDeck) {
      movementDeck.setProps({ layers: [] });
    }
    return;
  }

  applyDeckLayers(latestMovementPayload);
  if (selectedEntity) {
    focusSelectionOnMap(latestMovementPayload);
  } else {
    focusModeOnMap(latestMovementPayload);
  }
}

export function destroyMovementInsights() {
  latestMovementPayload = null;
  selectedEntity = null;
  hoveredEntity = null;
  resetVisibleCounts();
  if (movementDeck) {
    movementDeck.finalize();
    movementDeck = null;
  }
}
