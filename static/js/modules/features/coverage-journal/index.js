/* global mapboxgl */

import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { createMap, isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";
import { escapeHtml } from "../../utils.js";

const VALID_RANGES = new Set(["all", "365d", "90d"]);
const VALID_SOURCES = new Set(["all", "trip", "manual"]);
const VALID_LEVELS = new Set(["street", "segment"]);
const RANGE_LABELS = { all: "All time", "365d": "12 months", "90d": "90 days" };
const MAP_SOURCE = "journal-streets";
const MAP_LAYER = "journal-streets-line";

function initialState() {
  const params = new URLSearchParams(window.location.search);
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return {
    areaId: document.getElementById("coverage-journal")?.dataset.areaId || "",
    range: VALID_RANGES.has(params.get("range")) ? params.get("range") : "all",
    source: VALID_SOURCES.has(params.get("source")) ? params.get("source") : "all",
    level: VALID_LEVELS.has(params.get("level")) ? params.get("level") : "street",
    asOf: params.get("as_of") || "",
    activeMilestone: hash.startsWith("milestone-") ? hash.slice(10) : "",
    metadata: null,
    geojson: null,
    areas: [],
    contributions: [],
    nextCursor: null,
    map: null,
    mapReady: false,
    mapMode: "progress",
    selectedIds: new Set(),
    listeners: [],
  };
}

let state = initialState();
let featureApi = null;

const $ = (id) => document.getElementById(id);

function listen(target, type, handler, options) {
  if (!target) {
    return;
  }
  target.addEventListener(type, handler, options);
  state.listeners.push(() => target.removeEventListener(type, handler, options));
}

function formatNumber(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(number)
    : "—";
}

function formatMiles(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${formatNumber(number, digits)} mi` : "—";
}

function parseDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatDate(value, options = {}) {
  const date = parseDate(value);
  if (!date) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: options.short ? "short" : "long",
    day: "numeric",
  }).format(date);
}

function formatShortDate(value) {
  const date = parseDate(value);
  if (!date) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    date
  );
}

function dateOnly(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

function tokenColor(variable, fallback) {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color || fallback;
  probe.remove();
  return color;
}

function palette() {
  return {
    cobalt: tokenColor("--primary", "rgb(55, 111, 214)"),
    steel: tokenColor("--text-tertiary", "rgb(118, 130, 143)"),
    coral: tokenColor("--danger", "rgb(205, 88, 82)"),
    ochre: tokenColor("--warning", "rgb(187, 132, 45)"),
    surface: tokenColor("--surface-1", "rgb(20, 25, 31)"),
  };
}

function setStateMessage(message, type = "loading") {
  const element = $("journal-state");
  const text = $("journal-state-text");
  if (!element || !text) {
    return;
  }
  text.textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.hidden = type === "ready";
  $("journal-content").hidden = type !== "ready";
  $("coverage-journal").setAttribute(
    "aria-busy",
    type === "loading" ? "true" : "false"
  );
}

function syncUrl({ replace = true } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("range", state.range);
  url.searchParams.set("source", state.source);
  url.searchParams.set("level", state.level);
  if (state.asOf) {
    url.searchParams.set("as_of", state.asOf);
  } else {
    url.searchParams.delete("as_of");
  }
  url.hash = state.activeMilestone ? `milestone-${state.activeMilestone}` : "";
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

function setActiveControls() {
  document.querySelectorAll("[data-journal-range]").forEach((button) => {
    const active = button.dataset.journalRange === state.range;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-journal-source]").forEach((button) => {
    const active = button.dataset.journalSource === state.source;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-journal-level]").forEach((button) => {
    const active = button.dataset.journalLevel === state.level;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function loadAreas() {
  const response = await featureApi.get("/api/coverage/areas", { cache: false });
  state.areas = (Array.isArray(response?.areas) ? response.areas : []).filter(
    (area) => String(area.status || "").toLowerCase() === "ready"
  );
  const select = $("journal-area-select");
  if (!select) {
    return;
  }
  select.innerHTML = state.areas
    .map(
      (area) =>
        `<option value="${escapeHtml(String(area.id))}">${escapeHtml(
          area.display_name || "Unnamed area"
        )} · ${formatNumber(area.coverage_percentage, 1)}%</option>`
    )
    .join("");
  select.value = state.areaId;
}

async function loadMetadata() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const params = new URLSearchParams({ range: state.range, timezone });
  state.metadata = await featureApi.get(
    `/api/coverage/areas/${encodeURIComponent(state.areaId)}/journal?${params}`,
    { cache: false }
  );
}

async function loadSegments() {
  const response = await featureApi.raw(
    `/api/coverage/areas/${encodeURIComponent(state.areaId)}/journal/segments?range=${encodeURIComponent(
      state.range
    )}`
  );
  if (!response.ok) {
    let detail = `Street geometry failed (${response.status})`;
    try {
      const payload = await response.json();
      detail = payload?.detail || detail;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(detail);
  }
  state.geojson = await response.json();
}

function renderSummary() {
  const { summary, area } = state.metadata;
  $("journal-title").textContent = area.display_name || "Coverage field journal";
  $("journal-subtitle").textContent = `${formatNumber(
    area.coverage_percentage,
    1
  )}% of the current street inventory is known.`;
  $("journal-stat-coverage").textContent =
    `${formatNumber(area.coverage_percentage, 1)}%`;
  $("journal-stat-miles").textContent =
    `${formatMiles(area.driven_length_miles)} / ${formatMiles(
      area.driveable_length_miles
    )}`;
  $("journal-stat-trips").textContent = formatNumber(summary.historical_trip_count);
  $("journal-stat-days").textContent = formatNumber(summary.active_coverage_days);
  $("journal-stat-first").textContent = formatDate(summary.first_covered_at, {
    short: true,
  });
  $("journal-stat-latest").textContent =
    summary.last_new_street_names?.[0] ||
    formatDate(summary.last_new_street_at, { short: true });
  $("journal-sculpture-link").href =
    `/memory-city?area=${encodeURIComponent(state.areaId)}`;
  $("journal-route-link").href = `/coverage-route-planner?area=${encodeURIComponent(
    state.areaId
  )}`;
}

function milestoneChapters() {
  const chapters = [...(state.metadata?.milestones || [])];
  const coverage = Number(state.metadata?.area?.coverage_percentage || 0);
  const reachedAt = state.metadata?.records?.last_new_street_at;
  const isDuplicate = chapters.some(
    (chapter) =>
      chapter.reached_at === reachedAt &&
      Math.abs(Number(chapter.coverage) - coverage) < 0.01
  );
  if (!isDuplicate && reachedAt) {
    chapters.push({
      key: "current",
      label: coverage >= 100 ? "Every street known" : "Current frontier",
      threshold: coverage,
      reached_at: reachedAt,
      coverage,
      street_names: state.metadata?.records?.last_new_street_names || [],
    });
  }
  return chapters;
}

function renderMilestones() {
  const chapters = milestoneChapters();
  if (
    !state.activeMilestone ||
    !chapters.some((item) => item.key === state.activeMilestone)
  ) {
    state.activeMilestone = chapters.at(-1)?.key || "";
  }
  const list = $("journal-milestones");
  if (!chapters.length) {
    list.innerHTML = `<li class="journal-milestone-copy"><h3>No chapters yet</h3><p>The first coverage-changing trip will open this journal.</p></li>`;
    return;
  }
  list.innerHTML = chapters
    .map((chapter, index) => {
      const marker =
        chapter.key === "first" ? "01" : `${Math.round(chapter.threshold)}%`;
      const names = chapter.street_names?.length
        ? chapter.street_names.join(", ")
        : "Coverage moved forward";
      return `<li class="journal-milestone ${
        chapter.key === state.activeMilestone ? "is-active" : ""
      }" data-milestone-key="${escapeHtml(chapter.key)}">
        <button type="button" data-milestone-index="${index}" aria-label="Show ${escapeHtml(
          chapter.label
        )} on map">
          <span class="journal-milestone-mark">${escapeHtml(marker)}</span>
          <span class="journal-milestone-copy">
            <time datetime="${escapeHtml(dateOnly(chapter.reached_at))}">${escapeHtml(
              formatDate(chapter.reached_at)
            )}</time>
            <h3>${escapeHtml(chapter.label)}</h3>
            <p>${escapeHtml(names)}</p>
          </span>
        </button>
      </li>`;
    })
    .join("");

  list.querySelectorAll("[data-milestone-index]").forEach((button) => {
    listen(button, "click", () =>
      selectMilestone(chapters[Number(button.dataset.milestoneIndex)])
    );
  });
  const selected = chapters.find((chapter) => chapter.key === state.activeMilestone);
  if (selected) {
    selectMilestone(selected, { updateUrl: false });
  }
}

function selectMilestone(chapter, { updateUrl = true } = {}) {
  state.activeMilestone = chapter.key;
  document.querySelectorAll(".journal-milestone").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.milestoneKey === chapter.key);
  });
  const chapters = milestoneChapters();
  const index = chapters.findIndex((item) => item.key === chapter.key);
  const previous = index > 0 ? chapters[index - 1] : null;
  setProgressMap(chapter.reached_at, previous?.reached_at || null, chapter.label);
  const names = chapter.street_names?.length
    ? chapter.street_names.join(", ")
    : "no named roads";
  $("journal-map-equivalent").textContent =
    `${formatDate(chapter.reached_at)} · ${formatNumber(
      chapter.coverage,
      1
    )}% covered · ${names}.`;
  if (updateUrl) {
    syncUrl();
  }
}

function setMapFeatureStyle(feature, color, width = 1.8, opacity = 0.78) {
  feature.properties.journal_color = color;
  feature.properties.journal_width = width;
  feature.properties.journal_opacity = opacity;
}

function refreshMapSource() {
  if (!state.mapReady || !state.geojson) {
    return;
  }
  state.map.getSource(MAP_SOURCE)?.setData(state.geojson);
}

function setProgressMap(cutoffValue, previousValue, label = "Coverage as of") {
  if (!state.geojson) {
    return;
  }
  state.mapMode = "progress";
  state.selectedIds.clear();
  const colors = palette();
  const cutoff = Date.parse(cutoffValue || "") || Number.POSITIVE_INFINITY;
  const previous = Date.parse(previousValue || "") || Number.NEGATIVE_INFINITY;
  let earlier = 0;
  let chapter = 0;
  let remaining = 0;
  for (const feature of state.geojson.features || []) {
    const props = feature.properties || {};
    const first = Date.parse(props.first_driven_at || "");
    if (props.status === "undriveable") {
      setMapFeatureStyle(feature, colors.steel, 1, 0.18);
    } else if (Number.isFinite(first) && first <= previous) {
      setMapFeatureStyle(feature, colors.steel, 1.7, 0.72);
      earlier += 1;
    } else if (Number.isFinite(first) && first <= cutoff) {
      setMapFeatureStyle(feature, colors.cobalt, 3.2, 0.96);
      chapter += 1;
    } else {
      setMapFeatureStyle(feature, colors.coral, 1.3, 0.55);
      remaining += 1;
    }
  }
  $("journal-map-caption").textContent = label;
  $("journal-map-legend").innerHTML = `
    <span><i class="journal-swatch journal-swatch--earlier"></i>${formatNumber(earlier)} earlier</span>
    <span><i class="journal-swatch journal-swatch--chapter"></i>${formatNumber(chapter)} chapter</span>
    <span><i class="journal-swatch journal-swatch--remaining"></i>${formatNumber(
      remaining
    )} remaining</span>`;
  refreshMapSource();
}

function setFrequencyMap() {
  if (!state.geojson) {
    return;
  }
  state.mapMode = "frequency";
  state.selectedIds.clear();
  const colors = palette();
  for (const feature of state.geojson.features || []) {
    const count = Number(feature.properties?.period_trip_count || 0);
    if (count <= 0) {
      setMapFeatureStyle(feature, colors.steel, 1, 0.18);
    } else if (count >= 20) {
      setMapFeatureStyle(feature, colors.cobalt, 5.5, 1);
    } else if (count >= 8) {
      setMapFeatureStyle(feature, colors.cobalt, 4, 0.86);
    } else if (count >= 3) {
      setMapFeatureStyle(feature, colors.cobalt, 2.8, 0.66);
    } else {
      setMapFeatureStyle(feature, colors.cobalt, 1.7, 0.42);
    }
  }
  $("journal-map-caption").textContent =
    `Drive frequency · ${RANGE_LABELS[state.range]}`;
  $("journal-map-legend").innerHTML = `
    <span>Faint · 1 trip</span><span>Medium · 3–19</span><span>Bold · 20+</span>`;
  $("journal-map-equivalent").textContent =
    "The ranking below is the non-map equivalent of this distinct-trip frequency lens.";
  refreshMapSource();
}

function setFrontierMap(selectedIds = []) {
  if (!state.geojson) {
    return;
  }
  state.mapMode = "frontier";
  state.selectedIds = new Set(selectedIds);
  const colors = palette();
  for (const feature of state.geojson.features || []) {
    const props = feature.properties || {};
    if (state.selectedIds.has(props.segment_id)) {
      setMapFeatureStyle(feature, colors.ochre, 5.2, 1);
    } else if (props.status === "undriven") {
      setMapFeatureStyle(feature, colors.coral, 2.3, 0.82);
    } else {
      setMapFeatureStyle(feature, colors.steel, 1, 0.16);
    }
  }
  $("journal-map-caption").textContent = selectedIds.length
    ? "Selected frontier road"
    : "Current frontier";
  $("journal-map-legend").innerHTML =
    `<span>Coral · remaining</span><span>Ochre · selected opportunity</span>`;
  refreshMapSource();
  if (selectedIds.length) {
    fitSelectedSegments(selectedIds);
  }
}

function highlightSegments(segmentIds, label) {
  if (!state.geojson) {
    return;
  }
  const ids = new Set(segmentIds || []);
  state.selectedIds = ids;
  state.mapMode = "selection";
  const colors = palette();
  for (const feature of state.geojson.features || []) {
    const selected = ids.has(feature.properties?.segment_id);
    setMapFeatureStyle(
      feature,
      selected ? colors.cobalt : colors.steel,
      selected ? 5.2 : 1,
      selected ? 1 : 0.16
    );
  }
  $("journal-map-caption").textContent = label;
  $("journal-map-legend").innerHTML =
    `<span>Cobalt · selected current segments</span><span>Steel · context</span>`;
  $("journal-map-equivalent").textContent = `${formatNumber(ids.size)} current segment${
    ids.size === 1 ? "" : "s"
  } highlighted for ${label}.`;
  refreshMapSource();
  fitSelectedSegments([...ids]);
}

function coordinatesFromGeometry(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates || [];
  }
  if (geometry.type === "MultiLineString") {
    return (geometry.coordinates || []).flat();
  }
  return [];
}

function fitSelectedSegments(segmentIds) {
  if (!state.mapReady || !segmentIds.length || typeof mapboxgl === "undefined") {
    return;
  }
  const ids = new Set(segmentIds);
  const points = (state.geojson?.features || [])
    .filter((feature) => ids.has(feature.properties?.segment_id))
    .flatMap((feature) => coordinatesFromGeometry(feature.geometry));
  if (!points.length) {
    return;
  }
  const bounds = points.reduce(
    (accumulator, point) => accumulator.extend(point),
    new mapboxgl.LngLatBounds(points[0], points[0])
  );
  state.map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 450 });
}

function fitArea() {
  const bbox = state.metadata?.area?.bounding_box;
  if (!state.mapReady || !Array.isArray(bbox) || bbox.length < 4) {
    return;
  }
  state.map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 50, duration: 450 }
  );
}

async function initMap() {
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  let accessToken;
  if (isMapboxStyleUrl(styleUrl)) {
    accessToken = await waitForMapboxToken({ timeoutMs: 5000 });
  }
  const bbox = state.metadata?.area?.bounding_box;
  state.map = createMap("journal-map", {
    style: styleUrl,
    accessToken,
    bounds: Array.isArray(bbox)
      ? [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ]
      : undefined,
    fitBoundsOptions: { padding: 50 },
    attributionControl: false,
  });
  await new Promise((resolve) => state.map.once("load", resolve));
  state.map.addSource(MAP_SOURCE, { type: "geojson", data: state.geojson });
  state.map.addLayer({
    id: MAP_LAYER,
    type: "line",
    source: MAP_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["coalesce", ["get", "journal_color"], palette().steel],
      "line-width": ["coalesce", ["get", "journal_width"], 1.4],
      "line-opacity": ["coalesce", ["get", "journal_opacity"], 0.6],
    },
  });
  state.mapReady = true;
  state.map.resize();
  const selected = milestoneChapters().find(
    (item) => item.key === state.activeMilestone
  );
  if (selected) {
    selectMilestone(selected, { updateUrl: false });
  }
}

function chartPath(points, close = false) {
  if (!points.length) {
    return "";
  }
  const path = points
    .map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return close
    ? `${path} L${points.at(-1)[0].toFixed(1)},310 L${points[0][0].toFixed(1)},310 Z`
    : path;
}

function renderPaceChart() {
  const series = state.metadata?.series || [];
  const svg = $("journal-pace-chart");
  const description = $("journal-chart-desc");
  const table = $("journal-series-table");
  if (!series.length) {
    svg.innerHTML = `<title id="journal-chart-title">Cumulative street coverage over time</title><desc id="journal-chart-desc">No coverage-changing activity in this range.</desc><text x="480" y="180" text-anchor="middle" class="journal-chart-axis">No new coverage in ${escapeHtml(
      RANGE_LABELS[state.range]
    )}</text>`;
    table.innerHTML = `<tr><td colspan="4">No coverage-changing activity in this range.</td></tr>`;
    $("journal-timeline-cursor").disabled = true;
    return;
  }
  const left = 62;
  const right = 930;
  const top = 28;
  const bottom = 270;
  const barBottom = 326;
  const maxMiles = Math.max(
    ...series.map((point) => Number(point.new_miles || 0)),
    0.1
  );
  const x = (index) => left + (index / Math.max(1, series.length - 1)) * (right - left);
  const y = (percentage) => bottom - (Number(percentage || 0) / 100) * (bottom - top);
  const points = series.map((point, index) => [x(index), y(point.coverage_percentage)]);
  const grid = [0, 25, 50, 75, 100]
    .map(
      (percent) =>
        `<line x1="${left}" y1="${y(percent)}" x2="${right}" y2="${y(
          percent
        )}" class="journal-chart-grid"/><text x="8" y="${y(percent) + 4}" class="journal-chart-axis">${percent}%</text>`
    )
    .join("");
  const bars = series
    .map((point, index) => {
      const height = (Number(point.new_miles || 0) / maxMiles) * 42;
      const width = Math.max(2, Math.min(12, (right - left) / series.length - 1));
      return `<rect x="${x(index) - width / 2}" y="${barBottom - height}" width="${width}" height="${height}" class="journal-chart-bar"/>`;
    })
    .join("");
  const milestoneMarks = (state.metadata?.milestones || [])
    .map((milestone) => {
      const milestoneDate = Date.parse(milestone.reached_at || "");
      let nearest = 0;
      let distance = Number.POSITIVE_INFINITY;
      series.forEach((point, index) => {
        const difference = Math.abs(Date.parse(point.date) - milestoneDate);
        if (difference < distance) {
          nearest = index;
          distance = difference;
        }
      });
      return `<circle cx="${x(nearest)}" cy="${y(
        milestone.coverage
      )}" r="5" class="journal-chart-milestone"><title>${escapeHtml(
        milestone.label
      )} · ${escapeHtml(formatDate(milestone.reached_at))}</title></circle>`;
    })
    .join("");
  const cursor = $("journal-timeline-cursor");
  cursor.disabled = false;
  cursor.max = String(series.length - 1);
  const requestedIndex = state.asOf
    ? series.findLastIndex((point) => point.date <= state.asOf)
    : series.length - 1;
  cursor.value = String(Math.max(0, requestedIndex));
  const cursorX = x(Number(cursor.value));
  svg.innerHTML = `<title id="journal-chart-title">Cumulative street coverage over time</title>
    <desc id="journal-chart-desc">${series.length} active coverage days in ${escapeHtml(
      RANGE_LABELS[state.range]
    )}; ending at ${formatNumber(series.at(-1).coverage_percentage, 1)} percent.</desc>
    ${grid}<path d="${chartPath(points, true)}" class="journal-chart-area"/>
    ${bars}<path d="${chartPath(points)}" class="journal-chart-line"/>
    ${milestoneMarks}<line x1="${cursorX}" y1="${top}" x2="${cursorX}" y2="${barBottom}" class="journal-chart-cursor" id="journal-chart-cursor-line"/>
    <text x="${left}" y="350" class="journal-chart-axis">${escapeHtml(
      formatShortDate(series[0].date)
    )}</text><text x="${right}" y="350" text-anchor="end" class="journal-chart-axis">${escapeHtml(
      formatShortDate(series.at(-1).date)
    )}</text>`;
  description.textContent = `${series.length} active coverage days in ${RANGE_LABELS[state.range]}.`;
  table.innerHTML = series
    .map(
      (point) =>
        `<tr><td>${escapeHtml(formatDate(point.date, { short: true }))}</td><td>${formatNumber(
          point.coverage_percentage,
          1
        )}%</td><td>${formatMiles(point.new_miles, 2)}</td><td>${formatNumber(
          point.contributions
        )}</td></tr>`
    )
    .join("");
  updateTimelineCursor(Number(cursor.value), { updateUrl: false, updateMap: false });
}

