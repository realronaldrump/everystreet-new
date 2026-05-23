/**
 * Memory City — 3D sculpture view of an area's driven streets.
 *
 * The sculpture is rendered with deck.gl using two layers:
 *
 *   - ColumnLayer: one column at each driven segment's midpoint,
 *     extruded by days-since-first-driven (how long the street
 *     has been part of your city). Tinted by recency.
 *   - PathLayer: glowing threads tracing the full segment
 *     geometry at ground level, also tinted by recency.
 *
 * A time scrubber masks segments to `first_driven_at <= cutoff`,
 * enabling a "watch yourself build the city" animation.
 *
 * No basemap is shown — undriven roads literally do not exist in
 * this view. The area is only the shape you've carved with drives.
 */

import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";
import { escapeHtml, isAbortError } from "../../utils.js";

const DAY_MS = 86_400_000;

// Recency color gradient (warm → cool). Each stop is [daysThreshold, [r,g,b]].
// Streets driven within `daysThreshold` take on that color.
const RECENCY_STOPS = [
  [0, [255, 204, 118]], // fresh drive — warm honey
  [7, [242, 160, 74]], // within a week — amber
  [30, [216, 131, 85]], // within a month — coral
  [90, [184, 118, 142]], // within a quarter — dusk mauve
  [180, [138, 122, 176]], // within half a year — lavender
  [365, [108, 120, 172]], // within a year — indigo
  [Number.POSITIVE_INFINITY, [70, 86, 140]], // older — deep steel
];

// Sculpture geometry tuning
const MIN_COLUMN_HEIGHT_M = 15;
const MAX_COLUMN_HEIGHT_M = 500; // Capped to look less like spikes, more like monuments
const PATH_GLOW_WIDTH_MIN_PX = 1.5;
const PATH_GLOW_WIDTH_MAX_PX = 4;

const DEFAULT_VIEW_STATE = Object.freeze({
  longitude: -97.14,
  latitude: 31.55,
  zoom: 11.5,
  pitch: 55,
  bearing: -18,
});

