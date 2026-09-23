/**
 * Coverage journal page: one area's history on a single page. The report
 * runs down the left; a map beside it follows whatever is selected or in
 * view (the date on the chart, a milestone, a drive, a street, what's left).
 */

import { updateUrlHistory } from "../../core/url-history.js";
import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { navigate } from "../../core/navigation.js";
import { createMap, isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";
import { escapeHtml } from "../../utils.js";
import { shortAreaName, splitAreaName } from "../coverage-management/area-name.js";
import { buildChartModel, nearestIndex, placeCursor, renderChart } from "./chart.js";
import { journalDateKey } from "./date-boundaries.js";
import {
  describeOutlook,
  describeRequirement,
  formatDate,
  formatMiles,
  formatNumber,
  formatPercent,
  paceRows,
  plural,
  roadClassLabel,
} from "./format.js";
import { boundsOf, createJournalMap, prepareFeatures } from "./map.js";
import { mergeStreetFeatures } from "./map-features.js";
import { completeJournalRequests } from "./requests.js";

const VALID_RANGES = new Set(["all", "365d", "90d"]);
const VALID_SOURCES = new Set(["all", "trip", "manual"]);
const VALID_LEVELS = new Set(["street", "segment"]);
const RANGE_NAMES = { all: "All time", "365d": "Last 12 months", "90d": "Last 90 days" };
const UNIT_NAMES = { day: "day", week: "week", month: "month" };
// Areas up to this size load every street at once (see the streets API).
const WHOLE_AREA_LIMIT = 30000;
const PENDING_RETRY_MS = 4000;
const PENDING_RETRY_LIMIT = 45;

const $ = (id) => document.getElementById(id);

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function todayKey() {
  return journalDateKey(new Date().toISOString(), timezone());
}

/** The last millisecond of a local calendar day. */
function endOfDay(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day + 1).getTime() - 1;
}

function initialState() {
  const params = new URLSearchParams(window.location.search);
  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return {
    areaId: $("coverage-journal")?.dataset.areaId || "",
    range: VALID_RANGES.has(params.get("range")) ? params.get("range") : "all",
    source: VALID_SOURCES.has(params.get("source")) ? params.get("source") : "all",
    level: VALID_LEVELS.has(params.get("level")) ? params.get("level") : "street",
    asOf: params.get("as_of") || "",
    milestone: hash.startsWith("milestone-") ? hash.slice(10) : "",
    metadata: null,
    intelligence: null,
    missions: [],
    contributions: [],
    nextCursor: null,
    map: null,
    journalMap: null,
    geojson: null,
    wholeArea: true,
    chart: null,
    cursorIndex: -1,
    selection: null,
    rankIds: [],
    rankNames: [],
    frontierIds: [],
    activeSection: "progress",
    listeners: [],
    timers: [],
    metadataRequest: 0,
    notesRequest: 0,
    segmentsRequest: 0,
    rangeAbort: null,
    notesAbort: null,
    segmentsAbort: null,
  };
}

let state = initialState();
let featureApi = null;

function listen(target, type, handler, options) {
  if (!target) {
    return;
  }
  target.addEventListener(type, handler, options);
  state.listeners.push(() => target.removeEventListener(type, handler, options));
}

