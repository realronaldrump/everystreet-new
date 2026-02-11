/* global bootstrap, Chart */
/**
 * Routes Page – Recurring Route Templates
 * Browse, filter, build, and explore route analytics with rich visualisations.
 */

import apiClient from "../../core/api-client.js";
import { createMap } from "../../map-base.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml, formatDuration, sanitizeLocation } from "../../utils.js";

/* ───── constants ───── */
const DEFAULT_LIST_LIMIT = 200;
const MODAL_SOURCE_ID = "route-modal-geojson";
const MODAL_LINE_LAYER_ID = "route-modal-line";
const MODAL_START_LAYER_ID = "route-modal-start";
const MODAL_END_LAYER_ID = "route-modal-end";
const MODAL_TRIPS_SOURCE_ID = "route-modal-trips";
const MODAL_TRIPS_LAYER_ID = "route-modal-trips-layer";

/* ───── module-level state ───── */
let pageSignal = null;
const listState = { q: "", minTrips: 3, includeHidden: false, imei: "", sort: "trips" };
let vehicles = [];
let allRoutes = [];
let buildPollTimer = null;
let activeBuildJobId = null;
let routeModalInstance = null;
let routeModalMap = null;
let routeModalRouteId = null;
let routeModalRoute = null;
let routeModalAnalyticsData = null;
let routeModalOpenToken = 0;
let showAllTrips = false;
let placesCatalog = [];
let placesLoaded = false;
let explorerRequestId = 0;

// Chart instances (destroyed on each modal open)
let chartMonthly = null;
let chartHour = null;
let chartDow = null;
let chartDistTrend = null;
let explorerChartVariantShare = null;
let explorerChartMonthly = null;
let explorerChartHour = null;
let explorerChartDay = null;

/* ───── helpers ───── */
const withSignal = (o = {}) => (pageSignal ? { ...o, signal: pageSignal } : o);
const apiGet = (u, o = {}) => apiClient.get(u, withSignal(o));
const apiPost = (u, b, o = {}) => apiClient.post(u, b, withSignal(o));
const apiPatch = (u, b, o = {}) => apiClient.patch(u, b, withSignal(o));
const getEl = (id) => document.getElementById(id);

function formatMiles(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)} mi` : "--";
}

function formatDateShort(v) {
  if (!v) return "--";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "--"
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function formatMonthLabel(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[Number(m) - 1] || m} '${y.slice(2)}`;
}

function formatHourLabel(h) {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function formatPercent(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "--";
}

function routeStrokeColor(route) {
  const raw = (route?.color || "").trim();
  return raw.startsWith("#") && raw.length === 7 ? raw : "#3b8a7f";
}

/* ───── insight computations ───── */
function computeTripsPerWeek(route) {
  const first = route?.first_start_time ? new Date(route.first_start_time) : null;
  const last = route?.last_start_time ? new Date(route.last_start_time) : null;
  if (!first || !last || Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()))
    return 0;
  const daySpan = Math.max(7, (last - first) / 86400000);
  return (route.trip_count || 0) / (daySpan / 7);
}

function getDistanceCategory(medianMiles) {
  const n = Number(medianMiles);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 3) return "short hop";
  if (n < 15) return "regular drive";
  if (n < 50) return "long commute";
  return "road trip";
}

function getRoutePersonality(route) {
  const tpw = computeTripsPerWeek(route);
  const daysSinceLast = route?.last_start_time
    ? (Date.now() - new Date(route.last_start_time).getTime()) / 86400000
    : null;
  const dist = Number(route?.distance_miles_median || route?.distance_miles_avg || 0);

  if (daysSinceLast !== null && daysSinceLast > 90) return "Inactive route";
  if (tpw >= 4 && dist < 20) return "Daily commute";
  if (tpw >= 4) return "Frequent regular";
  if (tpw >= 1.5) return "Regular route";
  if (tpw >= 0.5) return "Weekly trip";
  if (tpw > 0) return "Occasional trip";
  return "Route";
}

function getCardInsightSentence(route) {
  const tpw = computeTripsPerWeek(route);
  const distCat = getDistanceCategory(route?.distance_miles_median);
  const freqLabel =
    tpw >= 4
      ? "Frequent"
      : tpw >= 1.5
        ? "Regular"
        : tpw >= 0.5
          ? "Weekly"
          : "Occasional";
  return distCat ? `${freqLabel} ${distCat}` : freqLabel;
}

function computeHeroInsights(routes) {
  if (!routes || routes.length === 0) return { dna: "", spotlight: "" };

  const totalTrips = routes.reduce((s, r) => s + (r.trip_count || 0), 0);
  const totalMiles = routes.reduce(
    (s, r) =>
      s + (r.distance_miles_avg || r.distance_miles_median || 0) * (r.trip_count || 0),
    0
  );
  const totalHours = routes.reduce(
    (s, r) =>
      s +
      ((r.duration_sec_avg || r.duration_sec_median || 0) * (r.trip_count || 0)) / 3600,
    0
  );

  const milesStr =
    totalMiles >= 1000
      ? `${(totalMiles / 1000).toFixed(1)}k`
      : Math.round(totalMiles).toLocaleString();
  const hoursStr =
    totalHours >= 100
      ? `${Math.round(totalHours).toLocaleString()}`
      : totalHours.toFixed(0);
  const dna = `${routes.length} recurring routes across ${totalTrips.toLocaleString()} trips covering ${milesStr} miles and ${hoursStr} hours on the road.`;

  const sorted = [...routes].sort((a, b) => (b.trip_count || 0) - (a.trip_count || 0));
  const top = sorted[0];
  const topName =
    top?.display_name ||
    top?.name ||
    top?.auto_name ||
    `${top?.start_label || "?"} to ${top?.end_label || "?"}`;
  const spotlight = top ? `Most driven: ${topName} with ${top.trip_count} trips.` : "";

  return { dna, spotlight };
}

function computeConsistencyScore(analyticsData) {
  const timeline = analyticsData?.timeline;
  if (!Array.isArray(timeline) || timeline.length < 3) return null;
  const distances = timeline.map((t) => Number(t?.distance)).filter(Number.isFinite);
  if (distances.length < 3) return null;
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
  if (mean <= 0) return null;
  const variance =
    distances.reduce((s, d) => s + (d - mean) ** 2, 0) / distances.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv < 0.05)
    return { score: Math.round(95 + Math.random() * 5), label: "Like clockwork" };
  if (cv < 0.15)
    return {
      score: Math.round(80 + ((0.15 - cv) / 0.1) * 14),
      label: "Very consistent",
    };
  if (cv < 0.3)
    return {
      score: Math.round(60 + ((0.3 - cv) / 0.15) * 19),
      label: "Mostly consistent",
    };
  return { score: Math.max(20, Math.round(60 - cv * 50)), label: "Variable" };
}

