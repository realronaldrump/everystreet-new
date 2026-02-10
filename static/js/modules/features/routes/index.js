/* global bootstrap, mapboxgl */
/**
 * Routes Page - Recurring Route Templates
 * Browse, filter, build, and edit locally-derived route templates.
 */

import apiClient from "../../core/api-client.js";
import { createMap } from "../../map-base.js";
import notificationManager from "../../ui/notifications.js";
import { debounce, escapeHtml, formatDuration, sanitizeLocation } from "../../utils.js";

const DEFAULT_LIST_LIMIT = 200;

let pageSignal = null;
let listState = {
  q: "",
  minTrips: 3,
  includeHidden: false,
  imei: "",
};

let routesData = [];
let vehicles = [];

let buildPollTimer = null;
let activeBuildJobId = null;

let routeModalInstance = null;
let routeModalMap = null;
let routeModalRouteId = null;
let routeModalRoute = null;
let routeModalOpenToken = 0;
const MODAL_SOURCE_ID = "route-modal-geojson";
const MODAL_LINE_LAYER_ID = "route-modal-line";
const MODAL_START_LAYER_ID = "route-modal-start";
const MODAL_END_LAYER_ID = "route-modal-end";

const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;
const apiGet = (url, options = {}) => apiClient.get(url, withSignal(options));
const apiPost = (url, body, options = {}) =>
  apiClient.post(url, body, withSignal(options));
const apiPatch = (url, body, options = {}) =>
  apiClient.patch(url, body, withSignal(options));

function getEl(id) {
  return document.getElementById(id);
}

function getPreloadRouteIdFromUrl(href = window.location.href) {
  try {
    const url = new URL(href, window.location.origin);
    const path = url.pathname || "";
    const match = path.match(/^\\/routes\\/([^/]+)$/);
    if (match) {
      return match[1] || null;
    }
    return url.searchParams.get("route_id");
  } catch {
    return null;
  }
}

function setLoading(isLoading) {
  const loading = getEl("routes-loading");
  const grid = getEl("routes-grid");
  const empty = getEl("routes-empty");
  if (!loading || !grid || !empty) {
    return;
  }
  loading.classList.toggle("d-none", !isLoading);
  empty.classList.add("d-none");
  if (isLoading) {
    grid.setAttribute("aria-busy", "true");
  } else {
    grid.removeAttribute("aria-busy");
  }
}

function showEmpty(show) {
  const empty = getEl("routes-empty");
  if (!empty) {
    return;
  }
  empty.classList.toggle("d-none", !show);
}

function updateCount(count) {
  const countEl = getEl("routes-results-count");
  if (countEl) {
    countEl.textContent = String(count);
  }
  const resultsCount = getEl("routes-results-count");
  if (resultsCount) {
    // Keep
  }
}

function updateResultsHeader(total) {
  const countEl = getEl("routes-results-count");
  const hintEl = getEl("routes-results-hint");
  if (countEl) {
    countEl.textContent = String(total || 0);
  }
  if (hintEl) {
    const minTrips = Number(listState.minTrips) || 3;
    const vehicle = listState.imei ? vehicles.find((v) => v.imei === listState.imei) : null;
    const vehicleLabel = vehicle ? sanitizeLocation(vehicle.custom_name || vehicle.label || vehicle.vin || vehicle.imei) : null;
    const recurringText = minTrips >= 3 ? "recurring routes" : `routes with ${minTrips}+ trip${minTrips === 1 ? "" : "s"}`;
    hintEl.textContent = vehicleLabel
      ? `Showing ${recurringText} for ${vehicleLabel}`
      : `Showing ${recurringText}`;
  }
}

function formatMiles(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "--";
  }
  return `${n.toFixed(1)} mi`;
}

function formatDateShort(value) {
  if (!value) {
    return "--";
  }
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    return "--";
  }
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function routeStrokeColor(route) {
  const raw = (route?.color || "").trim();
  if (raw && raw.startsWith("#") && raw.length === 7) {
    return raw;
  }
  return "rgb(var(--primary-rgb) / 90%)";
}