function areaPath(suffix = "") {
  return `/api/coverage/areas/${encodeURIComponent(state.areaId)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function setStateMessage(message, type = "loading") {
  const element = $("journal-state");
  if (!element) {
    return;
  }
  $("journal-state-text").textContent = message;
  element.classList.toggle("is-error", type === "error");
  element.classList.toggle("is-waiting", type === "waiting");
  element.hidden = type === "ready";
  $("journal-retry").hidden = type !== "error";
  $("journal-content").hidden = type !== "ready";
  $("coverage-journal").setAttribute("aria-busy", type === "loading" ? "true" : "false");
}

async function loadAreas() {
  const response = await featureApi.get("/api/coverage/areas", { cache: false });
  const areas = (Array.isArray(response?.areas) ? response.areas : []).filter(
    (area) => String(area.status || "").toLowerCase() === "ready"
  );
  const select = $("journal-area-select");
  if (!select) {
    return;
  }
  select.innerHTML = areas
    .sort((a, b) => shortAreaName(a.display_name).localeCompare(shortAreaName(b.display_name)))
    .map(
      (area) =>
        `<option value="${escapeHtml(String(area.id))}">${escapeHtml(
          shortAreaName(area.display_name)
        )} · ${formatPercent(area.coverage_percentage, {
          complete: area.is_complete,
        })}</option>`
    )
    .join("");
  select.value = state.areaId;
}

async function loadMetadata(signal = null) {
  const request = ++state.metadataRequest;
  const range = state.range;
  const params = new URLSearchParams({ range, timezone: timezone() });
  const data = await featureApi.get(areaPath(`/journal?${params}`), {
    cache: false,
    signal,
  });
  if (request === state.metadataRequest && range === state.range) {
    state.metadata = data;
  }
}

async function loadIntelligence() {
  const params = new URLSearchParams({ timezone: timezone() });
  const [intelligence, missions] = await Promise.all([
    featureApi.get(areaPath(`/intelligence?${params}`), { cache: false }),
    featureApi.get(areaPath("/missions?limit=12"), { cache: false }),
  ]);
  state.intelligence = intelligence || null;
  state.missions = Array.isArray(missions?.missions) ? missions.missions : [];
}

async function loadContributions({ append = false, signal = null } = {}) {
  const request = ++state.notesRequest;
  state.notesAbort?.abort();
  state.notesAbort = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, state.notesAbort.signal])
    : state.notesAbort.signal;
  const params = new URLSearchParams({
    range: state.range,
    source: state.source,
    timezone: timezone(),
    limit: "15",
  });
  if (append && state.nextCursor) {
    params.set("cursor", state.nextCursor);
  }
  const response = await featureApi.get(areaPath(`/journal/contributions?${params}`), {
    cache: false,
    signal: combined,
  });
  if (request !== state.notesRequest) {
    return;
  }
  state.contributions = append
    ? [...state.contributions, ...(response.contributions || [])]
    : response.contributions || [];
  state.nextCursor = response.next_cursor || null;
  renderDrives();
}

async function loadSegments({ signal = null, retry = true } = {}) {
  if (!state.journalMap) {
    return;
  }
  const request = ++state.segmentsRequest;
  state.segmentsAbort?.abort();
  state.segmentsAbort = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, state.segmentsAbort.signal])
    : state.segmentsAbort.signal;
  const params = new URLSearchParams({ range: state.range, timezone: timezone() });
  if (!state.wholeArea) {
    const bounds = state.map.getBounds();
    params.set("min_lon", bounds.getWest().toFixed(6));
    params.set("min_lat", bounds.getSouth().toFixed(6));
    params.set("max_lon", bounds.getEast().toFixed(6));
    params.set("max_lat", bounds.getNorth().toFixed(6));
  }
  let data;
  try {
    data = await featureApi.get(areaPath(`/journal/segments?${params}`), {
      cache: false,
      signal: combined,
    });
  } catch (error) {
    if (error.status === 409 && retry && !combined.aborted) {
      await loadMetadata(signal);
      return loadSegments({ signal, retry: false });
    }
    throw error;
  }
  if (request !== state.segmentsRequest) {
    return;
  }
  prepareFeatures(data);
  const keep =
    !state.wholeArea && state.geojson?.revision === data.revision
      ? (state.geojson.features || []).filter((feature) =>
          state.selection?.ids?.includes(feature.properties.segment_id)
        )
      : [];
  state.geojson = { ...data, features: mergeStreetFeatures(keep, data.features) };
  state.journalMap.install(state.geojson);
  $("journal-map-status").textContent = data.truncated
    ? "Zoom in to see every street here."
    : "";
}

async function loadSelectionSegments(ids) {
  if (state.wholeArea || !ids.length) {
    return;
  }
  const present = new Set(
    (state.geojson?.features || []).map((feature) => feature.properties.segment_id)
  );
  const missing = ids.filter((id) => !present.has(id));
  for (let start = 0; start < missing.length; start += 300) {
    const params = new URLSearchParams({ range: state.range, timezone: timezone() });
    missing.slice(start, start + 300).forEach((id) => params.append("ids", id));
    const data = prepareFeatures(
      await featureApi.get(areaPath(`/journal/segments?${params}`), { cache: false })
    );
    state.geojson = {
      ...data,
      features: mergeStreetFeatures(state.geojson?.features || [], data.features),
    };
  }
  state.journalMap.install(state.geojson);
}

// ---------------------------------------------------------------------------
// Header and figures
// ---------------------------------------------------------------------------

function renderHeader() {
  const { area, summary } = state.metadata;
  const { name, region } = splitAreaName(area.display_name);
  $("journal-title").textContent = name;
  $("journal-subtitle").textContent = region;
  document.title = `${name} · Coverage journal`;
  const id = encodeURIComponent(state.areaId);
  $("journal-map-link").href = `/coverage-management?area=${id}`;
  $("journal-route-link").href = `/coverage-route-planner?area=${id}`;
  $("journal-plan-link").href = `/coverage-route-planner?area=${id}`;
  $("journal-sculpture-link").href = `/memory-city?area=${id}`;

  const complete = area.is_complete === true;
  $("journal-stat-coverage").textContent = formatPercent(area.coverage_percentage, {
    complete,
  });
  $("journal-stat-survey").style.width = `${Math.max(
    0,
    Math.min(100, Number(area.coverage_percentage) || 0)
  )}%`;
  $("journal-stat-miles").textContent = formatNumber(area.driven_length_miles, 1);
  $("journal-stat-miles-total").textContent = `of ${formatMiles(
    area.driveable_length_miles,
    1
  )}`;
  $("journal-stat-left").textContent = formatNumber(area.remaining_length_miles, 1);
  $("journal-stat-left-segments").textContent = complete
    ? "Every street driven"
    : `${plural(area.remaining_segments, "segment")} left`;
  $("journal-stat-trips").textContent = formatNumber(summary.historical_trip_count);
  $("journal-stat-days").textContent = summary.first_covered_at
    ? `Since ${formatDate(summary.first_covered_at, "monthShort")}`
    : "No drives yet";
  $("journal-stat-latest").textContent = summary.last_new_street_at
    ? formatDate(summary.last_new_street_at, "short")
    : "—";
  $("journal-stat-latest-name").textContent =
    summary.last_new_street_names?.[0] || (summary.last_new_street_at ? "Unnamed road" : "");
}

// ---------------------------------------------------------------------------
// Progress: chart, date cursor, milestones, records
// ---------------------------------------------------------------------------

function milestoneMarks() {
  const tz = state.metadata?.timezone;
  return (state.metadata?.milestones || []).map((item) => ({
    key: item.key,
    label: item.label,
    date: journalDateKey(item.reached_at, tz),
    level: Number(item.coverage || 0),
    short: item.key === "first" ? "" : `${Math.round(item.threshold)}%`,
  }));
}

function renderChartSection() {
  const svg = $("journal-chart-svg");
  const series = state.metadata?.series || [];
  const area = state.metadata.area;
  const model = buildChartModel({
    series,
    range: state.range,
    today: todayKey(),
    driveableMiles: Number(area.driveable_length_miles || 0),
    currentLevel: Number(area.coverage_percentage || 0),
  });
  const scales = renderChart(svg, model, { milestones: milestoneMarks() });
  state.chart = { model, scales };
  const cursor = $("journal-timeline-cursor");
  cursor.disabled = !series.length;
  cursor.max = String(Math.max(0, series.length - 1));
  const requested = state.asOf
    ? series.findLastIndex((point) => point.date <= state.asOf)
    : series.length - 1;
  state.cursorIndex = series.length ? Math.max(0, requested) : -1;
  cursor.value = String(Math.max(0, state.cursorIndex));
  placeCursor(svg, model, scales, state.cursorIndex);
  $("journal-chart-caption").textContent = series.length
    ? `Line: share of streets driven. Bars: new miles each ${UNIT_NAMES[model.unit]}.`
    : `No new streets in ${RANGE_NAMES[state.range].toLowerCase()}.`;
  showReadout(state.cursorIndex);
  renderSeriesTable(series);
}

function showReadout(index) {
  const series = state.metadata?.series || [];
  const point = series[index];
  const area = state.metadata.area;
  if (!point) {
    $("journal-readout-date").textContent = "Today";
    $("journal-readout-value").textContent = `${formatPercent(area.coverage_percentage, {
      complete: area.is_complete,
    })} driven`;
    return;
  }
  const isLast = index === series.length - 1;
  $("journal-readout-date").textContent = formatDate(point.date, "long");
  const complete = isLast && area.is_complete;
  $("journal-readout-value").textContent = `${formatPercent(point.coverage_percentage, {
    complete,
  })} driven · ${formatMiles(point.new_miles, 2)} new that day`;
}

function selectDate(index, { updateUrl = true, updateMap = true } = {}) {
  const series = state.metadata?.series || [];
  const point = series[index];
  if (!point) {
    return;
  }
  state.cursorIndex = index;
  state.asOf = index === series.length - 1 ? "" : point.date;
  state.milestone = "";
  state.selection = null;
  $("journal-timeline-cursor").value = String(index);
  placeCursor($("journal-chart-svg"), state.chart.model, state.chart.scales, index);
  showReadout(index);
  markActiveMilestone();
  if (updateMap) {
    showDateOnMap();
  }
  if (updateUrl) {
    syncUrl();
  }
}

function showDateOnMap() {
  const series = state.metadata?.series || [];
  const point = series[state.cursorIndex];
  const latest = !point || state.cursorIndex === series.length - 1;
  state.journalMap?.showProgress(latest ? null : endOfDay(point.date));
  setMapCaption("Streets driven by", latest ? "today" : formatDate(point.date, "long"), [
    ["driven", "Driven"],
    ["undriven", "Not driven yet"],
  ]);
}

function milestoneChapters() {
  return state.metadata?.milestones || [];
}

function renderMilestones() {
  const list = $("journal-milestones");
  const chapters = milestoneChapters();
  if (!chapters.length) {
    list.innerHTML = `<li class="journal-empty">Milestones start with the first street you drive here.</li>`;
    return;
  }
  list.innerHTML = chapters
    .map((chapter) => {
      const names = (chapter.street_names || []).slice(0, 3);
      const mark = chapter.key === "first" ? "1st" : `${Math.round(chapter.threshold)}%`;
      return `<li>
        <button type="button" class="journal-milestone" data-milestone="${escapeHtml(chapter.key)}">
          <span class="journal-milestone-mark">${escapeHtml(mark)}</span>
          <span class="journal-milestone-body">
            <strong>${escapeHtml(chapter.label)}</strong>
            <span>${escapeHtml(names.length ? names.join(", ") : "Unnamed roads")}</span>
          </span>
          <time datetime="${escapeHtml(journalDateKey(chapter.reached_at, state.metadata.timezone))}">${escapeHtml(
            formatDate(chapter.reached_at, "short")
          )}</time>
        </button>
      </li>`;
    })
    .join("");
  markActiveMilestone();
}

function markActiveMilestone() {
  document.querySelectorAll("[data-milestone]").forEach((element) => {
    const active = element.dataset.milestone === state.milestone;
    element.classList.toggle("is-active", active);
    if (element.tagName === "BUTTON") {
      element.setAttribute("aria-pressed", String(active));
    }
  });
}

function selectMilestone(key, { updateUrl = true } = {}) {
  const chapters = milestoneChapters();
  const index = chapters.findIndex((item) => item.key === key);
  const chapter = chapters[index];
  if (!chapter) {
    return;
  }
  const previous = index > 0 ? chapters[index - 1] : null;
  state.milestone = key;
  state.selection = null;
  const series = state.metadata?.series || [];
  const dateKey = journalDateKey(chapter.reached_at, state.metadata.timezone);
  const seriesIndex = series.findIndex((point) => point.date === dateKey);
  if (seriesIndex >= 0) {
    state.cursorIndex = seriesIndex;
    $("journal-timeline-cursor").value = String(seriesIndex);
    placeCursor($("journal-chart-svg"), state.chart.model, state.chart.scales, seriesIndex);
    showReadout(seriesIndex);
  }
  markActiveMilestone();
  state.journalMap?.showProgress(
    Date.parse(chapter.reached_at),
    previous ? Date.parse(previous.reached_at) : null
  );
  setMapCaption(
    previous ? `Added between ${formatDate(previous.reached_at, "short")} and` : "Driven by",
    `${formatDate(chapter.reached_at, "long")} (${chapter.label.toLowerCase()})`,
    previous
      ? [
          ["driven", `Driven by ${previous.label.toLowerCase()}`],
          ["highlight", "Added in this stretch"],
          ["undriven", "Not driven yet"],
        ]
      : [
          ["driven", "Driven"],
          ["undriven", "Not driven yet"],
        ]
  );
  if (updateUrl) {
    syncUrl();
  }
}

function renderRecords() {
  const series = state.metadata?.series || [];
  const records = state.metadata?.records || {};
  const best = series.reduce(
    (top, point) => (Number(point.new_miles) > Number(top?.new_miles ?? -1) ? point : top),
    null
  );
  const biggest = records.biggest_push;
  const items = [
    [
      "Best day",
      best ? formatMiles(best.new_miles, 1) : "—",
      best ? formatDate(best.date, "short") : "",
    ],
    [
      "Biggest drive",
      biggest ? formatMiles(biggest.new_miles, 1) : "—",
      biggest ? formatDate(biggest.occurred_at, "short") : "",
    ],
    ["Days with new streets", formatNumber(series.length), RANGE_NAMES[state.range]],
    [
      "Longest gap",
      series.length > 1 ? plural(Math.round(records.longest_pause_days || 0), "day") : "—",
      "between new streets",
    ],
  ];
  $("journal-records").innerHTML = items
    .map(
      ([label, value, note]) => `<div>
        <dt>${escapeHtml(label)}</dt>
        <dd><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></dd>
      </div>`
    )
    .join("");
}

function renderSeriesTable(series) {
  $("journal-series-table").innerHTML = series.length
    ? [...series]
        .reverse()
        .map(
          (point) =>
            `<tr><td>${escapeHtml(formatDate(point.date, "short"))}</td><td>${escapeHtml(
              formatMiles(point.new_miles, 2)
            )}</td><td>${escapeHtml(formatPercent(point.coverage_percentage))}</td><td>${formatNumber(
              point.contributions
            )}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4">No new streets in this range.</td></tr>`;
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
  mark_driven: "Marked driven",
  mark_undriven: "Marked not driven",
  mark_undriveable: "Marked undriveable",
  mark_automatic: "Returned to drive history",
};