function computePeakDeparture(analyticsData) {
  const byHour = analyticsData?.byHour;
  if (!Array.isArray(byHour) || byHour.length === 0) return null;
  const peak = byHour.reduce(
    (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
    byHour[0]
  );
  if (!peak || (peak.count || 0) === 0) return null;
  const h = peak.hour;
  const nextH = (h + 1) % 24;
  return {
    hour: h,
    label: `${formatHourLabel(h)}\u2013${formatHourLabel(nextH)}`,
    count: peak.count,
  };
}

function computeDayPattern(analyticsData) {
  const byDay = analyticsData?.byDayOfWeek;
  if (!Array.isArray(byDay) || byDay.length === 0) return null;
  const total = byDay.reduce((s, d) => s + (d?.count || 0), 0);
  if (total === 0) return null;
  const weekday = byDay
    .filter((d) => {
      const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(d.dayName);
      return idx >= 1 && idx <= 5;
    })
    .reduce((s, d) => s + (d?.count || 0), 0);
  const weekdayShare = weekday / total;
  if (weekdayShare > 0.8) return "Weekday regular";
  if (weekdayShare < 0.5) return "Weekend warrior";
  const counts = byDay.map((d) => d?.count || 0);
  const maxDay = Math.max(...counts);
  const minDay = Math.min(...counts.filter((c) => c > 0));
  if (minDay > 0 && maxDay / minDay < 2.5) return "Everyday route";
  return "Mixed schedule";
}

function generateModalInsightSentence(route, analyticsData) {
  const parts = [];
  const dayPattern = computeDayPattern(analyticsData);
  if (dayPattern) parts.push(dayPattern);
  const peak = computePeakDeparture(analyticsData);
  if (peak) parts.push(`usually departs ${peak.label}`);
  const consistency = computeConsistencyScore(analyticsData);
  if (consistency) parts.push(`${consistency.label.toLowerCase()} distance`);
  if (parts.length === 0) {
    const personality = getRoutePersonality(route);
    return personality !== "Route" ? personality : "Recurring route pattern";
  }
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function normalizePlaceLabel(label) {
  return String(label || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildVisitsLink({ placeId, label }) {
  const cleanedId = String(placeId || "").trim();
  if (cleanedId) {
    return `/visits?place=${encodeURIComponent(cleanedId)}`;
  }
  const normalizedLabel = normalizePlaceLabel(label);
  if (normalizedLabel) {
    return `/visits?place_name=${encodeURIComponent(normalizedLabel)}`;
  }
  return "/visits";
}

function getPreloadRouteIdFromUrl(href = window.location.href) {
  try {
    const url = new URL(href, window.location.origin);
    const match = (url.pathname || "").match(/^\/routes\/([^/]+)$/);
    return match ? match[1] : url.searchParams.get("route_id");
  } catch {
    return null;
  }
}

/* ───── Chart.js defaults ───── */
function getChartDefaults() {
  const textColor = "rgba(255,255,255,0.6)";
  const gridColor = "rgba(255,255,255,0.07)";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(15,20,30,0.92)",
        titleColor: "#fff",
        bodyColor: "rgba(255,255,255,0.8)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
      },
    },
    scales: {
      x: {
        ticks: { color: textColor, font: { size: 10 } },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        ticks: { color: textColor, font: { size: 10 } },
        grid: { color: gridColor },
        border: { display: false },
        beginAtZero: true,
      },
    },
  };
}

function destroyChartRef(chartRef) {
  try {
    chartRef?.destroy();
  } catch {
    /* ok */
  }
  return null;
}

function destroyCanvasChart(canvas) {
  if (!canvas || typeof Chart === "undefined" || typeof Chart.getChart !== "function") {
    return;
  }
  try {
    Chart.getChart(canvas)?.destroy();
  } catch {
    /* ok */
  }
}

function setChartEmptyState(canvasId, emptyId, hasData, emptyText) {
  const canvas = getEl(canvasId);
  const empty = getEl(emptyId);
  if (canvas) canvas.classList.toggle("d-none", !hasData);
  if (empty) {
    if (emptyText) empty.textContent = emptyText;
    empty.classList.toggle("d-none", hasData);
  }
}

function destroyCharts() {
  chartMonthly = destroyChartRef(chartMonthly);
  chartHour = destroyChartRef(chartHour);
  chartDow = destroyChartRef(chartDow);
  chartDistTrend = destroyChartRef(chartDistTrend);
  [
    "route-chart-monthly",
    "route-chart-hour",
    "route-chart-dow",
    "route-chart-distance-trend",
  ].forEach((id) => destroyCanvasChart(getEl(id)));
}

function destroyExplorerCharts() {
  explorerChartVariantShare = destroyChartRef(explorerChartVariantShare);
  explorerChartMonthly = destroyChartRef(explorerChartMonthly);
  explorerChartHour = destroyChartRef(explorerChartHour);
  explorerChartDay = destroyChartRef(explorerChartDay);
  [
    "routes-explorer-variant-share-chart",
    "routes-explorer-chart-monthly",
    "routes-explorer-chart-hour",
    "routes-explorer-chart-day",
  ].forEach((id) => destroyCanvasChart(getEl(id)));
}

/* ───── loading / empty states ───── */
function setLoading(on) {
  const loading = getEl("routes-loading");
  const grid = getEl("routes-grid");
  const empty = getEl("routes-empty");
  if (loading) loading.classList.toggle("d-none", !on);
  if (empty) empty.classList.add("d-none");
  if (grid)
    on ? grid.setAttribute("aria-busy", "true") : grid.removeAttribute("aria-busy");
}

function showEmpty(show) {
  const el = getEl("routes-empty");
  if (el) el.classList.toggle("d-none", !show);
}

/* ───── hero stats ───── */
function updateHeroStats(routes) {
  const routeCount = routes.length;
  const totalTrips = routes.reduce((s, r) => s + (r.trip_count || 0), 0);
  const totalMiles = routes.reduce(
    (s, r) =>
      s + (r.distance_miles_avg || r.distance_miles_median || 0) * (r.trip_count || 0),
    0
  );
  const mostFrequent =
    routes.length > 0
      ? routes.reduce((a, b) => ((b.trip_count || 0) > (a.trip_count || 0) ? b : a))
      : null;

  const setVal = (id, v) => {
    const el = getEl(id);
    if (el) el.textContent = v;
  };
  setVal("hero-stat-routes", routeCount.toLocaleString());
  setVal("hero-stat-trips", totalTrips.toLocaleString());
  setVal(
    "hero-stat-miles",
    totalMiles >= 1000
      ? `${(totalMiles / 1000).toFixed(1)}k`
      : Math.round(totalMiles).toLocaleString()
  );
  setVal("hero-stat-freq", mostFrequent ? `${mostFrequent.trip_count} trips` : "--");

  const insights = computeHeroInsights(routes);
  setVal("hero-insight-dna", insights.dna || "No routes yet.");
  setVal(
    "hero-insight-spotlight",
    insights.spotlight || "Build routes to see insights."
  );
}

function updateResultsHeader(total) {
  const countEl = getEl("routes-results-count");
  const hintEl = getEl("routes-results-hint");
  if (countEl) countEl.textContent = String(total || 0);
  if (hintEl) {
    const minTrips = Number(listState.minTrips) || 3;
    const vehicle = listState.imei
      ? vehicles.find((v) => v.imei === listState.imei)
      : null;
    const vehicleLabel = vehicle
      ? sanitizeLocation(
          vehicle.custom_name || vehicle.label || vehicle.vin || vehicle.imei
        )
      : null;
    const txt =
      minTrips >= 3
        ? "recurring routes"
        : `routes with ${minTrips}+ trip${minTrips === 1 ? "" : "s"}`;
    hintEl.textContent = vehicleLabel
      ? `Showing ${txt} for ${vehicleLabel}`
      : `Showing ${txt}`;
  }
}

/* ───── route cards ───── */
function createRouteCard(route) {
  const card = document.createElement("div");
  card.className = "route-card";
  card.dataset.routeId = route.id;
  const strokeColor = routeStrokeColor(route);
  card.style.setProperty("--route-stroke", strokeColor);

  const start = escapeHtml(route.start_label || "Unknown");
  const end = escapeHtml(route.end_label || "Unknown");
  const previewPath = route.preview_svg_path || "M 5,35 Q 25,5 50,20 T 95,15";
  const medianDist = formatMiles(route.distance_miles_median);
  const medianDur = route.duration_sec_median
    ? formatDuration(route.duration_sec_median)
    : "--";

  // Freshness indicator
  const daysSinceLast = route.last_start_time
    ? Math.floor((Date.now() - new Date(route.last_start_time).getTime()) / 86400000)
    : null;
  let freshnessClass = "stale";
  let freshnessLabel = "Inactive";
  if (daysSinceLast !== null) {
    if (daysSinceLast <= 7) {
      freshnessClass = "fresh";
      freshnessLabel = "This week";
    } else if (daysSinceLast <= 30) {
      freshnessClass = "recent";
      freshnessLabel = "This month";
    } else if (daysSinceLast <= 90) {
      freshnessClass = "aging";
      freshnessLabel = `${Math.round(daysSinceLast / 7)}w ago`;
    } else {
      freshnessLabel = formatDateShort(route.last_start_time);
    }
  }

  const pills = [];
  if (route.is_pinned)
    pills.push(
      '<span class="route-pill pinned"><i class="fas fa-thumbtack"></i></span>'
    );
  if (route.is_hidden)
    pills.push(
      '<span class="route-pill hidden-pill"><i class="fas fa-eye-slash"></i></span>'
    );

  const personality = getRoutePersonality(route);
  const insightSentence = getCardInsightSentence(route);

  card.innerHTML = `
    <div class="route-card-top">
      <span class="route-personality-tag">${escapeHtml(personality)}</span>
      <div class="route-card-indicators">
        ${pills.join("")}
        <span class="route-freshness-dot ${freshnessClass}" title="${escapeHtml(freshnessLabel)}"></span>
      </div>
    </div>
    <div class="route-card-labels">
      <span class="route-label-start">${start}</span>
      <span class="route-label-arrow"><i class="fas fa-long-arrow-alt-right" aria-hidden="true"></i></span>
      <span class="route-label-end">${end}</span>
    </div>
    <div class="route-card-visual">
      <svg class="route-preview-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
        <path d="${escapeHtml(previewPath)}"></path>
      </svg>
    </div>
    <div class="route-card-insight">${escapeHtml(insightSentence)}</div>
    <div class="route-card-stats">
      <span>${route.trip_count || 0} trips</span>
      <span class="stat-sep">&middot;</span>
      <span>${escapeHtml(medianDist)}</span>
      <span class="stat-sep">&middot;</span>
      <span>${escapeHtml(medianDur)}</span>
    </div>
  `;

  card.addEventListener("click", () => openRouteModal(route.id));
  return card;
}

function renderRoutes(routes) {
  const grid = getEl("routes-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!routes || routes.length === 0) {
    showEmpty(true);
    return;
  }
  showEmpty(false);
  routes.forEach((r) => grid.appendChild(createRouteCard(r)));
}

/* ───── places loading ───── */
async function loadPlacesCatalog({ force = false } = {}) {
  if (placesLoaded && !force) return placesCatalog;
  try {
    const places = await apiGet("/api/places", { cache: true });
    placesCatalog = Array.isArray(places) ? places : [];
    placesLoaded = true;
  } catch {
    placesCatalog = [];
    placesLoaded = false;
  }
  return placesCatalog;
}

/* ───── vehicle loading ───── */
async function loadVehicles() {
  const select = getEl("routes-vehicle");
  if (!select) return;
  try {
    const list = await apiGet("/api/vehicles?active_only=true");
    vehicles = Array.isArray(list) ? list : [];
    select.innerHTML = '<option value="">All vehicles</option>';
    vehicles.forEach((v) => {
      const o = document.createElement("option");
      o.value = v.imei;
      o.textContent =
        v.custom_name || v.name || v.label || v.vin || v.imei || "Vehicle";
      select.appendChild(o);
    });
  } catch {
    /* vehicles optional */
  }
}

/* ───── list loading ───── */
function buildListUrl() {
  const p = new URLSearchParams();
  if (listState.q) p.set("q", listState.q);
  p.set("min_trips", String(listState.minTrips || 3));
  if (listState.includeHidden) p.set("include_hidden", "true");
  if (listState.imei) p.set("imei", listState.imei);
  p.set("limit", String(DEFAULT_LIST_LIMIT));
  p.set("offset", "0");
  return `/api/recurring_routes?${p.toString()}`;
}

async function loadRoutes() {
  setLoading(true);
  try {
    const data = await apiGet(buildListUrl(), { cache: false });
    const routes = Array.isArray(data?.routes) ? data.routes : [];
    allRoutes = routes;
    updateResultsHeader(data?.total ?? routes.length);
    updateHeroStats(routes);
    renderRoutes(routes);

    const lastBuiltEl = getEl("routes-last-built");
    if (lastBuiltEl && routes.length > 0) {
      const max = routes
        .map((r) => r.updated_at)
        .filter(Boolean)
        .map((v) => new Date(v))
        .filter((d) => !Number.isNaN(d.getTime()))
        .sort((a, b) => b - a)[0];
      lastBuiltEl.textContent = max
        ? `Last built: ${max.toLocaleString()}`
        : "Built (timestamp unavailable)";
    }
  } catch (e) {
    notificationManager.show?.(`Failed to load routes: ${e?.message || e}`, "danger");
    renderRoutes([]);
  } finally {
    setLoading(false);
  }
}

/* ───── build lifecycle ───── */
function setBuildUi(state) {
  const dot = getEl("routes-build-dot");
  const text = getEl("routes-build-text");
  const progressWrap = getEl("routes-build-progress-wrap");
  const progressBar = getEl("routes-build-progress-bar");
  const stageEl = getEl("routes-build-stage");
  const pctEl = getEl("routes-build-progress");
  const cancelBtn = getEl("routes-cancel-btn");
  if (dot) dot.dataset.state = state?.dotState || "idle";
  if (text) text.textContent = state?.text || "Ready to build";
  if (progressWrap) progressWrap.classList.toggle("d-none", !state?.showProgress);
  if (progressBar)
    progressBar.style.width = `${Math.max(0, Math.min(100, Number(state?.progress || 0)))}%`;
  if (stageEl) stageEl.textContent = state?.stage || "Queued";
  if (pctEl) pctEl.textContent = `${Math.round(Number(state?.progress || 0))}%`;
  if (cancelBtn) cancelBtn.classList.toggle("d-none", !state?.showCancel);
}

function stopBuildPolling() {
  if (buildPollTimer) {
    clearTimeout(buildPollTimer);
    buildPollTimer = null;
  }
  activeBuildJobId = null;
}

async function pollBuildJob(jobId) {
  if (!jobId) return;
  activeBuildJobId = jobId;
  if (buildPollTimer) {
    clearTimeout(buildPollTimer);
    buildPollTimer = null;
  }

  const tick = async () => {
    if (activeBuildJobId !== jobId || pageSignal?.aborted) {
      stopBuildPolling();
      return;
    }
    try {
      const s = await apiGet(
        `/api/recurring_routes/jobs/${encodeURIComponent(jobId)}`,
        { cache: false }
      );
      const stage = s?.stage || "unknown";
      const pct = Number(s?.progress || 0);
      const terminal = ["completed", "failed", "cancelled", "error"];
      const key = String(s?.status || stage).toLowerCase();
      const done =
        terminal.includes(key) || terminal.includes(String(stage).toLowerCase());
      setBuildUi({
        dotState: done
          ? key === "completed"
            ? "success"
            : key === "cancelled"
              ? "idle"
              : "error"
          : "running",
        text: s?.message || "Building...",
        showProgress: !done,
        showCancel: !done,
        stage,
        progress: pct,
      });
      if (done) {
        stopBuildPolling();
        if (key === "completed") {
          setBuildUi({
            dotState: "success",
            text: "Build complete",
            showProgress: false,
            showCancel: false,
            stage,
            progress: 100,
          });
          await loadRoutes();
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        stopBuildPolling();
        return;
      }
    }
    if (activeBuildJobId === jobId && !pageSignal?.aborted)
      buildPollTimer = setTimeout(tick, 2000);
  };
  await tick();
}

async function startBuild() {
  try {
    setBuildUi({
      dotState: "running",
      text: "Queueing build...",
      showProgress: true,
      showCancel: true,
      stage: "queued",
      progress: 0,
    });
    const resp = await apiPost("/api/recurring_routes/jobs/build", {});
    const jobId = resp?.job_id;
    if (!jobId) throw new Error("Build job did not return a job_id");
    await pollBuildJob(jobId);
  } catch (e) {
    setBuildUi({
      dotState: "error",
      text: `Failed: ${e?.message || e}`,
      showProgress: false,
      showCancel: false,
      stage: "error",
      progress: 0,
    });
    notificationManager.show?.(`Failed to start build: ${e?.message || e}`, "danger");
  }
}

async function cancelBuild() {
  const jobId = activeBuildJobId;
  if (!jobId) return;
  try {
    await apiPost(`/api/recurring_routes/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  } catch (e) {
    notificationManager.show?.(`Failed to cancel: ${e?.message || e}`, "warning");
  }
}

/* ───── map helpers ───── */
function bboxForGeometry(geometry) {
  if (!geometry) return null;
  const pts = [];
  const { type, coordinates: coords } = geometry;
  if (type === "LineString" && Array.isArray(coords))
    coords.forEach((c) => pts.push(c));
  else if (type === "MultiLineString" && Array.isArray(coords))
    coords.forEach((l) => {
      if (Array.isArray(l)) l.forEach((c) => pts.push(c));
    });
  else return null;
  const valid = pts
    .filter((c) => Array.isArray(c) && c.length >= 2)
    .map((c) => [Number(c[0]), Number(c[1])])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (valid.length < 2) return null;
  const lons = valid.map((p) => p[0]);
  const lats = valid.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function ensureRouteModal() {
  const el = getEl("routeDetailsModal");
  if (!el || typeof bootstrap === "undefined") return null;
  if (!routeModalInstance) {
    routeModalInstance = bootstrap.Modal.getOrCreateInstance(el);
    el.addEventListener("hidden.bs.modal", () => {
      routeModalRouteId = null;
      routeModalRoute = null;
      routeModalAnalyticsData = null;
      showAllTrips = false;
      const allTripsBtn = getEl("route-modal-show-all-trips");
      if (allTripsBtn) {
        allTripsBtn.classList.remove("active");
        allTripsBtn.disabled = false;
        allTripsBtn.innerHTML =
          '<i class="fas fa-layer-group me-2" aria-hidden="true"></i>Show all trips';
      }
      if (routeModalMap) {
        const tripsSource = routeModalMap.getSource(MODAL_TRIPS_SOURCE_ID);
        if (tripsSource) {
          tripsSource.setData({ type: "FeatureCollection", features: [] });
        }
        if (routeModalMap.getLayer(MODAL_TRIPS_LAYER_ID)) {
          routeModalMap.setLayoutProperty(MODAL_TRIPS_LAYER_ID, "visibility", "none");
        }
      }
      destroyCharts();
    });
  }
  return routeModalInstance;
}

function ensureModalMap() {
  if (routeModalMap) return routeModalMap;
  try {
    routeModalMap = createMap("route-modal-map", {
      center: [-98.5795, 39.8283],
      zoom: 3,
    });
  } catch (e) {
    console.warn("Map failed", e);
    return null;
  }

  routeModalMap.on("load", () => {
    if (!routeModalMap.getSource(MODAL_SOURCE_ID)) {
      routeModalMap.addSource(MODAL_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!routeModalMap.getSource(MODAL_TRIPS_SOURCE_ID)) {
      routeModalMap.addSource(MODAL_TRIPS_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!routeModalMap.getLayer(MODAL_TRIPS_LAYER_ID)) {
      routeModalMap.addLayer({
        id: MODAL_TRIPS_LAYER_ID,
        type: "line",
        source: MODAL_TRIPS_SOURCE_ID,
        paint: {
          "line-width": 1.5,
          "line-color": ["coalesce", ["get", "color"], "#888"],
          "line-opacity": 0.25,
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: "none",
        },
      });
    }
    if (!routeModalMap.getLayer(MODAL_LINE_LAYER_ID)) {
      routeModalMap.addLayer({
        id: MODAL_LINE_LAYER_ID,
        type: "line",
        source: MODAL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "route"],
        paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 5, 18, 8],
          "line-color": ["coalesce", ["get", "color"], "#3b8a7f"],
          "line-opacity": 0.9,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }
    if (!routeModalMap.getLayer(MODAL_START_LAYER_ID)) {
      routeModalMap.addLayer({
        id: MODAL_START_LAYER_ID,
        type: "circle",
        source: MODAL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "start"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#ffffff",
          "circle-stroke-width": 3,
          "circle-stroke-color": ["coalesce", ["get", "color"], "#3b8a7f"],
        },
      });
    }
    if (!routeModalMap.getLayer(MODAL_END_LAYER_ID)) {
      routeModalMap.addLayer({
        id: MODAL_END_LAYER_ID,
        type: "circle",
        source: MODAL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "end"],
        paint: {
          "circle-radius": 7,
          "circle-color": ["coalesce", ["get", "color"], "#b87a4a"],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
    }
  });
  return routeModalMap;
}

/* ───── modal rendering ───── */
function setModalHeader(route) {
  const titleEl = getEl("routeModalTitle");
  const metaEl = getEl("routeModalMeta");
  const openBtn = getEl("route-modal-open-btn");
  if (titleEl) titleEl.textContent = route?.display_name || route?.auto_name || "Route";
  if (metaEl) {
    const startLink = route?.place_links?.start || {};
    const endLink = route?.place_links?.end || {};
    const startLabel =
      sanitizeLocation(startLink?.label || route?.start_label) || "Unknown";
    const endLabel = sanitizeLocation(endLink?.label || route?.end_label) || "Unknown";
    const startHref = buildVisitsLink({
      placeId: startLink?.id,
      label: startLabel,
    });
    const endHref = buildVisitsLink({
      placeId: endLink?.id,
      label: endLabel,
    });

    metaEl.innerHTML = `
      <a class="route-modal-place-link start" href="${startHref}">
        <span class="endpoint-dot start"></span>
        <span>${escapeHtml(startLabel)}</span>
      </a>
      <span class="route-modal-place-sep" aria-hidden="true">\u2192</span>
      <a class="route-modal-place-link end" href="${endHref}">
        <span class="endpoint-dot end"></span>
        <span>${escapeHtml(endLabel)}</span>
      </a>
    `;
  }
  if (openBtn && route?.id) openBtn.href = `/routes/${encodeURIComponent(route.id)}`;
}

function setModalStats(route, analyticsData) {
  const stats = analyticsData?.stats || {};
  const setVal = (id, v) => {
    const el = getEl(id);
    if (el) el.textContent = v;
  };

  setVal("route-stat-trips", String(route?.trip_count || stats.totalTrips || 0));
  setVal(
    "route-stat-frequency",
    analyticsData?.tripsPerWeek != null ? `${analyticsData.tripsPerWeek}` : "--"
  );
  setVal(
    "route-stat-distance",
    route?.distance_miles_avg
      ? formatMiles(route.distance_miles_avg)
      : formatMiles(route?.distance_miles_median)
  );
  setVal(
    "route-stat-duration",
    route?.duration_sec_avg
      ? formatDuration(route.duration_sec_avg)
      : route?.duration_sec_median
        ? formatDuration(route.duration_sec_median)
        : "--"
  );
  setVal(
    "route-stat-first",
    formatDateShort(route?.first_start_time || stats.firstTrip)
  );
  setVal("route-stat-last", formatDateShort(route?.last_start_time || stats.lastTrip));

  const totalDist = stats.totalDistance;
  setVal("route-stat-total-dist", totalDist != null ? formatMiles(totalDist) : "--");
  const totalDur = stats.totalDuration;
  setVal("route-stat-total-time", totalDur != null ? formatDuration(totalDur) : "--");
  setVal(
    "route-stat-fuel",
    route?.fuel_gal_avg != null ? `${Number(route.fuel_gal_avg).toFixed(2)} gal` : "--"
  );
  setVal(
    "route-stat-speed",
    route?.max_speed_mph_max != null
      ? `${Math.round(route.max_speed_mph_max)} mph`
      : stats.maxMaxSpeed != null
        ? `${Math.round(stats.maxMaxSpeed)} mph`
        : "--"
  );
  setVal(
    "route-stat-cost",
    route?.cost_usd_avg != null ? `$${Number(route.cost_usd_avg).toFixed(2)}` : "--"
  );

  // Insight banner
  const personality = getRoutePersonality(route);
  setVal("route-insight-tag", personality);
  const insightSentence = generateModalInsightSentence(route, analyticsData);
  setVal("route-insight-sentence", insightSentence);

  // Key facts
  const tpw = analyticsData?.tripsPerWeek ?? computeTripsPerWeek(route);
  setVal(
    "route-fact-frequency",
    tpw > 0 ? `${Number(tpw).toFixed(1)}x / week` : `${route?.trip_count || 0} total`
  );

  const distStr = route?.distance_miles_avg
    ? formatMiles(route.distance_miles_avg)
    : formatMiles(route?.distance_miles_median);
  const durStr = route?.duration_sec_avg
    ? formatDuration(route.duration_sec_avg)
    : route?.duration_sec_median
      ? formatDuration(route.duration_sec_median)
      : "";
  setVal("route-fact-distance", durStr ? `${distStr} / ${durStr}` : distStr);

  const consistency = computeConsistencyScore(analyticsData);
  if (consistency) {
    setVal("route-fact-consistency", `${consistency.score}`);
    const consistLabel = getEl("route-fact-consistency");
    if (consistLabel) consistLabel.title = consistency.label;
  } else {
    const medDist = Number(route?.distance_miles_median || 0);
    const avgDist = Number(route?.distance_miles_avg || 0);
    if (medDist > 0 && avgDist > 0) {
      const ratio = medDist / avgDist;
      setVal(
        "route-fact-consistency",
        ratio > 0.9 && ratio < 1.1 ? "Consistent" : "Variable"
      );
    } else {
      setVal("route-fact-consistency", "--");
    }
  }
}

function syncModalControls(route) {
  const nameInput = getEl("route-modal-name");
  const colorInput = getEl("route-modal-color");
  const pinBtn = getEl("route-modal-pin-btn");
  const hideBtn = getEl("route-modal-hide-btn");
  const badge = getEl("route-modal-map-badge");
  const badgeText = getEl("route-modal-map-badge-text");
  if (nameInput) {
    nameInput.value = route?.name || "";
    nameInput.placeholder = route?.auto_name || "(auto)";
  }
  if (colorInput) {
    const c = route?.color || "#3b8a7f";
    colorInput.value = c.startsWith("#") ? c : `#${c}`;
  }
  if (pinBtn) pinBtn.classList.toggle("active", Boolean(route?.is_pinned));
  if (hideBtn) hideBtn.classList.toggle("active", Boolean(route?.is_hidden));
  if (badge) {
    const show = Boolean(route?.is_pinned || route?.is_hidden);
    badge.style.display = show ? "flex" : "none";
    if (badgeText) badgeText.textContent = route?.is_hidden ? "Hidden" : "Pinned";
  }
}

/* ───── charts ───── */
function renderMonthlyChart(data) {
  const canvas = getEl("route-chart-monthly");
  if (!canvas || typeof Chart === "undefined") return;
  const byMonth = data?.byMonth || [];
  const hasData =
    Array.isArray(byMonth) &&
    byMonth.length > 0 &&
    byMonth.some((m) => Number(m?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-monthly",
    "route-chart-monthly-empty",
    hasData,
    "Not enough monthly data for this route."
  );
  if (!hasData) return;

  const labels = byMonth.map((m) => formatMonthLabel(m._id));
  const counts = byMonth.map((m) => m.count);
  const color = routeStrokeColor(routeModalRoute);
  destroyCanvasChart(canvas);
  chartMonthly = destroyChartRef(chartMonthly);

  chartMonthly = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: `${color}66`,
          borderColor: color,
          borderWidth: 1.5,
          borderRadius: 4,
          barPercentage: 0.7,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Monthly insight
  const monthlyInsight = getEl("route-chart-monthly-insight");
  if (monthlyInsight && byMonth.length >= 3) {
    const recent = counts.slice(-3);
    const earlier = counts.slice(-6, -3);
    if (earlier.length > 0) {
      const recentAvg = recent.reduce((s, c) => s + c, 0) / recent.length;
      const earlierAvg = earlier.reduce((s, c) => s + c, 0) / earlier.length;
      if (earlierAvg > 0) {
        const change = ((recentAvg - earlierAvg) / earlierAvg) * 100;
        if (Math.abs(change) > 10) {
          monthlyInsight.textContent =
            change > 0
              ? `Trending up ${Math.round(change)}% over recent months`
              : `Trending down ${Math.round(Math.abs(change))}% over recent months`;
        } else {
          monthlyInsight.textContent = "Steady frequency over recent months";
        }
      }
    }
  }
}

function renderHourChart(data) {
  const canvas = getEl("route-chart-hour");
  if (!canvas || typeof Chart === "undefined") return;
  const byHour = data?.byHour || [];
  const hasData =
    Array.isArray(byHour) &&
    byHour.length > 0 &&
    byHour.some((h) => Number(h?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-hour",
    "route-chart-hour-empty",
    hasData,
    "Not enough hourly data for this route."
  );
  if (!hasData) return;

  const labels = byHour.map((h) => formatHourLabel(h.hour));
  const counts = byHour.map((h) => h.count);
  const maxCount = Math.max(...counts, 1);
  const color = routeStrokeColor(routeModalRoute);
  destroyCanvasChart(canvas);
  chartHour = destroyChartRef(chartHour);

  chartHour = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: counts.map(
            (c) =>
              `${color}${Math.round((c / maxCount) * 180 + 40)
                .toString(16)
                .padStart(2, "0")}`
          ),
          borderRadius: 3,
          barPercentage: 0.85,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Hourly insight
  const hourInsight = getEl("route-chart-hour-insight");
  if (hourInsight) {
    const peak = byHour.reduce(
      (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
      byHour[0]
    );
    if (peak && peak.count > 0) {
      hourInsight.textContent = `Peak departure: ${formatHourLabel(peak.hour)}\u2013${formatHourLabel((peak.hour + 1) % 24)} with ${peak.count} trip${peak.count !== 1 ? "s" : ""}`;
    }
  }
}

function renderDowChart(data) {
  const canvas = getEl("route-chart-dow");
  if (!canvas || typeof Chart === "undefined") return;
  const byDay = data?.byDayOfWeek || [];
  const hasData =
    Array.isArray(byDay) &&
    byDay.length > 0 &&
    byDay.some((d) => Number(d?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-dow",
    "route-chart-dow-empty",
    hasData,
    "Not enough day-of-week data for this route."
  );
  if (!hasData) return;

  const labels = byDay.map((d) => d.dayName);
  const counts = byDay.map((d) => d.count);
  const maxCount = Math.max(...counts, 1);
  const color = routeStrokeColor(routeModalRoute);
  destroyCanvasChart(canvas);
  chartDow = destroyChartRef(chartDow);

  chartDow = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: counts.map(
            (c) =>
              `${color}${Math.round((c / maxCount) * 180 + 40)
                .toString(16)
                .padStart(2, "0")}`
          ),
          borderRadius: 4,
          barPercentage: 0.65,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Day of week insight
  const dowInsight = getEl("route-chart-dow-insight");
  if (dowInsight) {
    const peak = byDay.reduce(
      (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
      byDay[0]
    );
    if (peak && peak.count > 0) {
      dowInsight.textContent = `${peak.dayName} is most active with ${peak.count} trip${peak.count !== 1 ? "s" : ""}`;
    }
  }
}

function renderDistanceTrendChart(data) {
  const canvas = getEl("route-chart-distance-trend");
  if (!canvas || typeof Chart === "undefined") return;
  const timeline = data?.timeline || [];
  const hasData =
    Array.isArray(timeline) &&
    timeline.filter((t) => Number.isFinite(Number(t?.distance))).length > 1;
  setChartEmptyState(
    "route-chart-distance-trend",
    "route-chart-distance-trend-empty",
    hasData,
    "Not enough trend data for this route."
  );
  if (!hasData) return;

  const labels = timeline.map((t) => {
    const d = new Date(t.startTime);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  const distances = timeline.map((t) => t.distance);
  const durations = timeline.map((t) => (t.duration != null ? t.duration / 60 : null));
  const color = routeStrokeColor(routeModalRoute);
  const defaults = getChartDefaults();
  destroyCanvasChart(canvas);
  chartDistTrend = destroyChartRef(chartDistTrend);

  chartDistTrend = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Distance (mi)",
          data: distances,
          borderColor: color,
          backgroundColor: `${color}22`,
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
          yAxisID: "y",
        },
        {
          label: "Duration (min)",
          data: durations,
          borderColor: "#b87a4a",
          backgroundColor: "transparent",
          borderDash: [4, 3],
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: {
          display: true,
          labels: {
            color: "rgba(255,255,255,0.6)",
            boxWidth: 12,
            padding: 8,
            font: { size: 10 },
          },
        },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            label: (ctx) =>
              ctx.datasetIndex === 0
                ? `${Number(ctx.parsed.y).toFixed(1)} mi`
                : `${Number(ctx.parsed.y).toFixed(0)} min`,
          },
        },
      },
      scales: {
        ...defaults.scales,
        x: {
          ...defaults.scales.x,
          ticks: { ...defaults.scales.x.ticks, maxTicksLimit: 8 },
        },
        y: {
          ...defaults.scales.y,
          title: {
            display: true,
            text: "Miles",
            color: "rgba(255,255,255,0.4)",
            font: { size: 10 },
          },
        },
        y1: {
          position: "right",
          ticks: { color: "rgba(255,255,255,0.4)", font: { size: 10 } },
          grid: { display: false },
          border: { display: false },
          beginAtZero: true,
          title: {
            display: true,
            text: "Minutes",
            color: "rgba(255,255,255,0.4)",
            font: { size: 10 },
          },
        },
      },
    },
  });

  // Distance trend insight
  const trendInsight = getEl("route-chart-trend-insight");
  if (trendInsight && distances.length >= 3) {
    const validDist = distances.filter(Number.isFinite);
    if (validDist.length >= 3) {
      const mean = validDist.reduce((s, d) => s + d, 0) / validDist.length;
      const variance =
        validDist.reduce((s, d) => s + (d - mean) ** 2, 0) / validDist.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      if (cv < 0.1)
        trendInsight.textContent = `Very consistent distance (${mean.toFixed(1)} mi avg)`;
      else if (cv < 0.25)
        trendInsight.textContent = `Mostly consistent distance with some variation`;
      else trendInsight.textContent = `Distance varies significantly between trips`;
    }
  }
}

/* ───── trips list ───── */
function setModalTrips(trips) {
  const list = getEl("route-modal-trips-list");
  const count = getEl("route-modal-trips-count");
  if (count) count.textContent = String(trips.length);
  if (!list) return;
  list.innerHTML = "";
  if (!Array.isArray(trips) || trips.length === 0) {
    list.innerHTML =
      '<div class="routes-inline-empty">No trips are currently assigned to this route.</div>';
    return;
  }
  trips.forEach((trip) => {
    const tx = trip.transactionId;
    const startDt = trip.startTime ? new Date(trip.startTime) : null;
    const when =
      startDt && !Number.isNaN(startDt.getTime())
        ? startDt.toLocaleString()
        : "Unknown time";
    const dist =
      typeof trip.distance === "number" ? `${trip.distance.toFixed(1)} mi` : "--";
    const dur =
      typeof trip.duration === "number" ? formatDuration(trip.duration) : "--";
    const startLabel =
      sanitizeLocation(trip.place_links?.start?.label) ||
      sanitizeLocation(trip.startPlaceLabel) ||
      sanitizeLocation(trip.startLocation) ||
      "Unknown start";
    const endLabel =
      sanitizeLocation(trip.place_links?.end?.label) ||
      sanitizeLocation(trip.destinationPlaceLabel) ||
      sanitizeLocation(trip.destinationPlaceName) ||
      sanitizeLocation(trip.destination) ||
      "Unknown destination";

    const startHref = buildVisitsLink({
      placeId: trip.place_links?.start?.id || trip.startPlaceId,
      label: startLabel,
    });
    const endHref = buildVisitsLink({
      placeId: trip.place_links?.end?.id || trip.destinationPlaceId,
      label: endLabel,
    });

    const row = document.createElement("article");
    row.className = "route-trip-row";
    row.innerHTML = `
      <div class="route-trip-row-top">
        <div class="route-trip-row-title">${escapeHtml(when)}</div>
        <div class="route-trip-row-meta">${escapeHtml(dist)} &middot; ${escapeHtml(dur)}</div>
      </div>
      <div class="route-trip-row-places">
        <a class="route-trip-place-chip start" href="${startHref}">
          <span class="endpoint-dot start"></span>
          <span>${escapeHtml(startLabel)}</span>
        </a>
        <span class="route-trip-place-sep" aria-hidden="true">\u2192</span>
        <a class="route-trip-place-chip end" href="${endHref}">
          <span class="endpoint-dot end"></span>
          <span>${escapeHtml(endLabel)}</span>
        </a>
      </div>
      <div class="route-trip-row-actions">
        <a class="route-trip-open-link" href="${tx ? `/trips/${encodeURIComponent(tx)}` : "/trips"}">
          <i class="fas fa-external-link-alt" aria-hidden="true"></i>
          <span>Open trip</span>
        </a>
      </div>
    `;
    list.appendChild(row);
  });
}

/* ───── map display ───── */
function setModalMap(route) {
  const map = ensureModalMap();
  if (!map) return;
  const geometry = route?.geometry;
  const color = routeStrokeColor(route);
  const features = [];

  if (geometry) {
    features.push({
      type: "Feature",
      geometry,
      properties: { kind: "route", color },
    });
    const bbox = bboxForGeometry(geometry);
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      let start = null;
      let end = null;
      if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
        start = geometry.coordinates[0];
        end = geometry.coordinates[geometry.coordinates.length - 1];
      } else if (
        geometry.type === "MultiLineString" &&
        Array.isArray(geometry.coordinates)
      ) {
        start = geometry.coordinates[0]?.[0];
        const lastLine = geometry.coordinates[geometry.coordinates.length - 1];
        end = lastLine?.[lastLine.length - 1];
      }
      if (Array.isArray(start) && start.length >= 2)
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: start },
          properties: { kind: "start", color },
        });
      if (Array.isArray(end) && end.length >= 2)
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: end },
          properties: { kind: "end", color },
        });

      const fc = { type: "FeatureCollection", features };
      const applyData = () => {
        const src = map.getSource(MODAL_SOURCE_ID);
        if (src) src.setData(fc);
        map.resize();
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 48, duration: 450, essential: true }
        );
      };
      if (map.isStyleLoaded()) applyData();
      else map.once("load", applyData);
      return;
    }
  }
  const src = map.getSource(MODAL_SOURCE_ID);
  if (src) src.setData({ type: "FeatureCollection", features });
}

