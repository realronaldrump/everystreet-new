/**
 * Landing Page Controller
 * Fills the home page with live data: the recent-area line and hero plate,
 * range totals, coverage scales, index figures, and recent trips.
 */

import { CONFIG as APP_CONFIG } from "../../core/config.js";
import {
  disableBouncieLiveTracking,
  isBouncieLiveTrackingEnabled,
} from "../tracking/availability.js";
import { createFeatureApi } from "../../core/feature-api.js";
import store from "../../core/store.js";
import { getRemainingDriveableMiles } from "../navigation-core/coverage-areas.js";
import metricAnimator from "../../ui/metric-animator.js";
import { formatDurationCompact } from "../../utils/formatting.js";
import {
  DateUtils,
  formatNumber,
  formatRelativeTimeShort,
  getStorage,
  isAbortError,
} from "../../utils.js";
import { animateValue } from "./animations.js";
import { describeRecentArea, formatAreaFigures, updateMastheadDate } from "./hero.js";

// Configuration
const CONFIG = {
  refreshInterval: 60000, // 1 minute
  recordRotationInterval: 30 * 60 * 1000, // 30 minutes
  recordRotationStorageKey: "es:record-rotation",
  animationDuration: 500,
  activityLimit: 5,
  coverageRows: 3,
  signTextWidth: 134,
  mapTitleWidth: 100,
};

const SVG_NS = "http://www.w3.org/2000/svg";

// DOM Elements (cached after DOMContentLoaded)
let elements = {};
let refreshIntervalId = null;
let liveTrackingIntervalId = null;
let recordRotationIntervalId = null;
let recordEntries = [];
let recordIndex = 0;
let recordInitialized = false;
let currentRecordId = null;
let recordSources = {
  insights: null,
  gas: null,
  counties: null,
  coverage: null,
};

let pageSignal = null;
let lastKnownLocation = null;
let metricsLoadRequestId = 0;
let recordsLoadRequestId = 0;
let recentTripsLoadRequestId = 0;
let recordLoading = false;
let removeFilterRefreshListener = null;
let featureApi = createFeatureApi();
const apiGet = (url, options = {}) => featureApi.get(url, options);
const apiRaw = (url, options = {}) => featureApi.raw(url, options);
const isPageAbortError = (error) => isAbortError(error) || pageSignal?.aborted === true;

/**
 * Initialize the landing page
 */
export default function initLandingPage({ signal, cleanup, api } = {}) {
  pageSignal = signal || null;
  featureApi = api || createFeatureApi({ signal: pageSignal });
  cacheElements();
  updateMastheadDate(elements);

  highlightFrequentTiles();

  loadAllData();
  setupRefreshInterval();
  checkLiveTracking();
  bindRecordCard();
  removeFilterRefreshListener = bindFilterRefresh();
  const stopWatchingRange = watchDateRangeLabel();

  const teardown = () => {
    clearIntervals();
    stopWatchingRange();
    removeFilterRefreshListener?.();
    removeFilterRefreshListener = null;
    pageSignal = null;
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}

/**
 * Cache DOM elements for performance
 */
function cacheElements() {
  const byId = (id) => document.getElementById(id);
  elements = {
    mastheadDate: byId("manual-date"),
    areaLine: byId("home-area"),
    heroSignName: byId("hero-sign-name"),
    heroSignMiles: byId("hero-sign-miles"),
    heroMapTitle: byId("hero-map-title"),
    coverageSection: byId("home-coverage"),
    coverageRegister: byId("coverage-register"),
    weatherChip: byId("weather-chip"),
    logHeading: byId("log-heading"),
    statMiles: byId("stat-miles"),
    statTrips: byId("stat-trips"),
    statTime: byId("stat-time"),
    statTimeUnit: byId("stat-time-unit"),
    liveIndicator: byId("live-indicator"),
    recentTrip: byId("recent-trip"),
    lastFillup: byId("last-fillup"),
    indexAreas: byId("index-areas"),
    activityFeed: byId("activity-feed"),
    logbookFoot: byId("logbook-foot"),
    logbookTotal: byId("logbook-total"),
    logbookTotalLabel: byId("logbook-total-label"),
    recordCard: byId("record-card"),
    recordCount: byId("record-count"),
    recordValue: byId("record-value"),
    recordTitle: byId("record-title"),
    recordDate: byId("record-date"),

    navTiles: Array.from(document.querySelectorAll(".nav-tile")),
  };
}

/**
 * Load all data sources in parallel
 */
async function loadAllData() {
  try {
    updateMastheadDate(elements);
    updateLogHeading();

    highlightFrequentTiles();

    // Load trips first to get location
    await loadRecentTrips();

    await Promise.all([
      loadMetrics(),
      loadRecordSources(),
      loadCountyStats(),
      loadCoverageStats(),
      checkLiveTracking(),
      loadWeather(),
    ]);
  } catch (error) {
    if (!isPageAbortError(error)) {
      console.warn("Failed to load landing data", error);
    }
  }
}

function highlightFrequentTiles() {
  if (!elements.navTiles || elements.navTiles.length === 0) {
    return;
  }
  const counts = getRouteCounts();
  const frequentPaths = Object.entries(counts)
    .filter(([path]) => path !== "/" && path !== "/landing")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([path]) => path);

  const pathToTile = {
    "/map": "map",
    "/coverage-route-planner": "navigate",
    "/trips": "trips",
    "/insights": "insights",
    "/gas-tracking": "gas",
    "/visits": "visits",
    "/export": "export",
    "/coverage-management": "areas",
    "/map-matching": "map-matching",
    "/control-center": "settings",
  };

  const frequentTiles = new Set(
    frequentPaths.map((path) => pathToTile[path]).filter(Boolean)
  );

  elements.navTiles.forEach((tile) => {
    const tileId = tile.dataset.tile;
    tile.classList.toggle("tile-frequent", frequentTiles.has(tileId));
  });
}