function renderDrives() {
  const list = $("journal-contributions");
  if (!state.contributions.length) {
    list.innerHTML = `<li class="journal-empty">${
      state.source === "manual"
        ? "No corrections in this range."
        : `No new streets in ${RANGE_NAMES[state.range].toLowerCase()}.`
    }</li>`;
    $("journal-load-more").hidden = true;
    return;
  }
  list.innerHTML = state.contributions
    .map((item, index) => {
      const names = [...new Set((item.street_names || []).filter(Boolean))];
      const shown = names.slice(0, 3).join(", ") || "Unnamed roads";
      const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
      const manual = item.source === "manual";
      const label = manual ? ACTION_LABELS[item.action] || "Correction" : "";
      const ids = item.new_segment_ids || item.segment_ids || [];
      const gain = Number(item.new_miles || 0);
      const trip = item.trip_id
        ? `<a class="journal-drive-trip" href="/trips/${encodeURIComponent(item.trip_id)}" aria-label="Open this trip">Trip<i class="fas fa-arrow-right" aria-hidden="true"></i></a>`
        : `<span class="journal-drive-trip" aria-hidden="true"></span>`;
      return `<li class="journal-drive${manual ? " is-manual" : ""}" data-drive="${index}">
        <button type="button" class="journal-drive-main" data-drive-index="${index}" ${
          ids.length ? "" : "disabled"
        } aria-label="Show the streets from ${escapeHtml(formatDate(item.occurred_at, "long"))} on the map">
          <time datetime="${escapeHtml(journalDateKey(item.occurred_at, state.metadata?.timezone))}">${escapeHtml(
            formatDate(item.occurred_at, "short")
          )}</time>
          <span class="journal-drive-streets">${
            label ? `<em>${escapeHtml(label)}</em> ` : ""
          }${escapeHtml(shown)}${escapeHtml(more)}</span>
          <span class="journal-drive-gain">${gain > 0 ? `+${escapeHtml(formatMiles(gain, 2))}` : ""}</span>
          <span class="journal-drive-level">${escapeHtml(
            formatPercent(item.coverage_after, {
              complete: Number(item.coverage_after) >= 100,
            })
          )}</span>
        </button>
        ${trip}
      </li>`;
    })
    .join("");
  $("journal-load-more").hidden = !state.nextCursor;
  markActiveSelection();
}

