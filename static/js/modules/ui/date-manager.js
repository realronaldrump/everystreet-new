import { CONFIG } from "../core/config.js";
import store from "../core/store.js";
import { DateUtils, utils } from "../utils.js";
import eventManager from "./event-manager.js";

const dateUtils = DateUtils;

const MS_PER_DAY = 86_400_000;
const SHEET_DISMISS_DISTANCE = 110;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const dateManager = {
  flatpickrInstances: new Map(),
  isDropdownOpen: false,
  portalPlacements: {
    dropdown: null,
    overlay: null,
  },
  usingMobilePortal: false,
  viewportSyncHandler: null,
  isCustomRangeOpen: false,
  scrollLock: null,
  drag: null,
  monthGridYear: null,

  syncRangePickerLayout() {
    const picker = this.flatpickrInstances.get("range");
    if (!picker) {
      return;
    }
    const showMonths = this.isMobileViewport() ? 1 : 2;
    if (picker.config.showMonths !== showMonths) {
      picker.set("showMonths", showMonths);
    }
    picker.calendarContainer?.classList.toggle("es-single-month", showMonths === 1);
    picker.calendarContainer?.classList.toggle("es-multi-month", showMonths === 2);
  },

  getSelectedDateRange() {
    const today = dateUtils.getCurrentDate();
    const startDate =
      store.get("filters.startDate") ||
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) ||
      today;
    const endDate =
      store.get("filters.endDate") ||
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) ||
      today;
    return { startDate, endDate };
  },

  isMobileViewport() {
    return window.matchMedia("(max-width: 768px)").matches;
  },

  /**
   * iOS Safari keeps scrolling the document behind a fixed bottom sheet even
   * with `overflow: hidden` on <body>, which makes the sheet feel broken.
   * Pinning the body is the only reliable lock, so the scroll offset is
   * captured here and restored on close.
   */
  lockPageScroll() {
    if (this.scrollLock) {
      return;
    }
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    this.scrollLock = { scrollY };
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add("date-picker-open", "date-picker-scroll-locked");
  },

  unlockPageScroll() {
    document.body.classList.remove("date-picker-open", "date-picker-scroll-locked");
    if (!this.scrollLock) {
      return;
    }
    const { scrollY } = this.scrollLock;
    this.scrollLock = null;
    document.body.style.top = "";
    // `behavior: instant` matters: the global `scroll-behavior: smooth` would
    // otherwise animate the restore and leave the page mid-flight.
    window.scrollTo({ top: scrollY, left: 0, behavior: "instant" });
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

  restoreElementPlacement(key, element, defaultParent = null) {
    if (!element) {
      return;
    }
    const placement = this.portalPlacements[key];
    const targetParent =
      (placement?.parent?.isConnected ? placement.parent : defaultParent) || null;
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

  /**
   * Month/year navigation, built from plain buttons.
   *
   * Flatpickr's own month picker is a native <select> nested inside an element
   * it gives `transform: translate3d(0,0,0)`. iOS Safari refuses to open a
   * select's picker in that situation, so the month control was simply dead on
   * iPhone. Buttons have no such problem, so flatpickr's nav row is hidden
   * (CSS) and this drives the calendar instead.
   */
  buildMonthGrid() {
    const options = store.getElement(CONFIG.UI.selectors.dpMonthOptions);
    if (!options || options.childElementCount) {
      return;
    }
    for (const [index, name] of MONTH_NAMES.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dp-month-option";
      button.dataset.month = String(index);
      button.textContent = name.slice(0, 3);
      button.setAttribute("aria-label", name);
      eventManager.add(button, "click", () => this.jumpToMonth(index));
      options.append(button);
    }
  },

  bindMonthNav() {
    const picker = this.flatpickrInstances.get("range");
    const bind = (selector, handler) => {
      const element = store.getElement(selector);
      if (element) {
        eventManager.add(element, "click", handler);
      }
    };

    this.buildMonthGrid();

    bind(CONFIG.UI.selectors.dpPrevMonth, () => {
      picker?.changeMonth(-1);
      this.syncMonthNav();
    });
    bind(CONFIG.UI.selectors.dpNextMonth, () => {
      picker?.changeMonth(1);
      this.syncMonthNav();
    });
    bind(CONFIG.UI.selectors.dpMonthToggle, () => {
      this.setMonthGridOpen(
        store.getElement(CONFIG.UI.selectors.dpMonthGrid)?.hidden !== false
      );
    });
    bind(CONFIG.UI.selectors.dpPrevYear, () => this.stepMonthGridYear(-1));
    bind(CONFIG.UI.selectors.dpNextYear, () => this.stepMonthGridYear(1));
  },

  maxSelectableDate() {
    const configured = this.flatpickrInstances.get("range")?.config?.maxDate;
    return configured instanceof Date
      ? configured
      : dateUtils.parseDateString(dateUtils.getCurrentDate());
  },

  setMonthGridOpen(open) {
    const grid = store.getElement(CONFIG.UI.selectors.dpMonthGrid);
    const toggle = store.getElement(CONFIG.UI.selectors.dpMonthToggle);
    if (!grid || !toggle) {
      return;
    }
    grid.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    store
      .getElement(CONFIG.UI.selectors.dpCalendarHost)
      ?.classList.toggle("month-grid-open", open);
    if (open) {
      this.monthGridYear =
        this.flatpickrInstances.get("range")?.currentYear ?? this.monthGridYear;
      this.syncMonthNav();
    }
  },

  stepMonthGridYear(step) {
    const maxDate = this.maxSelectableDate();
    const next = (this.monthGridYear ?? maxDate?.getFullYear() ?? 0) + step;
    if (maxDate && next > maxDate.getFullYear()) {
      return;
    }
    this.monthGridYear = next;
    this.syncMonthNav();
  },

  jumpToMonth(month) {
    const picker = this.flatpickrInstances.get("range");
    const year = this.monthGridYear ?? picker?.currentYear;
    if (!picker || year == null) {
      return;
    }
    picker.jumpToDate(new Date(year, month, 1), false);
    picker.redraw();
    this.setMonthGridOpen(false);
    this.syncMonthNav();
  },

  syncMonthNav() {
    const picker = this.flatpickrInstances.get("range");
    const label = store.getElement(CONFIG.UI.selectors.dpMonthText);
    const yearText = store.getElement(CONFIG.UI.selectors.dpYearText);
    const nextMonth = store.getElement(CONFIG.UI.selectors.dpNextMonth);
    const nextYear = store.getElement(CONFIG.UI.selectors.dpNextYear);
    if (!picker || picker.currentMonth == null) {
      return;
    }

    const month = picker.currentMonth;
    const year = picker.currentYear;
    if (label) {
      label.textContent = `${MONTH_NAMES[month]} ${year}`;
    }

    const maxDate = this.maxSelectableDate();
    const gridYear = this.monthGridYear ?? year;
    if (yearText) {
      yearText.textContent = String(gridYear);
    }
    // Nothing past the latest selectable month is reachable.
    if (nextMonth) {
      nextMonth.disabled = Boolean(
        maxDate &&
          (year > maxDate.getFullYear() ||
            (year === maxDate.getFullYear() && month >= maxDate.getMonth()))
      );
    }
    if (nextYear) {
      nextYear.disabled = Boolean(maxDate && gridYear >= maxDate.getFullYear());
    }

    for (const option of store.getAllElements(".dp-month-option")) {
      const optionMonth = Number(option.dataset.month);
      const beyondMax = Boolean(
        maxDate &&
          (gridYear > maxDate.getFullYear() ||
            (gridYear === maxDate.getFullYear() && optionMonth > maxDate.getMonth()))
      );
      option.disabled = beyondMax;
      const isCurrent = optionMonth === month && gridYear === year;
      option.classList.toggle(CONFIG.UI.classes.active, isCurrent);
      option.setAttribute("aria-pressed", String(isCurrent));
    }
  },

  /**
   * Swipe-down-to-dismiss for the mobile sheet. The grab handle is drawn on
   * mobile, so it has to actually do something.
   */
  bindSheetDrag() {
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const dragHandles = [
      store.getElement(CONFIG.UI.selectors.dpGrabber),
      store.getElement(CONFIG.UI.selectors.dpHeader),
    ].filter(Boolean);
    if (!dropdown || !dragHandles.length) {
      return;
    }

    for (const handle of dragHandles) {
      eventManager.add(handle, "pointerdown", (event) => this.startSheetDrag(event));
    }
    window.addEventListener("pointermove", (event) => this.moveSheetDrag(event), {
      passive: false,
    });
    window.addEventListener("pointerup", () => this.endSheetDrag());
    window.addEventListener("pointercancel", () => this.endSheetDrag());
  },

  startSheetDrag(event) {
    if (!this.isDropdownOpen || !this.isMobileViewport() || this.drag) {
      return;
    }
    // Never hijack the close button or any other control in the header.
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    if (!dropdown) {
      return;
    }
    this.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      offset: 0,
      height: dropdown.getBoundingClientRect().height,
    };
    dropdown.classList.add("dragging");
  },

  moveSheetDrag(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    if (!dropdown) {
      return;
    }
    // Downward only — dragging up must not detach the sheet from the edge.
    this.drag.offset = Math.max(0, event.clientY - this.drag.startY);
    dropdown.style.setProperty("--dp-drag-y", `${this.drag.offset}px`);
    if (event.cancelable) {
      event.preventDefault();
    }
  },

  endSheetDrag() {
    if (!this.drag) {
      return;
    }
    const { offset, height } = this.drag;
    this.drag = null;
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    dropdown?.classList.remove("dragging");
    dropdown?.style.removeProperty("--dp-drag-y");
    if (offset > Math.min(SHEET_DISMISS_DISTANCE, height * 0.3)) {
      this.closeDropdown();
    }
  },

  /**
   * The mobile sheet is modal (overlay + locked page), so Tab must not walk
   * out of it into the page behind.
   */
  trapFocus(event) {
    if (event.key !== "Tab" || !this.isDropdownOpen || !this.isMobileViewport()) {
      return;
    }
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    if (!dropdown) {
      return;
    }
    const focusable = Array.from(
      dropdown.querySelectorAll(
        'button:not([disabled]), select, [href], input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.tabIndex !== -1 && el.offsetParent !== null);
    if (!focusable.length) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  },

  bindViewportSync() {
    if (this.viewportSyncHandler) {
      return;
    }
    this.viewportSyncHandler = utils.debounce(() => {
      const wasUsingMobilePortal = this.usingMobilePortal;
      this.syncMobilePortal();
      this.syncRangePickerLayout();

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
    const rangeInput = store.getElement(CONFIG.UI.selectors.dpRangeDate);
    const calendarHost = store.getElement(CONFIG.UI.selectors.dpCalendarHost);
    if (!startInput || !endInput || !rangeInput || !calendarHost) {
      return;
    }

    this.syncMobilePortal();
    this.bindViewportSync();

    const { startDate, endDate } = this.getSelectedDateRange();
    this.flatpickrInstances = new Map();

    const fpConfig = {
      enableTime: false,
      mode: "range",
      inline: true,
      dateFormat: "Y-m-d",
      maxDate: "today",
      disableMobile: true,
      allowInput: false,
      animate: CONFIG.UI.animations.enabled && !store.ui.reducedMotion,
      locale: { firstDayOfWeek: 0 },
      ariaDateFormat: "F j, Y",
      showMonths: this.isMobileViewport() ? 1 : 2,
      defaultDate: [startDate, endDate],
      appendTo: calendarHost,
      onChange: (selectedDates, _dateString, instance) => {
        this.handleRangeSelection(selectedDates, instance);
      },
      onMonthChange: () => this.syncMonthNav(),
      onYearChange: () => this.syncMonthNav(),
    };

    if (!rangeInput._flatpickr) {
      const rangePicker = dateUtils.initDatePicker(rangeInput, fpConfig);
      this.flatpickrInstances.set("range", rangePicker);
    } else {
      this.flatpickrInstances.set("range", rangeInput._flatpickr);
    }

    this.syncRangePickerLayout();
    this.bindMonthNav();
    this.syncMonthNav();
    this.updateInputs(startDate, endDate);
    this.updateDateDisplay();
    this.highlightActivePreset();

    // Listen for external filter changes
    document.addEventListener("es:filters-change", (event) => {
      const detail = event.detail || {};
      if (detail.source === "filters") {
        return;
      }
      const currentRange = this.getSelectedDateRange();
      const nextStart =
        detail.startDate || store.get("filters.startDate") || currentRange.startDate;
      const nextEnd =
        detail.endDate || store.get("filters.endDate") || currentRange.endDate;
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

    // Bind the custom range disclosure and apply action
    const applyBtn = store.getElement(CONFIG.UI.selectors.datePickerApply);
    const customToggle = store.getElement(CONFIG.UI.selectors.dpCustomToggle);
    const closeBtn = store.getElement(CONFIG.UI.selectors.datePickerClose);
    if (applyBtn) {
      eventManager.add(applyBtn, "click", () => this.applyFilters());
    }
    if (customToggle) {
      eventManager.add(customToggle, "click", () => {
        this.setCustomRangeOpen(!this.isCustomRangeOpen);
      });
    }
    if (closeBtn) {
      eventManager.add(closeBtn, "click", () => this.closeDropdown());
    }

    // Close dropdown on click outside
    document.addEventListener("click", (e) => {
      if (!this.isDropdownOpen) {
        return;
      }
      const wrapper = store.getElement(CONFIG.UI.selectors.datePickerWrapper);
      const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
      if (wrapper && !wrapper.contains(e.target) && !dropdown?.contains(e.target)) {
        this.closeDropdown();
      }
    });

    // Close on Escape key, keep Tab inside the modal sheet
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isDropdownOpen) {
        this.closeDropdown();
        return;
      }
      this.trapFocus(e);
    });

    this.bindSheetDrag();

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

  setCustomRangeOpen(open) {
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const toggle = store.getElement(CONFIG.UI.selectors.dpCustomToggle);
    const panel = store.getElement(CONFIG.UI.selectors.dpCustomPanel);
    const footer = store.getElement(CONFIG.UI.selectors.dpFooter);
    if (!toggle || !panel) {
      return;
    }

    this.isCustomRangeOpen = open;
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    dropdown?.classList.toggle("custom-open", open);

    // Apply only ever acts on a custom range; presets auto-apply on tap.
    if (footer) {
      footer.hidden = !open;
    }

    this.setMonthGridOpen(false);

    if (open) {
      const body = store.getElement(CONFIG.UI.selectors.dpBody);
      if (body) {
        body.scrollTop = 0;
      }
      requestAnimationFrame(() => {
        this.syncRangePickerLayout();
        this.flatpickrInstances.get("range")?.redraw();
        this.syncMonthNav();
      });
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

    dropdown.style.removeProperty("--dp-drag-y");
    dropdown.removeAttribute("inert");
    dropdown.classList.add("open");
    dropdown.setAttribute("aria-hidden", "false");
    trigger?.setAttribute("aria-expanded", "true");
    this.isDropdownOpen = true;
    this.setCustomRangeOpen(false);
    this.syncRangePickerLayout();

    const rangePicker = this.flatpickrInstances.get("range");
    const { endDate } = this.getSelectedDateRange();
    const visibleDate = dateUtils.parseDateString(endDate);
    if (visibleDate && !this.isMobileViewport()) {
      visibleDate.setDate(1);
      visibleDate.setMonth(visibleDate.getMonth() - 1);
    }
    rangePicker?.jumpToDate(visibleDate || endDate, false);
    this.monthGridYear = rangePicker?.currentYear ?? null;
    this.syncMonthNav();

    // Mobile renders as a modal bottom sheet: dim the page and stop it
    // scrolling underneath.
    if (this.isMobileViewport()) {
      overlay?.classList.add("visible");
      dropdown.setAttribute("aria-modal", "true");
      this.lockPageScroll();
    } else {
      dropdown.removeAttribute("aria-modal");
    }

    requestAnimationFrame(() => {
      const activePreset = dropdown.querySelector(".preset-btn.active");
      const closeButton = dropdown.querySelector(".dp-close-btn");
      (activePreset || closeButton)?.focus({ preventScroll: true });
    });
  },

  closeDropdown() {
    const dropdown = store.getElement(CONFIG.UI.selectors.datePickerDropdown);
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    const overlay = store.getElement(CONFIG.UI.selectors.datePickerOverlay);

    if (!dropdown) {
      return;
    }

    const restoreFocus = dropdown.contains(document.activeElement);
    dropdown.classList.remove("open", "dragging");
    dropdown.style.removeProperty("--dp-drag-y");
    dropdown.setAttribute("aria-hidden", "true");
    dropdown.removeAttribute("aria-modal");
    dropdown.setAttribute("inert", "");
    trigger?.setAttribute("aria-expanded", "false");
    this.isDropdownOpen = false;
    this.drag = null;
    this.setCustomRangeOpen(false);
    this.unlockPageScroll();

    // `inert` above blurs whatever was focused inside the sheet, so hand
    // focus back to the trigger rather than leaving it on <body>.
    if (restoreFocus) {
      trigger?.focus({ preventScroll: true });
    }

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
    if (!startInputEl || !endInputEl) {
      return;
    }

    startInputEl.value = startDate;
    endInputEl.value = endDate;
    this.flatpickrInstances.get("range")?.setDate([startDate, endDate], false, "Y-m-d");
    this.renderRangeSummary(startDate, endDate);
  },

  handleRangeSelection(selectedDates, instance) {
    const startInput = store.getElement(CONFIG.UI.selectors.dpStartDate);
    const endInput = store.getElement(CONFIG.UI.selectors.dpEndDate);
    if (!startInput || !endInput || !selectedDates.length) {
      return;
    }

    const startDate = instance.formatDate(selectedDates[0], "Y-m-d");
    const hasEndDate = selectedDates.length > 1;
    const endDate = hasEndDate
      ? instance.formatDate(selectedDates[1], "Y-m-d")
      : startDate;

    startInput.value = startDate;
    endInput.value = endDate;
    this.renderRangeSummary(startDate, hasEndDate ? endDate : null, !hasEndDate);
    store.getAllElements(".preset-btn").forEach((btn) => {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    });
  },

  countDays(startDate, endDate) {
    const start = dateUtils.parseDateString(startDate);
    const end = dateUtils.parseDateString(endDate);
    if (!start || !end) {
      return 0;
    }
    return Math.round((end - start) / MS_PER_DAY) + 1;
  },

  renderRangeSummary(startDate, endDate, selectionInProgress = false) {
    const startDisplay = store.getElement(CONFIG.UI.selectors.dpStartDisplay);
    const endDisplay = store.getElement(CONFIG.UI.selectors.dpEndDisplay);
    const hint = store.getElement(CONFIG.UI.selectors.dpRangeHint);
    const customSummary = store.getElement(CONFIG.UI.selectors.dpCustomSummary);
    const applyBtn = store.getElement(CONFIG.UI.selectors.datePickerApply);
    const rangeCount = store.getElement(CONFIG.UI.selectors.dpRangeCount);
    const formatDate = (date) =>
      date
        ? dateUtils.formatForDisplay(date, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }) || date
        : "Choose date";

    if (startDisplay) {
      startDisplay.textContent = formatDate(startDate);
    }
    if (endDisplay) {
      endDisplay.textContent = selectionInProgress
        ? "Tap an end date"
        : formatDate(endDate);
      endDisplay
        .closest(".dp-range-endpoint")
        ?.classList.toggle("is-awaiting", selectionInProgress);
    }
    if (hint) {
      hint.textContent = selectionInProgress
        ? "Tap an end date, or apply this as a single day."
        : "Select a start date, then an end date.";
    }
    if (customSummary) {
      const preset = this.detectPreset(startDate, endDate);
      customSummary.textContent = selectionInProgress
        ? `${formatDate(startDate)} — choose end`
        : preset
          ? "Choose exact dates"
          : `${formatDate(startDate)} – ${formatDate(endDate)}`;
    }
    if (rangeCount) {
      const days = selectionInProgress
        ? this.countDays(startDate, startDate)
        : this.countDays(startDate, endDate);
      rangeCount.textContent = days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : "";
    }
    if (applyBtn) {
      applyBtn.disabled = !startDate;
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
        store.set("ui.lastFilterPreset", range);
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

    if (start === yesterday && end === today) {
      return "yesterday";
    }

    // Check if same day
    if (start === end) {
      if (start === today) {
        return "today";
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
    const { startDate: savedStartDate, endDate: savedEndDate } =
      this.getSelectedDateRange();

    const activePreset = preset || this.detectPreset(savedStartDate, savedEndDate);

    store.getAllElements(".preset-btn").forEach((btn) => {
      const isActive = btn.dataset.range === activePreset;
      btn.classList.toggle(CONFIG.UI.classes.active, isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  },

  /**
   * Compact label for the header trigger. "Jul 1 – 25" beats "Jul 1, 2026 -
   * Jul…" when the button only has a few rem to work with on a phone.
   */
  formatTriggerRange(startDate, endDate) {
    const start = dateUtils.parseDateString(startDate);
    const end = dateUtils.parseDateString(endDate);
    if (!start || !end) {
      return `${startDate} - ${endDate}`;
    }

    const short = (value) =>
      dateUtils.formatForDisplay(value, { month: "short", day: "numeric" }) || value;
    const long = (value) =>
      dateUtils.formatForDisplay(value, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }) || value;

    const currentYear = dateUtils
      .parseDateString(dateUtils.getCurrentDate())
      ?.getFullYear();
    const sameYear = start.getFullYear() === end.getFullYear();
    const yearIsImplied = sameYear && start.getFullYear() === currentYear;

    if (start.getTime() === end.getTime()) {
      return yearIsImplied ? short(startDate) : long(startDate);
    }
    if (sameYear) {
      // "Jul 6 – 15" inside one month, "Jan 3 – Jul 15" across months; the
      // shared year is spelled out only when it is not the current one.
      const tail =
        start.getMonth() === end.getMonth() ? String(end.getDate()) : short(endDate);
      return yearIsImplied
        ? `${short(startDate)} – ${tail}`
        : `${short(startDate)} – ${tail}, ${end.getFullYear()}`;
    }
    return `${long(startDate)} – ${long(endDate)}`;
  },

  updateDateDisplay() {
    const display = store.getElement(CONFIG.UI.selectors.dateDisplay);
    const trigger = store.getElement(CONFIG.UI.selectors.datePickerTrigger);
    if (!display) {
      return;
    }

    const { startDate: savedStartDate, endDate: savedEndDate } =
      this.getSelectedDateRange();
    const today = dateUtils.getCurrentDate();

    const preset = this.detectPreset(savedStartDate, savedEndDate);

    // Map preset names to display text
    const presetLabels = {
      today: "Today",
      yesterday: "Since Yesterday",
      "last-week": "Last 7 Days",
      "last-month": "Last 30 Days",
      "last-quarter": "Last Quarter",
      "last-year": "Last Year",
      "all-time": "All Time",
    };

    const label =
      preset && presetLabels[preset]
        ? presetLabels[preset]
        : this.formatTriggerRange(savedStartDate, savedEndDate);
    display.textContent = label;

    // The compact label drops years, so spell the range out for assistive
    // tech and on hover.
    const fullRange = (value) =>
      dateUtils.formatForDisplay(value, { dateStyle: "medium" }) || value;
    const fullLabel =
      savedStartDate === savedEndDate
        ? fullRange(savedStartDate)
        : `${fullRange(savedStartDate)} to ${fullRange(savedEndDate)}`;
    trigger?.setAttribute("aria-label", `Select date range, currently ${fullLabel}`);
    trigger?.setAttribute("title", fullLabel);

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
      const calendarHost = store.getElement(CONFIG.UI.selectors.dpCalendarHost);
      calendarHost?.classList.add("invalid-shake");
      setTimeout(() => calendarHost?.classList.remove("invalid-shake"), 600);
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
};

export default dateManager;
