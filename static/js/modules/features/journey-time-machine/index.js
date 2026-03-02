import { swupReady } from "../../core/navigation.js";
import store from "../../core/store.js";
import { DateUtils } from "../../utils.js";
import { fetchJourneyFeed } from "./api.js";
import { ensureJourneyMap, renderJourneyGeometry, resizeJourneyMap } from "./map.js";
import {
  createPlaybackController,
  findClosestIndexByTimestamp,
  findIndexWithMinuteOffset,
} from "./playback.js";
import {
  renderFeedList,
  renderFilterChips,
  renderInspector,
  renderSourceErrors,
  updateFeedCount,
  updateFeedStatus,
} from "./render.js";
import {
  applyTypeFilters,
  getJourneyStoreState,
  resetJourneyEvents,
  setJourneyStoreState,
  state,
} from "./state.js";

let abortController = null;
let elements = {};
let playback = null;

function cacheElements() {
  elements = {
    trigger: document.getElementById("journey-time-machine-toggle"),
    dialog: document.getElementById("journey-time-machine"),
    close: document.getElementById("journey-time-machine-close"),
    backdrop: document.getElementById("journey-time-machine-backdrop"),
    playToggle: document.getElementById("journey-play-toggle"),
    prevEvent: document.getElementById("journey-prev-event"),
    nextEvent: document.getElementById("journey-next-event"),
    jumpBack: document.getElementById("journey-jump-back"),
    jumpForward: document.getElementById("journey-jump-forward"),
    scrubber: document.getElementById("journey-timeline-scrubber"),
    speedSelect: document.getElementById("journey-speed-select"),
    followRoute: document.getElementById("journey-follow-route"),
    feedSummary: document.getElementById("journey-filter-summary"),
  };
}

function updateSummary() {
  const filters = store.get("filters") || {};
  const startDate = filters.startDate || "--";
  const endDate = filters.endDate || "--";
  const vehicle = filters.vehicle || "all vehicles";

  if (elements.feedSummary) {
    elements.feedSummary.textContent = `Range ${startDate} to ${endDate} · ${vehicle}`;
  }
}

function getActiveIndex() {
  if (!state.visibleEvents.length || !state.activeEventId) {
    return 0;
  }
  const index = state.visibleEvents.findIndex(
    (event) => event.id === state.activeEventId
  );
  return index < 0 ? 0 : index;
}

function getActiveEvent() {
  if (!state.activeEventId) {
    return null;
  }
  return state.visibleEvents.find((event) => event.id === state.activeEventId) || null;
}

function dispatchJourneyEvent(type, detail = {}) {
  document.dispatchEvent(
    new CustomEvent(type, {
      detail: {
        source: "journey-time-machine",
        ...detail,
      },
    })
  );
}

function syncScrubber() {
  if (!elements.scrubber) {
    return;
  }
  const max = Math.max(0, state.visibleEvents.length - 1);
  const activeIndex = getActiveIndex();
  elements.scrubber.max = String(max);
  elements.scrubber.value = String(Math.max(0, Math.min(activeIndex, max)));
  elements.scrubber.disabled = state.visibleEvents.length <= 1;
}

function updatePlayButton(isPlaying) {
  const btn = elements.playToggle;
  if (!btn) {
    return;
  }

  btn.setAttribute("aria-pressed", isPlaying ? "true" : "false");
  btn.innerHTML = isPlaying
    ? '<i class="fas fa-pause" aria-hidden="true"></i><span>Pause</span>'
    : '<i class="fas fa-play" aria-hidden="true"></i><span>Play</span>';
}

function selectEventById(eventId, options = {}) {
  if (!eventId) {
    return;
  }

  const selected = state.visibleEvents.find((event) => event.id === eventId);
  if (!selected) {
    return;
  }

  state.activeEventId = selected.id;
  setJourneyStoreState(
    {
      activeEventId: selected.id,
      cursorTs: selected.timestamp,
    },
    { source: options.source || "journey-time-machine" }
  );

  renderFeedList(state.visibleEvents, state.activeEventId, selectEventById);
  renderInspector(selected);
  syncScrubber();
  void renderJourneyGeometry(selected, { followRoute: state.followRoute });

  if (options.emit !== false) {
    dispatchJourneyEvent("journey:seek", {
      eventId: selected.id,
      timestamp: selected.timestamp,
      event: selected,
    });
  }
}

function selectEventByIndex(index, options = {}) {
  const safeIndex = Math.max(0, Math.min(index, state.visibleEvents.length - 1));
  const selected = state.visibleEvents[safeIndex];
  if (!selected) {
    return;
  }
  selectEventById(selected.id, options);
}

