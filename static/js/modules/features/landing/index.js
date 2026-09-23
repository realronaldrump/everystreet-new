/**
 * Home page controller.
 *
 * Loads the page's data and hands each part to the module that draws it:
 * coverage.js (title line, hero plate, survey scales), records.js (the
 * record cell), logbook.js (recent trips and the ledger heading),
 * weather.js (the weather note), and car.js (the Murano on the plate).
 */

import { CONFIG as APP_CONFIG } from "../../core/config.js";
import { createFeatureApi } from "../../core/feature-api.js";
import store from "../../core/store.js";
import metricAnimator from "../../ui/metric-animator.js";
import {
  DateUtils,
  formatNumber,
  formatRelativeTimeShort,
  getStorage,
  isAbortError,
} from "../../utils.js";
import {
  disableBouncieLiveTracking,
  isBouncieLiveTrackingEnabled,
} from "../tracking/availability.js";
import { animateValue } from "./animations.js";
import initHeroCar from "./car.js";
import {
  renderAreaCount,
  renderCoverageRegister,
  renderRecentArea,
} from "./coverage.js";
import { updateMastheadDate } from "./hero.js";
import {
  formatWheelTime,
  renderLogbook,
  updateLogHeading,
  watchDateRangeLabel,
} from "./logbook.js";
import { createRecordCard } from "./records.js";
import { loadWeather } from "./weather.js";

const REFRESH_MS = 60 * 1000;
const LIVE_CHECK_MS = 10 * 1000;
const ANIMATION_MS = 500;
const RECENT_TRIPS_LIMIT = "60";