async function selectDrive(index) {
  const item = state.contributions[index];
  const ids = item?.new_segment_ids || item?.segment_ids || [];
  if (!ids.length) {
    return;
  }
  await showSelection(ids, {
    key: `drive-${index}`,
    mode: "Streets from the drive on",
    caption: formatDate(item.occurred_at, "long"),
  });
}

// ---------------------------------------------------------------------------
// Most-driven streets
// ---------------------------------------------------------------------------

function renderRankings() {
  const rows =
    state.level === "segment"
      ? state.metadata?.segment_rankings || []
      : state.metadata?.street_rankings || [];
  const list = $("journal-rankings");
  $("journal-streets-note").textContent =
    state.range === "all"
      ? "Ranked by number of trips."
      : `Ranked by number of trips in ${RANGE_NAMES[state.range].toLowerCase()}.`;
  if (!rows.length) {
    list.innerHTML = `<li class="journal-empty">No trips in this range.</li>`;
    return;
  }
  const top = Math.max(1, ...rows.map((row) => Number(row.trip_count || 0)));
  list.innerHTML = rows
    .map((row, index) => {
      const name = row.street_name || "Unnamed road";
      const length =
        state.level === "street"
          ? `${formatMiles(row.length_miles, 1)} driven`
          : formatMiles(row.length_miles, 2);
      const since = formatDate(row.first_driven_at, "monthShort");
      const last = formatDate(row.last_driven_at, "monthShort");
      return `<li>
        <button type="button" class="journal-rank" data-rank-index="${index}" data-selection-key="rank-${index}">
          <span class="journal-rank-position">${index + 1}</span>
          <span class="journal-rank-name"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(
            length
          )}</small></span>
          <span class="journal-rank-trips">
            <span class="journal-rank-bar" style="--share: ${(
              (Number(row.trip_count || 0) / top) *
              100
            ).toFixed(1)}%"></span>
            <strong>${formatNumber(row.trip_count)}</strong>
            <small>${Number(row.trip_count) === 1 ? "trip" : "trips"}</small>
          </span>
          <span class="journal-rank-dates">${escapeHtml(since === last ? since : `${since} – ${last}`)}</span>
        </button>
      </li>`;
    })
    .join("");
  state.rankIds = rows.map((row) =>
    state.level === "street" ? row.segment_ids || [] : [row.segment_id]
  );
  state.rankNames = rows.map((row) => row.street_name || "Unnamed road");
  markActiveSelection();
}

