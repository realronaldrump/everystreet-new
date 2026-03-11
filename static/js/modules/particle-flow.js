/**
 * Particle Flow Visualization
 *
 * Wind-map inspired animation where particles flow along trip polylines,
 * creating a living, breathing network visualization. Scales gracefully
 * from a single trip to tens of thousands.
 *
 * The effect resembles long-exposure photography of city traffic at night —
 * tiny luminous dots stream along every route, pooling into bright rivers
 * where many trips overlap.
 */

import store from "./core/store.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_PARTICLES = 12000;
const MIN_PARTICLES = 30;
const PARTICLE_SPEED_BASE = 0.0012; // progress per frame at 60 fps
const PARTICLE_SPEED_VARIANCE = 0.6; // ± fraction of base speed
const TRAIL_LENGTH = 6; // number of historical positions to draw
const RESPAWN_JITTER = 0.15; // random head-start when recycling
const FADE_IN_MS = 600;
const FADE_OUT_MS = 400;

// Adaptive density: maps trip-count to particle-count
function particleBudget(tripCount) {
  if (tripCount <= 0) return 0;
  if (tripCount <= 3) return Math.max(MIN_PARTICLES, tripCount * 25);
  if (tripCount <= 20) return Math.min(tripCount * 15, 400);
  if (tripCount <= 100) return Math.min(300 + tripCount * 3, 1200);
  if (tripCount <= 500) return Math.min(1200 + tripCount, 3000);
  if (tripCount <= 2000) return Math.min(3000 + Math.floor(tripCount * 0.8), 6000);
  return Math.min(6000 + Math.floor(tripCount * 0.3), MAX_PARTICLES);
}

// Particle radius adapts so dense networks don't become a blob
function particleRadius(tripCount, zoom) {
  let base = 2.2;
  if (tripCount > 500) base = 1.6;
  else if (tripCount > 100) base = 1.8;
  else if (tripCount > 20) base = 2.0;

  // Scale with zoom
  const zoomFactor = Math.pow(1.12, zoom - 12);
  return Math.max(0.8, Math.min(base * zoomFactor, 5));
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Flatten GeoJSON features into an array of coordinate arrays (LineStrings). */
function extractPaths(geojson) {
  const paths = [];
  if (!geojson?.features) return paths;
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString" && g.coordinates?.length >= 2) {
      paths.push(g.coordinates);
    } else if (g.type === "MultiLineString") {
      for (const line of g.coordinates) {
        if (line?.length >= 2) paths.push(line);
      }
    }
  }
  return paths;
}

/** Pre-compute cumulative distances along a path for uniform-speed sampling. */
function buildCumulativeDist(projected) {
  const dists = new Float64Array(projected.length);
  dists[0] = 0;
  for (let i = 1; i < projected.length; i++) {
    const dx = projected[i][0] - projected[i - 1][0];
    const dy = projected[i][1] - projected[i - 1][1];
    dists[i] = dists[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return dists;
}

/** Interpolate screen position at fractional progress t ∈ [0,1] along path. */
function samplePath(projected, cumDist, t) {
  const totalLen = cumDist[cumDist.length - 1];
  if (totalLen === 0) return projected[0];
  const target = t * totalLen;

  // Binary search for segment
  let lo = 0;
  let hi = cumDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= target) lo = mid;
    else hi = mid;
  }

  const segLen = cumDist[hi] - cumDist[lo];
  if (segLen === 0) return projected[lo];
  const frac = (target - cumDist[lo]) / segLen;
  return [
    projected[lo][0] + (projected[hi][0] - projected[lo][0]) * frac,
    projected[lo][1] + (projected[hi][1] - projected[lo][1]) * frac,
  ];
}

// ---------------------------------------------------------------------------
// The Particle Flow renderer
// ---------------------------------------------------------------------------