/** Index rows, keyed by the routes they open, for the "used most" pencil tick. */
const TILE_BY_PATH = {
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

const ELEMENT_IDS = {
  mastheadDate: "manual-date",
  areaLine: "home-area",
  heroSignName: "hero-sign-name",
  heroSignMiles: "hero-sign-miles",
  heroMapTitle: "hero-map-title",
  coverageSection: "home-coverage",
  coverageRegister: "coverage-register",
  weatherChip: "weather-chip",
  logHeading: "log-heading",
  statMiles: "stat-miles",
  statTrips: "stat-trips",
  statTime: "stat-time",
  statTimeUnit: "stat-time-unit",
  liveIndicator: "live-indicator",
  recentTrip: "recent-trip",
  lastFillup: "last-fillup",
  indexAreas: "index-areas",
  activityFeed: "activity-feed",
  logbookFoot: "logbook-foot",
  logbookTotal: "logbook-total",
  logbookTotalLabel: "logbook-total-label",
  recordCard: "record-card",
  recordCount: "record-count",
  recordValue: "record-value",
  recordTitle: "record-title",
  recordDate: "record-date",
};

/**
 * Initialize the home page.
 * @returns {Function} teardown
 */
export default function initLandingPage({ signal, cleanup, api } = {}) {
  const pageSignal = signal || null;
  const featureApi = api || createFeatureApi({ signal: pageSignal });
  const els = Object.fromEntries(
    Object.entries(ELEMENT_IDS).map(([key, id]) => [key, document.getElementById(id)])
  );
  els.navTiles = Array.from(document.querySelectorAll(".nav-tile"));

  const isPageAbort = (error) => isAbortError(error) || pageSignal?.aborted === true;
  const isStale = () => pageSignal?.aborted === true;
  const intervals = [];
  const requestIds = { metrics: 0, records: 0, trips: 0 };
  let lastKnownLocation = null;
  let liveTimer = null;

  const heroCar = initHeroCar({ signal: pageSignal });
  const records = createRecordCard(
    {
      card: els.recordCard,
      count: els.recordCount,
      value: els.recordValue,
      title: els.recordTitle,
      date: els.recordDate,
    },
    {
      signal: pageSignal,
      loadingText: () =>
        DateUtils.getStartDate() || DateUtils.getEndDate()
          ? "Checking selected range"
          : "Checking all time",
    }
  );

  function tripQuery() {
    const params = new URLSearchParams();
    const start = DateUtils.getStartDate();
    const end = DateUtils.getEndDate();
    if (start) {
      params.set("start_date", start);
    }
    if (end) {
      params.set("end_date", end);
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

  const withQuery = (path, params = tripQuery()) => {
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };

  function markFrequentTiles() {
    const counts = getStorage("es:route-counts") || {};
    const frequent = new Set(
      Object.entries(counts)
        .filter(([path]) => path !== "/" && path !== "/landing")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([path]) => TILE_BY_PATH[path])
        .filter(Boolean)
    );
    els.navTiles.forEach((tile) => {
      tile.classList.toggle("tile-frequent", frequent.has(tile.dataset.tile));
    });
  }

  function setMetricsLoading(isLoading) {
    [els.statMiles, els.statTrips, els.statTime].forEach((el) => {
      const figure = el?.closest?.(".snapshot-figure");
      figure?.classList.toggle("is-loading", Boolean(isLoading));
      figure?.setAttribute("aria-busy", isLoading ? "true" : "false");
    });
  }

  async function loadMetrics({ showLoading = false } = {}) {
    const requestId = ++requestIds.metrics;
    const current = () => requestId === requestIds.metrics && !isStale();
    if (showLoading) {
      setMetricsLoading(true);
    }
    try {
      const data = await featureApi.get(withQuery("/api/metrics"));
      if (!current()) {
        return;
      }
      const miles = parseFloat(data.total_distance) || 0;
      const trips = parseInt(data.total_trips, 10) || 0;
      const decimals = miles > 0 && miles < 10 ? 1 : 0;
      if (metricAnimator?.animate) {
        metricAnimator.animate(els.statMiles, miles, { decimals });
        metricAnimator.animate(els.statTrips, trips, { decimals: 0 });
      } else {
        animateValue(
          els.statMiles,
          miles,
          (v) => formatNumber(v, decimals),
          ANIMATION_MS
        );
        animateValue(els.statTrips, trips, formatNumber, ANIMATION_MS);
      }
      const wheelTime = formatWheelTime(data.total_duration_seconds);
      if (els.statTime) {
        els.statTime.textContent = wheelTime.value;
      }
      if (els.statTimeUnit) {
        els.statTimeUnit.textContent = wheelTime.unit;
      }
    } catch (error) {
      if (!current() || isPageAbort(error)) {
        return;
      }
      [els.statMiles, els.statTrips, els.statTime].forEach((el) => {
        if (el) {
          el.textContent = "--";
        }
      });
    } finally {
      if (current()) {
        setMetricsLoading(false);
      }
    }
  }

  function showRecentTrip(lastTrip) {
    if (!els.recentTrip) {
      return;
    }
    const when = lastTrip?.endTime || lastTrip?.startTime;
    const value = els.recentTrip.querySelector(".meta-value");
    if (value) {
      value.textContent = when ? formatRelativeTimeShort(new Date(when)) : "--";
    }
    els.recentTrip.hidden = !when;
  }

  async function loadRecentTrips() {
    const requestId = ++requestIds.trips;
    const current = () => requestId === requestIds.trips && !isStale();
    try {
      const params = tripQuery();
      params.set("limit", RECENT_TRIPS_LIMIT);
      const data = await featureApi.get(`/api/trips/history?${params}`);
      if (!current()) {
        return;
      }
      const trips = data.trips || data || [];
      const [lon, lat] = trips[0]?.destinationGeoPoint?.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        lastKnownLocation = { latitude: lat, longitude: lon };
      }
      showRecentTrip(trips[0]);
      renderLogbook(els, trips);
    } catch (error) {
      if (!current() || isPageAbort(error)) {
        return;
      }
      showRecentTrip(null);
      renderLogbook(els, []);
    }
  }

  async function loadRecords({ showLoading = false } = {}) {
    const requestId = ++requestIds.records;
    if (showLoading) {
      records.setLoading(true);
      records.update({ insights: null, gas: null });
    }
    const insightsParams = tripQuery();
    insightsParams.set("include_movement", "false");
    const [insights, gas] = await Promise.allSettled([
      featureApi.get(`/api/driving-insights?${insightsParams}`),
      featureApi.get(withQuery("/api/gas-statistics")),
    ]);
    if (requestId !== requestIds.records || isStale()) {
      return;
    }
    for (const [label, result] of [
      ["driving insights", insights],
      ["gas stats", gas],
    ]) {
      if (result.status === "rejected" && !isPageAbort(result.reason)) {
        console.warn(`Failed to load ${label}`, result.reason);
      }
    }
    const gasStats = gas.status === "fulfilled" ? gas.value : null;
    const fillup = els.lastFillup?.querySelector(".meta-value");
    if (gasStats && fillup) {
      fillup.textContent = gasStats.average_mpg
        ? gasStats.average_mpg.toFixed(1)
        : "--";
    }
    records.update({
      insights: insights.status === "fulfilled" ? insights.value : null,
      gas: gasStats,
    });
    records.setLoading(false);
  }

  async function loadCountyStats() {
    try {
      const data = await featureApi.get("/api/geo-coverage/summary");
      if (data?.success) {
        records.update({
          counties: {
            success: true,
            totalVisited: data?.levels?.county?.visited || 0,
            lastUpdated: data?.lastUpdated || null,
          },
        });
      }
    } catch (error) {
      if (!isPageAbort(error)) {
        console.warn("Failed to load county stats", error);
      }
    }
  }

  async function loadCoverage() {
    try {
      const data = await featureApi.get("/api/coverage/areas");
      if (data?.areas) {
        records.update({ coverage: data });
        renderCoverageRegister(els, data.areas);
        renderRecentArea(els, data.areas);
        renderAreaCount(els.indexAreas, data.areas);
      }
    } catch (error) {
      if (!isPageAbort(error)) {
        console.warn("Failed to load coverage stats", error);
      }
    }
  }

  function hideLiveChip() {
    if (els.liveIndicator) {
      (els.liveIndicator.closest(".status-chip") || els.liveIndicator).hidden = true;
    }
  }

  async function checkLiveTracking() {
    if (!isBouncieLiveTrackingEnabled()) {
      return;
    }
    try {
      const data = await featureApi.get("/api/active_trip");
      if (data.enabled === false) {
        heroCar?.setLive(false);
        disableBouncieLiveTracking();
        clearInterval(liveTimer);
        liveTimer = null;
        hideLiveChip();
        return;
      }
      const onTheRoad = data.trip?.status === "active";
      heroCar?.setLive(onTheRoad);
      els.liveIndicator?.classList.toggle("active", onTheRoad);
      if (els.liveIndicator) {
        els.liveIndicator.title = onTheRoad
          ? "Live tracking active"
          : "No active tracking";
      }
    } catch {
      els.liveIndicator?.classList.remove("active");
    }
  }

  async function loadAll() {
    try {
      updateMastheadDate(els);
      updateLogHeading(els.logHeading);
      markFrequentTiles();
      // Trips first: the newest one gives the weather its location.
      await loadRecentTrips();
      await Promise.all([
        loadMetrics(),
        loadRecords(),
        loadCountyStats(),
        loadCoverage(),
        checkLiveTracking(),
        loadWeather(els.weatherChip, {
          location: lastKnownLocation,
          fetchRaw: (url, options) => featureApi.raw(url, options),
        }),
      ]);
    } catch (error) {
      if (!isPageAbort(error)) {
        console.warn("Failed to load landing data", error);
      }
    }
  }

  function refreshForFilters() {
    loadMetrics({ showLoading: true });
    loadRecords({ showLoading: true });
    loadRecentTrips();
  }

  updateMastheadDate(els);
  loadAll();
  intervals.push(setInterval(loadAll, REFRESH_MS));
  if (isBouncieLiveTrackingEnabled()) {
    liveTimer = setInterval(checkLiveTracking, LIVE_CHECK_MS);
  }

  document.addEventListener(
    "filtersApplied",
    refreshForFilters,
    pageSignal ? { signal: pageSignal } : false
  );
  const stopWatchingRange = watchDateRangeLabel(els.logHeading);

  const teardown = () => {
    intervals.forEach(clearInterval);
    clearInterval(liveTimer);
    records.stop();
    heroCar?.destroy();
    stopWatchingRange();
    if (!pageSignal) {
      document.removeEventListener("filtersApplied", refreshForFilters);
    }
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }
  return teardown;
}