function renderFeed() {
  updateFeedCount(state.visibleEvents.length);
  renderFeedList(state.visibleEvents, state.activeEventId, selectEventById);
  syncScrubber();

  if (!state.visibleEvents.length) {
    state.activeEventId = null;
    renderInspector(null);
    updateFeedStatus("No events found for the selected filters.");
    return;
  }

  const currentExists = state.visibleEvents.some(
    (event) => event.id === state.activeEventId
  );
  if (!currentExists) {
    const { cursorTs } = getJourneyStoreState();
    const fallbackIndex = findClosestIndexByTimestamp(state.visibleEvents, cursorTs);
    selectEventByIndex(fallbackIndex, { emit: false });
  } else {
    renderInspector(getActiveEvent());
  }

  updateFeedStatus("Timeline loaded.");
}

function toggleType(type) {
  if (state.activeTypes.has(type)) {
    if (state.activeTypes.size === 1) {
      return;
    }
    state.activeTypes.delete(type);
  } else {
    state.activeTypes.add(type);
  }

  renderFilterChips(toggleType);
  applyTypeFilters(state.events);
  renderFeed();
}

function getQueryFilters() {
  const filters = store.get("filters") || {};
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    vehicle: filters.vehicle,
  };
}

async function loadFeed({ preserveSelection = true } = {}) {
  if (!elements.dialog) {
    return;
  }

  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  state.loading = true;
  updateFeedStatus("Loading feed...");

  const previousEventId = preserveSelection ? state.activeEventId : null;

  try {
    const filters = getQueryFilters();
    const response = await fetchJourneyFeed({
      startDate: filters.startDate,
      endDate: filters.endDate,
      vehicle: filters.vehicle,
      limit: 1200,
      signal: abortController.signal,
    });

    state.events = Array.isArray(response?.events) ? response.events : [];
    state.errors = response?.errors || {};
    state.cursor = response?.meta?.next_cursor || null;
    state.hasMore = Boolean(response?.meta?.has_more);

    if (previousEventId) {
      state.activeEventId = previousEventId;
    }

    applyTypeFilters(state.events);
    renderFilterChips(toggleType);
    renderFeed();
    renderSourceErrors(state.errors);

    if (state.hasMore) {
      updateFeedStatus("Timeline loaded (partial page).");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    resetJourneyEvents();
    renderFilterChips(toggleType);
    renderFeed();
    updateFeedStatus(
      `Failed to load journey feed: ${error.message || "Unknown error"}`,
      true
    );
  } finally {
    state.loading = false;
  }
}

function onPlayStateChange(isPlaying) {
  setJourneyStoreState({ isPlaying }, { source: "journey-time-machine" });

  updatePlayButton(isPlaying);
  dispatchJourneyEvent(isPlaying ? "journey:play" : "journey:pause", {
    eventId: state.activeEventId,
    timestamp: getActiveEvent()?.timestamp || null,
  });
}

function initPlaybackController() {
  playback = createPlaybackController({
    getEvents: () => state.visibleEvents,
    getActiveIndex,
    onSelectIndex: (index) => selectEventByIndex(index),
    onPlayStateChange,
    getSpeed: () => Number(store.get("journey.playbackSpeed") || 1),
  });
}

function closeDialog({ restoreFocus = true } = {}) {
  if (!elements.dialog) {
    return;
  }

  playback?.stop();

  elements.dialog.classList.remove("is-open");
  elements.dialog.setAttribute("aria-hidden", "true");
  document.body.classList.remove("journey-time-machine-open");
  setJourneyStoreState(
    {
      isOpen: false,
      isPlaying: false,
    },
    { source: "journey-time-machine" }
  );

  elements.trigger?.setAttribute("aria-expanded", "false");

  if (restoreFocus) {
    elements.trigger?.focus();
  }
}

async function openDialog() {
  if (!elements.dialog) {
    return;
  }

  elements.dialog.classList.add("is-open");
  elements.dialog.setAttribute("aria-hidden", "false");
  document.body.classList.add("journey-time-machine-open");
  setJourneyStoreState({ isOpen: true }, { source: "journey-time-machine" });
  elements.trigger?.setAttribute("aria-expanded", "true");

  updateSummary();

  try {
    await ensureJourneyMap();
    requestAnimationFrame(() => {
      resizeJourneyMap();
    });
  } catch (error) {
    updateFeedStatus(`Map unavailable: ${error?.message || "Unknown error"}`, true);
  }

  await loadFeed({ preserveSelection: true });
  elements.close?.focus();
}

function toggleDialog() {
  if (!elements.dialog) {
    return;
  }
  const isOpen = elements.dialog.classList.contains("is-open");
  if (isOpen) {
    closeDialog();
  } else {
    void openDialog();
  }
}

function handlePresetClick(event) {
  const button = event.target.closest(".journey-preset-btn");
  if (!button) {
    return;
  }

  const { range } = button.dataset;
  if (!range) {
    return;
  }

  DateUtils.getDateRangePreset(range)
    .then(({ startDate, endDate }) => {
      if (!startDate || !endDate) {
        return;
      }
      store.updateFilters(
        {
          startDate,
          endDate,
        },
        {
          source: "journey-time-machine-preset",
        }
      );
    })
    .catch(() => {});
}

function bindEvents() {
  elements.trigger?.addEventListener("click", () => toggleDialog());
  elements.close?.addEventListener("click", () => closeDialog());
  elements.backdrop?.addEventListener("click", () => closeDialog());

  document.addEventListener("click", handlePresetClick);

  elements.playToggle?.addEventListener("click", () => {
    playback?.toggle();
  });

  elements.prevEvent?.addEventListener("click", () => {
    const nextIndex = Math.max(0, getActiveIndex() - 1);
    selectEventByIndex(nextIndex);
  });

  elements.nextEvent?.addEventListener("click", () => {
    const nextIndex = Math.min(state.visibleEvents.length - 1, getActiveIndex() + 1);
    selectEventByIndex(nextIndex);
  });

  elements.jumpBack?.addEventListener("click", () => {
    const target = findIndexWithMinuteOffset(state.visibleEvents, getActiveIndex(), -5);
    if (target >= 0) {
      selectEventByIndex(target);
    }
  });

  elements.jumpForward?.addEventListener("click", () => {
    const target = findIndexWithMinuteOffset(state.visibleEvents, getActiveIndex(), 5);
    if (target >= 0) {
      selectEventByIndex(target);
    }
  });

  elements.scrubber?.addEventListener("input", () => {
    const nextIndex = Number(elements.scrubber?.value || 0);
    selectEventByIndex(nextIndex);
  });

  elements.speedSelect?.addEventListener("change", () => {
    const speed = Number(elements.speedSelect?.value || 1);
    setJourneyStoreState(
      {
        playbackSpeed: speed,
      },
      { source: "journey-time-machine" }
    );
    playback?.restart();
  });

  elements.followRoute?.addEventListener("click", () => {
    state.followRoute = !state.followRoute;
    elements.followRoute?.setAttribute(
      "aria-pressed",
      state.followRoute ? "true" : "false"
    );
    const active = getActiveEvent();
    if (active) {
      void renderJourneyGeometry(active, { followRoute: state.followRoute });
    }
  });

  document.addEventListener("filtersApplied", () => {
    updateSummary();
    if (!elements.dialog?.classList.contains("is-open")) {
      return;
    }
    void loadFeed({ preserveSelection: true });
  });

  document.addEventListener("journey:route-context", () => {
    updateSummary();
    if (!elements.dialog?.classList.contains("is-open")) {
      return;
    }
    requestAnimationFrame(() => resizeJourneyMap());
  });

  document.addEventListener("keydown", (event) => {
    const targetTag = (event.target?.tagName || "").toLowerCase();
    const isInput =
      targetTag === "input" || targetTag === "textarea" || targetTag === "select";

    if (event.key.toLowerCase() === "t" && event.shiftKey && !isInput) {
      event.preventDefault();
      toggleDialog();
      return;
    }

    if (!elements.dialog?.classList.contains("is-open")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }

    if (event.key === " " && !isInput) {
      event.preventDefault();
      playback?.toggle();
    }
  });

  document.addEventListener("journey:seek", (event) => {
    if (event?.detail?.source === "journey-time-machine") {
      return;
    }
    const eventId = event?.detail?.eventId;
    if (eventId) {
      selectEventById(eventId, { emit: false, source: "journey-external" });
    }
  });

  document.addEventListener("journey:play", (event) => {
    if (event?.detail?.source === "journey-time-machine") {
      return;
    }
    playback?.start();
  });

  document.addEventListener("journey:pause", (event) => {
    if (event?.detail?.source === "journey-time-machine") {
      return;
    }
    playback?.stop();
  });

  window.addEventListener("resize", () => {
    if (!elements.dialog?.classList.contains("is-open")) {
      return;
    }
    resizeJourneyMap();
  });

  swupReady
    .then((swup) => {
      swup.hooks.on("page:view", () => {
        updateSummary();
        if (elements.dialog?.classList.contains("is-open")) {
          requestAnimationFrame(() => resizeJourneyMap());
        }
      });
    })
    .catch(() => {});
}

function restoreFromStore() {
  const journeyState = getJourneyStoreState();
  const speed = Number(journeyState.playbackSpeed || 1);
  if (elements.speedSelect) {
    elements.speedSelect.value = String(speed);
  }
  state.activeEventId = journeyState.activeEventId || null;

  if (journeyState.isOpen) {
    void openDialog();
  }
}

export default function initJourneyTimeMachine() {
  if (state.initialized) {
    return;
  }

  cacheElements();
  if (!elements.dialog || !elements.trigger) {
    return;
  }

  initPlaybackController();
  renderFilterChips(toggleType);
  updatePlayButton(false);
  renderInspector(null);
  updateSummary();

  bindEvents();
  restoreFromStore();

  state.initialized = true;
}
