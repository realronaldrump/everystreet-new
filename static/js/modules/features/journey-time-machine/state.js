import store from "../../core/store.js";

export const EVENT_TYPES = ["trip", "visit", "fuel", "coverage", "map_matching"];

export const state = {
  initialized: false,
  events: [],
  visibleEvents: [],
  activeEventId: null,
  loading: false,
  errors: {},
  cursor: null,
  hasMore: false,
  followRoute: true,
  activeTypes: new Set(EVENT_TYPES),
};

export function resetJourneyEvents() {
  state.events = [];
  state.visibleEvents = [];
  state.activeEventId = null;
  state.errors = {};
  state.cursor = null;
  state.hasMore = false;
}

export function getJourneyStoreState() {
  return {
    isOpen: Boolean(store.get("journey.isOpen")),
    cursorTs: store.get("journey.cursorTs") || null,
    activeEventId: store.get("journey.activeEventId") || null,
    isPlaying: Boolean(store.get("journey.isPlaying")),
    playbackSpeed: Number(store.get("journey.playbackSpeed") || 1),
  };
}

export function setJourneyStoreState(partial = {}, options = {}) {
  Object.entries(partial).forEach(([key, value]) => {
    store.set(`journey.${key}`, value, {
      source: options.source || "journey-time-machine",
      persist: options.persist,
      silent: options.silent,
    });
  });
}

export function applyTypeFilters(events = []) {
  state.visibleEvents = events.filter((event) => state.activeTypes.has(event.type));
  return state.visibleEvents;
}

export function eventTypeLabel(type) {
  switch (type) {
    case "trip":
      return "Trip";
    case "visit":
      return "Visit";
    case "fuel":
      return "Fuel";
    case "coverage":
      return "Coverage";
    case "map_matching":
      return "Map Match";
    default:
      return "Event";
  }
}
