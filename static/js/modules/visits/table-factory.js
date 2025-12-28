(() => {
  function createVisitsTable({ onPlaceSelected }) {
    const el = document.getElementById("visits-table");
    if (!el || !window.$) return null;

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
      if (event.button !== 0) return;
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
    if (!el || !window.$) return null;

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
        "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
        "<'row'<'col-sm-12'tr>>" +
        "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
    });
  }

  function createTripsTable({ onTripSelected }) {
    const el = document.getElementById("trips-for-place-table");
    if (!el || !window.$) return null;

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
      pageLength: 15,
      columns: [
        {
          data: "transactionId",
          render: (data, type, row) =>
            type === "display"
              ? `<a href="#" class="trip-id-link" data-trip-id="${row.id}">
                  <i class="fas fa-hashtag me-1"></i>${data}
                 </a>`
              : data,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "endTime",
          className: "date-cell",
          render: (data, type) =>
            type === "display" || type === "filter"
              ? DateUtils.formatForDisplay(data, { dateStyle: "medium" })
              : data,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "endTime",
          className: "date-cell",
          render: (data, type) =>
            type === "display" || type === "filter"
              ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
              : data,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "departureTime",
          className: "date-cell",
          render: (data, type) =>
            type === "display" || type === "filter"
              ? data
                ? DateUtils.formatForDisplay(data, { timeStyle: "short" })
                : '<span class="text-muted">Unknown</span>'
              : data,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "timeSpent",
          className: "numeric-cell text-end",
          type: "duration",
          render: (data) => `<span class="badge bg-success">${data}</span>`,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "timeSinceLastVisit",
          className: "numeric-cell text-end",
          type: "duration",
          render: (data) => data || '<span class="text-muted">First visit</span>',
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: null,
          className: "action-cell text-center",
          orderable: false,
          render: (_data, type, row) =>
            type === "display"
              ? `<button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${row.id}">
                  <i class="fas fa-map-marker-alt me-1"></i> View Route
                 </button>`
              : "",
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
      ],
      language: {
        emptyTable:
          '<div class="empty-state"><i class="fas fa-route"></i><h5>No Trips Found</h5><p>Trip history will appear here</p></div>',
        info: "Showing _START_ to _END_ of _TOTAL_ trips",
        search: "",
        searchPlaceholder: "Search trips...",
      },
      dom:
        "<'row'<'col-sm-12 col-md-6'l><'col-sm-12 col-md-6'f>>" +
        "<'row'<'col-sm-12'tr>>" +
        "<'row'<'col-sm-12 col-md-5'i><'col-sm-12 col-md-7'p>>",
      columnDefs: [{ type: "duration", targets: [4, 5] }],
    });

    $(el)
      .find("tbody")
      .on("mousedown", ".view-trip-btn, .trip-id-link", (e) => {
        if (e.button !== 0) return;
        const tripId = $(e.currentTarget).data("trip-id");
        if (tripId) {
          const $btn = $(e.currentTarget);
          $btn.addClass("loading");
          onTripSelected?.(tripId);
        }
      });

    return table;
  }

  function createSuggestionsTable({ onCreatePlace, onPreview }) {
    const el = document.getElementById("suggested-places-table");
    if (!el || !window.$) return null;

    const headers = [
      "Suggested Name",
      "Total Visits",
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
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "totalVisits",
          className: "numeric-cell text-end",
          render: (d) => `<span class="badge bg-info">${d}</span>`,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "firstVisit",
          className: "date-cell",
          render: (d, type) =>
            type === "display" || type === "filter"
              ? d
                ? DateUtils.formatForDisplay(d, { dateStyle: "medium" })
                : "N/A"
              : d,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: "lastVisit",
          className: "date-cell",
          render: (d, type) =>
            type === "display" || type === "filter"
              ? d
                ? DateUtils.formatForDisplay(d, { dateStyle: "medium" })
                : "N/A"
              : d,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
        {
          data: null,
          orderable: false,
          className: "action-cell text-center",
          render: () =>
            `<div class="btn-group btn-group-sm">
               <button class="btn btn-outline-primary preview-suggestion-btn" title="Preview on Map"><i class="fas fa-eye"></i></button>
               <button class="btn btn-primary create-place-btn" title="Create Place"><i class="fas fa-plus"></i></button>
             </div>`,
          createdCell: (td, _cellData, _rowData, _row, col) => {
            $(td).attr("data-label", headers[col]);
          },
        },
      ],
      language: {
        emptyTable:
          '<div class="empty-state"><i class="fas fa-magic"></i><h5>No Suggestions Yet</h5><p>Drive around to gather data</p></div>',
      },
    });

    $(el)
      .find("tbody")
      .on("click", ".create-place-btn", (e) => {
        const row = table.row($(e.currentTarget).closest("tr"));
        const data = row.data();
        if (data) {
          onCreatePlace?.(data);
        }
      })
      .on("click", ".preview-suggestion-btn", (e) => {
        const row = table.row($(e.currentTarget).closest("tr"));
        const data = row.data();
        if (data) {
          onPreview?.(data);
        }
      });

    return table;
  }

  window.VisitsTableFactory = {
    createVisitsTable,
    createNonCustomVisitsTable,
    createTripsTable,
    createSuggestionsTable,
  };
})();