function createRouteCard(route) {
  const card = document.createElement("div");
  card.className = "route-card";
  card.dataset.routeId = route.id;
  card.style.setProperty("--route-stroke", routeStrokeColor(route));

  const start = route.start_label || "Unknown";
  const end = route.end_label || "Unknown";
  const subtitle = `${start} → ${end}`;

  const pills = [];
  if (route.is_pinned) {
    pills.push(`<span class="route-pill primary"><i class="fas fa-thumbtack"></i> Pinned</span>`);
  }
  if (route.is_hidden) {
    pills.push(`<span class="route-pill"><i class="fas fa-eye-slash"></i> Hidden</span>`);
  }
  pills.push(`<span class="route-pill"><i class="fas fa-repeat"></i> ${route.trip_count || 0}</span>`);

  const previewPath = route.preview_svg_path || "M 5,35 Q 25,5 50,20 T 95,15";
  const medianDist = formatMiles(route.distance_miles_median);
  const medianDur = route.duration_sec_median ? formatDuration(route.duration_sec_median) : "--";
  const lastTaken = formatDateShort(route.last_start_time);

  card.innerHTML = `
    <div class="route-card-top">
      <div class="route-card-main">
        <h3 class="route-card-title">${escapeHtml(route.display_name || route.auto_name || "Route")}</h3>
        <div class="route-card-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      <div class="route-card-badges">
        ${pills.join("")}
      </div>
    </div>
    <div class="route-card-preview">
      <div class="route-preview-frame" aria-hidden="true">
        <svg class="route-preview-svg" viewBox="0 0 100 40" preserveAspectRatio="none">
          <path d="${escapeHtml(previewPath)}"></path>
        </svg>
      </div>
      <div class="route-metrics">
        <div class="route-metric">
          <span class="route-metric-label">Median</span>
          <span class="route-metric-value">${escapeHtml(medianDist)}</span>
        </div>
        <div class="route-metric">
          <span class="route-metric-label">Duration</span>
          <span class="route-metric-value">${escapeHtml(medianDur)}</span>
        </div>
        <div class="route-metric">
          <span class="route-metric-label">Last</span>
          <span class="route-metric-value">${escapeHtml(lastTaken)}</span>
        </div>
      </div>
    </div>
  `;

  card.addEventListener("click", () => openRouteModal(route.id));
  return card;
}

function renderRoutes(routes) {
  const grid = getEl("routes-grid");
  if (!grid) {
    return;
  }
  grid.innerHTML = "";

  if (!routes || routes.length === 0) {
    showEmpty(true);
    return;
  }

  showEmpty(false);
  routes.forEach((route) => {
    grid.appendChild(createRouteCard(route));
  });
}

async function loadVehicles() {
  const select = getEl("routes-vehicle");
  if (!select) {
    return;
  }
  try {
    const list = await apiGet("/api/vehicles?active_only=true");
    vehicles = Array.isArray(list) ? list : [];
    select.innerHTML = '<option value="">All vehicles</option>';
    vehicles.forEach((v) => {
      const option = document.createElement("option");
      option.value = v.imei;
      option.textContent = v.custom_name || v.name || v.label || v.vin || v.imei || "Vehicle";
      select.appendChild(option);
    });
  } catch {
    // Vehicles are optional; keep the default.
  }
}

function buildListUrl() {
  const params = new URLSearchParams();
  if (listState.q) {
    params.set("q", listState.q);
  }
  params.set("min_trips", String(listState.minTrips || 3));
  if (listState.includeHidden) {
    params.set("include_hidden", "true");
  }
  if (listState.imei) {
    params.set("imei", listState.imei);
  }
  params.set("limit", String(DEFAULT_LIST_LIMIT));
  params.set("offset", "0");
  return `/api/recurring_routes?${params.toString()}`;
}

async function loadRoutes() {
  setLoading(true);
  try {
    const data = await apiGet(buildListUrl(), { cache: false });
    const routes = Array.isArray(data?.routes) ? data.routes : [];
    routesData = routes;
    updateResultsHeader(data?.total ?? routes.length);
    renderRoutes(routes);

    // Derive "last built" as the max updated_at in the current list.
    const lastBuiltEl = getEl("routes-last-built");
    if (lastBuiltEl && routes.length > 0) {
      const max = routes
        .map((r) => r.updated_at)
        .filter(Boolean)
        .map((v) => new Date(v))
        .filter((d) => !Number.isNaN(d.getTime()))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      if (max) {
        lastBuiltEl.textContent = `Last built: ${max.toLocaleString()}`;
      } else {
        lastBuiltEl.textContent = "Built (timestamp unavailable)";
      }
    }
  } catch (e) {
    notificationManager.show?.(`Failed to load routes: ${e?.message || e}`, "danger");
    renderRoutes([]);
  } finally {
    setLoading(false);
  }
}