/* ───── all-trips overlay ───── */
async function toggleAllTrips() {
  const map = routeModalMap;
  const routeId = routeModalRouteId;
  if (!map || !routeId) return;

  showAllTrips = !showAllTrips;
  const btn = getEl("route-modal-show-all-trips");
  if (btn) {
    const icon = '<i class="fas fa-layer-group me-2" aria-hidden="true"></i>';
    btn.innerHTML = showAllTrips
      ? `${icon}Hide trip overlays`
      : `${icon}Show all trips`;
  }
  if (btn) btn.classList.toggle("active", showAllTrips);

  if (!showAllTrips) {
    if (map.getLayer(MODAL_TRIPS_LAYER_ID))
      map.setLayoutProperty(MODAL_TRIPS_LAYER_ID, "visibility", "none");
    return;
  }

  try {
    if (btn) btn.disabled = true;
    const resp = await apiGet(
      `/api/recurring_routes/${encodeURIComponent(routeId)}/trips?limit=200&offset=0&include_geometry=true`,
      { cache: false }
    );
    const trips = Array.isArray(resp?.trips) ? resp.trips : [];
    const color = routeStrokeColor(routeModalRoute);
    let features = trips
      .filter((t) => t.gps?.type)
      .map((t) => ({
        type: "Feature",
        geometry: t.gps,
        properties: { color },
      }));
    if (features.length === 0) {
      showAllTrips = false;
      if (btn) {
        btn.classList.remove("active");
        btn.innerHTML =
          '<i class="fas fa-layer-group me-2" aria-hidden="true"></i>Show all trips';
      }
      if (map.getLayer(MODAL_TRIPS_LAYER_ID))
        map.setLayoutProperty(MODAL_TRIPS_LAYER_ID, "visibility", "none");
      notificationManager.show?.(
        "No trip geometry is available for this route.",
        "info"
      );
      return;
    }
    if (features.length > 150) {
      features = features.slice(0, 150);
      notificationManager.show?.(
        "Showing the most recent 150 trip paths to keep the map responsive.",
        "info"
      );
    }
    const applyOverlay = () => {
      const src = map.getSource(MODAL_TRIPS_SOURCE_ID);
      if (src) src.setData({ type: "FeatureCollection", features });
      if (map.getLayer(MODAL_TRIPS_LAYER_ID))
        map.setLayoutProperty(MODAL_TRIPS_LAYER_ID, "visibility", "visible");
    };
    if (map.isStyleLoaded()) applyOverlay();
    else map.once("load", applyOverlay);
  } catch (e) {
    notificationManager.show?.(
      `Failed to load trip geometries: ${e?.message || e}`,
      "warning"
    );
    showAllTrips = false;
    if (btn) btn.classList.remove("active");
    if (btn)
      btn.innerHTML =
        '<i class="fas fa-layer-group me-2" aria-hidden="true"></i>Show all trips';
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ───── places connection ───── */
function loadConnectedPlaces(route) {
  const container = getEl("route-modal-places");
  const list = getEl("route-places-list");
  if (!container || !list) return;
  const start = route?.place_links?.start || null;
  const end = route?.place_links?.end || null;
  const startLabel = sanitizeLocation(start?.label || route?.start_label);
  const endLabel = sanitizeLocation(end?.label || route?.end_label);

  const items = [];
  if (startLabel) {
    items.push({
      kind: "Start",
      href: buildVisitsLink({ placeId: start?.id, label: startLabel }),
      label: startLabel,
    });
  }
  if (endLabel) {
    items.push({
      kind: "End",
      href: buildVisitsLink({ placeId: end?.id, label: endLabel }),
      label: endLabel,
    });
  }

  if (items.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "";
  list.innerHTML = "";
  items.forEach((item) => {
    const link = document.createElement("a");
    link.href = item.href;
    link.className = "connected-place-link";
    link.innerHTML = `
      <span class="connected-place-kind">${escapeHtml(item.kind)}</span>
      <i class="fas fa-map-marker-alt" aria-hidden="true"></i>
      <span>${escapeHtml(item.label)}</span>
      <i class="fas fa-external-link-alt" aria-hidden="true"></i>
    `;
    list.appendChild(link);
  });
}

/* ───── all-paths explorer ───── */
function setExplorerStatus(message, tone = "muted") {
  const status = getEl("routes-explorer-status");
  if (!status) return;
  status.textContent = message;
  status.classList.remove("is-error", "is-success", "is-muted");
  status.classList.add(
    tone === "error" ? "is-error" : tone === "success" ? "is-success" : "is-muted"
  );
}

function setExplorerLoading(isLoading) {
  const runBtn = getEl("routes-explorer-run-btn");
  if (!runBtn) return;
  runBtn.disabled = Boolean(isLoading);
  runBtn.classList.toggle("is-loading", Boolean(isLoading));
}

function getExplorerTimeframe() {
  const selected = document.querySelector(
    'input[name="routes-explorer-timeframe"]:checked'
  );
  return selected?.value || "90d";
}

function toExplorerArray(value) {
  return Array.isArray(value) ? value : [];
}

function setExplorerDefaults() {
  const setVal = (id, value) => {
    const el = getEl(id);
    if (el) el.textContent = value;
  };
  setVal("routes-explorer-kpi-trips", "--");
  setVal("routes-explorer-kpi-variants", "--");
  setVal("routes-explorer-kpi-top-share", "--");
  setVal("routes-explorer-kpi-span", "--");

  const variantList = getEl("routes-explorer-variant-share-list");
  if (variantList) {
    variantList.innerHTML =
      '<div class="routes-inline-empty">Run analysis to see route variant share.</div>';
  }

  const variants = getEl("routes-explorer-variants-list");
  if (variants) {
    variants.innerHTML =
      '<div class="routes-inline-empty">Run analysis to inspect matched variants.</div>';
  }

  setChartEmptyState(
    "routes-explorer-variant-share-chart",
    "routes-explorer-variant-share-empty",
    false,
    "Run analysis to see variant share."
  );
  setChartEmptyState(
    "routes-explorer-chart-monthly",
    "routes-explorer-chart-monthly-empty",
    false,
    "No monthly data yet."
  );
  setChartEmptyState(
    "routes-explorer-chart-hour",
    "routes-explorer-chart-hour-empty",
    false,
    "No hourly data yet."
  );
  setChartEmptyState(
    "routes-explorer-chart-day",
    "routes-explorer-chart-day-empty",
    false,
    "No day-of-week data yet."
  );
}

function populateExplorerPlaceSelectors(places) {
  const start = getEl("routes-explorer-start-place");
  const end = getEl("routes-explorer-end-place");
  const runBtn = getEl("routes-explorer-run-btn");
  if (!start || !end) return;

  const items = Array.isArray(places) ? places : [];
  const options = [
    '<option value="">Choose a place</option>',
    ...items
      .map((p) => {
        const id = escapeHtml(String(p.id || p._id || ""));
        const name = escapeHtml(p.name || "Unnamed place");
        return `<option value="${id}">${name}</option>`;
      })
      .filter(Boolean),
  ].join("");
  start.innerHTML = options;
  end.innerHTML = options;

  const disabled = items.length === 0;
  start.disabled = disabled;
  end.disabled = disabled;

  if (items.length >= 2) {
    start.value = String(items[0].id || items[0]._id || "");
    end.value = String(items[1].id || items[1]._id || "");
  } else if (items.length === 1) {
    start.value = String(items[0].id || items[0]._id || "");
    end.value = "";
  }

  if (runBtn) runBtn.disabled = items.length < 2;
  if (items.length < 2) {
    setExplorerStatus(
      "Create at least two custom places in Visits to use All Paths Explorer.",
      "error"
    );
  } else {
    setExplorerStatus("Select places and click Analyze pair.", "muted");
  }
}

function normalizeExplorerByMonth(data) {
  return toExplorerArray(data).map((entry) => ({
    label: entry?._id || entry?.month || entry?.yearMonth || entry?.label || "",
    count: Number(entry?.count ?? entry?.trips ?? entry?.total ?? 0) || 0,
  }));
}

function normalizeExplorerByHour(data) {
  const source = toExplorerArray(data);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0,
  }));
  source.forEach((entry) => {
    const hour = Number(entry?.hour ?? entry?._id);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
    byHour[hour].count = Number(entry?.count ?? entry?.trips ?? entry?.total ?? 0) || 0;
  });
  return byHour;
}

