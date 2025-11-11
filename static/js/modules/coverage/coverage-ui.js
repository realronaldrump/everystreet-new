/**
 * Coverage UI Module
 * Handles dashboard, tables, charts, and UI components
 */

/* global Chart, bootstrap */

class CoverageUI {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.streetTypeChartInstance = null;
    this.undrivenStreetsContainer = null;
    this.undrivenSortCriterion = "length_desc";
    this.undrivenSortSelect = null;
  }

  /**
   * Update coverage table
   */
  updateCoverageTable(areas, formatRelativeTime, formatStageName, distanceInUserUnits) {
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
        </tr>
      `;
      return;
    }

    areas.sort((a, b) => {
      const dateA = new Date(a.last_updated || 0);
      const dateB = new Date(b.last_updated || 0);
      return dateB - dateA;
    });

    areas.forEach((area, index) => {
      const row = document.createElement("tr");
      const status = area.status || "unknown";
      const isProcessing = [
        "processing_trips",
        "preprocessing",
        "calculating",
        "indexing",
        "finalizing",
        "generating_geojson",
        "completed_stats",
        "initializing",
        "loading_streets",
        "counting_trips",
      ].includes(status);
      const hasError = status === "error";
      const isCanceled = status === "canceled";

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
      const totalLengthMiles = distanceInUserUnits(area.total_length);
      const drivenLengthMiles = distanceInUserUnits(area.driven_length);
      const coveragePercentage = area.coverage_percentage?.toFixed(1) || "0.0";

      let progressBarColor = "bg-success";
      if (hasError || isCanceled) progressBarColor = "bg-secondary";
      else if (area.coverage_percentage < 25) progressBarColor = "bg-danger";
      else if (area.coverage_percentage < 75) progressBarColor = "bg-warning";

      const locationButtonData = JSON.stringify({
        display_name: area.location?.display_name || "",
      }).replace(/'/g, "&apos;");

      const locationId = area._id;

      row.innerHTML = `
        <td data-label="Location">
          <a href="#" class="location-name-link text-info fw-bold" data-location-id="${locationId}">
            ${area.location?.display_name || "Unknown Location"}
          </a>
          ${
            hasError
              ? `<div class="text-danger small mt-1" title="${
                  area.last_error || ""
                }"><i class="fas fa-exclamation-circle me-1"></i>Error occurred</div>`
              : ""
          }
          ${
            isCanceled
              ? '<div class="text-warning small mt-1"><i class="fas fa-ban me-1"></i>Canceled</div>'
              : ""
          }
          ${
            isProcessing
              ? `<div class="text-primary small mt-1"><i class="fas fa-spinner fa-spin me-1"></i>${formatStageName(
                  status
                )}...</div>`
              : ""
          }
        </td>
        <td data-label="Total Length" class="text-end" data-order="${
          parseFloat(area.total_length || 0) * 0.000621371
        }">${totalLengthMiles}</td>
        <td data-label="Driven Length" class="text-end" data-order="${
          parseFloat(area.driven_length || 0) * 0.000621371
        }">${drivenLengthMiles}</td>
        <td data-label="Coverage" data-order="${parseFloat(
          area.coverage_percentage || 0
        )}">
          <div class="progress" style="height: 22px;" title="${coveragePercentage}% coverage">
            <div class="progress-bar ${progressBarColor}" role="progressbar"
                 style="width: ${coveragePercentage}%; transition: width 0.5s ease;"
                 aria-valuenow="${coveragePercentage}"
                 aria-valuemin="0" aria-valuemax="100">
              <span style="font-weight: 600;">${coveragePercentage}%</span>
            </div>
          </div>
        </td>
        <td data-label="Segments" class="text-end" data-order="${parseInt(
          area.total_segments || 0,
          10
        )}">${area.total_segments?.toLocaleString() || 0}</td>
        <td data-label="Last Updated" data-order="${lastUpdatedOrder}">
          <span title="${lastUpdated}">${formatRelativeTime(area.last_updated)}</span>
        </td>
        <td data-label="Actions">
          <div class="btn-group" role="group" aria-label="Coverage area actions">
            <button class="btn btn-sm btn-success" data-action="update-full" data-location-id="${locationId}" 
                    title="Full Update - Recalculate all coverage" ${
                      isProcessing ? "disabled" : ""
                    } 
                    data-bs-toggle="tooltip">
              <i class="fas fa-sync-alt"></i>
            </button>
            <button class="btn btn-sm btn-info" data-action="update-incremental" data-location-id="${locationId}" 
                    title="Quick Update - Process new trips only" ${
                      isProcessing ? "disabled" : ""
                    } 
                    data-bs-toggle="tooltip">
              <i class="fas fa-bolt"></i>
            </button>
            <button class="btn btn-sm btn-secondary" data-action="reprocess" data-location-id="${locationId}" title="Re-segment streets (choose new segment length)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
              <i class="fas fa-sliders-h"></i>
            </button>
            <button class="btn btn-sm btn-danger" data-action="delete" data-location='${locationButtonData}' 
                    title="Delete this coverage area" ${isProcessing ? "disabled" : ""} 
                    data-bs-toggle="tooltip">
              <i class="fas fa-trash-alt"></i>
            </button>
            ${
              isProcessing
                ? `<button class="btn btn-sm btn-warning" data-action="cancel" data-location='${locationButtonData}' title="Cancel processing" data-bs-toggle="tooltip"><i class="fas fa-stop-circle"></i></button>`
                : ""
            }
          </div>
        </td>
      `;
      tableBody.appendChild(row);
    });
  }

  /**
   * Initialize DataTable
   */
  initializeDataTable() {
    if (!window.$ || !$.fn.DataTable) return;

    const table = $("#coverage-areas-table");

    if ($.fn.DataTable.isDataTable(table)) {
      table.DataTable().destroy();
    }

    table.removeClass("dataTable no-footer");

    const headerColumns = table.find("thead tr").first().children("th").length;
    const bodyRows = Array.from(table.find("tbody tr"));
    const hasPlaceholderRows = bodyRows.some((row) => {
      const cells = Array.from(row.children);
      if (cells.some((cell) => cell.hasAttribute("colspan"))) return true;
      return headerColumns && cells.length !== headerColumns;
    });

    if (hasPlaceholderRows) {
      return;
    }

    try {
      table.DataTable({
        order: [[5, "desc"]],
        paging: false,
        searching: false,
        info: false,
        responsive: true,
        autoWidth: false,
        columnDefs: [
          { orderable: false, targets: 6 },
          {
            targets: 1,
            render(data, type) {
              return type === "display" ? data : parseFloat(data);
            },
          },
        ],
        language: {
          emptyTable: "No coverage areas defined yet.",
        },
        drawCallback() {
          document.dispatchEvent(new CustomEvent("coverageTableRedrawn"));
        },
      });
    } catch (error) {
      console.error("Failed to initialize DataTable:", error);
    }
  }

  /**
   * Update dashboard stats
   */
  updateDashboardStats(coverage, distanceInUserUnits, formatRelativeTime) {
    if (!coverage) return;
    const statsContainer = document.querySelector(
      ".dashboard-stats-card .stats-container"
    );
    if (!statsContainer) return;

    const totalLengthM = parseFloat(coverage.total_length || 0);
    const drivenLengthM = parseFloat(coverage.driven_length || 0);
    const coveragePercentage = parseFloat(coverage.coverage_percentage || 0).toFixed(1);
    const totalSegments = parseInt(coverage.total_segments || 0, 10);

    let coveredSegments = 0;
    if (Array.isArray(coverage.street_types)) {
      coveredSegments = coverage.street_types.reduce((sum, typeStats) => {
        const c1 = parseInt(typeStats.covered, 10);
        const c2 = parseInt(typeStats.covered_segments, 10);
        return sum + (!Number.isNaN(c1) ? c1 : c2 || 0);
      }, 0);
    }

    const lastUpdated =
      coverage.last_stats_update || coverage.last_updated
        ? formatRelativeTime(coverage.last_stats_update || coverage.last_updated)
        : "Never";

    let barColor = "bg-success";
    if (coverage.status === "error" || coverage.status === "canceled")
      barColor = "bg-danger";
    else if (coverage.status !== "completed" && coverage.status !== "complete")
      barColor = "bg-warning";

    const html = `
      <div class="row g-3">
        ${this.createStatItem(distanceInUserUnits(totalLengthM), "Total Length")}
        ${this.createStatItem(
          distanceInUserUnits(drivenLengthM),
          "Driven Length",
          "text-success"
        )}
        ${this.createStatItem(`${coveragePercentage}%`, "Coverage", "text-primary")}
        ${this.createStatItem(totalSegments.toLocaleString(), "Total Segments")}
        ${this.createStatItem(
          coveredSegments.toLocaleString(),
          "Driven Segments",
          "text-success"
        )}
        ${this.createStatItem(lastUpdated, "Last Updated", "text-muted", "small")}
      </div>
      <div class="progress mt-3 mb-2" style="height: 12px;">
        <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePercentage}%" 
             aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100">
        </div>
      </div>
    `;
    statsContainer.innerHTML = html;
    statsContainer.querySelectorAll(".stat-value").forEach((el) => {
      el.classList.add("value-updated");
      setTimeout(() => el.classList.remove("value-updated"), 600);
    });
    const progressBar = statsContainer.querySelector(".progress-bar");
    if (progressBar) {
      progressBar.style.transition = "width 0.6s ease";
    }
  }

  /**
   * Create stat item
   */
  createStatItem(value, label, valueClass = "", labelClass = "") {
    return `
      <div class="col-md-4 col-6">
        <div class="stat-item">
          <div class="stat-value ${valueClass}">${value}</div>
          <div class="stat-label ${labelClass}">${label}</div>
        </div>
      </div>`;
  }

  /**
   * Update street type coverage
   */
  updateStreetTypeCoverage(streetTypes, distanceInUserUnits, formatStreetType) {
    const streetTypeCoverageEl = document.getElementById("street-type-coverage");
    if (!streetTypeCoverageEl) return;

    if (!streetTypes || !streetTypes.length) {
      streetTypeCoverageEl.innerHTML = this.createAlertMessage(
        "No Data",
        "No street type data available.",
        "secondary"
      );
      return;
    }

    const sortedTypes = [...streetTypes].sort(
      (a, b) => parseFloat(b.total_length_m || 0) - parseFloat(a.total_length_m || 0)
    );
    const topTypes = sortedTypes.slice(0, 6);

    let html = "";
    topTypes.forEach((type) => {
      const coveragePct = parseFloat(type.coverage_percentage || 0).toFixed(1);
      const coveredDist = distanceInUserUnits(parseFloat(type.covered_length_m || 0));
      const totalDist = distanceInUserUnits(
        parseFloat(
          (type.driveable_length_m !== undefined
            ? type.driveable_length_m
            : type.total_length_m) || 0
        )
      );
      const denominatorLabel =
        type.driveable_length_m !== undefined ? "Driveable" : "Total";

      let barColor = "bg-success";
      if (parseFloat(coveragePct) < 25) barColor = "bg-danger";
      else if (parseFloat(coveragePct) < 75) barColor = "bg-warning";

      html += `
        <div class="street-type-item mb-2">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <small class="fw-bold text-truncate me-2" title="${formatStreetType(
              type.type
            )}">${formatStreetType(type.type)}</small>
            <small class="text-muted text-nowrap">${coveragePct}% (${coveredDist} / ${totalDist} ${denominatorLabel})</small>
          </div>
          <div class="progress" style="height: 8px;" title="${formatStreetType(
            type.type
          )}: ${coveragePct}% Covered">
            <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%"
                 aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
        </div>
      `;
    });
    streetTypeCoverageEl.innerHTML = html;
  }

  /**
   * Create street type chart
   */
  createStreetTypeChart(streetTypes, formatStreetType, _distanceInUserUnits) {
    const chartContainer = document.getElementById("street-type-chart");
    if (!chartContainer) return;
    if (this.streetTypeChartInstance) this.streetTypeChartInstance.destroy();

    if (!streetTypes || !streetTypes.length) {
      chartContainer.innerHTML = this.createAlertMessage(
        "No Data",
        "No street type data available for chart.",
        "secondary"
      );
      return;
    }

    const sortedTypes = [...streetTypes]
      .sort((a, b) => (b.total_length_m || 0) - (a.total_length_m || 0))
      .slice(0, 10);
    const labels = sortedTypes.map((t) => formatStreetType(t.type));
    const covered = sortedTypes.map((t) => (t.covered_length_m || 0) * 0.000621371);
    const driveable = sortedTypes.map((t) => (t.driveable_length_m || 0) * 0.000621371);
    const coveragePct = sortedTypes.map((t) => t.coverage_percentage || 0);

    chartContainer.innerHTML =
      '<canvas id="streetTypeChartCanvas" style="min-height: 180px;"></canvas>';
    const ctx = document.getElementById("streetTypeChartCanvas").getContext("2d");

    this.streetTypeChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Covered (mi)",
            data: covered,
            backgroundColor: "#4caf50",
            order: 1,
          },
          {
            label: "Driveable (mi)",
            data: driveable,
            backgroundColor: "#607d8b",
            order: 1,
          },
          {
            label: "% Covered",
            data: coveragePct,
            type: "line",
            yAxisID: "y1",
            borderColor: "#ffb300",
            tension: 0.2,
            order: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#fff", boxWidth: 15, padding: 15 },
          },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              label: (ctx) =>
                `${ctx.dataset.label}: ${
                  ctx.dataset.label === "% Covered"
                    ? `${ctx.parsed.y.toFixed(1)}%`
                    : `${ctx.parsed.y.toFixed(2)} mi`
                }`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#ccc", font: { size: 10 } },
            grid: { color: "rgba(255,255,255,0.05)" },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: "Distance (mi)", color: "#ccc" },
            ticks: { color: "#ccc" },
            grid: { color: "rgba(255,255,255,0.1)" },
          },
          y1: {
            beginAtZero: true,
            position: "right",
            title: { display: true, text: "% Covered", color: "#ffb300" },
            ticks: { color: "#ffb300", callback: (v) => `${v}%` },
            grid: { drawOnChartArea: false },
            min: 0,
            max: 100,
          },
        },
      },
    });
  }

  /**
   * Update undriven streets list
   */
  updateUndrivenStreetsList(geojson, distanceInUserUnits) {
    if (!this.undrivenStreetsContainer) {
      this.undrivenStreetsContainer = document.getElementById("undriven-streets-list");
    }
    if (!this.undrivenSortSelect) {
      this.undrivenSortSelect = document.getElementById("undriven-streets-sort");
      if (
        this.undrivenSortSelect &&
        !this.undrivenSortSelect.dataset.listenerAttached
      ) {
        this.undrivenSortSelect.addEventListener("change", () => {
          this.undrivenSortCriterion = this.undrivenSortSelect.value;
          document.dispatchEvent(
            new CustomEvent("coverageUndrivenSortChanged", {
              detail: this.undrivenSortCriterion,
            })
          );
        });
        this.undrivenSortSelect.dataset.listenerAttached = "true";
      }
    }
    const container = this.undrivenStreetsContainer;
    if (!container) return;

    if (!geojson || !Array.isArray(geojson.features) || !geojson.features.length) {
      container.innerHTML = this.createAlertMessage(
        "No Data",
        "No street data available.",
        "secondary"
      );
      return;
    }

    const aggregates = new Map();
    for (const feature of geojson.features) {
      const props = feature.properties || {};
      const name = props.street_name || "Unnamed";
      const segLen = parseFloat(props.segment_length || 0);
      let agg = aggregates.get(name);
      if (!agg) {
        agg = { length: 0, segments: 0, driven: false };
        aggregates.set(name, agg);
      }
      agg.length += Number.isNaN(segLen) ? 0 : segLen;
      agg.segments += 1;
      if (props.driven) agg.driven = true;
    }

    const undrivenData = [...aggregates.entries()]
      .filter(([, agg]) => !agg.driven)
      .map(([name, agg]) => ({
        name,
        length: agg.length,
        segments: agg.segments,
      }));

    if (!undrivenData.length) {
      container.innerHTML = this.createAlertMessage(
        "All Covered",
        "Great job! Every street has at least one driven segment.",
        "success"
      );
      return;
    }

    const sortKey = this.undrivenSortCriterion || "length_desc";
    undrivenData.sort((a, b) => {
      switch (sortKey) {
        case "length_asc":
          return a.length - b.length;
        case "length_desc":
          return b.length - a.length;
        case "segments_asc":
          return a.segments - b.segments;
        case "segments_desc":
          return b.segments - a.segments;
        case "name_asc":
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        default:
          return 0;
      }
    });

    let html = '<ul class="list-group list-group-flush small">';
    undrivenData.forEach((item) => {
      const dist = distanceInUserUnits(item.length);
      html += `<li class="list-group-item d-flex align-items-center justify-content-between bg-transparent text-truncate undriven-street-item" data-street-name="${item.name}" title="${item.name}">
        <span class="street-name text-truncate me-2">${item.name}</span>
        <div class="text-nowrap"><span class="badge bg-secondary" title="Total length">${dist}</span> <span class="badge bg-dark" title="Segment count">${item.segments}</span></div>
      </li>`;
    });
    html += "</ul>";

    container.innerHTML = html;

    container.querySelectorAll(".undriven-street-item").forEach((el) => {
      el.addEventListener("click", () => {
        const street = el.dataset.streetName || el.textContent.trim();
        document.dispatchEvent(
          new CustomEvent("coverageShowStreet", { detail: street })
        );
      });
    });
  }

  /**
   * Clear dashboard UI
   */
  clearDashboardUI() {
    document.getElementById("dashboard-location-name").textContent =
      "Select a location";
    const statsContainer = document.querySelector(
      ".dashboard-stats-card .stats-container"
    );
    if (statsContainer) statsContainer.innerHTML = "";

    const chartContainer = document.getElementById("street-type-chart");
    if (chartContainer) chartContainer.innerHTML = "";

    const coverageEl = document.getElementById("street-type-coverage");
    if (coverageEl) coverageEl.innerHTML = "";

    if (this.streetTypeChartInstance) {
      this.streetTypeChartInstance.destroy();
      this.streetTypeChartInstance = null;
    }
  }

  /**
   * Create alert message
   */
  createAlertMessage(title, message, type = "info") {
    const iconClass =
      {
        danger: "fa-exclamation-circle",
        warning: "fa-exclamation-triangle",
        info: "fa-info-circle",
        secondary: "fa-question-circle",
      }[type] || "fa-info-circle";

    return `
      <div class="alert alert-${type} m-3 fade-in-up">
        <h5 class="alert-heading h6 mb-1"><i class="fas ${iconClass} me-2"></i>${title}</h5>
        <p class="small mb-0">${message}</p>
      </div>`;
  }

  /**
   * Create loading skeleton
   */
  createLoadingSkeleton(height, count = 1) {
    let skeletonHtml = "";
    for (let i = 0; i < count; i++) {
      skeletonHtml += `<div class="loading-skeleton skeleton-shimmer mb-2" style="height: ${height}px;"></div>`;
    }
    return skeletonHtml;
  }

  /**
   * Create loading indicator
   */
  createLoadingIndicator(message = "Loading...") {
    return `
      <div class="d-flex flex-column align-items-center justify-content-center p-4 text-center text-muted h-100">
        <div class="loading-indicator mb-3"></div>
        <small>${message}</small>
      </div>`;
  }
}

export default CoverageUI;