function setBuildUi(state) {
  const dot = getEl("routes-build-dot");
  const text = getEl("routes-build-text");
  const progressWrap = getEl("routes-build-progress-wrap");
  const progressBar = getEl("routes-build-progress-bar");
  const stageEl = getEl("routes-build-stage");
  const pctEl = getEl("routes-build-progress");
  const cancelBtn = getEl("routes-cancel-btn");

  if (dot) {
    dot.dataset.state = state?.dotState || "idle";
  }
  if (text) {
    text.textContent = state?.text || "Ready to build";
  }
  if (progressWrap) {
    progressWrap.classList.toggle("d-none", !state?.showProgress);
  }
  if (progressBar) {
    progressBar.style.width = `${Math.max(0, Math.min(100, Number(state?.progress || 0)))}%`;
  }
  if (stageEl) {
    stageEl.textContent = state?.stage || "Queued";
  }
  if (pctEl) {
    pctEl.textContent = `${Math.round(Number(state?.progress || 0))}%`;
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("d-none", !state?.showCancel);
  }
}

function stopBuildPolling() {
  if (buildPollTimer) {
    clearTimeout(buildPollTimer);
    buildPollTimer = null;
  }
  activeBuildJobId = null;
}

async function pollBuildJob(jobId) {
  if (!jobId) {
    return;
  }
  activeBuildJobId = jobId;
  if (buildPollTimer) {
    clearTimeout(buildPollTimer);
    buildPollTimer = null;
  }

  const tick = async () => {
    if (activeBuildJobId !== jobId) {
      return;
    }
    if (pageSignal?.aborted) {
      stopBuildPolling();
      return;
    }
    try {
      const status = await apiGet(`/api/recurring_routes/jobs/${encodeURIComponent(jobId)}`, { cache: false });
      const stage = status?.stage || "unknown";
      const pct = Number(status?.progress || 0);
      const isTerminal = ["completed", "failed", "cancelled", "error"].includes(
        String(status?.status || stage).toLowerCase()
      ) || ["completed", "failed", "cancelled", "error"].includes(String(stage).toLowerCase());

      setBuildUi({
        dotState: isTerminal
          ? String(status?.status || stage).toLowerCase() === "completed"
            ? "success"
            : String(status?.status || stage).toLowerCase() === "cancelled"
              ? "idle"
              : "error"
          : "running",
        text: status?.message || "Building...",
        showProgress: !isTerminal,
        showCancel: !isTerminal,
        stage,
        progress: pct,
      });

      if (isTerminal) {
        stopBuildPolling();
        if (String(status?.status || stage).toLowerCase() === "completed") {
          setBuildUi({
            dotState: "success",
            text: "Build complete",
            showProgress: false,
            showCancel: false,
            stage,
            progress: 100,
          });
          await loadRoutes();
        } else if (String(status?.status || stage).toLowerCase() === "cancelled") {
          setBuildUi({
            dotState: "idle",
            text: "Build cancelled",
            showProgress: false,
            showCancel: false,
            stage: "cancelled",
            progress: 0,
          });
        } else {
          setBuildUi({
            dotState: "error",
            text: status?.error ? `Build failed: ${status.error}` : "Build failed",
            showProgress: false,
            showCancel: false,
            stage: stage || "failed",
            progress: 0,
          });
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        stopBuildPolling();
        return;
      }
      // If the job status endpoint fails intermittently, keep polling.
      console.warn("Build status poll failed", e);
    }

    // Avoid overlapping polls: schedule the next tick only after this one finishes.
    if (activeBuildJobId === jobId && !pageSignal?.aborted) {
      buildPollTimer = setTimeout(() => {
        void tick();
      }, 2000);
    }
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
    if (!jobId) {
      throw new Error("Build job did not return a job_id");
    }
    await pollBuildJob(jobId);
  } catch (e) {
    setBuildUi({
      dotState: "error",
      text: `Failed to start build: ${e?.message || e}`,
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
  if (!jobId) {
    return;
  }
  try {
    await apiPost(`/api/recurring_routes/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  } catch (e) {
    notificationManager.show?.(`Failed to cancel job: ${e?.message || e}`, "warning");
  }
}

function bboxForGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }
  const type = geometry.type;
  const coords = geometry.coordinates;
  const points = [];
  if (type === "LineString" && Array.isArray(coords)) {
    coords.forEach((c) => points.push(c));
  } else if (type === "MultiLineString" && Array.isArray(coords)) {
    coords.forEach((line) => {
      if (Array.isArray(line)) {
        line.forEach((c) => points.push(c));
      }
    });
  } else {
    return null;
  }
  const valid = points
    .filter((c) => Array.isArray(c) && c.length >= 2)
    .map((c) => [Number(c[0]), Number(c[1])])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (valid.length < 2) {
    return null;
  }
  const lons = valid.map((p) => p[0]);
  const lats = valid.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function ensureRouteModal() {
  const modalEl = getEl("routeDetailsModal");
  if (!modalEl || typeof bootstrap === "undefined") {
    return null;
  }
  if (!routeModalInstance) {
    routeModalInstance = bootstrap.Modal.getOrCreateInstance(modalEl);
    modalEl.addEventListener("hidden.bs.modal", () => {
      routeModalRouteId = null;
      routeModalRoute = null;
    });
  }
  return routeModalInstance;
}

function ensureModalMap() {
  if (routeModalMap) {
    return routeModalMap;
  }
  try {
    routeModalMap = createMap("route-modal-map", {
      center: [-98.5795, 39.8283],
      zoom: 3,
    });
  } catch (e) {
    console.warn("Failed to create route modal map", e);
    return null;
  }

  routeModalMap.on("load", () => {
    if (!routeModalMap.getSource(MODAL_SOURCE_ID)) {
      routeModalMap.addSource(MODAL_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!routeModalMap.getLayer(MODAL_LINE_LAYER_ID)) {
      routeModalMap.addLayer({
        id: MODAL_LINE_LAYER_ID,
        type: "line",
        source: MODAL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "route"],
        paint: {
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, 2.5,
            14, 4,
            18, 7,
          ],
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
          "circle-radius": 6,
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
          "circle-radius": 6,
          "circle-color": ["coalesce", ["get", "color"], "#b87a4a"],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
    }
  });

  return routeModalMap;
}

function setModalHeader(route) {
  const titleEl = getEl("routeModalTitle");
  const metaEl = getEl("routeModalMeta");
  const openBtn = getEl("route-modal-open-btn");
  if (titleEl) {
    titleEl.textContent = route?.display_name || route?.auto_name || "Route";
  }
  if (metaEl) {
    const trips = route?.trip_count || 0;
    const dist = route?.distance_miles_median ? formatMiles(route.distance_miles_median) : "--";
    metaEl.textContent = `${trips} trips • ${dist}`;
  }
  if (openBtn && route?.id) {
    openBtn.href = `/routes/${encodeURIComponent(route.id)}`;
  }
}

function setModalStats(route) {
  const tripsEl = getEl("route-stat-trips");
  const distEl = getEl("route-stat-distance");
  const durEl = getEl("route-stat-duration");
  const lastEl = getEl("route-stat-last");
  if (tripsEl) {
    tripsEl.textContent = String(route?.trip_count || 0);
  }
  if (distEl) {
    distEl.textContent = route?.distance_miles_median ? formatMiles(route.distance_miles_median) : "--";
  }
  if (durEl) {
    durEl.textContent = route?.duration_sec_median ? formatDuration(route.duration_sec_median) : "--";
  }
  if (lastEl) {
    lastEl.textContent = route?.last_start_time ? formatDateShort(route.last_start_time) : "--";
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
    const color = route?.color || "#3b8a7f";
    colorInput.value = color.startsWith("#") ? color : `#${color}`;
  }
  if (pinBtn) {
    pinBtn.classList.toggle("active", Boolean(route?.is_pinned));
  }
  if (hideBtn) {
    hideBtn.classList.toggle("active", Boolean(route?.is_hidden));
  }
  if (badge) {
    const show = Boolean(route?.is_pinned || route?.is_hidden);
    badge.style.display = show ? "flex" : "none";
    if (badgeText) {
      badgeText.textContent = route?.is_hidden ? "Hidden" : "Pinned";
    }
  }
}

function setModalTrips(trips, route) {
  const list = getEl("route-modal-trips-list");
  const count = getEl("route-modal-trips-count");
  if (count) {
    count.textContent = String(trips.length);
  }
  if (!list) {
    return;
  }
  list.innerHTML = "";
  trips.forEach((trip) => {
    const tx = trip.transactionId;
    const start = trip.startTime ? new Date(trip.startTime) : null;
    const when = start && !Number.isNaN(start.getTime()) ? start.toLocaleString() : "Unknown time";
    const dist = typeof trip.distance === "number" ? `${trip.distance.toFixed(1)} mi` : "--";
    const dur = typeof trip.duration === "number" ? formatDuration(trip.duration) : "--";
    const startLoc = sanitizeLocation(trip.startLocation);
    const endLoc = sanitizeLocation(trip.destination) || trip.destinationPlaceName || "Unknown";

    const a = document.createElement("a");
    a.className = "route-trip-row";
    a.href = tx ? `/trips/${encodeURIComponent(tx)}` : "/trips";
    a.innerHTML = `
      <div class="route-trip-row-top">
        <div class="route-trip-row-title">${escapeHtml(when)}</div>
        <div class="route-trip-row-meta">${escapeHtml(dist)} • ${escapeHtml(dur)}</div>
      </div>
      <div class="route-trip-row-sub">${escapeHtml(`${startLoc} → ${endLoc}`)}</div>
    `;
    list.appendChild(a);
  });
}

function setModalMap(route) {
  const map = ensureModalMap();
  if (!map) {
    return;
  }

  const geometry = route?.geometry;
  const color = (route?.color || "#3b8a7f").trim() || "#3b8a7f";

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
      const start = Array.isArray(geometry?.coordinates) ? geometry.coordinates?.[0] : null;
      let end = null;
      if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
        end = geometry.coordinates[geometry.coordinates.length - 1];
      } else if (geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
        const lastLine = geometry.coordinates[geometry.coordinates.length - 1];
        if (Array.isArray(lastLine) && lastLine.length > 0) {
          end = lastLine[lastLine.length - 1];
        }
      }

      if (Array.isArray(start) && start.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: start },
          properties: { kind: "start", color },
        });
      }
      if (Array.isArray(end) && end.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: end },
          properties: { kind: "end", color },
        });
      }

      const fc = { type: "FeatureCollection", features };
      const applyData = () => {
        const src = map.getSource(MODAL_SOURCE_ID);
        if (src) {
          src.setData(fc);
        }
        map.resize();
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 48, duration: 450, essential: true }
        );
      };

      if (map.isStyleLoaded()) {
        applyData();
      } else {
        map.once("load", applyData);
      }
      return;
    }
  }

  const fc = { type: "FeatureCollection", features };
  const src = map.getSource(MODAL_SOURCE_ID);
  if (src) {
    src.setData(fc);
  }
}