export default async function initMemoryCityPage(ctx = {}) {
  const { signal, onCleanup } = ctx;
  const registerCleanup = typeof onCleanup === "function" ? onCleanup : () => {};

  const state = {
    areas: [],
    selectedAreaId: null,
    payload: null, // raw API response
    timeCutoff: null, // ms timestamp; null = show all
    timeRange: null, // { min, max }
    deck: null,
    viewState: null,
    hoveredSegmentId: null,
    selectedSegmentId: null,
    isPlaying: false,
    playRaf: null,
    playStartTs: 0,
    autoRotate: false,
    rotateRaf: null,
    inflight: null,
    hoveredRecencyIndex: null,
    selectedRecencyIndex: null,
  };

  const elements = {
    view: document.getElementById("memory-city"),
    canvas: document.getElementById("memory-city-canvas"),
    title: document.getElementById("memory-city-title"),
    subtitle: document.getElementById("memory-city-subtitle"),
    areaSelect: document.getElementById("memory-city-area-select"),
    statSegments: document.getElementById("mc-stat-segments"),
    statMiles: document.getElementById("mc-stat-miles"),
    statPercent: document.getElementById("mc-stat-percent"),
    statFirst: document.getElementById("mc-stat-first"),
    scrubber: document.getElementById("memory-city-scrubber"),
    scrubberMin: document.getElementById("mc-scrubber-min"),
    scrubberMax: document.getElementById("mc-scrubber-max"),
    scrubberCurrent: document.getElementById("mc-scrubber-current"),
    playBtn: document.getElementById("memory-city-play"),
    resetCamBtn: document.getElementById("memory-city-reset-cam"),
    spinBtn: document.getElementById("memory-city-toggle-spin"),
    camCinematicBtn: document.getElementById("memory-city-cam-cinematic"),
    camBlueprintBtn: document.getElementById("memory-city-cam-blueprint"),
    camHorizonBtn: document.getElementById("memory-city-cam-horizon"),
    detail: document.getElementById("memory-city-detail"),
    stateOverlay: document.getElementById("memory-city-state"),
  };

  if (!elements.view || !elements.canvas) {
    return;
  }

  await ensureDeckLoaded();
  if (signal?.aborted) {
    return;
  }

  bindEvents();
  setState("loading", "Summoning your city…");

  try {
    await loadAreas();
    if (signal?.aborted) {
      return;
    }
    if (state.selectedAreaId) {
      await loadArea(state.selectedAreaId);
    } else {
      setState("empty", "Create a coverage area to build your Memory City.");
    }
  } catch (error) {
    if (!signal?.aborted) {
      console.error("Memory City init failed", error);
      setState("error", error?.message || "Unable to load Memory City.");
    }
  }

  registerCleanup(teardown);

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async function ensureDeckLoaded() {
    if (typeof window !== "undefined" && window.deck) {
      return;
    }
    const { ensureLibraries } = await import("../../core/library-loader.js");
    await ensureLibraries(["deck"]);
  }

  function bindEvents() {
    const addListener = (el, type, handler, opts) => {
      if (!el) {
        return;
      }
      const options = signal ? { ...(opts || {}), signal } : opts;
      el.addEventListener(type, handler, options);
    };

    addListener(elements.areaSelect, "change", onAreaSelectChange);
    addListener(elements.scrubber, "input", onScrubberInput);
    addListener(elements.playBtn, "click", togglePlay);
    addListener(elements.resetCamBtn, "click", resetCamera);
    addListener(elements.spinBtn, "click", toggleAutoRotate);
    addListener(elements.camCinematicBtn, "click", () => setCameraPreset("cinematic"));
    addListener(elements.camBlueprintBtn, "click", () => setCameraPreset("blueprint"));
    addListener(elements.camHorizonBtn, "click", () => setCameraPreset("horizon"));

    if (signal) {
      signal.addEventListener("abort", teardown, { once: true });
    }
  }

  function teardown() {
    stopPlay();
    stopAutoRotate();
    if (state.inflight) {
      state.inflight.abort();
      state.inflight = null;
    }
    if (state.deck) {
      try {
        state.deck.finalize();
      } catch (err) {
        console.warn("Memory City deck finalize failed", err);
      }
      state.deck = null;
    }
  }

  // ===========================================================================
  // Data loading
  // ===========================================================================

  async function loadAreas() {
    const data = await apiClient.get("/api/coverage/areas", {
      signal,
      cache: false,
    });
    const list = Array.isArray(data?.areas) ? data.areas : [];
    // Only ready areas with driven streets make for a meaningful sculpture.
    const buildable = list.filter(
      (area) =>
        String(area.status || "").toLowerCase() === "ready" &&
        (area.driven_segments || 0) > 0
    );

    state.areas = buildable;
    populateAreaSelect(buildable);

    if (buildable.length === 0) {
      setState("empty", "No driven areas yet — go build coverage, then return.");
      return;
    }

    // Prefer the area with the most driven miles — likeliest to be the
    // showcase monument.
    const preferred =
      buildable
        .slice()
        .sort(
          (a, b) => (b.driven_length_miles || 0) - (a.driven_length_miles || 0)
        )[0] || buildable[0];
    state.selectedAreaId = preferred.id;
    elements.areaSelect.value = preferred.id;
  }

  function populateAreaSelect(areas) {
    const select = elements.areaSelect;
    if (!select) {
      return;
    }
    select.innerHTML = "";

    if (areas.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "No areas with drives yet";
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    for (const area of areas) {
      const opt = document.createElement("option");
      opt.value = area.id;
      const pct =
        Number.isFinite(area.coverage_percentage) && area.coverage_percentage > 0
          ? ` · ${area.coverage_percentage.toFixed(1)}%`
          : "";
      opt.textContent = `${area.display_name}${pct}`;
      select.appendChild(opt);
    }
  }

  function syncSelectedAreaOption(area) {
    const select = elements.areaSelect;
    if (!select || !area?.id) {
      return;
    }
    const option = Array.from(select.options).find(
      (candidate) => candidate.value === String(area.id)
    );
    if (!option) {
      return;
    }
    const pct =
      Number.isFinite(area.coverage_percentage) && area.coverage_percentage > 0
        ? ` · ${Number(area.coverage_percentage).toFixed(1)}%`
        : "";
    option.textContent = `${area.display_name || "Unnamed area"}${pct}`;
  }

  async function onAreaSelectChange(event) {
    const nextId = event.target.value;
    if (!nextId || nextId === state.selectedAreaId) {
      return;
    }
    state.selectedAreaId = nextId;
    await loadArea(nextId);
  }

  async function loadArea(areaId) {
    if (state.inflight) {
      state.inflight.abort();
    }
    const controller = new AbortController();
    const composite = signal
      ? anySignal([signal, controller.signal])
      : controller.signal;
    state.inflight = controller;

    setState("loading", "Summoning your city…");

    try {
      const payload = await apiClient.get(
        `/api/coverage/areas/${encodeURIComponent(areaId)}/memory-city`,
        { signal: composite, cache: false }
      );

      if (composite.aborted) {
        return;
      }

      state.payload = payload;
      state.selectedSegmentId = null;
      state.hoveredSegmentId = null;
      state.selectedRecencyIndex = null;
      state.hoveredRecencyIndex = null;
      syncSelectedAreaOption(payload?.area);

      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      buildLegendRecency();
      if (segments.length === 0) {
        setState("empty", "This area has no driven streets yet. Drive something!");
        renderStats(payload);
        configureScrubber(null);
        renderDetailEmpty();
        if (state.deck) {
          state.deck.setProps({ layers: [] });
        }
        return;
      }

      renderStats(payload);
      configureScrubber(payload);
      renderDetailEmpty();
      buildSculpture(payload);
      setState("hidden");
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error("Failed to load Memory City area", error);
      setState("error", error?.message || "Failed to load area.");
      notificationManager?.show?.({
        type: "danger",
        message: `Memory City: ${error?.message || "load failed"}`,
      });
    } finally {
      if (state.inflight === controller) {
        state.inflight = null;
      }
    }
  }

  // ===========================================================================
  // Stats + header
  // ===========================================================================

  function renderStats(payload) {
    const area = payload?.area || {};
    if (elements.title) {
      elements.title.textContent = area.display_name || "Memory City";
    }
    if (elements.subtitle) {
      elements.subtitle.textContent = buildSubtitle(payload);
    }

    setText(elements.statSegments, formatInt(area.driven_segments));
    setText(elements.statMiles, formatMiles(area.driven_length_miles));
    setText(elements.statPercent, formatPercent(area.coverage_percentage));

    const firstIso = payload?.first_driven_min;
    setText(elements.statFirst, firstIso ? formatDate(firstIso) : "—");
  }

  function buildSubtitle(payload) {
    const segments = Array.isArray(payload?.segments) ? payload.segments.length : 0;
    if (segments === 0) {
      return "A 3D monument of the streets you've driven. This area is empty.";
    }
    const pct =
      Number.isFinite(payload?.area?.coverage_percentage) &&
      payload.area.coverage_percentage > 0
        ? ` (${payload.area.coverage_percentage.toFixed(1)}% complete)`
        : "";
    return `${formatInt(segments)} streets stand in your city${pct}. Height = tenure. Color = recency. Scrub to watch it grow.`;
  }

  // ===========================================================================
  // Scrubber
  // ===========================================================================

  function configureScrubber(payload) {
    const min = parseIso(payload?.first_driven_min);
    const max = parseIso(payload?.first_driven_max);

    if (min === null || max === null || max <= min) {
      state.timeRange = null;
      state.timeCutoff = null;
      if (elements.scrubber) {
        elements.scrubber.disabled = true;
      }
      setText(elements.scrubberMin, "—");
      setText(elements.scrubberMax, "—");
      setText(elements.scrubberCurrent, "—");
      setScrubberProgress(100);
      return;
    }

    state.timeRange = { min, max };
    state.timeCutoff = max; // start showing full city

    if (elements.scrubber) {
      elements.scrubber.disabled = false;
      elements.scrubber.value = "1000";
    }
    setText(elements.scrubberMin, formatDate(min));
    setText(elements.scrubberMax, formatDate(max));
    setText(elements.scrubberCurrent, `now · ${formatDate(max)}`);
    setScrubberProgress(100);
  }

  function onScrubberInput(event) {
    const range = state.timeRange;
    if (!range) {
      return;
    }
    const ratio = clamp(Number(event.target.value) / 1000, 0, 1);
    const cutoff = range.min + (range.max - range.min) * ratio;
    applyCutoff(cutoff, ratio);
    if (state.isPlaying) {
      stopPlay();
    }
  }

  function applyCutoff(cutoff, ratio) {
    state.timeCutoff = cutoff;
    const range = state.timeRange;
    if (!range) {
      return;
    }
    const pct =
      typeof ratio === "number"
        ? ratio
        : (cutoff - range.min) / (range.max - range.min);
    const cutoffLabel =
      Math.abs(cutoff - range.max) < DAY_MS
        ? `now · ${formatDate(range.max)}`
        : formatDate(cutoff);
    setText(elements.scrubberCurrent, cutoffLabel);
    setScrubberProgress(clamp(pct * 100, 0, 100));
    updateDynamicStats(cutoff);
    refreshLayers();
  }

  function setScrubberProgress(percent) {
    if (elements.scrubber) {
      elements.scrubber.style.setProperty("--mc-scrubber-progress", `${percent}%`);
    }
  }

  // ===========================================================================
  // Play animation (watch the city grow)
  // ===========================================================================

  function togglePlay() {
    if (!state.timeRange) {
      return;
    }
    if (state.isPlaying) {
      stopPlay();
    } else {
      startPlay();
    }
  }

  function startPlay() {
    if (!state.timeRange) {
      return;
    }
    state.isPlaying = true;
    elements.playBtn?.classList.add("is-playing");
    setPlayIcon(true);
    elements.playBtn?.setAttribute("aria-label", "Pause grow animation");

    const durationMs = 8_000;
    const start = performance.now();
    const startRatio = 0;
    state.playStartTs = start;

    const range = state.timeRange;

    // Rewind to start before animating forward
    elements.scrubber.value = "0";
    const initialCutoff = range.min;
    applyCutoff(initialCutoff, startRatio);

    const step = (now) => {
      if (!state.isPlaying) {
        return;
      }
      const elapsed = now - start;
      const ratio = clamp(elapsed / durationMs, 0, 1);
      const cutoff = range.min + (range.max - range.min) * ratio;
      if (elements.scrubber) {
        elements.scrubber.value = String(Math.round(ratio * 1000));
      }
      applyCutoff(cutoff, ratio);
      if (ratio >= 1) {
        stopPlay();
        return;
      }
      state.playRaf = requestAnimationFrame(step);
    };
    state.playRaf = requestAnimationFrame(step);
  }

  function stopPlay() {
    if (state.playRaf) {
      cancelAnimationFrame(state.playRaf);
      state.playRaf = null;
    }
    state.isPlaying = false;
    elements.playBtn?.classList.remove("is-playing");
    setPlayIcon(false);
    elements.playBtn?.setAttribute("aria-label", "Play grow animation");
  }

  function setPlayIcon(isPlaying) {
    const icon = elements.playBtn?.querySelector("i");
    if (!icon) {
      return;
    }
    icon.classList.remove("fa-play", "fa-pause");
    icon.classList.add(isPlaying ? "fa-pause" : "fa-play");
  }

  // ===========================================================================
  // Camera
  // ===========================================================================

  function toggleAutoRotate() {
    if (state.autoRotate) {
      stopAutoRotate();
    } else {
      startAutoRotate();
    }
  }

  function startAutoRotate() {
    if (!state.deck || state.autoRotate) {
      return;
    }
    state.autoRotate = true;
    elements.spinBtn?.setAttribute("aria-pressed", "true");
    const degPerSec = 6;
    let last = performance.now();
    const step = (now) => {
      if (!state.autoRotate) {
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      const current = state.viewState || DEFAULT_VIEW_STATE;
      const nextBearing = ((current.bearing + degPerSec * dt + 360) % 360) - 180;
      updateViewState({ ...current, bearing: nextBearing });
      state.rotateRaf = requestAnimationFrame(step);
    };
    state.rotateRaf = requestAnimationFrame(step);
  }

  function stopAutoRotate() {
    if (state.rotateRaf) {
      cancelAnimationFrame(state.rotateRaf);
      state.rotateRaf = null;
    }
    state.autoRotate = false;
    elements.spinBtn?.setAttribute("aria-pressed", "false");
  }

  function resetCamera() {
    const fitted = fitViewToArea(state.payload);
    if (fitted) {
      updateViewState({ ...fitted, transitionDuration: 800 });
    }
  }

  function fitViewToArea(payload) {
    if (!payload) {
      return null;
    }
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    if (segments.length === 0) {
      return null;
    }

    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    for (const seg of segments) {
      const { path } = seg;
      if (!Array.isArray(path)) {
        continue;
      }
      for (const pt of path) {
        if (!Array.isArray(pt) || pt.length < 2) {
          continue;
        }
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          continue;
        }
        if (lon < minLon) {
          minLon = lon;
        }
        if (lon > maxLon) {
          maxLon = lon;
        }
        if (lat < minLat) {
          minLat = lat;
        }
        if (lat > maxLat) {
          maxLat = lat;
        }
      }
    }

    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
      return null;
    }

    const WebMercatorViewport = window.deck?.WebMercatorViewport;
    const container = elements.canvas;
    if (WebMercatorViewport && container) {
      try {
        const vp = new WebMercatorViewport({
          width: Math.max(1, container.clientWidth),
          height: Math.max(1, container.clientHeight),
        });
        const fitted = vp.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 80 }
        );
        return {
          longitude: fitted.longitude,
          latitude: fitted.latitude,
          zoom: Math.max(10.5, Math.min(16, fitted.zoom - 0.6)),
          pitch: DEFAULT_VIEW_STATE.pitch,
          bearing: DEFAULT_VIEW_STATE.bearing,
        };
      } catch (err) {
        console.warn("fitBounds failed", err);
      }
    }

    return {
      longitude: (minLon + maxLon) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom: 11.5,
      pitch: DEFAULT_VIEW_STATE.pitch,
      bearing: DEFAULT_VIEW_STATE.bearing,
    };
  }

  function updateViewState(next) {
    state.viewState = { ...next };
    if (state.deck) {
      state.deck.setProps({ viewState: next });
    }
  }

  // ===========================================================================
  // Sculpture (deck.gl)
  // ===========================================================================

  function buildSculpture(payload) {
    const deckNs = window.deck;
    if (!deckNs) {
      setState("error", "3D renderer (deck.gl) failed to load.");
      return;
    }

    const initial = fitViewToArea(payload) || DEFAULT_VIEW_STATE;
    state.viewState = { ...initial };

    if (!state.deck) {
      state.deck = new deckNs.Deck({
        parent: elements.canvas,
        controller: {
          dragRotate: true,
          touchRotate: true,
          scrollZoom: { smooth: true },
          inertia: 260,
        },
        views: new deckNs.MapView({ repeat: false }),
        viewState: state.viewState,
        onViewStateChange: ({ viewState }) => {
          state.viewState = viewState;
          state.deck?.setProps({ viewState });
          // User dragged: stop auto-rotate so we don't fight them.
          if (state.autoRotate) {
            stopAutoRotate();
          }
          updateCameraPresetActiveStates(null);
        },
        getTooltip: buildTooltip,
        onClick: onSculptureClick,
        onHover: onSculptureHover,
        layers: buildLayers(payload),
        parameters: {
          clearColor: [0.024, 0.027, 0.043, 1],
        },
      });
    } else {
      state.deck.setProps({
        viewState: state.viewState,
        layers: buildLayers(payload),
      });
    }
  }

  function refreshLayers() {
    if (!state.deck || !state.payload) {
      return;
    }
    state.deck.setProps({ layers: buildLayers(state.payload) });
  }

  function buildLayers(payload) {
    const deckNs = window.deck;
    if (!deckNs) {
      return [];
    }

    const segments = Array.isArray(payload?.segments) ? payload.segments : [];
    const now = Date.now();
    const tenureMin = parseIso(payload?.first_driven_min) ?? now;
    const tenureMax = parseIso(payload?.first_driven_max) ?? now;
    const tenureSpan = Math.max(1, tenureMax - tenureMin);
    const cutoff = state.timeCutoff;
    const hoveredId = state.hoveredSegmentId;
    const selectedId = state.selectedSegmentId;

    // Determine if any recency filter is currently active
    const activeRecencyIndex =
      state.hoveredRecencyIndex !== null
        ? state.hoveredRecencyIndex
        : state.selectedRecencyIndex;

    const visible = [];
    for (const seg of segments) {
      const firstMs = parseIso(seg.first_driven_at);
      if (firstMs === null) {
        continue;
      }
      if (cutoff !== null && firstMs > cutoff) {
        continue;
      }

      const path = Array.isArray(seg.path) ? seg.path : [];
      if (path.length < 2) {
        continue;
      }

      const lastMs = parseIso(seg.last_driven_at) ?? firstMs;
      const mid = midpointOfPath(path);
      if (!mid) {
        continue;
      }

      // Tenure: how long the street has been part of the city (0..1)
      const tenureRatio = clamp((firstMs - tenureMin) / tenureSpan, 0, 1);
      // Invert so older streets are TALLER (more established)
      const heightRatio = 1 - tenureRatio;
      const height =
        MIN_COLUMN_HEIGHT_M + heightRatio * (MAX_COLUMN_HEIGHT_M - MIN_COLUMN_HEIGHT_M);

      const daysSinceDriven = Math.max(0, (now - lastMs) / DAY_MS);
      const color = recencyColor(daysSinceDriven);

      visible.push({
        segmentId: seg.segment_id,
        streetName: seg.street_name || "Unnamed street",
        highwayType: seg.highway_type || "unclassified",
        lengthMiles: seg.length_miles || 0,
        firstDrivenMs: firstMs,
        lastDrivenMs: lastMs,
        daysSinceDriven,
        height,
        path,
        midpoint: mid,
        color,
      });
    }

    const layers = [];

    // Glow underlay — wider, translucent trace beneath the bright thread.
    layers.push(
      new deckNs.PathLayer({
        id: "memory-city-path-glow",
        data: visible,
        pickable: false,
        widthUnits: "pixels",
        getPath: (d) => d.path,
        getColor: (d) => {
          const isDimmed =
            activeRecencyIndex !== null &&
            getRecencyBucketIndex(d.daysSinceDriven) !== activeRecencyIndex;
          const alpha = isDimmed ? 6 : 46;
          return [d.color[0], d.color[1], d.color[2], alpha];
        },
        getWidth: 8,
        widthMinPixels: 4,
        widthMaxPixels: 16,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        updateTriggers: {
          getColor: [activeRecencyIndex],
        },
      })
    );

    // Main thread — crisp glowing line on the ground plane.
    layers.push(
      new deckNs.PathLayer({
        id: "memory-city-path",
        data: visible,
        pickable: true,
        widthUnits: "pixels",
        getPath: (d) => d.path,
        getColor: (d) => {
          const isDimmed =
            activeRecencyIndex !== null &&
            getRecencyBucketIndex(d.daysSinceDriven) !== activeRecencyIndex;
          const alpha = isDimmed ? 20 : 215;
          if (d.segmentId === selectedId) {
            return [255, 255, 255, isDimmed ? 80 : 240];
          }
          if (d.segmentId === hoveredId) {
            return [255, 255, 255, isDimmed ? 70 : 210];
          }
          return [d.color[0], d.color[1], d.color[2], alpha];
        },
        getWidth: PATH_GLOW_WIDTH_MIN_PX + 0.8,
        widthMinPixels: PATH_GLOW_WIDTH_MIN_PX,
        widthMaxPixels: PATH_GLOW_WIDTH_MAX_PX,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        updateTriggers: {
          getColor: [hoveredId, selectedId, activeRecencyIndex],
        },
      })
    );

    // 3D columns at segment midpoints — ColumnLayer supports a constant radius
    // per layer, so split by road class to keep road-type sizing.
    const columnGroups = new Map();
    for (const segment of visible) {
      const radius = getColumnRadiusForHighwayType(segment.highwayType);
      if (!columnGroups.has(radius)) {
        columnGroups.set(radius, []);
      }
      columnGroups.get(radius).push(segment);
    }

    for (const [radius, data] of columnGroups.entries()) {
      layers.push(
        new deckNs.ColumnLayer({
          id: `memory-city-columns-${radius}`,
          data,
          pickable: true,
          diskResolution: 16,
          radius,
          extruded: true,
          elevationScale: 1,
          getPosition: (d) => d.midpoint,
          getElevation: (d) => d.height,
          getFillColor: (d) => {
            const isDimmed =
              activeRecencyIndex !== null &&
              getRecencyBucketIndex(d.daysSinceDriven) !== activeRecencyIndex;
            const alpha = isDimmed ? 15 : 190;
            const [r, g, b] = d.color;
            if (d.segmentId === selectedId) {
              return [255, 255, 255, isDimmed ? 80 : 240];
            }
            if (d.segmentId === hoveredId) {
              return [r, g, b, isDimmed ? 25 : 235];
            }
            return [r, g, b, alpha];
          },
          getLineColor: (d) => {
            const isDimmed =
              activeRecencyIndex !== null &&
              getRecencyBucketIndex(d.daysSinceDriven) !== activeRecencyIndex;
            const alpha = isDimmed ? 20 : 220;
            const [r, g, b] = d.color;
            return [
              Math.min(255, r + 35),
              Math.min(255, g + 35),
              Math.min(255, b + 35),
              alpha,
            ];
          },
          material: {
            ambient: 0.35,
            diffuse: 0.75,
            shininess: 140,
            specularColor: [220, 220, 240],
          },
          updateTriggers: {
            getFillColor: [hoveredId, selectedId, activeRecencyIndex],
            getLineColor: [hoveredId, selectedId, activeRecencyIndex],
          },
        })
      );
    }

    return layers;
  }

  function onSculptureHover(info) {
    const nextId = info?.object?.segmentId ?? null;
    if (nextId === state.hoveredSegmentId) {
      return;
    }
    state.hoveredSegmentId = nextId;
    refreshLayers();
  }

  function onSculptureClick(info) {
    const nextId = info?.object?.segmentId ?? null;
    if (!nextId) {
      state.selectedSegmentId = null;
      renderDetailEmpty();
      refreshLayers();
      return;
    }
    state.selectedSegmentId = nextId;
    renderDetailForSegment(info.object);
    refreshLayers();
  }

  function buildTooltip(info) {
    const obj = info?.object;
    if (!obj) {
      return null;
    }
    const recency = formatRelativeDays(obj.daysSinceDriven);
    return {
      className: "memory-city-tooltip",
      html: `
        <strong>${escapeHtml(obj.streetName)}</strong><br>
        <span style="opacity:.78">${escapeHtml(recency)} · ${obj.lengthMiles.toFixed(2)} mi</span>
      `,
    };
  }

  // ===========================================================================
  // Detail panel
  // ===========================================================================

  function renderDetailEmpty() {
    if (!elements.detail) {
      return;
    }
    elements.detail.classList.remove("is-locked");
    elements.detail.style.removeProperty("--detail-glow-color-rgb");
    elements.detail.innerHTML = `
      <div class="memory-city-detail-empty">
        <i class="fas fa-hand-pointer" aria-hidden="true"></i>
        <span>Hover a thread to inspect a street</span>
      </div>
    `;
  }

  function renderDetailForSegment(segObj) {
    if (!elements.detail || !segObj) {
      return;
    }
    elements.detail.classList.add("is-locked");

    // Set custom glow color matching the recency of the selected segment
    if (Array.isArray(segObj.color)) {
      elements.detail.style.setProperty(
        "--detail-glow-color-rgb",
        segObj.color.join(", ")
      );
    } else {
      elements.detail.style.removeProperty("--detail-glow-color-rgb");
    }

    const heightFt = Math.round(segObj.height * 3.281);
    elements.detail.innerHTML = `
      <button type="button" class="memory-city-detail-close" aria-label="Clear selection">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
      <div class="memory-city-detail-label">Street</div>
      <h3 class="memory-city-detail-name">${escapeHtml(segObj.streetName)}</h3>
      <dl>
        <div class="memory-city-detail-row">
          <dt>First driven</dt>
          <dd>${escapeHtml(formatDate(segObj.firstDrivenMs))}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Last driven</dt>
          <dd>${escapeHtml(formatRelativeDays(segObj.daysSinceDriven))}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Length</dt>
          <dd>${segObj.lengthMiles.toFixed(2)} mi</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Monument height</dt>
          <dd>${heightFt.toLocaleString()} ft</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Type</dt>
          <dd>${escapeHtml(segObj.highwayType.replace(/_/g, " "))}</dd>
        </div>
      </dl>
      <a href="/map?lat=${segObj.midpoint[1]}&lng=${segObj.midpoint[0]}&zoom=16" class="memory-city-detail-map-link" target="_blank">
        <i class="fas fa-external-link-alt" aria-hidden="true"></i> View on Main Map
      </a>
    `;
    const closeBtn = elements.detail.querySelector(".memory-city-detail-close");
    if (closeBtn) {
      closeBtn.addEventListener(
        "click",
        () => {
          state.selectedSegmentId = null;
          renderDetailEmpty();
          refreshLayers();
        },
        signal ? { signal } : false
      );
    }
  }

  // ===========================================================================
  // Overlay state
  // ===========================================================================

  function setState(kind, text) {
    const overlay = elements.stateOverlay;
    if (!overlay) {
      return;
    }
    overlay.classList.remove("is-error");
    if (kind === "hidden") {
      overlay.classList.add("is-hidden");
      return;
    }
    overlay.classList.remove("is-hidden");
    if (kind === "error") {
      overlay.classList.add("is-error");
    }
    const t = overlay.querySelector(".memory-city-state-text");
    if (t) {
      t.textContent = text || "";
    }
  }

  // ===========================================================================
  // Camera presets
  // ===========================================================================

  function setCameraPreset(mode) {
    if (!state.deck || !state.viewState) {
      return;
    }

    if (state.autoRotate) {
      stopAutoRotate();
    }

    const targetViewState = { ...state.viewState };

    if (mode === "cinematic") {
      targetViewState.pitch = 55;
      targetViewState.bearing = -18;
    } else if (mode === "blueprint") {
      targetViewState.pitch = 0;
      targetViewState.bearing = 0;
    } else if (mode === "horizon") {
      targetViewState.pitch = 75;
      targetViewState.bearing = -45;
    }

    targetViewState.transitionDuration = 1000;

    if (window.deck?.FlyToInterpolator) {
      targetViewState.transitionInterpolator = new window.deck.FlyToInterpolator();
    }

    updateViewState(targetViewState);
    updateCameraPresetActiveStates(mode);
  }

  function updateCameraPresetActiveStates(activeMode) {
    const presets = ["cinematic", "blueprint", "horizon"];
    presets.forEach((mode) => {
      const btn = elements[`cam${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`];
      if (btn) {
        btn.setAttribute("aria-pressed", mode === activeMode ? "true" : "false");
      }
    });
  }

  // ===========================================================================
  // Interactive Legend
  // ===========================================================================

  function buildLegendRecency() {
    const container = document.getElementById("memory-city-legend-recency");
    if (!container) {
      return;
    }

    container.innerHTML = "";

    const labelSpan = document.createElement("span");
    labelSpan.className = "memory-city-legend-label";
    labelSpan.textContent = "Color = recency:";
    container.appendChild(labelSpan);

    const swatchesWrap = document.createElement("div");
    swatchesWrap.className = "memory-city-legend-swatches";

    const labels = [
      "Today",
      "< 1 Week",
      "< 1 Month",
      "< 3 Months",
      "< 6 Months",
      "< 1 Year",
      "Older",
    ];

    RECENCY_STOPS.forEach(([threshold, rgb], index) => {
      const swatch = document.createElement("span");
      swatch.className = "mc-legend-swatch";
      if (state.selectedRecencyIndex === index) {
        swatch.classList.add("is-active");
      }
      const colorStr = `rgb(${rgb.join(",")})`;
      swatch.style.backgroundColor = colorStr;
      swatch.style.color = colorStr;
      swatch.title = labels[index] || "Older";
      swatch.dataset.index = index;

      swatch.addEventListener("mouseenter", () => highlightRecencyBucket(index));
      swatch.addEventListener("mouseleave", () => clearRecencyHighlight());
      swatch.addEventListener("click", () => toggleRecencyFilter(index, swatch));

      swatchesWrap.appendChild(swatch);
    });

    container.appendChild(swatchesWrap);
  }

  function highlightRecencyBucket(index) {
    state.hoveredRecencyIndex = index;
    refreshLayers();
  }

  function clearRecencyHighlight() {
    state.hoveredRecencyIndex = null;
    refreshLayers();
  }

  function toggleRecencyFilter(index, el) {
    const alreadySelected = state.selectedRecencyIndex === index;
    state.selectedRecencyIndex = alreadySelected ? null : index;

    const container = document.getElementById("memory-city-legend-recency");
    if (container) {
      container.querySelectorAll(".mc-legend-swatch").forEach((sw) => {
        sw.classList.remove("is-active");
      });
      if (!alreadySelected && el) {
        el.classList.add("is-active");
      }
    }
    refreshLayers();
  }

  // ===========================================================================
  // Real-time Dynamic Stats Calculation
  // ===========================================================================

  function updateDynamicStats(cutoff) {
    if (!state.payload || !Array.isArray(state.payload.segments)) {
      return;
    }

    let activeSegments = 0;
    let activeMiles = 0;

    for (const seg of state.payload.segments) {
      const firstMs = parseIso(seg.first_driven_at);
      if (firstMs === null) {
        continue;
      }
      if (cutoff !== null && firstMs > cutoff) {
        continue;
      }

      activeSegments += 1;
      activeMiles += seg.length_miles || 0;
    }

    const formattedSegments = formatInt(activeSegments);
    const formattedMiles = formatMiles(activeMiles);

    const area = state.payload.area || {};
    let formattedPercent = "—";
    if (Number.isFinite(area.coverage_percentage) && area.coverage_percentage > 0) {
      const totalMiles = area.driven_length_miles / (area.coverage_percentage / 100);
      const activeCoverage = totalMiles > 0 ? (activeMiles / totalMiles) * 100 : 0;
      formattedPercent = formatPercent(activeCoverage);
    }

    updateStatElement(elements.statSegments, formattedSegments);
    updateStatElement(elements.statMiles, formattedMiles);
    updateStatElement(elements.statPercent, formattedPercent);
  }

  function updateStatElement(el, nextValue) {
    if (!el) {
      return;
    }
    if (el.textContent === nextValue) {
      return;
    }

    el.textContent = nextValue;

    el.classList.remove("is-updating");
    void el.offsetWidth; // Force reflow
    el.classList.add("is-updating");
  }
}

