import { escapeHtml } from "./utils.js";

export class TableManager {
  constructor(tableId, options = {}) {
    this.table = document.getElementById(tableId);
    if (!this.table) {
      throw new Error(`Table element '${tableId}' not found`);
    }

    this.options = {
      serverSide: options.serverSide ?? true,
      url: options.url || "",
      columns: options.columns || [],
      pageSize: options.pageSize || 25,
      pageSizes: options.pageSizes || [10, 25, 50, 100],
      onRowClick: options.onRowClick || null,
      onDataLoaded: options.onDataLoaded || null,
      emptyMessage: options.emptyMessage || "No data available",
      loadingMessage: options.loadingMessage || "Loading...",
      getFilters: options.getFilters || (() => ({})),
      ...options,
    };

    this.state = {
      data: [],
      page: 0,
      totalRecords: 0,
      totalPages: 0,
      sortColumn: options.defaultSort?.column || 0,
      sortDir: options.defaultSort?.dir || "desc",
      loading: false,
      abortController: null,
    };

    this.tbody = this.table.querySelector("tbody") || this._createTbody();
    this._init();
  }

  _createTbody() {
    const tbody = document.createElement("tbody");
    this.table.appendChild(tbody);
    return tbody;
  }

  _init() {
    this._createControls();
    this._bindEvents();
    this.reload();
  }

  _createControls() {
    const wrapper = this.table.closest(".table-responsive") || this.table.parentElement;

    // Create pagination controls
    const paginationContainer = document.createElement("div");
    paginationContainer.className =
      "table-pagination d-flex justify-content-between align-items-center mt-3";
    paginationContainer.innerHTML = `
      <div class="pagination-info">
        <span class="pagination-showing"></span>
      </div>
      <div class="pagination-controls d-flex gap-2 align-items-center">
        <select class="form-select form-select-sm page-size-select" style="width: auto;">
          ${this.options.pageSizes.map((size) => `<option value="${size}" ${size === this.options.pageSize ? "selected" : ""}>${size} per page</option>`).join("")}
        </select>
        <nav aria-label="Table navigation">
          <ul class="pagination pagination-sm mb-0 page-numbers-list">
            <li class="page-item page-prev-item"><button class="page-link page-prev" disabled>&laquo;</button></li>
            <!-- Page number items will be inserted here dynamically -->
            <li class="page-item page-next-item"><button class="page-link page-next" disabled>&raquo;</button></li>
          </ul>
        </nav>
      </div>
    `;
    wrapper.after(paginationContainer);

    this.controls = {
      pagination: paginationContainer,
      info: paginationContainer.querySelector(".pagination-showing"),
      prev: paginationContainer.querySelector(".page-prev"),
      next: paginationContainer.querySelector(".page-next"),
      paginationList: paginationContainer.querySelector(".page-numbers-list"),
      prevItem: paginationContainer.querySelector(".page-prev-item"),
      nextItem: paginationContainer.querySelector(".page-next-item"),
      pageSize: paginationContainer.querySelector(".page-size-select"),
    };
  }

