import { escapeHtml } from "../../utils.js";
import {
  formatMiles,
  formatRelativeTime,
  getCoverageTierClass,
  normalizeCoveragePercent,
} from "./stats.js";

export function isJobActiveStatus(status) {
  return ["pending", "running"].includes(status);
}

export function isJobTerminalStatus(status) {
  return ["completed", "failed", "cancelled", "needs_attention"].includes(status);
}

// -----------------------------------------------------------------------------
// Status badge renderer (shared between list and card views)
// -----------------------------------------------------------------------------

function hasActiveJob(job) {
  return Boolean(job && isJobActiveStatus(job.status));
}

function renderRouteStatus(area, routeJob) {
  const hasActiveRouteJob = hasActiveJob(routeJob);
  const hasSavedRoute = Boolean(
    area?.has_optimal_route || area?.optimal_route_generated_at
  );

  if (!hasActiveRouteJob && !hasSavedRoute) {
    return "";
  }

  if (hasActiveRouteJob) {
    const percent =
      typeof routeJob.progress === "number" ? Math.round(routeJob.progress) : 0;
    const detailText = routeJob.message
      ? escapeHtml(routeJob.message)
      : "Generating optimal route";
    return `
      <div class="area-route-status" aria-live="polite">
        <div class="area-route-status-header">
          <div class="area-route-label">
            <i class="fas fa-route text-info" aria-hidden="true"></i>
            <span>Optimal Route</span>
          </div>
          <span class="badge bg-info">Generating…</span>
        </div>
        <div class="coverage-job-progress">
          <div class="progress" style="height: 6px;">
            <div class="progress-bar bg-info" role="progressbar"
                 style="width: ${percent}%"
                 aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
          <div class="small text-muted">${detailText}</div>
        </div>
      </div>`;
  }

  const generatedText = area?.optimal_route_generated_at
    ? `Updated ${formatRelativeTime(area.optimal_route_generated_at)}`
    : "Ready to load in navigation";

  return `
    <div class="area-route-status area-route-status--ready">
      <div class="area-route-status-header">
        <div class="area-route-label">
          <i class="fas fa-route text-success" aria-hidden="true"></i>
          <span>Optimal Route</span>
        </div>
        <span class="badge bg-success">Ready</span>
      </div>
      <div class="area-route-meta small text-muted">${escapeHtml(generatedText)}</div>
    </div>`;
}

function renderStatus(area, coverageJob) {
  const status = area?.status;
  const statusConfig = {
    ready: { cls: "success", icon: "check-circle", text: "Ready" },
    initializing: { cls: "info", icon: "spinner fa-spin", text: "Setting up…" },
    rebuilding: { cls: "warning", icon: "sync fa-spin", text: "Rebuilding…" },
    error: { cls: "danger", icon: "exclamation-circle", text: "Error" },
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

  if (
    coverageJob &&
    isJobActiveStatus(coverageJob.status) &&
    (status === "initializing" || status === "rebuilding")
  ) {
    const percent =
      typeof coverageJob.progress === "number" ? Math.round(coverageJob.progress) : 0;
    const detailText = coverageJob.message
      ? escapeHtml(coverageJob.message)
      : "Processing";
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
  if (status === "error") {
    return "danger";
  }
  if (status !== "ready") {
    return "secondary";
  }
  if (pct >= 100) {
    return "amber";
  }
  if (pct >= 76) {
    return "success";
  }
  if (pct >= 51) {
    return "info";
  }
  if (pct >= 26) {
    return "warning";
  }
  return "danger";
}

const US_STATE_NAME_TO_CODE = Object.freeze({
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "american samoa": "AS",
  guam: "GU",
  "northern mariana islands": "MP",
  "puerto rico": "PR",
  "us virgin islands": "VI",
  "u.s. virgin islands": "VI",
  "virgin islands": "VI",
});

const US_STATE_CODES = new Set(Object.values(US_STATE_NAME_TO_CODE));

function parseUsStateCode(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) {
    return "";
  }

  const upper = label.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && US_STATE_CODES.has(upper)) {
    return upper;
  }

  return US_STATE_NAME_TO_CODE[label.toLowerCase()] || "";
}

function formatCityDisplayName(displayName) {
  const rawName = typeof displayName === "string" ? displayName.trim() : "";
  if (!rawName) {
    return "Coverage area";
  }

  const parts = rawName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return rawName;
  }

  const cityName = parts[0];
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const stateCode = parseUsStateCode(parts[index]);
    if (stateCode) {
      return `${cityName}, ${stateCode}`;
    }
  }

  return rawName;
}

// -----------------------------------------------------------------------------
// Area card HTML
// -----------------------------------------------------------------------------

