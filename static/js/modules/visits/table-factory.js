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
        '<div class="empty-state"><i class="fas fa-map-marked-alt"></i><h5>No Custom Places Yet</h5><p>Draw your first place on the map to start tracking visits</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ places",
      search: "",
      searchPlaceholder: "Search places...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>"
      + "<'row'<'col-sm-12'tr>>"
      + "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
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

function createNonCustomVisitsTable() {
  const el = document.getElementById("non-custom-visits-table");
  if (!el || !window.$) {
    return null;
  }

  const headers = ["Place", "Total Visits", "First Visit", "Last Visit"];

  return $(el).DataTable({
    responsive: true,
    order: [[3, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "name",
        render: (data) => `<i class="fas fa-globe me-2 text-info"></i>${data}`,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "totalVisits",
        className: "numeric-cell text-end",
        render: (data) => `<span class="badge bg-info">${data}</span>`,
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
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
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
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
              : "N/A"
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
    ],
    language: {
      emptyTable:
        '<div class="empty-state"><i class="fas fa-globe"></i><h5>No Other Locations Visited</h5><p>Visit tracking data will appear here</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ locations",
      search: "",
      searchPlaceholder: "Search locations...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>"
      + "<'row'<'col-sm-12'tr>>"
      + "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
  });
}

function createTripsTable({ onTripSelected }) {
  const el = document.getElementById("trips-for-place-table");
  if (!el || !window.$) {
    return null;
  }

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
        render: (data) => `<span class="badge bg-secondary">${data}</span>`,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "startTime",
        render: (data) => DateUtils.formatForDisplay(data, { dateStyle: "medium" }),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "startTime",
        render: (data) => DateUtils.formatForDisplay(data, { timeStyle: "short" }),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "departureTime",
        render: (data) =>
          data ? DateUtils.formatForDisplay(data, { timeStyle: "short" }) : "N/A",
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSpent",
        render: (data) => (data ? data : "N/A"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "timeSinceLastVisit",
        render: (data) => (data ? data : "N/A"),
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: null,
        render: (data, type, row) =>
          type === "display"
            ? `<button class="btn btn-sm btn-outline-primary view-trip-btn" data-trip-id="${row.transactionId}">
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
        '<div class="empty-state"><i class="fas fa-route"></i><h5>No Trips Found</h5><p>No trips found for this place</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ trips",
      search: "",
      searchPlaceholder: "Search trips...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>"
      + "<'row'<'col-sm-12'tr>>"
      + "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
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

function createSuggestionsTable({ onCreatePlace, onPreview } = {}) {
  const el = document.getElementById("suggested-places-table");
  if (!el || !window.$) {
    return null;
  }

  const headers = [
    "Suggested Place",
    "Visit Count",
    "First Visit",
    "Last Visit",
    "Actions",
  ];

  const table = $(el).DataTable({
    responsive: true,
    order: [[1, "desc"]],
    pageLength: 10,
    columns: [
      {
        data: "suggestedName",
        render: (data, _type, row) => {
          const name = data || row?.name || "Suggested Place";
          return `<i class="fas fa-map-marker-alt me-2 text-warning"></i>${name}`;
        },
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: "totalVisits",
        className: "numeric-cell text-end",
        render: (data) => `<span class="badge bg-warning text-dark">${data}</span>`,
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
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
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
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
              : "N/A"
            : data,
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
      {
        data: null,
        render: (data, type, row) => {
          if (type !== "display") {
            return data;
          }
          const suggestionId
            = row?.suggestionId || row?._id || row?.suggestedName || "";
          return `<div class="btn-group btn-group-sm" role="group">
                <button class="btn btn-sm btn-outline-info preview-suggestion-btn" data-place-id="${suggestionId}" title="Preview">
                  <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-sm btn-outline-warning add-suggested-btn" data-place-id="${suggestionId}" title="Add">
                  <i class="fas fa-plus"></i>
                </button>
              </div>`;
        },
        createdCell: (td, _cellData, _rowData, _row, col) => {
          $(td).attr("data-label", headers[col]);
        },
      },
    ],
    language: {
      emptyTable:
        '<div class="empty-state"><i class="fas fa-lightbulb"></i><h5>No Suggestions Yet</h5><p>Suggestions appear once you have enough trips</p></div>',
      info: "Showing _START_ to _END_ of _TOTAL_ suggestions",
      search: "",
      searchPlaceholder: "Search suggestions...",
    },
    dom:
      "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>"
      + "<'row'<'col-sm-12'tr>>"
      + "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
  });

  const getRowData = (event) => {
    const rowEl = $(event.target).closest("tr");
    if (!rowEl.length) {
      return null;
    }
    return table.row(rowEl).data();
  };

  $(el).on("mousedown", ".add-suggested-btn", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const suggestion = getRowData(event);
    if (suggestion) {
      onCreatePlace?.(suggestion);
    }
  });

  $(el).on("mousedown", ".preview-suggestion-btn", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const suggestion = getRowData(event);
    if (suggestion) {
      onPreview?.(suggestion);
    }
  });

  $("#suggested-places-table_filter input").addClass("form-control-sm");
  return table;
}

export {
  createNonCustomVisitsTable,
  createSuggestionsTable,
  createTripsTable,
  createVisitsTable,
};
