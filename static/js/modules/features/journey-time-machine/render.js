import { EVENT_TYPES, eventTypeLabel, state } from "./state.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTimestamp(iso) {
  if (!iso) {
    return "Unknown time";
  }

  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) {
      return "Unknown time";
    }
    return dt.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "Unknown time";
  }
}

function eventTypeIcon(type) {
  switch (type) {
    case "trip":
      return "fa-road";
    case "visit":
      return "fa-location-dot";
    case "fuel":
      return "fa-gas-pump";
    case "coverage":
      return "fa-map";
    case "map_matching":
      return "fa-route";
    default:
      return "fa-clock";
  }
}

function formatMetricValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "--";
    }
    if (Math.abs(value) >= 1000) {
      return value.toLocaleString();
    }
    if (Math.abs(value) >= 100) {
      return value.toFixed(0);
    }
    if (Math.abs(value) >= 10) {
      return value.toFixed(1);
    }
    return value.toFixed(2);
  }
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  return String(value);
}

function formatMetricLabel(key) {
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function updateFeedStatus(text, isError = false) {
  const statusEl = document.getElementById("journey-feed-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = text || "";
  statusEl.classList.toggle("is-error", Boolean(isError));
}

export function updateFeedCount(count) {
  const countEl = document.getElementById("journey-feed-count");
  if (!countEl) {
    return;
  }
  const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
  const label = safeCount === 1 ? "event" : "events";
  countEl.textContent = `${safeCount} ${label}`;
}

export function renderFilterChips(onToggleType) {
  const root = document.getElementById("journey-filter-chips");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  EVENT_TYPES.forEach((type) => {
    if (state.errors && state.errors[type]) {
      return;
    }
    const active = state.activeTypes.has(type);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "journey-chip";
    button.dataset.type = type;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("is-active", active);
    button.textContent = eventTypeLabel(type);
    button.addEventListener("click", () => onToggleType(type));
    root.appendChild(button);
  });
}

export function renderFeedList(events = [], activeEventId, onSelect) {
  const listEl = document.getElementById("journey-feed-list");
  const emptyEl = document.getElementById("journey-feed-empty");
  if (!listEl) {
    return;
  }

  listEl.innerHTML = "";
  const hasEvents = Array.isArray(events) && events.length > 0;
  emptyEl?.classList.toggle("d-none", hasEvents);

  if (!hasEvents) {
    return;
  }

  const fragment = document.createDocumentFragment();

  events.forEach((event, index) => {
    const isActive = event.id === activeEventId;

    const item = document.createElement("button");
    item.type = "button";
    item.className = "journey-event-card";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isActive ? "true" : "false");
    item.dataset.eventId = event.id;
    item.classList.toggle("is-active", isActive);

    const typeBadge = eventTypeLabel(event.type);
    const icon = eventTypeIcon(event.type);

    item.innerHTML = `
      <span class="journey-event-meta">
        <span class="journey-event-badge journey-type-${event.type}">
          <i class="fas ${icon}" aria-hidden="true"></i>
          ${escapeHtml(typeBadge)}
        </span>
        <time class="journey-event-time">${escapeHtml(formatTimestamp(event.timestamp))}</time>
      </span>
      <span class="journey-event-title">${escapeHtml(event.title || "Event")}</span>
      <span class="journey-event-summary">${escapeHtml(event.summary || "")}</span>
    `;

    item.style.setProperty("--journey-index", String(index));
    item.addEventListener("click", () => onSelect(event.id));
    fragment.appendChild(item);
  });

  listEl.appendChild(fragment);
}

export function renderInspector(event) {
  const inspectorEl = document.getElementById("journey-inspector");
  const sourceEl = document.getElementById("journey-open-source");
  const timestampEl = document.getElementById("journey-current-timestamp");

  if (timestampEl) {
    timestampEl.textContent = event ? formatTimestamp(event.timestamp) : "--:--";
  }

  if (!inspectorEl || !sourceEl) {
    return;
  }

  if (!event) {
    inspectorEl.innerHTML =
      '<p class="journey-inspector-empty">Select an event from the timeline to inspect details.</p>';
    sourceEl.classList.add("is-disabled");
    sourceEl.setAttribute("aria-disabled", "true");
    sourceEl.setAttribute("href", "#");
    return;
  }

  const metrics = event.metrics || {};
  const metricsEntries = Object.entries(metrics);
  const metricsHtml =
    metricsEntries.length > 0
      ? `<div class="journey-metrics-grid">${metricsEntries
          .map(
            ([key, value]) => `
              <article class="journey-metric-item">
                <span class="journey-metric-label">${escapeHtml(formatMetricLabel(key))}</span>
                <span class="journey-metric-value">${escapeHtml(formatMetricValue(value))}</span>
              </article>
            `
          )
          .join("")}</div>`
      : '<p class="journey-inspector-empty">No metrics available for this event.</p>';

  inspectorEl.innerHTML = `
    <header class="journey-inspector-header">
      <span class="journey-inspector-type">${escapeHtml(eventTypeLabel(event.type))}</span>
      <h4 class="journey-inspector-title">${escapeHtml(event.title || "Event")}</h4>
      <p class="journey-inspector-summary">${escapeHtml(event.summary || "")}</p>
      <time class="journey-inspector-time">${escapeHtml(formatTimestamp(event.timestamp))}</time>
    </header>
    ${metricsHtml}
  `;

  if (event.source_url) {
    sourceEl.classList.remove("is-disabled");
    sourceEl.setAttribute("aria-disabled", "false");
    sourceEl.setAttribute("href", event.source_url);
  } else {
    sourceEl.classList.add("is-disabled");
    sourceEl.setAttribute("aria-disabled", "true");
    sourceEl.setAttribute("href", "#");
  }
}

export function renderSourceErrors(errors = {}) {
  const errorEntries = Object.entries(errors).filter(([, value]) => Boolean(value));
  if (errorEntries.length === 0) {
    return;
  }

  const message = errorEntries
    .map(([source]) => `${eventTypeLabel(source)} unavailable`)
    .join(" · ");
  updateFeedStatus(message, true);
}