function showWeatherChip(temp, label) {
  elements.weatherChip.textContent = `${temp}°F · ${label}`;
  elements.weatherChip.hidden = false;
}

async function loadWeather() {
  if (!elements.weatherChip) {
    return;
  }

  const cached = getCachedWeather();
  if (cached) {
    showWeatherChip(cached.temp, cached.label);
    return;
  }

  if (!navigator.geolocation && !lastKnownLocation) {
    elements.weatherChip.hidden = true;
    return;
  }

  try {
    let latitude;
    let longitude;

    if (lastKnownLocation) {
      ({ latitude, longitude } = lastKnownLocation);
    } else {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 5000,
          maximumAge: 600000,
        });
      });
      ({ latitude, longitude } = position.coords);
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const response = await apiRaw(url, { retry: false });
    if (!response.ok) {
      throw new Error("Weather request failed");
    }

    const data = await response.json();
    const temp = Math.round(Number(data.current?.temperature_2m));
    const label = mapWeatherCode(data.current?.weather_code);
    if (!Number.isFinite(temp) || !label) {
      throw new Error("Weather data missing");
    }

    showWeatherChip(temp, label);
    setCachedWeather({ temp, label });
  } catch {
    elements.weatherChip.hidden = true;
  }
}

function bindRecordCard() {
  if (!elements.recordCard) {
    return;
  }
  const advance = () => advanceRecord({ manual: true });
  elements.recordCard.addEventListener(
    "click",
    advance,
    pageSignal ? { signal: pageSignal } : false
  );
  elements.recordCard.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        advance();
      }
    },
    pageSignal ? { signal: pageSignal } : false
  );
}

function bindFilterRefresh() {
  const refreshDashboard = () => {
    loadMetrics({ showLoading: true });
    loadRecordSources({ showLoading: true });
    loadRecentTrips();
  };

  if (pageSignal) {
    document.addEventListener("filtersApplied", refreshDashboard, {
      signal: pageSignal,
    });
    return () => {};
  }

  document.addEventListener("filtersApplied", refreshDashboard);
  return () => {
    document.removeEventListener("filtersApplied", refreshDashboard);
  };
}

async function loadCountyStats() {
  try {
    const data = await apiGet("/api/geo-coverage/summary");
    if (data?.success) {
      setRecordSource("counties", {
        success: true,
        totalVisited: data?.levels?.county?.visited || 0,
        lastUpdated: data?.lastUpdated || null,
      });
    }
  } catch (error) {
    if (!isPageAbortError(error)) {
      console.warn("Failed to load county stats", error);
    }
  }
}

async function loadCoverageStats() {
  try {
    const data = await apiGet("/api/coverage/areas");
    if (data?.areas) {
      setRecordSource("coverage", data);
      renderCoverageRegister(data.areas);
      renderRecentArea(data.areas);
      renderAreaCount(data.areas);
    }
  } catch (error) {
    if (!isPageAbortError(error)) {
      console.warn("Failed to load coverage stats", error);
    }
  }
}

/**
 * The line under the title and the hero plate's road sign and map label
 * follow the coverage area driven most recently.
 */
function renderRecentArea(areas) {
  const area = describeRecentArea(areas);
  renderAreaLine(area);
  renderHeroPlate(area);
}

function renderAreaLine(area) {
  const line = elements.areaLine;
  if (!line) {
    return;
  }
  if (!area) {
    line.hidden = true;
    return;
  }
  const nameEl = document.createElement("strong");
  nameEl.textContent = area.name;
  line.replaceChildren(nameEl, formatAreaFigures(area));
  line.hidden = false;
}