// ---------------------------------------------------------------------------
// Left to drive
// ---------------------------------------------------------------------------

function renderLeft() {
  const classes = (state.metadata?.road_classes || [])
    .filter((row) => Number(row.total_miles) - Number(row.undriveable_miles || 0) > 0)
    .sort((a, b) => Number(b.remaining_miles) - Number(a.remaining_miles));
  $("journal-road-classes").innerHTML = classes
    .map((row) => {
      const done = Number(row.remaining_miles) <= 0;
      const percent = Math.max(0, Math.min(100, Number(row.coverage_percentage) || 0));
      return `<li class="journal-road-class">
        <span class="journal-road-class-name">${escapeHtml(roadClassLabel(row.road_class))}</span>
        <span class="journal-road-class-figures">${escapeHtml(
          formatPercent(row.coverage_percentage, { complete: done })
        )}<small>${done ? "done" : `${escapeHtml(formatMiles(row.remaining_miles, 1))} left`}</small></span>
        <span class="survey-bar journal-road-class-bar" aria-hidden="true"><span class="survey-fill" style="width: ${percent.toFixed(
          1
        )}%"></span></span>
      </li>`;
    })
    .join("");
  const frontier = state.metadata?.frontier || [];
  state.frontierIds = frontier.map((row) => row.segment_ids || []);
  $("journal-frontier-list").innerHTML = frontier.length
    ? frontier
        .map(
          (row, index) => `<li>
            <button type="button" class="journal-frontier-row" data-frontier-index="${index}" data-selection-key="left-${index}">
              <span><strong>${escapeHtml(row.street_name)}</strong><small>${escapeHtml(
                plural(row.segments, "segment")
              )}</small></span>
              <span class="journal-frontier-miles">${escapeHtml(formatMiles(row.length_miles, 2))}</span>
            </button>
          </li>`
        )
        .join("")
    : `<li class="journal-empty">Every named street here is driven.</li>`;
  markActiveSelection();
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

function renderGoal() {
  const intelligence = state.intelligence;
  if (!intelligence) {
    $("journal-forecast").innerHTML = "<p>The outlook is unavailable.</p>";
    return;
  }
  const goal = intelligence.goal || null;
  const forecast = intelligence.forecast || {};
  const target = Number(goal?.target_percentage ?? 100);
  $("journal-goal-percentage").value = String(target);
  $("journal-goal-date").value = goal?.target_date ? goal.target_date.slice(0, 10) : "";
  $("journal-goal-minutes").value = String(goal?.preferred_mission_minutes ?? 90);
  const outlook = describeOutlook(forecast, { targetPercentage: target });
  const rows = paceRows(forecast, Number(intelligence.area?.remaining_miles || 0), todayKey());
  const requirement = describeRequirement(forecast, goal);
  $("journal-forecast").innerHTML = `
    <p class="journal-outlook-lead">${escapeHtml(outlook.lead)}</p>
    ${outlook.detail ? `<p class="journal-outlook-detail">${escapeHtml(outlook.detail)}</p>` : ""}
    ${
      rows.length
        ? `<table class="table table-sm journal-pace">
            <thead><tr><th scope="col">Pace over</th><th scope="col">Per week</th><th scope="col">Finish</th></tr></thead>
            <tbody>${rows
              .map(
                (row) =>
                  `<tr class="${row.window === forecast.window ? "is-primary" : ""}"><th scope="row">${escapeHtml(
                    row.label
                  )}</th><td>${escapeHtml(row.milesPerWeek)}</td><td>${escapeHtml(row.finish)}</td></tr>`
              )
              .join("")}</tbody>
          </table>`
        : ""
    }
    ${requirement ? `<p class="journal-outlook-detail">${escapeHtml(requirement)}</p>` : ""}`;

  $("journal-missions").innerHTML = state.missions.length
    ? state.missions
        .map((mission) => {
          const done = Math.round(Number(mission.completion_ratio || 0) * 100);
          return `<li>
            <strong>${escapeHtml(formatDate(mission.created_at, "short"))}</strong>
            <span>${escapeHtml(formatMiles(mission.target_miles, 1))} planned · ${done}% driven</span>
            <small>${escapeHtml(String(mission.status || "").replaceAll("_", " "))}</small>
          </li>`;
        })
        .join("")
    : `<li class="journal-empty">No missions yet. <a href="/coverage-route-planner?area=${encodeURIComponent(
        state.areaId
      )}">Plan one</a> to drive a batch of streets in one outing.</li>`;
}

function renderNote() {
  $("journal-methodology").textContent = state.metadata?.methodology || "";
  $("journal-as-of").textContent = `Updated ${formatDate(state.metadata?.built_at, "long")}.`;
  $("journal-as-of").title = `Coverage revision ${state.metadata?.revision ?? "—"}`;
}

// ---------------------------------------------------------------------------
// Map views
// ---------------------------------------------------------------------------

function setMapCaption(mode, caption, keys = []) {
  $("journal-map-mode").textContent = mode;
  $("journal-map-caption").textContent = caption;
  $("journal-map-legend").innerHTML = keys
    .map(
      ([ink, label]) =>
        `<span class="journal-key"><i class="journal-swatch journal-swatch--${escapeHtml(
          ink
        )}" aria-hidden="true"></i>${escapeHtml(label)}</span>`
    )
    .join("");
}

function showFrequencyOnMap() {
  state.journalMap?.showFrequency();
  setMapCaption("Trips on each street", RANGE_NAMES[state.range].toLowerCase(), [
    ["thin", "Few trips"],
    ["thick", "Many trips"],
  ]);
}

function showLeftOnMap(ids = []) {
  state.journalMap?.showLeft(ids);
  const area = state.metadata.area;
  setMapCaption("Streets left to drive", formatMiles(area.remaining_length_miles, 1), [
    ["undriven", "Not driven yet"],
    ...(ids.length ? [["highlight", "Selected street"]] : []),
    ["faint", "Driven"],
  ]);
}

async function showSelection(ids, { key, mode, caption, left = false }) {
  state.selection = { key, ids };
  markActiveSelection();
  await loadSelectionSegments(ids);
  if (left) {
    showLeftOnMap(ids);
  } else {
    state.journalMap?.showSelection(ids);
    setMapCaption(mode, caption, [["highlight", "Selected"]]);
  }
  fitSegments(ids);
  revealMap();
}

function markActiveSelection() {
  document.querySelectorAll("[data-selection-key], [data-drive-index]").forEach((element) => {
    const key = element.dataset.selectionKey || `drive-${element.dataset.driveIndex}`;
    element.classList.toggle("is-active", state.selection?.key === key);
  });
}

function showSectionOnMap(section) {
  if (!state.journalMap || !state.metadata) {
    return;
  }
  if (section === "streets") {
    showFrequencyOnMap();
  } else if (section === "left" || section === "goal") {
    showLeftOnMap();
  } else if (state.milestone) {
    selectMilestone(state.milestone, { updateUrl: false });
  } else {
    showDateOnMap();
  }
}

function fitSegments(ids) {
  const bounds = boundsOf(state.geojson, ids);
  if (!bounds || !state.map) {
    return;
  }
  state.map.fitBounds(
    [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ],
    { padding: 70, maxZoom: 16, duration: 450 }
  );
}

function fitArea() {
  const bbox = state.metadata?.area?.bounding_box;
  if (!state.map || !Array.isArray(bbox) || bbox.length < 4) {
    return;
  }
  state.map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 40, duration: 450 }
  );
}