function renderAreaCard(area, coverageJob, routeJob) {
  const pct = normalizeCoveragePercent(area.coverage_percentage);
  const accentClass = getCoverageAccent(pct, area.status);
  const tierClass = getCoverageTierClass(pct);
  const normalizedAreaType = String(area.area_type || "")
    .trim()
    .toLowerCase();
  const displayName =
    normalizedAreaType === "city"
      ? formatCityDisplayName(area.display_name)
      : area.display_name || "Coverage area";
  const areaName = escapeHtml(displayName);
  const isReady = area.status === "ready";
  const hasActiveCoverageJob = hasActiveJob(coverageJob);
  const hasActiveRouteJob = hasActiveJob(routeJob);
  const hasSavedRoute = Boolean(
    area.has_optimal_route || area.optimal_route_generated_at
  );
  const totalSegments = area.total_segments || 0;
  const drivenSegments = area.driven_segments || 0;
  const undriveableSegments = area.undriveable_segments || 0;
  const remainingSegments = Math.max(
    0,
    totalSegments - drivenSegments - undriveableSegments
  );

  // Small inline SVG ring (48px container, r=20, cx/cy=24)
  const MINI_R = 20;
  const miniCircumference = 2 * Math.PI * MINI_R;
  const miniOffset = miniCircumference - (pct / 100) * miniCircumference;
  const routeStatus = renderRouteStatus(area, routeJob);
  const routeMenuLabel = hasSavedRoute
    ? "Regenerate Optimal Route"
    : "Generate Optimal Route";
  const routeMenuAction = hasSavedRoute ? "restart-route" : "generate-route";

  return `
    <div class="area-card" data-area-id="${area.id}" data-accent="${accentClass}" role="listitem">
      <div class="area-card-header">
        <div class="area-card-title-group">
          <h3 class="area-card-title" title="${areaName}">${areaName}</h3>
          <span class="area-type-badge">${escapeHtml(area.area_type || "")}</span>
        </div>
        <div class="area-card-status">${renderStatus(area, coverageJob)}</div>
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

      ${routeStatus}

      <div class="area-card-footer">
        <button class="btn btn-primary btn-sm flex-grow-1"
                data-area-action="view"
                data-area-id="${area.id}"
                ${!isReady ? "disabled" : ""}
                aria-label="Explore coverage map for ${areaName}">
          <i class="fas fa-map me-1" aria-hidden="true"></i>Explore Map
        </button>

        ${
          hasActiveRouteJob
            ? `
          <button class="btn btn-outline-danger btn-sm"
                  type="button"
                  data-area-action="cancel-route"
                  data-area-id="${area.id}"
                  data-area-name="${areaName}"
                  aria-label="Stop optimal route generation for ${areaName}">
            <i class="fas fa-stop-circle me-1" aria-hidden="true"></i>Stop Route
          </button>`
            : ""
        }

        <div class="dropdown">
          <button class="btn btn-outline-secondary btn-sm dropdown-toggle dropdown-toggle-split"
                  data-bs-toggle="dropdown"
                  aria-expanded="false"
                  aria-label="More actions for ${areaName}">
            <i class="fas fa-ellipsis-v" aria-hidden="true"></i>
          </button>
          <ul class="dropdown-menu dropdown-menu-end">
            ${
              hasActiveRouteJob
                ? `
              <li>
                <button class="dropdown-item"
                        data-area-action="restart-route"
                        data-area-id="${area.id}"
                        data-area-name="${areaName}">
                  <i class="fas fa-rotate-right me-2" aria-hidden="true"></i>Restart Optimal Route
                </button>
              </li>
              <li>
                <button class="dropdown-item text-danger"
                        data-area-action="cancel-route"
                        data-area-id="${area.id}"
                        data-area-name="${areaName}">
                  <i class="fas fa-stop-circle me-2" aria-hidden="true"></i>Stop Route Generation
                </button>
              </li>
              <li><hr class="dropdown-divider"></li>`
                : isReady
                  ? `
              <li>
                <button class="dropdown-item"
                        data-area-action="${routeMenuAction}"
                        data-area-id="${area.id}"
                        data-area-name="${areaName}">
                  <i class="fas fa-route me-2" aria-hidden="true"></i>${routeMenuLabel}
                </button>
              </li>
              <li><hr class="dropdown-divider"></li>`
                  : ""
            }
            ${
              hasActiveCoverageJob
                ? `
              <li>
                <button class="dropdown-item text-danger"
                        data-area-action="cancel-job"
                        data-area-id="${area.id}"
                        data-area-name="${areaName}">
                  <i class="fas fa-stop-circle me-2" aria-hidden="true"></i>Stop Active Job
                </button>
              </li>
              <li><hr class="dropdown-divider"></li>`
                : ""
            }
            <li>
              <button class="dropdown-item"
                      data-area-action="recalculate"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}"
                      ${!isReady ? "disabled" : ""}>
                <i class="fas fa-calculator me-2" aria-hidden="true"></i>Recalculate Street Coverage
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
 *
 * @param {object} options
 * @param {Array}  options.areas                - Coverage area objects from API
 * @param {Map}    options.activeJobsByAreaId   - Map of areaId → job object
 * @param {Map}    options.areaErrorById        - Map to populate: areaId → error string
 * @param {Map}    options.areaNameById         - Map to populate: areaId → display name
 * @returns {{ hasAreas: boolean }}
 */
export function renderAreaCards({
  areas,
  activeJobsByAreaId = new Map(),
  activeRouteJobsByAreaId = new Map(),
  areaErrorById,
  areaNameById,
}) {
  const grid = document.getElementById("area-cards-grid");
  const loading = document.getElementById("area-cards-loading");
  const emptyState = document.getElementById("area-empty-state");

  // Hide skeleton loader once we have data
  if (loading) {
    loading.style.display = "none";
  }

  if (!grid) {
    return { hasAreas: false };
  }

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
    .map((area) =>
      renderAreaCard(
        area,
        activeJobsByAreaId.get(area.id),
        activeRouteJobsByAreaId.get(area.id)
      )
    )
    .join("");

  grid.style.display = "grid";
  return { hasAreas: true };
}