function updateTimelineCursor(index, { updateUrl = true, updateMap = true } = {}) {
  const series = state.metadata?.series || [];
  const point = series[index];
  if (!point) {
    return;
  }
  state.asOf = point.date;
  $("journal-cursor-date").textContent = formatDate(point.date);
  $("journal-cursor-summary").textContent = `${formatNumber(
    point.coverage_percentage,
    1
  )}% covered · ${formatMiles(point.new_miles, 2)} added that day · ${formatNumber(
    point.new_segments
  )} new segments.`;
  const x = 62 + (index / Math.max(1, series.length - 1)) * (930 - 62);
  const line = $("journal-chart-cursor-line");
  if (line) {
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
  }
  if (updateMap) {
    setProgressMap(
      `${point.date}T23:59:59Z`,
      null,
      `Coverage as of ${formatDate(point.date)}`
    );
  }
  if (updateUrl) {
    syncUrl();
  }
}

function renderRecords() {
  const records = state.metadata?.records || {};
  const biggest = records.biggest_push;
  const latest = records.last_period_addition;
  $("journal-records").innerHTML = `
    <div class="journal-record"><span>Biggest push</span><strong>${formatMiles(
      biggest?.new_miles,
      2
    )}</strong><small>${escapeHtml(formatDate(biggest?.occurred_at))}</small></div>
    <div class="journal-record"><span>Longest pause</span><strong>${formatNumber(
      records.longest_pause_days,
      1
    )} days</strong><small>Between coverage-changing sessions</small></div>
    <div class="journal-record"><span>Latest addition</span><strong>${escapeHtml(
      latest?.street_names?.[0] || "No addition in this range"
    )}</strong><small>${escapeHtml(formatDate(latest?.occurred_at))}</small></div>`;
}