function normalizeExplorerByDay(data) {
  const source = toExplorerArray(data);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDay = dayNames.map((dayName, index) => ({
    dayName,
    count: 0,
    index,
  }));
  source.forEach((entry) => {
    const dayFromName = dayNames.findIndex(
      (n) => String(n).toLowerCase() === String(entry?.dayName || "").toLowerCase()
    );
    const dayRaw = Number(entry?.day ?? entry?._id ?? entry?.index);
    const zeroBased =
      dayFromName >= 0
        ? dayFromName
        : Number.isInteger(dayRaw)
          ? dayRaw >= 1 && dayRaw <= 7
            ? dayRaw - 1
            : dayRaw
          : -1;
    if (zeroBased < 0 || zeroBased > 6) return;
    byDay[zeroBased].count =
      Number(entry?.count ?? entry?.trips ?? entry?.total ?? 0) || 0;
  });
  return byDay;
}

function normalizeExplorerVariants(data) {
  return toExplorerArray(data).map((entry, idx) => {
    const trips = Number(entry?.trip_count ?? entry?.trips ?? entry?.count ?? 0) || 0;
    let share = Number(
      entry?.share ??
        entry?.share_ratio ??
        entry?.share_pct ??
        entry?.sharePercent ??
        entry?.percentage ??
        Number.NaN
    );
    if (Number.isFinite(share) && share > 1) share /= 100;
    return {
      key:
        entry?.variant_id ||
        entry?.variantId ||
        entry?.route_id ||
        entry?.routeId ||
        `variant-${idx + 1}`,
      label:
        entry?.label ||
        entry?.display_name ||
        entry?.name ||
        entry?.route_name ||
        entry?.routeName ||
        `Variant ${idx + 1}`,
      trips,
      share: Number.isFinite(share) ? share : null,
      distance: Number(
        entry?.median_distance ?? entry?.distance_miles ?? entry?.distance ?? Number.NaN
      ),
      duration: Number(
        entry?.median_duration ?? entry?.duration_sec ?? entry?.duration ?? Number.NaN
      ),
      routeId: entry?.route_id || entry?.routeId || entry?.id || null,
      tripId:
        entry?.sample_trip_id ||
        entry?.trip_id ||
        entry?.tripId ||
        entry?.transactionId ||
        entry?.example_trip_id ||
        null,
    };
  });
}