function renderHeroPlate(area) {
  const { heroSignName, heroSignMiles, heroMapTitle } = elements;

  if (heroSignName) {
    heroSignName.textContent = area ? area.name.toUpperCase() : "EVERY STREET";
  }
  if (heroSignMiles) {
    let miles = "";
    if (area && !area.done && area.remaining !== null) {
      miles = `${area.remaining.toFixed(1)} MI`;
    } else if (area) {
      miles = `${Math.floor(area.pct)}%`;
    }
    heroSignMiles.textContent = miles;
  }
  if (heroMapTitle) {
    heroMapTitle.textContent = area?.region || area?.name || "Road Map";
  }

  fitPlateText();
  document.fonts?.ready?.then(fitPlateText).catch(() => {});
}

/** Squeeze long place names so they stay inside the sign and cartouche. */
function fitPlateText() {
  fitSvgText(elements.heroSignName, CONFIG.signTextWidth);
  fitSvgText(elements.heroMapTitle, CONFIG.mapTitleWidth);
}

function fitSvgText(el, maxWidth) {
  if (!el?.getComputedTextLength) {
    return;
  }
  el.removeAttribute("textLength");
  el.removeAttribute("lengthAdjust");
  try {
    if (el.getComputedTextLength() > maxWidth) {
      el.setAttribute("textLength", String(maxWidth));
      el.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  } catch {
    // Not rendered yet (hidden or detached); the fonts.ready pass retries.
  }
}

function renderAreaCount(areas) {
  const meta = elements.indexAreas;
  if (!meta) {
    return;
  }
  const count = Array.isArray(areas) ? areas.length : 0;
  const valueEl = meta.querySelector(".meta-value");
  const labelEl = meta.querySelector(".meta-label");
  if (valueEl) {
    valueEl.textContent = formatNumber(count);
  }
  if (labelEl) {
    labelEl.textContent = count === 1 ? "area" : "areas";
  }
  meta.hidden = count === 0;
}

/** A hand-drawn loop in pencil, stretched around a figure. */
function createPencilRing() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "pencil-ring");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M62 4C38 1 8 6 4 19c-3 11 18 18 44 18s49-6 48-18C95 8 70 3 46 5c-10 1-19 3-26 6"
  );
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(path);
  return svg;
}

function renderCoverageRegister(areas) {
  if (!elements.coverageSection || !elements.coverageRegister) {
    return;
  }

  const rows = (Array.isArray(areas) ? areas : [])
    .filter((area) => Number.isFinite(Number(area?.coverage_percentage)))
    .sort(
      (a, b) =>
        (Number(b?.total_length_miles) || 0) - (Number(a?.total_length_miles) || 0)
    )
    .slice(0, CONFIG.coverageRows);

  if (rows.length === 0) {
    elements.coverageSection.hidden = true;
    return;
  }

  const fills = [];
  const items = rows.map((area) => {
    const pct = Math.max(0, Math.min(100, Number(area.coverage_percentage)));
    const remaining = getRemainingDriveableMiles(area);
    const name = area.display_name?.split(",")[0]?.trim() || "Unnamed area";
    const done = pct >= 100;

    const item = document.createElement("li");
    item.className = `coverage-register-row${done ? " is-complete" : ""}`;

    const link = document.createElement("a");
    link.className = "coverage-register-link";
    link.href = "/coverage-management";
    link.setAttribute(
      "aria-label",
      `${name}: ${pct.toFixed(1)} percent driven${
        remaining !== null ? `, ${remaining.toFixed(1)} miles left` : ""
      }`
    );

    const nameEl = document.createElement("span");
    nameEl.className = "coverage-register-name";
    nameEl.textContent = name;

    const bar = document.createElement("span");
    bar.className = "survey-bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "survey-fill";
    bar.appendChild(fill);
    fills.push([fill, pct]);

    const pctEl = document.createElement("span");
    pctEl.className = "coverage-register-pct";
    pctEl.textContent = `${pct.toFixed(1)}%`;
    if (pct >= 80 && !done) {
      pctEl.appendChild(createPencilRing());
    }

    const leftEl = document.createElement("span");
    leftEl.className = "coverage-register-left";
    if (done) {
      leftEl.textContent = "Complete";
    } else {
      leftEl.textContent = remaining !== null ? `${remaining.toFixed(1)} mi left` : "";
    }

    link.append(nameEl, bar, pctEl, leftEl);
    item.appendChild(link);
    return item;
  });

  // Periodic refreshes update the figures in place; only the first render
  // draws the scales and pencil rings in.
  const register = elements.coverageRegister;
  const redraw = register.dataset.drawn === "true";
  register.classList.toggle("is-settled", redraw);
  register.replaceChildren(...items);
  elements.coverageSection.hidden = false;

  const setWidths = () => {
    fills.forEach(([fill, pct]) => {
      fill.style.width = `${pct}%`;
    });
  };
  if (redraw) {
    setWidths();
    return;
  }
  register.dataset.drawn = "true";
  // Let the hatching run out along each scale once the rows are painted.
  requestAnimationFrame(() => requestAnimationFrame(setWidths));
}