async function loadContributions({ append = false } = {}) {
  const params = new URLSearchParams({
    range: state.range,
    source: state.source,
    limit: "20",
  });
  if (append && state.nextCursor) {
    params.set("cursor", state.nextCursor);
  }
  const response = await featureApi.get(
    `/api/coverage/areas/${encodeURIComponent(state.areaId)}/journal/contributions?${params}`,
    { cache: false }
  );
  state.contributions = append
    ? [...state.contributions, ...(response.contributions || [])]
    : response.contributions || [];
  state.nextCursor = response.next_cursor || null;
  renderContributions();
}

function contributionTitle(item) {
  if (item.action === "mark_undriven") {
    return "Returned streets to the frontier";
  }
  if (item.action === "mark_undriveable") {
    return "Marked streets undriveable";
  }
  if (item.source === "manual") {
    return "Manual map adjustment";
  }
  if (item.source === "unattributed") {
    return "Earlier coverage record";
  }
  return "Coverage drive";
}

function renderContributions() {
  const list = $("journal-contributions");
  if (!state.contributions.length) {
    list.innerHTML = `<li class="journal-contribution"><div class="journal-contribution-copy"><h3>No field notes in this view</h3><p>Try another date range or source.</p></div></li>`;
  } else {
    list.innerHTML = state.contributions
      .map((item) => {
        const streets = item.street_names?.length
          ? item.street_names.join(", ")
          : "Unnamed roads";
        const tripLink = item.trip_id
          ? `<a class="journal-contribution-link" href="/trips/${encodeURIComponent(
              item.trip_id
            )}">Open trip <i class="fas fa-arrow-right" aria-hidden="true"></i></a>`
          : `<span class="journal-contribution-link">${escapeHtml(item.source || "manual")}</span>`;
        return `<li class="journal-contribution">
          <div class="journal-contribution-date"><time datetime="${escapeHtml(
            dateOnly(item.occurred_at)
          )}">${escapeHtml(formatDate(item.occurred_at, { short: true }))}</time><span>${escapeHtml(
            item.source || "unknown"
          )}</span></div>
          <div class="journal-contribution-copy"><h3>${escapeHtml(
            contributionTitle(item)
          )}</h3><p>${escapeHtml(streets)}</p>${tripLink}</div>
          <div class="journal-contribution-metric"><strong>${formatMiles(
            item.new_miles,
            2
          )}</strong><span>${formatNumber(item.new_segments)} new segments</span></div>
          <div class="journal-contribution-metric"><strong>${formatNumber(
            item.coverage_before,
            1
          )}% → ${formatNumber(item.coverage_after, 1)}%</strong><span>coverage</span></div>
        </li>`;
      })
      .join("");
  }
  $("journal-load-more").hidden = !state.nextCursor;
}

