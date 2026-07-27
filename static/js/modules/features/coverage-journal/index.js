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
    mapSelectionPinned: false,
    chartScrubbing: false,
    chartStartIndex: 0,
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
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    String(value || "").trim()
  );
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

function journalDateKey(value) {
  const dateText = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return dateText;
  }
  const date = parseDate(value);
  if (!date) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: state.metadata?.timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeStreetKey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function streetButton(streetName) {
  const name = String(streetName || "").trim();
  if (!name) {
    return "";
  }
  return `<button type="button" class="journal-street-link" data-journal-street="${escapeHtml(
    name
  )}" aria-label="Show ${escapeHtml(name)} on the map">${escapeHtml(
    name
  )}<i class="fas fa-location-dot" aria-hidden="true"></i></button>`;
}

function renderStreetLinks(streetNames, fallback = "Unnamed roads") {
  const names = [...new Set((streetNames || []).filter(Boolean))];
  if (!names.length) {
    return `<span class="journal-street-fallback">${escapeHtml(fallback)}</span>`;
  }
  return names
    .map(
      (name, index) =>
        `${index ? '<span class="journal-street-separator" aria-hidden="true">,</span>' : ""}${streetButton(
          name
        )}`
    )
    .join("");
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
  const latestStreet = summary.last_new_street_names?.[0];
  $("journal-stat-latest").innerHTML = latestStreet
    ? streetButton(latestStreet)
    : escapeHtml(formatDate(summary.last_new_street_at, { short: true }));
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
    list.innerHTML = `<li class="journal-milestone-copy"><h3>No milestones yet</h3><p>The first coverage-changing trip will create this area’s first milestone.</p></li>`;
    return;
  }
  list.innerHTML = chapters
    .map((chapter, index) => {
      const marker =
        chapter.key === "first" ? "01" : `${Math.round(chapter.threshold)}%`;
      return `<li class="journal-milestone ${
        chapter.key === state.activeMilestone ? "is-active" : ""
      }" data-milestone-key="${escapeHtml(chapter.key)}">
        <button type="button" class="journal-milestone-trigger" data-milestone-index="${index}" aria-label="Show ${escapeHtml(
          chapter.label
        )} on map">
          <span class="journal-milestone-mark">${escapeHtml(marker)}</span>
          <span class="journal-milestone-copy">
            <time datetime="${escapeHtml(journalDateKey(chapter.reached_at))}">${escapeHtml(
              formatDate(chapter.reached_at)
            )}</time>
            <h3>${escapeHtml(chapter.label)}</h3>
          </span>
        </button>
        <p class="journal-milestone-streets">${renderStreetLinks(
          chapter.street_names,
          "Coverage moved forward"
        )}</p>
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
  state.mapSelectionPinned = false;
  document.querySelectorAll(".journal-milestone").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.milestoneKey === chapter.key);
  });
  const chapters = milestoneChapters();
  const index = chapters.findIndex((item) => item.key === chapter.key);
  const previous = index > 0 ? chapters[index - 1] : null;
  setProgressMap(
    chapter.reached_at,
    previous?.reached_at || null,
    chapter.label,
    previous?.label || ""
  );
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

function renderMapLegend(items, note) {
  const legend = $("journal-map-legend");
  legend.innerHTML = items
    .map(
      (item) => `<span class="journal-map-legend-item">
        <i class="journal-swatch ${escapeHtml(item.swatch)}" aria-hidden="true"></i>
        ${item.value ? `<strong>${escapeHtml(item.value)}</strong>` : ""}
        <span>${escapeHtml(item.label)}</span>
      </span>`
    )
    .join("");
  legend.setAttribute("aria-label", `Map key. ${note}`);
  $("journal-map-legend-note").textContent = note;
}

function setProgressMap(
  cutoffValue,
  previousValue,
  label = "Coverage as of",
  previousLabel = ""
) {
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
  const cutoffDate = formatDate(cutoffValue);
  const hasPreviousMilestone = Boolean(previousValue);
  if (hasPreviousMilestone) {
    const startingMilestone = previousLabel || "the previous milestone";
    renderMapLegend(
      [
        {
          swatch: "journal-swatch--earlier",
          value: formatNumber(earlier),
          label: `Covered by ${startingMilestone}`,
        },
        {
          swatch: "journal-swatch--chapter",
          value: formatNumber(chapter),
          label: `Added since ${startingMilestone}`,
        },
        {
          swatch: "journal-swatch--remaining",
          value: formatNumber(remaining),
          label: label === "Current frontier" ? "Not covered yet" : `Still uncovered at ${label}`,
        },
      ],
      `Counts individual road segments. The selected period starts after ${startingMilestone} (${formatDate(
        previousValue
      )}) and ends at ${label} (${cutoffDate}).`
    );
  } else {
    const isTimelineDate = label.startsWith("Coverage as of");
    const momentLabel = isTimelineDate ? "the selected date" : label;
    renderMapLegend(
      [
        {
          swatch: "journal-swatch--chapter",
          value: formatNumber(chapter),
          label: `Covered by ${momentLabel}`,
        },
        {
          swatch: "journal-swatch--remaining",
          value: formatNumber(remaining),
          label: `Not covered by ${momentLabel}`,
        },
      ],
      `Counts individual road segments as of ${cutoffDate}.`
    );
  }
  refreshMapSource();
}

function setFrequencyMap() {
  if (!state.geojson) {
    return;
  }
  state.mapMode = "frequency";
  state.mapSelectionPinned = false;
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
  renderMapLegend(
    [
      { swatch: "journal-swatch--frequency-low", label: "1–2 distinct trips" },
      { swatch: "journal-swatch--frequency-medium", label: "3–19 distinct trips" },
      { swatch: "journal-swatch--frequency-high", label: "20+ distinct trips" },
    ],
    `Line thickness shows how many distinct completed trips touched each road during ${RANGE_LABELS[
      state.range
    ]}.`
  );
  $("journal-map-equivalent").textContent =
    "The ranking below is the non-map equivalent of this distinct-trip frequency lens.";
  refreshMapSource();
}

function setFrontierMap(selectedIds = []) {
  if (!state.geojson) {
    return;
  }
  state.mapMode = "frontier";
  state.mapSelectionPinned = selectedIds.length > 0;
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
  renderMapLegend(
    [
      { swatch: "journal-swatch--remaining", label: "Uncovered road segment" },
      { swatch: "journal-swatch--selected", label: "Selected road opportunity" },
    ],
    "Coral marks road segments that remain uncovered. Ochre marks the road selected below."
  );
  refreshMapSource();
  if (selectedIds.length) {
    fitSelectedSegments(selectedIds);
  }
}

function revealMapFolio() {
  const folio = $("journal-map-folio");
  if (!folio) {
    return;
  }
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    .matches;
  folio.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "center",
  });
  window.setTimeout(() => folio.focus({ preventScroll: true }), reducedMotion ? 0 : 350);
}

function segmentIdsForStreet(streetName) {
  const key = normalizeStreetKey(streetName);
  if (!key) {
    return [];
  }
  return (state.geojson?.features || [])
    .filter(
      (feature) =>
        normalizeStreetKey(
          feature.properties?.street_key || feature.properties?.street_name
        ) === key
    )
    .map((feature) => feature.properties?.segment_id)
    .filter(Boolean);
}

function showStreetOnMap(streetName) {
  const segmentIds = segmentIdsForStreet(streetName);
  if (!segmentIds.length) {
    $("journal-map-equivalent").textContent =
      `${streetName} has no matching segment in the current street inventory.`;
    revealMapFolio();
    return;
  }
  highlightSegments(segmentIds, streetName, { reveal: true });
}

function highlightSegments(segmentIds, label, { reveal = false } = {}) {
  if (!state.geojson) {
    return;
  }
  const ids = new Set(segmentIds || []);
  state.selectedIds = ids;
  state.mapMode = "selection";
  state.mapSelectionPinned = true;
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
  renderMapLegend(
    [
      { swatch: "journal-swatch--chapter", label: "Selected street segments" },
      { swatch: "journal-swatch--earlier", label: "Other streets for context" },
    ],
    "Cobalt marks every current segment belonging to the selected street. Steel shows the surrounding street network."
  );
  $("journal-map-equivalent").textContent = `${formatNumber(ids.size)} current segment${
    ids.size === 1 ? "" : "s"
  } highlighted for ${label}.`;
  refreshMapSource();
  fitSelectedSegments([...ids]);
  if (reveal) {
    revealMapFolio();
  }
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

function timelineIndexFromPointer(event) {
  const svg = $("journal-pace-chart");
  const series = state.metadata?.series || [];
  if (!svg || !series.length) {
    return 0;
  }
  const bounds = svg.getBoundingClientRect();
  const viewBoxX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 960;
  const ratio = Math.max(0, Math.min(1, (viewBoxX - 62) / (930 - 62)));
  return Math.round(ratio * Math.max(0, series.length - 1));
}

function nearestSeriesIndex(value, series = state.metadata?.series || []) {
  const target = Date.parse(`${journalDateKey(value)}T00:00:00Z`);
  if (!series.length || !Number.isFinite(target)) {
    return 0;
  }
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  series.forEach((point, index) => {
    const difference = Math.abs(Date.parse(point.date) - target);
    if (difference < distance) {
      nearest = index;
      distance = difference;
    }
  });
  return nearest;
}

function chartScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function updateChartPanControls() {
  const scroller = $("journal-chart-scroll");
  const earlier = $("journal-chart-earlier");
  const later = $("journal-chart-later");
  if (!scroller || !earlier || !later) {
    return;
  }
  const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  earlier.disabled = scroller.scrollLeft <= 2;
  later.disabled = scroller.scrollLeft >= maxScroll - 2;
}

function panChart(direction) {
  const scroller = $("journal-chart-scroll");
  if (!scroller) {
    return;
  }
  scroller.scrollBy({
    left: direction * Math.max(240, scroller.clientWidth * 0.72),
    behavior: chartScrollBehavior(),
  });
}

function scrollChartToIndex(index) {
  const scroller = $("journal-chart-scroll");
  const svg = $("journal-pace-chart");
  const series = state.metadata?.series || [];
  if (!scroller || !svg || !series.length) {
    return;
  }
  const ratio = index / Math.max(1, series.length - 1);
  const x = ratio * svg.scrollWidth;
  scroller.scrollTo({
    left: Math.max(0, x - scroller.clientWidth / 2),
    behavior: chartScrollBehavior(),
  });
}

function biggestProgressDay(series = state.metadata?.series || []) {
  return series.reduce(
    (best, point, index) =>
      Number(point.new_miles || 0) > Number(best?.point?.new_miles ?? -1)
        ? { point, index }
        : best,
    null
  );
}

function renderPaceEvents(series) {
  const container = $("journal-chart-events");
  if (!container) {
    return;
  }
  if (!series.length) {
    container.innerHTML = "";
    return;
  }
  const inRange = (value) => {
    const key = journalDateKey(value);
    return Boolean(key && key >= series[0].date && key <= series.at(-1).date);
  };
  const biggest = biggestProgressDay(series);
  const events = [];
  if (biggest?.point?.date && inRange(biggest.point.date)) {
    events.push({
      kind: "record",
      eyebrow: "Record day",
      title: "Best progress day",
      occurredAt: biggest.point.date,
      detail: `+${formatMiles(biggest.point.new_miles, 2)} · ${formatNumber(
        biggest.point.new_segments
      )} new segments · ${formatNumber(
        biggest.point.coverage_percentage,
        1
      )}% reached`,
    });
  }
  for (const milestone of state.metadata?.milestones || []) {
    if (!inRange(milestone.reached_at)) {
      continue;
    }
    events.push({
      kind: "milestone",
      eyebrow: "Milestone",
      title: milestone.label,
      occurredAt: milestone.reached_at,
      detail: `${formatNumber(milestone.coverage, 1)}% coverage reached`,
    });
  }
  if (!events.length) {
    container.innerHTML = `<div class="journal-chart-events-empty">No record or milestone date falls inside ${escapeHtml(
      RANGE_LABELS[state.range].toLowerCase()
    )}.</div>`;
    return;
  }
  container.innerHTML = `<div class="journal-chart-events-heading"><strong>Momentous dates</strong><span>Select one to move the timeline and map.</span></div>
    <ol>${events
      .map((event) => {
        const index = nearestSeriesIndex(event.occurredAt, series);
        return `<li><button type="button" class="journal-chart-event journal-chart-event--${escapeHtml(
          event.kind
        )}" data-pace-event-index="${index}">
          <span>${escapeHtml(event.eyebrow)}</span>
          <strong>${escapeHtml(event.title)}</strong>
          <time datetime="${escapeHtml(journalDateKey(event.occurredAt))}">${escapeHtml(
            formatDate(event.occurredAt, { short: true })
          )}</time>
          <small>${escapeHtml(event.detail)}</small>
        </button></li>`;
      })
      .join("")}</ol>`;
}

function updateTimelineVisuals(index) {
  const series = state.metadata?.series || [];
  const point = series[index];
  if (!point) {
    return;
  }
  const x = 62 + (index / Math.max(1, series.length - 1)) * (930 - 62);
  const y = 270 - (Number(point.coverage_percentage || 0) / 100) * (270 - 28);
  const line = $("journal-chart-cursor-line");
  const dot = $("journal-chart-cursor-dot");
  const readout = $("journal-chart-readout");
  if (line) {
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
  }
  if (dot) {
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
  }
  if (readout) {
    const tooltipX = Math.max(62, Math.min(740, x - 95));
    readout.setAttribute("transform", `translate(${tooltipX} 38)`);
  }
  $("journal-chart-readout-date").textContent = formatDate(point.date, {
    short: true,
  });
  $("journal-chart-readout-value").textContent = `${formatNumber(
    point.coverage_percentage,
    1
  )}% covered · +${formatMiles(point.new_miles, 2)}`;
  $("journal-cursor-date").textContent = formatDate(point.date);
  $("journal-cursor-summary").textContent = `${formatNumber(
    point.coverage_percentage,
    1
  )}% covered · ${formatMiles(point.new_miles, 2)} added that day · ${formatNumber(
    point.new_segments
  )} new segments.`;
  document.querySelectorAll("[data-pace-event-index]").forEach((button) => {
    const active = Number(button.dataset.paceEventIndex) === index;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "date" : "false");
  });
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
    svg.style.minWidth = "720px";
    renderPaceEvents([]);
    updateChartPanControls();
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
  svg.style.minWidth = `${Math.min(2200, Math.max(960, series.length * 13))}px`;
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
  const biggestDay = biggestProgressDay(series);
  const biggestIndex = biggestDay?.index ?? -1;
  const bars = series
    .map((point, index) => {
      const height = (Number(point.new_miles || 0) / maxMiles) * 42;
      const width = Math.max(2, Math.min(12, (right - left) / series.length - 1));
      return `<rect x="${x(index) - width / 2}" y="${
        barBottom - height
      }" width="${width}" height="${height}" class="journal-chart-bar${
        index === biggestIndex ? " is-record" : ""
      }"><title>${escapeHtml(formatDate(point.date))} · ${formatMiles(
        point.new_miles,
        2
      )} added</title></rect>`;
    })
    .join("");
  const visibleMilestones = (state.metadata?.milestones || []).filter((milestone) => {
    const key = journalDateKey(milestone.reached_at);
    return Boolean(key && key >= series[0].date && key <= series.at(-1).date);
  });
  const milestoneMarks = visibleMilestones
    .map((milestone, milestoneIndex) => {
      const nearest = nearestSeriesIndex(milestone.reached_at, series);
      const pointY = y(milestone.coverage);
      const labelY = Math.max(top + 12, pointY - 10 - (milestoneIndex % 2) * 16);
      const markerLabel =
        milestone.key === "first"
          ? "START"
          : `${Math.round(milestone.threshold || milestone.coverage)}%`;
      return `<g class="journal-chart-milestone-mark">
        <line x1="${x(nearest)}" y1="${top}" x2="${x(
          nearest
        )}" y2="${barBottom}" class="journal-chart-milestone-guide"/>
        <circle cx="${x(nearest)}" cy="${pointY}" r="5" class="journal-chart-milestone"><title>${escapeHtml(
          milestone.label
        )} · ${escapeHtml(formatDate(milestone.reached_at))}</title></circle>
        <text x="${x(nearest)}" y="${labelY}" text-anchor="middle" class="journal-chart-milestone-label">${escapeHtml(
          markerLabel
        )}</text>
      </g>`;
    })
    .join("");
  let recordMark = "";
  if (biggestIndex >= 0 && biggestDay) {
    const recordX = x(biggestIndex);
    const recordHeight =
      (Number(series[biggestIndex]?.new_miles || 0) / maxMiles) * 42;
    const anchor = recordX < 180 ? "start" : recordX > 820 ? "end" : "middle";
    recordMark = `<g class="journal-chart-record-mark">
      <line x1="${recordX}" y1="${barBottom - recordHeight - 5}" x2="${recordX}" y2="${
        barBottom - 54
      }"/>
      <text x="${recordX}" y="${barBottom - 59}" text-anchor="${anchor}">BEST DAY · +${escapeHtml(
        formatMiles(biggestDay.point.new_miles, 2)
      )}</text>
    </g>`;
  }
  const cursor = $("journal-timeline-cursor");
  cursor.disabled = false;
  cursor.max = String(series.length - 1);
  const requestedIndex = state.asOf
    ? series.findLastIndex((point) => point.date <= state.asOf)
    : series.length - 1;
  cursor.value = String(Math.max(0, requestedIndex));
  const cursorX = x(Number(cursor.value));
  const cursorPoint = series[Number(cursor.value)];
  const cursorY = y(cursorPoint.coverage_percentage);
  const readoutX = Math.max(62, Math.min(740, cursorX - 95));
  svg.innerHTML = `<title id="journal-chart-title">Cumulative street coverage over time</title>
    <desc id="journal-chart-desc">${series.length} active coverage days in ${escapeHtml(
      RANGE_LABELS[state.range]
    )}; ending at ${formatNumber(series.at(-1).coverage_percentage, 1)} percent.</desc>
    ${grid}<path d="${chartPath(points, true)}" class="journal-chart-area"/>
    ${bars}<path d="${chartPath(points)}" class="journal-chart-line"/>
    ${milestoneMarks}${recordMark}<line x1="${cursorX}" y1="${top}" x2="${cursorX}" y2="${barBottom}" class="journal-chart-cursor" id="journal-chart-cursor-line"/>
    <circle cx="${cursorX}" cy="${cursorY}" r="5" class="journal-chart-cursor-dot" id="journal-chart-cursor-dot"/>
    <g id="journal-chart-readout" class="journal-chart-readout" transform="translate(${readoutX} 38)">
      <rect width="190" height="54" class="journal-chart-readout-panel"/>
      <text x="12" y="21" id="journal-chart-readout-date" class="journal-chart-axis">${escapeHtml(
        formatDate(cursorPoint.date, { short: true })
      )}</text>
      <text x="12" y="42" id="journal-chart-readout-value" class="journal-chart-readout-value">${formatNumber(
        cursorPoint.coverage_percentage,
        1
      )}% covered · +${formatMiles(cursorPoint.new_miles, 2)}</text>
    </g>
    <rect x="${left}" y="${top}" width="${right - left}" height="${
      barBottom - top
    }" class="journal-chart-hit" id="journal-chart-hit"/>
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
  renderPaceEvents(series);
  updateTimelineCursor(Number(cursor.value), { updateUrl: false, updateMap: false });
  window.requestAnimationFrame(updateChartPanControls);
}

