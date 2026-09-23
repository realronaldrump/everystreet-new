/**
 * Formatting and plain-language summaries for the coverage journal.
 * Pure functions: no DOM, so they are tested directly.
 */

const FEET_PER_MILE = 5280;
const DAY_MS = 86400000;

export function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(number)
    : "—";
}

/** Miles, or feet below a tenth of a mile so small gains never read as zero. */
export function formatMiles(value, digits = 1) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const miles = Number(value);
  if (!Number.isFinite(miles)) {
    return "—";
  }
  if (miles > 0 && miles < 0.1) {
    return `${formatNumber(Math.max(1, Math.round(miles * FEET_PER_MILE)))} ft`;
  }
  return `${formatNumber(miles, digits)} mi`;
}

/**
 * A coverage percentage that never rounds up to done: 99.96% of an
 * unfinished area prints as 99.9%, and only a complete area prints 100%.
 */
export function formatPercent(value, { complete = false, digits = 1 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "—";
  }
  if (complete) {
    return "100%";
  }
  const step = 10 ** -digits;
  const clamped = Math.min(100 - step, Math.max(0, number));
  return `${formatNumber(clamped, digits)}%`;
}

export function parseDate(value) {
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (calendarDate) {
    return new Date(
      Number(calendarDate[1]),
      Number(calendarDate[2]) - 1,
      Number(calendarDate[3]),
      12
    );
  }
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

const DATE_STYLES = {
  long: { year: "numeric", month: "long", day: "numeric" },
  short: { year: "numeric", month: "short", day: "numeric" },
  day: { month: "short", day: "numeric" },
  month: { year: "numeric", month: "long" },
  monthShort: { year: "numeric", month: "short" },
  year: { year: "numeric" },
};

export function formatDate(value, style = "short") {
  const date = parseDate(value);
  if (!date) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-US", DATE_STYLES[style] || DATE_STYLES.short).format(
    date
  );
}

/** Whole days from one calendar date (YYYY-MM-DD) to another. */
export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.round((end - start) / DAY_MS)
    : null;
}