function normalizeExplorerVariantShare(data, variants, totalTrips) {
  const source = toExplorerArray(data);
  if (source.length > 0) {
    return source.map((entry, idx) => {
      const trips = Number(entry?.trip_count ?? entry?.trips ?? entry?.count ?? 0) || 0;
      let share = Number(
        entry?.share ??
          entry?.share_ratio ??
          entry?.share_pct ??
          entry?.sharePercent ??
          entry?.percentage ??
          Number.NaN
      );
      if (!Number.isFinite(share) && totalTrips > 0) share = trips / totalTrips;
      if (share > 1) share /= 100;
      return {
        key: entry?.variant_id || entry?.variantId || `variant-share-${idx + 1}`,
        label: entry?.label || entry?.name || `Variant ${idx + 1}`,
        trips,
        share: Number.isFinite(share) ? share : 0,
      };
    });
  }

  const sourceVariants = variants.filter((v) => v.trips > 0);
  if (sourceVariants.length === 0) return [];
  const denom =
    totalTrips > 0 ? totalTrips : sourceVariants.reduce((sum, v) => sum + v.trips, 0);
  return sourceVariants.map((variant) => ({
    key: variant.key,
    label: variant.label,
    trips: variant.trips,
    share: denom > 0 ? variant.trips / denom : 0,
  }));
}

