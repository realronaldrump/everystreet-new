import {
  escapeHtml,
  formatForDisplay,
  parseDurationToSeconds,
} from "../utils/formatting.js";

function renderDate(data, type, options, icon = "", missingLabel = "N/A") {
  const timestamp = data ? Date.parse(data) : NaN;
  if (type === "sort" || type === "type") {
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (!Number.isFinite(timestamp)) {
    return missingLabel;
  }
  const formatted = formatForDisplay(data, options);
  return type === "display"
    ? `${icon ? `<i class="${icon} me-1" aria-hidden="true"></i>` : ""}${escapeHtml(formatted)}`
    : formatted;
}

function renderDuration(data, type, icon = "") {
  const duration = String(data || "N/A");
  if (type === "sort" || type === "type") {
    return parseDurationToSeconds(duration);
  }
  return type === "display"
    ? `${icon && duration !== "N/A" ? `<i class="${icon} me-1" aria-hidden="true"></i>` : ""}${escapeHtml(duration)}`
    : duration;
}

function createVisitsTable({ onPlaceSelected }) {
  const el = document.getElementById("visits-table");
  if (!el || !window.$) {
    return null;
  }

  const headers = [
    "Place",
    "Total Visits",
    "First Visit",
    "Last Visit",
    "Avg Time Spent",
  ];

  const table = $(el).DataTable({
    responsive: true,
    deferRender: true,
    order: [[3, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "name",
        render: (data, type, row) =>
          type === "display"
            ? `<button type="button" class="place-link btn btn-link p-0 text-start" data-place-id="${escapeHtml(row.id)}">${escapeHtml(data)}</button>`
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "totalVisits",
        className: "numeric-cell text-end",
        type: "num",
        render: (data, type) => {
          if (data == null || data === "" || !Number.isFinite(Number(data))) {
            return type === "sort" || type === "type" ? -1 : "—";
          }
          const visits = Number(data);
          return type === "display"
            ? `<span class="visits-badge">${visits.toLocaleString()}</span>`
            : visits;
        },
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "firstVisit",
        defaultContent: "—",
        className: "date-cell",
        type: "num",
        render: (data, type) =>
          renderDate(data, type, { dateStyle: "medium" }, "far fa-calendar", "—"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "lastVisit",
        defaultContent: "—",
        className: "date-cell",
        type: "num",
        render: (data, type) =>
          renderDate(data, type, { dateStyle: "medium" }, "far fa-calendar-check", "—"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "avgTimeSpent",
        className: "numeric-cell text-end",
        type: "num",
        render: (data, type) => renderDuration(data, type, "far fa-clock"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
    ],
    language: {
      emptyTable:
        '<div class="empty-state"><h5>No places yet</h5><p>Draw a boundary on the map — visits start counting from your very first trip there</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ places",
      search: "",
      searchPlaceholder: "Search places...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
      "<'row'<'col-sm-12'tr>>" +
      "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
  });

  $(el)
    .off("click.visits", ".place-link")
    .on("click.visits", ".place-link", (event) => {
      event.preventDefault();
      const placeId = event.currentTarget.getAttribute("data-place-id");
      if (placeId) {
        onPlaceSelected?.(placeId);
      }
    });

  $("#visits-table_filter input").addClass("form-control-sm");
  return table;
}

function createTripsTable({ onTripSelected }) {
  const el = document.getElementById("trips-for-place-table");
  if (!el || !window.$) {
    return null;
  }

  const resolveTripTime = (trip) => trip?.endTime || null;

  const headers = [
    "Trip ID",
    "Date",
    "Time",
    "Departure Time",
    "Time Spent",
    "Time Since Last Visit",
    "Actions",
  ];

  const table = $(el).DataTable({
    responsive: true,
    deferRender: true,
    order: [[1, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "transactionId",
        defaultContent: "",
        render: (data, type) =>
          type === "display"
            ? `<span class="badge bg-secondary">${escapeHtml(data)}</span>`
            : data || "",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: (row) => resolveTripTime(row),
        defaultContent: "",
        type: "num",
        render: (data, type) => renderDate(data, type, { dateStyle: "medium" }),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: (row) => resolveTripTime(row),
        defaultContent: "",
        type: "num",
        render: (data, type) => renderDate(data, type, { timeStyle: "short" }),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "departureTime",
        defaultContent: "",
        type: "num",
        render: (data, type) => renderDate(data, type, { timeStyle: "short" }),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSpent",
        defaultContent: "",
        type: "num",
        render: (data, type) => renderDuration(data, type),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSinceLastVisit",
        defaultContent: "",
        type: "num",
        render: (data, type) => renderDuration(data, type),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: null,
        orderable: false,
        searchable: false,
        render: (data, type, row) =>
          type === "display"
            ? `<button type="button" class="btn btn-sm btn-outline-primary view-trip-btn" data-trip-id="${escapeHtml(row.transactionId)}" aria-label="View trip on map">
                <i class="fas fa-map" aria-hidden="true"></i>
              </button>`
            : "",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
    ],
    language: {
      emptyTable:
        '<div class="empty-state"><h5>No trips end here</h5><p>Drives that stop inside this boundary will be listed here</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ trips",
      search: "",
      searchPlaceholder: "Search trips...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
      "<'row'<'col-sm-12'tr>>" +
      "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
  });

  $(el)
    .off("click.visits", ".view-trip-btn")
    .on("click.visits", ".view-trip-btn", (event) => {
      event.preventDefault();
      const tripId = event.currentTarget.getAttribute("data-trip-id");
      if (tripId) {
        onTripSelected?.(tripId);
      }
    });

  $("#trips-for-place-table_filter input").addClass("form-control-sm");
  return table;
}

export { createTripsTable, createVisitsTable };
