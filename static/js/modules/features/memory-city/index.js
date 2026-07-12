/**
 * Memory City — your driving history as a sculpture of strata.
 *
 * The vertical axis is time. Every driven street floats at the altitude
 * of the moment it joined your city: ground level is the day you laid
 * the founding stone, the summit is your newest street. Eras of heavy
 * building read as dense bands; quiet seasons read as air between them.
 * Undriven roads do not exist in this view.
 *
 * Rendered with deck.gl:
 *   - ground shadow (PathLayer at z=0): the street plan, dimmed
 *   - strata threads (PathLayer at founding altitude): the sculpture
 *   - a glow underlay, a survey line at the timeline cutoff, and a
 *     plumb line dropped from the selected street to its shadow
 *
 * The timeline scrubber and timelapse run in a blended progress domain
 * (calendar time × founding order) computed in strata.js, and use
 * deck.gl's DataFilterExtension when available so playback never
 * rebuilds geometry. Lenses recolor the same sculpture by recency,
 * chapter, or whether you ever returned to a street.
 */

import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";
import { escapeHtml, isAbortError } from "../../utils.js";
import {
  RECENCY_LABELS,
  RECENCY_STOPS,
  clamp,
  parseIso,
  prepareModel,
  progressIndex,
  recencyBucketIndex,
  searchStreets,
} from "./strata.js";

const SCRUBBER_MAX = 1000;

// Alphas for the three visual states of a thread.
const ALPHA = {
  strata: 210,
  strataDim: 16,
  glow: 44,
  glowDim: 5,
  shadow: 60,
  shadowDim: 8,
};

// Fallback categorical palette (cobalt, ochre, steel, coral, slate,
// purple) — matches the survey tokens in variables.css and is replaced
// by the live token values at runtime.
const CAT_FALLBACK = [
  [111, 143, 206],
  [212, 162, 74],
  [98, 144, 173],
  [196, 112, 80],
  [114, 122, 132],
  [138, 122, 176],
];

const LENSES = {
  recency: {
    label: "Last driven",
    caption: "Color — when you last drove it",
  },
  chapter: {
    label: "Chapter",
    caption: "Color — the era that built it",
  },
  loyalty: {
    label: "Revisits",
    caption: "Color — whether you ever came back",
  },
};

const CAMERA_PRESETS = {
  cinematic: { pitch: 55, bearing: -18 },
  blueprint: { pitch: 0, bearing: 0 },
  horizon: { pitch: 74, bearing: -45 },
};

const DEFAULT_VIEW_STATE = Object.freeze({
  longitude: -97.14,
  latitude: 31.55,
  zoom: 11.5,
  pitch: CAMERA_PRESETS.cinematic.pitch,
  bearing: CAMERA_PRESETS.cinematic.bearing,
});