function normalizeExplorerResponse(raw, timeframe) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : raw || {};
  const summaryRaw = data?.summary || data?.kpis || data?.stats || {};
  const variants = normalizeExplorerVariants(
    data?.variants || data?.route_variants || data?.variant_routes
  );
  const totalTripsFromSummary =
    Number(
      summaryRaw?.totalTrips ??
        summaryRaw?.total_trips ??
        summaryRaw?.trip_count ??
        data?.totalTrips ??
        data?.total_trips
    ) || 0;
  const variantShare = normalizeExplorerVariantShare(
    data?.variant_share || data?.variantShare || data?.variantShares,
    variants,
    totalTripsFromSummary
  );
  const totalTrips =
    totalTripsFromSummary ||
    variantShare.reduce((sum, entry) => sum + (entry.trips || 0), 0) ||
    variants.reduce((sum, entry) => sum + (entry.trips || 0), 0);
  const variantCount =
    Number(
      summaryRaw?.variantCount ??
        summaryRaw?.variant_count ??
        summaryRaw?.totalVariants ??
        data?.variantCount
    ) ||
    variantShare.length ||
    variants.length;
  const topShare =
    Number(
      summaryRaw?.topShare ??
        summaryRaw?.top_share ??
        summaryRaw?.dominantShare ??
        summaryRaw?.dominant_share
    ) ||
    (variantShare.length > 0
      ? Math.max(...variantShare.map((entry) => Number(entry.share || 0)))
      : 0);
  const firstTripRaw =
    summaryRaw?.first_trip ?? summaryRaw?.firstTrip ?? data?.first_trip ?? null;
  const lastTripRaw =
    summaryRaw?.last_trip ?? summaryRaw?.lastTrip ?? data?.last_trip ?? null;
  const firstTrip = firstTripRaw ? new Date(firstTripRaw) : null;
  const lastTrip = lastTripRaw ? new Date(lastTripRaw) : null;
  const spanFromDates =
    firstTrip &&
    lastTrip &&
    !Number.isNaN(firstTrip.getTime()) &&
    !Number.isNaN(lastTrip.getTime())
      ? Math.max(1, Math.round((lastTrip.getTime() - firstTrip.getTime()) / 86400000))
      : 0;
  const spanDays =
    Number(
      summaryRaw?.spanDays ??
        summaryRaw?.span_days ??
        summaryRaw?.coveredDays ??
        summaryRaw?.days
    ) ||
    spanFromDates ||
    (timeframe === "90d" ? 90 : 0);
  return {
    totalTrips,
    variantCount,
    topShare,
    spanDays,
    byMonth: normalizeExplorerByMonth(data?.byMonth || data?.monthly || data?.by_month),
    byHour: normalizeExplorerByHour(data?.byHour || data?.hourly || data?.by_hour),
    byDay: normalizeExplorerByDay(
      data?.byDayOfWeek || data?.byDay || data?.by_day || data?.day_of_week
    ),
    variantShare,
    variants,
  };
}

function renderExplorerSummary(summary, timeframe) {
  const setVal = (id, value) => {
    const el = getEl(id);
    if (el) el.textContent = value;
  };
  const topShareNum = Number(summary?.topShare);
  setVal(
    "routes-explorer-kpi-trips",
    Number(summary?.totalTrips || 0).toLocaleString()
  );
  setVal(
    "routes-explorer-kpi-variants",
    Number(summary?.variantCount || 0).toLocaleString()
  );
  setVal(
    "routes-explorer-kpi-top-share",
    Number.isFinite(topShareNum) ? formatPercent(topShareNum * 100) : "--"
  );
  if (summary?.spanDays) {
    setVal("routes-explorer-kpi-span", `${Math.round(summary.spanDays)} days`);
  } else {
    setVal("routes-explorer-kpi-span", timeframe === "all" ? "All time" : "--");
  }

  // Generate explorer insight sentence
  const insightEl = getEl("routes-explorer-insight-sentence");
  if (insightEl && summary?.totalTrips > 0) {
    const startSelect = getEl("routes-explorer-start-place");
    const endSelect = getEl("routes-explorer-end-place");
    const startName = startSelect?.selectedOptions?.[0]?.textContent || "start";
    const endName = endSelect?.selectedOptions?.[0]?.textContent || "end";
    const topPct = Number.isFinite(topShareNum)
      ? `${Math.round(topShareNum * 100)}%`
      : "";
    const parts = [`Between ${startName} and ${endName}`];
    if (summary.variantCount > 0)
      parts.push(
        `${summary.variantCount} route variant${summary.variantCount !== 1 ? "s" : ""}`
      );
    if (topPct)
      parts.push(`most popular covers ${topPct} of ${summary.totalTrips} trips`);
    insightEl.textContent = `${parts.join(", ")}.`;
    insightEl.style.display = "";
  } else if (insightEl) {
    insightEl.textContent = "";
    insightEl.style.display = "none";
  }
}

function renderExplorerVariantShareList(items) {
  const list = getEl("routes-explorer-variant-share-list");
  if (!list) return;
  list.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    list.innerHTML =
      '<div class="routes-inline-empty">No variant share data for this pair.</div>';
    return;
  }
  items
    .slice()
    .sort((a, b) => Number(b.share || 0) - Number(a.share || 0))
    .forEach((entry) => {
      const row = document.createElement("div");
      row.className = "routes-variant-share-item";
      row.innerHTML = `
        <span class="routes-variant-share-label">${escapeHtml(entry.label || "Variant")}</span>
        <span class="routes-variant-share-value">${formatPercent(Number(entry.share || 0) * 100)}</span>
      `;
      list.appendChild(row);
    });
}