/** On one-column layouts the map sits above the report; bring it into view. */
function revealMap() {
  const panel = $("journal-map-panel");
  if (!panel || getComputedStyle(panel).position === "sticky") {
    return;
  }
  const rect = panel.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
    return;
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  panel.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

async function initMap() {
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  const accessToken = isMapboxStyleUrl(styleUrl)
    ? await waitForMapboxToken({ timeoutMs: 5000 })
    : undefined;
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
    fitBoundsOptions: { padding: 40 },
    attributionControl: false,
  });
  await new Promise((resolve) => state.map.once("load", resolve));
  state.journalMap = createJournalMap(state.map);
  state.wholeArea = Number(state.metadata?.area?.total_segments || 0) <= WHOLE_AREA_LIMIT;
  if (!state.wholeArea) {
    let timer;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadSegments().catch((error) => {
          if (error.name !== "AbortError") {
            $("journal-map-status").textContent = error.message;
          }
        });
      }, 200);
    };
    state.map.on("moveend", reload);
    state.listeners.push(() => clearTimeout(timer));
  }
  await loadSegments();
  showSectionOnMap(state.activeSection);
}

// ---------------------------------------------------------------------------
// Rendering and range changes
// ---------------------------------------------------------------------------

function setActiveControls() {
  for (const [attribute, value] of [
    ["journalRange", state.range],
    ["journalSource", state.source],
    ["journalLevel", state.level],
  ]) {
    const selector = `[data-${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`;
    document.querySelectorAll(selector).forEach((button) => {
      const active = button.dataset[attribute] === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
}

function renderAll() {
  setActiveControls();
  renderHeader();
  renderChartSection();
  renderRecords();
  renderMilestones();
  renderRankings();
  renderLeft();
  renderGoal();
  renderNote();
  if (state.milestone) {
    selectMilestone(state.milestone, { updateUrl: false });
  }
}

function syncUrl() {
  const url = new URL(window.location.href);
  const params = { range: state.range, source: state.source, level: state.level };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (state.asOf) {
    url.searchParams.set("as_of", state.asOf);
  } else {
    url.searchParams.delete("as_of");
  }
  url.hash = state.milestone ? `milestone-${state.milestone}` : "";
  updateUrlHistory(url, { push: false });
}

async function reloadRange() {
  state.rangeAbort?.abort();
  state.rangeAbort = new AbortController();
  const { signal } = state.rangeAbort;
  $("coverage-journal").setAttribute("aria-busy", "true");
  try {
    await loadMetadata(signal);
    state.contributions = [];
    state.nextCursor = null;
    const complete = await completeJournalRequests(
      [loadContributions({ signal }), loadSegments({ signal })],
      signal
    );
    if (!complete) {
      return;
    }
    renderAll();
    showSectionOnMap(state.activeSection);
    syncUrl();
  } finally {
    if (!signal.aborted) {
      $("coverage-journal").setAttribute("aria-busy", "false");
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function setupChartPointer() {
  const svg = $("journal-chart-svg");
  let dragging = false;
  const indexAt = (event) =>
    state.chart ? nearestIndex(state.chart.model, state.chart.scales, event.clientX, svg) : -1;
  listen(svg, "pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    dragging = true;
    svg.setPointerCapture?.(event.pointerId);
    const index = indexAt(event);
    if (index >= 0) {
      selectDate(index, { updateUrl: false });
    }
  });
  listen(svg, "pointermove", (event) => {
    const index = indexAt(event);
    if (index < 0) {
      return;
    }
    if (dragging) {
      selectDate(index, { updateUrl: false });
    } else if (event.pointerType === "mouse") {
      placeCursor(svg, state.chart.model, state.chart.scales, index, "journal-chart-hover");
      showReadout(index);
    }
  });
  const finish = (event) => {
    if (dragging) {
      dragging = false;
      svg.releasePointerCapture?.(event.pointerId);
      syncUrl();
    }
  };
  listen(svg, "pointerup", finish);
  listen(svg, "pointercancel", finish);
  listen(svg, "pointerleave", () => {
    svg.querySelector("#journal-chart-hover")?.setAttribute("visibility", "hidden");
    showReadout(state.cursorIndex);
  });
}

function setupListeners() {
  listen($("coverage-journal"), "click", (event) => {
    const milestone = event.target.closest("button[data-milestone]");
    if (milestone) {
      selectMilestone(milestone.dataset.milestone);
      revealMap();
      return;
    }
    const drive = event.target.closest("[data-drive-index]");
    if (drive) {
      void selectDrive(Number(drive.dataset.driveIndex));
      return;
    }
    const rank = event.target.closest("[data-rank-index]");
    if (rank) {
      const index = Number(rank.dataset.rankIndex);
      void showSelection(state.rankIds?.[index] || [], {
        key: `rank-${index}`,
        mode: "Most-driven",
        caption: state.rankNames?.[index] || "Street",
      });
      return;
    }
    const frontier = event.target.closest("[data-frontier-index]");
    if (frontier) {
      const index = Number(frontier.dataset.frontierIndex);
      void showSelection(state.frontierIds?.[index] || [], {
        key: `left-${index}`,
        left: true,
      });
    }
  });
  listen($("journal-area-select"), "change", (event) => {
    if (event.target.value && event.target.value !== state.areaId) {
      void navigate(`/coverage-management/${encodeURIComponent(event.target.value)}/journal`);
    }
  });
  document.querySelectorAll("[data-journal-range]").forEach((button) => {
    listen(button, "click", async () => {
      if (button.dataset.journalRange === state.range) {
        return;
      }
      state.range = button.dataset.journalRange;
      state.asOf = "";
      setActiveControls();
      try {
        await reloadRange();
      } catch (error) {
        if (error.name !== "AbortError") {
          setStateMessage(error.message || "This range could not be loaded.", "error");
        }
      }
    });
  });
  document.querySelectorAll("[data-journal-source]").forEach((button) => {
    listen(button, "click", async () => {
      state.source = button.dataset.journalSource;
      setActiveControls();
      try {
        await loadContributions();
        syncUrl();
      } catch (error) {
        if (error.name !== "AbortError") {
          $("journal-contributions").innerHTML = `<li class="journal-empty">${escapeHtml(
            error.message
          )}</li>`;
        }
      }
    });
  });
  document.querySelectorAll("[data-journal-level]").forEach((button) => {
    listen(button, "click", () => {
      state.level = button.dataset.journalLevel;
      state.selection = null;
      setActiveControls();
      renderRankings();
      showFrequencyOnMap();
      syncUrl();
    });
  });
  listen($("journal-timeline-cursor"), "input", (event) => {
    selectDate(Number(event.target.value));
  });
  setupChartPointer();
  listen($("journal-load-more"), "click", () =>
    loadContributions({ append: true }).catch((error) => {
      if (error.name !== "AbortError") {
        $("journal-load-more").textContent = error.message;
      }
    })
  );
  listen($("journal-map-reset"), "click", fitArea);
  listen($("journal-retry"), "click", () => {
    void start();
  });
  listen($("journal-goal-form"), "submit", async (event) => {
    event.preventDefault();
    const status = $("journal-goal-status");
    status.textContent = "Saving…";
    try {
      await featureApi.rawJson(areaPath("/goal"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_percentage: Number($("journal-goal-percentage").value),
          target_date: $("journal-goal-date").value || null,
          preferred_mission_minutes: Number($("journal-goal-minutes").value),
        }),
        retry: false,
      });
      await loadIntelligence();
      renderGoal();
      status.textContent = "Saved.";
    } catch (error) {
      status.textContent = error.message || "The goal could not be saved.";
    }
  });
  listen(document, "themeChanged", () => state.journalMap?.paint());

  const chart = $("journal-chart");
  if (chart && "ResizeObserver" in window) {
    let width = chart.clientWidth;
    const observer = new ResizeObserver(() => {
      if (state.metadata && Math.abs(chart.clientWidth - width) > 1) {
        width = chart.clientWidth;
        renderChartSection();
      }
    });
    observer.observe(chart);
    state.listeners.push(() => observer.disconnect());
  }

  if ("IntersectionObserver" in window) {
    const sections = ["progress", "drives", "streets", "left", "goal"]
      .map((id) => $(id))
      .filter(Boolean);
    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        const [top] = [...visible.entries()].sort((a, b) => b[1] - a[1]);
        if (!top || top[1] <= 0 || top[0] === state.activeSection) {
          return;
        }
        state.activeSection = top[0];
        state.selection = null;
        markActiveSelection();
        showSectionOnMap(top[0]);
      },
      { rootMargin: "-20% 0px -45% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    sections.forEach((section) => observer.observe(section));
    state.listeners.push(() => observer.disconnect());
  }
}

async function start() {
  setStateMessage("Loading the journal…");
  for (let attempt = 0; ; attempt += 1) {
    try {
      const areas = loadAreas();
      await Promise.all([loadMetadata(), loadIntelligence()]);
      await areas;
      break;
    } catch (error) {
      if (error.status === 409 && attempt < PENDING_RETRY_LIMIT) {
        setStateMessage(
          "This area's coverage is being recalculated. The journal opens when it finishes.",
          "waiting"
        );
        await new Promise((resolve) => {
          state.timers.push(setTimeout(resolve, PENDING_RETRY_MS));
        });
        continue;
      }
      throw error;
    }
  }
  await loadContributions();
  setStateMessage("", "ready");
  renderAll();
  await initMap();
  syncUrl();
}

export default async function initCoverageJournalPage({ signal, cleanup, api } = {}) {
  state = initialState();
  const ownedState = state;
  cleanup?.(() => {
    ownedState.rangeAbort?.abort();
    ownedState.notesAbort?.abort();
    ownedState.segmentsAbort?.abort();
    ownedState.timers.forEach(clearTimeout);
    for (const remove of ownedState.listeners.splice(0)) {
      remove();
    }
    ownedState.journalMap?.remove();
    ownedState.map?.remove();
    ownedState.map = null;
  });
  featureApi = api;
  if (!state.areaId || !featureApi) {
    return;
  }
  setupListeners();
  setActiveControls();
  const refresh = async () => {
    if (signal?.aborted || !state.metadata) {
      return;
    }
    try {
      await Promise.all([loadMetadata(), loadIntelligence(), loadAreas()]);
      state.contributions = [];
      state.nextCursor = null;
      await Promise.all([loadContributions(), loadSegments()]);
      renderAll();
      showSectionOnMap(state.activeSection);
    } catch (error) {
      if (!signal?.aborted && error.name !== "AbortError") {
        console.error("Coverage journal refresh failed", error);
      }
    }
  };
  listen(document, "historicalTripsUpdated", refresh);
  try {
    await start();
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    console.error("Coverage journal failed", error);
    setStateMessage(error.message || "The journal could not be opened.", "error");
  }
}
