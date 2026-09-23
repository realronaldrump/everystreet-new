/**
 * The "Personal record" cell of the home page ledger.
 *
 * Collects records from several sources (driving insights, fuel, counties,
 * coverage), shows one at a time, and turns to the next every thirty
 * minutes or when the reader clicks the cell. The position in the rotation
 * is remembered so a reload does not always start from the first record.
 */

import { formatDurationCompact } from "../../utils/formatting.js";
import { getStorage } from "../../utils.js";

const ROTATION_MS = 30 * 60 * 1000;
const ROTATION_KEY = "es:record-rotation";

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

const formatMiles = (value, suffix = "mi") => {
  const numeric = positive(value);
  return numeric === null ? null : `${numeric.toFixed(1)} ${suffix}`;
};

const formatSpeed = (value) => {
  const numeric = positive(value);
  return numeric === null ? null : `${numeric.toFixed(1)} mph`;
};

const formatCount = (value, singular, plural = `${singular}s`) => {
  const numeric = positive(value);
  if (numeric === null) {
    return null;
  }
  const rounded = Math.round(numeric);
  return `${rounded.toLocaleString()} ${rounded === 1 ? singular : plural}`;
};

const formatPrice = (value) => {
  const numeric = positive(value);
  return numeric === null ? null : `$${numeric.toFixed(2)}/gal`;
};

const formatPercent = (value) => {
  const numeric = positive(value);
  return numeric === null ? null : `${numeric.toFixed(2)}%`;
};