function currentRankings() {
  return state.level === "segment"
    ? state.metadata?.segment_rankings || []
    : state.metadata?.street_rankings || [];
}

function renderRankings() {
  const rankings = currentRankings();
  const list = $("journal-rankings");
  if (!rankings.length) {
    list.innerHTML = `<li class="journal-ranking-row"><div class="journal-ranking-name"><strong>No completed trip activity in this range</strong><small>Manual coverage never enters this ranking.</small></div></li>`;
    return;
  }
  list.innerHTML = rankings
    .map((row, index) => {
      const ids = state.level === "street" ? row.segment_ids || [] : [row.segment_id];
      return `<li class="journal-ranking-row" data-ranking-index="${index}">
        <button type="button" data-segment-ids="${escapeHtml(ids.join(","))}" data-ranking-label="${escapeHtml(
          row.street_name || "Unnamed road"
        )}">
          <span class="journal-ranking-position">${String(index + 1).padStart(2, "0")}</span>
          <span class="journal-ranking-name"><strong>${escapeHtml(
            row.street_name || "Unnamed road"
          )}</strong><small>${formatMiles(row.length_miles, 2)}</small></span>
          <span class="journal-ranking-metric"><strong>${formatNumber(
            row.trip_count
          )}</strong><span>in ${RANGE_LABELS[state.range].toLowerCase()}</span></span>
          <span class="journal-ranking-metric"><strong>${escapeHtml(
            formatDate(row.first_driven_at, { short: true })
          )}</strong><span>first drive</span></span>
          <span class="journal-ranking-metric"><strong>${escapeHtml(
            formatDate(row.last_driven_at, { short: true })
          )}</strong><span>last drive</span></span>
        </button>
      </li>`;
    })
    .join("");
  list.querySelectorAll("button[data-segment-ids]").forEach((button) => {
    listen(button, "click", () => {
      list
        .querySelectorAll(".journal-ranking-row")
        .forEach((row) => row.classList.remove("is-active"));
      button.closest(".journal-ranking-row")?.classList.add("is-active");
      highlightSegments(
        button.dataset.segmentIds.split(",").filter(Boolean),
        button.dataset.rankingLabel
      );
    });
  });
}