function setRecordSource(key, data) {
  recordSources = { ...recordSources, [key]: data };
  if (recordLoading) {
    return;
  }
  updateRecordEntries();
}

function setRecordLoading(isLoading) {
  recordLoading = Boolean(isLoading);
  if (!elements.recordCard) {
    return;
  }
  elements.recordCard.classList.toggle("is-loading", recordLoading);
  elements.recordCard.setAttribute("aria-busy", recordLoading ? "true" : "false");
  if (recordLoading) {
    renderRecordLoading();
  }
}

function renderRecordLoading() {
  if (recordRotationIntervalId) {
    clearInterval(recordRotationIntervalId);
    recordRotationIntervalId = null;
  }
  if (elements.recordValue) {
    elements.recordValue.textContent = "...";
  }
  if (elements.recordTitle) {
    elements.recordTitle.textContent = "Updating records";
  }
  if (elements.recordDate) {
    elements.recordDate.textContent = getSelectedRangeStatusText();
  }
  clearRecordMarginalia();
  currentRecordId = null;
}

function updateRecordEntries() {
  recordEntries = buildRecordEntries();
  if (recordEntries.length === 0) {
    renderEmptyRecord();
    startRecordRotation();
    return;
  }

  if (!recordInitialized) {
    recordIndex = getInitialRecordIndex(recordEntries.length);
    recordInitialized = true;
  }
  if (recordIndex >= recordEntries.length) {
    recordIndex = 0;
  }

  renderRecordEntry(recordEntries[recordIndex]);
  startRecordRotation();
}

function buildRecordEntries() {
  const entries = [];
  const { insights } = recordSources;

  if (insights?.records) {
    const { records } = insights;
    addRecordEntry(entries, {
      id: "longest-trip-distance",
      title: "Longest trip distance",
      value: formatMilesValue(records.longest_trip?.distance, 1),
      date: records.longest_trip?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "longest-trip-duration",
      title: "Longest trip duration",
      value: formatDurationCompact(records.longest_duration?.duration_seconds),
      date: records.longest_duration?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-speed",
      title: "Top speed",
      value: formatSpeedValue(records.max_speed?.max_speed, 1),
      date: records.max_speed?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "avg-speed",
      title: "Highest average speed",
      value: formatSpeedValue(records.avg_speed?.avg_speed, 1),
      date: records.avg_speed?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-idle",
      title: "Most idle time in a trip",
      value: formatDurationCompact(records.max_idle?.idle_seconds),
      date: records.max_idle?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-hard-braking",
      title: "Most hard braking events",
      value: formatCountValue(records.max_hard_braking?.hard_braking, "event"),
      date: records.max_hard_braking?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-hard-accel",
      title: "Most hard acceleration events",
      value: formatCountValue(records.max_hard_accel?.hard_accel, "event"),
      date: records.max_hard_accel?.recorded_at,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-day-distance",
      title: "Most miles in a day",
      value: formatMilesValue(records.max_day_distance?.distance, 1),
      date: records.max_day_distance?.date,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-day-trips",
      title: "Most trips in a day",
      value: formatCountValue(records.max_day_trips?.trips, "trip"),
      date: records.max_day_trips?.date,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "max-day-duration",
      title: "Most drive time in a day",
      value: formatDurationCompact(records.max_day_duration?.duration_seconds),
      date: records.max_day_duration?.date,
      datePrefix: "On",
    });

    const mostVisited = records.most_visited;
    if (mostVisited) {
      const title = mostVisited.location
        ? `Most visited destination: ${mostVisited.location}`
        : "Most visited destination";
      addRecordEntry(entries, {
        id: "most-visited",
        title,
        value: formatCountValue(mostVisited.count, "visit"),
        date: mostVisited.lastVisit,
        datePrefix: "Last visit",
      });
    }
  }

  const gas = recordSources.gas?.records;
  if (gas) {
    addRecordEntry(entries, {
      id: "best-mpg",
      title: "Best MPG fill-up",
      value: formatMilesValue(gas.best_mpg?.mpg, 1, "mpg"),
      date: gas.best_mpg?.fillup_time,
      datePrefix: "On",
    });
    addRecordEntry(entries, {
      id: "cheapest-price",
      title: "Lowest price per gallon",
      value: formatPricePerGallon(gas.cheapest_price?.price_per_gallon),
      date: gas.cheapest_price?.fillup_time,
      datePrefix: "On",
    });
  }

  const { counties } = recordSources;
  if (counties?.success) {
    addRecordEntry(entries, {
      id: "counties-visited",
      title: "Counties visited",
      value: formatCountValue(counties.totalVisited, "county", "counties"),
      date: counties.lastUpdated,
      datePrefix: "Updated",
    });
  }

  const { coverage } = recordSources;
  if (coverage?.areas?.length) {
    const bestArea = coverage.areas.reduce((best, area) => {
      if (!best) {
        return area;
      }
      return area.coverage_percentage > best.coverage_percentage ? area : best;
    }, null);
    if (bestArea) {
      const coverageDate = bestArea.last_synced || bestArea.created_at;
      addRecordEntry(entries, {
        id: "coverage-best",
        title: `Coverage in ${bestArea.display_name}`,
        value: formatPercentage(bestArea.coverage_percentage),
        date: coverageDate,
        datePrefix: bestArea.last_synced ? "Last synced" : "Created",
      });
    }
  }

  return entries;
}

