/* global DateUtils */
"use strict";

(() => {
  // Configuration with performance optimizations
  const CONFIG = {
    selectors: {
      themeToggle: "#theme-toggle-checkbox",
      mobileDrawer: "#mobile-nav-drawer",
      menuToggle: "#menu-toggle",
      closeBtn: ".drawer-close-btn",
      contentOverlay: "#content-overlay",
      filterToggle: "#filters-toggle",
      filtersPanel: "#filters-panel",
      filtersClose: ".panel-close-btn",
      startDate: "#start-date",
      endDate: "#end-date",
      applyFiltersBtn: "#apply-filters",
      resetFilters: "#reset-filters",
      header: ".app-header",
      mapControls: "#map-controls",
      centerOnLocationButton: "#center-on-location",
      controlsToggle: "#controls-toggle",
      controlsContent: "#controls-content",
      filterIndicator: "#filter-indicator",
      toolsSection: ".tools-section",
      customPresetsListContainer: "#custom-presets-list",
      noCustomPresetsMessage: "#no-custom-presets-message",
    },
    classes: {
      active: "active",
      open: "open",
      visible: "visible",
      show: "show",
      scrolled: "scrolled",
      lightMode: "light-mode",
      minimized: "minimized",
      connected: "connected",
      disconnected: "disconnected",
      loading: "loading",
    },
    storage: {
      theme: "theme",
      startDate: "startDate",
      endDate: "endDate",
      filterPresets: "filterPresets",
      uiState: "uiState",
    },
    transitions: {
      fast: 150,
      normal: 300,
      slow: 500,
    },
    map: {
      defaultZoom: 14,
      flyToDuration: 1.5,
    },
    themeColors: {
      light: "#f8f9fa",
      dark: "#121212",
    },
    debounceDelays: {
      resize: 250,
      scroll: 50,
      input: 300,
    },
    mobileBreakpoint: 768,
    tooltipDelay: { show: 500, hide: 100 },
    animations: {
      enabled: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  };

  // State management with better structure
  class UIState {
    constructor() {
      this.elementCache = new Map();
      this.initialized = false;
      this.currentTheme = null;
      this.listeners = new WeakMap();
      this.activeModals = new Set();
      this.touchStartX = null;
      this.touchStartY = null;
      this.isMobile = window.innerWidth < CONFIG.mobileBreakpoint;
      this.reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      // UI state persistence
      this.uiState = this.loadUIState();
    }

    getElement(selector) {
      if (this.elementCache.has(selector)) {
        return this.elementCache.get(selector);
      }

      const element = document.querySelector(selector);
      if (element) {
        this.elementCache.set(selector, element);
      }
      return element;
    }

    getAllElements(selector) {
      const key = `all_${selector}`;
      if (this.elementCache.has(key)) {
        return this.elementCache.get(key);
      }

      const elements = document.querySelectorAll(selector);
      this.elementCache.set(key, elements);
      return elements;
    }

    loadUIState() {
      try {
        const saved = localStorage.getItem(CONFIG.storage.uiState);
        return saved
          ? JSON.parse(saved)
          : {
              controlsMinimized: false,
              filtersOpen: false,
              lastFilterPreset: null,
            };
      } catch {
        return {
          controlsMinimized: false,
          filtersOpen: false,
          lastFilterPreset: null,
        };
      }
    }

    saveUIState() {
      try {
        localStorage.setItem(
          CONFIG.storage.uiState,
          JSON.stringify(this.uiState),
        );
      } catch (e) {
        console.warn("Failed to save UI state:", e);
      }
    }
  }

  const state = new UIState();

  // Enhanced utility functions
  const utils = {
    debounce(func, wait) {
      let timeout;
      let lastCallTime = 0;

      return function executedFunction(...args) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        const later = () => {
          clearTimeout(timeout);
          lastCallTime = Date.now();
          func(...args);
        };

        clearTimeout(timeout);

        if (timeSinceLastCall >= wait) {
          lastCallTime = now;
          func(...args);
        } else {
          timeout = setTimeout(later, wait);
        }
      };
    },

    throttle(func, limit) {
      let inThrottle;
      let lastResult;

      return function (...args) {
        if (!inThrottle) {
          lastResult = func.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
        return lastResult;
      };
    },

    getStorage(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(key);
        if (value === null) return defaultValue;

        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } catch {
        return defaultValue;
      }
    },

    setStorage(key, value) {
      try {
        const stringValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        localStorage.setItem(key, stringValue);
        return true;
      } catch {
        return false;
      }
    },

    showNotification(message, type = "info", duration = 5000) {
      window.notificationManager?.show?.(message, type, duration) ||
        console.log(`[${type.toUpperCase()}] ${message}`);
    },

    batchDomUpdates(updates) {
      if (state.reducedMotion) {
        updates.forEach((update) => update());
      } else {
        requestAnimationFrame(() => {
          updates.forEach((update) => update());
        });
      }
    },

    fadeIn(element, duration = CONFIG.transitions.normal) {
      if (!element || state.reducedMotion) {
        if (element) element.style.display = "block";
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        element.style.opacity = "0";
        element.style.display = "block";
        element.style.transition = `opacity ${duration}ms ease-in-out`;

        requestAnimationFrame(() => {
          element.style.opacity = "1";
          setTimeout(resolve, duration);
        });
      });
    },

    fadeOut(element, duration = CONFIG.transitions.normal) {
      if (!element || state.reducedMotion) {
        if (element) element.style.display = "none";
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        element.style.transition = `opacity ${duration}ms ease-in-out`;
        element.style.opacity = "0";

        setTimeout(() => {
          element.style.display = "none";
          resolve();
        }, duration);
      });
    },

    measureScrollbarWidth() {
      const scrollDiv = document.createElement("div");
      scrollDiv.className = "scrollbar-measure";
      scrollDiv.style.cssText =
        "width: 100px; height: 100px; overflow: scroll; position: absolute; top: -9999px;";
      document.body.appendChild(scrollDiv);
      const scrollbarWidth = scrollDiv.offsetWidth - scrollDiv.clientWidth;
      document.body.removeChild(scrollDiv);
      return scrollbarWidth;
    },
  };

  // Enhanced event management
  const eventManager = {
    add(element, events, handler, options = {}) {
      const el =
        typeof element === "string" ? state.getElement(element) : element;
      if (!el) return false;

      if (!state.listeners.has(el)) {
        state.listeners.set(el, new Map());
      }

      const eventList = Array.isArray(events) ? events : [events];
      const elementListeners = state.listeners.get(el);

      eventList.forEach((eventType) => {
        const key = `${eventType}_${handler.name || Math.random()}`;
        if (elementListeners.has(key)) return;

        const wrappedHandler =
          options.leftClickOnly && eventType === "click"
            ? (e) => {
                if (e.button === 0) handler(e);
              }
            : handler;

        el.addEventListener(
          eventType,
          wrappedHandler,
          options.passive ? { passive: true } : false,
        );
        elementListeners.set(key, { handler: wrappedHandler, eventType });
      });

      return true;
    },

    delegate(container, selector, eventType, handler) {
      const containerEl =
        typeof container === "string" ? state.getElement(container) : container;
      if (!containerEl) return false;

      const delegatedHandler = (e) => {
        const target = e.target.closest(selector);
        if (target && containerEl.contains(target)) {
          handler.call(target, e);
        }
      };

      containerEl.addEventListener(eventType, delegatedHandler);
      return true;
    },

    once(element, event, handler) {
      const el =
        typeof element === "string" ? state.getElement(element) : element;
      if (!el) return false;

      const onceHandler = (e) => {
        handler(e);
        el.removeEventListener(event, onceHandler);
      };

      el.addEventListener(event, onceHandler);
      return true;
    },
  };

  // Enhanced theme management
  const themeManager = {
    init() {
      const saved = utils.getStorage(CONFIG.storage.theme);
      const systemPreference = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      const initial = saved || systemPreference;

      this.apply(initial, false);
      this.setupToggles();
      this.watchSystemPreference();
    },

    apply(theme, animate = true) {
      if (state.currentTheme === theme) return;

      const isLight = theme === "light";
      state.currentTheme = theme;

      if (animate && CONFIG.animations.enabled) {
        document.documentElement.style.transition =
          "background-color 0.3s ease, color 0.3s ease";
      }

      utils.batchDomUpdates([
        () => {
          document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
          document.documentElement.setAttribute("data-bs-theme", theme);
        },
        () => this.updateMetaColor(theme),
        () => this.updateMapTheme(theme),
        () => this.syncToggles(theme),
        () => this.updateChartThemes(theme),
      ]);

      if (animate && CONFIG.animations.enabled) {
        setTimeout(() => {
          document.documentElement.style.transition = "";
        }, 300);
      }

      utils.setStorage(CONFIG.storage.theme, theme);
      document.dispatchEvent(
        new CustomEvent("themeChanged", { detail: { theme } }),
      );
    },

    updateMetaColor(theme) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute("content", CONFIG.themeColors[theme]);
      }
    },

    updateMapTheme(theme) {
      if (!window.map || !window.map.setStyle) return;

      // Store current map state
      const center = window.map.getCenter();
      const zoom = window.map.getZoom();
      const bearing = window.map.getBearing();
      const pitch = window.map.getPitch();

      if (window.CONFIG?.MAP?.styles?.[theme]) {
        const styleUrl = window.CONFIG.MAP.styles[theme];

        // Set up one-time listener for style load
        const restoreState = () => {
          window.map.jumpTo({
            center: center,
            zoom: zoom,
            bearing: bearing,
            pitch: pitch,
          });

          // Trigger map resize after theme change
          setTimeout(() => {
            window.map.resize();
          }, 100);

          // Dispatch an event to notify that the style has loaded and state is restored
          document.dispatchEvent(
            new CustomEvent("mapStyleLoaded", { detail: { theme } }),
          );
        };

        window.map.once("styledata", restoreState);
        window.map.setStyle(styleUrl);
      }

      document.dispatchEvent(
        new CustomEvent("mapThemeChanged", { detail: { theme } }),
      );
    },

    updateChartThemes(theme) {
      // Update any Chart.js instances
      if (window.Chart) {
        const charts = window.Chart.instances;
        if (charts) {
          Object.values(charts).forEach((chart) => {
            if (chart && chart.options) {
              const isDark = theme === "dark";
              const textColor = isDark ? "#ffffff" : "#000000";
              const gridColor = isDark
                ? "rgba(255, 255, 255, 0.1)"
                : "rgba(0, 0, 0, 0.1)";

              // Update colors
              if (chart.options.scales) {
                Object.values(chart.options.scales).forEach((scale) => {
                  if (scale.ticks) scale.ticks.color = textColor;
                  if (scale.grid) scale.grid.color = gridColor;
                });
              }

              if (chart.options.plugins?.legend?.labels) {
                chart.options.plugins.legend.labels.color = textColor;
              }

              chart.update("none"); // Update without animation
            }
          });
        }
      }
    },

    syncToggles(theme) {
      const themeToggle = state.getElement(CONFIG.selectors.themeToggle);
      if (themeToggle) {
        themeToggle.checked = theme === "light";
      }
    },

    setupToggles() {
      const themeToggle = state.getElement(CONFIG.selectors.themeToggle);
      if (themeToggle) {
        eventManager.add(themeToggle, "change", () => {
          this.apply(themeToggle.checked ? "light" : "dark");
        });
      }
    },

    watchSystemPreference() {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

      const handleChange = (e) => {
        // Only apply system preference if user hasn't set a preference
        if (!utils.getStorage(CONFIG.storage.theme)) {
          this.apply(e.matches ? "dark" : "light");
        }
      };

      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener("change", handleChange);
      } else {
        // Fallback for older browsers
        mediaQuery.addListener(handleChange);
      }
    },
  };

  // Enhanced panel management with animations
  const panelManager = {
    transitionDuration: CONFIG.transitions.normal,

    async close(type) {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = state.getElement(panelMap[type]);
      const overlay = state.getElement(CONFIG.selectors.contentOverlay);

      if (!panel || !panel.classList.contains(CONFIG.classes.open)) return;

      // Start closing animation
      panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;
      panel.classList.remove(CONFIG.classes.open);

      if (overlay) {
        await utils.fadeOut(overlay, this.transitionDuration);
      }

      if (type === "mobile") {
        document.body.style.overflow = "";
        // Remove padding to compensate for scrollbar
        document.body.style.paddingRight = "";
      }

      if (type === "filters") {
        state.uiState.filtersOpen = false;
        state.saveUIState();
      }

      // Clean up after transition
      setTimeout(() => {
        panel.style.transition = "";
      }, this.transitionDuration);
    },

    async open(type) {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = state.getElement(panelMap[type]);
      const overlay = state.getElement(CONFIG.selectors.contentOverlay);

      if (!panel || panel.classList.contains(CONFIG.classes.open)) return;

      // Prepare for animation
      panel.style.transition = `transform ${this.transitionDuration}ms ease-in-out`;

      if (type === "mobile") {
        // Prevent body scroll and compensate for scrollbar
        const scrollbarWidth = utils.measureScrollbarWidth();
        document.body.style.overflow = "hidden";
        if (scrollbarWidth > 0) {
          document.body.style.paddingRight = `${scrollbarWidth}px`;
        }
      }

      // Show overlay with fade
      if (overlay) {
        overlay.style.display = "block";
        await utils.fadeIn(overlay, this.transitionDuration / 2);
      }

      // Open panel
      panel.classList.add(CONFIG.classes.open);

      if (type === "filters") {
        state.uiState.filtersOpen = true;
        state.saveUIState();

        // Focus first input
        setTimeout(() => {
          const firstInput = panel.querySelector("input, select, button");
          if (firstInput) firstInput.focus();
        }, this.transitionDuration);
      }
    },

    toggle(type) {
      const panelMap = {
        filters: CONFIG.selectors.filtersPanel,
        mobile: CONFIG.selectors.mobileDrawer,
      };
      const panel = state.getElement(panelMap[type]);

      if (panel?.classList.contains(CONFIG.classes.open)) {
        this.close(type);
      } else {
        this.open(type);
      }
    },

    init() {
      // Mobile drawer with swipe support
      const mobileDrawer = state.getElement(CONFIG.selectors.mobileDrawer);
      if (mobileDrawer && "ontouchstart" in window) {
        this.initSwipeGestures(mobileDrawer, "mobile");
      }

      eventManager.add(CONFIG.selectors.menuToggle, "click", (e) => {
        e.stopPropagation();
        this.open("mobile");
      });

      eventManager.add(CONFIG.selectors.closeBtn, "click", () =>
        this.close("mobile"),
      );

      eventManager.add(CONFIG.selectors.contentOverlay, "click", () => {
        this.close("mobile");
        this.close("filters");
      });

      // Filter panel
      eventManager.add(CONFIG.selectors.filterToggle, "click", (e) => {
        e.stopPropagation();
        this.toggle("filters");
      });

      eventManager.add(CONFIG.selectors.filtersClose, "click", () =>
        this.close("filters"),
      );

      // Escape key
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          this.close("mobile");
          this.close("filters");
        }
      });

      // Restore filter panel state
      if (state.uiState.filtersOpen) {
        setTimeout(() => this.open("filters"), 100);
      }
    },

    initSwipeGestures(element, type) {
      let startX = 0;
      let currentX = 0;
      let isDragging = false;

      const handleTouchStart = (e) => {
        startX = e.touches[0].clientX;
        currentX = startX;
        isDragging = true;
        element.style.transition = "none";
      };

      const handleTouchMove = (e) => {
        if (!isDragging) return;

        currentX = e.touches[0].clientX;
        const diff = currentX - startX;

        // Only allow swiping in the closing direction
        if (type === "mobile" && diff < 0) {
          const translateX = Math.max(diff, -element.offsetWidth);
          element.style.transform = `translateX(${translateX}px)`;
        }
      };

      const handleTouchEnd = () => {
        if (!isDragging) return;

        isDragging = false;
        element.style.transition = "";
        element.style.transform = "";

        const diff = currentX - startX;

        // Close if swiped more than 30% of width
        if (Math.abs(diff) > element.offsetWidth * 0.3) {
          this.close(type);
        }
      };

      element.addEventListener("touchstart", handleTouchStart, {
        passive: true,
      });
      element.addEventListener("touchmove", handleTouchMove, { passive: true });
      element.addEventListener("touchend", handleTouchEnd, { passive: true });
    },
  };

  // Enhanced date management
  const dateManager = {
    flatpickrInstances: new Map(),

    init() {
      if (!window.DateUtils) {
        console.error("DateUtils not found");
        return;
      }

      const startInput = state.getElement(CONFIG.selectors.startDate);
      const endInput = state.getElement(CONFIG.selectors.endDate);

      if (!startInput || !endInput) return;

      const today = DateUtils.getCurrentDate();
      const startDate = utils.getStorage(CONFIG.storage.startDate) || today;
      const endDate = utils.getStorage(CONFIG.storage.endDate) || today;

      const config = {
        maxDate: "today",
        disableMobile: true,
        dateFormat: "Y-m-d",
        altInput: true,
        altFormat: "M j, Y",
        theme: state.currentTheme || "dark",
        animate: CONFIG.animations.enabled,
        onReady: (selectedDates, dateStr, instance) => {
          // Add clear button
          const clearBtn = document.createElement("button");
          clearBtn.className = "flatpickr-clear";
          clearBtn.textContent = "Clear";
          clearBtn.type = "button";
          clearBtn.addEventListener("click", () => {
            instance.clear();
          });
          instance.calendarContainer.appendChild(clearBtn);
        },
      };

      // Initialize or update flatpickr instances
      if (!startInput._flatpickr) {
        const startPicker = DateUtils.initDatePicker(startInput, {
          ...config,
          onChange: (selectedDates) => {
            if (selectedDates.length > 0) {
              // Update end date min date
              const endPicker = this.flatpickrInstances.get("end");
              if (endPicker) {
                endPicker.set("minDate", selectedDates[0]);
              }
            }
          },
        });
        this.flatpickrInstances.set("start", startPicker);
      }

      if (!endInput._flatpickr) {
        const endPicker = DateUtils.initDatePicker(endInput, {
          ...config,
          minDate: startDate,
          onChange: (selectedDates) => {
            if (selectedDates.length > 0) {
              // Update start date max date
              const startPicker = this.flatpickrInstances.get("start");
              if (startPicker) {
                startPicker.set("maxDate", selectedDates[0]);
              }
            }
          },
        });
        this.flatpickrInstances.set("end", endPicker);
      }

      this.updateInputs(startDate, endDate);
      this.updateIndicator();
      this.loadFilterPresets();
      this._setupPresetEventListeners();
    },

    updateInputs(startDate, endDate) {
      const startInput = state.getElement(CONFIG.selectors.startDate);
      const endInput = state.getElement(CONFIG.selectors.endDate);

      if (startInput) {
        startInput._flatpickr?.setDate(startDate, true) ||
          (startInput.value = startDate);
      }
      if (endInput) {
        endInput._flatpickr?.setDate(endDate, true) ||
          (endInput.value = endDate);
      }
    },

    async setRange(range) {
      if (!window.DateUtils) {
        utils.showNotification("Date utility missing", "danger");
        return;
      }

      // Show loading state on the button
      const activeButton = document.querySelector(`[data-range="${range}"]`);
      if (activeButton) {
        activeButton.classList.add("btn-loading");
      }

      try {
        const { startDate, endDate } =
          await DateUtils.getDateRangePreset(range);

        if (startDate && endDate) {
          this.updateInputs(startDate, endDate);
          utils.setStorage(CONFIG.storage.startDate, startDate);
          utils.setStorage(CONFIG.storage.endDate, endDate);
          this.updateIndicator();

          // Save this as last used preset
          state.uiState.lastFilterPreset = range;
          state.saveUIState();
        } else {
          throw new Error("Invalid date range");
        }
      } catch (error) {
        console.error("Error setting date range:", error);
        utils.showNotification(
          `Error setting date range: ${error.message}`,
          "danger",
        );
      } finally {
        if (activeButton) {
          activeButton.classList.remove("btn-loading");
        }
      }
    },

    updateIndicator() {
      const indicator = state.getElement(CONFIG.selectors.filterIndicator);
      if (!indicator || !window.DateUtils) return;

      const rangeSpan = indicator.querySelector(".filter-date-range");
      if (!rangeSpan) return;

      const startDate =
        utils.getStorage(CONFIG.storage.startDate) ||
        DateUtils.getCurrentDate();
      const endDate =
        utils.getStorage(CONFIG.storage.endDate) || DateUtils.getCurrentDate();

      const formatDate = (dateStr) =>
        DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" }) || dateStr;

      // Check if this matches a preset
      const preset = this.detectPreset(startDate, endDate);
      if (preset) {
        rangeSpan.textContent =
          preset.charAt(0).toUpperCase() + preset.slice(1).replace("-", " ");
        indicator.setAttribute("data-preset", preset);
      } else {
        rangeSpan.textContent =
          startDate === endDate
            ? formatDate(startDate)
            : `${formatDate(startDate)} - ${formatDate(endDate)}`;
        indicator.removeAttribute("data-preset");
      }

      // Add pulse animation when filter changes
      indicator.classList.add("filter-changed");
      setTimeout(() => indicator.classList.remove("filter-changed"), 600);
    },

    detectPreset(startDate, endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const daysDiff = Math.floor((end - start) / (1000 * 60 * 60 * 24));

      // Check common presets
      if (
        start.toDateString() === end.toDateString() &&
        start.toDateString() === today.toDateString()
      ) {
        return "today";
      }

      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (
        start.toDateString() === yesterday.toDateString() &&
        end.toDateString() === yesterday.toDateString()
      ) {
        return "yesterday";
      }

      if (daysDiff === 6) return "last-week";
      if (daysDiff === 29 || daysDiff === 30) return "last-month";
      if (daysDiff === 89 || daysDiff === 90) return "last-quarter";
      if (daysDiff === 364 || daysDiff === 365) return "last-year";

      return null;
    },

    async applyFilters() {
      const startInput = state.getElement(CONFIG.selectors.startDate);
      const endInput = state.getElement(CONFIG.selectors.endDate);
      const applyButton = state.getElement(CONFIG.selectors.applyFiltersBtn);

      if (!startInput || !endInput) {
        utils.showNotification("Date input elements missing", "danger");
        return;
      }

      const startDate = startInput.value;
      const endDate = endInput.value;

      if (!window.DateUtils?.isValidDateRange?.(startDate, endDate)) {
        utils.showNotification("Invalid date range", "warning");

        // Shake animation for invalid inputs
        [startInput, endInput].forEach((input) => {
          input.classList.add("invalid-shake");
          setTimeout(() => input.classList.remove("invalid-shake"), 600);
        });

        return;
      }

      // Show loading state
      if (applyButton) {
        applyButton.disabled = true;
        applyButton.classList.add("btn-loading");
      }

      try {
        utils.setStorage(CONFIG.storage.startDate, startDate);
        utils.setStorage(CONFIG.storage.endDate, endDate);
        this.updateIndicator();
        this.saveFilterPreset(startDate, endDate);

        await panelManager.close("filters");

        document.dispatchEvent(
          new CustomEvent("filtersApplied", {
            detail: { startDate, endDate },
          }),
        );

        const formatDate = (date) =>
          DateUtils.formatForDisplay(date, { dateStyle: "short" });
        utils.showNotification(
          `Filters applied: ${formatDate(startDate)} to ${formatDate(endDate)}`,
          "success",
          3000,
        );
      } finally {
        if (applyButton) {
          applyButton.disabled = false;
          applyButton.classList.remove("btn-loading");
        }
      }
    },

    reset() {
      if (!window.DateUtils) {
        utils.showNotification("Date utility missing", "danger");
        return;
      }

      const today = DateUtils.getCurrentDate();
      this.updateInputs(today, today);
      utils.setStorage(CONFIG.storage.startDate, today);
      utils.setStorage(CONFIG.storage.endDate, today);

      // Reset active states
      const quickBtns = state.getAllElements(".quick-select-btn");
      quickBtns.forEach((btn) => btn.classList.remove(CONFIG.classes.active));

      const todayBtn = state.getElement(
        '.quick-select-btn[data-range="today"]',
      );
      if (todayBtn) todayBtn.classList.add(CONFIG.classes.active);

      this.updateIndicator();
      this.applyFilters();
    },

    loadFilterPresets() {
      const presets = utils.getStorage(CONFIG.storage.filterPresets) || [];
      const container = state.getElement(
        CONFIG.selectors.customPresetsListContainer,
      );
      const messageEl = state.getElement(
        CONFIG.selectors.noCustomPresetsMessage,
      );

      if (!container || !messageEl) {
        console.warn("Custom preset UI elements not found.");
        return;
      }

      container.innerHTML = ""; // Clear existing items

      if (presets.length === 0) {
        messageEl.style.display = "block";
        container.style.display = "none";
      } else {
        messageEl.style.display = "none";
        container.style.display = "block";

        presets.forEach((preset, index) => {
          if (!preset || !preset.startDate || !preset.endDate) return;

          const item = document.createElement("div");
          item.className =
            "list-group-item d-flex justify-content-between align-items-center custom-preset-item";
          item.setAttribute("data-start-date", preset.startDate);
          item.setAttribute("data-end-date", preset.endDate);
          item.setAttribute("data-index", index);

          const nameSpan = document.createElement("span");
          const formattedStart =
            DateUtils.formatForDisplay(preset.startDate, {
              dateStyle: "medium",
            }) || preset.startDate;
          const formattedEnd =
            DateUtils.formatForDisplay(preset.endDate, {
              dateStyle: "medium",
            }) || preset.endDate;

          nameSpan.textContent =
            preset.startDate === preset.endDate
              ? formattedStart
              : `${formattedStart} - ${formattedEnd}`;
          nameSpan.title = `From ${preset.startDate} to ${preset.endDate}`;

          const deleteBtn = document.createElement("button");
          deleteBtn.className =
            "btn btn-sm btn-outline-danger delete-preset-btn";
          deleteBtn.title = "Delete preset";
          deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
          deleteBtn.setAttribute("data-index", index);

          item.appendChild(nameSpan);
          item.appendChild(deleteBtn);
          container.appendChild(item);
        });
      }
    },

    saveFilterPreset(startDate, endDate) {
      const presets = utils.getStorage(CONFIG.storage.filterPresets) || [];
      const presetName =
        startDate === endDate ? startDate : `${startDate} to ${endDate}`;

      // Avoid duplicate presets based on date range
      const existingPresetIndex = presets.findIndex(
        (p) => p.startDate === startDate && p.endDate === endDate,
      );
      if (existingPresetIndex !== -1) {
        // Move to top if already exists
        const existing = presets.splice(existingPresetIndex, 1)[0];
        existing.timestamp = Date.now(); // Update timestamp
        presets.unshift(existing);
      } else {
        const newPreset = {
          startDate,
          endDate,
          timestamp: Date.now(),
          name: presetName, // Original name, display formatting done in loadFilterPresets
        };
        presets.unshift(newPreset);
      }

      // Keep only last 5 custom presets
      if (presets.length > 5) {
        presets.length = 5; // More direct way to truncate
      }

      utils.setStorage(CONFIG.storage.filterPresets, presets);
      this.loadFilterPresets(); // Refresh the list
    },

    _setupPresetEventListeners() {
      const container = state.getElement(
        CONFIG.selectors.customPresetsListContainer,
      );
      if (!container) return;

      eventManager.add(container, "click", (e) => {
        const target = e.target;
        const presetItem = target.closest(".custom-preset-item");

        if (!presetItem) return;

        const index = parseInt(presetItem.dataset.index, 10);

        if (target.closest(".delete-preset-btn")) {
          e.stopPropagation(); // Prevent item click event
          this._deletePreset(index);
        } else {
          // Click on the preset item itself
          const startDate = presetItem.dataset.startDate;
          const endDate = presetItem.dataset.endDate;

          if (startDate && endDate) {
            this.updateInputs(startDate, endDate);
            utils.setStorage(CONFIG.storage.startDate, startDate);
            utils.setStorage(CONFIG.storage.endDate, endDate);
            this.updateIndicator();

            // Clear any "quick select" active state visually
            state
              .getAllElements(".quick-select-btn")
              .forEach((btn) => btn.classList.remove(CONFIG.classes.active));

            state.uiState.lastFilterPreset = null; // Clear programmatic preset state
            state.saveUIState();

            // Optionally, provide feedback e.g. highlight apply button
            const applyBtn = state.getElement(CONFIG.selectors.applyFiltersBtn);
            if (applyBtn) {
              applyBtn.focus();
              applyBtn.classList.add("btn-primary-pulse");
              setTimeout(
                () => applyBtn.classList.remove("btn-primary-pulse"),
                1000,
              );
            }
          }
        }
      });
    },

    _deletePreset(index) {
      let presets = utils.getStorage(CONFIG.storage.filterPresets) || [];
      if (index >= 0 && index < presets.length) {
        presets.splice(index, 1);
        utils.setStorage(CONFIG.storage.filterPresets, presets);
        this.loadFilterPresets(); // Refresh the list
        utils.showNotification("Preset deleted", "info", 2000);
      }
    },
  };

  // Map controls manager with improvements
  const mapControlsManager = {
    init() {
      const controls = state.getElement(CONFIG.selectors.mapControls);
      const toggle = state.getElement(CONFIG.selectors.controlsToggle);

      if (!controls) return;

      // Performance optimizations for mobile
      if (state.isMobile) {
        controls.style.willChange = "transform";
      }

      // Restore minimized state
      if (state.uiState.controlsMinimized) {
        controls.classList.add(CONFIG.classes.minimized);
        const content = state.getElement(CONFIG.selectors.controlsContent);
        if (content && window.bootstrap?.Collapse) {
          const collapse =
            window.bootstrap.Collapse.getOrCreateInstance(content);
          collapse.hide();
        }
      }

      // Toggle functionality with smooth animation
      if (toggle) {
        eventManager.add(toggle, "click", () => {
          const isMinimizing = !controls.classList.contains(
            CONFIG.classes.minimized,
          );
          controls.classList.toggle(CONFIG.classes.minimized);

          state.uiState.controlsMinimized = isMinimizing;
          state.saveUIState();

          const content = state.getElement(CONFIG.selectors.controlsContent);
          if (content && window.bootstrap?.Collapse) {
            const collapse =
              window.bootstrap.Collapse.getOrCreateInstance(content);
            isMinimizing ? collapse.hide() : collapse.show();
          }

          const icon = toggle.querySelector("i");
          if (icon) {
            // Smooth icon rotation
            icon.style.transition = "transform 0.3s ease";
            icon.style.transform = isMinimizing
              ? "rotate(180deg)"
              : "rotate(0deg)";
          }

          requestAnimationFrame(() => this.updateOpacity());
        });
      }

      // Optimize touch handling for mobile
      if ("ontouchstart" in window) {
        controls.addEventListener(
          "touchstart",
          (e) => {
            // Allow scrolling within controls
            const scrollableElement = e.target.closest(
              ".overflow-auto, .form-select, .form-control",
            );
            if (!scrollableElement) {
              e.stopPropagation();
            }
          },
          { passive: true },
        );
      }

      // Prevent map interaction
      ["mousedown", "touchstart", "wheel"].forEach((eventType) => {
        controls.addEventListener(
          eventType,
          (e) => {
            const isInteractive = e.target.closest(
              "input, select, textarea, button, a, .form-check, .nav-item, .list-group-item",
            );
            if (!isInteractive && eventType !== "wheel") {
              e.stopPropagation();
            }
          },
          { passive: eventType === "wheel" },
        );
      });

      // Smart opacity management
      let opacityTimeout;

      const setOpacity = (opacity) => {
        clearTimeout(opacityTimeout);
        controls.style.opacity = opacity;
      };

      eventManager.add(controls, "mouseenter", () => setOpacity("1"));
      eventManager.add(controls, "mouseleave", () => {
        opacityTimeout = setTimeout(() => this.updateOpacity(), 1000);
      });

      this.updateOpacity();
    },

    updateOpacity() {
      const controls = state.getElement(CONFIG.selectors.mapControls);
      if (!controls || controls.matches(":hover")) return;

      const opacity = controls.classList.contains(CONFIG.classes.minimized)
        ? "0.8"
        : "0.95";
      controls.style.opacity = opacity;
    },
  };

  // Filter indicator with better UX
  const filterIndicatorManager = {
    create() {
      const toolsSection = state.getElement(CONFIG.selectors.toolsSection);
      const existing = state.getElement(CONFIG.selectors.filterIndicator);

      if (!toolsSection || existing) return;

      const indicator = document.createElement("div");
      indicator.className = "filter-indicator me-2";
      indicator.id = CONFIG.selectors.filterIndicator.substring(1);
      indicator.title = "Current date range filter (click to change)";
      indicator.setAttribute("role", "button");
      indicator.setAttribute("tabindex", "0");
      indicator.innerHTML = `
        <i class="fas fa-calendar-alt me-1"></i>
        <span class="filter-date-range">Today</span>
        <i class="fas fa-caret-down ms-1 small"></i>
      `;

      const filterToggle = state.getElement(CONFIG.selectors.filterToggle);
      if (filterToggle) {
        toolsSection.insertBefore(indicator, filterToggle);
      } else {
        toolsSection.appendChild(indicator);
      }

      state.elementCache.set(CONFIG.selectors.filterIndicator, indicator);

      // Click and keyboard support
      const openFilters = () => panelManager.open("filters");
      eventManager.add(indicator, "click", openFilters);
      eventManager.add(indicator, "keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openFilters();
        }
      });

      dateManager.updateIndicator();
    },
  };

  // Enhanced event setup
  const setupEvents = () => {
    // Quick select buttons with loading states
    eventManager.delegate(
      document,
      ".quick-select-btn",
      "click",
      async function (e) {
        e.preventDefault();
        const range = this.dataset.range;
        if (!range || this.disabled) return;

        // Update active states immediately
        state
          .getAllElements(".quick-select-btn")
          .forEach((btn) => btn.classList.remove(CONFIG.classes.active));
        this.classList.add(CONFIG.classes.active);

        await dateManager.setRange(range);
      },
    );

    // Filter buttons
    eventManager.add(CONFIG.selectors.applyFiltersBtn, "click", (e) => {
      e.preventDefault();
      dateManager.applyFilters();
    });

    eventManager.add(CONFIG.selectors.resetFilters, "click", (e) => {
      e.preventDefault();
      dateManager.reset();
    });

    // Scroll effects with throttling
    const header = state.getElement(CONFIG.selectors.header);
    if (header) {
      let lastScrollY = window.scrollY;
      let ticking = false;

      const updateScrollState = () => {
        const scrollY = window.scrollY;

        // Add scrolled class
        header.classList.toggle(CONFIG.classes.scrolled, scrollY > 10);

        // Hide/show header on scroll
        if (scrollY > lastScrollY && scrollY > 100) {
          header.style.transform = "translateY(-100%)";
        } else {
          header.style.transform = "translateY(0)";
        }

        lastScrollY = scrollY;
        ticking = false;
      };

      const requestTick = () => {
        if (!ticking) {
          requestAnimationFrame(updateScrollState);
          ticking = true;
        }
      };

      window.addEventListener("scroll", requestTick, { passive: true });
      updateScrollState();
    }

    // Responsive handling
    let resizeTimeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const wasMobile = state.isMobile;
        state.isMobile = window.innerWidth < CONFIG.mobileBreakpoint;

        if (wasMobile !== state.isMobile) {
          // Close mobile menu when switching to desktop
          if (!state.isMobile) {
            panelManager.close("mobile");
          }

          // Update map controls
          mapControlsManager.updateOpacity();
        }
      }, CONFIG.debounceDelays.resize);
    };

    window.addEventListener("resize", handleResize);

    // Connection status with retry logic
    const statusIndicator = state.getElement(".status-indicator");
    const statusText = state.getElement(".status-text");

    if (statusIndicator && statusText) {
      let retryCount = 0;
      const maxRetries = 3;

      const updateStatus = () => {
        const textContent = statusText.textContent.toLowerCase();
        const wasConnected = statusIndicator.classList.contains(
          CONFIG.classes.connected,
        );
        const isConnected =
          textContent.includes("connected") &&
          !textContent.includes("disconnected");

        statusIndicator.classList.toggle(CONFIG.classes.connected, isConnected);
        statusIndicator.classList.toggle(
          CONFIG.classes.disconnected,
          !isConnected,
        );

        // Handle connection changes
        if (!isConnected && wasConnected) {
          retryCount = 0;
          statusText.textContent = `Disconnected (Retry ${retryCount + 1}/${maxRetries})`;
        } else if (!isConnected && retryCount < maxRetries) {
          retryCount++;
          setTimeout(() => {
            statusText.textContent = `Reconnecting... (${retryCount}/${maxRetries})`;
            // Trigger reconnection attempt
            document.dispatchEvent(new CustomEvent("reconnectRequest"));
          }, 2000 * retryCount);
        } else if (isConnected && !wasConnected) {
          retryCount = 0;
          utils.showNotification("Connection restored", "success", 3000);
        }
      };

      // Use MutationObserver for better performance
      const observer = new MutationObserver(updateStatus);
      observer.observe(statusText, {
        childList: true,
        characterData: true,
        subtree: true,
      });

      updateStatus();
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Global shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case "/":
            e.preventDefault();
            panelManager.toggle("filters");
            break;
          case "m":
            e.preventDefault();
            panelManager.toggle("mobile");
            break;
          case "t":
            e.preventDefault();
            const themeToggle = state.getElement(CONFIG.selectors.themeToggle);
            if (themeToggle) {
              themeToggle.checked = !themeToggle.checked;
              themeToggle.dispatchEvent(new Event("change"));
            }
            break;
        }
      }
    });

    // Touch gesture support for panels
    if ("ontouchstart" in window) {
      let touchStartX = 0;
      let touchStartY = 0;

      document.addEventListener(
        "touchstart",
        (e) => {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
        },
        { passive: true },
      );

      document.addEventListener(
        "touchend",
        (e) => {
          const touchEndX = e.changedTouches[0].clientX;
          const touchEndY = e.changedTouches[0].clientY;

          const deltaX = touchEndX - touchStartX;
          const deltaY = Math.abs(touchEndY - touchStartY);

          // Detect horizontal swipe
          if (Math.abs(deltaX) > 50 && deltaY < 100) {
            if (deltaX > 0 && touchStartX < 20) {
              // Swipe right from left edge - open mobile menu
              panelManager.open("mobile");
            } else if (deltaX < 0 && touchStartX > window.innerWidth - 20) {
              // Swipe left from right edge - open filters
              panelManager.open("filters");
            }
          }
        },
        { passive: true },
      );
    }
  };

  // Performance optimizations
  const performanceOptimizations = {
    init() {
      // Lazy load images
      if ("IntersectionObserver" in window) {
        const imageObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const img = entry.target;
              if (img.dataset.src) {
                img.src = img.dataset.src;
                img.removeAttribute("data-src");
                imageObserver.unobserve(img);
              }
            }
          });
        });

        document.querySelectorAll("img[data-src]").forEach((img) => {
          imageObserver.observe(img);
        });
      }

      // Optimize animations for battery saving
      if ("getBattery" in navigator) {
        navigator.getBattery().then((battery) => {
          const updateAnimations = () => {
            if (battery.level < 0.2 && !battery.charging) {
              // Reduce animations on low battery
              document.body.classList.add("reduce-animations");
              CONFIG.animations.enabled = false;
            } else {
              document.body.classList.remove("reduce-animations");
              CONFIG.animations.enabled = !state.reducedMotion;
            }
          };

          battery.addEventListener("levelchange", updateAnimations);
          battery.addEventListener("chargingchange", updateAnimations);
          updateAnimations();
        });
      }
    },
  };

  // Main initialization
  function init() {
    if (state.initialized) return;

    try {
      // Early theme application to prevent flash
      themeManager.init();

      // Initialize components
      panelManager.init();
      mapControlsManager.init();
      filterIndicatorManager.create();
      performanceOptimizations.init();

      // Defer non-critical initialization
      if ("requestIdleCallback" in window) {
        requestIdleCallback(
          () => {
            dateManager.init();
            setupEvents();
          },
          { timeout: 1000 },
        );
      } else {
        setTimeout(() => {
          dateManager.init();
          setupEvents();
        }, 100);
      }

      state.initialized = true;

      // Notify other components
      document.dispatchEvent(new CustomEvent("modernUIReady"));
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      utils.showNotification(
        `Error initializing UI: ${error.message}`,
        "danger",
      );
    }
  }

  // Initialize based on DOM state
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Also listen for app ready event
  document.addEventListener("appReady", () => {
    if (!state.initialized) init();
  });

  // Export public API
  window.modernUI = {
    showLoading: (msg) => window.loadingManager?.show?.(msg),
    hideLoading: () => window.loadingManager?.hide?.(),
    updateProgress: (pct, msg) =>
      window.loadingManager?.updateProgress?.(pct, msg),
    setDateRange: dateManager.setRange.bind(dateManager),
    applyTheme: themeManager.apply.bind(themeManager),
    openPanel: panelManager.open.bind(panelManager),
    closePanel: panelManager.close.bind(panelManager),
    togglePanel: panelManager.toggle.bind(panelManager),
    showNotification: utils.showNotification,
    utils,
    state,
  };
})();
