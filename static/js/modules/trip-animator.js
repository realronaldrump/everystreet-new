/**
 * Trip Animator Module
 *
 * Provides route drawing animations for trips on the map.
 * When a trip is selected, the route draws itself with a trailing glow.
 * Also provides a full trip replay mode with an animated marker.
 */

/* global mapboxgl */

import layerManager from "./layer-manager.js";
import {
  bearing as computeBearing,
  haversineDistance,
} from "./utils/geo-math.js";

const ANIM_SOURCE = "trip-animator-source";
const ANIM_LINE_LAYER = "trip-animator-line";
const ANIM_GLOW_LAYER = "trip-animator-glow";
const REPLAY_MARKER_SOURCE = "trip-replay-marker";
const REPLAY_MARKER_LAYER = "trip-replay-marker-circle";
const REPLAY_TRAIL_SOURCE = "trip-replay-trail";
const REPLAY_TRAIL_LAYER = "trip-replay-trail-line";
const REPLAY_MS_PER_METER = 3;
const REPLAY_MIN_DURATION_MS = 8000;
const REPLAY_MAX_DURATION_MS = 60000;

class TripAnimator {
  constructor() {
    this._drawFrameId = null;
    this._replayFrameId = null;
    this._replayState = null;
    this._isDrawing = false;
    this._destroyed = false;
  }