const particleFlow = {
  _active: false,
  _canvas: null,
  _ctx: null,
  _animFrame: null,
  _particles: [],
  _paths: [], // [{ lngLat, projected, cumDist }]
  _opacity: 0,
  _fadeStart: 0,
  _fading: null, // 'in' | 'out' | null
  _mapMoveHandler: null,
  _mapZoomHandler: null,
  _mapResizeHandler: null,
  _styleChangeHandler: null,
  _prevHiddenLayers: null,
  _destroyed: false,

  // ------ Public API --------------------------------------------------------

  /** Whether the particle flow mode is currently active. */
  isActive() {
    return this._active;
  },

  /** Toggle particle flow on or off. Returns the new state. */
  toggle() {
    if (this._active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this._active;
  },

  /** Activate particle flow mode. */
  activate() {
    if (this._active) return;
    this._active = true;
    this._destroyed = false;

    const map = store.map;
    if (!map) return;

    this._createCanvas(map);
    this._collectPaths();
    this._spawnParticles();
    this._bindMapEvents(map);
    this._hideTripLayers(map);

    // Fade in
    this._opacity = 0;
    this._fading = "in";
    this._fadeStart = performance.now();

    this._startLoop();

    document.dispatchEvent(new CustomEvent("particleFlow:activated"));
  },

  /** Deactivate particle flow mode. */
  deactivate() {
    if (!this._active) return;

    // Fade out then clean up
    this._fading = "out";
    this._fadeStart = performance.now();

    const finishDeactivation = () => {
      this._active = false;
      this._stopLoop();
      this._unbindMapEvents();
      this._removeCanvas();
      this._restoreTripLayers(store.map);
      this._particles = [];
      this._paths = [];
      document.dispatchEvent(new CustomEvent("particleFlow:deactivated"));
    };

    // Let fade-out finish, then clean up
    setTimeout(finishDeactivation, FADE_OUT_MS + 50);
  },

  /** Full cleanup (page teardown). */
  destroy() {
    const wasActive = this._active;
    this._destroyed = true;
    this._active = false;
    this._stopLoop();
    this._unbindMapEvents();
    this._removeCanvas();
    this._restoreTripLayers(store.map);
    this._particles = [];
    this._paths = [];
    if (wasActive) {
      document.dispatchEvent(new CustomEvent("particleFlow:deactivated"));
    }
  },

  /** Re-read trip data (e.g. after date filter change). */
  refresh() {
    if (!this._active) return;
    this._collectPaths();
    this._spawnParticles();
    this._reprojectAll();
  },

  // ------ Canvas management -------------------------------------------------

  _createCanvas(map) {
    if (this._canvas) return;
    const container = map.getCanvasContainer();
    if (!container) return;

    const mapCanvas = map.getCanvas();
    const canvas = document.createElement("canvas");
    canvas.className = "particle-flow-canvas";
    canvas.width = mapCanvas.width;
    canvas.height = mapCanvas.height;
    canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";

    container.appendChild(canvas);
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
  },

  _removeCanvas() {
    if (this._canvas) {
      this._canvas.remove();
      this._canvas = null;
      this._ctx = null;
    }
  },

  _resizeCanvas() {
    const map = store.map;
    if (!this._canvas || !map) return;
    const mapCanvas = map.getCanvas();
    if (
      this._canvas.width !== mapCanvas.width ||
      this._canvas.height !== mapCanvas.height
    ) {
      this._canvas.width = mapCanvas.width;
      this._canvas.height = mapCanvas.height;
    }
  },

  // ------ Path collection ---------------------------------------------------

  _collectPaths() {
    this._paths = [];
    for (const layerName of ["trips", "matchedTrips"]) {
      const layerData = store.mapLayers[layerName];
      if (!layerData?.visible || !layerData.layer) continue;
      const extracted = extractPaths(layerData.layer);
      for (const coords of extracted) {
        this._paths.push({
          lngLat: coords,
          projected: null,
          cumDist: null,
        });
      }
    }
  },

  // ------ Projection --------------------------------------------------------

  _reprojectAll() {
    const map = store.map;
    if (!map) return;

    for (const path of this._paths) {
      const projected = new Array(path.lngLat.length);
      for (let i = 0; i < path.lngLat.length; i++) {
        const pt = map.project(path.lngLat[i]);
        // Use device pixel ratio for HiDPI
        projected[i] = [pt.x * devicePixelRatio, pt.y * devicePixelRatio];
      }
      path.projected = projected;
      path.cumDist = buildCumulativeDist(projected);
    }
  },

  // ------ Particle lifecycle ------------------------------------------------

  _spawnParticles() {
    const pathCount = this._paths.length;
    if (pathCount === 0) {
      this._particles = [];
      return;
    }

    const budget = particleBudget(pathCount);
    const particles = new Array(budget);

    for (let i = 0; i < budget; i++) {
      const pathIdx = i % pathCount;
      particles[i] = {
        pathIdx,
        t: Math.random(), // progress along path [0,1]
        speed:
          PARTICLE_SPEED_BASE *
          (1 + (Math.random() * 2 - 1) * PARTICLE_SPEED_VARIANCE),
        trail: [], // recent screen positions
        age: Math.random() * 100, // stagger initial age to avoid sync
      };
    }

    this._particles = particles;
  },

  _recycleParticle(p) {
    p.pathIdx = Math.floor(Math.random() * this._paths.length);
    p.t = Math.random() * RESPAWN_JITTER;
    p.speed =
      PARTICLE_SPEED_BASE *
      (1 + (Math.random() * 2 - 1) * PARTICLE_SPEED_VARIANCE);
    p.trail = [];
    p.age = 0;
  },

  // ------ Map event binding -------------------------------------------------

  _bindMapEvents(map) {
    this._mapMoveHandler = () => this._reprojectAll();
    this._mapZoomHandler = () => this._reprojectAll();
    this._mapResizeHandler = () => {
      this._resizeCanvas();
      this._reprojectAll();
    };

    map.on("move", this._mapMoveHandler);
    map.on("zoom", this._mapZoomHandler);
    map.on("resize", this._mapResizeHandler);
  },

  _unbindMapEvents() {
    const map = store.map;
    if (!map) return;
    if (this._mapMoveHandler) map.off("move", this._mapMoveHandler);
    if (this._mapZoomHandler) map.off("zoom", this._mapZoomHandler);
    if (this._mapResizeHandler) map.off("resize", this._mapResizeHandler);
    this._mapMoveHandler = null;
    this._mapZoomHandler = null;
    this._mapResizeHandler = null;
  },

  // ------ Layer visibility management ---------------------------------------

  _hideTripLayers(map) {
    if (!map) return;
    this._prevHiddenLayers = [];

    const style = map.getStyle();
    if (!style?.layers) return;

    for (const layer of style.layers) {
      const id = layer.id;
      // Hide any trip-related rendered layers (not hitbox)
      if (
        (id.startsWith("trips-layer") ||
          id.startsWith("matchedTrips-layer")) &&
        !id.includes("hitbox")
      ) {
        const currentVis = map.getLayoutProperty(id, "visibility");
        if (currentVis !== "none") {
          this._prevHiddenLayers.push(id);
          map.setLayoutProperty(id, "visibility", "none");
        }
      }
    }
  },

  _restoreTripLayers(map) {
    if (!map || !this._prevHiddenLayers) return;
    for (const id of this._prevHiddenLayers) {
      try {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", "visible");
        }
      } catch {
        // Layer may have been removed
      }
    }
    this._prevHiddenLayers = null;
  },

  // ------ Animation loop ----------------------------------------------------

  _startLoop() {
    if (this._animFrame) return;

    // Initial projection
    this._reprojectAll();
    this._resizeCanvas();

    let lastTime = performance.now();

    const frame = (now) => {
      if (this._destroyed) return;
      this._animFrame = requestAnimationFrame(frame);

      const dt = Math.min((now - lastTime) / 16.667, 3); // normalize to 60fps, cap
      lastTime = now;

      // Handle fading
      if (this._fading === "in") {
        const elapsed = now - this._fadeStart;
        this._opacity = Math.min(elapsed / FADE_IN_MS, 1);
        if (this._opacity >= 1) this._fading = null;
      } else if (this._fading === "out") {
        const elapsed = now - this._fadeStart;
        this._opacity = Math.max(1 - elapsed / FADE_OUT_MS, 0);
      }

      this._simulate(dt);
      this._render();
    };

    this._animFrame = requestAnimationFrame(frame);
  },

  _stopLoop() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  },

  // ------ Simulation --------------------------------------------------------

  _simulate(dt) {
    const pathCount = this._paths.length;
    if (pathCount === 0) return;

    for (const p of this._particles) {
      p.t += p.speed * dt;
      p.age += dt;

      if (p.t >= 1) {
        this._recycleParticle(p);
        continue;
      }

      const path = this._paths[p.pathIdx];
      if (!path?.projected || !path.cumDist) continue;

      const pos = samplePath(path.projected, path.cumDist, p.t);
      p.trail.push(pos);
      if (p.trail.length > TRAIL_LENGTH) {
        p.trail.shift();
      }
    }
  },

  // ------ Rendering ---------------------------------------------------------

  _render() {
    const ctx = this._ctx;
    const canvas = this._canvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this._opacity <= 0 || this._paths.length === 0) return;

    const tripCount = this._paths.length;
    const map = store.map;
    const zoom = map ? map.getZoom() : 12;
    const radius = particleRadius(tripCount, zoom);
    const globalAlpha = this._opacity;

    // Determine theme colors
    const isDark = this._isDarkTheme();
    const coreColor = isDark ? [240, 184, 64] : [200, 120, 50]; // golden / warm brown
    const glowColor = isDark ? [200, 104, 50] : [180, 100, 60]; // orange

    // Use additive-like compositing for the glow buildup
    ctx.globalCompositeOperation = "screen";

    // Draw glow layer (larger, transparent)
    const glowRadius = radius * 2.5;
    for (const p of this._particles) {
      if (p.trail.length === 0) continue;
      const head = p.trail[p.trail.length - 1];

      // Skip particles outside canvas bounds (with margin)
      if (
        head[0] < -glowRadius ||
        head[0] > canvas.width + glowRadius ||
        head[1] < -glowRadius ||
        head[1] > canvas.height + glowRadius
      )
        continue;

      // Age-based fade in for newly spawned particles
      const ageFade = Math.min(p.age / 8, 1);
      const alpha = 0.12 * globalAlpha * ageFade;
      if (alpha <= 0.005) continue;

      ctx.beginPath();
      ctx.arc(head[0], head[1], glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${glowColor[0]},${glowColor[1]},${glowColor[2]},${alpha})`;
      ctx.fill();
    }

    // Draw trails
    ctx.globalCompositeOperation = "screen";
    for (const p of this._particles) {
      const trail = p.trail;
      if (trail.length < 2) continue;

      const head = trail[trail.length - 1];
      if (
        head[0] < -20 ||
        head[0] > canvas.width + 20 ||
        head[1] < -20 ||
        head[1] > canvas.height + 20
      )
        continue;

      const ageFade = Math.min(p.age / 8, 1);

      ctx.beginPath();
      ctx.moveTo(trail[0][0], trail[0][1]);
      for (let i = 1; i < trail.length; i++) {
        ctx.lineTo(trail[i][0], trail[i][1]);
      }
      ctx.strokeStyle = `rgba(${glowColor[0]},${glowColor[1]},${glowColor[2]},${0.25 * globalAlpha * ageFade})`;
      ctx.lineWidth = radius * 0.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Draw core dots (bright heads)
    ctx.globalCompositeOperation = "lighter";
    for (const p of this._particles) {
      if (p.trail.length === 0) continue;
      const head = p.trail[p.trail.length - 1];

      if (
        head[0] < -radius ||
        head[0] > canvas.width + radius ||
        head[1] < -radius ||
        head[1] > canvas.height + radius
      )
        continue;

      const ageFade = Math.min(p.age / 8, 1);
      const alpha = 0.7 * globalAlpha * ageFade;
      if (alpha <= 0.01) continue;

      ctx.beginPath();
      ctx.arc(head[0], head[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${coreColor[0]},${coreColor[1]},${coreColor[2]},${alpha})`;
      ctx.fill();
    }

    // Reset compositing
    ctx.globalCompositeOperation = "source-over";
  },

  _isDarkTheme() {
    const mapType =
      store.state?.map?.style ||
      localStorage.getItem("mapType") ||
      "dark";
    return mapType !== "light" && mapType !== "streets";
  },
};

export default particleFlow;