function addRecordEntry(entries, { id, title, value, date, datePrefix }) {
  if (!value || value === "--") {
    return;
  }
  const parsedDate = parseRecordDate(date);
  if (!parsedDate) {
    return;
  }
  const dateText = formatRecordDate(parsedDate);
  if (!dateText) {
    return;
  }
  entries.push({
    id,
    title,
    value,
    dateText: datePrefix ? `${datePrefix} ${dateText}` : dateText,
  });
}

function renderRecordEntry(entry) {
  if (!entry) {
    renderEmptyRecord();
    return;
  }
  if (elements.recordValue) {
    elements.recordValue.textContent = entry.value;
  }
  if (elements.recordTitle) {
    elements.recordTitle.textContent = entry.title;
  }
  if (elements.recordDate) {
    elements.recordDate.textContent = entry.dateText;
  }
  if (elements.recordCount) {
    elements.recordCount.textContent =
      recordEntries.length > 1 ? `${recordIndex + 1} of ${recordEntries.length}` : "";
  }
  if (entry.id !== currentRecordId) {
    currentRecordId = entry.id;
    storeRecordIndex(recordIndex);
  }
}

function renderEmptyRecord() {
  if (elements.recordValue) {
    elements.recordValue.textContent = "--";
  }
  if (elements.recordTitle) {
    elements.recordTitle.textContent = "--";
  }
  if (elements.recordDate) {
    elements.recordDate.textContent = "--";
  }
  clearRecordMarginalia();
  currentRecordId = null;
}

function clearRecordMarginalia() {
  if (elements.recordCount) {
    elements.recordCount.textContent = "";
  }
}

function advanceRecord({ manual = false } = {}) {
  if (recordEntries.length === 0) {
    return;
  }
  recordIndex = (recordIndex + 1) % recordEntries.length;
  renderRecordEntry(recordEntries[recordIndex]);
  if (manual) {
    startRecordRotation({ reset: true });
  }
}

function startRecordRotation({ reset = false } = {}) {
  if (recordEntries.length < 2) {
    if (recordRotationIntervalId) {
      clearInterval(recordRotationIntervalId);
      recordRotationIntervalId = null;
    }
    return;
  }
  if (recordRotationIntervalId && !reset) {
    return;
  }
  if (recordRotationIntervalId) {
    clearInterval(recordRotationIntervalId);
    recordRotationIntervalId = null;
  }
  recordRotationIntervalId = setInterval(() => {
    advanceRecord();
  }, CONFIG.recordRotationInterval);
}

function getInitialRecordIndex(entryCount) {
  const stored = getStoredValue(CONFIG.recordRotationStorageKey);
  if (
    stored &&
    Number.isInteger(stored.index) &&
    stored.index >= 0 &&
    stored.index < entryCount
  ) {
    const elapsed = Date.now() - (stored.timestamp || 0);
    if (elapsed < CONFIG.recordRotationInterval) {
      return stored.index;
    }
    return (stored.index + 1) % entryCount;
  }
  return 0;
}

function storeRecordIndex(index) {
  try {
    localStorage.setItem(
      CONFIG.recordRotationStorageKey,
      JSON.stringify({ index, timestamp: Date.now() })
    );
  } catch {
    // Ignore storage failures.
  }
}

function parseRecordDate(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatRecordDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMilesValue(value, decimals = 1, suffix = "mi") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(decimals)} ${suffix}`;
}

function formatSpeedValue(value, decimals = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(decimals)} mph`;
}

function formatCountValue(value, singular, plural) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const rounded = Math.round(numeric);
  const label = rounded === 1 ? singular : plural || `${singular}s`;
  return `${rounded.toLocaleString()} ${label}`;
}

function formatPricePerGallon(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `$${numeric.toFixed(2)}/gal`;
}

