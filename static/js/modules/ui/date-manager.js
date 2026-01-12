import { CONFIG } from "../config.js";
import { uiState } from "../ui-state.js";
import { utils } from "../utils.js";
import store from "../spa/store.js";
import eventManager from "./event-manager.js";
import panelManager from "./panel-manager.js";

const dateUtils = window.DateUtils;

const dateManager = {
  flatpickrInstances: new Map(),

  init() {
    const startInput = uiState.getElement(CONFIG.UI.selectors.startDate);
    const endInput = uiState.getElement(CONFIG.UI.selectors.endDate);
    if (!startInput || !endInput) {
      return;
    }

    const startDate
      = store.get("filters.startDate")
      || utils.getStorage(CONFIG.STORAGE_KEYS.startDate)
      || dateUtils.getCurrentDate();
    const endDate
      = store.get("filters.endDate")
      || utils.getStorage(CONFIG.STORAGE_KEYS.endDate)
      || dateUtils.getCurrentDate();
    this.flatpickrInstances = new Map();

    const fpConfig = {
      enableTime: false,
      altInput: true,
      altFormat: "M j, Y",
      dateFormat: "Y-m-d",
      maxDate: "today",
      disableMobile: true,
      allowInput: true,
      animate: CONFIG.UI.animations.enabled && !uiState.reducedMotion,
      locale: { firstDayOfWeek: 0 },
    };

    if (!startInput._flatpickr) {
      const sp = dateUtils.initDatePicker(startInput, {
        ...fpConfig,
        maxDate: endDate,
        onChange: (sel) => {
          if (sel.length) {
            this.flatpickrInstances.get("end")?.set("minDate", sel[0]);
          }
        },
      });
      this.flatpickrInstances.set("start", sp);
    }

    if (!endInput._flatpickr) {
      const ep = dateUtils.initDatePicker(endInput, {
        ...fpConfig,
        minDate: startDate,
        onChange: (sel) => {
          if (sel.length) {
            this.flatpickrInstances.get("start")?.set("maxDate", sel[0]);
          }
        },
      });
      this.flatpickrInstances.set("end", ep);
    }

    this.updateInputs(startDate, endDate);
    this.updateIndicator();

    document.addEventListener("es:filters-change", (event) => {
      const detail = event.detail || {};
      if (detail.source === "filters") {
        return;
      }
      const nextStart
        = detail.startDate || store.get("filters.startDate") || startDate;
      const nextEnd = detail.endDate || store.get("filters.endDate") || endDate;
      if (!nextStart || !nextEnd) {
        return;
      }
      this.updateInputs(nextStart, nextEnd);
      this.updateIndicator();
    });

    // Bind quick-select buttons
    uiState.getAllElements(".quick-select-btn").forEach((btn) => {
      eventManager.add(btn, "click", () => this.setRange(btn.dataset.range));
    });

    // Bind apply and reset buttons
    const applyBtn = uiState.getElement(CONFIG.UI.selectors.applyFiltersBtn);
    const resetBtn = uiState.getElement(CONFIG.UI.selectors.resetFilters);
    if (applyBtn) {
      eventManager.add(applyBtn, "click", () => this.applyFilters());
    }
    if (resetBtn) {
      eventManager.add(resetBtn, "click", () => this.reset());
    }
  },

  updateInputs(startDate, endDate) {
    const startInputEl = uiState.getElement(CONFIG.UI.selectors.startDate);
    const endInputEl = uiState.getElement(CONFIG.UI.selectors.endDate);

    // Helper to calculate "today" for diverse constraints if needed,
    // but here we just need to relax them effectively.
    // For start picker: maxDate usually constrains it to <= End Date.
    // For end picker: minDate usually constrains it to >= Start Date.

    if (startInputEl?._flatpickr && endInputEl && endInputEl._flatpickr) {
      // 1. Relax constraints temporarily to allow any valid range
      // Set start's max to today (or broadly valid) to unblock moving it forward
      startInputEl._flatpickr.set("maxDate", "today");
      // Set end's min to null (or very old) to unblock moving it backward
      endInputEl._flatpickr.set("minDate", null);

      // 2. Set the dates
      // true argument triggers onChange, which normally re-sets constraints.
      // However, we want to ensure values are set first.
      startInputEl._flatpickr.setDate(startDate, false); // false = no event yet
      endInputEl._flatpickr.setDate(endDate, false); // false = no event yet

      // 3. Re-establish strict cross-linking manually or trigger events if needed.
      // The init() logic binds onChange to update the OTHER picker's min/max.
      // We should manually sync them now to be safe and clean.
      startInputEl._flatpickr.set("maxDate", endDate);
      endInputEl._flatpickr.set("minDate", startDate);

      // Optional: If we want to trigger internal listeners that might rely on change events
      // startInputEl.dispatchEvent(new Event('change'));
      // endInputEl.dispatchEvent(new Event('change'));
    } else {
      // Fallback or partial existence
      if (startInputEl) {
        if (startInputEl._flatpickr) {
          startInputEl._flatpickr.setDate(startDate, true);
        } else {
          startInputEl.value = startDate;
        }
      }
      if (endInputEl) {
        if (endInputEl._flatpickr) {
          endInputEl._flatpickr.setDate(endDate, true);
        } else {
          endInputEl.value = endDate;
        }
      }
    }
  },

  async setRange(range) {
    const btn = document.querySelector(`[data-range="${range}"]`);
    if (btn) {
      btn.classList.add("btn-loading");
    }
    try {
      const { startDate, endDate } = await dateUtils.getDateRangePreset(range);
      if (startDate && endDate) {
        this.updateInputs(startDate, endDate);
        uiState.getAllElements(".quick-select-btn").forEach((b) => {
          b.classList.toggle(CONFIG.UI.classes.active, b.dataset.range === range);
        });
        uiState.uiState.lastFilterPreset = range;
        uiState.saveUIState();
        await this.applyFilters();
      } else {
        throw new Error("Invalid date range");
      }
    } catch (err) {
      console.error("Error setting date range:", err);
      utils.showNotification(`Error setting date range: ${err.message}`, "danger");
    } finally {
      if (btn) {
        btn.classList.remove("btn-loading");
      }
    }
  },

  detectPreset(start, end) {
    if (!start || !end) {
      return null;
    }

    // Use string comparison for date strings (YYYY-MM-DD)
    const today = dateUtils.getCurrentDate();
    const yesterday = dateUtils.getYesterday();

    // Check if same day
    if (start === end) {
      if (start === today) {
        return "today";
      }
      if (start === yesterday) {
        return "yesterday";
      }
    }

    // For range presets, calculate day difference using string dates
    const startDate = dateUtils.parseDateString(start);
    const endDate = dateUtils.parseDateString(end);
    if (!startDate || !endDate) {
      return null;
    }

    const diffDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24));
    const endIsToday = end === today;

    if (endIsToday) {
      if (diffDays === 6) {
        return "last-week";
      }
      if (diffDays === 29 || diffDays === 30) {
        return "last-month";
      }
      if (diffDays === 89 || diffDays === 90) {
        return "last-quarter";
      }
      if (diffDays === 364 || diffDays === 365) {
        return "last-year";
      }
    }

    return null;
  },

  updateIndicator() {
    const indicator = uiState.getElement(CONFIG.UI.selectors.filterIndicator);
    if (!indicator) {
      return;
    }
    const span = indicator.querySelector(".filter-date-range");
    if (!span) {
      return;
    }
    const savedStartDate
      = utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || dateUtils.getCurrentDate();
    const savedEndDate
      = utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || dateUtils.getCurrentDate();
    const fmt = (d) => dateUtils.formatForDisplay(d, { dateStyle: "medium" }) || d;
    const preset = this.detectPreset(savedStartDate, savedEndDate);
    if (preset) {
      span.textContent
        = preset.charAt(0).toUpperCase() + preset.slice(1).replace("-", " ");
      indicator.setAttribute("data-preset", preset);
    } else {
      span.textContent
        = savedStartDate === savedEndDate
          ? fmt(savedStartDate)
          : `${fmt(savedStartDate)} - ${fmt(savedEndDate)}`;
      indicator.removeAttribute("data-preset");
    }
    indicator.classList.add("filter-changed");
    setTimeout(() => indicator.classList.remove("filter-changed"), 600);
  },

  async applyFilters() {
    const sIn = uiState.getElement(CONFIG.UI.selectors.startDate);
    const eIn = uiState.getElement(CONFIG.UI.selectors.endDate);
    const btn = uiState.getElement(CONFIG.UI.selectors.applyFiltersBtn);
    if (!sIn || !eIn) {
      utils.showNotification("Date input elements missing", "danger");
      return;
    }
    const startDateVal = sIn.value;
    const endDateVal = eIn.value;
    if (!dateUtils.isValidDateRange(startDateVal, endDateVal)) {
      utils.showNotification("Invalid date range", "warning");
      [sIn, eIn].forEach((el) => {
        el.classList.add("invalid-shake");
        setTimeout(() => el.classList.remove("invalid-shake"), 600);
      });
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add("btn-loading");
    }
    try {
      store.updateFilters(
        { startDate: startDateVal, endDate: endDateVal },
        { push: true, source: "filters" }
      );
      this.updateIndicator();
      await panelManager.close("filters");
      const fd = (d) => dateUtils.formatForDisplay(d, { dateStyle: "short" });
      utils.showNotification(
        `Filters applied: ${fd(startDateVal)} to ${fd(endDateVal)}`,
        "success",
        3000
      );
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("btn-loading");
      }
    }
  },

  reset() {
    const today = dateUtils.getCurrentDate();
    this.updateInputs(today, today);
    uiState.getAllElements(".quick-select-btn").forEach((btn) => {
      btn.classList.remove(CONFIG.UI.classes.active);
    });
    const todayBtn = uiState.getElement('.quick-select-btn[data-range="today"]');
    if (todayBtn) {
      todayBtn.classList.add(CONFIG.UI.classes.active);
    }
    this.updateIndicator();
    this.applyFilters();
    document.dispatchEvent(new Event("filtersReset"));
  },
};

export default dateManager;
