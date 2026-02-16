/**
 * Story Sections Module
 * Renders the narrative insights experience (storyrail, scenes, orbit, timeline).
 */

import { escapeHtml, formatHourLabel } from "../utils.js";
import { fetchDrilldownTrips } from "./api.js";
import { deriveInsightsSnapshot } from "./derived-insights.js";
import { formatDuration, getDateRange } from "./formatters.js";
import { displayTripsInModal, loadAndShowTripsForDrilldown } from "./modal.js";

const storyState = {
  snapshot: null,
  periodMode: "weekly",
  selectedPlaceIndex: 0,
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

function renderRhythmStoryrail(periods = [], mode = "weekly") {
  const container = document.getElementById("rhythm-storyrail");
  if (!container) {
    return;
  }

  if (!periods.length) {
    container.innerHTML = '<div class="story-empty">Not enough trip history yet to build period stories.</div>';
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
          ${sparklineSvg(sparkWindow)}
          <div class="storyrail-meta">
            <span>${period.trips} trips</span>
            <span>${period.distance.toFixed(1)} mi</span>
            <span>${mode === "weekly" ? "week" : "month"}</span>
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

  if (!scenes.length) {
    container.innerHTML = '<div class="story-empty">No scenes yet. Drive a bit more to unlock insights.</div>';
    return;
  }

  container.innerHTML = scenes
    .map(
      (scene) => `
        <article class="scene-card tone-${scene.tone || "mint"}">
          <div class="scene-icon"><i class="fas ${escapeHtml(scene.icon || "fa-circle")}"></i></div>
          <p class="scene-title">${escapeHtml(scene.title || "Insight")}</p>
          <p class="scene-value">${escapeHtml(scene.value || "-")}</p>
          <p class="scene-detail">${escapeHtml(scene.detail || "")}</p>
        </article>
      `
    )
    .join("");
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
    container.innerHTML = '<div class="story-empty">No record highlights for this range yet.</div>';
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
    container.textContent = "Narrative summary will appear after a few trips in this range.";
    return;
  }

  const focus = currentView === "daily" ? "daily detail" : `${mode} rhythm`;
  const trendText =
    latest.distanceDeltaPct == null
      ? "This is your first comparable period in this range."
      : latest.distanceDeltaPct >= 0
        ? `Distance is up ${latest.distanceDeltaPct.toFixed(1)}% from the prior period.`
        : `Distance is down ${Math.abs(latest.distanceDeltaPct).toFixed(1)}% from the prior period.`;

  const previousText = previous
    ? `Previous period logged ${previous.trips} trips across ${previous.distance.toFixed(1)} miles.`
    : "More context appears as additional periods become available.";

  container.innerHTML = `
    <p><strong>${escapeHtml(latest.headline)}</strong> (${escapeHtml(focus)}). ${escapeHtml(trendText)}</p>
    <p>${escapeHtml(previousText)}</p>
  `;
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
    </div>
  `;
}

export function renderAllStorySections(stateData = {}) {
  const snapshot = deriveInsightsSnapshot(stateData);
  storyState.snapshot = snapshot;

  const mode = normalizePeriodMode(stateData.rhythmView || stateData.currentView);
  storyState.periodMode = mode;
  storyState.selectedPlaceIndex = 0;

  renderRhythmPeriodToggle(mode);
  renderRhythmStoryrail(snapshot.periods[mode], mode);
  renderInsightScenes(snapshot.narrativeScenes);
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
  renderRhythmStoryrail(storyState.snapshot.periods[nextMode], nextMode);
  renderTrendsNarrative(storyState.snapshot, nextMode, currentView);
}

export function updateTimeSignatureStory(currentTimeView = "hour") {
  if (!storyState.snapshot) {
    return;
  }
  renderTimeSignature(storyState.snapshot.timeSignature, currentTimeView);
}

export function getStorySnapshot() {
  return storyState.snapshot;
}

export function destroyStorySections() {
  storyState.snapshot = null;
  storyState.periodMode = "weekly";
  storyState.selectedPlaceIndex = 0;
}