async function openRouteModal(routeId) {
  if (!routeId) {
    return;
  }
  const instance = ensureRouteModal();
  if (!instance) {
    return;
  }

  const token = ++routeModalOpenToken;
  routeModalRouteId = routeId;
  try {
    const data = await apiGet(`/api/recurring_routes/${encodeURIComponent(routeId)}`, { cache: false });
    if (token !== routeModalOpenToken || routeModalRouteId !== routeId) {
      return;
    }
    const route = data?.route;
    if (!route) {
      throw new Error("Route not found");
    }
    routeModalRoute = route;

    setModalHeader(route);
    setModalStats(route);
    syncModalControls(route);

    instance.show();
    // Resize map after modal is visible.
    setTimeout(() => {
      if (token !== routeModalOpenToken || routeModalRouteId !== routeId) {
        return;
      }
      setModalMap(route);
    }, 50);

    const tripsResp = await apiGet(`/api/recurring_routes/${encodeURIComponent(routeId)}/trips?limit=50&offset=0`, { cache: false });
    if (token !== routeModalOpenToken || routeModalRouteId !== routeId) {
      return;
    }
    const trips = Array.isArray(tripsResp?.trips) ? tripsResp.trips : [];
    setModalTrips(trips, route);
  } catch (e) {
    if (token !== routeModalOpenToken || routeModalRouteId !== routeId || e?.name === "AbortError") {
      return;
    }
    notificationManager.show?.(`Failed to open route: ${e?.message || e}`, "danger");
  }
}

