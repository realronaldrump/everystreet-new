import { escapeHtml } from "../../utils.js";
import {
  formatDate,
  formatMiles,
  formatPercent,
  plural,
} from "../coverage-journal/format.js";
import { splitAreaName } from "./area-name.js";
import { formatRelativeTime, normalizeCoveragePercent } from "./stats.js";

export const DEFAULT_AREA_SORT = "coverage-desc";
const AREA_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function compareAreaNames(a, b) {
  const byName = AREA_NAME_COLLATOR.compare(
    String(a?.display_name || ""),
    String(b?.display_name || "")
  );
  return byName || String(a?.id || "").localeCompare(String(b?.id || ""));
}

function compareAreaDates(a, b, field, direction) {
  const aTimestamp = Date.parse(a?.[field] || "");
  const bTimestamp = Date.parse(b?.[field] || "");
  const aHasDate = Number.isFinite(aTimestamp);
  const bHasDate = Number.isFinite(bTimestamp);

  if (aHasDate !== bHasDate) {
    return aHasDate ? -1 : 1;
  }
  if (aHasDate && aTimestamp !== bTimestamp) {
    return direction === "asc" ? aTimestamp - bTimestamp : bTimestamp - aTimestamp;
  }
  return compareAreaNames(a, b);
}

/**
 * Return a sorted copy of the coverage areas for list and batch displays.
 */
export function sortCoverageAreas(areas, sortKey = DEFAULT_AREA_SORT) {
  const sortedAreas = Array.isArray(areas) ? [...areas] : [];
  const comparators = {
    "coverage-desc": (a, b) =>
      normalizeCoveragePercent(b?.coverage_percentage) -
        normalizeCoveragePercent(a?.coverage_percentage) || compareAreaNames(a, b),
    "coverage-asc": (a, b) =>
      normalizeCoveragePercent(a?.coverage_percentage) -
        normalizeCoveragePercent(b?.coverage_percentage) || compareAreaNames(a, b),
    "size-desc": (a, b) =>
      (b?.total_length_miles ?? 0) - (a?.total_length_miles ?? 0) ||
      compareAreaNames(a, b),
    "size-asc": (a, b) =>
      (a?.total_length_miles ?? 0) - (b?.total_length_miles ?? 0) ||
      compareAreaNames(a, b),
    "created-desc": (a, b) => compareAreaDates(a, b, "created_at", "desc"),
    "created-asc": (a, b) => compareAreaDates(a, b, "created_at", "asc"),
    "name-asc": compareAreaNames,
    "name-desc": (a, b) => compareAreaNames(b, a),
    "synced-desc": (a, b) => compareAreaDates(a, b, "last_synced", "desc"),
  };
  sortedAreas.sort(comparators[sortKey] || comparators[DEFAULT_AREA_SORT]);
  return sortedAreas;
}

function isJobActiveStatus(status) {
  return ["pending", "running"].includes(status);
}

// -----------------------------------------------------------------------------
// Status badge renderer (shared between list and card views)
// -----------------------------------------------------------------------------

function hasActiveJob(job) {
  return Boolean(job && isJobActiveStatus(job.status));
}

