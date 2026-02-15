import { CONFIG } from "../core/config.js";
import store from "../core/store.js";
import { DateUtils, utils } from "../utils.js";
import eventManager from "./event-manager.js";

const dateUtils = DateUtils;

const dateManager = {
  flatpickrInstances: new Map(),
  isDropdownOpen: false,
  portalPlacements: {
    dropdown: null,
    overlay: null,
  },
  usingMobilePortal: false,
  viewportSyncHandler: null,

  isMobileViewport() {
    return window.matchMedia("(max-width: 768px)").matches;
  },

  cacheOriginalPlacement(key, element) {
    if (!element || this.portalPlacements[key]) {
      return;
    }
    this.portalPlacements[key] = {
      parent: element.parentElement,
      nextSibling: element.nextSibling,
    };
  },

  moveElementToBody(key, element) {
    if (!element) {
      return;
    }
    this.cacheOriginalPlacement(key, element);
    if (element.parentElement !== document.body) {
      document.body.append(element);
    }
  },

  restoreElementPlacement(key, element, fallbackParent = null) {
    if (!element) {
      return;
    }
    const placement = this.portalPlacements[key];
    const targetParent =
      (placement?.parent && placement.parent.isConnected ? placement.parent : fallbackParent) ||
      null;
    if (!targetParent || element.parentElement === targetParent) {
      return;
    }
    const nextSibling = placement?.nextSibling;
    if (nextSibling && nextSibling.parentNode === targetParent) {
      targetParent.insertBefore(element, nextSibling);
    } else {
      targetParent.appendChild(element);
    }
  },

  syncMobilePortal() {
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const overlay = store.getElement(CONFIG.UI.selectors.datePickerOverlay);
    const wrapper = store.getElement(CONFIG.UI.selectors.datePickerWrapper);

    if (!dropdown || !overlay) {
      return;
    }

    if (this.isMobileViewport()) {
      // Mobile bottom-sheet must be mounted on <body> so it is not clipped
      // by the fixed/glass header's containing block.
      this.moveElementToBody("dropdown", dropdown);
      this.moveElementToBody("overlay", overlay);
      this.usingMobilePortal = true;
      return;
    }

    this.restoreElementPlacement("dropdown", dropdown, wrapper);
    this.restoreElementPlacement(
      "overlay",
      overlay,
      this.portalPlacements.overlay?.parent || wrapper?.parentElement || document.body
    );
    this.usingMobilePortal = false;
  },

  bindViewportSync() {
    if (this.viewportSyncHandler) {
      return;
    }
    this.viewportSyncHandler = utils.debounce(() => {
      const wasUsingMobilePortal = this.usingMobilePortal;
      this.syncMobilePortal();

      // If the viewport mode changes while open, close cleanly so users
      // don't keep a stale desktop/mobile layout.
      if (wasUsingMobilePortal !== this.usingMobilePortal && this.isDropdownOpen) {
        this.closeDropdown();
      }
    }, 120);
    window.addEventListener("resize", this.viewportSyncHandler, { passive: true });
  },

  init() {
    const startInput = store.getElement(CONFIG.UI.selectors.dpStartDate);
    const endInput = store.getElement(CONFIG.UI.selectors.dpEndDate);
    if (!startInput || !endInput) {
      return;
    }

    this.syncMobilePortal();
    this.bindViewportSync();

    const startDate =
      store.get("filters.startDate") ||
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) ||
      dateUtils.getCurrentDate();
    const endDate =
      store.get("filters.endDate") ||
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) ||
      dateUtils.getCurrentDate();
    this.flatpickrInstances = new Map();

    const fpConfig = {
      enableTime: false,
      altInput: true,
      altFormat: "M j, Y",
      dateFormat: "Y-m-d",
      maxDate: "today",
      disableMobile: true,
      allowInput: true,
      animate: CONFIG.UI.animations.enabled && !store.ui.reducedMotion,
      locale: { firstDayOfWeek: 0 },
      // Append calendar to body so it's not clipped by the bottom sheet overflow
      appendTo: document.body,
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
    this.updateDateDisplay();
    this.highlightActivePreset();

    // Listen for external filter changes
    document.addEventListener("es:filters-change", (event) => {
      const detail = event.detail || {};
      if (detail.source === "filters") {
        return;
      }
      const nextStart = detail.startDate || store.get("filters.startDate") || startDate;
      const nextEnd = detail.endDate || store.get("filters.endDate") || endDate;
      if (!nextStart || !nextEnd) {
        return;
      }
      this.updateInputs(nextStart, nextEnd);
      this.updateDateDisplay();
      this.highlightActivePreset();
    });

    // Bind dropdown trigger
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    if (trigger) {
      eventManager.add(trigger, "click", (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

    // Bind preset buttons (auto-apply on click)
    store.getAllElements(".preset-btn").forEach((btn) => {
      eventManager.add(btn, "click", () => this.setRange(btn.dataset.range));
    });

    // Bind apply and reset buttons
    const applyBtn = store.getElement(CONFIG.UI.selectors.datePickerApply);
    const resetBtn = store.getElement(CONFIG.UI.selectors.datePickerReset);
    if (applyBtn) {
      eventManager.add(applyBtn, "click", () => this.applyFilters());
    }
    if (resetBtn) {
      eventManager.add(resetBtn, "click", () => this.reset());
    }

    // Close dropdown on click outside
    document.addEventListener("click", (e) => {
      if (!this.isDropdownOpen) {
        return;
      }
      const wrapper = store.getElement(CONFIG.UI.selectors.datePickerWrapper);
      const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
      if (wrapper && !wrapper.contains(e.target) && !dropdown?.contains(e.target)) {
        // Check if click is inside a flatpickr calendar
        if (e.target.closest(".flatpickr-calendar")) {
          return;
        }
        this.closeDropdown();
      }
    });

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isDropdownOpen) {
        this.closeDropdown();
      }
    });

    // Overlay click closes dropdown (mobile)
    const overlay = store.getElement(CONFIG.UI.selectors.datePickerOverlay);
    if (overlay) {
      eventManager.add(overlay, "click", () => this.closeDropdown());
    }
  },

  toggleDropdown() {
    if (this.isDropdownOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  },

  openDropdown() {
    this.syncMobilePortal();

    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    const overlay = store.getElement(CONFIG.UI.selectors.datePickerOverlay);

    if (!dropdown) {
      return;
    }

    dropdown.classList.add("open");
    trigger?.setAttribute("aria-expanded", "true");
    this.isDropdownOpen = true;

    // Show overlay on mobile
    if (window.innerWidth <= 768 && overlay) {
      overlay.classList.add("visible");
    }
  },

  closeDropdown() {
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    const overlay = store.getElement(CONFIG.UI.selectors.datePickerOverlay);

    if (!dropdown) {
      return;
    }

    dropdown.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
    this.isDropdownOpen = false;

    // Hide overlay
    if (overlay) {
      overlay.classList.remove("visible");
    }

    if (!this.isMobileViewport()) {
      this.syncMobilePortal();
    }
  },

  updateInputs(startDate, endDate) {
    const startInputEl = store.getElement(CONFIG.UI.selectors.dpStartDate);
    const endInputEl = store.getElement(CONFIG.UI.selectors.dpEndDate);

    if (startInputEl?._flatpickr && endInputEl && endInputEl._flatpickr) {
      // Relax constraints temporarily
      startInputEl._flatpickr.set("maxDate", "today");
      endInputEl._flatpickr.set("minDate", null);

      // Set the dates
      startInputEl._flatpickr.setDate(startDate, false);
      endInputEl._flatpickr.setDate(endDate, false);

      // Re-establish strict cross-linking
      startInputEl._flatpickr.set("maxDate", endDate);
      endInputEl._flatpickr.set("minDate", startDate);
    } else {
      // Fallback
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
        this.highlightActivePreset(range);
        store.set("ui.lastFilterPreset", range, { source: "ui" });
        store.saveUIState();
        // Auto-apply for presets
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

    // For range presets, calculate day difference
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

  highlightActivePreset(preset = null) {
    const savedStartDate =
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || dateUtils.getCurrentDate();
    const savedEndDate =
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || dateUtils.getCurrentDate();

    const activePreset = preset || this.detectPreset(savedStartDate, savedEndDate);

    store.getAllElements(".preset-btn").forEach((btn) => {
      btn.classList.toggle(
        CONFIG.UI.classes.active,
        btn.dataset.range === activePreset
      );
    });
  },

  updateDateDisplay() {
    const display = store.getElement(CONFIG.UI.selectors.dateDisplay);
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    if (!display) {
      return;
    }

    const savedStartDate =
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || dateUtils.getCurrentDate();
    const savedEndDate =
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || dateUtils.getCurrentDate();
    const today = dateUtils.getCurrentDate();

    const fmt = (d) => dateUtils.formatForDisplay(d, { dateStyle: "medium" }) || d;
    const preset = this.detectPreset(savedStartDate, savedEndDate);

    // Map preset names to display text
    const presetLabels = {
      today: "Today",
      yesterday: "Yesterday",
      "last-week": "Last 7 Days",
      "last-month": "Last 30 Days",
      "last-quarter": "Last Quarter",
      "last-year": "Last Year",
      "all-time": "All Time",
    };

    if (preset && presetLabels[preset]) {
      display.textContent = presetLabels[preset];
    } else if (savedStartDate === savedEndDate) {
      display.textContent = fmt(savedStartDate);
    } else {
      display.textContent = `${fmt(savedStartDate)} - ${fmt(savedEndDate)}`;
    }

    // Update trigger active state
    const isNotToday = savedStartDate !== today || savedEndDate !== today;
    trigger?.classList.toggle("has-filter", isNotToday);
  },

  applyFilters() {
    const sIn = store.getElement(CONFIG.UI.selectors.dpStartDate);
    const eIn = store.getElement(CONFIG.UI.selectors.dpEndDate);
    const btn = store.getElement(CONFIG.UI.selectors.datePickerApply);
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
      this.updateDateDisplay();
      this.highlightActivePreset();
      this.closeDropdown();
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
    this.highlightActivePreset("today");
    this.updateDateDisplay();
    this.applyFilters();
    document.dispatchEvent(new Event("filtersReset"));
  },
};

export default dateManager;