// ============================================================================
// Helpers (pure)
// ============================================================================

function getRecencyBucketIndex(daysSinceDriven) {
  for (let i = 0; i < RECENCY_STOPS.length; i++) {
    if (daysSinceDriven <= RECENCY_STOPS[i][0]) {
      return i;
    }
  }
  return RECENCY_STOPS.length - 1;
}

function getColumnRadiusForHighwayType(highwayType) {
  const type = String(highwayType || "").toLowerCase();
  if (type.includes("motorway") || type.includes("trunk")) {
    return 22;
  }
  if (type.includes("primary") || type.includes("secondary")) {
    return 16;
  }
  if (type.includes("tertiary")) {
    return 12;
  }
  return 8;
}

function parseIso(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function midpointOfPath(path) {
  if (!Array.isArray(path) || path.length < 2) {
    return null;
  }
  // Use the geometric midpoint along the polyline rather than the centroid,
  // so long curved streets place their "monument" on the road itself.
  const segmentLengths = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    const len = Math.hypot(dx, dy);
    segmentLengths.push(len);
    total += len;
  }
  if (total === 0) {
    return [Number(path[0][0]), Number(path[0][1])];
  }
  const target = total / 2;
  let acc = 0;
  for (let i = 0; i < segmentLengths.length; i += 1) {
    const segLen = segmentLengths[i];
    if (acc + segLen >= target) {
      const remainder = target - acc;
      const t = segLen > 0 ? remainder / segLen : 0;
      const a = path[i];
      const b = path[i + 1];
      return [Number(a[0]) + (b[0] - a[0]) * t, Number(a[1]) + (b[1] - a[1]) * t];
    }
    acc += segLen;
  }
  const last = path[path.length - 1];
  return [Number(last[0]), Number(last[1])];
}

