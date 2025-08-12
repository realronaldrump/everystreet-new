"use strict";

// Classic script for coverage areas table: rendering and interactions.
// Exposes: window.CoverageModules.Table

(() => {
  window.CoverageModules = window.CoverageModules || {};
  const STATUS = window.STATUS || {};

  const Table = {
    updateCoverageTable(areas, manager) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;
      tableBody.innerHTML = "";
      if (!areas || areas.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center">
              <div class="empty-state py-5">
                <i class="fas fa-map-marked-alt fa-3x mb-3 opacity-50"></i>
                <h5>No Coverage Areas Yet</h5>
                <p class="text-muted mb-3">Start tracking your coverage by adding a new area.</p>
                <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addAreaModal">
                  <i class="fas fa-plus me-2"></i>Add Your First Area
                </button>
              </div>
            </td>
          </tr>`;
        return;
      }
      areas.sort(
        (a, b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0),
      );
      areas.forEach((area, index) => {
        const row = document.createElement("tr");
        const status = area.status || STATUS.UNKNOWN;
        const isProcessing = [
          STATUS.PROCESSING_TRIPS,
          STATUS.PREPROCESSING,
          STATUS.CALCULATING,
          STATUS.INDEXING,
          STATUS.FINALIZING,
          STATUS.GENERATING_GEOJSON,
          STATUS.COMPLETE_STATS,
          STATUS.INITIALIZING,
          STATUS.LOADING_STREETS,
          STATUS.COUNTING_TRIPS,
        ].includes(status);
        const hasError = status === STATUS.ERROR;
        const isCanceled = status === STATUS.CANCELED;
        row.className = isProcessing
          ? "processing-row table-info"
          : hasError
            ? "table-danger"
            : isCanceled
              ? "table-warning"
              : "";
        if (index < 5) {
          row.style.animationDelay = `${index * 0.05}s`;
          row.classList.add("fade-in-up");
        }
        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        const lastUpdatedOrder = area.last_updated
          ? new Date(area.last_updated).getTime()
          : 0;
        const totalLength = CoverageShared.UI.distanceInUserUnits(
          area.total_length || 0,
        );
        const drivenLength = CoverageShared.UI.distanceInUserUnits(
          area.driven_length || 0,
        );
        const coveragePercentage = (area.coverage_percentage || 0).toFixed
          ? (area.coverage_percentage || 0).toFixed(1)
          : String(area.coverage_percentage || 0);
        let progressBarColor = "bg-success";
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if ((area.coverage_percentage || 0) < 25)
          progressBarColor = "bg-danger";
        else if ((area.coverage_percentage || 0) < 75)
          progressBarColor = "bg-warning";
        const locationId = area._id;
        const locationButtonData = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;");
        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${locationId}">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${hasError ? `<div class="text-danger small mt-1" title="${area.last_error || ""}"><i class="fas fa-exclamation-circle me-1"></i>Error occurred</div>` : ""}
            ${isCanceled ? '<div class="text-warning small mt-1"><i class="fas fa-ban me-1"></i>Canceled</div>' : ""}
            ${isProcessing ? `<div class="text-primary small mt-1"><i class="fas fa-spinner fa-spin me-1"></i>${manager.constructor.formatStageName(status)}...</div>` : ""}
          </td>
          <td data-label="Total Length" class="text-end">${totalLength}</td>
          <td data-label="Driven Length" class="text-end">${drivenLength}</td>
          <td data-label="Coverage" data-order="${parseFloat(area.coverage_percentage || 0)}">
            <div class="progress" style="height: 22px;" title="${coveragePercentage}% coverage">
              <div class="progress-bar ${progressBarColor}" role="progressbar" style="width: ${coveragePercentage}%" aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100">
                <span style="font-weight: 600;">${coveragePercentage}%</span>
              </div>
            </div>
          </td>
          <td data-label="Segments" class="text-end">${(area.total_segments || 0).toLocaleString()}</td>
          <td data-label="Last Updated" data-order="${lastUpdatedOrder}"><span title="${lastUpdated}">${manager.formatRelativeTime?.(area.last_updated) || lastUpdated}</span></td>
          <td data-label="Actions">
            <div class="btn-group" role="group" aria-label="Coverage area actions">
              <button class="btn btn-sm btn-success" data-action="update-full" data-location-id="${locationId}" title="Full Update - Recalculate all coverage" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip"><i class="fas fa-sync-alt"></i></button>
              <button class="btn btn-sm btn-info" data-action="update-incremental" data-location-id="${locationId}" title="Quick Update - Process new trips only" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip"><i class="fas fa-bolt"></i></button>
              <button class="btn btn-sm btn-secondary" data-action="reprocess" data-location-id="${locationId}" title="Re-segment streets" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip"><i class="fas fa-sliders-h"></i></button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-location='${locationButtonData}' title="Delete this coverage area" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip"><i class="fas fa-trash-alt"></i></button>
              ${isProcessing ? `<button class="btn btn-sm btn-warning" data-action="cancel" data-location='${locationButtonData}' title="Cancel processing" data-bs-toggle="tooltip"><i class="fas fa-stop-circle"></i></button>` : ""}
            </div>
          </td>`;
        tableBody.appendChild(row);
      });
    },
  };

  window.CoverageModules.Table = Table;
})();