function renderExplorerVariantShareChart(items) {
  const canvas = getEl("routes-explorer-variant-share-chart");
  if (!canvas || typeof Chart === "undefined") return;
  const source = Array.isArray(items)
    ? items.filter((entry) => Number(entry.share || 0) > 0)
    : [];
  const hasData = source.length > 0;
  setChartEmptyState(
    "routes-explorer-variant-share-chart",
    "routes-explorer-variant-share-empty",
    hasData,
    "No variant share data for this pair."
  );
  if (!hasData) return;

  destroyCanvasChart(canvas);
  explorerChartVariantShare = destroyChartRef(explorerChartVariantShare);
  explorerChartVariantShare = new Chart(canvas, {
    type: "bar",
    data: {
      labels: source.map((entry) => entry.label),
      datasets: [
        {
          data: source.map((entry) => Number(entry.share || 0) * 100),
          backgroundColor: [
            "#3b8a7f",
            "#b87a4a",
            "#6b8ec8",
            "#7abf58",
            "#d28973",
            "#9872bf",
          ],
          borderRadius: 8,
          barPercentage: 0.8,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      indexAxis: "y",
      scales: {
        ...getChartDefaults().scales,
        x: {
          ...getChartDefaults().scales.x,
          ticks: {
            ...getChartDefaults().scales.x.ticks,
            callback: (value) => `${value}%`,
          },
          beginAtZero: true,
          max: 100,
        },
        y: {
          ...getChartDefaults().scales.y,
          grid: { display: false },
          ticks: { color: "rgba(255,255,255,0.72)", font: { size: 11 } },
        },
      },
    },
  });
}

function renderExplorerMonthlyChart(byMonth) {
  const canvas = getEl("routes-explorer-chart-monthly");
  if (!canvas || typeof Chart === "undefined") return;
  const source = toExplorerArray(byMonth).filter((entry) => entry.count > 0);
  const hasData = source.length > 0;
  setChartEmptyState(
    "routes-explorer-chart-monthly",
    "routes-explorer-chart-monthly-empty",
    hasData,
    "No monthly data yet."
  );
  if (!hasData) return;
  destroyCanvasChart(canvas);
  explorerChartMonthly = destroyChartRef(explorerChartMonthly);
  explorerChartMonthly = new Chart(canvas, {
    type: "bar",
    data: {
      labels: source.map((entry) => formatMonthLabel(entry.label)),
      datasets: [
        {
          data: source.map((entry) => entry.count),
          backgroundColor: "rgba(59,138,127,0.48)",
          borderColor: "#3b8a7f",
          borderWidth: 1.5,
          borderRadius: 5,
          barPercentage: 0.75,
        },
      ],
    },
    options: getChartDefaults(),
  });
}

function renderExplorerHourChart(byHour) {
  const canvas = getEl("routes-explorer-chart-hour");
  if (!canvas || typeof Chart === "undefined") return;
  const source = toExplorerArray(byHour);
  const hasData = source.some((entry) => Number(entry.count || 0) > 0);
  setChartEmptyState(
    "routes-explorer-chart-hour",
    "routes-explorer-chart-hour-empty",
    hasData,
    "No hourly data yet."
  );
  if (!hasData) return;
  destroyCanvasChart(canvas);
  explorerChartHour = destroyChartRef(explorerChartHour);
  explorerChartHour = new Chart(canvas, {
    type: "bar",
    data: {
      labels: source.map((entry) => formatHourLabel(entry.hour)),
      datasets: [
        {
          data: source.map((entry) => entry.count),
          backgroundColor: "rgba(107,142,200,0.48)",
          borderColor: "#6b8ec8",
          borderWidth: 1.2,
          borderRadius: 4,
          barPercentage: 0.86,
        },
      ],
    },
    options: getChartDefaults(),
  });
}

function renderExplorerDayChart(byDay) {
  const canvas = getEl("routes-explorer-chart-day");
  if (!canvas || typeof Chart === "undefined") return;
  const source = toExplorerArray(byDay);
  const hasData = source.some((entry) => Number(entry.count || 0) > 0);
  setChartEmptyState(
    "routes-explorer-chart-day",
    "routes-explorer-chart-day-empty",
    hasData,
    "No day-of-week data yet."
  );
  if (!hasData) return;
  destroyCanvasChart(canvas);
  explorerChartDay = destroyChartRef(explorerChartDay);
  explorerChartDay = new Chart(canvas, {
    type: "bar",
    data: {
      labels: source.map((entry) => entry.dayName),
      datasets: [
        {
          data: source.map((entry) => entry.count),
          backgroundColor: "rgba(184,122,74,0.45)",
          borderColor: "#b87a4a",
          borderWidth: 1.2,
          borderRadius: 4,
          barPercentage: 0.74,
        },
      ],
    },
    options: getChartDefaults(),
  });
}

function renderExplorerVariants(variants) {
  const list = getEl("routes-explorer-variants-list");
  if (!list) return;
  list.innerHTML = "";
  const source = toExplorerArray(variants).filter(
    (entry) => Number(entry?.trips || 0) > 0
  );
  if (source.length === 0) {
    list.innerHTML =
      '<div class="routes-inline-empty">No matched recurring-route variants for this pair.</div>';
    return;
  }

  source
    .slice()
    .sort((a, b) => Number(b.trips || 0) - Number(a.trips || 0))
    .forEach((entry) => {
      const item = document.createElement("article");
      item.className = "routes-variant-item";
      const shareLabel =
        entry.share != null
          ? `<span class="routes-variant-chip">${formatPercent(Number(entry.share) * 100)}</span>`
          : "";
      const distLabel =
        Number.isFinite(entry.distance) && entry.distance > 0
          ? `${entry.distance.toFixed(1)} mi`
          : "--";
      const durLabel =
        Number.isFinite(entry.duration) && entry.duration > 0
          ? formatDuration(entry.duration)
          : "--";
      const routeLink = entry.routeId
        ? `<a class="routes-variant-link" href="/routes/${encodeURIComponent(entry.routeId)}"><i class="fas fa-route"></i> Route</a>`
        : "";
      const tripLink = entry.tripId
        ? `<a class="routes-variant-link" href="/trips/${encodeURIComponent(entry.tripId)}"><i class="fas fa-car"></i> Sample trip</a>`
        : "";
      item.innerHTML = `
        <div class="routes-variant-main">
          <div>
            <div class="routes-variant-title">${escapeHtml(entry.label || "Variant")}</div>
            <div class="routes-variant-meta">${Number(entry.trips || 0).toLocaleString()} trips · ${escapeHtml(distLabel)} · ${escapeHtml(durLabel)}</div>
          </div>
          ${shareLabel}
        </div>
        <div class="routes-variant-links">${routeLink}${tripLink}</div>
      `;
      list.appendChild(item);
    });
}

async function requestExplorerAnalysis(payload) {
  const params = new URLSearchParams();
  params.set("start_place_id", payload.start_place_id);
  params.set("end_place_id", payload.end_place_id);
  params.set("include_reverse", payload.include_reverse ? "true" : "false");
  params.set("timeframe", payload.timeframe);
  params.set("limit", "500");
  return apiGet(`/api/recurring_routes/place_pair_analysis?${params.toString()}`, {
    cache: false,
  });
}

async function runExplorerAnalysis() {
  const start = getEl("routes-explorer-start-place");
  const end = getEl("routes-explorer-end-place");
  const includeReverse = getEl("routes-explorer-include-reverse");
  if (!start || !end) return;

  const startPlaceId = (start.value || "").trim();
  const endPlaceId = (end.value || "").trim();
  if (!startPlaceId || !endPlaceId) {
    setExplorerStatus(
      "Choose both start and end places before running analysis.",
      "error"
    );
    return;
  }

  const timeframe = getExplorerTimeframe();
  const requestId = ++explorerRequestId;
  setExplorerLoading(true);
  setExplorerStatus("Analyzing selected place pair...", "muted");

  try {
    const payload = {
      start_place_id: startPlaceId,
      end_place_id: endPlaceId,
      include_reverse: Boolean(includeReverse?.checked),
      timeframe,
    };
    const raw = await requestExplorerAnalysis(payload);
    if (requestId !== explorerRequestId) return;

    const normalized = normalizeExplorerResponse(raw, timeframe);
    renderExplorerSummary(normalized, timeframe);
    renderExplorerVariantShareList(normalized.variantShare);
    renderExplorerVariantShareChart(normalized.variantShare);
    renderExplorerMonthlyChart(normalized.byMonth);
    renderExplorerHourChart(normalized.byHour);
    renderExplorerDayChart(normalized.byDay);
    renderExplorerVariants(normalized.variants);

    if (normalized.totalTrips > 0 || normalized.variants.length > 0) {
      setExplorerStatus("Analysis complete.", "success");
    } else {
      setExplorerStatus(
        "No recurring-route data matched this pair for the selected timeframe.",
        "muted"
      );
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    destroyExplorerCharts();
    setExplorerDefaults();
    setExplorerStatus(
      `Unable to analyze pair: ${error?.message || "request failed"}`,
      "error"
    );
  } finally {
    if (requestId === explorerRequestId) setExplorerLoading(false);
  }
}

async function initExplorerSelectors() {
  const places = await loadPlacesCatalog();
  populateExplorerPlaceSelectors(places);
  destroyExplorerCharts();
  setExplorerDefaults();
}

function bindExplorerControls(signal) {
  const start = getEl("routes-explorer-start-place");
  const end = getEl("routes-explorer-end-place");
  const runBtn = getEl("routes-explorer-run-btn");
  const timeframeInputs = document.querySelectorAll(
    'input[name="routes-explorer-timeframe"]'
  );
  const opts = signal ? { signal } : false;

  const expandBtn = getEl("routes-explorer-expand-btn");
  const teaser = getEl("routes-explorer-teaser");
  const body = getEl("routes-explorer-body");
  if (expandBtn && body) {
    expandBtn.addEventListener(
      "click",
      () => {
        const isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "";
        expandBtn.querySelector("span").textContent = isOpen
          ? "Open Explorer"
          : "Close Explorer";
        expandBtn.querySelector("i").classList.toggle("fa-chevron-down", isOpen);
        expandBtn.querySelector("i").classList.toggle("fa-chevron-up", !isOpen);
        if (teaser) teaser.classList.toggle("is-expanded", !isOpen);
      },
      opts
    );
  }

  if (runBtn) runBtn.addEventListener("click", runExplorerAnalysis, opts);
  if (start) {
    start.addEventListener(
      "change",
      () => setExplorerStatus("Selection updated. Click Analyze pair.", "muted"),
      opts
    );
  }
  if (end) {
    end.addEventListener(
      "change",
      () => setExplorerStatus("Selection updated. Click Analyze pair.", "muted"),
      opts
    );
  }
  timeframeInputs.forEach((input) =>
    input.addEventListener(
      "change",
      () => setExplorerStatus("Timeframe updated. Click Analyze pair.", "muted"),
      opts
    )
  );
}

/* ───── tabs ───── */
function activateModalTab(tab) {
  document
    .querySelectorAll(".routes-modal-tab")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document
    .querySelectorAll(".routes-modal-tab-content")
    .forEach((c) => c.classList.toggle("active", c.dataset.tabContent === tab));
}

function renderModalAnalyticsCharts() {
  const analyticsData = routeModalAnalyticsData || {};
  renderMonthlyChart(analyticsData);
  renderHourChart(analyticsData);
  renderDowChart(analyticsData);
  renderDistanceTrendChart(analyticsData);
}

function handleModalTabChange(tab) {
  if (tab === "analytics") {
    renderModalAnalyticsCharts();
    return;
  }
  destroyCharts();
}

function initModalTabs() {
  const tabBtns = document.querySelectorAll(".routes-modal-tab");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activateModalTab(tab);
      handleModalTabChange(tab);
    });
  });
}