function recencyColor(daysSinceDriven) {
  for (const [threshold, rgb] of RECENCY_STOPS) {
    if (daysSinceDriven <= threshold) {
      return rgb;
    }
  }
  return RECENCY_STOPS[RECENCY_STOPS.length - 1][1];
}

function clamp(n, min, max) {
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}

function formatInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return Math.round(n).toLocaleString();
}

function formatMiles(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return `${n.toFixed(1)} mi`;
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return `${n.toFixed(1)}%`;
}

function formatDate(value) {
  const ts = parseIso(value);
  if (ts === null) {
    return "—";
  }
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRelativeDays(days) {
  if (!Number.isFinite(days)) {
    return "—";
  }
  if (days < 1) {
    return "driven today";
  }
  if (days < 2) {
    return "driven yesterday";
  }
  if (days < 7) {
    return `driven ${Math.round(days)} days ago`;
  }
  if (days < 30) {
    return `driven ${Math.round(days / 7)} weeks ago`;
  }
  if (days < 365) {
    return `driven ${Math.round(days / 30)} months ago`;
  }
  return `driven ${(days / 365).toFixed(1)} years ago`;
}

function setText(el, value) {
  if (el) {
    el.textContent = value ?? "—";
  }
}

/**
 * Combine multiple AbortSignals into one. Resolves on first abort.
 */
function anySignal(signals) {
  const controller = new AbortController();
  for (const sig of signals) {
    if (!sig) {
      continue;
    }
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
