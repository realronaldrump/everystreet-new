import { escapeHtml } from "../../utils.js";
import { formatMiles, formatRelativeTime, getCoverageTierClass, normalizeCoveragePercent } from "./stats.js";

export function isJobActiveStatus(status) {
  return ["pending", "running"].includes(status);
}

export function isJobTerminalStatus(status) {
  return ["completed", "failed", "cancelled", "needs_attention"].includes(status);
}

// -----------------------------------------------------------------------------
// Status badge renderer (shared between list and card views)
// -----------------------------------------------------------------------------

function renderStatus(area, job) {
  const status = area?.status;
  const statusConfig = {
    ready:        { cls: "success", icon: "check-circle",   text: "Ready" },
    initializing: { cls: "info",    icon: "spinner fa-spin", text: "Setting up…" },
    rebuilding:   { cls: "warning", icon: "sync fa-spin",    text: "Rebuilding…" },
    error:        { cls: "danger",  icon: "exclamation-circle", text: "Error" },
  };

  const config = statusConfig[status] || statusConfig.error;
  const badge = `<span class="badge bg-${config.cls}">
    <i class="fas fa-${config.icon} me-1" aria-hidden="true"></i>${config.text}
  </span>`;

  if (status === "error") {
    const areaName = escapeHtml(area?.display_name || "Coverage area");
    return `
      <button type="button"
              class="coverage-error-trigger"
              data-error-action="show"
              data-area-id="${area.id}"
              data-area-name="${areaName}"
              title="View error details"
              aria-label="View error details for ${areaName}">
        <i class="fas fa-${config.icon} me-1" aria-hidden="true"></i>${config.text}
      </button>`;
  }

  if (job && isJobActiveStatus(job.status) &&
      (status === "initializing" || status === "rebuilding")) {
    const percent = typeof job.progress === "number" ? Math.round(job.progress) : 0;
    const detailText = job.message ? escapeHtml(job.message) : "Processing";
    return `
      <div class="coverage-job-status">
        ${badge}
        <div class="coverage-job-progress">
          <div class="progress" style="height: 6px;">
            <div class="progress-bar" role="progressbar"
                 style="width: ${percent}%"
                 aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
          <div class="small text-muted">${detailText}</div>
        </div>
      </div>`;
  }

  return badge;
}

// -----------------------------------------------------------------------------
// Coverage tier → card accent class
// -----------------------------------------------------------------------------

function getCoverageAccent(pct, status) {
  if (status === "error") return "danger";
  if (status !== "ready") return "secondary";
  if (pct >= 100) return "amber";
  if (pct >= 76)  return "success";
  if (pct >= 51)  return "info";
  if (pct >= 26)  return "warning";
  return "danger";
}

// -----------------------------------------------------------------------------
// Area card HTML
// -----------------------------------------------------------------------------

