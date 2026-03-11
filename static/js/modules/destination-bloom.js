import store from "./core/store.js";

const LAYER_SEARCH_ORDER = ["trips", "matchedTrips"];
const MAX_BLOOM_RADIUS = 34;
const MIN_BLOOM_RADIUS = 9;
const FADE_IN_MS = 420;
const FADE_OUT_MS = 260;
const TOOLTIP_OFFSET_X = 14;
const TOOLTIP_OFFSET_Y = 16;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function emitDocumentEvent(type, detail = null) {
  if (
    typeof document?.dispatchEvent === "function" &&
    typeof CustomEvent === "function"
  ) {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function clearTripInteractionState(map = store.map) {
  store.selectedTripId = null;
  store.selectedTripLayer = null;

  if (map?.getLayer?.("selected-trip-layer")) {
    map.removeLayer?.("selected-trip-layer");
  }
  if (map?.getSource?.("selected-trip-source")) {
    map.removeSource?.("selected-trip-source");
  }

  if (typeof document?.querySelectorAll !== "function") {
    return;
  }

  document.querySelectorAll(".trip-popup-content").forEach((content) => {
    content.closest?.(".mapboxgl-popup")?.remove?.();
    content.closest?.(".maplibregl-popup")?.remove?.();
  });
}

function formatDestinationLabel(value) {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? value.formatted_address ||
          value.formattedAddress ||
          value.name ||
          value.address ||
          value.label
        : "";

  const normalized = String(candidate || "").trim();
  if (
    !normalized ||
    ["unknown", "n/a", "na", "null", "undefined"].includes(normalized.toLowerCase())
  ) {
    return "";
  }
  return normalized;
}

function parseArrivalTime(value) {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function getDestinationPointFromGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const last = geometry.coordinates.at(-1);
    if (Array.isArray(last) && last.length >= 2) {
      return [Number(last[0]), Number(last[1])];
    }
    return null;
  }

  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    for (let i = geometry.coordinates.length - 1; i >= 0; i -= 1) {
      const line = geometry.coordinates[i];
      if (!Array.isArray(line) || line.length === 0) {
        continue;
      }
      const last = line.at(-1);
      if (Array.isArray(last) && last.length >= 2) {
        return [Number(last[0]), Number(last[1])];
      }
    }
  }

  return null;
}

function getFeatureTripId(feature) {
  const rawId =
    feature?.properties?.transactionId ||
    feature?.properties?.tripId ||
    feature?.properties?.id ||
    feature?.id ||
    "";
  const normalized = String(rawId || "").trim();
  return normalized || null;
}

export function extractDestinationPoint(feature, { layerName = "" } = {}) {
  const coords = getDestinationPointFromGeometry(feature?.geometry);
  if (
    !coords ||
    coords.length < 2 ||
    !Number.isFinite(coords[0]) ||
    !Number.isFinite(coords[1])
  ) {
    return null;
  }

  const label = formatDestinationLabel(feature?.properties?.destination);
  const lastArrival = parseArrivalTime(feature?.properties?.endTime);

  return {
    id: getFeatureTripId(feature),
    coordinates: coords,
    label,
    lastArrival,
    layerName,
  };
}

export function collectDestinationPoints(mapLayers = {}) {
  const pointsById = new Map();
  const anonymousPoints = [];

  LAYER_SEARCH_ORDER.forEach((layerName) => {
    const layerInfo = mapLayers?.[layerName];
    const features = Array.isArray(layerInfo?.layer?.features)
      ? layerInfo.layer.features
      : [];
    if (!layerInfo?.visible || features.length === 0) {
      return;
    }

    features.forEach((feature) => {
      const point = extractDestinationPoint(feature, { layerName });
      if (!point) {
        return;
      }
      if (point.id) {
        pointsById.set(point.id, point);
      } else {
        anonymousPoints.push(point);
      }
    });
  });

  return [...pointsById.values(), ...anonymousPoints];
}

export function clusterCellSize(zoom = 12) {
  return clamp(74 - zoom * 3.2, 24, 64);
}

export function radiusForCluster(count, zoom = 12) {
  const radius =
    8 + Math.sqrt(Math.max(count, 1)) * 2.4 + Math.max(0, 12 - zoom) * 0.4;
  return clamp(radius, MIN_BLOOM_RADIUS, MAX_BLOOM_RADIUS);
}

