(() => {
  "use strict";

  const state = {
    page: 1,
    pageSize: 25,
    sortField: "payPeriodEnd",
    sortOrder: "desc",
    currency: "USD",
    filters: {
      search: "",
      department: "",
      status: "",
      startDate: "",
      endDate: "",
    },
    isLoading: false,
    debounceTimer: null,
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    setupEventListeners();
    fetchData();
  }

  function cacheElements() {
    elements.search = document.getElementById("search");
    elements.department = document.getElementById("department-filter");
    elements.status = document.getElementById("status-filter");
    elements.startDate = document.getElementById("start-date-filter");
    elements.endDate = document.getElementById("end-date-filter");
    elements.pageSize = document.getElementById("page-size");
    elements.resetFilters = document.getElementById("reset-filters");
    elements.table = document.getElementById("student-workers-table");
    elements.tableBody = elements.table.querySelector("tbody");
    elements.pagination = document.getElementById("pagination");
    elements.summary = document.getElementById("results-summary");
    elements.totalHours = document.getElementById("total-hours");
    elements.totalPayroll = document.getElementById("total-payroll");
    elements.avgRate = document.getElementById("avg-rate");
    elements.totalWorkers = document.getElementById("total-workers");
    elements.lastRefreshed = document.getElementById("last-refreshed");
    elements.loadingOverlay = document.getElementById("loading-overlay");
  }

  function setupEventListeners() {
    if (elements.search) {
      elements.search.addEventListener("input", () => {
        debounce(() => {
          state.filters.search = elements.search.value.trim();
          state.page = 1;
          fetchData();
        });
      });
    }

    [elements.department, elements.status].forEach((select, index) => {
      if (!select) return;
      select.addEventListener("change", () => {
        state.filters[index === 0 ? "department" : "status"] = select.value;
        state.page = 1;
        fetchData();
      });
    });

    [elements.startDate, elements.endDate].forEach((input, index) => {
      if (!input) return;
      input.addEventListener("change", () => {
        state.filters[index === 0 ? "startDate" : "endDate"] = input.value;
        state.page = 1;
        fetchData();
      });
    });

    if (elements.pageSize) {
      elements.pageSize.addEventListener("change", () => {
        const newSize = parseInt(elements.pageSize.value, 10);
        if (!Number.isNaN(newSize)) {
          state.pageSize = newSize;
          state.page = 1;
          fetchData();
        }
      });
    }

    if (elements.resetFilters) {
      elements.resetFilters.addEventListener("click", () => {
        resetFilters();
      });
    }

    elements.table
      .querySelectorAll("th.sortable")
      .forEach((header) =>
        header.addEventListener("click", () => handleSort(header)),
      );
  }

  function debounce(callback, delay = 250) {
    if (state.debounceTimer) {
      window.clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = window.setTimeout(callback, delay);
  }

  async function fetchData() {
    if (state.isLoading) return;

    setLoading(true);

    try {
      const params = new URLSearchParams({
        page: state.page.toString(),
        page_size: state.pageSize.toString(),
        sort_by: state.sortField,
        sort_order: state.sortOrder,
      });

      if (state.filters.search) params.set("search", state.filters.search);
      if (state.filters.department)
        params.set("department", state.filters.department);
      if (state.filters.status) params.set("status", state.filters.status);
      if (state.filters.startDate)
        params.set("start_date", state.filters.startDate);
      if (state.filters.endDate) params.set("end_date", state.filters.endDate);

      const response = await fetch(`/api/student-workers?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();

      if (data.total_pages && state.page > data.total_pages && data.total > 0) {
        state.page = data.total_pages;
        setLoading(false);
        fetchData();
        return;
      }

      state.sortField = data.sort?.field || state.sortField;
      state.sortOrder = data.sort?.order || state.sortOrder;
      state.currency = data.currency || state.currency;

      renderTotals(data);
      renderTable(data.items || []);
      renderPagination(data.page, data.total_pages);
      renderFilters(data.filters || {});
      updateSortIndicators();
      updateSummary(data.page, data.page_size, data.total);
      updateLastRefreshed();
    } catch (error) {
      console.error("Failed to load student worker data", error);
      showErrorRow("Unable to load student worker data. Please try again.");
      updateSummary(0, 0, 0);
      renderPagination(1, 1);
      renderTotals({ totals: { hours: 0, payroll: 0 }, total: 0 });
    } finally {
      setLoading(false);
    }
  }

  function renderTotals(data) {
    const totals = data.totals || { hours: 0, payroll: 0 };
    const totalHours = Number(totals.hours) || 0;
    const totalPayroll = Number(totals.payroll) || 0;
    const totalWorkers = Number(data.total) || 0;

    if (elements.totalHours) {
      elements.totalHours.textContent = formatNumber(totalHours, 2);
    }

    if (elements.totalPayroll) {
      elements.totalPayroll.textContent = formatCurrency(
        totalPayroll,
        data.currency,
      );
    }

    if (elements.avgRate) {
      const avgRate = totalHours > 0 ? totalPayroll / totalHours : 0;
      elements.avgRate.textContent = formatCurrency(avgRate, data.currency);
    }

    if (elements.totalWorkers) {
      const label = totalWorkers === 1 ? "worker" : "workers";
      elements.totalWorkers.textContent = `${totalWorkers.toLocaleString()} ${label}`;
    }
  }

  function renderTable(items) {
    if (!elements.tableBody) return;
    elements.tableBody.innerHTML = "";

    if (!items.length) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td colspan="9" class="text-center py-5 text-secondary">
          No student workers match your current filters.
        </td>`;
      elements.tableBody.appendChild(row);
      return;
    }

    items.forEach((item) => {
      const row = document.createElement("tr");
      const payPeriod = formatPayPeriod(item.payPeriodStart, item.payPeriodEnd);
      row.innerHTML = `
        <td>
          <div class="fw-semibold">${escapeHtml(item.name || "Unknown")}</div>
          <div class="text-secondary small">${escapeHtml(item.email || "")}</div>
        </td>
        <td>${escapeHtml(item.studentId || "—")}</td>
        <td>${escapeHtml(item.department || "—")}</td>
        <td><span class="badge bg-status">${escapeHtml(item.status || "—")}</span></td>
        <td class="text-end">${formatNumber(item.hoursWorked)}</td>
        <td class="text-end">${formatCurrency(item.hourlyRate, item.currency)}</td>
        <td class="text-end">${formatCurrency(item.payrollAmount, item.currency)}</td>
        <td>${payPeriod}</td>
        <td>${formatDateTime(item.lastUpdated)}</td>`;
      elements.tableBody.appendChild(row);
    });
  }

  function renderPagination(currentPage = 1, totalPages = 1) {
    if (!elements.pagination) return;
    elements.pagination.innerHTML = "";

    const createPageItem = (
      label,
      page,
      disabled = false,
      active = false,
      ariaLabel,
    ) => {
      const li = document.createElement("li");
      li.className = `page-item${disabled ? " disabled" : ""}${active ? " active" : ""}`;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "page-link";
      link.textContent = label;
      if (ariaLabel) link.setAttribute("aria-label", ariaLabel);
      if (!disabled) {
        link.addEventListener("click", () => {
          state.page = page;
          fetchData();
        });
      }
      li.appendChild(link);
      elements.pagination.appendChild(li);
    };

    const safeTotal = Math.max(totalPages || 1, 1);
    const prevDisabled = currentPage <= 1;
    createPageItem(
      "«",
      Math.max(1, currentPage - 1),
      prevDisabled,
      false,
      "Previous page",
    );

    const maxButtons = 7;
    let start = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let end = Math.min(safeTotal, start + maxButtons - 1);
    if (end - start + 1 < maxButtons) {
      start = Math.max(1, end - maxButtons + 1);
    }

    if (start > 1) {
      createPageItem("1", 1, false, currentPage === 1);
      if (start > 2) {
        appendEllipsis();
      }
    }

    for (let page = start; page <= end; page += 1) {
      createPageItem(page.toString(), page, false, page === currentPage);
    }

    if (end < safeTotal) {
      if (end < safeTotal - 1) {
        appendEllipsis();
      }
      createPageItem(
        safeTotal.toString(),
        safeTotal,
        false,
        currentPage === safeTotal,
      );
    }

    const nextDisabled = currentPage >= safeTotal;
    createPageItem(
      "»",
      Math.min(safeTotal, currentPage + 1),
      nextDisabled,
      false,
      "Next page",
    );
  }

  function appendEllipsis() {
    const li = document.createElement("li");
    li.className = "page-item disabled";
    li.innerHTML = '<span class="page-link">…</span>';
    elements.pagination.appendChild(li);
  }

  function renderFilters(filters) {
    if (!filters) return;
    updateSelectOptions(
      elements.department,
      filters.departments,
      state.filters.department,
    );
    updateSelectOptions(
      elements.status,
      filters.statuses,
      state.filters.status,
    );
  }

  function updateSelectOptions(select, options = [], currentValue = "") {
    if (!select) return;
    const previous = currentValue || "";
    const defaultOption = select.querySelector('option[value=""]');
    select.innerHTML = "";
    const defaultNode = document.createElement("option");
    defaultNode.value = "";
    defaultNode.textContent = "All";
    select.appendChild(defaultNode);

    options
      .filter((option) => option && option.trim())
      .forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option;
        opt.textContent = option;
        select.appendChild(opt);
      });

    select.value =
      previous &&
      Array.from(select.options).some((opt) => opt.value === previous)
        ? previous
        : "";
  }

  function updateSummary(page, pageSize, total) {
    if (!elements.summary) return;
    if (!total) {
      elements.summary.textContent = "Showing 0 of 0 workers";
      return;
    }
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    elements.summary.textContent = `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${total.toLocaleString()} workers`;
  }

  function updateSortIndicators() {
    elements.table.querySelectorAll("th.sortable").forEach((header) => {
      header.classList.remove("sort-asc", "sort-desc");
      const sortKey = header.getAttribute("data-sort");
      if (!sortKey) return;
      if (
        (sortKey === "hours" && state.sortField === "hoursWorked") ||
        (sortKey === "pay" && state.sortField === "payrollAmount") ||
        state.sortField === sortKey
      ) {
        header.classList.add(
          state.sortOrder === "desc" ? "sort-desc" : "sort-asc",
        );
      }
    });
  }

  function handleSort(header) {
    const sortKey = header.getAttribute("data-sort");
    if (!sortKey) return;

    const mapping = {
      hours: "hoursWorked",
      pay: "payrollAmount",
      rate: "hourlyRate",
    };

    const resolvedKey = mapping[sortKey] || sortKey;

    if (state.sortField === resolvedKey) {
      state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
    } else {
      state.sortField = resolvedKey;
      state.sortOrder = resolvedKey === "name" ? "asc" : "desc";
    }

    state.page = 1;
    fetchData();
  }

  function resetFilters() {
    state.filters = {
      search: "",
      department: "",
      status: "",
      startDate: "",
      endDate: "",
    };

    if (elements.search) elements.search.value = "";
    if (elements.department) elements.department.value = "";
    if (elements.status) elements.status.value = "";
    if (elements.startDate) elements.startDate.value = "";
    if (elements.endDate) elements.endDate.value = "";

    state.page = 1;
    fetchData();
  }

  function showErrorRow(message) {
    if (!elements.tableBody) return;
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="9" class="text-center py-5 text-danger">
          <i class="fas fa-exclamation-triangle me-2"></i>${message}
        </td>
      </tr>`;
  }

  function updateLastRefreshed() {
    if (!elements.lastRefreshed) return;
    const now = new Date();
    elements.lastRefreshed.textContent = now.toLocaleString();
  }

  function setLoading(isLoading) {
    state.isLoading = isLoading;
    if (!elements.loadingOverlay) return;
    if (isLoading) {
      elements.loadingOverlay.classList.add("show");
      elements.loadingOverlay.setAttribute("aria-hidden", "false");
    } else {
      elements.loadingOverlay.classList.remove("show");
      elements.loadingOverlay.setAttribute("aria-hidden", "true");
    }
  }

  function formatNumber(value, decimals = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0";
    return numeric.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function formatCurrency(value, currencyOverride) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "$0.00";
    const currency = currencyOverride || state.currency || "USD";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(numeric);
    } catch (error) {
      console.warn("Currency formatting failed", error);
      return `${currency} ${numeric.toFixed(2)}`;
    }
  }

  function formatPayPeriod(start, end) {
    const hasStart = Boolean(start);
    const hasEnd = Boolean(end);
    if (!hasStart && !hasEnd) return "—";

    if (hasStart && hasEnd) {
      return `${formatDate(start)} – ${formatDate(end)}`;
    }

    return formatDate(hasStart ? start : end);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function escapeHtml(value) {
    if (typeof value !== "string") {
      return value === undefined || value === null ? "" : String(value);
    }
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }
})();