export default async function initMemoryCityPage(ctx = {}) {
  const { signal, onCleanup } = ctx;
  const registerCleanup = typeof onCleanup === "function" ? onCleanup : () => {};

  const state = {
    areas: [],
    selectedAreaId: null,
    area: null, // area summary from the payload
    model: null, // prepared strata model (see strata.js)
    lens: "recency",
    legendHover: null, // bucket index under the pointer
    legendSelected: null, // sticky bucket filter
    focusStreet: null, // name-index entry from search / records
    selected: null, // selected segment (model object)
    colorRev: 0, // bumped whenever thread colors must recompute
    progressValue: 1, // timeline position in [0, 1]
    cutIndex: -1, // last visible segment index
    cpuVisible: null, // CPU fallback when DataFilterExtension is absent
    deck: null,
    filterExt: null,
    viewState: null,
    isPlaying: false,
    playRaf: null,
    cinemaRotate: false,
    autoRotate: false,
    rotateRaf: null,
    inflight: null,
    searchTimer: null,
    searchResults: [],
    searchActive: -1,
    pendingCapture: null,
    palette: null,
    reducedMotion:
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    view: $("memory-city"),
    canvas: $("memory-city-canvas"),
    title: $("memory-city-title"),
    subtitle: $("memory-city-subtitle"),
    areaSelect: $("memory-city-area-select"),
    statSegments: $("mc-stat-segments"),
    statMiles: $("mc-stat-miles"),
    statPercent: $("mc-stat-percent"),
    statFirst: $("mc-stat-first"),
    records: $("memory-city-records"),
    recordsList: $("mc-records-list"),
    searchWrap: $("memory-city-search"),
    searchInput: $("mc-search-input"),
    searchClear: $("mc-search-clear"),
    searchResults: $("mc-search-results"),
    scrubber: $("memory-city-scrubber"),
    scrubberTicks: $("mc-scrubber-ticks"),
    scrubberMin: $("mc-scrubber-min"),
    scrubberMax: $("mc-scrubber-max"),
    scrubberCurrent: $("mc-scrubber-current"),
    playBtn: $("memory-city-play"),
    chapters: $("memory-city-chapters"),
    lens: $("memory-city-lens"),
    legend: $("memory-city-legend"),
    legendCaption: $("mc-legend-caption"),
    resetCamBtn: $("memory-city-reset-cam"),
    spinBtn: $("memory-city-toggle-spin"),
    camCinematicBtn: $("memory-city-cam-cinematic"),
    camBlueprintBtn: $("memory-city-cam-blueprint"),
    camHorizonBtn: $("memory-city-cam-horizon"),
    postcardBtn: $("memory-city-postcard"),
    detail: $("memory-city-detail"),
    stateOverlay: $("memory-city-state"),
  };

  if (!elements.view || !elements.canvas) {
    return;
  }

  await ensureDeckLoaded();
  if (signal?.aborted) {
    return;
  }

  resolvePalette();
  bindEvents();
  renderLensControl();
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
    addListener(elements.postcardBtn, "click", savePostcard);

    addListener(elements.searchInput, "input", onSearchInput);
    addListener(elements.searchInput, "keydown", onSearchKeydown);
    addListener(elements.searchClear, "click", () => clearStreetFocus(true));
    addListener(document, "click", (event) => {
      if (elements.searchWrap && !elements.searchWrap.contains(event.target)) {
        closeSearchResults();
      }
    });

    addListener(document, "keydown", onGlobalKeydown);
    addListener(document, "themeChanged", onThemeChanged);

    if (signal) {
      signal.addEventListener("abort", teardown, { once: true });
    }
  }

  function onGlobalKeydown(event) {
    if (event.code !== "Space" || event.repeat) {
      return;
    }
    const target = event.target;
    const tag = target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "BUTTON" ||
      target?.isContentEditable
    ) {
      return;
    }
    event.preventDefault();
    togglePlay();
  }

  function teardown() {
    stopPlay();
    stopAutoRotate();
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
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
  // Theme palette
  // ===========================================================================

  function resolvePalette() {
    const styles = getComputedStyle(document.documentElement);
    const light = document.documentElement.classList.contains("light-mode");

    const readRgbToken = (token, fallback) => {
      const raw = styles.getPropertyValue(token).trim();
      const parts = raw
        .split(/[\s,/]+/)
        .map(Number)
        .filter(Number.isFinite);
      return parts.length >= 3 ? parts.slice(0, 3) : fallback;
    };

    const readHexToken = (token, fallback) => {
      const raw = styles.getPropertyValue(token).trim();
      const match = /^#([0-9a-f]{6})$/i.exec(raw);
      if (!match) {
        return fallback;
      }
      const value = match[1];
      return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
    };

    // On paper (light mode) the luminous ramp must become ink: darken
    // every thread color so hairlines keep contrast.
    const inkFactor = light ? 0.66 : 1;
    const ink = (rgb) => rgb.map((c) => Math.round(c * inkFactor));

    const cat = [
      readRgbToken("--cat-cobalt-rgb", CAT_FALLBACK[0]),
      readRgbToken("--cat-ochre-rgb", CAT_FALLBACK[1]),
      readRgbToken("--cat-steel-rgb", CAT_FALLBACK[2]),
      readRgbToken("--cat-coral-rgb", CAT_FALLBACK[3]),
      readRgbToken("--cat-slate-rgb", CAT_FALLBACK[4]),
      readRgbToken("--cat-purple-rgb", CAT_FALLBACK[5]),
    ].map(ink);

    const sky = readHexToken("--surface-deep", light ? [252, 251, 247] : [5, 5, 7]);

    state.palette = {
      light,
      clearColor: [sky[0] / 255, sky[1] / 255, sky[2] / 255, 1],
      action: readRgbToken("--action-rgb", light ? [38, 36, 31] : [237, 234, 224]),
      survey: readRgbToken("--warning-rgb", CAT_FALLBACK[1]),
      ramp: RECENCY_STOPS.map(([, rgb]) => ink(rgb)),
      cat,
      shadowAlpha: light ? 84 : ALPHA.shadow,
    };
  }

  function onThemeChanged() {
    resolvePalette();
    if (state.deck) {
      state.deck.setProps({ parameters: { clearColor: state.palette.clearColor } });
    }
    bumpColors();
    renderLegend();
    renderRecords();
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

    stopPlay();
    setState("loading", "Summoning your city…");

    try {
      const payload = await apiClient.get(
        `/api/coverage/areas/${encodeURIComponent(areaId)}/memory-city`,
        { signal: composite, cache: false }
      );

      if (composite.aborted) {
        return;
      }

      state.area = payload?.area || null;
      state.selected = null;
      state.focusStreet = null;
      state.legendHover = null;
      state.legendSelected = null;
      state.searchResults = [];
      syncSelectedAreaOption(state.area);
      if (elements.searchInput) {
        elements.searchInput.value = "";
      }
      closeSearchResults();

      state.model = prepareModel(payload);
      bumpColors();

      if (!state.model) {
        elements.view.classList.add("is-empty");
        renderHeader();
        renderStats();
        renderRecords();
        configureTimeline();
        renderChapters();
        renderLegend();
        renderDetailEmpty();
        if (state.deck) {
          state.deck.setProps({ layers: [] });
        }
        setState("empty", "This area has no driven streets yet. Drive something!");
        return;
      }

      elements.view.classList.remove("is-empty");
      state.progressValue = 1;
      state.cutIndex = state.model.count - 1;
      state.cpuVisible = state.model.segments;

      renderHeader();
      renderStats();
      renderRecords();
      configureTimeline();
      renderChapters();
      renderLensControl();
      renderLegend();
      renderDetailEmpty();
      buildSculpture();
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
  // Header + stats
  // ===========================================================================

  function renderHeader() {
    const area = state.area || {};
    if (elements.title) {
      elements.title.textContent = area.display_name || "Memory City";
    }
    if (elements.subtitle) {
      elements.subtitle.textContent = buildSubtitle();
    }
  }

  function buildSubtitle() {
    const model = state.model;
    if (!model) {
      return "A sculpture of the streets you've driven. This area is empty so far.";
    }
    const founded = new Date(model.firstMs).getFullYear();
    return (
      `${formatInt(model.count)} streets stacked in founding order — ` +
      `ground level is ${founded}, the summit is your newest street. ` +
      "Scrub the timeline to watch the city accrete."
    );
  }

  function renderStats() {
    const model = state.model;
    const area = state.area || {};
    if (!model) {
      setText(elements.statSegments, formatInt(area.driven_segments ?? 0));
      setText(elements.statMiles, formatMiles(area.driven_length_miles ?? 0));
      setText(elements.statPercent, formatPercent(area.coverage_percentage));
      setText(elements.statFirst, "—");
      return;
    }
    updateLiveStats();
    setText(elements.statFirst, formatDate(model.firstMs));
  }

  function updateLiveStats() {
    const model = state.model;
    if (!model) {
      return;
    }
    const count = state.cutIndex + 1;
    const miles = model.prefixMiles[count];

    updateStatElement(elements.statSegments, formatInt(count));
    updateStatElement(elements.statMiles, formatMiles(miles));

    const area = state.area || {};
    let percentLabel = "—";
    if (
      Number.isFinite(area.coverage_percentage) &&
      area.coverage_percentage > 0 &&
      area.driven_length_miles > 0
    ) {
      const totalAreaMiles =
        area.driven_length_miles / (area.coverage_percentage / 100);
      percentLabel = formatPercent(
        totalAreaMiles > 0 ? (miles / totalAreaMiles) * 100 : 0
      );
    }
    updateStatElement(elements.statPercent, percentLabel);
  }

  function updateStatElement(el, nextValue) {
    if (!el || el.textContent === nextValue) {
      return;
    }
    el.textContent = nextValue;
    el.classList.remove("is-updating");
    void el.offsetWidth; // restart the pulse animation
    el.classList.add("is-updating");
  }

  // ===========================================================================
  // Timeline (scrubber + timelapse)
  // ===========================================================================

  function configureTimeline() {
    const model = state.model;
    const usable = Boolean(model && model.count > 1 && model.lastMs > model.firstMs);

    if (elements.scrubber) {
      elements.scrubber.disabled = !usable;
      elements.scrubber.value = String(SCRUBBER_MAX);
    }
    if (elements.playBtn) {
      elements.playBtn.disabled = !usable;
    }

    if (!usable) {
      setText(elements.scrubberMin, "—");
      setText(elements.scrubberMax, "—");
      setText(
        elements.scrubberCurrent,
        model ? `now · ${formatDate(model.lastMs)}` : "—"
      );
      setScrubberProgress(100);
      renderScrubberTicks();
      return;
    }

    setText(elements.scrubberMin, formatDate(model.firstMs));
    setText(elements.scrubberMax, formatDate(model.lastMs));
    setText(elements.scrubberCurrent, `now · ${formatDate(model.lastMs)}`);
    setScrubberProgress(100);
    renderScrubberTicks();
  }

  function renderScrubberTicks() {
    const container = elements.scrubberTicks;
    if (!container) {
      return;
    }
    container.innerHTML = "";
    const model = state.model;
    if (!model || model.chapters.length < 2) {
      return;
    }
    for (const chapter of model.chapters) {
      if (chapter.index === 0) {
        continue;
      }
      const tick = document.createElement("span");
      tick.className = "mc-scrubber-tick";
      tick.style.left = `${(chapter.startProgress * 100).toFixed(2)}%`;
      tick.title = `Ch. ${chapter.numeral} · ${chapter.dateLabel}`;
      container.appendChild(tick);
    }
  }

  function onScrubberInput(event) {
    if (state.isPlaying) {
      stopPlay();
    }
    applyProgress(Number(event.target.value) / SCRUBBER_MAX);
  }

  function applyProgress(value) {
    const model = state.model;
    if (!model) {
      return;
    }
    state.progressValue = clamp(value, 0, 1);
    state.cutIndex = progressIndex(model.progress, state.progressValue);
    if (!state.filterExt) {
      state.cpuVisible = model.segments.slice(0, state.cutIndex + 1);
    } else {
      state.cpuVisible = model.segments;
    }

    const complete = state.cutIndex >= model.count - 1 && state.progressValue >= 1;
    let label;
    if (complete) {
      label = `now · ${formatDate(model.lastMs)}`;
    } else {
      const seg = model.segments[state.cutIndex];
      const chapter = model.chapters[seg.chapterIndex];
      label =
        model.chapters.length > 1 && chapter
          ? `${formatDate(seg.firstMs)} · Ch. ${chapter.numeral}`
          : formatDate(seg.firstMs);
    }
    setText(elements.scrubberCurrent, label);
    setScrubberProgress(state.progressValue * 100);
    updateLiveStats();
    updateActiveChapterChip();
    refreshLayers();
  }

  function setScrubberProgress(percent) {
    if (elements.scrubber) {
      elements.scrubber.style.setProperty(
        "--mc-scrubber-progress",
        `${clamp(percent, 0, 100)}%`
      );
    }
  }

  function togglePlay() {
    if (state.isPlaying) {
      stopPlay();
    } else {
      startPlay(0, 1);
    }
  }

  function startPlay(fromV, toV, durationMs) {
    const model = state.model;
    if (!model || model.count < 2 || elements.playBtn?.disabled) {
      return;
    }
    stopPlay();
    state.isPlaying = true;
    elements.playBtn?.classList.add("is-playing");
    setPlayIcon(true);
    elements.playBtn?.setAttribute("aria-label", "Pause timelapse");

    const duration =
      durationMs ?? clamp(8000 + model.count / 3, 9000, 16_000);

    if (!state.reducedMotion && !state.autoRotate) {
      state.cinemaRotate = true;
      startAutoRotate(2.4);
    }

    const start = performance.now();
    const step = (now) => {
      if (!state.isPlaying) {
        return;
      }
      const r = clamp((now - start) / duration, 0, 1);
      const v = fromV + (toV - fromV) * r;
      if (elements.scrubber) {
        elements.scrubber.value = String(Math.round(v * SCRUBBER_MAX));
      }
      applyProgress(v);
      if (r >= 1) {
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
    if (state.cinemaRotate) {
      state.cinemaRotate = false;
      stopAutoRotate();
    }
    state.isPlaying = false;
    elements.playBtn?.classList.remove("is-playing");
    setPlayIcon(false);
    elements.playBtn?.setAttribute("aria-label", "Play timelapse");
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
  // Chapters
  // ===========================================================================

  function renderChapters() {
    const container = elements.chapters;
    if (!container) {
      return;
    }
    container.innerHTML = "";
    const model = state.model;
    const chapters = model?.chapters || [];
    container.classList.toggle("is-hidden", chapters.length < 2);
    if (chapters.length < 2) {
      return;
    }

    for (const chapter of chapters) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mc-chapter";
      btn.dataset.chapter = String(chapter.index);
      btn.title = `Replay chapter ${chapter.numeral} — ${chapter.dateLabel}`;
      btn.innerHTML = `
        <span class="mc-chapter-numeral">${chapter.numeral}</span>
        <span class="mc-chapter-body">
          <span class="mc-chapter-dates">${escapeHtml(chapter.dateLabel)}</span>
          <span class="mc-chapter-count">${formatInt(chapter.count)} streets · ${formatMiles(chapter.miles)}</span>
        </span>
        <i class="fas fa-play mc-chapter-play" aria-hidden="true"></i>
      `;
      btn.addEventListener("click", () => playChapter(chapter), signal ? { signal } : false);
      container.appendChild(btn);
    }
    updateActiveChapterChip();
  }

  function playChapter(chapter) {
    const model = state.model;
    if (!model) {
      return;
    }
    const from = chapter.startProgress;
    const to = Math.min(1, chapter.endProgress + 0.002);
    const duration = clamp(1400 + chapter.count * 1.2, 1800, 6000);
    startPlay(from, to, duration);
  }

  function updateActiveChapterChip() {
    const container = elements.chapters;
    const model = state.model;
    if (!container || !model) {
      return;
    }
    const complete = state.progressValue >= 1;
    const seg = model.segments[state.cutIndex];
    const activeIndex = !complete && seg ? seg.chapterIndex : null;
    for (const btn of container.querySelectorAll(".mc-chapter")) {
      btn.classList.toggle(
        "is-active",
        activeIndex !== null && Number(btn.dataset.chapter) === activeIndex
      );
    }
  }

  // ===========================================================================
  // Lenses + legend
  // ===========================================================================

  function renderLensControl() {
    const container = elements.lens;
    if (!container) {
      return;
    }
    container.innerHTML = "";
    const chapterCount = state.model?.chapters?.length ?? 0;

    for (const [key, def] of Object.entries(LENSES)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.lens = key;
      btn.textContent = def.label;
      btn.setAttribute("aria-pressed", state.lens === key ? "true" : "false");
      if (key === "chapter" && chapterCount < 2) {
        btn.disabled = true;
        btn.title = "This city was built in a single chapter";
      }
      btn.addEventListener("click", () => setLens(key), signal ? { signal } : false);
      container.appendChild(btn);
    }
  }

  function setLens(lens) {
    if (!LENSES[lens] || state.lens === lens) {
      return;
    }
    state.lens = lens;
    state.legendHover = null;
    state.legendSelected = null;
    for (const btn of elements.lens?.querySelectorAll("button") || []) {
      btn.setAttribute("aria-pressed", btn.dataset.lens === lens ? "true" : "false");
    }
    renderLegend();
    bumpColors();
    refreshLayers();
  }

  function legendItems() {
    const model = state.model;
    const palette = state.palette;
    if (!palette) {
      return [];
    }
    if (state.lens === "chapter") {
      return (model?.chapters || []).map((chapter) => ({
        bucket: chapter.index,
        color: palette.cat[chapter.index % palette.cat.length],
        label: `Ch. ${chapter.numeral}`,
        title: `${chapter.dateLabel} · ${formatInt(chapter.count)} streets`,
      }));
    }
    if (state.lens === "loyalty") {
      return [
        {
          bucket: 0,
          color: palette.cat[0],
          label: "Returned to",
          title: "Streets you have driven again since first meeting them",
        },
        {
          bucket: 1,
          color: palette.cat[3],
          label: "Met once",
          title: "Streets you have only ever driven once",
        },
      ];
    }
    return RECENCY_LABELS.map((label, index) => ({
      bucket: index,
      color: palette.ramp[index],
      label,
      title: label,
    }));
  }

  function renderLegend() {
    const container = elements.legend;
    if (!container) {
      return;
    }
    container.innerHTML = "";
    if (elements.legendCaption) {
      elements.legendCaption.textContent = LENSES[state.lens].caption;
    }

    for (const item of legendItems()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mc-legend-chip";
      chip.title = item.title;
      chip.setAttribute(
        "aria-pressed",
        state.legendSelected === item.bucket ? "true" : "false"
      );
      const [r, g, b] = item.color;
      chip.innerHTML = `
        <span class="mc-legend-chip-swatch" style="background: rgb(${r} ${g} ${b})" aria-hidden="true"></span>
        <span class="mc-legend-chip-label">${escapeHtml(item.label)}</span>
      `;
      const opts = signal ? { signal } : false;
      chip.addEventListener(
        "mouseenter",
        () => {
          state.legendHover = item.bucket;
          bumpColors();
          refreshLayers();
        },
        opts
      );
      chip.addEventListener(
        "mouseleave",
        () => {
          state.legendHover = null;
          bumpColors();
          refreshLayers();
        },
        opts
      );
      chip.addEventListener(
        "click",
        () => {
          setLegendSelected(state.legendSelected === item.bucket ? null : item.bucket);
        },
        opts
      );
      container.appendChild(chip);
    }
  }

  function setLegendSelected(bucket) {
    state.legendSelected = bucket;
    for (const chip of elements.legend?.querySelectorAll(".mc-legend-chip") || []) {
      chip.setAttribute("aria-pressed", "false");
    }
    if (bucket !== null) {
      const items = legendItems();
      const idx = items.findIndex((item) => item.bucket === bucket);
      const chips = elements.legend?.querySelectorAll(".mc-legend-chip");
      if (chips && chips[idx]) {
        chips[idx].setAttribute("aria-pressed", "true");
      }
    }
    bumpColors();
    refreshLayers();
  }

  function bucketOf(seg) {
    if (state.lens === "chapter") {
      return seg.chapterIndex;
    }
    if (state.lens === "loyalty") {
      return seg.revisited ? 0 : 1;
    }
    return recencyBucketIndex(seg.daysSinceDriven);
  }

  function lensColor(seg) {
    const palette = state.palette;
    if (state.lens === "chapter") {
      return palette.cat[seg.chapterIndex % palette.cat.length];
    }
    if (state.lens === "loyalty") {
      return seg.revisited ? palette.cat[0] : palette.cat[3];
    }
    return palette.ramp[recencyBucketIndex(seg.daysSinceDriven)];
  }

  function bumpColors() {
    state.colorRev += 1;
  }

  // ===========================================================================
  // Sculpture (deck.gl)
  // ===========================================================================

  function buildSculpture() {
    const deckNs = window.deck;
    if (!deckNs) {
      setState("error", "3D renderer (deck.gl) failed to load.");
      return;
    }

    if (!state.filterExt && deckNs.DataFilterExtension) {
      state.filterExt = new deckNs.DataFilterExtension({ filterSize: 1 });
    }

    const initial = fitViewToModel() || DEFAULT_VIEW_STATE;
    state.viewState = { ...initial };

    if (!state.deck) {
      state.deck = new deckNs.Deck({
        parent: elements.canvas,
        controller: {
          dragRotate: true,
          touchRotate: true,
          scrollZoom: { smooth: true },
          inertia: 260,
          maxPitch: 85,
        },
        views: new deckNs.MapView({ repeat: false }),
        viewState: state.viewState,
        onViewStateChange: ({ viewState }) => {
          state.viewState = viewState;
          state.deck?.setProps({ viewState });
          if (state.autoRotate && !state.cinemaRotate) {
            stopAutoRotate();
          }
          updateCameraPresetActiveStates(null);
        },
        getTooltip: buildTooltip,
        onClick: onSculptureClick,
        pickingRadius: 5,
        layers: buildLayers(),
        parameters: {
          clearColor: state.palette.clearColor,
        },
        deviceProps: {
          webgl: { preserveDrawingBuffer: true },
        },
        onAfterRender: handleAfterRender,
      });
    } else {
      state.deck.setProps({
        viewState: state.viewState,
        layers: buildLayers(),
        parameters: { clearColor: state.palette.clearColor },
      });
    }
  }

  function refreshLayers() {
    if (!state.deck || !state.model) {
      return;
    }
    state.deck.setProps({ layers: buildLayers() });
  }

  function timeFilterProps() {
    if (!state.filterExt || !state.model) {
      return {};
    }
    const cut = state.cutIndex + 0.5;
    return {
      getFilterValue: (d) => d.rank,
      filterRange: [-1, cut],
      filterSoftRange: [-1, Math.max(-1, cut - state.model.softRanks)],
      extensions: [state.filterExt],
    };
  }

  function buildLayers() {
    const deckNs = window.deck;
    const model = state.model;
    if (!deckNs || !model || !state.palette) {
      return [];
    }

    const palette = state.palette;
    const lens = state.lens;
    const focusName = state.focusStreet?.name || null;
    const selectedId = state.selected?.segmentId || null;
    const activeBucket = state.legendHover ?? state.legendSelected;
    const colorRev = state.colorRev;
    const data = state.filterExt ? model.segments : state.cpuVisible || model.segments;
    const filterProps = timeFilterProps();
    const highlight = [...palette.action, 150];

    const isDimmed = (d) => {
      if (activeBucket !== null && bucketOf(d) !== activeBucket) {
        return true;
      }
      return Boolean(focusName) && d.streetName !== focusName;
    };

    const layers = [
      // Ground shadow: the street plan at z=0, always dim — the city's
      // reflection, and the map reading in blueprint view.
      new deckNs.PathLayer({
        id: "mc-shadow",
        data,
        pickable: true,
        autoHighlight: true,
        highlightColor: highlight,
        widthUnits: "pixels",
        getPath: (d) => d.path,
        getColor: (d) => {
          const [r, g, b] = lensColor(d);
          return [r, g, b, isDimmed(d) ? ALPHA.shadowDim : palette.shadowAlpha];
        },
        getWidth: (d) => d.baseWidth * 0.8,
        widthMinPixels: 1,
        widthMaxPixels: 2.6,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        updateTriggers: { getColor: [colorRev, lens] },
        ...filterProps,
      }),

      // Glow underlay for the strata threads.
      new deckNs.PathLayer({
        id: "mc-strata-glow",
        data,
        pickable: false,
        widthUnits: "pixels",
        getPath: (d) => d.pathZ,
        getColor: (d) => {
          const [r, g, b] = lensColor(d);
          return [r, g, b, isDimmed(d) ? ALPHA.glowDim : ALPHA.glow];
        },
        getWidth: (d) => d.baseWidth * 3.4,
        widthMinPixels: 4,
        widthMaxPixels: 14,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        updateTriggers: { getColor: [colorRev, lens] },
        ...filterProps,
      }),

      // The strata themselves: every street at its founding altitude.
      new deckNs.PathLayer({
        id: "mc-strata",
        data,
        pickable: true,
        autoHighlight: true,
        highlightColor: highlight,
        widthUnits: "pixels",
        getPath: (d) => d.pathZ,
        getColor: (d) => {
          if (d.segmentId === selectedId) {
            return [...palette.action, 245];
          }
          const [r, g, b] = lensColor(d);
          return [r, g, b, isDimmed(d) ? ALPHA.strataDim : ALPHA.strata];
        },
        getWidth: (d) => d.baseWidth,
        widthMinPixels: 1.4,
        widthMaxPixels: 4.5,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        updateTriggers: { getColor: [colorRev, lens, selectedId] },
        ...filterProps,
      }),
    ];

    // Survey line: a drafting reference at the timeline cutoff altitude
    // while the city is under construction.
    if (state.cutIndex < model.count - 1) {
      const z = model.segments[state.cutIndex].altitude;
      const [minLon, minLat, maxLon, maxLat] = model.bbox;
      const padLon = (maxLon - minLon) * 0.04 || 0.001;
      const padLat = (maxLat - minLat) * 0.04 || 0.001;
      const rect = [
        [minLon - padLon, minLat - padLat, z],
        [maxLon + padLon, minLat - padLat, z],
        [maxLon + padLon, maxLat + padLat, z],
        [minLon - padLon, maxLat + padLat, z],
        [minLon - padLon, minLat - padLat, z],
      ];
      layers.push(
        new deckNs.PathLayer({
          id: "mc-survey",
          data: [{ path: rect }],
          pickable: false,
          widthUnits: "pixels",
          getPath: (d) => d.path,
          getColor: [...palette.survey, 130],
          getWidth: 1,
          widthMinPixels: 1,
          widthMaxPixels: 1.5,
          parameters: { depthTest: false },
        })
      );
    }

    // Plumb line: drop the selected street to its ground shadow.
    if (state.selected) {
      const seg = state.selected;
      layers.push(
        new deckNs.LineLayer({
          id: "mc-plumb",
          data: [seg],
          pickable: false,
          getSourcePosition: (d) => [d.midpoint[0], d.midpoint[1], 0],
          getTargetPosition: (d) => [d.midpoint[0], d.midpoint[1], d.altitude],
          getColor: [...palette.action, 150],
          getWidth: 1.5,
          widthUnits: "pixels",
          parameters: { depthTest: false },
        })
      );
    }

    return layers;
  }

  function onSculptureClick(info) {
    const seg = info?.object || null;
    if (!seg) {
      clearSelection();
      return;
    }
    selectSegment(seg);
  }

  function selectSegment(seg) {
    state.selected = seg;
    renderDetailSegment(seg);
    bumpColors();
    refreshLayers();
  }

  function clearSelection() {
    if (!state.selected) {
      return;
    }
    state.selected = null;
    if (state.focusStreet) {
      renderDetailStreet(state.focusStreet);
    } else {
      renderDetailEmpty();
    }
    bumpColors();
    refreshLayers();
  }

  function buildTooltip(info) {
    const obj = info?.object;
    if (!obj) {
      return null;
    }
    return {
      className: "memory-city-tooltip",
      html: `
        <strong>${escapeHtml(obj.streetName || "Unnamed street")}</strong><br>
        <span style="opacity:.78">joined ${escapeHtml(formatDate(obj.firstMs))} · ${escapeHtml(
          formatRelativeDays(obj.daysSinceDriven)
        )} · ${obj.lengthMiles.toFixed(2)} mi</span>
      `,
    };
  }

  // ===========================================================================
  // Camera
  // ===========================================================================

  function fitViewToModel() {
    const model = state.model;
    if (!model) {
      return null;
    }
    const [minLon, minLat, maxLon, maxLat] = model.bbox;
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
          { padding: 90 }
        );
        return {
          longitude: fitted.longitude,
          latitude: fitted.latitude,
          zoom: clamp(fitted.zoom - 0.5, 10, 16),
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

  function flyTo(partial, duration = 900) {
    const current = state.viewState || DEFAULT_VIEW_STATE;
    const target = { ...current, ...partial, transitionDuration: duration };
    if (window.deck?.FlyToInterpolator) {
      target.transitionInterpolator = new window.deck.FlyToInterpolator();
    }
    updateViewState(target);
  }

  function flyToSegment(seg) {
    const current = state.viewState || DEFAULT_VIEW_STATE;
    flyTo({
      longitude: seg.midpoint[0],
      latitude: seg.midpoint[1],
      zoom: Math.max(current.zoom, 13.6),
    });
  }

  function flyToBbox(bbox) {
    const WebMercatorViewport = window.deck?.WebMercatorViewport;
    const container = elements.canvas;
    if (!WebMercatorViewport || !container) {
      flyTo({
        longitude: (bbox[0] + bbox[2]) / 2,
        latitude: (bbox[1] + bbox[3]) / 2,
      });
      return;
    }
    try {
      const vp = new WebMercatorViewport({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
      });
      const fitted = vp.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 120 }
      );
      flyTo({
        longitude: fitted.longitude,
        latitude: fitted.latitude,
        zoom: clamp(fitted.zoom, 10, 15.5),
      });
    } catch {
      flyTo({
        longitude: (bbox[0] + bbox[2]) / 2,
        latitude: (bbox[1] + bbox[3]) / 2,
      });
    }
  }

  function resetCamera() {
    const fitted = fitViewToModel();
    if (fitted) {
      flyTo(fitted, 800);
    }
  }

  function setCameraPreset(mode) {
    const preset = CAMERA_PRESETS[mode];
    if (!state.deck || !state.viewState || !preset) {
      return;
    }
    if (state.autoRotate) {
      stopAutoRotate();
    }
    flyTo({ pitch: preset.pitch, bearing: preset.bearing }, 1000);
    updateCameraPresetActiveStates(mode);
  }

  function updateCameraPresetActiveStates(activeMode) {
    for (const mode of Object.keys(CAMERA_PRESETS)) {
      const btn = elements[`cam${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`];
      if (btn) {
        btn.setAttribute("aria-pressed", mode === activeMode ? "true" : "false");
      }
    }
  }

  function toggleAutoRotate() {
    if (state.autoRotate) {
      state.cinemaRotate = false;
      stopAutoRotate();
    } else {
      startAutoRotate(6);
    }
  }

  function startAutoRotate(degPerSec = 6) {
    if (!state.deck || state.autoRotate) {
      return;
    }
    state.autoRotate = true;
    elements.spinBtn?.setAttribute("aria-pressed", "true");
    let last = performance.now();
    const step = (now) => {
      if (!state.autoRotate) {
        return;
      }
      const dt = (now - last) / 1000;
      last = now;
      const current = state.viewState || DEFAULT_VIEW_STATE;
      const nextBearing = ((current.bearing + degPerSec * dt + 540) % 360) - 180;
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

  // ===========================================================================
  // City records
  // ===========================================================================

  function renderRecords() {
    const list = elements.recordsList;
    if (!list) {
      return;
    }
    list.innerHTML = "";
    const model = state.model;
    elements.records?.classList.toggle("is-hidden", !model);
    if (!model) {
      return;
    }

    const { records } = model;
    const rows = [
      {
        key: "founding",
        label: "Founding stone",
        value: records.founding.streetName || "Unnamed street",
        sub: formatDate(records.founding.firstMs),
        onSelect: () => focusSegment(records.founding),
      },
      {
        key: "newest",
        label: "Newest addition",
        value: records.newest.streetName || "Unnamed street",
        sub: formatDate(records.newest.firstMs),
        onSelect: () => focusSegment(records.newest),
      },
      records.backbone
        ? {
            key: "backbone",
            label: "The backbone",
            value: records.backbone.name,
            sub: `${formatMiles(records.backbone.miles)} across ${formatInt(records.backbone.count)} segments`,
            onSelect: () => focusStreetEntry(records.backbone),
          }
        : null,
      {
        key: "forgotten",
        label: "Most forgotten",
        value: records.forgotten.streetName || "Unnamed street",
        sub: `last driven ${formatRelativeDays(records.forgotten.daysSinceDriven).replace(/^driven /, "")}`,
        onSelect: () => focusSegment(records.forgotten),
      },
      {
        key: "once",
        label: "Met only once",
        value: `${records.oncePct.toFixed(0)}% of the city`,
        sub: `${formatInt(records.onceCount)} streets you never returned to`,
        onSelect: () => {
          if (state.lens !== "loyalty") {
            setLens("loyalty");
          }
          setLegendSelected(1);
        },
      },
    ].filter(Boolean);

    for (const row of rows) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mc-record";
      btn.innerHTML = `
        <span class="mc-record-label">${escapeHtml(row.label)}</span>
        <span class="mc-record-value">${escapeHtml(row.value)}</span>
        <span class="mc-record-sub">${escapeHtml(row.sub)}</span>
      `;
      btn.addEventListener("click", row.onSelect, signal ? { signal } : false);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function focusSegment(seg) {
    // Records can point at streets hidden by the current timeline
    // position — reveal the full city first.
    revealFullCity();
    selectSegment(seg);
    flyToSegment(seg);
  }

  function revealFullCity() {
    if (state.cutIndex < (state.model?.count ?? 0) - 1) {
      stopPlay();
      if (elements.scrubber) {
        elements.scrubber.value = String(SCRUBBER_MAX);
      }
      applyProgress(1);
    }
  }

  function focusStreetEntry(entry) {
    // A search result can include segments newer than the current timeline
    // cutoff. Reveal them before flying to and highlighting the street.
    revealFullCity();
    state.focusStreet = entry;
    state.selected = null;
    if (elements.searchInput) {
      elements.searchInput.value = entry.name;
    }
    elements.searchWrap?.classList.add("has-focus");
    closeSearchResults();
    renderDetailStreet(entry);
    bumpColors();
    refreshLayers();
    flyToBbox(entry.bbox);
  }

  // ===========================================================================
  // Street search
  // ===========================================================================

  function onSearchInput() {
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
    }
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      runSearch();
    }, 140);
  }

  function runSearch() {
    const model = state.model;
    const input = elements.searchInput;
    if (!model || !input) {
      return;
    }
    const query = input.value;
    if (!query.trim()) {
      clearStreetFocus(false);
      return;
    }
    state.searchResults = searchStreets(model.nameIndex, query);
    state.searchActive = -1;
    renderSearchResults();
  }

  function renderSearchResults() {
    const list = elements.searchResults;
    if (!list) {
      return;
    }
    list.innerHTML = "";
    const results = state.searchResults;
    list.hidden = results.length === 0;
    elements.searchInput?.setAttribute(
      "aria-expanded",
      results.length > 0 ? "true" : "false"
    );

    results.forEach((entry, index) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mc-search-result";
      btn.classList.toggle("is-active", index === state.searchActive);
      btn.innerHTML = `
        <span class="mc-search-result-name">${escapeHtml(entry.name)}</span>
        <span class="mc-search-result-meta">${formatInt(entry.count)} segments · ${formatMiles(entry.miles)}</span>
      `;
      btn.addEventListener(
        "click",
        () => focusStreetEntry(entry),
        signal ? { signal } : false
      );
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function onSearchKeydown(event) {
    const results = state.searchResults;
    if (event.key === "Escape") {
      if (results.length > 0) {
        closeSearchResults();
      } else {
        clearStreetFocus(true);
      }
      return;
    }
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      state.searchActive = clamp(state.searchActive + delta, 0, results.length - 1);
      renderSearchResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      focusStreetEntry(results[Math.max(0, state.searchActive)]);
    }
  }

  function closeSearchResults() {
    state.searchResults = [];
    state.searchActive = -1;
    if (elements.searchResults) {
      elements.searchResults.innerHTML = "";
      elements.searchResults.hidden = true;
    }
    elements.searchInput?.setAttribute("aria-expanded", "false");
  }

  function clearStreetFocus(clearInput) {
    closeSearchResults();
    if (clearInput && elements.searchInput) {
      elements.searchInput.value = "";
    }
    elements.searchWrap?.classList.remove("has-focus");
    if (!state.focusStreet) {
      return;
    }
    state.focusStreet = null;
    if (!state.selected) {
      renderDetailEmpty();
    }
    bumpColors();
    refreshLayers();
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
        <span>Click a thread to read its record</span>
      </div>
    `;
  }

  function attachDetailClose(onClose) {
    const closeBtn = elements.detail?.querySelector(".memory-city-detail-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", onClose, signal ? { signal } : false);
    }
  }

  function renderDetailSegment(seg) {
    if (!elements.detail) {
      return;
    }
    const model = state.model;
    elements.detail.classList.add("is-locked");
    elements.detail.style.setProperty(
      "--detail-glow-color-rgb",
      lensColor(seg).join(", ")
    );

    const chapter = model?.chapters?.[seg.chapterIndex];
    const chapterRow =
      model && model.chapters.length > 1 && chapter
        ? `
        <div class="memory-city-detail-row">
          <dt>Chapter</dt>
          <dd>Ch. ${chapter.numeral} · ${escapeHtml(chapter.dateLabel)}</dd>
        </div>`
        : "";

    elements.detail.innerHTML = `
      <button type="button" class="memory-city-detail-close" aria-label="Clear selection">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
      <div class="memory-city-detail-label">Street № ${formatInt(seg.rank + 1)} of ${formatInt(model?.count ?? 0)}</div>
      <h3 class="memory-city-detail-name">${escapeHtml(seg.streetName || "Unnamed street")}</h3>
      <dl>
        <div class="memory-city-detail-row">
          <dt>Joined the city</dt>
          <dd>${escapeHtml(formatDate(seg.firstMs))}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Last driven</dt>
          <dd>${escapeHtml(formatRelativeDays(seg.daysSinceDriven))}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Standing</dt>
          <dd>${seg.revisited ? "Returned to" : "Met once"}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Length</dt>
          <dd>${seg.lengthMiles.toFixed(2)} mi</dd>
        </div>${chapterRow}
        <div class="memory-city-detail-row">
          <dt>Type</dt>
          <dd>${escapeHtml(String(seg.highwayType).replace(/_/g, " "))}</dd>
        </div>
      </dl>
      <a href="/map?lat=${seg.midpoint[1]}&lng=${seg.midpoint[0]}&zoom=16" class="memory-city-detail-map-link" target="_blank">
        <i class="fas fa-external-link-alt" aria-hidden="true"></i> View on Main Map
      </a>
    `;
    attachDetailClose(clearSelection);
  }

  function renderDetailStreet(entry) {
    if (!elements.detail) {
      return;
    }
    elements.detail.classList.add("is-locked");
    elements.detail.style.removeProperty("--detail-glow-color-rgb");
    const now = Date.now();
    const daysSince = Math.max(0, (now - entry.lastMs) / 86_400_000);
    elements.detail.innerHTML = `
      <button type="button" class="memory-city-detail-close" aria-label="Clear street focus">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
      <div class="memory-city-detail-label">Street focus</div>
      <h3 class="memory-city-detail-name">${escapeHtml(entry.name)}</h3>
      <dl>
        <div class="memory-city-detail-row">
          <dt>Segments</dt>
          <dd>${formatInt(entry.count)}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Length</dt>
          <dd>${formatMiles(entry.miles)}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Joined the city</dt>
          <dd>${escapeHtml(formatDate(entry.firstMs))}</dd>
        </div>
        <div class="memory-city-detail-row">
          <dt>Last driven</dt>
          <dd>${escapeHtml(formatRelativeDays(daysSince))}</dd>
        </div>
      </dl>
    `;
    attachDetailClose(() => clearStreetFocus(true));
  }

  // ===========================================================================
  // Postcard export
  // ===========================================================================

  function handleAfterRender() {
    if (!state.pendingCapture) {
      return;
    }
    const { resolve, reject } = state.pendingCapture;
    state.pendingCapture = null;
    try {
      const canvas =
        state.deck?.getCanvas?.() || elements.canvas.querySelector("canvas");
      if (!canvas) {
        throw new Error("Renderer canvas unavailable");
      }
      resolve(canvas.toDataURL("image/png"));
    } catch (err) {
      reject(err);
    }
  }

  function captureFrame() {
    return new Promise((resolve, reject) => {
      if (!state.deck) {
        reject(new Error("Sculpture is not ready"));
        return;
      }
      state.pendingCapture = { resolve, reject };
      state.deck.redraw("memory-city-postcard");
      setTimeout(() => {
        if (state.pendingCapture) {
          state.pendingCapture = null;
          reject(new Error("Renderer did not produce a frame"));
        }
      }, 2000);
    });
  }

  async function savePostcard() {
    const model = state.model;
    if (!model || !state.deck) {
      return;
    }
    try {
      const frame = await captureFrame();
      const url = await composePostcard(frame);
      const link = document.createElement("a");
      const name = (state.area?.display_name || "memory-city")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      link.href = url;
      link.download = `memory-city-${name}-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      notificationManager?.show?.({
        type: "info",
        message: "Postcard saved.",
      });
    } catch (err) {
      console.error("Postcard export failed", err);
      notificationManager?.show?.({
        type: "danger",
        message: `Postcard failed: ${err?.message || "unknown error"}`,
      });
    }
  }

  function composePostcard(frameDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const styles = getComputedStyle(document.documentElement);
          const token = (name, fallback) =>
            styles.getPropertyValue(name).trim() || fallback;
          const displayFont = token("--font-family-display", "sans-serif");
          const monoFont = token("--font-family-mono", "monospace");

          const footer = clamp(Math.round(img.width * 0.055), 96, 220);
          const pad = Math.round(footer * 0.34);
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height + footer;
          const ctx2d = canvas.getContext("2d");
          ctx2d.drawImage(img, 0, 0);

          ctx2d.fillStyle = token("--surface-1", "#101018");
          ctx2d.fillRect(0, img.height, canvas.width, footer);
          ctx2d.fillStyle = token("--border-color", "#333");
          ctx2d.fillRect(0, img.height, canvas.width, Math.max(1, Math.round(footer * 0.015)));

          const model = state.model;
          const area = state.area || {};
          const titleSize = Math.round(footer * 0.32);
          const metaSize = Math.round(footer * 0.17);

          ctx2d.fillStyle = token("--text-primary", "#eee");
          ctx2d.font = `600 ${titleSize}px ${displayFont}`;
          ctx2d.textBaseline = "alphabetic";
          ctx2d.fillText(
            area.display_name || "Memory City",
            pad,
            img.height + pad + titleSize * 0.82,
            canvas.width * 0.62
          );

          const founded = formatDate(model.firstMs).toUpperCase();
          const metaLine = [
            `${formatInt(model.count)} STREETS`,
            formatMiles(model.totalMiles).toUpperCase(),
            Number.isFinite(area.coverage_percentage)
              ? `${area.coverage_percentage.toFixed(1)}%`
              : null,
            `EST. ${founded}`,
          ]
            .filter(Boolean)
            .join(" · ");
          ctx2d.fillStyle = token("--text-secondary", "#aaa");
          ctx2d.font = `500 ${metaSize}px ${monoFont}`;
          ctx2d.fillText(metaLine, pad, img.height + footer - pad, canvas.width * 0.62);

          ctx2d.fillStyle = token("--text-tertiary", "#888");
          ctx2d.font = `600 ${metaSize}px ${monoFont}`;
          ctx2d.textAlign = "right";
          ctx2d.fillText(
            "EVERY STREET — MEMORY CITY",
            canvas.width - pad,
            img.height + footer / 2 + metaSize * 0.36
          );

          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Could not read the rendered frame"));
      img.src = frameDataUrl;
    });
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
}

// ============================================================================
// Formatting helpers (pure)
// ============================================================================

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
  return new Date(ts).toLocaleDateString(undefined, {
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
