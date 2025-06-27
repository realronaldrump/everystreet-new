import { UI_CONFIG as CONFIG } from "../ui-config.js";
import uiState from "../ui-state.js";
import utils from "../utils.js";
import dateUtils from "../date-utils.js";
import panelManager from "./panel-manager.js";
import eventManager from "./event-manager.js";

const dateManager = {
  flatpickrInstances: new Map(),

  init() {
    const startInput = uiState.getElement(CONFIG.selectors.startDate);
    const endInput = uiState.getElement(CONFIG.selectors.endDate);
    if (!startInput || !endInput) return;

    const startDate =
      utils.getStorage(CONFIG.storage.startDate) || dateUtils.getCurrentDate();
    const endDate =
      utils.getStorage(CONFIG.storage.endDate) || dateUtils.getCurrentDate();
    this.flatpickrInstances = new Map();

    const fpConfig = {
      enableTime: false,
      altInput: true,
      altFormat: "M j, Y",
      dateFormat: "Y-m-d",
      maxDate: "today",
      disableMobile: true,
      allowInput: true,
      animate: CONFIG.animations.enabled && !uiState.reducedMotion,
      locale: { firstDayOfWeek: 0 },
    };

    if (!startInput._flatpickr) {
      const sp = dateUtils.initDatePicker(startInput, {
        ...fpConfig,
        maxDate: endDate,
        onChange: (sel) => {
          if (sel.length)
            this.flatpickrInstances.get("end")?.set("minDate", sel[0]);
        },
      });
      this.flatpickrInstances.set("start", sp);
    }

    if (!endInput._flatpickr) {
      const ep = dateUtils.initDatePicker(endInput, {
        ...fpConfig,
        minDate: startDate,
        onChange: (sel) => {
          if (sel.length)
            this.flatpickrInstances.get("start")?.set("maxDate", sel[0]);
        },
      });
      this.flatpickrInstances.set("end", ep);
    }

    this.updateInputs(startDate, endDate);
    this.updateIndicator();

    // Bind quick-select buttons
    uiState.getAllElements(".quick-select-btn").forEach((btn) => {
      eventManager.add(btn, "click", () => this.setRange(btn.dataset.range));
    });

    // Bind apply and reset buttons
    const applyBtn = uiState.getElement(CONFIG.selectors.applyFiltersBtn);
    const resetBtn = uiState.getElement(CONFIG.selectors.resetFilters);
    if (applyBtn)
      eventManager.add(applyBtn, "click", () => this.applyFilters());
    if (resetBtn) eventManager.add(resetBtn, "click", () => this.reset());
  },

  updateInputs(startDate, endDate) {
    const s = uiState.getElement(CONFIG.selectors.startDate);
    const e = uiState.getElement(CONFIG.selectors.endDate);
    if (s) s._flatpickr?.setDate(startDate, true) || (s.value = startDate);
    if (e) e._flatpickr?.setDate(endDate, true) || (e.value = endDate);
  },

  async setRange(range) {
    const btn = document.querySelector(`[data-range="${range}"]`);
    if (btn) btn.classList.add("btn-loading");
    try {
      const { startDate, endDate } = await dateUtils.getDateRangePreset(range);
      if (startDate && endDate) {
        this.updateInputs(startDate, endDate);
        utils.setStorage(CONFIG.storage.startDate, startDate);
        utils.setStorage(CONFIG.storage.endDate, endDate);
        this.updateIndicator();
        uiState
          .getAllElements(".quick-select-btn")
          .forEach((b) =>
            b.classList.toggle(
              CONFIG.classes.active,
              b.dataset.range === range,
            ),
          );
        uiState.uiState.lastFilterPreset = range;
        uiState.saveUIState();
      } else throw new Error("Invalid date range");
    } catch (err) {
      console.error("Error setting date range:", err);
      utils.showNotification(
        `Error setting date range: ${err.message}`,
        "danger",
      );
    } finally {
      if (btn) btn.classList.remove("btn-loading");
    }
  },

  detectPreset(start, end) {
    const s = new Date(start);
    const e = new Date(end);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((e - s) / (1000 * 60 * 60 * 24));
    if (
      s.toDateString() === e.toDateString() &&
      s.toDateString() === today.toDateString()
    )
      return "today";
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    if (
      s.toDateString() === yest.toDateString() &&
      e.toDateString() === yest.toDateString()
    )
      return "yesterday";
    if (diffDays === 6) return "last-week";
    if (diffDays === 29 || diffDays === 30) return "last-month";
    if (diffDays === 89 || diffDays === 90) return "last-quarter";
    if (diffDays === 364 || diffDays === 365) return "last-year";
    return null;
  },

  updateIndicator() {
    const indicator = uiState.getElement(CONFIG.selectors.filterIndicator);
    if (!indicator) return;
    const span = indicator.querySelector(".filter-date-range");
    if (!span) return;
    const s =
      utils.getStorage(CONFIG.storage.startDate) || dateUtils.getCurrentDate();
    const e =
      utils.getStorage(CONFIG.storage.endDate) || dateUtils.getCurrentDate();
    const fmt = (d) =>
      dateUtils.formatForDisplay(d, { dateStyle: "medium" }) || d;
    const preset = this.detectPreset(s, e);
    if (preset) {
      span.textContent =
        preset.charAt(0).toUpperCase() + preset.slice(1).replace("-", " ");
      indicator.setAttribute("data-preset", preset);
    } else {
      span.textContent = s === e ? fmt(s) : `${fmt(s)} - ${fmt(e)}`;
      indicator.removeAttribute("data-preset");
    }
    indicator.classList.add("filter-changed");
    setTimeout(() => indicator.classList.remove("filter-changed"), 600);
  },

  async applyFilters() {
    const sIn = uiState.getElement(CONFIG.selectors.startDate);
    const eIn = uiState.getElement(CONFIG.selectors.endDate);
    const btn = uiState.getElement(CONFIG.selectors.applyFiltersBtn);
    if (!sIn || !eIn) {
      utils.showNotification("Date input elements missing", "danger");
      return;
    }
    const s = sIn.value;
    const e = eIn.value;
    if (!dateUtils.isValidDateRange(s, e)) {
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
      utils.setStorage(CONFIG.storage.startDate, s);
      utils.setStorage(CONFIG.storage.endDate, e);
      this.updateIndicator();
      await panelManager.close("filters");
      document.dispatchEvent(
        new CustomEvent("filtersApplied", {
          detail: { startDate: s, endDate: e },
        }),
      );
      const fd = (d) => dateUtils.formatForDisplay(d, { dateStyle: "short" });
      utils.showNotification(
        `Filters applied: ${fd(s)} to ${fd(e)}`,
        "success",
        3000,
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
    utils.setStorage(CONFIG.storage.startDate, today);
    utils.setStorage(CONFIG.storage.endDate, today);
    uiState
      .getAllElements(".quick-select-btn")
      .forEach((btn) => btn.classList.remove(CONFIG.classes.active));
    const todayBtn = uiState.getElement(
      '.quick-select-btn[data-range="today"]',
    );
    if (todayBtn) todayBtn.classList.add(CONFIG.classes.active);
    this.updateIndicator();
    this.applyFilters();
    document.dispatchEvent(new Event("filtersReset"));
  },
};

if (!window.dateManager) window.dateManager = dateManager;
export { dateManager as default };