async function saveRoutePatch(routeId, patch) {
  if (!routeId) {
    return null;
  }
  const resp = await apiPatch(`/api/recurring_routes/${encodeURIComponent(routeId)}`, patch);
  return resp?.route || null;
}

function bindModalControls(signal) {
  const nameInput = getEl("route-modal-name");
  const colorInput = getEl("route-modal-color");
  const pinBtn = getEl("route-modal-pin-btn");
  const hideBtn = getEl("route-modal-hide-btn");

  const saveNameNow = async () => {
    if (!routeModalRouteId) {
      return;
    }
    const name = (nameInput?.value || "").trim();
    try {
      const updated = await saveRoutePatch(routeModalRouteId, { name: name || null });
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

  const debouncedNameSave = debounce(saveNameNow, 500);

  if (nameInput) {
    nameInput.addEventListener(
      "input",
      () => {
        debouncedNameSave();
      },
      signal ? { signal } : false
    );
    nameInput.addEventListener(
      "blur",
      () => {
        saveNameNow();
      },
      signal ? { signal } : false
    );
  }

  if (colorInput) {
    colorInput.addEventListener(
      "change",
      async () => {
        if (!routeModalRouteId) {
          return;
        }
        try {
          const updated = await saveRoutePatch(routeModalRouteId, { color: colorInput.value });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            setModalMap(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(`Failed to save color: ${e?.message || e}`, "warning");
        }
      },
      signal ? { signal } : false
    );
  }

  if (pinBtn) {
    pinBtn.addEventListener(
      "click",
      async () => {
        if (!routeModalRouteId || !routeModalRoute) {
          return;
        }
        try {
          const updated = await saveRoutePatch(routeModalRouteId, { is_pinned: !routeModalRoute.is_pinned });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(`Failed to update pin: ${e?.message || e}`, "warning");
        }
      },
      signal ? { signal } : false
    );
  }

  if (hideBtn) {
    hideBtn.addEventListener(
      "click",
      async () => {
        if (!routeModalRouteId || !routeModalRoute) {
          return;
        }
        try {
          const updated = await saveRoutePatch(routeModalRouteId, { is_hidden: !routeModalRoute.is_hidden });
          if (updated) {
            routeModalRoute = updated;
            syncModalControls(updated);
            await loadRoutes();
          }
        } catch (e) {
          notificationManager.show?.(`Failed to update hidden: ${e?.message || e}`, "warning");
        }
      },
      signal ? { signal } : false
    );
  }
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

  if (search) {
    search.addEventListener(
      "input",
      () => {
        listState.q = search.value || "";
        if (clearBtn) {
          clearBtn.classList.toggle("d-none", !listState.q);
        }
        triggerLoad();
      },
      signal ? { signal } : false
    );
  }

  if (clearBtn) {
    clearBtn.addEventListener(
      "click",
      () => {
        if (search) {
          search.value = "";
        }
        listState.q = "";
        clearBtn.classList.add("d-none");
        loadRoutes();
      },
      signal ? { signal } : false
    );
  }

  if (minTrips) {
    minTrips.addEventListener(
      "change",
      () => {
        listState.minTrips = Number(minTrips.value) || 3;
        loadRoutes();
      },
      signal ? { signal } : false
    );
  }

  if (vehicle) {
    vehicle.addEventListener(
      "change",
      () => {
        listState.imei = vehicle.value || "";
        loadRoutes();
      },
      signal ? { signal } : false
    );
  }

  if (includeHidden) {
    includeHidden.addEventListener(
      "change",
      () => {
        listState.includeHidden = Boolean(includeHidden.checked);
        loadRoutes();
      },
      signal ? { signal } : false
    );
  }

  const startBuildHandler = () => startBuild();

  if (buildBtn) {
    buildBtn.addEventListener("click", startBuildHandler, signal ? { signal } : false);
  }
  if (emptyBuildBtn) {
    emptyBuildBtn.addEventListener("click", startBuildHandler, signal ? { signal } : false);
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelBuild, signal ? { signal } : false);
  }
}

export default async function initRoutesPage({ signal, cleanup } = {}) {
  pageSignal = signal || null;
  const cleanupFns = [];
  const registerCleanup = (fn) => {
    if (typeof fn === "function") {
      cleanupFns.push(fn);
    }
  };

  setBuildUi({
    dotState: "idle",
    text: "Ready to build",
    showProgress: false,
    showCancel: false,
    stage: "idle",
    progress: 0,
  });

  bindPageControls(signal);
  bindModalControls(signal);

  await loadVehicles();
  await loadRoutes();

  const preload = getPreloadRouteIdFromUrl();
  if (preload) {
    requestAnimationFrame(() => openRouteModal(preload));
  }

  const teardown = () => {
    stopBuildPolling();
    if (routeModalMap) {
      try {
        routeModalMap.remove();
      } catch {}
      routeModalMap = null;
    }
    routeModalInstance = null;
    routeModalRouteId = null;
    routeModalRoute = null;
    pageSignal = null;
    cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
}