export function addDays(dateKey, days) {
  const start = Date.parse(`${dateKey}T00:00:00Z`);
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

const ROAD_CLASS_LABELS = {
  motorway: "Freeways",
  motorway_link: "Freeway ramps",
  trunk: "Highways",
  trunk_link: "Highway ramps",
  primary: "Major roads",
  primary_link: "Major road ramps",
  secondary: "Secondary roads",
  secondary_link: "Secondary road ramps",
  tertiary: "Collector roads",
  tertiary_link: "Collector road ramps",
  residential: "Residential streets",
  living_street: "Living streets",
  unclassified: "Minor roads",
  service: "Service roads",
  track: "Tracks",
  road: "Unclassified roads",
};

/** A plain name for an OpenStreetMap highway class. */
export function roadClassLabel(highway) {
  const key = String(highway || "unclassified").toLowerCase();
  if (ROAD_CLASS_LABELS[key]) {
    return ROAD_CLASS_LABELS[key];
  }
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const WINDOW_LABELS = {
  "90d": "the last 90 days",
  "365d": "the last 12 months",
  all: "all time",
};

const WINDOW_TITLES = {
  "90d": "Last 90 days",
  "365d": "Last 12 months",
  all: "All time",
};

const MIN_PACE_ACTIVE_DAYS = 4;
const HORIZON_DAYS = 365 * 50;

/** Weekly mileage: two decimals below a mile, so slow paces stay in miles. */
export function formatPace(milesPerWeek) {
  const miles = Number(milesPerWeek);
  if (!Number.isFinite(miles)) {
    return "—";
  }
  return `${formatNumber(miles, miles > 0 && miles < 1 ? 2 : 1)} mi`;
}

/** Finish date (YYYY-MM-DD) at a weekly pace, or null past fifty years. */
export function finishDate(remainingMiles, milesPerWeek, today) {
  if (!(remainingMiles > 0)) {
    return today;
  }
  if (!(milesPerWeek > 0)) {
    return null;
  }
  const days = Math.ceil((remainingMiles / milesPerWeek) * 7);
  return days > HORIZON_DAYS ? null : addDays(today, days);
}

/** One row per pace window: its weekly miles and the finish it implies. */
export function paceRows(forecast, remainingMiles, today) {
  return (forecast?.paces || []).map((pace) => {
    const enough = pace.active_days >= MIN_PACE_ACTIVE_DAYS;
    const finish = enough ? finishDate(remainingMiles, pace.miles_per_week, today) : null;
    let finishLabel = "Too few drives";
    if (enough) {
      finishLabel = finish ? formatDate(finish, "monthShort") : "Over 50 years";
    }
    return {
      window: pace.window,
      label: WINDOW_TITLES[pace.window] || pace.window,
      milesPerWeek: formatPace(pace.miles_per_week),
      activeDays: pace.active_days,
      finish: finishLabel,
    };
  });
}

/**
 * The completion outlook in two short sentences: when the goal would be
 * reached at the current pace, and how recent that pace is.
 */
export function describeOutlook(forecast, { targetPercentage = 100 } = {}) {
  if (!forecast) {
    return { lead: "The outlook is unavailable.", detail: "" };
  }
  const target = `${formatNumber(targetPercentage, targetPercentage % 1 ? 1 : 0)}%`;
  const stalled =
    forecast.days_since_progress !== null &&
    forecast.days_since_progress !== undefined &&
    forecast.days_since_progress > 30;
  const lastNew = forecast.last_progress_date
    ? `No new streets since ${formatDate(forecast.last_progress_date, "long")}.`
    : "";
  if (forecast.confidence === "complete") {
    return { lead: `${target} is reached.`, detail: "" };
  }
  if (!forecast.available || !forecast.expected_completion_date) {
    return {
      lead: forecast.reason || "There is not enough history for a finish date.",
      detail: stalled ? lastNew : "",
    };
  }
  const windowLabel = WINDOW_LABELS[forecast.window] || "your recent drives";
  const lead = `At your pace over ${windowLabel}, ${formatPace(
    forecast.miles_per_week
  )} a week, you would reach ${target} around ${formatDate(
    forecast.expected_completion_date,
    "month"
  )}.`;
  return { lead, detail: stalled ? lastNew : "" };
}

/** What a saved target date asks for, in miles and driving days a week. */
export function describeRequirement(forecast, goal) {
  if (!goal?.target_date || !forecast?.required_miles_per_week) {
    return "";
  }
  const days = forecast.required_active_days_per_week;
  const perDay = forecast.miles_per_active_day;
  const target = `${formatNumber(goal.target_percentage, goal.target_percentage % 1 ? 1 : 0)}%`;
  const base = `Reaching ${target} by ${formatDate(goal.target_date, "long")} takes ${formatPace(
    forecast.required_miles_per_week
  )} a week`;
  if (days && perDay) {
    return `${base}: about ${formatNumber(days, 1)} driving days a week at your usual ${formatMiles(
      perDay,
      1
    )} a day.`;
  }
  return `${base}.`;
}

/**
 * Group daily gains into bars: days for a short range, weeks for about a
 * year, months beyond that. Keys are the first calendar date of each bar.
 */
export function bucketUnit(spanDays) {
  if (spanDays > 730) {
    return "month";
  }
  if (spanDays > 120) {
    return "week";
  }
  return "day";
}

export function bucketKey(dateKey, unit) {
  if (unit === "month") {
    return `${dateKey.slice(0, 7)}-01`;
  }
  if (unit === "week") {
    const date = new Date(`${dateKey}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    return addDays(dateKey, -weekday);
  }
  return dateKey;
}

export function bucketSeries(series, unit) {
  const buckets = new Map();
  for (const point of series || []) {
    const key = bucketKey(point.date, unit);
    const bucket = buckets.get(key) || { date: key, new_miles: 0, days: 0 };
    bucket.new_miles += Number(point.new_miles || 0);
    bucket.days += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${formatNumber(count)} ${Number(count) === 1 ? singular : pluralForm}`;
}
