/* global DateUtils */
"use strict";

(() => {
  // Configuration
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
    },
    storage: {
      theme: "theme",
      startDate: "startDate",
      endDate: "endDate",
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
    },
    mobileBreakpoint: 768,
    tooltipDelay: { show: 500, hide: 100 },
  };

  // State management
  class UIState {
    constructor() {
      this.elementCache = new Map();
      this.initialized = false;
      this.currentTheme = null;
      this.listeners = new WeakMap();
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
  }

  const state = new UIState();

  // Utilities
  const utils = {
    debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    },

    getStorage(key, defaultValue = null) {
      try {
        return (
          window.utils?.getStorage?.(key) ??
          localStorage.getItem(key) ??
          defaultValue
        );
      } catch {
        return defaultValue;
      }
    },

    setStorage(key, value) {
      try {
        window.utils?.setStorage?.(key, value) ??
          localStorage.setItem(key, String(value));
        return true;
      } catch {
        return false;
      }
    },

    showNotification(message, type = "info") {
      window.notificationManager?.show?.(message, type) ||
        console.log(`[${type.toUpperCase()}] ${message}`);
    },

    batchDomUpdates(updates) {
      requestAnimationFrame(() => {
        updates.forEach((update) => update());
      });
    },
  };

  // Event management
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
  };

  // Theme management
  const themeManager = {
    init() {
      const saved = utils.getStorage(CONFIG.storage.theme);
      const preferred = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      const initial = saved || preferred;

      this.apply(initial);
      this.setupToggles();

      // Listen for system theme changes
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", (e) => {
          if (!utils.getStorage(CONFIG.storage.theme)) {
            this.apply(e.matches ? "dark" : "light");
          }
        });
    },

    apply(theme) {
      if (state.currentTheme === theme) return;

      const isLight = theme === "light";
      state.currentTheme = theme;

      utils.batchDomUpdates([
        () => {
          document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
          document.documentElement.setAttribute("data-bs-theme", theme);
        },
        () => this.updateMetaColor(theme),
        () => this.updateMapTheme(theme),
        () => this.syncToggles(theme),
      ]);

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
      if (!window.map) return;

      // Check if this is a Mapbox GL JS map
      if (window.map.setStyle && window.CONFIG?.MAP?.styles) {
        const styleUrl = window.CONFIG.MAP.styles[theme];
        if (styleUrl && window.map.isStyleLoaded?.()) {
          window.map.setStyle(styleUrl);
        }
      }

      // Trigger resize for any map type
      if (window.map.resize) {
        setTimeout(() => window.map.resize(), 100);
      } else if (window.map.invalidateSize) {
        window.map.invalidateSize();
      }

      document.dispatchEvent(
        new CustomEvent("mapThemeChanged", { detail: { theme } }),
      );
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
  };

  // Loading management (expose globally for other scripts)
  if (!window.loadingManager || typeof window.loadingManager.addSubOperation !== "function") {
    window.loadingManager = {
      show(message = "Loading...") {
        const overlay = state.getElement(".loading-overlay");
        const text = state.getElement(".loading-text");
        const progress = state.getElement(".progress-bar");

        if (!overlay) return;

        utils.batchDomUpdates([
          () => {
            if (text) text.textContent = message;
            if (progress) progress.style.width = "0%";
            overlay.style.display = "flex";
          },
          () => (overlay.style.opacity = "1"),
        ]);
      },

      hide() {
        const overlay = state.getElement(".loading-overlay");
        const progress = state.getElement(".progress-bar");

        if (!overlay) return;

        if (progress) progress.style.width = "100%";
        overlay.style.opacity = "0";

        setTimeout(() => {
          overlay.style.display = "none";
        }, 400);
      },

      updateProgress(percent, message) {
        const progress = state.getElement(".progress-bar");
        const text = state.getElement(".loading-text");

        if (progress)
          progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        if (text && message) text.textContent = message;
      },

      // Compatibility methods
      startOperation(message) {
        this.show(message);
      },
      finish() {
        this.hide();
      },
      error(message) {
        this.hide();
        utils.showNotification(message, "danger");
      },
    };
  }

  // Panel management
  const panelManager = {
    close(type) {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = state.getElement(panelMap[type]);
      const overlay = state.getElement(CONFIG.selectors.contentOverlay);

      if (panel) panel.classList.remove(CONFIG.classes.open);
      if (overlay) overlay.classList.remove(CONFIG.classes.visible);

      if (type === "mobile") {
        document.body.style.overflow = "";
      }
    },

    open(type) {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = state.getElement(panelMap[type]);
      const overlay = state.getElement(CONFIG.selectors.contentOverlay);

      if (panel) panel.classList.add(CONFIG.classes.open);
      if (overlay) overlay.classList.add(CONFIG.classes.visible);

      if (type === "mobile") {
        document.body.style.overflow = "hidden";
      }
    },

    toggle(type) {
      const panelMap = { filters: CONFIG.selectors.filtersPanel };
      const panel = state.getElement(panelMap[type]);

      if (panel?.classList.contains(CONFIG.classes.open)) {
        this.close(type);
      } else {
        this.open(type);
      }
    },

    init() {
      // Mobile drawer
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
        if (e.key === "Escape") {
          this.close("mobile");
          this.close("filters");
        }
      });
    },
  };

  // Date management
  const dateManager = {
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
      };

      if (!startInput._flatpickr) DateUtils.initDatePicker(startInput, config);
      if (!endInput._flatpickr) DateUtils.initDatePicker(endInput, config);

      this.updateInputs(startDate, endDate);
      this.updateIndicator();
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

    setRange(range) {
      if (!window.DateUtils) {
        utils.showNotification("Date utility missing", "danger");
        return;
      }

      window.loadingManager?.show("Setting date range...");

      DateUtils.getDateRangePreset(range)
        .then(({ startDate, endDate }) => {
          if (startDate && endDate) {
            this.updateInputs(startDate, endDate);
            utils.setStorage(CONFIG.storage.startDate, startDate);
            utils.setStorage(CONFIG.storage.endDate, endDate);
            this.updateIndicator();
          } else {
            throw new Error("Invalid date range");
          }
        })
        .catch((error) => {
          console.error("Error setting date range:", error);
          utils.showNotification(
            `Error setting date range: ${error.message}`,
            "danger",
          );
        })
        .finally(() => {
          window.loadingManager?.hide();
        });
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

      rangeSpan.textContent =
        startDate === endDate
          ? formatDate(startDate)
          : `${formatDate(startDate)} - ${formatDate(endDate)}`;
    },

    applyFilters() {
      const startInput = state.getElement(CONFIG.selectors.startDate);
      const endInput = state.getElement(CONFIG.selectors.endDate);

      if (!startInput || !endInput) {
        utils.showNotification("Date input elements missing", "danger");
        return;
      }

      const startDate = startInput.value;
      const endDate = endInput.value;

      if (!window.DateUtils?.isValidDateRange?.(startDate, endDate)) {
        utils.showNotification("Invalid date range", "warning");
        return;
      }

      utils.setStorage(CONFIG.storage.startDate, startDate);
      utils.setStorage(CONFIG.storage.endDate, endDate);
      this.updateIndicator();

      panelManager.close("filters");

      document.dispatchEvent(
        new CustomEvent("filtersApplied", {
          detail: { startDate, endDate },
        }),
      );

      utils.showNotification(
        `Filters applied: ${DateUtils.formatForDisplay(startDate)} to ${DateUtils.formatForDisplay(endDate)}`,
        "success",
      );
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

      const quickBtns = state.getAllElements(".quick-select-btn");
      quickBtns.forEach((btn) => btn.classList.remove(CONFIG.classes.active));

      const todayBtn = state.getElement(
        '.quick-select-btn[data-range="today"]',
      );
      if (todayBtn) todayBtn.classList.add(CONFIG.classes.active);

      this.updateIndicator();
      this.applyFilters();
    },
  };

  // Map controls
  const mapControlsManager = {
    init() {
      const controls = state.getElement(CONFIG.selectors.mapControls);
      const toggle = state.getElement(CONFIG.selectors.controlsToggle);

      if (!controls) return;

      // Optimize for touch devices
      Object.assign(controls.style, {
        touchAction: "pan-y",
        webkitOverflowScrolling: "touch",
        overflowY: "auto",
      });

      // Toggle functionality
      if (toggle) {
        eventManager.add(toggle, "click", () => {
          controls.classList.toggle(CONFIG.classes.minimized);

          const content = state.getElement(CONFIG.selectors.controlsContent);
          if (content && window.bootstrap?.Collapse) {
            const collapse =
              window.bootstrap.Collapse.getOrCreateInstance(content);
            controls.classList.contains(CONFIG.classes.minimized)
              ? collapse.hide()
              : collapse.show();
          }

          const icon = toggle.querySelector("i");
          if (icon) {
            icon.classList.toggle("fa-chevron-up");
            icon.classList.toggle("fa-chevron-down");
          }

          requestAnimationFrame(() => this.updateOpacity());
        });
      }

      // Prevent map interaction
      ["mousedown", "touchstart", "wheel"].forEach((eventType) => {
        controls.addEventListener(
          eventType,
          (e) => {
            const isInteractive = e.target.closest(
              "input, select, textarea, button, a, .form-check, .nav-item, .list-group-item",
            );
            if (!isInteractive) e.stopPropagation();
          },
          { passive: false },
        );
      });

      // Opacity management
      eventManager.add(
        controls,
        "mouseenter",
        () => (controls.style.opacity = "1"),
      );
      eventManager.add(controls, "mouseleave", () => this.updateOpacity());

      this.updateOpacity();
    },

    updateOpacity() {
      const controls = state.getElement(CONFIG.selectors.mapControls);
      if (!controls || controls.matches(":hover")) return;

      controls.style.opacity = controls.classList.contains(
        CONFIG.classes.minimized,
      )
        ? "0.8"
        : "1";
    },
  };

  // Filter indicator
  const filterIndicatorManager = {
    create() {
      const toolsSection = state.getElement(CONFIG.selectors.toolsSection);
      const existing = state.getElement(CONFIG.selectors.filterIndicator);

      if (!toolsSection || existing) return;

      const indicator = document.createElement("div");
      indicator.className = "filter-indicator me-2";
      indicator.id = CONFIG.selectors.filterIndicator.substring(1);
      indicator.title = "Current date range filter";
      indicator.style.cursor = "pointer";
      indicator.innerHTML = `<i class="fas fa-calendar-alt me-1"></i><span class="filter-date-range">Today</span>`;

      const filterToggle = state.getElement(CONFIG.selectors.filterToggle);
      if (filterToggle) {
        toolsSection.insertBefore(indicator, filterToggle);
      } else {
        toolsSection.appendChild(indicator);
      }

      state.elementCache.set(CONFIG.selectors.filterIndicator, indicator);

      eventManager.add(indicator, "click", () => panelManager.open("filters"));

      dateManager.updateIndicator();
    },
  };

  // Event setup
  const setupEvents = () => {
    // Quick select buttons
    eventManager.delegate(document, ".quick-select-btn", "click", function () {
      const range = this.dataset.range;
      if (!range) return;

      dateManager.setRange(range);

      state
        .getAllElements(".quick-select-btn")
        .forEach((btn) => btn.classList.remove(CONFIG.classes.active));
      this.classList.add(CONFIG.classes.active);
    });

    // Filter buttons
    eventManager.add(CONFIG.selectors.applyFiltersBtn, "click", () =>
      dateManager.applyFilters(),
    );
    eventManager.add(CONFIG.selectors.resetFilters, "click", () =>
      dateManager.reset(),
    );

    // Scroll effects
    const header = state.getElement(CONFIG.selectors.header);
    if (header) {
      const scrollHandler = utils.debounce(() => {
        header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
      }, CONFIG.debounceDelays.scroll);

      window.addEventListener("scroll", scrollHandler, { passive: true });
      scrollHandler();
    }

    // Resize handler
    const resizeHandler = utils.debounce(() => {
      if (window.innerWidth >= CONFIG.mobileBreakpoint) {
        panelManager.close("mobile");
      }
    }, CONFIG.debounceDelays.resize);

    window.addEventListener("resize", resizeHandler);

    // Connection status indicator
    const statusIndicator = state.getElement(".status-indicator");
    const statusText = state.getElement(".status-text");

    if (statusIndicator && statusText) {
      const updateStatus = () => {
        const textContent = statusText.textContent.toLowerCase();
        statusIndicator.classList.toggle(
          CONFIG.classes.connected,
          textContent.includes("connected"),
        );
        statusIndicator.classList.toggle(
          CONFIG.classes.disconnected,
          textContent.includes("disconnected") &&
            !textContent.includes("connected"),
        );
      };

      updateStatus();
      setInterval(updateStatus, 3000);
    }
  };

  // Main initialization
  function init() {
    if (state.initialized) return;

    try {
      themeManager.init();
      panelManager.init();
      mapControlsManager.init();
      filterIndicatorManager.create();

      requestIdleCallback(() => {
        dateManager.init();
        setupEvents();
      });

      state.initialized = true;
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      utils.showNotification(
        `Error initializing UI: ${error.message}`,
        "danger",
      );
    }
  }

  // Polyfills
  if (!window.requestIdleCallback) {
    window.requestIdleCallback = function (cb) {
      const start = Date.now();
      return setTimeout(() => {
        cb({
          didTimeout: false,
          timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
        });
      }, 1);
    };
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  document.addEventListener("appReady", init);

  // Legacy API for backward compatibility
  window.modernUI = {
    showLoading: window.loadingManager.show,
    hideLoading: window.loadingManager.hide,
    updateProgress: window.loadingManager.updateProgress,
    setDateRange: dateManager.setRange.bind(dateManager),
    applyTheme: themeManager.apply.bind(themeManager),
    centerOnLocation: () => {
      // This is now handled in app.js
      const centerBtn = state.getElement(
        CONFIG.selectors.centerOnLocationButton,
      );
      if (centerBtn) centerBtn.click();
    },
  };
})();

// Passive event listeners for better performance
(() => {
  const passiveEvents = ["wheel", "touchmove", "mousemove", "pointermove"];
  passiveEvents.forEach((event) => {
    window.addEventListener(event, () => {}, { passive: true });
  });
})();