/* ───── open modal ───── */
async function openRouteModal(routeId) {
  if (!routeId) return;
  const instance = ensureRouteModal();
  if (!instance) return;

  const token = ++routeModalOpenToken;
  routeModalRouteId = routeId;
  routeModalAnalyticsData = null;
  showAllTrips = false;
  destroyCharts();

  // Reset tabs to overview
  activateModalTab("overview");

  const allTripsBtn = getEl("route-modal-show-all-trips");
  if (allTripsBtn) {
    allTripsBtn.classList.remove("active");
    allTripsBtn.disabled = false;
    allTripsBtn.innerHTML =
      '<i class="fas fa-layer-group me-2" aria-hidden="true"></i>Show all trips';
  }
  if (routeModalMap) {
    const tripsSource = routeModalMap.getSource(MODAL_TRIPS_SOURCE_ID);
    if (tripsSource) {
      tripsSource.setData({ type: "FeatureCollection", features: [] });
    }
    if (routeModalMap.getLayer(MODAL_TRIPS_LAYER_ID)) {
      routeModalMap.setLayoutProperty(MODAL_TRIPS_LAYER_ID, "visibility", "none");
    }
  }

  try {
    const [detailResp, analyticsResp] = await Promise.all([
      apiGet(`/api/recurring_routes/${encodeURIComponent(routeId)}`, {
        cache: false,
      }),
      apiGet(`/api/recurring_routes/${encodeURIComponent(routeId)}/analytics`, {
        cache: false,
      }).catch(() => null),
    ]);

    if (token !== routeModalOpenToken || routeModalRouteId !== routeId) return;
    const route = detailResp?.route;
    if (!route) throw new Error("Route not found");
    routeModalRoute = route;
    routeModalAnalyticsData = analyticsResp || {};

    setModalHeader(route);
    setModalStats(route, analyticsResp);
    syncModalControls(route);
    loadConnectedPlaces(route);

    instance.show();
    setTimeout(() => {
      if (token !== routeModalOpenToken) return;
      setModalMap(route);
    }, 80);

    const tripsResp = await apiGet(
      `/api/recurring_routes/${encodeURIComponent(routeId)}/trips?limit=100&offset=0`,
      { cache: false }
    );
    if (token !== routeModalOpenToken || routeModalRouteId !== routeId) return;
    setModalTrips(Array.isArray(tripsResp?.trips) ? tripsResp.trips : []);
  } catch (e) {
    if (token !== routeModalOpenToken || e?.name === "AbortError") return;
    notificationManager.show?.(`Failed to open route: ${e?.message || e}`, "danger");
  }
}

/* ───── route PATCH ───── */
async function saveRoutePatch(routeId, patch) {
  if (!routeId) return null;
  const resp = await apiPatch(
    `/api/recurring_routes/${encodeURIComponent(routeId)}`,
    patch
  );
  return resp?.route || null;
}

/* ───── bindings ───── */
function bindModalControls(signal) {
  const nameInput = getEl("route-modal-name");
  const colorInput = getEl("route-modal-color");
  const pinBtn = getEl("route-modal-pin-btn");
  const hideBtn = getEl("route-modal-hide-btn");
  const allTripsBtn = getEl("route-modal-show-all-trips");

  const saveNameNow = async () => {
    if (!routeModalRouteId) return;
    const name = (nameInput?.value || "").trim();
    try {
      const updated = await saveRoutePatch(routeModalRouteId, {
        name: name || null,
      });
      if (updated) {
        routeModalRoute = updated;
        setModalHeader(updated);
        syncModalControls(updated);
        await loadRoutes();
      }
    } catch (e) {
      notificationManager.show?.(`Failed to save name: ${e?.message || e}`, "warning");
    }
  };
  const debouncedName = debounce(saveNameNow, 500);

  const opts = signal ? { signal } : false;
  if (nameInput) {
    nameInput.addEventListener("input", debouncedName, opts);
    nameInput.addEventListener("blur", saveNameNow, opts);
  }
  if (colorInput) {
    colorInput.addEventListener(
      "change",
      async () => {
        if (!routeModalRouteId) return;
        try {
          const updated = await saveRoutePatch(routeModalRouteId, {
            color: colorInput.value,
          });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            setModalMap(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(
            `Failed to save color: ${e?.message || e}`,
            "warning"
          );
        }
      },
      opts
    );
  }
  if (pinBtn) {
    pinBtn.addEventListener(
      "click",
      async () => {
        if (!routeModalRouteId || !routeModalRoute) return;
        try {
          const updated = await saveRoutePatch(routeModalRouteId, {
            is_pinned: !routeModalRoute.is_pinned,
          });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(
            `Failed to update pin: ${e?.message || e}`,
            "warning"
          );
        }
      },
      opts
    );
  }
  if (hideBtn) {
    hideBtn.addEventListener(
      "click",
      async () => {
        if (!routeModalRouteId || !routeModalRoute) return;
        try {
          const updated = await saveRoutePatch(routeModalRouteId, {
            is_hidden: !routeModalRoute.is_hidden,
          });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(
            `Failed to update hidden: ${e?.message || e}`,
            "warning"
          );
        }
      },
      opts
    );
  }
  if (allTripsBtn) {
    allTripsBtn.addEventListener("click", () => toggleAllTrips(), opts);
  }
}

function sortRoutes(routes, sortKey) {
  const sorted = [...routes];
  switch (sortKey) {
    case "recent":
      sorted.sort((a, b) => {
        const ta = a.last_start_time ? new Date(a.last_start_time).getTime() : 0;
        const tb = b.last_start_time ? new Date(b.last_start_time).getTime() : 0;
        return tb - ta;
      });
      break;
    case "distance":
      sorted.sort(
        (a, b) => (b.distance_miles_median || 0) - (a.distance_miles_median || 0)
      );
      break;
    case "alpha":
      sorted.sort((a, b) => {
        const na = (
          a.display_name ||
          a.name ||
          a.auto_name ||
          a.start_label ||
          ""
        ).toLowerCase();
        const nb = (
          b.display_name ||
          b.name ||
          b.auto_name ||
          b.start_label ||
          ""
        ).toLowerCase();
        return na.localeCompare(nb);
      });
      break;
    default: // "trips" - pinned first, then by trip count (default API order)
      break;
  }
  // Always keep pinned routes first
  if (sortKey !== "trips") {
    const pinned = sorted.filter((r) => r.is_pinned);
    const unpinned = sorted.filter((r) => !r.is_pinned);
    return [...pinned, ...unpinned];
  }
  return sorted;
}

function bindPageControls(signal) {
  const search = getEl("routes-search-input");
  const clearBtn = getEl("routes-search-clear");
  const minTrips = getEl("routes-min-trips");
  const vehicle = getEl("routes-vehicle");
  const includeHidden = getEl("routes-include-hidden");
  const buildBtn = getEl("routes-build-btn");
  const cancelBtn = getEl("routes-cancel-btn");
  const emptyBuildBtn = getEl("routes-empty-build-btn");

  const triggerLoad = debounce(() => loadRoutes(), 250);
  const opts = signal ? { signal } : false;

  if (search) {
    search.addEventListener(
      "input",
      () => {
        listState.q = search.value || "";
        if (clearBtn) clearBtn.classList.toggle("d-none", !listState.q);
        triggerLoad();
      },
      opts
    );
  }
  if (clearBtn) {
    clearBtn.addEventListener(
      "click",
      () => {
        if (search) search.value = "";
        listState.q = "";
        clearBtn.classList.add("d-none");
        loadRoutes();
      },
      opts
    );
  }
  if (minTrips) {
    minTrips.addEventListener(
      "change",
      () => {
        listState.minTrips = Number(minTrips.value) || 3;
        loadRoutes();
      },
      opts
    );
  }
  if (vehicle) {
    vehicle.addEventListener(
      "change",
      () => {
        listState.imei = vehicle.value || "";
        loadRoutes();
      },
      opts
    );
  }
  if (includeHidden) {
    includeHidden.addEventListener(
      "change",
      () => {
        listState.includeHidden = Boolean(includeHidden.checked);
        loadRoutes();
      },
      opts
    );
  }

  const statsToggle = getEl("routes-stats-toggle");
  const statsPanel = getEl("routes-hero-stats");
  if (statsToggle && statsPanel) {
    statsToggle.addEventListener(
      "click",
      () => {
        const expanded = statsToggle.getAttribute("aria-expanded") === "true";
        statsToggle.setAttribute("aria-expanded", String(!expanded));
        statsPanel.classList.toggle("collapsed", expanded);
        statsPanel.classList.toggle("expanded", !expanded);
        statsToggle.querySelector("span").textContent = expanded
          ? "View stats"
          : "Hide stats";
      },
      opts
    );
  }

  const sortSelect = getEl("routes-sort");
  if (sortSelect) {
    sortSelect.addEventListener(
      "change",
      () => {
        listState.sort = sortSelect.value || "trips";
        renderRoutes(sortRoutes(allRoutes, listState.sort));
      },
      opts
    );
  }

  const startBuildHandler = () => startBuild();
  if (buildBtn) buildBtn.addEventListener("click", startBuildHandler, opts);
  if (emptyBuildBtn) emptyBuildBtn.addEventListener("click", startBuildHandler, opts);
  if (cancelBtn) cancelBtn.addEventListener("click", cancelBuild, opts);
}

/* ───── entry-point ───── */
export default async function initRoutesPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;

  setBuildUi({
    dotState: "idle",
    text: "Ready to build",
    showProgress: false,
    showCancel: false,
    stage: "idle",
    progress: 0,
  });

  initModalTabs();
  bindPageControls(signal);
  bindModalControls(signal);
  bindExplorerControls(signal);

  await loadVehicles();
  await initExplorerSelectors();
  await loadRoutes();

  const preload = getPreloadRouteIdFromUrl();
  if (preload) requestAnimationFrame(() => openRouteModal(preload));

  const teardown = () => {
    stopBuildPolling();
    destroyCharts();
    destroyExplorerCharts();
    explorerRequestId += 1;
    if (routeModalMap) {
      try {
        routeModalMap.remove();
      } catch {
        /* ok */
      }
      routeModalMap = null;
    }
    routeModalInstance = null;
    routeModalRouteId = null;
    routeModalRoute = null;
    routeModalAnalyticsData = null;
    pageSignal = null;
  };

  if (typeof cleanup === "function") cleanup(teardown);
  return teardown;
}