function updateTimelineCursor(index, { updateUrl = true, updateMap = true } = {}) {
  const series = state.metadata?.series || [];
  const safeIndex = Math.max(0, Math.min(series.length - 1, Number(index) || 0));
  const point = series[safeIndex];
  if (!point) {
    return;
  }
  state.asOf = point.date;
  $("journal-timeline-cursor").value = String(safeIndex);
  updateTimelineVisuals(safeIndex);
  if (updateMap) {
    state.mapSelectionPinned = false;
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
    <div class="journal-record"><span>Largest single session</span><strong>${formatMiles(
      biggest?.new_miles,
      2
    )}</strong><small>${escapeHtml(formatDate(biggest?.occurred_at))}</small></div>
    <div class="journal-record"><span>Longest pause</span><strong>${formatNumber(
      records.longest_pause_days,
      1
    )} days</strong><small>Between coverage-changing sessions</small></div>
    <div class="journal-record"><span>Latest addition</span><strong>${
      latest?.street_names?.[0]
        ? streetButton(latest.street_names[0])
        : "No addition in this range"
    }</strong><small>${escapeHtml(formatDate(latest?.occurred_at))}</small></div>`;
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
          )}</h3><p>${renderStreetLinks(item.street_names)}</p>${tripLink}</div>
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
        button.dataset.rankingLabel,
        { reveal: true }
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
      revealMapFolio();
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
  listen($("coverage-journal"), "click", (event) => {
    const street = event.target.closest("[data-journal-street]");
    if (street) {
      showStreetOnMap(street.dataset.journalStreet);
      return;
    }
    const paceEvent = event.target.closest("[data-pace-event-index]");
    if (paceEvent) {
      const index = Number(paceEvent.dataset.paceEventIndex);
      updateTimelineCursor(index);
      scrollChartToIndex(index);
    }
  });
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
  listen($("journal-chart-earlier"), "click", () => panChart(-1));
  listen($("journal-chart-later"), "click", () => panChart(1));
  listen($("journal-chart-scroll"), "scroll", updateChartPanControls, {
    passive: true,
  });
  listen(window, "resize", updateChartPanControls, { passive: true });
  listen($("journal-pace-chart"), "pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") {
      return;
    }
    state.chartScrubbing = true;
    state.chartStartIndex = Number($("journal-timeline-cursor")?.value || 0);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const index = timelineIndexFromPointer(event);
    $("journal-timeline-cursor").value = String(index);
    updateTimelineCursor(index, { updateUrl: false, updateMap: false });
  });
  listen($("journal-pace-chart"), "pointermove", (event) => {
    const index = timelineIndexFromPointer(event);
    if (state.chartScrubbing) {
      event.preventDefault();
      $("journal-timeline-cursor").value = String(index);
      updateTimelineCursor(index, { updateUrl: false, updateMap: false });
    } else if (event.pointerType === "mouse") {
      updateTimelineVisuals(index);
    }
  });
  listen($("journal-pace-chart"), "pointerup", (event) => {
    if (!state.chartScrubbing) {
      return;
    }
    state.chartScrubbing = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateTimelineCursor(timelineIndexFromPointer(event));
  });
  listen($("journal-pace-chart"), "pointercancel", () => {
    state.chartScrubbing = false;
    updateTimelineCursor(state.chartStartIndex, {
      updateUrl: false,
      updateMap: false,
    });
  });
  listen($("journal-pace-chart"), "pointerleave", () => {
    if (!state.chartScrubbing) {
      updateTimelineVisuals(Number($("journal-timeline-cursor")?.value || 0));
    }
  });
  listen($("journal-load-more"), "click", () => loadContributions({ append: true }));
  listen($("journal-map-reset"), "click", fitArea);
  listen(
    $("known-by-heart"),
    "mouseenter",
    () => {
      if (!state.mapSelectionPinned) {
        setFrequencyMap();
      }
    },
    { once: true }
  );
  listen(
    $("frontier"),
    "mouseenter",
    () => {
      if (!state.mapSelectionPinned) {
        setFrontierMap();
      }
    },
    { once: true }
  );
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
        if (state.mapSelectionPinned) {
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
