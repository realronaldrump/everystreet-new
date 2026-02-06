/**
 * Landing Page Controller
 * Fetches live data and animates the landing page
 */

import apiClient from "../../core/api-client.js";
import { swupReady } from "../../core/navigation.js";
import metricAnimator from "../../ui/metric-animator.js";
import notificationManager from "../../ui/notifications.js";
import { formatNumber, formatRelativeTimeShort } from "../../utils.js";
import { animateValue } from "./animations.js";
import { bindWidgetEditToggle, updateGreeting } from "./hero.js";

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
const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;
const apiGet = (url, options = {}) => apiClient.get(url, withSignal(options));
const apiRaw = (url, options = {}) => apiClient.raw(url, withSignal(options));

/**
 * Initialize the landing page
 */
export default function initLandingPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  cacheElements();
  updateGreeting(elements);

  highlightFrequentTiles();
  bindWidgetEditToggle(elements, pageSignal);

  loadAllData();
  setupRefreshInterval();
  checkLiveTracking();
  bindSwipeActions();
  bindRecordCard();
  const teardown = () => {
    clearIntervals();
    swipeActionsBound = false;
    pageSignal = null;
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
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
      loadGasStats(),
      loadInsights(),
      loadCountyStats(),
      loadCoverageStats(),
      checkLiveTracking(),
      loadWeather(),
    ]);
  } catch (error) {
    console.warn("Failed to load landing data", error);
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
    "/settings": "settings",
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
    let latitude,
longitude;

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

async function loadCountyStats() {
  try {
    const data = await apiGet("/api/counties/visited");
    if (data?.success) {
      setRecordSource("counties", data);
    }
  } catch (error) {
    console.warn("Failed to load county stats", error);
  }
}

async function loadCoverageStats() {
  try {
    const data = await apiGet("/api/coverage/areas");
    if (data?.areas) {
      setRecordSource("coverage", data);
    }
  } catch (error) {
    console.warn("Failed to load coverage stats", error);
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
      value: formatDurationShort(records.longest_duration?.duration_seconds),
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
      value: formatDurationShort(records.max_idle?.idle_seconds),
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
      value: formatDurationShort(records.max_day_duration?.duration_seconds),
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
      value: formatCountValue(counties.totalVisited, "county"),
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
    stored
    && Number.isInteger(stored.index)
    && stored.index >= 0
    && stored.index < entryCount
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

function formatDurationShort(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const totalMinutes = Math.max(1, Math.round(numeric / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    const minuteLabel = minutes > 0 ? ` ${String(minutes).padStart(2, "0")}m` : "";
    return `${hours}h${minuteLabel}`;
  }
  return `${minutes}m`;
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

/**
 * Fetch trip metrics and update stats
 */
async function loadMetrics() {
  try {
    const data = await apiGet("/api/metrics");

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
  } catch {
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
        lastTrip.destinationGeoPoint?.coordinates
        && lastTrip.destinationGeoPoint.coordinates.length >= 2
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
    const data = await apiGet("/api/driving-insights");
    setRecordSource("insights", data);
  } catch (error) {
    console.warn("Failed to load driving insights", error);
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
    console.warn("Failed to load gas stats", error);
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
        swupReady
          .then((swup) => {
            swup.navigate("/trips");
          })
          .catch(() => {
            window.location.href = "/trips";
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
