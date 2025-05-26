/* global L, bootstrap, DateUtils */

"use strict";

let baseTileLayer = null;

(function () {
  // Consolidated and optimized configuration
  const CONFIG = {
    selectors: {
      themeToggle: "#theme-toggle-checkbox",
      darkModeToggle: "#dark-mode-toggle",
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
      mapContainer: "#map",
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
      lightBg: "#e0e0e0",
      darkBg: "#1a1a1a",
      tileUrls: {
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      },
    },
    themeColors: {
      light: "#f8f9fa",
      dark: "#121212",
    },
    debounceDelays: {
      resize: 250,
      scroll: 50,
      filter: 100,
    },
    mobileBreakpoint: 768,
    tooltipDelay: { show: 500, hide: 100 },
  };

  // Optimized element cache using Map for better performance
  const elementCache = new Map();
  let isInitialized = false;

  // Utility functions
  const utils = {
    debounce: (func, wait) => {
      let timeout;
      return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    },

    getElement: (selector) => {
      if (elementCache.has(selector)) {
        return elementCache.get(selector);
      }

      const element = document.querySelector(selector);
      if (element) {
        elementCache.set(selector, element);
      }
      return element;
    },

    getAllElements: (selector) => {
      const cached = elementCache.get(`all_${selector}`);
      if (cached) return cached;

      const elements = document.querySelectorAll(selector);
      elementCache.set(`all_${selector}`, elements);
      return elements;
    },

    getStorage: (key, defaultValue = null) => {
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

    setStorage: (key, value) => {
      try {
        if (window.utils?.setStorage) {
          window.utils.setStorage(key, value);
        } else {
          localStorage.setItem(key, String(value));
        }
        return true;
      } catch {
        return false;
      }
    },

    showNotification: (message, type = "info") => {
      if (window.notificationManager?.show) {
        window.notificationManager.show(message, type);
      } else {
        console.log(`[${type.toUpperCase()}] ${message}`);
      }
    },

    batchDomUpdates: (updates) => {
      requestAnimationFrame(() => {
        updates.forEach((update) => update());
      });
    },
  };

  // Consolidated event management
  const eventManager = {
    listeners: new WeakMap(),

    add: (element, events, handler, options = {}) => {
      const el =
        typeof element === "string" ? utils.getElement(element) : element;
      if (!el) return false;

      if (!eventManager.listeners.has(el)) {
        eventManager.listeners.set(el, new Map());
      }

      const eventList = Array.isArray(events) ? events : [events];
      const elementListeners = eventManager.listeners.get(el);

      eventList.forEach((eventType) => {
        const key = `${eventType}_${handler.name || Math.random()}`;
        if (elementListeners.has(key)) return;

        const wrappedHandler = options.leftClickOnly
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

    delegate: (container, selector, eventType, handler) => {
      const containerEl =
        typeof container === "string" ? utils.getElement(container) : container;
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

    cleanup: (element) => {
      const el =
        typeof element === "string" ? utils.getElement(element) : element;
      if (!el || !eventManager.listeners.has(el)) return;

      const elementListeners = eventManager.listeners.get(el);
      elementListeners.forEach(({ handler, eventType }) => {
        el.removeEventListener(eventType, handler);
      });
      elementListeners.clear();
    },
  };

  // Theme management
  const themeManager = {
    current: null,

    init: () => {
      const saved = utils.getStorage(CONFIG.storage.theme);
      const preferred = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      const initial = saved || preferred;

      themeManager.apply(initial);
      themeManager.setupToggles();
    },

    apply: (theme) => {
      if (themeManager.current === theme) return;

      const isLight = theme === "light";
      themeManager.current = theme;

      utils.batchDomUpdates([
        () => {
          document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
          document.documentElement.setAttribute("data-bs-theme", theme);
        },
        () => themeManager.updateMetaColor(theme),
        () => themeManager.updateMapTheme(theme),
        () => themeManager.syncToggles(theme),
      ]);

      utils.setStorage(CONFIG.storage.theme, theme);
      document.dispatchEvent(
        new CustomEvent("themeChanged", { detail: { theme } }),
      );
    },

    updateMetaColor: (theme) => {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute("content", CONFIG.themeColors[theme]);
      }
    },

    updateMapTheme: (theme) => {
      if (!window.map) return;

      const mapContainer = utils.getElement(CONFIG.selectors.mapContainer);
      if (mapContainer) {
        mapContainer.style.background =
          CONFIG.map[theme === "light" ? "lightBg" : "darkBg"];
      }

      // Check if this is a Mapbox GL JS map (has setStyle method)
      if (window.map.setStyle && window.CONFIG?.MAP?.styles) {
        const styleUrl = window.CONFIG.MAP.styles[theme];
        if (styleUrl) {
          // Only update style if map is loaded to prevent style diff warnings
          if (window.map.isStyleLoaded()) {
            window.map.setStyle(styleUrl);
          } else {
            // Wait for style to load before switching
            window.map.once("style.load", () => {
              window.map.setStyle(styleUrl);
            });
          }
        }
      }
      // Legacy Leaflet support (for other pages)
      else if (window.map.addLayer && CONFIG.map?.tileUrls) {
        const tileUrl = CONFIG.map.tileUrls[theme];
        if (!tileUrl) return;

        if (baseTileLayer) {
          baseTileLayer.setUrl(tileUrl);
        } else {
          baseTileLayer = L.tileLayer(tileUrl, {
            maxZoom: 19,
            attribution: "",
          }).addTo(window.map);
        }

        // Only call invalidateSize for Leaflet maps
        if (window.map.invalidateSize) {
          window.map.invalidateSize();
        }
      }

      // Trigger resize for Mapbox GL JS (equivalent to invalidateSize)
      if (window.map.resize) {
        setTimeout(() => window.map.resize(), 100);
      }

      document.dispatchEvent(
        new CustomEvent("mapThemeChanged", { detail: { theme } }),
      );
    },

    syncToggles: (theme) => {
      const themeToggle = utils.getElement(CONFIG.selectors.themeToggle);
      const darkModeToggle = utils.getElement(CONFIG.selectors.darkModeToggle);

      if (themeToggle) themeToggle.checked = theme === "light";
      if (darkModeToggle) darkModeToggle.checked = theme === "dark";
    },

    setupToggles: () => {
      const themeToggle = utils.getElement(CONFIG.selectors.themeToggle);
      const darkModeToggle = utils.getElement(CONFIG.selectors.darkModeToggle);

      if (themeToggle) {
        eventManager.add(themeToggle, "change", () => {
          themeManager.apply(themeToggle.checked ? "light" : "dark");
        });
      }

      if (darkModeToggle && !themeToggle) {
        eventManager.add(darkModeToggle, "change", () => {
          themeManager.apply(darkModeToggle.checked ? "dark" : "light");
        });
      }
    },
  };

  // Loading management
  const loadingManager = {
    show: (message = "Loading...") => {
      const overlay = utils.getElement(".loading-overlay");
      const text = utils.getElement(".loading-text");
      const progress = utils.getElement(".progress-bar");

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

    hide: () => {
      const overlay = utils.getElement(".loading-overlay");
      const progress = utils.getElement(".progress-bar");

      if (!overlay) return;

      if (progress) progress.style.width = "100%";
      overlay.style.opacity = "0";

      setTimeout(() => {
        overlay.style.display = "none";
      }, 400);
    },

    updateProgress: (percent, message) => {
      const progress = utils.getElement(".progress-bar");
      const text = utils.getElement(".loading-text");

      if (progress)
        progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      if (text && message) text.textContent = message;
    },

    // Add operation methods for backward compatibility and global access
    startOperation: function(message = "Loading...") {
      this.show(message);
    },

    finish: function() {
      this.hide();
    },

    error: function(message) {
      this.hide();
      utils.showNotification(message, "danger");
    },
  };

  // Expose loadingManager globally for use in other scripts
  window.loadingManager = loadingManager;

  // Location management
  const locationManager = {
    findBest: () => {
      // Try live tracker first
      const liveCoords = window.liveTracker?.activeTrip?.coordinates;
      if (liveCoords?.length > 0) {
        const last = liveCoords[liveCoords.length - 1];
        if (last?.lat && last?.lon) {
          return { coords: [last.lat, last.lon], source: "live location" };
        }
      }

      // Try last known location
      const lastKnown = window.drivingNavigation?.lastKnownLocation;
      if (lastKnown?.lat && lastKnown?.lon) {
        return {
          coords: [lastKnown.lat, lastKnown.lon],
          source: "last known location",
        };
      }

      // Try last trip end
      const lastTrip = locationManager.findLastTripEnd();
      if (lastTrip) {
        return { coords: lastTrip.coords, source: "last trip end" };
      }

      return { coords: null, source: null };
    },

    findLastTripEnd: () => {
      const features = window.AppState?.mapLayers?.trips?.layer?.features;
      if (!Array.isArray(features) || features.length === 0) return null;

      let latest = null;
      let latestTime = 0;

      features.forEach((feature) => {
        const endTime = feature.properties?.endTime;
        if (endTime) {
          const time = new Date(endTime).getTime();
          if (!isNaN(time) && time > latestTime) {
            latestTime = time;
            latest = feature;
          }
        }
      });

      if (!latest) return null;

      const coords = locationManager.extractCoords(latest);
      return coords
        ? {
            coords,
            featureId:
              latest.properties?.id || latest.properties?.transactionId,
          }
        : null;
    },

    extractCoords: (feature) => {
      const { type, coordinates } = feature?.geometry || {};
      let coord = null;

      if (
        type === "LineString" &&
        Array.isArray(coordinates) &&
        coordinates.length > 0
      ) {
        coord = coordinates[coordinates.length - 1];
      } else if (type === "Point" && Array.isArray(coordinates)) {
        coord = coordinates;
      }

      if (
        Array.isArray(coord) &&
        coord.length === 2 &&
        typeof coord[0] === "number" &&
        typeof coord[1] === "number"
      ) {
        return [coord[1], coord[0]]; // Convert to [lat, lng] for Leaflet
      }
      return null;
    },

    centerMap: () => {
      if (!window.map) {
        utils.showNotification("Map is not ready yet.", "warning");
        return;
      }

      const location = locationManager.findBest();
      if (location.coords) {
        const zoom =
          window.map.getZoom() < CONFIG.map.defaultZoom
            ? CONFIG.map.defaultZoom
            : window.map.getZoom();
        window.map.flyTo(location.coords, zoom, {
          animate: true,
          duration: CONFIG.map.flyToDuration,
        });
        utils.showNotification(`Centered map on ${location.source}.`, "info");
      } else {
        utils.showNotification(
          "Could not determine current or last known location.",
          "warning",
        );
      }
    },
  };

  // Date management
  const dateManager = {
    init: () => {
      if (!window.DateUtils) {
        console.error("DateUtils not found. Cannot initialize date pickers.");
        return;
      }

      const startInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.startDate}`,
        ) || utils.getElement(CONFIG.selectors.startDate);
      const endInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.endDate}`,
        ) || utils.getElement(CONFIG.selectors.endDate);

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
        theme: themeManager.current || "dark",
        errorHandler: (error) => console.warn("Flatpickr error:", error),
      };

      // Initialize date pickers
      if (!startInput._flatpickr) DateUtils.initDatePicker(startInput, config);
      if (!endInput._flatpickr) DateUtils.initDatePicker(endInput, config);

      // Set initial values
      dateManager.updateInputs(startDate, endDate);
      dateManager.updateIndicator();
    },

    updateInputs: (startDate, endDate) => {
      const startInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.startDate}`,
        ) || utils.getElement(CONFIG.selectors.startDate);
      const endInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.endDate}`,
        ) || utils.getElement(CONFIG.selectors.endDate);

      if (startInput) {
        if (startInput._flatpickr) {
          startInput._flatpickr.setDate(startDate, true);
        } else {
          startInput.value = startDate;
        }
      }

      if (endInput) {
        if (endInput._flatpickr) {
          endInput._flatpickr.setDate(endDate, true);
        } else {
          endInput.value = endDate;
        }
      }
    },

    setRange: (range) => {
      if (!window.DateUtils) {
        utils.showNotification("Error: Date utility missing.", "danger");
        return;
      }

      window.loadingManager?.startOperation?.("DateRangeSet", 100);

      DateUtils.getDateRangePreset(range)
        .then(({ startDate, endDate }) => {
          if (startDate && endDate) {
            dateManager.updateInputs(startDate, endDate);
            utils.setStorage(CONFIG.storage.startDate, startDate);
            utils.setStorage(CONFIG.storage.endDate, endDate);
            dateManager.updateIndicator();
          } else {
            throw new Error("Invalid date range received.");
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
          window.loadingManager?.finish?.("DateRangeSet");
        });
    },

    updateIndicator: () => {
      const indicator = utils.getElement(CONFIG.selectors.filterIndicator);
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

    applyFilters: () => {
      const startInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.startDate}`,
        ) || utils.getElement(CONFIG.selectors.startDate);
      const endInput =
        utils.getElement(
          `${CONFIG.selectors.filtersPanel} ${CONFIG.selectors.endDate}`,
        ) || utils.getElement(CONFIG.selectors.endDate);

      if (!startInput || !endInput) {
        utils.showNotification(
          "UI Error: Date input elements missing.",
          "danger",
        );
        return;
      }

      const startDate = startInput.value;
      const endDate = endInput.value;

      if (!window.DateUtils?.isValidDateRange?.(startDate, endDate)) {
        utils.showNotification(
          "Invalid date range: Start date must be before or equal to end date.",
          "warning",
        );
        return;
      }

      utils.setStorage(CONFIG.storage.startDate, startDate);
      utils.setStorage(CONFIG.storage.endDate, endDate);
      dateManager.updateIndicator();

      // Close filter panel
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

    reset: () => {
      if (!window.DateUtils) {
        utils.showNotification("Error: Date utility missing.", "danger");
        return;
      }

      const today = DateUtils.getCurrentDate();
      dateManager.updateInputs(today, today);
      utils.setStorage(CONFIG.storage.startDate, today);
      utils.setStorage(CONFIG.storage.endDate, today);

      // Update quick select buttons
      const quickBtns = utils.getAllElements(".quick-select-btn");
      quickBtns.forEach((btn) => btn.classList.remove(CONFIG.classes.active));

      const todayBtn = utils.getElement(
        '.quick-select-btn[data-range="today"]',
      );
      if (todayBtn) todayBtn.classList.add(CONFIG.classes.active);

      dateManager.updateIndicator();
      dateManager.applyFilters();
    },
  };

  // Panel management (drawer, filters)
  const panelManager = {
    close: (type) => {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = utils.getElement(panelMap[type]);
      const overlay = utils.getElement(CONFIG.selectors.contentOverlay);

      if (panel) panel.classList.remove(CONFIG.classes.open);
      if (overlay) overlay.classList.remove(CONFIG.classes.visible);

      if (type === "mobile") {
        document.body.style.overflow = "";
      }
    },

    open: (type) => {
      const panelMap = {
        mobile: CONFIG.selectors.mobileDrawer,
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = utils.getElement(panelMap[type]);
      const overlay = utils.getElement(CONFIG.selectors.contentOverlay);

      if (panel) panel.classList.add(CONFIG.classes.open);
      if (overlay) overlay.classList.add(CONFIG.classes.visible);

      if (type === "mobile") {
        document.body.style.overflow = "hidden";
      }
    },

    toggle: (type) => {
      const panelMap = {
        filters: CONFIG.selectors.filtersPanel,
      };

      const panel = utils.getElement(panelMap[type]);
      if (panel?.classList.contains(CONFIG.classes.open)) {
        panelManager.close(type);
      } else {
        panelManager.open(type);
      }
    },

    init: () => {
      // Mobile drawer
      eventManager.add(CONFIG.selectors.menuToggle, "click", (e) => {
        e.stopPropagation();
        panelManager.open("mobile");
      });

      eventManager.add(CONFIG.selectors.closeBtn, "click", () =>
        panelManager.close("mobile"),
      );
      eventManager.add(CONFIG.selectors.contentOverlay, "click", () => {
        panelManager.close("mobile");
        panelManager.close("filters");
      });

      // Filter panel
      eventManager.add(
        CONFIG.selectors.filterToggle,
        ["mousedown"],
        (e) => {
          if (e.button === 0) {
            e.stopPropagation();
            panelManager.toggle("filters");
          }
        },
        { leftClickOnly: true },
      );

      eventManager.add(
        CONFIG.selectors.filtersClose,
        ["mousedown"],
        (e) => {
          if (e.button === 0) panelManager.close("filters");
        },
        { leftClickOnly: true },
      );

      // Escape key
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          panelManager.close("mobile");
          panelManager.close("filters");
        }
      });
    },
  };

  // Map controls
  const mapControlsManager = {
    init: () => {
      const controls = utils.getElement(CONFIG.selectors.mapControls);
      const toggle = utils.getElement(CONFIG.selectors.controlsToggle);
      const centerBtn = utils.getElement(
        CONFIG.selectors.centerOnLocationButton,
      );

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

          const content = utils.getElement(CONFIG.selectors.controlsContent);
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

          requestAnimationFrame(() => mapControlsManager.updateOpacity());
        });
      }

      // Prevent map interaction
      const stopEvents = [
        "mousedown",
        "mouseup",
        "click",
        "dblclick",
        "touchstart",
        "touchend",
        "wheel",
        "contextmenu",
      ];
      stopEvents.forEach((eventType) => {
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

      // Center location button
      if (centerBtn) {
        eventManager.add(
          centerBtn,
          ["mousedown"],
          (e) => {
            if (e.button === 0) {
              e.preventDefault();
              locationManager.centerMap();
            }
          },
          { leftClickOnly: true },
        );
      }

      // Opacity management
      eventManager.add(
        controls,
        "mouseenter",
        () => (controls.style.opacity = "1"),
      );
      eventManager.add(controls, "mouseleave", () =>
        mapControlsManager.updateOpacity(),
      );

      mapControlsManager.updateOpacity();
    },

    updateOpacity: () => {
      const controls = utils.getElement(CONFIG.selectors.mapControls);
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
    create: () => {
      const toolsSection = utils.getElement(CONFIG.selectors.toolsSection);
      const existing = utils.getElement(CONFIG.selectors.filterIndicator);

      if (!toolsSection || existing) return;

      const indicator = document.createElement("div");
      indicator.className = "filter-indicator me-2";
      indicator.id = CONFIG.selectors.filterIndicator.substring(1);
      indicator.title = "Current date range filter";
      indicator.style.cursor = "pointer";
      indicator.innerHTML = `<i class="fas fa-calendar-alt me-1"></i><span class="filter-date-range">Today</span>`;

      const filterToggle = utils.getElement(CONFIG.selectors.filterToggle);
      if (filterToggle) {
        toolsSection.insertBefore(indicator, filterToggle);
      } else {
        toolsSection.appendChild(indicator);
      }

      elementCache.set(CONFIG.selectors.filterIndicator, indicator);

      eventManager.add(
        indicator,
        ["mousedown"],
        (e) => {
          if (e.button === 0) panelManager.open("filters");
        },
        { leftClickOnly: true },
      );

      dateManager.updateIndicator();
    },
  };

  // Map enhancements
  const mapEnhancer = {
    enhance: () => {
      if (!window.map?.options) return;

      window.map.options.zoomSnap = 0.5;

      // Add tooltips to zoom controls
      if (window.bootstrap?.Tooltip) {
        const zoomControls = utils.getAllElements(".leaflet-control-zoom a");
        zoomControls.forEach((control) => {
          if (bootstrap.Tooltip.getInstance(control)) return;

          let title = "";
          if (control.classList.contains("leaflet-control-zoom-in"))
            title = "Zoom In";
          else if (control.classList.contains("leaflet-control-zoom-out"))
            title = "Zoom Out";

          if (title) {
            new bootstrap.Tooltip(control, {
              title,
              placement: "left",
              delay: CONFIG.tooltipDelay,
              trigger: "hover",
            });
          }
        });
      }

      // Connection status indicator
      mapEnhancer.setupStatusIndicator();
    },

    setupStatusIndicator: () => {
      const indicator = utils.getElement(".status-indicator");
      const text = utils.getElement(".status-text");

      if (!indicator || !text) return;

      const updateStatus = () => {
        const textContent = text.textContent.toLowerCase();
        indicator.classList.toggle(
          CONFIG.classes.connected,
          textContent.includes("connected"),
        );
        indicator.classList.toggle(
          CONFIG.classes.disconnected,
          textContent.includes("disconnected") &&
            !textContent.includes("connected"),
        );
      };

      updateStatus();
      setInterval(updateStatus, 3000);
    },
  };

  // Event setup with delegation for better performance
  const setupEvents = () => {
    // Quick select buttons
    eventManager.delegate(
      document,
      ".quick-select-btn",
      "mousedown",
      function (e) {
        if (e.button !== 0) return;

        const range = this.dataset.range;
        if (!range) return;

        dateManager.setRange(range);

        utils
          .getAllElements(".quick-select-btn")
          .forEach((btn) => btn.classList.remove(CONFIG.classes.active));
        this.classList.add(CONFIG.classes.active);
      },
    );

    // Filter buttons
    eventManager.add(
      CONFIG.selectors.applyFiltersBtn,
      ["mousedown"],
      (e) => {
        if (e.button === 0) dateManager.applyFilters();
      },
      { leftClickOnly: true },
    );

    eventManager.add(
      CONFIG.selectors.resetFilters,
      ["mousedown"],
      (e) => {
        if (e.button === 0) dateManager.reset();
      },
      { leftClickOnly: true },
    );

    // Scroll effects
    const header = utils.getElement(CONFIG.selectors.header);
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
  };

  // Main initialization function
  function init() {
    if (isInitialized) return;

    try {
      themeManager.init();
      panelManager.init();
      mapControlsManager.init();
      filterIndicatorManager.create();

      requestIdleCallback(() => {
        dateManager.init();
        setupEvents();
      });

      // Map-related initializations
      document.addEventListener("mapInitialized", mapEnhancer.enhance);
      window.addEventListener("load", mapEnhancer.enhance);

      isInitialized = true;
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      utils.showNotification(
        `Error initializing UI: ${error.message}`,
        "danger",
      );
    }
  }

  // Legacy bridge for backward compatibility
  window.modernUI = {
    showLoading: loadingManager.show,
    hideLoading: loadingManager.hide,
    updateProgress: loadingManager.updateProgress,
    setDateRange: dateManager.setRange,
    applyTheme: themeManager.apply,
    centerOnLocation: locationManager.centerMap,
  };

  // Polyfill for requestIdleCallback
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

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Alternative initialization trigger
  document.addEventListener("appReady", init);
})();

// Global passive event listeners for better performance
(function () {
  const passiveEvents = ["wheel", "touchmove", "mousemove", "pointermove"];
  passiveEvents.forEach((event) => {
    window.addEventListener(event, () => {}, { passive: true });
  });
})();
