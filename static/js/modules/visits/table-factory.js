/* global $ */

import { DateUtils } from "../utils.js";

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
    order: [[3, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "name",
        render: (data, type, row) =>
          type === "display"
            ? `<a href="#" class="place-link" data-place-id="${row._id}">
                  <i class="fas fa-map-marker-alt me-2"></i>${data}
                 </a>`
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "totalVisits",
        className: "numeric-cell text-end",
        render: (data) => {
          const visits = data || 0;
          return `<span class="visits-badge">${visits}</span>`;
        },
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "firstVisit",
        className: "date-cell",
        render: (data, type) =>
          type === "display" || type === "filter"
            ? data
              ? `<i class="far fa-calendar me-1"></i>${DateUtils.formatForDisplay(data, { dateStyle: "medium" })}`
              : "N/A"
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "lastVisit",
        className: "date-cell",
        render: (data, type) =>
          type === "display" || type === "filter"
            ? data
              ? `<i class="far fa-calendar-check me-1"></i>${DateUtils.formatForDisplay(data, { dateStyle: "medium" })}`
              : "N/A"
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "avgTimeSpent",
        className: "numeric-cell text-end",
        type: "duration",
        render: (data) => (data ? `<i class="far fa-clock me-1"></i>${data}` : "N/A"),
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
    columnDefs: [{ type: "duration", targets: 4 }],
    drawCallback() {
      $("#visits-table tbody tr").each(function (i) {
        $(this)
          .delay(50 * i)
          .animate({ opacity: 1 }, 300);
      });
    },
  });

  $(el).on("mousedown", ".place-link", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const placeId = $(event.target).closest(".place-link").data("place-id");
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
    order: [[1, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "transactionId",
        defaultContent: "",
        render: (data, _type, row) =>
          `<span class="badge bg-secondary">${data || row?.id || "N/A"}</span>`,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: (row) => resolveTripTime(row),
        defaultContent: "",
        render: (data, type) =>
          type === "display" || type === "filter"
            ? data
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
              : "N/A"
            : data || "",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: (row) => resolveTripTime(row),
        defaultContent: "",
        render: (data, type) =>
          type === "display" || type === "filter"
            ? data
              ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
              : "N/A"
            : data || "",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "departureTime",
        defaultContent: "",
        render: (data) =>
          data ? DateUtils.formatForDisplay(data, { timeStyle: "short" }) : "N/A",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSpent",
        defaultContent: "",
        render: (data) => (data ? data : "N/A"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSinceLastVisit",
        defaultContent: "",
        render: (data) => (data ? data : "N/A"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: null,
        render: (data, type, row) =>
          type === "display"
            ? `<button class="btn btn-sm btn-outline-primary view-trip-btn" data-trip-id="${row.transactionId || row.id || ""}">
                <i class="fas fa-map"></i>
              </button>`
            : data,
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

  $(el).on("mousedown", ".view-trip-btn", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const tripId = $(event.target).closest(".view-trip-btn").data("trip-id");
    if (tripId) {
      onTripSelected?.(tripId);
    }
  });

  $("#trips-for-place-table_filter input").addClass("form-control-sm");
  return table;
}

export { createTripsTable, createVisitsTable };