/** Dates arrive as day keys (YYYY-MM-DD) or full timestamps. */
function parseRecordDate(value) {
  if (!value) {
    return null;
  }
  const text =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T12:00:00`
      : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function entry({ id, title, value, date, datePrefix = "On" }) {
  const parsed = parseRecordDate(date);
  if (!value || value === "--" || !parsed) {
    return null;
  }
  const dateText = parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return { id, title, value, dateText: `${datePrefix} ${dateText}` };
}

function insightEntries(records) {
  if (!records) {
    return [];
  }
  const mostVisited = records.most_visited;
  return [
    {
      id: "longest-trip-distance",
      title: "Longest trip distance",
      value: formatMiles(records.longest_trip?.distance),
      date: records.longest_trip?.recorded_at,
    },
    {
      id: "longest-trip-duration",
      title: "Longest trip duration",
      value: formatDurationCompact(records.longest_duration?.duration_seconds),
      date: records.longest_duration?.recorded_at,
    },
    {
      id: "max-speed",
      title: "Top speed",
      value: formatSpeed(records.max_speed?.max_speed),
      date: records.max_speed?.recorded_at,
    },
    {
      id: "avg-speed",
      title: "Highest average speed",
      value: formatSpeed(records.avg_speed?.avg_speed),
      date: records.avg_speed?.recorded_at,
    },
    {
      id: "max-idle",
      title: "Most idle time in a trip",
      value: formatDurationCompact(records.max_idle?.idle_seconds),
      date: records.max_idle?.recorded_at,
    },
    {
      id: "max-hard-braking",
      title: "Most hard braking events",
      value: formatCount(records.max_hard_braking?.hard_braking, "event"),
      date: records.max_hard_braking?.recorded_at,
    },
    {
      id: "max-hard-accel",
      title: "Most hard acceleration events",
      value: formatCount(records.max_hard_accel?.hard_accel, "event"),
      date: records.max_hard_accel?.recorded_at,
    },
    {
      id: "max-day-distance",
      title: "Most miles in a day",
      value: formatMiles(records.max_day_distance?.distance),
      date: records.max_day_distance?.date,
    },
    {
      id: "max-day-trips",
      title: "Most trips in a day",
      value: formatCount(records.max_day_trips?.trips, "trip"),
      date: records.max_day_trips?.date,
    },
    {
      id: "max-day-duration",
      title: "Most drive time in a day",
      value: formatDurationCompact(records.max_day_duration?.duration_seconds),
      date: records.max_day_duration?.date,
    },
    mostVisited && {
      id: "most-visited",
      title: mostVisited.location
        ? `Most visited destination: ${mostVisited.location}`
        : "Most visited destination",
      value: formatCount(mostVisited.count, "visit"),
      date: mostVisited.lastVisit,
      datePrefix: "Last visit",
    },
  ];
}

function fuelEntries(records) {
  if (!records) {
    return [];
  }
  return [
    {
      id: "best-mpg",
      title: "Best MPG fill-up",
      value: formatMiles(records.best_mpg?.mpg, "mpg"),
      date: records.best_mpg?.fillup_time,
    },
    {
      id: "cheapest-price",
      title: "Lowest price per gallon",
      value: formatPrice(records.cheapest_price?.price_per_gallon),
      date: records.cheapest_price?.fillup_time,
    },
  ];
}

function coverageEntry(coverage) {
  const best = (coverage?.areas || []).reduce(
    (top, area) =>
      !top || area.coverage_percentage > top.coverage_percentage ? area : top,
    null
  );
  if (!best) {
    return null;
  }
  return {
    id: "coverage-best",
    title: `Coverage in ${best.display_name}`,
    value: formatPercent(best.coverage_percentage),
    date: best.last_synced || best.created_at,
    datePrefix: best.last_synced ? "Last synced" : "Created",
  };
}

/** Every record the sources can support, in a fixed order. */
export function buildRecordEntries({ insights, gas, counties, coverage } = {}) {
  const candidates = [
    ...insightEntries(insights?.records),
    ...fuelEntries(gas?.records),
    counties?.success && {
      id: "counties-visited",
      title: "Counties visited",
      value: formatCount(counties.totalVisited, "county", "counties"),
      date: counties.lastUpdated,
      datePrefix: "Updated",
    },
    coverageEntry(coverage),
  ];
  return candidates.filter(Boolean).map(entry).filter(Boolean);
}

function initialIndex(count) {
  const stored = getStorage(ROTATION_KEY);
  if (
    !stored ||
    !Number.isInteger(stored.index) ||
    stored.index < 0 ||
    stored.index >= count
  ) {
    return 0;
  }
  const elapsed = Date.now() - (stored.timestamp || 0);
  return elapsed < ROTATION_MS ? stored.index : (stored.index + 1) % count;
}

function rememberIndex(index) {
  try {
    localStorage.setItem(
      ROTATION_KEY,
      JSON.stringify({ index, timestamp: Date.now() })
    );
  } catch {
    // Storage can be full or blocked; the rotation restarts next visit.
  }
}

/**
 * @param {{ card, count, value, title, date }} els  record cell elements
 * @param {{ signal?: AbortSignal, loadingText: () => string }} options
 */
export function createRecordCard(els, { signal, loadingText }) {
  let sources = { insights: null, gas: null, counties: null, coverage: null };
  let entries = [];
  let index = 0;
  let initialized = false;
  let currentId = null;
  let loading = false;
  let timer = null;

  const setText = (el, text) => {
    if (el) {
      el.textContent = text;
    }
  };

  const stopRotation = () => {
    clearInterval(timer);
    timer = null;
  };

  function show(record) {
    if (!record) {
      setText(els.value, "--");
      setText(els.title, "--");
      setText(els.date, "--");
      setText(els.count, "");
      currentId = null;
      return;
    }
    setText(els.value, record.value);
    setText(els.title, record.title);
    setText(els.date, record.dateText);
    setText(els.count, entries.length > 1 ? `${index + 1} of ${entries.length}` : "");
    if (record.id !== currentId) {
      currentId = record.id;
      rememberIndex(index);
    }
  }

  function advance({ manual = false } = {}) {
    if (entries.length === 0) {
      return;
    }
    index = (index + 1) % entries.length;
    show(entries[index]);
    if (manual) {
      startRotation({ reset: true });
    }
  }

  function startRotation({ reset = false } = {}) {
    if (entries.length < 2) {
      stopRotation();
      return;
    }
    if (timer && !reset) {
      return;
    }
    stopRotation();
    timer = setInterval(advance, ROTATION_MS);
  }

  function render() {
    entries = buildRecordEntries(sources);
    if (entries.length && !initialized) {
      index = initialIndex(entries.length);
      initialized = true;
    }
    if (index >= entries.length) {
      index = 0;
    }
    show(entries[index] || null);
    startRotation();
  }

  if (els.card) {
    const listener = signal ? { signal } : false;
    els.card.addEventListener("click", () => advance({ manual: true }), listener);
    els.card.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          advance({ manual: true });
        }
      },
      listener
    );
  }

  return {
    /** Merge in new source data and redraw unless a reload is in flight. */
    update(patch) {
      sources = { ...sources, ...patch };
      if (!loading) {
        render();
      }
    },
    setLoading(isLoading) {
      loading = Boolean(isLoading);
      els.card?.classList.toggle("is-loading", loading);
      els.card?.setAttribute("aria-busy", loading ? "true" : "false");
      if (!loading) {
        render();
        return;
      }
      stopRotation();
      setText(els.value, "...");
      setText(els.title, "Updating records");
      setText(els.date, loadingText());
      setText(els.count, "");
      currentId = null;
    },
    stop: stopRotation,
  };
}