function renderAreaCard(area, job) {
  const pct = normalizeCoveragePercent(area.coverage_percentage);
  const accentClass = getCoverageAccent(pct, area.status);
  const tierClass = getCoverageTierClass(pct);
  const areaName = escapeHtml(area.display_name || "Coverage area");
  const isReady = area.status === "ready";
  const totalSegments = area.total_segments || 0;
  const drivenSegments = area.driven_segments || 0;
  const undriveableSegments = area.undriveable_segments || 0;
  const remainingSegments = Math.max(0, totalSegments - drivenSegments - undriveableSegments);

  // Small inline SVG ring (48px container, r=20, cx/cy=24)
  const MINI_R = 20;
  const miniCircumference = 2 * Math.PI * MINI_R;
  const miniOffset = miniCircumference - (pct / 100) * miniCircumference;

  return `
    <div class="area-card" data-area-id="${area.id}" data-accent="${accentClass}" role="listitem">
      <div class="area-card-header">
        <div class="area-card-title-group">
          <h3 class="area-card-title" title="${areaName}">${areaName}</h3>
          <span class="area-type-badge">${escapeHtml(area.area_type || "")}</span>
        </div>
        <div class="area-card-status">${renderStatus(area, job)}</div>
      </div>

      <div class="area-card-progress">
        <div class="area-mini-ring" aria-hidden="true">
          <svg class="area-mini-ring-svg"
               width="48" height="48"
               viewBox="0 0 48 48">
            <circle class="ring-track"
                    cx="24" cy="24" r="${MINI_R}"
                    fill="none" stroke-width="4" />
            <circle class="ring-fill ${tierClass}"
                    cx="24" cy="24" r="${MINI_R}"
                    fill="none" stroke-width="4"
                    stroke-linecap="round"
                    transform="rotate(-90 24 24)"
                    style="stroke-dasharray: ${miniCircumference.toFixed(2)}; stroke-dashoffset: ${miniOffset.toFixed(2)};" />
          </svg>
        </div>
        <div class="area-progress-text">
          <span class="area-pct-large">${pct.toFixed(1)}%</span>
          <span class="area-pct-sub">${formatMiles(area.driven_length_miles)} driven</span>
        </div>
      </div>

      <div class="area-card-stats">
        <div class="area-stat">
          <i class="fas fa-road text-danger" aria-hidden="true"></i>
          <span>${remainingSegments.toLocaleString()} segment${remainingSegments !== 1 ? "s" : ""} remaining</span>
        </div>
        <div class="area-stat">
          <i class="fas fa-ruler-horizontal text-secondary" aria-hidden="true"></i>
          <span>${formatMiles(area.total_length_miles)} total</span>
        </div>
        <div class="area-stat">
          <i class="fas fa-clock text-secondary" aria-hidden="true"></i>
          <span>${area.last_synced ? formatRelativeTime(area.last_synced) : "Never synced"}</span>
        </div>
      </div>

      <div class="area-card-footer">
        <button class="btn btn-primary btn-sm flex-grow-1"
                data-area-action="view"
                data-area-id="${area.id}"
                ${!isReady ? "disabled" : ""}
                aria-label="Explore coverage map for ${areaName}">
          <i class="fas fa-map me-1" aria-hidden="true"></i>Explore Map
        </button>

        <div class="dropdown">
          <button class="btn btn-outline-secondary btn-sm dropdown-toggle dropdown-toggle-split"
                  data-bs-toggle="dropdown"
                  aria-expanded="false"
                  aria-label="More actions for ${areaName}">
            <i class="fas fa-ellipsis-v" aria-hidden="true"></i>
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li>
              <button class="dropdown-item"
                      data-area-action="recalculate"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}"
                      ${!isReady ? "disabled" : ""}>
                <i class="fas fa-calculator me-2" aria-hidden="true"></i>Recalculate
              </button>
            </li>
            <li>
              <button class="dropdown-item"
                      data-area-action="rebuild"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}"
                      ${!isReady ? "disabled" : ""}>
                <i class="fas fa-sync me-2" aria-hidden="true"></i>Rebuild from OSM
              </button>
            </li>
            <li><hr class="dropdown-divider"></li>
            <li>
              <button class="dropdown-item text-danger"
                      data-area-action="delete"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}">
                <i class="fas fa-trash me-2" aria-hidden="true"></i>Delete
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Public: renderAreaCards
// -----------------------------------------------------------------------------

/**
 * Renders the coverage area cards grid.
 * Replaces the old renderAreasTable function.
 *
 * @param {object} options
 * @param {Array}  options.areas                - Coverage area objects from API
 * @param {Map}    options.activeJobsByAreaId   - Map of areaId → job object
 * @param {Map}    options.areaErrorById        - Map to populate: areaId → error string
 * @param {Map}    options.areaNameById         - Map to populate: areaId → display name
 * @returns {{ hasAreas: boolean }}
 */
export function renderAreaCards({ areas, activeJobsByAreaId, areaErrorById, areaNameById }) {
  const grid = document.getElementById("area-cards-grid");
  const loading = document.getElementById("area-cards-loading");
  const emptyState = document.getElementById("area-empty-state");

  // Hide skeleton loader once we have data
  if (loading) loading.style.display = "none";

  if (!grid) return { hasAreas: false };

  if (!areas || areas.length === 0) {
    areaErrorById.clear();
    areaNameById.clear();
    grid.innerHTML = "";
    grid.style.display = "none";
    emptyState?.classList.remove("d-none");
    return { hasAreas: false };
  }

  emptyState?.classList.add("d-none");
  areaErrorById.clear();
  areaNameById.clear();

  areas.forEach((area) => {
    areaErrorById.set(area.id, area.last_error || "");
    areaNameById.set(area.id, area.display_name || "Coverage area");
  });

  grid.innerHTML = areas
    .map((area) => renderAreaCard(area, activeJobsByAreaId.get(area.id)))
    .join("");

  grid.style.display = "";
  return { hasAreas: true };
}
