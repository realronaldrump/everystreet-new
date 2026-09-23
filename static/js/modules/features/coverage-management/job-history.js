/**
 * The area sidebar's History tab: coverage job history and recent driving
 * activity, loaded when the tab opens.
 */

import { escapeHtml } from "../../utils.js";
import { formatMiles } from "../coverage-journal/format.js";
import { formatRelativeTime } from "./stats.js";
import { apiGet, state } from "./context.js";
import { HIGHLIGHT_LAYER_ID } from "./street-map.js";

// =============================================================================
// Job History
// =============================================================================

export async function loadDrivingActivity(areaId) {
  const container = document.getElementById("driving-activity-container");
  if (!container) {
    return;
  }

  container.innerHTML = `<p class="text-secondary small text-center mt-3">
    <i class="fas fa-spinner fa-spin me-1" aria-hidden="true"></i>Loading activity…
  </p>`;

  try {
    const data = await apiGet(
      `/areas/${areaId}/journal/contributions?range=all&source=all&limit=8`
    );
    if (areaId !== state.currentAreaId) {
      return;
    }
    renderDrivingActivity(data.contributions || []);
  } catch {
    if (areaId !== state.currentAreaId) {
      return;
    }
    container.innerHTML =
      '<p class="text-secondary small text-center mt-3">Could not load driving activity.</p>';
  }
}

function renderDrivingActivity(activity) {
  const container = document.getElementById("driving-activity-container");
  if (!container) {
    return;
  }

  if (!activity.length) {
    container.innerHTML = `<div class="activity-empty">
      <i class="fas fa-flag-checkered me-1" aria-hidden="true"></i>
      No drives here yet.
    </div>`;
    return;
  }

  const items = activity
    .map((entry) => {
      const isManual = entry.source === "manual";
      let iconClass = "activity-icon";
      let icon = "fa-route";
      let label = "Trip";
      if (isManual) {
        iconClass += " activity-icon--manual";
        icon = "fa-hand-pointer";
        label =
          entry.action === "mark_undriven"
            ? "Marked not driven"
            : entry.action === "mark_undriveable"
              ? "Marked undriveable"
              : "Marked driven";
      }
      const length = Number(entry.new_miles) > 0 ? `+${formatMiles(entry.new_miles, 2)}` : "";
      const segmentCount = Number(entry.new_segments || 0);
      const meta = [
        label,
        length,
        segmentCount ? `${segmentCount} segment${segmentCount === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" • ");
      const time = entry.occurred_at ? formatRelativeTime(entry.occurred_at) : "";
      const safeName = escapeHtml(
        entry.street_names?.length ? entry.street_names.join(", ") : "Unnamed roads"
      );
      const segmentId = escapeHtml(
        entry.new_segment_ids?.[0] || entry.segment_ids?.[0] || ""
      );
      return `<button type="button"
                       class="activity-item"
                       data-segment-id="${segmentId}"
                       title="Focus on ${safeName}">
        <span class="${iconClass}" aria-hidden="true">
          <i class="fas ${icon}"></i>
        </span>
        <span class="activity-body">
          <span class="activity-name">${safeName}</span>
          <span class="activity-meta">${escapeHtml(meta)}</span>
        </span>
        <span class="activity-time">${escapeHtml(time)}</span>
      </button>`;
    })
    .join("");

  container.innerHTML = `<div class="activity-list">${items}</div>`;

  container.querySelectorAll(".activity-item").forEach((el) => {
    el.addEventListener("click", () => {
      const segmentId = el.getAttribute("data-segment-id");
      if (segmentId) {
        focusSegmentOnMap(segmentId);
      }
    });
  });
}

function focusSegmentOnMap(segmentId) {
  if (!state.map || !segmentId || !state.streetsCacheGeojson) {
    return;
  }
  const features = state.streetsCacheGeojson.features || [];
  const feature = features.find((f) => f?.properties?.segment_id === segmentId);
  if (!feature || !feature.geometry) {
    return;
  }
  try {
    const coords =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates.flat()
        : feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) {
      return;
    }
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2) {
        continue;
      }
      const [lon, lat] = c;
      if (lon < minLon) {
        minLon = lon;
      }
      if (lat < minLat) {
        minLat = lat;
      }
      if (lon > maxLon) {
        maxLon = lon;
      }
      if (lat > maxLat) {
        maxLat = lat;
      }
    }
    if (!Number.isFinite(minLon)) {
      return;
    }
    state.map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 80, maxZoom: 17, duration: 600 }
    );
    if (state.map.setFilter) {
      state.map.setFilter(HIGHLIGHT_LAYER_ID, ["==", ["get", "segment_id"], segmentId]);
    }
  } catch {
    /* ignore */
  }
}

export async function loadJobHistory(areaId) {
  const container = document.getElementById("job-history-container");
  if (!container) {
    return;
  }

  container.innerHTML = `<p class="text-secondary small text-center mt-3">
    <i class="fas fa-spinner fa-spin me-1" aria-hidden="true"></i>Loading jobs…
  </p>`;

  try {
    const data = await apiGet(`/areas/${areaId}/jobs`);
    if (areaId !== state.currentAreaId) {
      return;
    }
    renderJobHistory(data.jobs || []);
  } catch {
    if (areaId !== state.currentAreaId) {
      return;
    }
    container.innerHTML =
      '<p class="text-secondary small text-center mt-3">Could not load job history.</p>';
  }
}

function renderJobHistory(jobs) {
  const container = document.getElementById("job-history-container");
  if (!container) {
    return;
  }

  if (!jobs.length) {
    container.innerHTML =
      '<p class="text-secondary small text-center mt-4">No recent jobs found.</p>';
    return;
  }

  const typeLabels = {
    area_ingestion: "Setup",
    area_rebuild: "Street rebuild",
    area_backfill: "Recalculation",
    optimal_route: "Optimal route",
  };

  const statusIcons = {
    completed:
      '<i class="fas fa-check-circle text-success" aria-label="Completed"></i>',
    failed: '<i class="fas fa-exclamation-circle text-danger" aria-label="Failed"></i>',
    running: '<i class="fas fa-spinner fa-spin text-info" aria-label="Running"></i>',
    pending: '<i class="fas fa-clock text-warning" aria-label="Pending"></i>',
    cancelled:
      '<i class="fas fa-times-circle text-secondary" aria-label="Cancelled"></i>',
  };

  container.innerHTML = `<div class="job-history-list">
    ${jobs
      .map(
        (job) => `
      <div class="job-history-item">
        <div class="job-history-header">
          <span class="job-history-type">
            ${statusIcons[job.status] || ""}
            ${escapeHtml(typeLabels[job.job_type] || job.job_type || "Job")}
          </span>
          <span class="job-history-time">${job.created_at ? formatRelativeTime(job.created_at) : ""}</span>
        </div>
        ${job.message ? `<div class="job-history-message">${escapeHtml(job.message)}</div>` : ""}
      </div>`
      )
      .join("")}
  </div>`;
}