function formatPercentage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(2)}%`;
}

function getRouteCounts() {
  return getStoredValue("es:route-counts") || {};
}

function _getMostVisitedPath(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return null;
  }
  const [path] = entries.sort((a, b) => b[1] - a[1])[0];
  return { path, timestamp: null };
}

function getStoredValue(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getCachedWeather() {
  const cached = getStoredValue("es:weather-cache");
  if (!cached) {
    return null;
  }
  const maxAge = 20 * 60 * 1000;
  if (Date.now() - cached.timestamp > maxAge) {
    return null;
  }
  return cached;
}

function setCachedWeather({ temp, label }) {
  try {
    localStorage.setItem(
      "es:weather-cache",
      JSON.stringify({
        temp,
        label,
        timestamp: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures.
  }
}

function mapWeatherCode(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric === 0) {
    return "Clear";
  }
  if ([1, 2].includes(numeric)) {
    return "Partly Cloudy";
  }
  if (numeric === 3) {
    return "Cloudy";
  }
  if ([45, 48].includes(numeric)) {
    return "Fog";
  }
  if ([51, 53, 55, 56, 57].includes(numeric)) {
    return "Drizzle";
  }
  if ([61, 63, 65, 66, 67].includes(numeric)) {
    return "Rain";
  }
  if ([71, 73, 75, 77].includes(numeric)) {
    return "Snow";
  }
  if ([80, 81, 82].includes(numeric)) {
    return "Showers";
  }
  if ([95, 96, 99].includes(numeric)) {
    return "Storm";
  }
  return "Clear";
}

function buildTripMetricsQueryParams() {
  const params = new URLSearchParams();
  const startDate = DateUtils.getStartDate();
  const endDate = DateUtils.getEndDate();

  if (startDate) {
    params.set("start_date", startDate);
  }
  if (endDate) {
    params.set("end_date", endDate);
  }

  const storeVehicle = store.get?.("filters.vehicle");
  const savedVehicle = getStorage(APP_CONFIG.STORAGE_KEYS.selectedVehicle);
  const imei =
    (typeof storeVehicle === "string" && storeVehicle.trim()) ||
    (typeof savedVehicle === "string" && savedVehicle.trim()) ||
    null;

  if (imei) {
    params.set("imei", imei);
  }

  return params;
}

function getSelectedRangeStatusText() {
  const startDate = DateUtils.getStartDate();
  const endDate = DateUtils.getEndDate();
  if (startDate || endDate) {
    return "Checking selected range";
  }
  return "Checking all time";
}

/** Name the totals after the selected range, as the date picker labels it. */
function updateLogHeading() {
  const { logHeading } = elements;
  if (!logHeading) {
    return;
  }
  const today = DateUtils.getCurrentDate();
  const isToday =
    DateUtils.getStartDate() === today && DateUtils.getEndDate() === today;
  const label = document.getElementById("date-display")?.textContent?.trim();
  logHeading.textContent = isToday ? "Today" : label || "Selected range";
}

/** Keep the log heading in step with the header's date-range label. */
function watchDateRangeLabel() {
  const display = document.getElementById("date-display");
  if (!display || typeof MutationObserver !== "function") {
    return () => {};
  }
  const observer = new MutationObserver(() => updateLogHeading());
  observer.observe(display, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}

/** Hours at the wheel, as a ledger figure and its unit. */
function formatWheelTime(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { value: "0", unit: "hr" };
  }
  const hours = numeric / 3600;
  if (hours >= 10) {
    return { value: formatNumber(Math.round(hours)), unit: "hr" };
  }
  if (hours >= 1) {
    return { value: hours.toFixed(1), unit: "hr" };
  }
  return { value: String(Math.max(1, Math.round(numeric / 60))), unit: "min" };
}

function setMetricsLoading(isLoading) {
  [elements.statMiles, elements.statTrips, elements.statTime].forEach((el) => {
    const figure = el?.closest?.(".snapshot-figure");
    if (!figure) {
      return;
    }
    figure.classList.toggle("is-loading", Boolean(isLoading));
    figure.setAttribute("aria-busy", isLoading ? "true" : "false");
  });
}

/**
 * Fetch trip metrics and update stats
 */
async function loadMetrics({ showLoading = false } = {}) {
  const requestId = ++metricsLoadRequestId;
  if (showLoading) {
    setMetricsLoading(true);
  }
  try {
    const params = buildTripMetricsQueryParams();
    const qs = params.toString();
    const data = await apiGet(qs ? `/api/metrics?${qs}` : "/api/metrics");

    if (requestId !== metricsLoadRequestId || pageSignal?.aborted) {
      return;
    }

    // Update stats with animation
    const miles = parseFloat(data.total_distance) || 0;
    const trips = parseInt(data.total_trips, 10) || 0;

    const milesDecimals = miles > 0 && miles < 10 ? 1 : 0;
    if (metricAnimator?.animate) {
      metricAnimator.animate(elements.statMiles, miles, { decimals: milesDecimals });
      metricAnimator.animate(elements.statTrips, trips, { decimals: 0 });
    } else {
      animateValue(
        elements.statMiles,
        miles,
        (value) => formatNumber(value, milesDecimals),
        CONFIG.animationDuration
      );
      animateValue(elements.statTrips, trips, formatNumber, CONFIG.animationDuration);
    }

    const wheelTime = formatWheelTime(data.total_duration_seconds);
    if (elements.statTime) {
      elements.statTime.textContent = wheelTime.value;
    }
    if (elements.statTimeUnit) {
      elements.statTimeUnit.textContent = wheelTime.unit;
    }
  } catch (error) {
    if (requestId !== metricsLoadRequestId || isPageAbortError(error)) {
      return;
    }
    if (elements.statMiles) {
      elements.statMiles.textContent = "--";
    }
    if (elements.statTrips) {
      elements.statTrips.textContent = "--";
    }
    if (elements.statTime) {
      elements.statTime.textContent = "--";
    }
  } finally {
    if (requestId === metricsLoadRequestId && !pageSignal?.aborted) {
      setMetricsLoading(false);
    }
  }
}

/**
 * Fetch recent trips for activity feed
 */
async function loadRecentTrips() {
  const requestId = ++recentTripsLoadRequestId;
  try {
    const params = buildTripMetricsQueryParams();
    params.set("limit", "60");
    const data = await apiGet(`/api/trips/history?${params.toString()}`);
    if (requestId !== recentTripsLoadRequestId || pageSignal?.aborted) {
      return;
    }
    const trips = data.trips || data || [];

    // Extract last known location from the most recent trip
    if (trips.length > 0) {
      const lastTrip = trips[0];
      if (
        lastTrip.destinationGeoPoint?.coordinates &&
        lastTrip.destinationGeoPoint.coordinates.length >= 2
      ) {
        const [lon, lat] = lastTrip.destinationGeoPoint.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          lastKnownLocation = { latitude: lat, longitude: lon };
        }
      }
    }

    // Update recent trip meta
    if (elements.recentTrip) {
      const valueEl = elements.recentTrip.querySelector(".meta-value");
      const lastTrip = trips[0];
      const lastTripTime = lastTrip?.endTime || lastTrip?.startTime;
      if (valueEl) {
        valueEl.textContent = lastTripTime
          ? formatRelativeTimeShort(new Date(lastTripTime))
          : "--";
      }
      elements.recentTrip.hidden = !lastTripTime;
    }

    // Populate activity feed
    populateActivityFeed(trips);
  } catch (error) {
    if (requestId !== recentTripsLoadRequestId || isPageAbortError(error)) {
      return;
    }
    const valueEl = elements.recentTrip?.querySelector(".meta-value");
    if (valueEl) {
      valueEl.textContent = "--";
    }
    if (elements.recentTrip) {
      elements.recentTrip.hidden = true;
    }
    populateActivityFeed([]);
  }
}

async function loadRecordSources({ showLoading = false } = {}) {
  const requestId = ++recordsLoadRequestId;
  if (showLoading) {
    recordSources = { ...recordSources, insights: null, gas: null };
    setRecordLoading(true);
  }

  const [insightsResult, gasResult] = await Promise.allSettled([
    fetchInsightsData(),
    fetchGasStatsData(),
  ]);

  if (requestId !== recordsLoadRequestId || pageSignal?.aborted) {
    return;
  }

  if (insightsResult.status === "rejected") {
    if (!isPageAbortError(insightsResult.reason)) {
      console.warn("Failed to load driving insights", insightsResult.reason);
    }
  }
  if (gasResult.status === "rejected") {
    if (!isPageAbortError(gasResult.reason)) {
      console.warn("Failed to load gas stats", gasResult.reason);
    }
  }

  recordSources = {
    ...recordSources,
    insights: insightsResult.status === "fulfilled" ? insightsResult.value : null,
    gas: gasResult.status === "fulfilled" ? gasResult.value : null,
  };

  if (gasResult.status === "fulfilled") {
    updateLastFillup(gasResult.value);
  }

  setRecordLoading(false);
  updateRecordEntries();
}

function fetchInsightsData() {
  const params = buildTripMetricsQueryParams();
  params.set("include_movement", "false");
  return apiGet(`/api/driving-insights?${params.toString()}`);
}

function fetchGasStatsData() {
  const params = buildTripMetricsQueryParams();
  const qs = params.toString();
  return apiGet(qs ? `/api/gas-statistics?${qs}` : "/api/gas-statistics");
}

function updateLastFillup(data) {
  if (!elements.lastFillup) {
    return;
  }
  const valueEl = elements.lastFillup.querySelector(".meta-value");
  if (valueEl) {
    valueEl.textContent = data?.average_mpg ? data.average_mpg.toFixed(1) : "--";
  }
}

/**
 * Check if there's an active live tracking session
 */
async function checkLiveTracking() {
  if (!isBouncieLiveTrackingEnabled()) {
    return;
  }
  try {
    const data = await apiGet("/api/active_trip");
    if (data.enabled === false) {
      disableBouncieLiveTracking();
      clearInterval(liveTrackingIntervalId);
      liveTrackingIntervalId = null;
      if (elements.liveIndicator) {
        (
          elements.liveIndicator.closest(".status-chip") || elements.liveIndicator
        ).hidden = true;
      }
      return;
    }

    if (elements.liveIndicator) {
      if (data.trip && data.trip.status === "active") {
        elements.liveIndicator.classList.add("active");
        elements.liveIndicator.title = "Live tracking active";
      } else {
        elements.liveIndicator.classList.remove("active");
        elements.liveIndicator.title = "No active tracking";
      }
    }
  } catch {
    if (elements.liveIndicator) {
      elements.liveIndicator.classList.remove("active");
    }
  }
}

/**
 * Write the most recent trips into the logbook: date, departure time,
 * destination, duration, and miles, with a page total underneath.
 */
function populateActivityFeed(trips) {
  const feed = elements.activityFeed;
  if (!feed) {
    return;
  }

  const entries = (Array.isArray(trips) ? trips : []).slice(0, CONFIG.activityLimit);
  if (entries.length === 0) {
    const row = document.createElement("tr");
    row.className = "logbook-empty";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No trips in this range.";
    row.appendChild(cell);
    feed.replaceChildren(row);
    if (elements.logbookFoot) {
      elements.logbookFoot.hidden = true;
    }
    return;
  }

  let totalMiles = 0;
  const rows = entries.map((trip) => {
    const miles = Number.parseFloat(trip.distance);
    if (Number.isFinite(miles)) {
      totalMiles += miles;
    }
    const start = parseTripTime(trip.startTime);
    const end = parseTripTime(trip.endTime);
    const when = start || end;

    const row = document.createElement("tr");
    row.className = "logbook-row";

    const dateCell = document.createElement("td");
    dateCell.className = "logbook-date";
    dateCell.textContent = when
      ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "--";

    const timeCell = document.createElement("td");
    timeCell.className = "logbook-time";
    timeCell.textContent = when
      ? when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : "";

    const destCell = document.createElement("td");
    destCell.className = "logbook-dest";
    const destination = formatDestination(trip.destination);
    if (trip.transactionId) {
      const link = document.createElement("a");
      link.href = `/trips/${encodeURIComponent(trip.transactionId)}`;
      link.textContent = destination;
      link.title = destination;
      destCell.appendChild(link);
    } else {
      destCell.textContent = destination;
    }

    const durationCell = document.createElement("td");
    durationCell.className = "logbook-num logbook-duration";
    durationCell.textContent =
      start && end ? formatDurationCompact((end - start) / 1000) || "" : "";

    const milesCell = document.createElement("td");
    milesCell.className = "logbook-num logbook-miles";
    milesCell.textContent = Number.isFinite(miles) ? miles.toFixed(1) : "--";

    row.append(dateCell, timeCell, destCell, durationCell, milesCell);
    return row;
  });

  feed.replaceChildren(...rows);

  if (elements.logbookFoot && elements.logbookTotal) {
    elements.logbookTotal.textContent = `${totalMiles.toFixed(1)} mi`;
    if (elements.logbookTotalLabel) {
      elements.logbookTotalLabel.textContent = `Total, ${entries.length} ${
        entries.length === 1 ? "trip" : "trips"
      }`;
    }
    elements.logbookFoot.hidden = false;
  }
}

function parseTripTime(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Format a destination object for display
 */
function formatDestination(dest) {
  if (!dest) {
    return "Unknown";
  }
  if (typeof dest === "string") {
    return dest;
  }
  if (dest.name) {
    return dest.name;
  }
  if (dest.formatted_address) {
    // Shorten the address
    const parts = dest.formatted_address.split(",");
    return parts[0] || dest.formatted_address;
  }
  return "Unknown";
}

/**
 * Set up periodic data refresh
 */
function setupRefreshInterval() {
  clearIntervals();

  // Refresh data periodically
  refreshIntervalId = setInterval(() => {
    loadAllData();
  }, CONFIG.refreshInterval);

  // Check live tracking more frequently
  if (isBouncieLiveTrackingEnabled()) {
    liveTrackingIntervalId = setInterval(() => {
      checkLiveTracking();
    }, 10000); // Every 10 seconds
  }
}

function clearIntervals() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  if (liveTrackingIntervalId) {
    clearInterval(liveTrackingIntervalId);
    liveTrackingIntervalId = null;
  }
  if (recordRotationIntervalId) {
    clearInterval(recordRotationIntervalId);
    recordRotationIntervalId = null;
  }
}
