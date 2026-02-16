/**
 * Story Sections Module
 * Renders the insights experience (period cards, pattern cards, orbit, timeline).
 */

import { escapeHtml, formatHourLabel } from "../utils.js";
import { fetchDrilldownTrips } from "./api.js";
import { deriveInsightsSnapshot } from "./derived-insights.js";
import { formatDuration, getDateRange } from "./formatters.js";
import {
  displayTripsInModal,
  loadAndShowTripsForDrilldown,
  loadAndShowTripsForTimePeriod,
} from "./modal.js";

const storyState = {
  snapshot: null,
  periodMode: "weekly",
  selectedPlaceIndex: 0,
  scenes: [],
};

function normalizePeriodMode(mode) {
  return mode === "monthly" ? "monthly" : "weekly";
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return "New baseline";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatShortDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function sparklineSvg(values = []) {
  const width = 140;
  const height = 34;
  const points = values.map((value, index) => ({
    x: (index / Math.max(values.length - 1, 1)) * width,
    y: value,
  }));

  if (!points.length) {
    return `<svg class="storyrail-spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);

  const toCoord = (point) => {
    const normalizedY = (point.y - min) / range;
    const y = height - normalizedY * (height - 4) - 2;
    return `${point.x.toFixed(2)},${y.toFixed(2)}`;
  };

  const polyline = points.map(toCoord).join(" ");
  return `
    <svg class="storyrail-spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <polyline points="${polyline}" />
    </svg>
  `;
}

function renderRhythmPeriodToggle(mode) {
  const buttons = document.querySelectorAll("#rhythm-period-toggle [data-rhythm-view]");
  buttons.forEach((button) => {
    button.classList.toggle("active", button.dataset.rhythmView === mode);
    button.setAttribute("aria-pressed", button.dataset.rhythmView === mode ? "true" : "false");
  });
}

function renderRhythmStoryrail(periods = []) {
  const container = document.getElementById("rhythm-storyrail");
  if (!container) {
    return;
  }

  if (!periods.length) {
    container.innerHTML =
      '<div class="story-empty">Not enough data in this range to compare periods yet.</div>';
    return;
  }

  const visiblePeriods = periods.slice(-8);
  const allDistances = periods.map((period) => period.distance || 0);
  const startIndexOffset = periods.length - visiblePeriods.length;

  container.innerHTML = visiblePeriods
    .map((period, localIndex) => {
      const globalIndex = startIndexOffset + localIndex;
      const sparkWindow = allDistances.slice(Math.max(0, globalIndex - 5), globalIndex + 1);
      const deltaClass =
        period.distanceDeltaPct == null
          ? "is-neutral"
          : period.distanceDeltaPct > 1
            ? "is-up"
            : period.distanceDeltaPct < -1
              ? "is-down"
              : "is-neutral";

      const previousSummary =
        period.previousTrips == null || period.previousDistance == null
          ? "No prior period in selected range"
          : `Previous: ${period.previousTrips} trips • ${Number(period.previousDistance).toFixed(1)} mi`;

      return `
        <button type="button"
                class="rhythm-story-card ${deltaClass}"
                data-start="${period.start}"
                data-end="${period.end}"
                data-label="${escapeHtml(period.label)}"
                aria-label="Open trips for ${escapeHtml(period.label)}">
          <div class="storyrail-topline">
            <span class="storyrail-period">${escapeHtml(period.label)}</span>
            <span class="storyrail-delta ${deltaClass}">${formatSignedPercent(period.distanceDeltaPct)}</span>
          </div>
          <h3 class="storyrail-headline">${escapeHtml(period.headline)}</h3>
          <p class="storyrail-summary">${escapeHtml(period.summary)}</p>
          <p class="storyrail-summary">${escapeHtml(previousSummary)}</p>
          ${sparklineSvg(sparkWindow)}
          <div class="storyrail-meta">
            <span>${period.trips} trips</span>
            <span>${period.distance.toFixed(1)} mi</span>
            <span>${period.avgDistancePerTrip.toFixed(1)} mi/trip</span>
          </div>
        </button>
      `;
    })
    .join("");

  if (container.dataset.bound !== "true") {
    container.addEventListener("click", (event) => {
      const card = event.target.closest(".rhythm-story-card");
      if (!card) {
        return;
      }
      loadAndShowTripsForDrilldown("trips", {
        start: card.dataset.start,
        end: card.dataset.end,
        title: `Trips for ${card.dataset.label}`,
      });
    });
    container.dataset.bound = "true";
  }
}

function renderInsightScenes(scenes = []) {
  const container = document.getElementById("insight-scenes");
  if (!container) {
    return;
  }
  storyState.scenes = scenes;

  if (!scenes.length) {
    container.innerHTML =
      '<div class="story-empty">Not enough data in this range to compute pattern cards yet.</div>';
    return;
  }

  container.innerHTML = scenes
    .map(
      (scene, index) => `
        <button type="button"
                class="scene-card tone-${scene.tone || "mint"}"
                data-scene-index="${index}"
                aria-label="Open data for ${escapeHtml(scene.title || "pattern")}">
          <div class="scene-icon"><i class="fas ${escapeHtml(scene.icon || "fa-circle")}"></i></div>
          <p class="scene-title">${escapeHtml(scene.title || "Pattern")}</p>
          <p class="scene-value">${escapeHtml(scene.value || "-")}</p>
          <p class="scene-detail">${escapeHtml(scene.detail || "")}</p>
          <p class="scene-action">Open underlying trips</p>
        </button>
      `
    )
    .join("");

  if (container.dataset.bound !== "true") {
    container.addEventListener("click", async (event) => {
      const card = event.target.closest("[data-scene-index]");
      if (!card) {
        return;
      }
      const index = Number.parseInt(card.dataset.sceneIndex || "-1", 10);
      if (index < 0 || index >= storyState.scenes.length) {
        return;
      }
      await handleSceneAction(storyState.scenes[index]?.action);
    });
    container.dataset.bound = "true";
  }
}

function locationText(place) {
  if (!place) {
    return "Unknown place";
  }
  if (typeof place === "string") {
    return place;
  }
  if (typeof place === "object") {
    return place.formatted_address || place.name || place.address || "Unknown place";
  }
  return String(place);
}

function renderPlaceDetail(place, exploration, panel) {
  if (!panel) {
    return;
  }
  if (!place) {
    panel.innerHTML = `
      <div class="places-detail-empty">
        <p>Select a place bubble to see details.</p>
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="places-detail-content">
      <p class="places-detail-label">Selected place</p>
      <h3 class="places-detail-title">${escapeHtml(place.location)}</h3>
      <div class="places-detail-stats">
        <div><span>Visits</span><strong>${place.visits}</strong></div>
        <div><span>Distance</span><strong>${place.distance.toFixed(1)} mi</strong></div>
        <div><span>Last visit</span><strong>${escapeHtml(formatShortDate(place.lastVisit))}</strong></div>
        <div><span>Exploration score</span><strong>${exploration.explorationScore.toFixed(0)} / 100</strong></div>
      </div>
      <button type="button" class="btn btn-outline-primary places-detail-action" data-place-action="open-trips">
        View Trips To This Place
      </button>
      <a class="places-detail-link" href="/trips">Open trips page</a>
    </div>
  `;
}

async function openTripsForPlace(place) {
  const dateRange = getDateRange();
  const params = new URLSearchParams({
    start_date: dateRange.start,
    end_date: dateRange.end,
    kind: "trips",
    limit: "500",
  });

  const allTrips = await fetchDrilldownTrips(params);
  const target = (place?.location || "").trim().toLowerCase();

  const filtered = (Array.isArray(allTrips) ? allTrips : []).filter((trip) => {
    const destination = locationText(trip?.destination).trim().toLowerCase();
    return destination && target && destination.includes(target);
  });

  if (!filtered.length) {
    loadAndShowTripsForDrilldown("trips", {
      start: dateRange.start,
      end: dateRange.end,
      title: `Trips (${dateRange.start} to ${dateRange.end})`,
    });
    return;
  }

  displayTripsInModal(filtered, {
    title: `Trips to ${place.location} (${filtered.length})`,
    insightKind: "trips",
  });
}

async function handleSceneAction(action = {}) {
  if (!action || typeof action !== "object") {
    return;
  }

  if (action.type === "drilldown") {
    loadAndShowTripsForDrilldown(action.kind || "trips");
    return;
  }

  if (action.type === "time-period") {
    const timeType = action.timeType === "day" ? "day" : "hour";
    const rawValue = Number.parseInt(String(action.timeValue ?? 0), 10);
    const maxValue = timeType === "day" ? 6 : 23;
    const timeValue = Math.min(Math.max(Number.isFinite(rawValue) ? rawValue : 0, 0), maxValue);
    loadAndShowTripsForTimePeriod(timeType, timeValue);
    return;
  }

  if (action.type === "place") {
    const place = storyState.snapshot?.exploration?.mostVisited;
    if (place) {
      await openTripsForPlace(place);
      return;
    }
    loadAndShowTripsForDrilldown("trips");
  }
}

function renderPlacesOrbit(exploration = {}) {
  const container = document.getElementById("places-orbit");
  const panel = document.getElementById("places-detail-panel");
  if (!container || !panel) {
    return;
  }

  const destinations = Array.isArray(exploration.destinations)
    ? exploration.destinations.slice(0, 5)
    : [];

  if (!destinations.length) {
    container.innerHTML = '<div class="story-empty">No destination clusters in this date range.</div>';
    renderPlaceDetail(null, exploration, panel);
    return;
  }

  const maxVisits = Math.max(...destinations.map((place) => place.visits), 1);
  const nodesMarkup = destinations
    .map((place, index) => {
      const angle = (-90 + index * (360 / destinations.length)) * (Math.PI / 180);
      const radius = 24 + index * 8;
      const x = 50 + Math.cos(angle) * radius;
      const y = 50 + Math.sin(angle) * radius;
      const size = 52 + (place.visits / maxVisits) * 46;
      const activeClass = index === storyState.selectedPlaceIndex ? "is-active" : "";

      return `
        <button type="button"
                class="orbit-node ${activeClass}"
                data-place-index="${index}"
                style="left:${x}%;top:${y}%;--node-size:${size}px;animation-delay:${index * 80}ms"
                aria-label="${escapeHtml(place.location)}">
          <span class="orbit-node-name">${escapeHtml(place.location)}</span>
          <span class="orbit-node-visits">${place.visits}</span>
        </button>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="orbit-core" aria-hidden="true">
      <span>${exploration.explorationLabel || "Driving orbit"}</span>
    </div>
    ${nodesMarkup}
  `;

  const selected = destinations[storyState.selectedPlaceIndex] || destinations[0];
  renderPlaceDetail(selected, exploration, panel);

  container.onclick = (event) => {
    const node = event.target.closest(".orbit-node");
    if (!node) {
      return;
    }
    storyState.selectedPlaceIndex = Number.parseInt(node.dataset.placeIndex || "0", 10);
    renderPlacesOrbit(exploration);
  };

  panel.onclick = async (event) => {
    const actionButton = event.target.closest("[data-place-action='open-trips']");
    if (!actionButton) {
      return;
    }

    const currentPlace = destinations[storyState.selectedPlaceIndex] || null;
    if (!currentPlace) {
      return;
    }

    actionButton.disabled = true;
    actionButton.textContent = "Loading trips...";
    try {
      await openTripsForPlace(currentPlace);
    } finally {
      actionButton.disabled = false;
      actionButton.textContent = "View Trips To This Place";
    }
  };
}

function renderRecordsTimeline(records = {}) {
  const container = document.getElementById("records-timeline");
  if (!container) {
    return;
  }

  const entries = [];

  if (records.longest_trip?.distance) {
    entries.push({
      title: "Longest trip",
      value: `${records.longest_trip.distance.toFixed(1)} mi`,
      detail: formatShortDate(records.longest_trip.recorded_at),
      icon: "fa-route",
    });
  }

  if (records.longest_duration?.duration_seconds) {
    entries.push({
      title: "Longest driving session",
      value: formatDuration(records.longest_duration.duration_seconds),
      detail: formatShortDate(records.longest_duration.recorded_at),
      icon: "fa-hourglass-half",
    });
  }

  if (records.max_day_distance?.distance) {
    entries.push({
      title: "Biggest distance day",
      value: `${records.max_day_distance.distance.toFixed(1)} mi`,
      detail: formatShortDate(records.max_day_distance.date),
      icon: "fa-mountain",
    });
  }

  if (records.max_day_trips?.trips) {
    entries.push({
      title: "Most trips in one day",
      value: `${records.max_day_trips.trips} trips`,
      detail: formatShortDate(records.max_day_trips.date),
      icon: "fa-layer-group",
    });
  }

  if (records.most_visited?.location) {
    entries.push({
      title: "Most visited place",
      value: records.most_visited.location,
      detail: `${records.most_visited.count || 0} visits`,
      icon: "fa-map-pin",
    });
  }

  if (!entries.length) {
    container.innerHTML = '<div class="story-empty">No record-level outliers in this range yet.</div>';
    return;
  }

  container.innerHTML = entries
    .map(
      (entry) => `
        <article class="timeline-card">
          <div class="timeline-icon"><i class="fas ${escapeHtml(entry.icon)}"></i></div>
          <div class="timeline-content">
            <p class="timeline-title">${escapeHtml(entry.title)}</p>
            <p class="timeline-value">${escapeHtml(entry.value)}</p>
            <p class="timeline-detail">${escapeHtml(entry.detail)}</p>
          </div>
        </article>
      `
    )
    .join("");
}

function renderTrendsNarrative(snapshot, mode, currentView) {
  const container = document.getElementById("trends-narrative");
  if (!container) {
    return;
  }

  const periods = snapshot?.periods?.[mode] || [];
  const latest = periods.length ? periods[periods.length - 1] : null;
  const previous = periods.length > 1 ? periods[periods.length - 2] : null;

  if (!latest) {
    container.textContent = "Not enough periods in this range for a comparison yet.";
    return;
  }

  const focus = currentView === "daily" ? "Daily resolution" : `${mode[0].toUpperCase()}${mode.slice(1)} resolution`;
  const avgDistance = latest.trips > 0 ? latest.distance / latest.trips : 0;
  const previousAvgDistance = previous && previous.trips > 0 ? previous.distance / previous.trips : 0;
  const pctText =
    latest.distanceDeltaPct == null
      ? "N/A"
      : `${latest.distanceDeltaPct > 0 ? "+" : ""}${latest.distanceDeltaPct.toFixed(1)}%`;

  container.innerHTML = `
    <p><strong>${escapeHtml(focus)}</strong> • Current period: ${latest.trips} trips, ${latest.distance.toFixed(1)} mi, ${avgDistance.toFixed(1)} mi/trip.</p>
    <p>Distance change vs previous: ${escapeHtml(pctText)}. Previous period: ${previous ? `${previous.trips} trips, ${previous.distance.toFixed(1)} mi, ${previousAvgDistance.toFixed(1)} mi/trip` : "N/A"}.</p>
    <div class="trends-narrative-actions">
      <button type="button" class="btn btn-outline-primary btn-sm trends-drill-btn"
              data-start="${latest.start}" data-end="${latest.end}" data-label="${escapeHtml(latest.label)}">
        View Current Period Trips
      </button>
      ${previous ? `<button type="button" class="btn btn-outline-secondary btn-sm trends-drill-btn" data-start="${previous.start}" data-end="${previous.end}" data-label="${escapeHtml(previous.label)}">View Previous Period Trips</button>` : ""}
    </div>
  `;

  container.onclick = (event) => {
    const button = event.target.closest(".trends-drill-btn");
    if (!button) {
      return;
    }
    loadAndShowTripsForDrilldown("trips", {
      start: button.dataset.start,
      end: button.dataset.end,
      title: `Trips for ${button.dataset.label}`,
    });
  };
}

function renderTimeSignature(timeSignature = {}, currentTimeView = "hour") {
  const container = document.getElementById("time-signature");
  if (!container) {
    return;
  }

  const hourly = Array.isArray(timeSignature.hourly) ? timeSignature.hourly : new Array(24).fill(0);
  const maxHour = Math.max(...hourly, 1);

  const bars = hourly
    .map((count, hour) => {
      const strength = Math.max(0.08, count / maxHour);
      return `<span class="clock-bar" style="--index:${hour};--strength:${strength.toFixed(3)}"></span>`;
    })
    .join("");

  const peakHourLabel = formatHourLabel(timeSignature.peakHour || 0);
  const quietHourLabel = formatHourLabel(timeSignature.quietHour || 0);

  container.innerHTML = `
    <div class="signature-clock" aria-hidden="true">${bars}<div class="clock-center"></div></div>
    <div class="signature-copy">
      <p class="signature-kicker">Time signature (${escapeHtml(currentTimeView)})</p>
      <h3>${escapeHtml(timeSignature.dominantDaypartLabel || "Daytime")}</h3>
      <p>Peak window: <strong>${escapeHtml(peakHourLabel)}</strong> • Quiet window: <strong>${escapeHtml(quietHourLabel)}</strong></p>
      <p>Peak weekday: <strong>${escapeHtml(timeSignature.peakDayLabel || "-")}</strong> • Quiet weekday: <strong>${escapeHtml(timeSignature.quietDayLabel || "-")}</strong></p>
      <div class="trends-narrative-actions">
        <button type="button" class="btn btn-outline-primary btn-sm time-signature-action" data-time-type="hour" data-time-value="${Number(timeSignature.peakHour || 0)}">Peak Hour Trips</button>
        <button type="button" class="btn btn-outline-secondary btn-sm time-signature-action" data-time-type="day" data-time-value="${Number(timeSignature.peakDay || 0)}">Peak Weekday Trips</button>
      </div>
    </div>
  `;

  container.onclick = (event) => {
    const action = event.target.closest(".time-signature-action");
    if (!action) {
      return;
    }
    const timeType = action.dataset.timeType === "day" ? "day" : "hour";
    const rawValue = Number.parseInt(action.dataset.timeValue || "0", 10);
    const max = timeType === "day" ? 6 : 23;
    const timeValue = Math.min(Math.max(Number.isFinite(rawValue) ? rawValue : 0, 0), max);
    loadAndShowTripsForTimePeriod(timeType, timeValue);
  };
}

export function renderAllStorySections(stateData = {}) {
  const snapshot = deriveInsightsSnapshot(stateData);
  storyState.snapshot = snapshot;

  const mode = normalizePeriodMode(stateData.rhythmView || stateData.currentView);
  storyState.periodMode = mode;
  storyState.selectedPlaceIndex = 0;

  renderRhythmPeriodToggle(mode);
  renderRhythmStoryrail(snapshot.periods[mode]);
  renderInsightScenes(snapshot.patternCards);
  renderPlacesOrbit(snapshot.exploration);
  renderRecordsTimeline(stateData?.insights?.records || {});
  renderTrendsNarrative(snapshot, mode, stateData.currentView || "daily");
  renderTimeSignature(snapshot.timeSignature, stateData.currentTimeView || "hour");

  return snapshot;
}

export function updatePeriodStory(mode, currentView = "daily") {
  const nextMode = normalizePeriodMode(mode);
  if (!storyState.snapshot) {
    return;
  }

  storyState.periodMode = nextMode;
  renderRhythmPeriodToggle(nextMode);
  renderRhythmStoryrail(storyState.snapshot.periods[nextMode]);
  renderTrendsNarrative(storyState.snapshot, nextMode, currentView);
}

export function updateTimeSignatureStory(currentTimeView = "hour") {
  if (!storyState.snapshot) {
    return;
  }
  renderTimeSignature(storyState.snapshot.timeSignature, currentTimeView);
}

export function destroyStorySections() {
  storyState.snapshot = null;
  storyState.periodMode = "weekly";
  storyState.selectedPlaceIndex = 0;
  storyState.scenes = [];
}