  _bindEvents() {
    // Header click for sorting
    const headers = this.table.querySelectorAll("thead th[data-sortable]");
    headers.forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => this._handleSort(th.cellIndex));
    });

    // Pagination
    this.controls.prev.addEventListener("click", () => this.prevPage());
    this.controls.next.addEventListener("click", () => this.nextPage());
    this.controls.pageSize.addEventListener("change", (e) => {
      this.options.pageSize = parseInt(e.target.value, 10);
      this.state.page = 0;
      this.reload();
    });
  }

  _handleSort(columnIndex) {
    if (this.state.sortColumn === columnIndex) {
      this.state.sortDir = this.state.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.state.sortColumn = columnIndex;
      this.state.sortDir = "desc";
    }

    // Update visual indicators
    const headers = this.table.querySelectorAll("thead th");
    headers.forEach((th, i) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (i === columnIndex) {
        th.classList.add(`sorted-${this.state.sortDir}`);
      }
    });

    this.reload({ resetPage: true });
  }

  async reload({ resetPage = false } = {}) {
    if (resetPage) {
      this.state.page = 0;
    }
    if (this.state.loading) {
      this.state.abortController?.abort();
    }

    this.state.loading = true;
    this.state.abortController = new AbortController();

    // Use soft loading if we already have data
    const softLoad = this.state.data.length > 0;
    this._showLoading(softLoad);

    try {
      if (this.options.serverSide) {
        await this._fetchServerData();
      } else {
        this._renderClientData();
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.error("Table data fetch error:", error);
      this._showError("Failed to load data");
    } finally {
      this.state.loading = false;
      this.tbody.classList.remove("table-loading");
    }
  }

  async _fetchServerData() {
    const { page, sortColumn, sortDir } = this.state;
    const filters = this.options.getFilters();

    const payload = {
      draw: Date.now(),
      start: page * this.options.pageSize,
      length: this.options.pageSize,
      order: [{ column: sortColumn, dir: sortDir }],
      columns: this.options.columns.map((col, i) => ({
        data: col.data || i,
        name: col.name || "",
        searchable: col.searchable ?? true,
        orderable: col.orderable ?? true,
      })),
      filters,
    };

    const response = await fetch(this.options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: this.state.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    this.state.data = result.data || [];
    const totalRecords = Number.isFinite(result.recordsFiltered)
      ? result.recordsFiltered
      : Number.isFinite(result.recordsTotal)
        ? result.recordsTotal
        : 0;
    this.state.totalRecords = totalRecords;
    this.state.totalPages = Math.ceil(totalRecords / this.options.pageSize);

    this._render();
    this.options.onDataLoaded?.(result);
  }

  _renderClientData() {
    // For client-side data, just render what we have
    this._render();
  }

  _render() {
    this.tbody.innerHTML = "";

    if (this.state.data.length === 0) {
      this._showEmpty();
      return;
    }

    const fragment = document.createDocumentFragment();

    this.state.data.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      tr.dataset.index = rowIndex;

      this.options.columns.forEach((col) => {
        const td = document.createElement("td");

        if (col.render) {
          // Custom render function - returns HTML string or DOM element
          const content = col.render(row[col.data], "display", row, rowIndex);
          if (content instanceof HTMLElement) {
            td.appendChild(content);
          } else if (typeof content === "string") {
            // If render returns HTML string, we trust it's safe (developer responsibility)
            td.innerHTML = content;
          } else {
            td.textContent = String(content ?? "");
          }
        } else {
          // Default: escape and display as text
          td.textContent = escapeHtml(row[col.data] ?? "");
        }

        if (col.className) {
          td.className = col.className;
        }
        tr.appendChild(td);
      });

      if (this.options.onRowClick) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", (e) => {
          if (!e.target.closest("button, a, input, .no-row-click")) {
            this.options.onRowClick(row, rowIndex, tr);
          }
        });
      }

      fragment.appendChild(tr);
    });

    this.tbody.appendChild(fragment);
    this._updatePagination();
  }

  _showLoading(soft = false) {
    if (soft) {
      this.tbody.classList.add("table-loading");
    } else {
      const columns = this.options.columns.length;
      const rows = this.options.skeletonRows || 6;
      const widths = ["short", "wide", "medium", "wide", "medium", "short"];
      const skeletonRows = Array.from({ length: rows })
        .map(() => {
          const cells = Array.from({ length: columns })
            .map((_, colIndex) => {
              const widthClass = widths[colIndex % widths.length];
              return `
                <td>
                  <div class="skeleton-loader table-skeleton-block ${widthClass}"></div>
                </td>
              `;
            })
            .join("");
          return `<tr class="table-skeleton-row">${cells}</tr>`;
        })
        .join("");
      this.tbody.innerHTML = skeletonRows;
    }
  }

  _showEmpty() {
    this.tbody.innerHTML = `
      <tr>
        <td colspan="${this.options.columns.length}" class="text-center py-4 text-muted">
          ${escapeHtml(this.options.emptyMessage)}
        </td>
      </tr>
    `;
    this._updatePagination();
  }

  _showError(message) {
    this.tbody.innerHTML = `
      <tr>
        <td colspan="${this.options.columns.length}" class="text-center py-4 text-danger">
          <i class="fas fa-exclamation-circle me-2"></i>${escapeHtml(message)}
        </td>
      </tr>
    `;
  }

  _updatePagination() {
    const { page, totalRecords, totalPages } = this.state;
    const { pageSize } = this.options;

    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRecords);

    this.controls.info.textContent =
      totalRecords > 0
        ? `Showing ${start} to ${end} of ${totalRecords} entries`
        : "No entries";

    this.controls.prev.disabled = page === 0;
    this.controls.next.disabled = page >= totalPages - 1;

    // Remove existing page number items (everything between prev and next)
    const existingPageItems =
      this.controls.paginationList.querySelectorAll(".page-number-item");
    existingPageItems.forEach((item) => {
      item.remove();
    });

    // Calculate visible page range
    const maxVisible = 5;
    let startPage = Math.max(0, page - Math.floor(maxVisible / 2));
    const endPage = Math.min(totalPages, startPage + maxVisible);

    if (endPage - startPage < maxVisible) {
      startPage = Math.max(0, endPage - maxVisible);
    }

    // Insert new page number items before the next button
    for (let i = startPage; i < endPage; i++) {
      const li = document.createElement("li");
      li.className = `page-item page-number-item ${i === page ? "active" : ""}`;

      const btn = document.createElement("button");
      btn.className = "page-link";
      btn.textContent = String(i + 1);
      btn.addEventListener("click", () => this.goToPage(i));

      li.appendChild(btn);
      this.controls.nextItem.before(li);
    }
  }

  goToPage(page) {
    if (page >= 0 && page < this.state.totalPages) {
      this.state.page = page;
      this.reload();
    }
  }

  nextPage() {
    this.goToPage(this.state.page + 1);
  }

  prevPage() {
    this.goToPage(this.state.page - 1);
  }

  setData(data) {
    this.state.data = data;
    this.state.totalRecords = data.length;
    this.state.totalPages = Math.ceil(data.length / this.options.pageSize);
    this._render();
  }

  getSelectedRows(checkboxSelector = ".row-checkbox:checked") {
    return Array.from(this.tbody.querySelectorAll(checkboxSelector)).map(
      (cb) => cb.value
    );
  }

  destroy() {
    this.state.abortController?.abort();
    this.controls.pagination?.remove();
  }
}

export default TableManager;
