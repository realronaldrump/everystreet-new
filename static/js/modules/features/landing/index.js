/**
 * Landing Page Controller
 * Fetches live data and animates the landing page
 */

import { CONFIG as APP_CONFIG } from "../../core/config.js";
import { createFeatureApi } from "../../core/feature-api.js";
import { swupReady } from "../../core/navigation.js";
import store from "../../core/store.js";
import metricAnimator from "../../ui/metric-animator.js";
import notificationManager from "../../ui/notifications.js";
import { formatDurationCompact } from "../../utils/formatting.js";
import {
  DateUtils,
  formatNumber,
  formatRelativeTimeShort,
  getStorage,
} from "../../utils.js";
import {
  computeConsistencyStats,
  computeTimeSignature,
} from "../../insights/derived-insights.js";
import { animateValue } from "./animations.js";
import { bindWidgetEditToggle, updateGreeting } from "./hero.js";
import streakHeatmap, { buildHeatmapWindow } from "../../ui/streak-heatmap.js";
import wrappedExperience from "../../ui/wrapped.js";

// Configuration
const CONFIG = {
  refreshInterval: 60000, // 1 minute
  recordRotationInterval: 30 * 60 * 1000, // 30 minutes
  recordRotationStorageKey: "es:record-rotation",
  animationDuration: 500,
  activityLimit: 5,
};

// DOM Elements (cached after DOMContentLoaded)
let elements = {};
let refreshIntervalId = null;
let liveTrackingIntervalId = null;
let recordRotationIntervalId = null;
let swipeActionsBound = false;
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
let streakHeatmapLoadRequestId = 0;
let removeFilterRefreshListener = null;
let ambientCleanup = null;
let featureApi = createFeatureApi();
const apiGet = (url, options = {}) => featureApi.get(url, options);
const apiRaw = (url, options = {}) => featureApi.raw(url, options);
const isAbortError = (error) =>
  error?.name === "AbortError" || pageSignal?.aborted === true;

/**
 * Initialize the landing page
 */
