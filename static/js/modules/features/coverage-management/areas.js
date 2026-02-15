import { escapeHtml } from "../../utils.js";
import { formatMiles, formatRelativeTime } from "./stats.js";

export function isJobActiveStatus(status) {
  return ["pending", "running"].includes(status);
}

export function isJobTerminalStatus(status) {
  return ["completed", "failed", "cancelled", "needs_attention"].includes(status);
}

function normalizeCoveragePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function renderStatus(area, job) {
  const status = area?.status;
  const statusConfig = {
    ready: { class: "success", icon: "check-circle", text: "Ready" },
    initializing: {
      class: "info",
      icon: "spinner fa-spin",
      text: "Setting up...",
    },
    rebuilding: {
      class: "warning",
      icon: "sync fa-spin",
      text: "Rebuilding...",
    },
    error: { class: "danger", icon: "exclamation-circle", text: "Error" },
  };

  const config = statusConfig[status] || statusConfig.error;
  const isErrorStatus = status === "error";
  const badge = `<span class="badge bg-${config.class}">
        <i class="fas fa-${config.icon} me-1"></i>${config.text}
    </span>`;

  if (isErrorStatus) {
    const areaName = escapeHtml(area?.display_name || "Coverage area");
    return `
      <button type="button"
              class="coverage-error-trigger"
              data-error-action="show"
              data-area-id="${area.id}"
              data-area-name="${areaName}"
              title="View error details"
              aria-label="View error details for ${areaName}">
        <i class="fas fa-${config.icon} me-1"></i>${config.text}
      </button>
    `;
  }

  if (
    job &&
    isJobActiveStatus(job.status) &&
    (status === "initializing" || status === "rebuilding")
  ) {
    const percent = typeof job.progress === "number" ? Math.round(job.progress) : 0;
    const detailText = job.message ? escapeHtml(job.message) : "Processing";
    return `
      <div class="coverage-job-status">
        ${badge}
        <div class="coverage-job-progress">
          <div class="progress" style="height: 8px;">
            <div class="progress-bar" role="progressbar" style="width: ${percent}%"></div>
          </div>
          <div class="small text-muted">${detailText}</div>
        </div>
      </div>
    `;
  }

  return badge;
}

export function renderAreasTable({
  areas,
  activeJobsByAreaId,
  areaErrorById,
  areaNameById,
}) {
  const tbody = document.querySelector("#coverage-areas-table tbody");
  if (!tbody) {
    return { hasAreas: false };
  }

  if (!areas || areas.length === 0) {
    areaErrorById.clear();
    areaNameById.clear();
    tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center p-4">
                    <div class="empty-state">
                        <i class="fas fa-map-marked-alt fa-3x text-secondary mb-3"></i>
                        <p class="mb-2">No coverage areas yet</p>
                        <button class="btn btn-success btn-sm" data-bs-toggle="modal" data-bs-target="#addAreaModal">
                            <i class="fas fa-plus me-1"></i>Add Your First Area
                        </button>
                    </div>
                </td>
            </tr>`;
    return { hasAreas: false };
  }

  areaErrorById.clear();
  areaNameById.clear();
  areas.forEach((area) => {
    areaErrorById.set(area.id, area.last_error || "");
    areaNameById.set(area.id, area.display_name || "Coverage area");
  });

  tbody.innerHTML = areas
    .map((area) => {
      const areaName = escapeHtml(area.display_name || "Coverage area");
      const isReady = area.status === "ready";
      const coveragePercentage = normalizeCoveragePercent(area.coverage_percentage);
      return `
        <tr data-area-id="${area.id}">
            <td>
                <strong>${areaName}</strong>
                <br><small class="text-secondary">${area.area_type}</small>
            </td>
            <td>${renderStatus(area, activeJobsByAreaId.get(area.id))}</td>
            <td>${formatMiles(area.total_length_miles)}</td>
            <td>${formatMiles(area.driven_length_miles)}</td>
            <td>
                <div class="progress" style="height: 20px; min-width: 100px;">
                    <div class="progress-bar bg-success" style="width: ${coveragePercentage}%">
                        ${coveragePercentage.toFixed(2)}%
                    </div>
                </div>
            </td>
            <td>${area.last_synced ? formatRelativeTime(area.last_synced) : "Never"}</td>
            <td>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-primary" data-area-action="view" data-area-id="${area.id}"
                            title="View on map" ${!isReady ? "disabled" : ""}>
                        <i class="fas fa-map"></i>
                    </button>
                    <button class="btn btn-outline-info" data-area-action="recalculate" data-area-id="${area.id}"
                            data-area-name="${areaName}"
                            title="Recalculate coverage from trips" ${!isReady ? "disabled" : ""}>
                        <i class="fas fa-calculator"></i>
                    </button>
                    <button class="btn btn-outline-warning" data-area-action="rebuild" data-area-id="${area.id}"
                            data-area-name="${areaName}"
                             title="Rebuild with fresh OSM data" ${!isReady ? "disabled" : ""}>
                        <i class="fas fa-sync"></i>
                    </button>
                    <button class="btn btn-outline-danger" data-area-action="delete" data-area-id="${area.id}"
                            data-area-name="${areaName}"
                            title="Delete area">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    })
    .join("");

  return { hasAreas: true };
}