  /**
   * Animate a trip route drawing itself on the map.
   * @param {Object} map - Mapbox GL map instance
   * @param {Array} coordinates - Array of [lng, lat] coordinates
   * @param {Object} options - Animation options
   */
  animateRouteDraw(map, coordinates, options = {}) {
    if (!map || !coordinates?.length || coordinates.length < 2) return;

    this.stopDraw(map);

    const {
      duration = 2000,
      color = "#3b8a7f",
      glowColor = "#d09868",
      lineWidth = 3,
      onComplete = null,
    } = options;

    const geojson = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [] },
    };

    // Set up source and layers
    this._ensureSource(map, ANIM_SOURCE, true);
    this._ensureLineLayer(map, ANIM_GLOW_LAYER, ANIM_SOURCE, {
      color: glowColor,
      width: lineWidth * 2.5,
      blur: lineWidth * 2,
      opacity: 0.4,
    });
    this._ensureLineLayer(map, ANIM_LINE_LAYER, ANIM_SOURCE, {
      color,
      width: lineWidth,
      blur: 0,
      opacity: 0.9,
    });

    // Calculate segment distances for uniform speed
    const totalDist = this._totalDistance(coordinates);
    const startTime = performance.now();
    this._isDrawing = true;

    const animate = (now) => {
      if (this._destroyed || !this._isDrawing) return;

      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 3; // ease-out cubic
      const targetDist = eased * totalDist;

      // Build partial coordinate list
      const partial = this._interpolateAlongLine(coordinates, targetDist, totalDist);
      geojson.geometry.coordinates = partial;

      const source = map.getSource(ANIM_SOURCE);
      if (source) source.setData(geojson);

      if (progress < 1) {
        this._drawFrameId = requestAnimationFrame(animate);
      } else {
        this._isDrawing = false;
        onComplete?.();
      }
    };

    this._drawFrameId = requestAnimationFrame(animate);
  }

  /**
   * Start trip replay with animated marker moving along route.
   * @param {Object} map - Mapbox GL map instance
   * @param {Array} coordinates - Route coordinates
   * @param {Object} options - Replay options
   */
  startReplay(map, coordinates, options = {}) {
    if (!map || !coordinates?.length || coordinates.length < 2) return;

    this.stopReplay(map);

    const {
      speed = 1,
      followCamera = true,
      color = "#3b8a7f",
      onProgress = null,
      onComplete = null,
    } = options;

    // Compute total distance and per-segment distances
    const totalDist = this._totalDistance(coordinates);
    const baseDuration = Math.min(
      Math.max(totalDist * REPLAY_MS_PER_METER, REPLAY_MIN_DURATION_MS),
      REPLAY_MAX_DURATION_MS
    );
    const duration = baseDuration / speed;

    // Set up trail
    this._ensureSource(map, REPLAY_TRAIL_SOURCE, true);
    this._ensureLineLayer(map, REPLAY_TRAIL_LAYER, REPLAY_TRAIL_SOURCE, {
      color,
      width: 3,
      blur: 0,
      opacity: 0.7,
    });

    // Set up marker
    if (!map.getSource(REPLAY_MARKER_SOURCE)) {
      map.addSource(REPLAY_MARKER_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer(REPLAY_MARKER_LAYER)) {
      map.addLayer({
        id: REPLAY_MARKER_LAYER,
        type: "circle",
        source: REPLAY_MARKER_SOURCE,
        paint: {
          "circle-radius": 7,
          "circle-color": color,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "rgba(255,255,255,0.8)",
        },
      });
    }

    const startTime = performance.now();
    const trailGeoJSON = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [] },
    };

    this._replayState = {
      playing: true,
      speed,
      startTime,
      duration,
      coordinates,
      totalDist,
      followCamera,
      onProgress,
      onComplete,
      lastCameraUpdate: 0,
    };

    const animate = (now) => {
      const state = this._replayState;
      if (!state?.playing || this._destroyed) return;

      const elapsed = now - state.startTime;
      const progress = Math.min(elapsed / state.duration, 1);
      const eased = progress; // Linear for replay (consistent speed feel)
      const targetDist = eased * state.totalDist;

      const partial = this._interpolateAlongLine(coordinates, targetDist, state.totalDist);
      const currentPos = partial[partial.length - 1];

      // Update trail
      trailGeoJSON.geometry.coordinates = partial;
      map.getSource(REPLAY_TRAIL_SOURCE)?.setData(trailGeoJSON);

      // Update marker
      map.getSource(REPLAY_MARKER_SOURCE)?.setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: currentPos },
        }],
      });

      // Follow camera (throttled to avoid jitter)
      if (state.followCamera && now - state.lastCameraUpdate > 100) {
        state.lastCameraUpdate = now;
        const prev = partial[partial.length - 2];
        const bearing = prev
          ? computeBearing(prev[1], prev[0], currentPos[1], currentPos[0])
          : 0;
        map.easeTo({
          center: currentPos,
          zoom: 15.5,
          pitch: 52,
          bearing,
          duration: 300,
          essential: true,
        });
      }

      state.onProgress?.(progress);

      if (progress < 1) {
        this._replayFrameId = requestAnimationFrame(animate);
      } else {
        state.playing = false;
        state.onComplete?.();
      }
    };

    this._replayFrameId = requestAnimationFrame(animate);
  }

  /** Change replay speed */
  setReplaySpeed(speed) {
    if (!this._replayState?.playing) return;
    const state = this._replayState;
    const now = performance.now();
    const elapsed = now - state.startTime;
    const currentProgress = Math.min(elapsed / state.duration, 1);
    const baseDuration = state.duration * state.speed; // original total
    state.speed = speed;
    state.duration = baseDuration / speed;
    state.startTime = now - currentProgress * state.duration;
  }

  /** Stop route drawing animation */
  stopDraw(map = null) {
    this._isDrawing = false;
    if (this._drawFrameId) {
      cancelAnimationFrame(this._drawFrameId);
      this._drawFrameId = null;
    }
    if (map) {
      this._setLineSourceData(map, ANIM_SOURCE, []);
    }
  }

  /** Stop replay */
  stopReplay(map = null) {
    if (this._replayFrameId) {
      cancelAnimationFrame(this._replayFrameId);
      this._replayFrameId = null;
    }
    this._replayState = null;
    if (map) {
      this._setLineSourceData(map, REPLAY_TRAIL_SOURCE, []);
      this._setPointSourceData(map, REPLAY_MARKER_SOURCE, []);
    }
  }

  /** Clean up all layers and sources */
  cleanup(map) {
    this.stopDraw();
    this.stopReplay();
    if (!map) return;

    const layers = [ANIM_LINE_LAYER, ANIM_GLOW_LAYER, REPLAY_TRAIL_LAYER, REPLAY_MARKER_LAYER];
    const sources = [ANIM_SOURCE, REPLAY_TRAIL_SOURCE, REPLAY_MARKER_SOURCE];

    for (const id of layers) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of sources) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  destroy() {
    this._destroyed = true;
    this.stopDraw();
    this.stopReplay();
  }

  get isReplaying() {
    return this._replayState?.playing === true;
  }

  get isDrawing() {
    return this._isDrawing;
  }

  // --- Helpers ---

  _ensureSource(map, id, lineMetrics = false) {
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
        lineMetrics,
      });
    }
  }

  _ensureLineLayer(map, layerId, sourceId, style) {
    if (map.getLayer(layerId)) return;
    const beforeId = layerManager.getFirstSymbolLayerId();
    map.addLayer({
      id: layerId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": style.color,
        "line-width": style.width,
        "line-blur": style.blur,
        "line-opacity": style.opacity,
      },
    }, beforeId);
  }

  _setLineSourceData(map, sourceId, coordinates) {
    map.getSource(sourceId)?.setData({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates,
      },
    });
  }

  _setPointSourceData(map, sourceId, coordinates) {
    map.getSource(sourceId)?.setData({
      type: "FeatureCollection",
      features: coordinates.length
        ? [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates },
            },
          ]
        : [],
    });
  }

  _totalDistance(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) {
      d += this._segDist(coords[i - 1], coords[i]);
    }
    return d;
  }

  _segDist(a, b) {
    return haversineDistance(a[1], a[0], b[1], b[0]);
  }

  _interpolateAlongLine(coords, targetDist, totalDist) {
    if (targetDist <= 0) return [coords[0]];
    if (targetDist >= totalDist) return [...coords];

    const result = [coords[0]];
    let accum = 0;

    for (let i = 1; i < coords.length; i++) {
      const segLen = this._segDist(coords[i - 1], coords[i]);
      if (accum + segLen >= targetDist) {
        const remaining = targetDist - accum;
        const ratio = segLen > 0 ? remaining / segLen : 0;
        const interp = [
          coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * ratio,
          coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * ratio,
        ];
        result.push(interp);
        return result;
      }
      accum += segLen;
      result.push(coords[i]);
    }

    return result;
  }
}

const tripAnimator = new TripAnimator();
export default tripAnimator;