function renderRouteStatus(area, routeJob) {
  const hasActiveRouteJob = hasActiveJob(routeJob);
  const hasSavedRoute = Boolean(area?.has_optimal_route);

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
          <div class="progress coverage-job-progress-bar">
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
  if (coverageJob && isJobActiveStatus(coverageJob.status)) {
    return `
      <span class="coverage-job-status-chip">
        <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
        <span>Calculating</span>
      </span>`;
  }

  // A ready area needs no badge; only work in progress and failures do.
  if (status === "ready") {
    return "";
  }
  const statusConfig = {
    initializing: { cls: "info", icon: "spinner fa-spin", text: "Setting up" },
    rebuilding: { cls: "warning", icon: "sync fa-spin", text: "Rebuilding" },
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

  return badge;
}

function renderCoverageJobPanel(coverageJob) {
  if (!hasActiveJob(coverageJob)) {
    return "";
  }

  const percent =
    typeof coverageJob.progress === "number" ? Math.round(coverageJob.progress) : 0;
  const detailText = coverageJob.message
    ? escapeHtml(coverageJob.message)
    : "Processing coverage area";

  return `
    <div class="area-job-panel" aria-live="polite">
      <div class="area-job-panel-header">
        <span class="area-job-panel-label">
          <i class="fas fa-layer-group" aria-hidden="true"></i>
          Coverage calculation
        </span>
        <span class="area-job-panel-percent">${percent}%</span>
      </div>
      <div class="coverage-job-progress">
        <div class="progress coverage-job-progress-bar">
          <div class="progress-bar" role="progressbar"
               style="width: ${percent}%"
               aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div>
        </div>
      </div>
      <div class="area-job-panel-message">${detailText}</div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Area card HTML
// -----------------------------------------------------------------------------

function renderAreaCard(area, coverageJob, routeJob) {
  const pct = normalizeCoveragePercent(area.coverage_percentage);
  const { name, region } = splitAreaName(area.display_name);
  const areaName = escapeHtml(name);
  const isReady = area.status === "ready";
  const canRebuild = area.status === "ready" || area.status === "error";
  const isError = area.status === "error";
  const isComplete = isReady && area.is_complete === true;
  const hasActiveCoverageJob = hasActiveJob(coverageJob);
  const hasActiveRouteJob = hasActiveJob(routeJob);
  const hasSavedRoute = Boolean(area.has_optimal_route);
  const totalSegments = area.total_segments || 0;
  const drivenSegments = area.driven_segments || 0;
  const undriveableSegments = area.undriveable_segments || 0;
  const remainingSegments = Math.max(
    0,
    totalSegments - drivenSegments - undriveableSegments
  );
  const driveableMiles = Number(
    area.driveable_length_miles ?? area.total_length_miles ?? 0
  );
  const remainingMiles = Math.max(
    0,
    Number(area.remaining_length_miles ?? driveableMiles - (area.driven_length_miles || 0))
  );

  const routeStatus = renderRouteStatus(area, routeJob);
  const routeMenuLabel = hasSavedRoute
    ? "Regenerate Optimal Route"
    : "Generate Optimal Route";
  const routeMenuAction = hasSavedRoute ? "restart-route" : "generate-route";

  const cardClasses = [
    "area-card card card--object",
    hasActiveCoverageJob ? "area-card--job-active" : "",
    isComplete ? "area-card--complete" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const status = renderStatus(area, coverageJob);
  const lastDrive = area.last_coverage_trip_at
    ? formatDate(area.last_coverage_trip_at, "short")
    : "No drives yet";
  const leftText = isComplete
    ? "Nothing"
    : `${formatMiles(remainingMiles)} · ${plural(remainingSegments, "segment")}`;
  const primaryAction = isError
    ? `<button class="btn btn-primary btn-sm"
                data-area-action="rebuild"
                data-area-id="${area.id}"
                data-area-name="${areaName}"
                ${canRebuild ? "" : "disabled"}
                aria-label="Retry building ${areaName} from OpenStreetMap">
          <i class="fas fa-rotate-right" aria-hidden="true"></i>Retry build
        </button>`
    : `<button class="btn btn-primary btn-sm"
                data-area-action="view"
                data-area-id="${area.id}"
                data-area-name="${areaName}"
                ${isReady ? "" : "disabled"}
                aria-label="Open the street map for ${areaName}">
          <i class="fas fa-map" aria-hidden="true"></i>Map
        </button>`;

  return `
    <article class="${cardClasses}" data-area-id="${area.id}" role="listitem">
      <header class="area-card-header">
        <div class="area-card-title-group">
          <h3 class="area-card-title">${areaName}</h3>
          ${region ? `<p class="area-card-region">${escapeHtml(region)}</p>` : ""}
        </div>
        ${status ? `<div class="area-card-status">${status}</div>` : ""}
      </header>

      <div class="area-card-progress">
        <div class="area-progress-text">
          <span class="area-pct-large">${escapeHtml(
            formatPercent(pct, { complete: isComplete })
          )}</span>
          <span class="area-pct-sub">${escapeHtml(
            `${formatMiles(area.driven_length_miles || 0)} of ${formatMiles(driveableMiles)}`
          )}</span>
          ${
            isComplete
              ? `<span class="area-completion-banner">Every street driven</span>`
              : ""
          }
        </div>
        <div class="survey-bar area-survey${hasActiveCoverageJob ? " is-working" : ""}" aria-hidden="true">
          <span class="survey-fill" style="width: ${pct.toFixed(1)}%"></span>
        </div>
      </div>

      ${renderCoverageJobPanel(coverageJob)}

      <dl class="area-card-stats">
        <div><dt>Left</dt><dd>${escapeHtml(leftText)}</dd></div>
        <div><dt>Last drive</dt><dd>${escapeHtml(lastDrive)}</dd></div>
      </dl>

      ${routeStatus}

      <footer class="area-card-footer">
        ${primaryAction}
        <button class="btn btn-secondary btn-sm"
                data-area-action="journal"
                data-area-id="${area.id}"
                data-area-name="${areaName}"
                ${isReady ? "" : "disabled"}
                aria-label="Open the coverage journal for ${areaName}">
          <i class="fas fa-book-open" aria-hidden="true"></i>Journal
        </button>

        ${
          hasActiveRouteJob
            ? `
          <button class="btn btn-danger btn-sm"
                  type="button"
                  data-area-action="cancel-route"
                  data-area-id="${area.id}"
                  data-area-name="${areaName}"
                  aria-label="Stop optimal route generation for ${areaName}">
            <i class="fas fa-stop-circle" aria-hidden="true"></i>Stop Route
          </button>`
            : ""
        }

        <div class="dropdown area-card-more">
          <button class="btn btn-ghost btn-sm dropdown-toggle"
                  data-bs-toggle="dropdown"
                  aria-expanded="false"
                  aria-label="More actions for ${areaName}">
            <i class="fas fa-ellipsis" aria-hidden="true"></i>
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
                <i class="fas fa-calculator me-2" aria-hidden="true"></i>Recalculate coverage
              </button>
            </li>
            <li>
              <button class="dropdown-item"
                      data-area-action="rebuild"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}"
                      ${!canRebuild ? "disabled" : ""}>
                <i class="fas fa-sync me-2" aria-hidden="true"></i>${isError ? "Retry build from OpenStreetMap" : "Rebuild streets from OpenStreetMap"}
              </button>
            </li>
            <li><hr class="dropdown-divider"></li>
            <li>
              <button class="dropdown-item text-danger"
                      data-area-action="delete"
                      data-area-id="${area.id}"
                      data-area-name="${areaName}">
                <i class="fas fa-trash me-2" aria-hidden="true"></i>Delete area
              </button>
            </li>
          </ul>
        </div>
      </footer>
    </article>`;
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

  const canDiffDom =
    typeof grid.querySelectorAll === "function" &&
    typeof grid.appendChild === "function" &&
    typeof document.createElement === "function";

  if (!canDiffDom) {
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

  // Build a map of existing card elements by area ID for diffing
  const existingCards = new Map();
  for (const card of grid.querySelectorAll(".area-card[data-area-id]")) {
    existingCards.set(card.getAttribute("data-area-id"), card);
  }

  // Generate new card HTML per area and only update cards that changed
  const newAreaIds = new Set();
  const tempContainer = document.createElement("div");
  for (const area of areas) {
    newAreaIds.add(area.id);
    const html = renderAreaCard(
      area,
      activeJobsByAreaId.get(area.id),
      activeRouteJobsByAreaId.get(area.id)
    );

    const existing = existingCards.get(area.id);
    let cardToPlace;
    if (existing) {
      // Compare innerHTML-normalized content; replace only if changed
      tempContainer.innerHTML = html;
      const newCard = tempContainer.firstElementChild;
      if (existing.outerHTML !== newCard.outerHTML) {
        existing.replaceWith(newCard);
        cardToPlace = newCard;
      } else {
        cardToPlace = existing;
      }
    } else {
      tempContainer.innerHTML = html;
      cardToPlace = tempContainer.firstElementChild;
    }

    // Appending an existing node moves it, keeping the DOM in the selected order.
    grid.appendChild(cardToPlace);
  }

  // Remove cards for areas no longer in the list
  for (const [areaId, card] of existingCards) {
    if (!newAreaIds.has(areaId)) {
      card.remove();
    }
  }

  grid.style.display = "grid";
  return { hasAreas: true };
}