function titleCase(value) {
  return String(value || "unclassified")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderFrontier() {
  const classes = state.metadata?.road_classes || [];
  $("journal-road-classes").innerHTML = classes
    .map(
      (row) => `<div class="journal-road-class">
        <div class="journal-road-class-head"><strong>${escapeHtml(
          titleCase(row.road_class)
        )}</strong><span>${formatNumber(row.coverage_percentage, 1)}% · ${formatMiles(
          row.remaining_miles,
          1
        )} left</span></div>
        <div class="journal-road-class-track"><div class="journal-road-class-fill" style="width:${Math.max(
          0,
          Math.min(100, Number(row.coverage_percentage || 0))
        )}%"></div></div>
      </div>`
    )
    .join("");
  const frontier = state.metadata?.frontier || [];
  $("journal-frontier-list").innerHTML = frontier.length
    ? frontier
        .map(
          (row) =>
            `<li class="journal-frontier-row"><button type="button" data-frontier-ids="${escapeHtml(
              (row.segment_ids || []).join(",")
            )}"><span><strong>${escapeHtml(row.street_name)}</strong><small>${formatNumber(
              row.segments
            )} remaining segments</small></span><span class="journal-frontier-miles">${formatMiles(
              row.length_miles,
              2
            )}</span></button></li>`
        )
        .join("")
    : `<li class="journal-frontier-row"><span><strong>Frontier complete</strong><small>Every driveable street in the current inventory is covered.</small></span></li>`;
  document.querySelectorAll("[data-frontier-ids]").forEach((button) => {
    listen(button, "click", () => {
      setFrontierMap(button.dataset.frontierIds.split(",").filter(Boolean));
      $("journal-map-folio")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderMethodology() {
  $("journal-methodology").textContent = state.metadata?.methodology || "";
  $("journal-as-of").textContent = `Journal revision ${formatNumber(
    state.metadata?.revision
  )} · built ${formatDate(state.metadata?.built_at)} · viewed ${formatDate(
    state.metadata?.as_of
  )}.`;
}

function renderAll() {
  setActiveControls();
  renderSummary();
  renderMilestones();
  renderPaceChart();
  renderRecords();
  renderRankings();
  renderFrontier();
  renderMethodology();
}

async function reloadRange() {
  setStateMessage(`Loading ${RANGE_LABELS[state.range].toLowerCase()}…`);
  state.asOf = "";
  await loadMetadata();
  await loadSegments();
  state.contributions = [];
  state.nextCursor = null;
  await loadContributions();
  renderAll();
  setFrequencyMap();
  setStateMessage("", "ready");
  syncUrl();
}

function setupListeners() {
  listen($("journal-area-select"), "change", (event) => {
    if (!event.target.value || event.target.value === state.areaId) {
      return;
    }
    window.location.assign(
      `/coverage-management/${encodeURIComponent(event.target.value)}/journal`
    );
  });
  document.querySelectorAll("[data-journal-range]").forEach((button) => {
    listen(button, "click", async () => {
      const next = button.dataset.journalRange;
      if (next === state.range) {
        return;
      }
      state.range = next;
      setActiveControls();
      try {
        await reloadRange();
      } catch (error) {
        console.error("Coverage Journal range failed", error);
        setStateMessage(error.message || "Could not load this range.", "error");
      }
    });
  });
  document.querySelectorAll("[data-journal-source]").forEach((button) => {
    listen(button, "click", async () => {
      state.source = button.dataset.journalSource;
      setActiveControls();
      await loadContributions();
      syncUrl();
    });
  });
  document.querySelectorAll("[data-journal-level]").forEach((button) => {
    listen(button, "click", () => {
      state.level = button.dataset.journalLevel;
      setActiveControls();
      renderRankings();
      setFrequencyMap();
      syncUrl();
    });
  });
  listen($("journal-timeline-cursor"), "input", (event) => {
    updateTimelineCursor(Number(event.target.value));
  });
  listen($("journal-load-more"), "click", () => loadContributions({ append: true }));
  listen($("journal-map-reset"), "click", fitArea);
  listen($("known-by-heart"), "mouseenter", setFrequencyMap, { once: true });
  listen($("frontier"), "mouseenter", () => setFrontierMap(), { once: true });
  listen(window, "popstate", () => window.location.reload());
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) {
          return;
        }
        if (visible.target.id === "known-by-heart") {
          setFrequencyMap();
        } else if (visible.target.id === "frontier") {
          setFrontierMap();
        } else if (visible.target.id === "pace") {
          updateTimelineCursor(Number($("journal-timeline-cursor")?.value || 0), {
            updateUrl: false,
          });
        }
      },
      { threshold: [0.35, 0.55] }
    );
    [$("pace"), $("known-by-heart"), $("frontier")]
      .filter(Boolean)
      .forEach((section) => observer.observe(section));
    state.listeners.push(() => observer.disconnect());
  }
}

export default async function initCoverageJournalPage({ signal, cleanup, api } = {}) {
  state = initialState();
  featureApi = api;
  if (!state.areaId || !featureApi) {
    return;
  }
  setupListeners();
  setActiveControls();
  try {
    const areasPromise = loadAreas();
    await loadMetadata();
    await areasPromise;
    await loadSegments();
    await loadContributions();
    renderAll();
    setStateMessage("", "ready");
    await initMap();
    syncUrl();
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    console.error("Coverage Journal failed", error);
    setStateMessage(error.message || "The Journal could not be opened.", "error");
  }

  cleanup?.(() => {
    for (const remove of state.listeners.splice(0)) {
      remove();
    }
    if (state.map) {
      state.map.remove();
      state.map = null;
    }
  });
}