function gridKey(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function collectNeighborIndices(point, points, grid, cellSize, neighborRadiusSq) {
  const gx = Math.floor(point.x / cellSize);
  const gy = Math.floor(point.y / cellSize);
  const result = [];

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = grid.get(`${gx + dx}:${gy + dy}`) || [];
      bucket.forEach((candidateIdx) => {
        const candidate = points[candidateIdx];
        const diffX = candidate.x - point.x;
        const diffY = candidate.y - point.y;
        if (diffX * diffX + diffY * diffY <= neighborRadiusSq) {
          result.push(candidateIdx);
        }
      });
    }
  }

  return result;
}

function createFallbackLabel(lng, lat) {
  return `Area near ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

export function clusterDestinationPoints(points, { zoom = 12 } = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const cellSize = clusterCellSize(zoom);
  const neighborRadiusSq = Math.pow(cellSize * 0.9, 2);
  const grid = new Map();

  points.forEach((point, idx) => {
    const key = gridKey(point.x, point.y, cellSize);
    const bucket = grid.get(key) || [];
    bucket.push(idx);
    grid.set(key, bucket);
  });

  const visited = new Array(points.length).fill(false);
  const clusters = [];

  for (let i = 0; i < points.length; i += 1) {
    if (visited[i]) {
      continue;
    }

    const queue = [i];
    const members = [];
    visited[i] = true;

    while (queue.length > 0) {
      const idx = queue.shift();
      members.push(points[idx]);
      const neighbors = collectNeighborIndices(
        points[idx],
        points,
        grid,
        cellSize,
        neighborRadiusSq
      );
      neighbors.forEach((neighborIdx) => {
        if (visited[neighborIdx]) {
          return;
        }
        visited[neighborIdx] = true;
        queue.push(neighborIdx);
      });
    }

    const labelCounts = new Map();
    let sumX = 0;
    let sumY = 0;
    let sumLng = 0;
    let sumLat = 0;
    let lastArrival = null;

    members.forEach((member) => {
      sumX += member.x;
      sumY += member.y;
      sumLng += member.coordinates[0];
      sumLat += member.coordinates[1];
      if (member.label) {
        labelCounts.set(member.label, (labelCounts.get(member.label) || 0) + 1);
      }
      if (member.lastArrival && (!lastArrival || member.lastArrival > lastArrival)) {
        lastArrival = member.lastArrival;
      }
    });

    const x = sumX / members.length;
    const y = sumY / members.length;
    const lng = sumLng / members.length;
    const lat = sumLat / members.length;

    const label =
      [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
      createFallbackLabel(lng, lat);
    const radius = radiusForCluster(members.length, zoom);

    clusters.push({
      id: `${members.length}:${Math.round(x)}:${Math.round(y)}`,
      count: members.length,
      x,
      y,
      coordinates: [lng, lat],
      label,
      lastArrival,
      share: members.length / points.length,
      radius,
      phase: ((lng + 180) * 0.09 + (lat + 90) * 0.13) % (Math.PI * 2),
    });
  }

  return clusters.sort((a, b) => a.count - b.count);
}

function createTooltipSection(text, className = "") {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

function getMapViewportRect(map) {
  const canvas = map?.getCanvas?.();
  const container = map?.getCanvasContainer?.();
  return (
    canvas?.getBoundingClientRect?.() ||
    container?.getBoundingClientRect?.() ||
    null
  );
}

const destinationBloom = {
  _active: false,
  _destroyed: false,
  _canvas: null,
  _ctx: null,
  _tooltip: null,
  _emptyNotice: null,
  _animFrame: null,
  _fading: null,
  _fadeStart: 0,
  _opacity: 0,
  _points: [],
  _clusters: [],
  _pixelRatio: 1,
  _prevHiddenLayers: null,
  _mapMoveHandler: null,
  _mapZoomHandler: null,
  _mapResizeHandler: null,
  _deactivationTimer: null,
  _pointerMoveHandler: null,
  _pointerLeaveHandler: null,
  _pointerClickHandler: null,
  _touchStartHandler: null,
  _touchEndHandler: null,
  _hoveredClusterId: null,
  _pinnedClusterId: null,
  _lastPointer: null,

  isActive() {
    return this._active;
  },

  toggle() {
    if (this._active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this._active;
  },

  activate() {
    if (this._active) {
      return;
    }

    const map = store.map;
    if (!map) {
      return;
    }

    this._active = true;
    this._destroyed = false;
    if (this._deactivationTimer) {
      clearTimeout(this._deactivationTimer);
      this._deactivationTimer = null;
    }
    this._createCanvas(map);
    this._createTooltip(map);
    this._bindMapEvents(map);
    this._bindPointerEvents(map);
    clearTripInteractionState(map);
    this.refresh();

    if (this._prefersReducedMotion()) {
      this._opacity = 1;
      this._fading = null;
      this._render(performance.now());
    } else {
      this._opacity = 0;
      this._fading = "in";
      this._fadeStart = performance.now();
      this._startLoop();
    }

    emitDocumentEvent("destinationBloom:activated");
  },

  deactivate() {
    if (!this._active) {
      return;
    }

    if (this._prefersReducedMotion()) {
      this._finalizeDeactivate();
      return;
    }

    this._active = false;
    this._fading = "out";
    this._fadeStart = performance.now();
    emitDocumentEvent("destinationBloom:deactivated");
    this._deactivationTimer = setTimeout(() => {
      this._deactivationTimer = null;
      if (this._destroyed) {
        return;
      }
      this._finalizeDeactivate();
    }, FADE_OUT_MS + 40);
  },

  destroy() {
    const wasActive = this._active;
    this._destroyed = true;
    this._active = false;
    if (this._deactivationTimer) {
      clearTimeout(this._deactivationTimer);
      this._deactivationTimer = null;
    }
    this._finalizeDeactivate();
    if (wasActive) {
      emitDocumentEvent("destinationBloom:deactivated");
    }
  },

  refresh() {
    if (!this._active || !store.map) {
      return;
    }

    this._collectPoints();
    this._resizeCanvas();
    this._reprojectAndCluster();
    this._hideTripLayers(store.map);
    this._updateEmptyNotice();
    this._updateCanvasBlendMode();

    if (this._prefersReducedMotion()) {
      this._render(performance.now());
    }
  },

  ensureTripLayersHidden() {
    if (!this._active) {
      return;
    }
    this._hideTripLayers(store.map);
  },

  _collectPoints() {
    this._points = collectDestinationPoints(store.mapLayers);
  },

  _createCanvas(map) {
    if (this._canvas) {
      return;
    }

    const container = map.getCanvasContainer?.();
    if (!container) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "destination-bloom-canvas";
    canvas.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:10;";
    container.appendChild(canvas);

    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
  },

  _createTooltip(map) {
    if (this._tooltip) {
      return;
    }

    const container = map.getCanvasContainer?.();
    if (!container) {
      return;
    }

    const tooltip = document.createElement("div");
    tooltip.className = "destination-bloom-tooltip";
    tooltip.setAttribute("aria-hidden", "true");
    container.appendChild(tooltip);
    this._tooltip = tooltip;
  },

  _removeCanvas() {
    this._canvas?.remove?.();
    this._canvas = null;
    this._ctx = null;
  },

  _removeTooltip() {
    this._tooltip?.remove?.();
    this._tooltip = null;
  },

  _resizeCanvas() {
    const mapCanvas = store.map?.getCanvas?.();
    const container = store.map?.getCanvasContainer?.();
    if (!this._canvas || (!mapCanvas && !container)) {
      return;
    }

    const rect =
      mapCanvas?.getBoundingClientRect?.() ||
      container?.getBoundingClientRect?.() ||
      null;
    const width = Math.max(
      1,
      Math.round(rect?.width || mapCanvas?.clientWidth || container?.clientWidth || 1)
    );
    const height = Math.max(
      1,
      Math.round(rect?.height || mapCanvas?.clientHeight || container?.clientHeight || 1)
    );
    const pixelWidth = Math.max(
      1,
      Math.round(mapCanvas?.width || width * Math.max(globalThis.devicePixelRatio || 1, 1))
    );
    const pixelHeight = Math.max(
      1,
      Math.round(
        mapCanvas?.height || height * Math.max(globalThis.devicePixelRatio || 1, 1)
      )
    );

    this._pixelRatio = Math.max(pixelWidth / width, 1);
    this._canvas.width = pixelWidth;
    this._canvas.height = pixelHeight;
    this._canvas.style.width = `${width}px`;
    this._canvas.style.height = `${height}px`;
  },

  _reprojectAndCluster() {
    const map = store.map;
    if (!map) {
      this._clusters = [];
      return;
    }

    const projectedPoints = this._points
      .map((point) => {
        const projected = map.project?.(point.coordinates);
        const x = Number(projected?.x);
        const y = Number(projected?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        return {
          ...point,
          x,
          y,
        };
      })
      .filter(Boolean);

    this._clusters = clusterDestinationPoints(projectedPoints, {
      zoom: Number(map.getZoom?.()) || 12,
    });

    this._syncTooltipToActiveCluster();
  },

  _bindMapEvents(map) {
    this._mapMoveHandler = () => this._reprojectAndCluster();
    this._mapZoomHandler = () => this._reprojectAndCluster();
    this._mapResizeHandler = () => {
      this._resizeCanvas();
      this._reprojectAndCluster();
    };

    map.on?.("move", this._mapMoveHandler);
    map.on?.("zoom", this._mapZoomHandler);
    map.on?.("resize", this._mapResizeHandler);
  },

  _unbindMapEvents() {
    const map = store.map;
    if (!map) {
      return;
    }

    if (this._mapMoveHandler) {
      map.off?.("move", this._mapMoveHandler);
    }
    if (this._mapZoomHandler) {
      map.off?.("zoom", this._mapZoomHandler);
    }
    if (this._mapResizeHandler) {
      map.off?.("resize", this._mapResizeHandler);
    }

    this._mapMoveHandler = null;
    this._mapZoomHandler = null;
    this._mapResizeHandler = null;
  },

  _bindPointerEvents(map) {
    const container = map.getCanvasContainer?.();
    if (!container) {
      return;
    }

    this._pointerMoveHandler = (event) => {
      if (!this._active || this._pinnedClusterId) {
        return;
      }
      const pointer = this._getPointerPosition(event);
      if (!pointer) {
        return;
      }
      this._lastPointer = pointer;
      const cluster = this._findClusterAtPoint(pointer.x, pointer.y);
      this._hoveredClusterId = cluster?.id || null;
      this._updateCursor(cluster);
      this._updateTooltip(cluster, pointer);
    };

    this._pointerLeaveHandler = () => {
      if (this._pinnedClusterId) {
        return;
      }
      this._hoveredClusterId = null;
      this._updateCursor(null);
      this._hideTooltip();
    };

    this._pointerClickHandler = (event) => {
      if (!this._active) {
        return;
      }
      const pointer = this._getPointerPosition(event);
      if (!pointer) {
        return;
      }

      this._lastPointer = pointer;
      const cluster = this._findClusterAtPoint(pointer.x, pointer.y);
      if (!cluster) {
        this._pinnedClusterId = null;
        this._hoveredClusterId = null;
        this._hideTooltip();
        return;
      }

      this._pinnedClusterId =
        this._pinnedClusterId === cluster.id ? null : cluster.id;
      this._hoveredClusterId = cluster.id;
      this._updateTooltip(cluster, pointer);
    };

    container.addEventListener("pointermove", this._pointerMoveHandler, { passive: true });
    container.addEventListener("pointerleave", this._pointerLeaveHandler);
    container.addEventListener("click", this._pointerClickHandler);

    this._touchStartHandler = (event) => {
      if (!this._active || event.touches.length !== 1) return;
      this._lastTouchStart = performance.now();
    };
    this._touchEndHandler = (event) => {
      if (!this._active) return;
      const elapsed = performance.now() - (this._lastTouchStart || 0);
      if (elapsed > 400) return;
      const pointer = this._getPointerPosition(event);
      if (!pointer) return;
      this._lastPointer = pointer;
      const cluster = this._findClusterAtPoint(pointer.x, pointer.y);
      if (!cluster) {
        this._pinnedClusterId = null;
        this._hoveredClusterId = null;
        this._hideTooltip();
        return;
      }
      this._pinnedClusterId =
        this._pinnedClusterId === cluster.id ? null : cluster.id;
      this._hoveredClusterId = cluster.id;
      this._updateTooltip(cluster, pointer);
    };
    container.addEventListener("touchstart", this._touchStartHandler, { passive: true });
    container.addEventListener("touchend", this._touchEndHandler);
  },

  _unbindPointerEvents() {
    const container = store.map?.getCanvasContainer?.();
    if (!container) {
      return;
    }

    if (this._pointerMoveHandler) {
      container.removeEventListener("pointermove", this._pointerMoveHandler);
    }
    if (this._pointerLeaveHandler) {
      container.removeEventListener("pointerleave", this._pointerLeaveHandler);
    }
    if (this._pointerClickHandler) {
      container.removeEventListener("click", this._pointerClickHandler);
    }
    if (this._touchStartHandler) {
      container.removeEventListener("touchstart", this._touchStartHandler);
    }
    if (this._touchEndHandler) {
      container.removeEventListener("touchend", this._touchEndHandler);
    }

    this._pointerMoveHandler = null;
    this._pointerLeaveHandler = null;
    this._pointerClickHandler = null;
    this._touchStartHandler = null;
    this._touchEndHandler = null;
  },

  _getPointerPosition(event) {
    const map = store.map;
    const container = map?.getCanvasContainer?.();
    const rect = getMapViewportRect(map);
    if (!container || !rect) {
      return null;
    }

    const source = event?.touches?.[0] || event?.changedTouches?.[0] || event;
    if (
      !source ||
      !Number.isFinite(source.clientX) ||
      !Number.isFinite(source.clientY)
    ) {
      return null;
    }

    return {
      clientX: source.clientX,
      clientY: source.clientY,
      x: source.clientX - rect.left,
      y: source.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
  },

  _findClusterAtPoint(x, y) {
    let match = null;
    let minDistanceSq = Number.POSITIVE_INFINITY;

    for (let i = this._clusters.length - 1; i >= 0; i -= 1) {
      const cluster = this._clusters[i];
      const diffX = cluster.x - x;
      const diffY = cluster.y - y;
      const hitRadius = cluster.radius + 12;
      const distanceSq = diffX * diffX + diffY * diffY;
      if (distanceSq > hitRadius * hitRadius) {
        continue;
      }
      if (distanceSq < minDistanceSq) {
        minDistanceSq = distanceSq;
        match = cluster;
      }
    }

    return match;
  },

  _updateTooltip(cluster, pointer) {
    if (!this._tooltip) {
      return;
    }

    if (!cluster || !pointer) {
      this._hideTooltip();
      return;
    }

    this._tooltip.innerHTML = "";
    this._tooltip.appendChild(
      createTooltipSection(cluster.label, "destination-bloom-tooltip__title")
    );
    this._tooltip.appendChild(
      createTooltipSection(
        `${cluster.count} ${cluster.count === 1 ? "trip" : "trips"}`
      )
    );
    this._tooltip.appendChild(
      createTooltipSection(
        `${Math.round(cluster.share * 100)}% of visible destinations`
      )
    );

    if (cluster.lastArrival) {
      this._tooltip.appendChild(
        createTooltipSection(
          `Last arrival ${new Date(cluster.lastArrival).toLocaleString()}`
        )
      );
    }

    const tooltipRect = this._tooltip.getBoundingClientRect?.();
    const tipW = tooltipRect?.width || 220;
    const tipH = tooltipRect?.height || 100;
    const maxX = Math.max(pointer.width - tipW - 8, 12);
    const maxY = Math.max(pointer.height - tipH - 8, 12);
    const left = clamp(pointer.x + TOOLTIP_OFFSET_X, 12, maxX);
    const top = clamp(pointer.y + TOOLTIP_OFFSET_Y, 12, maxY);

    this._tooltip.style.transform = `translate(${left}px, ${top}px)`;
    this._tooltip.classList.add("is-visible");
    this._tooltip.setAttribute("aria-hidden", "false");
  },

  _hideTooltip() {
    if (!this._tooltip) {
      return;
    }
    this._tooltip.classList.remove("is-visible");
    this._tooltip.setAttribute("aria-hidden", "true");
  },

  _syncTooltipToActiveCluster() {
    const activeId = this._pinnedClusterId || this._hoveredClusterId;
    if (!activeId || !this._lastPointer) {
      return;
    }
    const cluster = this._clusters.find((entry) => entry.id === activeId) || null;
    if (!cluster) {
      this._pinnedClusterId = null;
      this._hoveredClusterId = null;
      this._hideTooltip();
      return;
    }
    this._updateTooltip(cluster, this._lastPointer);
  },

  _hideTripLayers(map) {
    const style = map?.getStyle?.();
    if (!style?.layers) {
      return;
    }

    if (!Array.isArray(this._prevHiddenLayers)) {
      this._prevHiddenLayers = [];
    }
    style.layers.forEach((layer) => {
      const id = layer?.id || "";
      if (
        !id ||
        (!id.startsWith("trips-layer") &&
          !id.startsWith("matchedTrips-layer") &&
          id !== "trips-hitbox" &&
          id !== "matchedTrips-hitbox")
      ) {
        return;
      }

      const visibility =
        map.getLayoutProperty?.(id, "visibility") ||
        layer?.layout?.visibility ||
        "visible";
      if (visibility === "none") {
        return;
      }

      if (!this._prevHiddenLayers.includes(id)) {
        this._prevHiddenLayers.push(id);
      }
      map.setLayoutProperty?.(id, "visibility", "none");
    });
  },

  _restoreTripLayers(map) {
    if (!map || !Array.isArray(this._prevHiddenLayers)) {
      return;
    }

    this._prevHiddenLayers.forEach((id) => {
      if (!map.getLayer?.(id)) {
        return;
      }
      map.setLayoutProperty?.(id, "visibility", "visible");
    });
    this._prevHiddenLayers = null;
  },

  _startLoop() {
    if (this._animFrame) {
      return;
    }

    const frame = (now) => {
      if (this._destroyed) {
        return;
      }

      if (this._fading === "in") {
        const elapsed = now - this._fadeStart;
        this._opacity = Math.min(elapsed / FADE_IN_MS, 1);
        if (this._opacity >= 1) {
          this._fading = null;
        }
      } else if (this._fading === "out") {
        const elapsed = now - this._fadeStart;
        this._opacity = Math.max(1 - elapsed / FADE_OUT_MS, 0);
      }

      this._render(now);

      if (this._active || this._fading === "out") {
        this._animFrame = requestAnimationFrame(frame);
      } else {
        this._animFrame = null;
      }
    };

    this._animFrame = requestAnimationFrame(frame);
  },

  _stopLoop() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  },

  _render(now) {
    const ctx = this._ctx;
    const canvas = this._canvas;
    if (!ctx || !canvas) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this._opacity <= 0 || this._clusters.length === 0) {
      return;
    }

    const palette = this._paletteForCurrentStyle();
    const dpr = this._pixelRatio || 1;
    const reducedMotion = this._prefersReducedMotion();

    // Use lighter for overlapping glow areas, source-over for labels.
    // The CSS mix-blend-mode on the canvas handles compositing with the map.
    ctx.globalCompositeOperation = "lighter";
    this._clusters.forEach((cluster) => {
      const pulse = reducedMotion
        ? 1
        : 1 + Math.sin(now * 0.0014 + cluster.phase) * 0.08;
      const baseRadius = cluster.radius * pulse * dpr;
      const haloRadius = baseRadius * 3.5;
      const auraRadius = baseRadius * 2.2;
      const drawX = cluster.x * dpr;
      const drawY = cluster.y * dpr;
      const alphaWeight = clamp(0.35 + cluster.count * 0.04, 0.35, 0.85);

      const haloGradient = ctx.createRadialGradient(
        drawX,
        drawY,
        0,
        drawX,
        drawY,
        haloRadius
      );
      haloGradient.addColorStop(
        0,
        `rgba(${palette.halo[0]}, ${palette.halo[1]}, ${palette.halo[2]}, ${
          0.42 * this._opacity * alphaWeight
        })`
      );
      haloGradient.addColorStop(
        0.4,
        `rgba(${palette.aura[0]}, ${palette.aura[1]}, ${palette.aura[2]}, ${
          0.22 * this._opacity * alphaWeight
        })`
      );
      haloGradient.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.beginPath();
      ctx.fillStyle = haloGradient;
      ctx.arc(drawX, drawY, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      const auraGradient = ctx.createRadialGradient(
        drawX,
        drawY,
        0,
        drawX,
        drawY,
        auraRadius
      );
      auraGradient.addColorStop(
        0,
        `rgba(${palette.glow[0]}, ${palette.glow[1]}, ${palette.glow[2]}, ${
          0.55 * this._opacity * alphaWeight
        })`
      );
      auraGradient.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.beginPath();
      ctx.fillStyle = auraGradient;
      ctx.arc(drawX, drawY, auraRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";

      ctx.beginPath();
      ctx.fillStyle = `rgba(${palette.core[0]}, ${palette.core[1]}, ${palette.core[2]}, ${
        0.95 * this._opacity
      })`;
      ctx.arc(drawX, drawY, baseRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = `rgba(${palette.highlight[0]}, ${palette.highlight[1]}, ${palette.highlight[2]}, ${
        0.92 * this._opacity
      })`;
      ctx.arc(drawX, drawY, Math.max(baseRadius * 0.32, 2), 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "lighter";
    });

    ctx.globalCompositeOperation = "source-over";

    // Render count labels on clusters large enough to fit text
    const MIN_LABEL_RADIUS = 10;
    this._clusters.forEach((cluster) => {
      if (cluster.count < 2) return;
      const pulse = reducedMotion
        ? 1
        : 1 + Math.sin(now * 0.0014 + cluster.phase) * 0.08;
      const baseRadius = cluster.radius * pulse * dpr;
      if (baseRadius / dpr < MIN_LABEL_RADIUS) return;

      const drawX = cluster.x * dpr;
      const drawY = cluster.y * dpr;
      const fontSize = Math.round(clamp(baseRadius * 0.55, 9 * dpr, 15 * dpr));
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 3 * dpr;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * this._opacity})`;
      ctx.fillText(String(cluster.count), drawX, drawY + 1 * dpr);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    });
  },

  _paletteForCurrentStyle() {
    const style =
      store.state?.map?.style || localStorage.getItem("mapType") || "dark";
    if (style === "light" || style === "streets") {
      return {
        halo: [220, 120, 40],
        aura: [235, 160, 60],
        glow: [210, 110, 35],
        core: [180, 85, 20],
        highlight: [255, 240, 210],
      };
    }
    if (style === "satellite") {
      return {
        halo: [255, 170, 50],
        aura: [255, 200, 90],
        glow: [255, 150, 40],
        core: [255, 200, 80],
        highlight: [255, 250, 220],
      };
    }
    return {
      halo: [255, 140, 40],
      aura: [255, 180, 60],
      glow: [255, 160, 50],
      core: [255, 200, 80],
      highlight: [255, 245, 210],
    };
  },

  _prefersReducedMotion() {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  },

  _updateCursor(cluster) {
    const container = store.map?.getCanvasContainer?.();
    if (!container) return;
    container.style.cursor = cluster ? "pointer" : "";
  },

  _updateEmptyNotice() {
    if (this._clusters.length > 0 || !this._active) {
      this._removeEmptyNotice();
      return;
    }
    if (this._emptyNotice) return;

    const container = store.map?.getCanvasContainer?.();
    if (!container) return;

    const notice = document.createElement("div");
    notice.className = "destination-bloom-empty";
    notice.textContent = "No destinations to display";
    container.appendChild(notice);
    this._emptyNotice = notice;
    requestAnimationFrame(() => notice.classList.add("is-visible"));
  },

  _removeEmptyNotice() {
    this._emptyNotice?.remove?.();
    this._emptyNotice = null;
  },

  _updateCanvasBlendMode() {
    if (!this._canvas) {
      return;
    }
    const style =
      store.state?.map?.style || localStorage.getItem("mapType") || "dark";
    const usesScreen = style === "dark" || style === "satellite";
    this._canvas.classList.toggle("blend-screen", usesScreen);
  },

  _finalizeDeactivate() {
    this._stopLoop();
    if (this._deactivationTimer) {
      clearTimeout(this._deactivationTimer);
      this._deactivationTimer = null;
    }
    this._unbindMapEvents();
    this._unbindPointerEvents();
    this._updateCursor(null);
    this._restoreTripLayers(store.map);
    this._hideTooltip();
    this._removeTooltip();
    this._removeEmptyNotice();
    this._removeCanvas();
    this._points = [];
    this._clusters = [];
    this._opacity = 0;
    this._fading = null;
    this._hoveredClusterId = null;
    this._pinnedClusterId = null;
    this._lastPointer = null;
  },
};

export default destinationBloom;