export default function initLandingPage({ signal, cleanup, api } = {}) {
  pageSignal = signal || null;
  featureApi = api || createFeatureApi({ signal: pageSignal });
  cacheElements();
  updateGreeting(elements);

  highlightFrequentTiles();
  bindWidgetEditToggle(elements, pageSignal);

  loadAllData();
  setupRefreshInterval();
  checkLiveTracking();
  bindSwipeActions();
  bindRecordCard();
  removeFilterRefreshListener = bindFilterRefresh();

  // Streak heatmap + Wrapped + Ambient background
  bindWrappedLauncher();
  setupAmbientBackground();
  const teardown = () => {
    cleanupLandingTransientUi();
    clearIntervals();
    removeFilterRefreshListener?.();
    removeFilterRefreshListener = null;
    swipeActionsBound = false;
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
  elements = {
    greetingTitle: document.getElementById("greeting-title"),
    greetingSubtitle: document.getElementById("greeting-subtitle"),
    weatherChip: document.getElementById("weather-chip"),
    statMiles: document.getElementById("stat-miles"),
    statTrips: document.getElementById("stat-trips"),
    liveIndicator: document.getElementById("live-indicator"),
    recentTrip: document.getElementById("recent-trip"),
    lastFillup: document.getElementById("last-fillup"),
    activityFeed: document.getElementById("activity-feed"),
    recordCard: document.getElementById("record-card"),
    recordValue: document.getElementById("record-value"),
    recordTitle: document.getElementById("record-title"),
    recordDate: document.getElementById("record-date"),

    widgetEditToggle: document.getElementById("widget-edit-toggle"),
    navTiles: Array.from(document.querySelectorAll(".nav-tile")),
  };
}

/**
 * Load all data sources in parallel
 */
async function loadAllData() {
  try {
    updateGreeting(elements);

    highlightFrequentTiles();

    // Load trips first to get location
    await loadRecentTrips();

    await Promise.all([
      loadMetrics(),
      loadStreakHeatmap(),
      loadGasStats(),
      loadInsights(),
      loadCountyStats(),
      loadCoverageStats(),
      checkLiveTracking(),
      loadWeather(),
    ]);
  } catch (error) {
    if (!isAbortError(error)) {
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
    "/coverage-navigator": "navigate",
    "/trips": "trips",
    "/insights": "insights",
    "/gas-tracking": "gas",
    "/visits": "visits",
    "/export": "export",
    "/coverage-management": "areas",
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

async function loadWeather() {
  if (!elements.weatherChip) {
    return;
  }

  const cached = getCachedWeather();
  if (cached) {
    elements.weatherChip.textContent = `Weather: ${cached.temp}F ${cached.label}`;
    return;
  }

  if (!navigator.geolocation && !lastKnownLocation) {
    elements.weatherChip.textContent = "Weather: --";
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

    elements.weatherChip.textContent = `Weather: ${temp}F ${label}`;
    setCachedWeather({ temp, label });
  } catch {
    elements.weatherChip.textContent = "Weather: --";
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
  const refreshMetrics = () => {
    loadMetrics();
    loadStreakHeatmap();
  };

  if (pageSignal) {
    document.addEventListener("filtersApplied", refreshMetrics, {
      signal: pageSignal,
    });
    return () => {};
  }

  document.addEventListener("filtersApplied", refreshMetrics);
  return () => {
    document.removeEventListener("filtersApplied", refreshMetrics);
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
    if (!isAbortError(error)) {
      console.warn("Failed to load county stats", error);
    }
  }
}

async function loadCoverageStats() {
  try {
    const data = await apiGet("/api/coverage/areas");
    if (data?.areas) {
      setRecordSource("coverage", data);
    }
  } catch (error) {
    if (!isAbortError(error)) {
      console.warn("Failed to load coverage stats", error);
    }
  }
}

function setRecordSource(key, data) {
  recordSources = { ...recordSources, [key]: data };
  updateRecordEntries();
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
  currentRecordId = null;
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
  const startDate = DateUtils.getStartDate?.();
  const endDate = DateUtils.getEndDate?.();

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

function getExplicitDateRange() {
  const storedStartDate =
    store.get?.("filters.startDate") || getStorage(APP_CONFIG.STORAGE_KEYS.startDate);
  const storedEndDate =
    store.get?.("filters.endDate") || getStorage(APP_CONFIG.STORAGE_KEYS.endDate);

  return {
    startDate:
      typeof storedStartDate === "string" && storedStartDate.trim()
        ? storedStartDate.trim()
        : null,
    endDate:
      typeof storedEndDate === "string" && storedEndDate.trim()
        ? storedEndDate.trim()
        : null,
  };
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatLocalDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function resolveDateRange({ fallbackDays = null, fallbackStart = null, fallbackEnd = null } = {}) {
  const today = startOfLocalDay();
  let { startDate, endDate } = getExplicitDateRange();

  if (!startDate && !endDate) {
    if (fallbackDays) {
      startDate = formatLocalDateInput(addDays(today, -(fallbackDays - 1)));
      endDate = formatLocalDateInput(today);
    } else {
      startDate = fallbackStart;
      endDate = fallbackEnd;
    }
  } else {
    const parsedEnd = parseDateInput(endDate) || parseDateInput(fallbackEnd) || today;
    if (!startDate && fallbackDays) {
      startDate = formatLocalDateInput(addDays(parsedEnd, -(fallbackDays - 1)));
    } else if (!startDate) {
      startDate = fallbackStart;
    }
    if (!endDate) {
      endDate = fallbackEnd || formatLocalDateInput(today);
    }
  }

  return { startDate, endDate };
}

function applyDateRangeToParams(params, { startDate, endDate }) {
  if (startDate) {
    params.set("start_date", startDate);
  }
  if (endDate) {
    params.set("end_date", endDate);
  }
  return params;
}

function formatStoryDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPeriodLabel(range, fallbackLabel = "Year in Review") {
  const start = parseDateInput(range?.startDate);
  const end = parseDateInput(range?.endDate);
  if (!start || !end) {
    return fallbackLabel;
  }

  const todayLabel = formatLocalDateInput(startOfLocalDay());
  if (
    range.startDate === `${start.getFullYear()}-01-01` &&
    range.endDate === todayLabel
  ) {
    return String(start.getFullYear());
  }

  const sameDay = range.startDate === range.endDate;
  if (sameDay) {
    return formatStoryDate(start);
  }

  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth) {
    return start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }

  const startLabel = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const endLabel = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startLabel} - ${endLabel}`;
}

function buildWrappedData({
  metricsData,
  insightsData,
  analyticsData,
  periodRange,
}) {
  const totalMiles = parseFloat(metricsData?.total_distance) || 0;
  const totalTrips = parseInt(metricsData?.total_trips, 10) || 0;
  const totalHours =
    Number(metricsData?.total_duration_seconds) > 0
      ? Number(metricsData.total_duration_seconds) / 3600
      : 0;

  const records = insightsData?.records || {};
  const topDestinations = (Array.isArray(insightsData?.top_destinations)
    ? insightsData.top_destinations
    : []
  )
    .map((destination) => ({
      name: formatDestination(destination?.location || destination?.name),
      visits: Number(destination?.visits) || 0,
    }))
    .filter((destination) => destination.name && destination.visits > 0);

  const dailyDistances = Array.isArray(analyticsData?.daily_distances)
    ? analyticsData.daily_distances
    : [];
  const consistency = computeConsistencyStats(dailyDistances);
  const timeSignature = computeTimeSignature(
    analyticsData?.time_distribution || [],
    analyticsData?.weekday_distribution || []
  );

  return {
    periodLabel: formatPeriodLabel(periodRange),
    totalMiles,
    totalTrips,
    totalHours,
    longestTripMiles: Number(records.longest_trip?.distance) || 0,
    longestTripDate: formatStoryDate(records.longest_trip?.recorded_at),
    busiestDayTrips: Number(records.max_day_trips?.trips) || 0,
    busiestDayDate: formatStoryDate(
      records.max_day_trips?.date || records.max_day_distance?.date
    ),
    busiestDayMiles: Number(records.max_day_distance?.distance) || 0,
    topDestinations,
    drivingDays: consistency.activeDays || 0,
    currentStreak: consistency.currentStreak || 0,
    favoriteDayOfWeek: timeSignature.peakDayLabel || "",
    favoriteHour: timeSignature.weightedHourLabel || "",
  };
}

/**
 * Fetch trip metrics and update stats
 */
async function loadMetrics() {
  const requestId = ++metricsLoadRequestId;
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

    if (metricAnimator?.animate) {
      metricAnimator.animate(elements.statMiles, miles, { decimals: 0 });
      metricAnimator.animate(elements.statTrips, trips, { decimals: 0 });
    } else {
      animateValue(elements.statMiles, miles, formatNumber, CONFIG.animationDuration);
      animateValue(elements.statTrips, trips, formatNumber, CONFIG.animationDuration);
    }

    // Numbers That Tell Stories — add contextual descriptions
    updateStatContext(miles, trips);
  } catch (error) {
    if (requestId !== metricsLoadRequestId || isAbortError(error)) {
      return;
    }
    if (elements.statMiles) {
      elements.statMiles.textContent = "--";
    }
    if (elements.statTrips) {
      elements.statTrips.textContent = "--";
    }
  }
}

/**
 * Fetch recent trips for activity feed
 */
async function loadRecentTrips() {
  try {
    const data = await apiGet("/api/trips/history?limit=60");
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
    if (trips.length > 0 && elements.recentTrip) {
      const lastTrip = trips[0];
      const lastTripTime = lastTrip.endTime || lastTrip.startTime;
      if (lastTripTime) {
        const valueEl = elements.recentTrip.querySelector(".meta-value");
        if (valueEl) {
          valueEl.textContent = formatRelativeTimeShort(new Date(lastTripTime));
        }
      }
    }

    // Populate activity feed
    populateActivityFeed(trips);
  } catch {
    populateActivityFeed([]);
  }
}

/**
 * Fetch driving insights for records
 */
async function loadInsights() {
  try {
    const params = buildTripMetricsQueryParams();
    const qs = params.toString();
    const data = await apiGet(
      qs ? `/api/driving-insights?${qs}` : "/api/driving-insights"
    );
    setRecordSource("insights", data);
  } catch (error) {
    if (!isAbortError(error)) {
      console.warn("Failed to load driving insights", error);
    }
  }
}

/**
 * Fetch gas/fuel statistics
 */
async function loadGasStats() {
  try {
    const data = await apiGet("/api/gas-statistics");
    setRecordSource("gas", data);

    if (elements.lastFillup) {
      const valueEl = elements.lastFillup.querySelector(".meta-value");
      if (valueEl && data.average_mpg) {
        valueEl.textContent = data.average_mpg.toFixed(1);
      }
    }
  } catch (error) {
    if (!isAbortError(error)) {
      console.warn("Failed to load gas stats", error);
    }
  }
}

/**
 * Check if there's an active live tracking session
 */
async function checkLiveTracking() {
  try {
    const data = await apiGet("/api/active_trip");

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
 * Populate the activity feed with recent trips
 */
function populateActivityFeed(trips) {
  if (!elements.activityFeed) {
    return;
  }

  if (!trips || trips.length === 0) {
    elements.activityFeed.innerHTML = `
      <div class="activity-empty">
        <i class="fas fa-road" style="margin-right: 8px; opacity: 0.5;"></i>
        No recent activity
      </div>
    `;
    return;
  }

  const activityHtml = trips
    .slice(0, CONFIG.activityLimit)
    .map((trip, index) => {
      const distance = trip.distance ? parseFloat(trip.distance).toFixed(1) : "?";
      const destination = formatDestination(trip.destination);
      const time = trip.endTime || trip.startTime;
      const timeAgo = time ? formatRelativeTimeShort(new Date(time)) : "";

      return `
      <div class="swipe-item" data-swipe-actions data-trip-id="${trip.transactionId || ""}">
        <div class="swipe-actions">
          <button class="swipe-action-btn secondary" data-action="share" aria-label="Share trip">
            <i class="fas fa-share-alt"></i>
          </button>
          <button class="swipe-action-btn" data-action="view" aria-label="View trips">
            <i class="fas fa-route"></i>
          </button>
        </div>
        <div class="swipe-content">
          <div class="activity-item" style="animation-delay: ${index * 0.1}s">
            <div class="activity-icon trip">
              <i class="fas fa-car"></i>
            </div>
            <div class="activity-text">
              <div class="activity-description">
                ${distance} mi to ${destination}
              </div>
              <div class="activity-time">${timeAgo}</div>
            </div>
          </div>
        </div>
      </div>
    `;
    })
    .join("");

  elements.activityFeed.innerHTML = activityHtml;
}

function bindSwipeActions() {
  if (swipeActionsBound || !elements.activityFeed) {
    return;
  }
  elements.activityFeed.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest(".swipe-action-btn");
      if (!button) {
        return;
      }
      const { action } = button.dataset;
      const item = button.closest("[data-trip-id]");
      const tripId = item?.dataset.tripId;

      if (action === "view") {
        swupReady.then((swup) => {
          swup.navigate("/trips");
        });
      } else if (action === "share" && tripId) {
        const shareData = {
          title: "Every Street Trip",
          text: "Check out this recent trip.",
          url: `${window.location.origin}/trips`,
        };
        if (navigator.share) {
          navigator.share(shareData).catch(() => {});
        } else {
          notificationManager.show("Share is not available on this device", "info");
        }
      }
    },
    pageSignal ? { signal: pageSignal } : false
  );
  swipeActionsBound = true;
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
 * Numbers That Tell Stories — contextual stat descriptions
 */
function updateStatContext(miles, trips) {
  const milesCtx = document.getElementById("stat-miles-context");
  const tripsCtx = document.getElementById("stat-trips-context");
  const setContext = (contextEl, text) => {
    if (!contextEl) {
      return;
    }
    contextEl.textContent = text;
    contextEl.closest(".story-stat")?.classList.toggle("stat-revealed", Boolean(text));
  };

  setContext(milesCtx, miles > 0 ? getMilesComparison(miles) : "");

  const milesPerTrip =
    trips > 0 && miles > 0 ? `~${(miles / Math.max(trips, 1)).toFixed(1)} mi per trip` : "";
  setContext(tripsCtx, milesPerTrip);
}

function getMilesComparison(miles) {
  // Fun geographic comparisons
  if (miles >= 238900) return `That's to the Moon!`;
  if (miles >= 24901) return `That's around the Earth!`;
  if (miles >= 5000) return `Like driving coast to coast and back`;
  if (miles >= 2800) return `Like driving coast to coast`;
  if (miles >= 1000) return `${(miles / 2800 * 100).toFixed(0)}% of a cross-country trip`;
  if (miles >= 500) return `Like ${Math.round(miles / 250)} round trips to a neighboring city`;
  if (miles >= 100) return `Keep exploring!`;
  return `Just getting started`;
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
  liveTrackingIntervalId = setInterval(() => {
    checkLiveTracking();
  }, 10000); // Every 10 seconds
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

/**
 * Load streak heatmap data and render it
 */
async function loadStreakHeatmap() {
  const requestId = ++streakHeatmapLoadRequestId;
  const container = document.getElementById("streak-heatmap-container");
  if (!container) return;

  try {
    const params = buildTripMetricsQueryParams();
    const explicitRange = getExplicitDateRange();
    const hasExplicitRange = Boolean(explicitRange.startDate || explicitRange.endDate);
    const resolvedRange = resolveDateRange({ fallbackDays: 26 * 7 });
    const requestRange = hasExplicitRange
      ? resolvedRange
      : (() => {
          const heatmapWindow = buildHeatmapWindow({ endDate: resolvedRange.endDate });
          return {
            startDate: formatLocalDateInput(heatmapWindow.startDate),
            endDate: formatLocalDateInput(heatmapWindow.endDate),
          };
        })();

    applyDateRangeToParams(params, requestRange);

    const qs = params.toString();
    const data = await apiGet(qs ? `/api/trip-analytics?${qs}` : "/api/trip-analytics");
    if (requestId !== streakHeatmapLoadRequestId || !container.isConnected) {
      return;
    }
    const dailyDistances = Array.isArray(data?.daily_distances)
      ? data.daily_distances
      : [];

    if (dailyDistances.length === 0) {
      container.innerHTML = "";
      container.className = "";
      return;
    }

    const consistency = computeConsistencyStats(dailyDistances);
    streakHeatmap.render(container, {
      dailyDistances,
      currentStreak: consistency.currentStreak,
      longestStreak: consistency.longestStreak,
      endDate: requestRange.endDate,
    });
  } catch (error) {
    if (requestId !== streakHeatmapLoadRequestId || isAbortError(error)) {
      return;
    }
    console.warn("Failed to load streak heatmap", error);
  }
}

/**
 * Bind Wrapped launcher button
 */
function bindWrappedLauncher() {
  const btn = document.getElementById("wrapped-launch-btn");
  if (!btn) return;

  const handleClick = async () => {
    btn.disabled = true;
    try {
      const params = buildTripMetricsQueryParams();
      const periodRange = resolveDateRange({
        fallbackStart: `${startOfLocalDay().getFullYear()}-01-01`,
        fallbackEnd: formatLocalDateInput(startOfLocalDay()),
      });
      applyDateRangeToParams(params, periodRange);

      const qs = params.toString();

      const [metricsData, analyticsData, insightsData] = await Promise.all([
        apiGet(qs ? `/api/metrics?${qs}` : "/api/metrics"),
        apiGet(qs ? `/api/trip-analytics?${qs}` : "/api/trip-analytics"),
        apiGet(qs ? `/api/driving-insights?${qs}` : "/api/driving-insights"),
      ]);

      const wrappedData = buildWrappedData({
        metricsData,
        insightsData,
        analyticsData,
        periodRange,
      });

      if (wrappedData.totalMiles <= 0 && wrappedData.totalTrips <= 0) {
        notificationManager.show(
          "Not enough trip data yet to build a driving story.",
          "info"
        );
        return;
      }

      wrappedExperience.launch(wrappedData);
    } catch (error) {
      if (!isAbortError(error)) {
        console.warn("Failed to launch wrapped", error);
        notificationManager.show("Failed to build your driving story.", "danger");
      }
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener(
    "click",
    handleClick,
    pageSignal ? { signal: pageSignal } : false
  );
}

/**
 * Data-responsive ambient background
 * Changes orb colors/intensity based on time of day and driving activity
 */
function setupAmbientBackground() {
  const ambientEl = document.querySelector(".ambient-background");
  if (!ambientEl) return;

  ambientCleanup?.();
  ambientCleanup = null;
  ambientEl.classList.add("data-responsive");

  const hour = new Date().getHours();
  const isNight = hour < 6 || hour >= 22;
  const isEvening = hour >= 18 && hour < 22;

  if (isNight) {
    ambientEl.classList.add("ambient-night");
    ambientEl.style.setProperty("--ambient-intensity", "0.06");
  } else if (isEvening) {
    ambientEl.style.setProperty("--ambient-intensity", "0.08");
  } else {
    ambientEl.style.setProperty("--ambient-intensity", "0.12");
  }

  // If live tracking is active, pulse warmer
  const checkLive = () => {
    if (elements.liveIndicator?.classList.contains("active")) {
      ambientEl.classList.add("ambient-driving");
    } else {
      ambientEl.classList.remove("ambient-driving");
    }
  };

  checkLive();
  const liveCheckId = setInterval(checkLive, 10000);

  ambientCleanup = () => {
    clearInterval(liveCheckId);
    ambientEl.classList.remove("data-responsive", "ambient-night", "ambient-driving");
  };
}

function cleanupLandingTransientUi() {
  wrappedExperience.close({ immediate: true });
  ambientCleanup?.();
  ambientCleanup = null;
}

export {
  cleanupLandingTransientUi,
  getExplicitDateRange,
  resolveDateRange,
  updateStatContext,
};
