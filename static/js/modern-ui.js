/* global L, flatpickr, notificationManager, bootstrap, DateUtils, $ */

/**
 * Modern UI - Main UI controller for the application
 */
"use strict";
(function () {
  // Configuration
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
      applyFilters: "#apply-filters",
      resetFilters: "#reset-filters",
      actionButton: "#action-button",
      actionMenu: "#action-menu",
      header: ".app-header",
      datepicker: ".datepicker",
      mapControls: "#map-controls",
      mapTileUrl: {
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      },
    },
    classes: {
      active: "active",
      open: "open",
      visible: "visible",
      show: "show",
      scrolled: "scrolled",
      lightMode: "light-mode",
    },
    storage: {
      theme: "theme",
      startDate: "startDate",
      endDate: "endDate",
    },
    mobileBreakpoint: 768,
  };

  // Application State
  const elements = {};

  // Main Initialization
  function init() {
    try {
      cacheElements();

      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initScrollEffects();
      initDatePickers();
      initMapControls();
      setupLegacyCodeBridge();

      // Handle resize events
      window.addEventListener(
        "resize",
        window.utils?.debounce(handleResize, 250) ||
          debounce(handleResize, 250),
      );
      handleResize();

      // Initialize map-dependent features AFTER map initialization
      document.addEventListener("mapInitialized", () => {
        console.log("Map initialization detected by modern-ui.js");
        enhanceMapInteraction();
      });
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      window.notificationManager?.show(
        "Error initializing UI: " + error.message,
        "danger",
      );
    }
  }

  // Cache elements for better performance
  function cacheElements() {
    const selectors = CONFIG.selectors;
    const selectorKeys = Object.keys(selectors).filter(
      (key) => typeof selectors[key] === "string",
    );

    // Cache all elements in one loop
    selectorKeys.forEach((key) => {
      // Ensure we get elements within the filters panel if IDs are ambiguous
      if (key === "startDate" || key === "endDate") {
        elements[`${key}Input`] = document.querySelector(
          `#filters-panel ${selectors[key]}`,
        );
      } else {
        elements[key] = document.querySelector(selectors[key]);
      }
    });
    // Correct element references if needed after potential prefixing
    if (!elements.startDateInput) elements.startDateInput = elements.startDate;
    if (!elements.endDateInput) elements.endDateInput = elements.endDate;

    // These are collections that need special handling
    elements.quickSelectBtns = document.querySelectorAll(".quick-select-btn");
    elements.datepickers = document.querySelectorAll(
      CONFIG.selectors.datepicker,
    ); // Use CONFIG
    elements.loadingOverlay = document.querySelector(".loading-overlay");
    elements.progressBar = document.querySelector(
      ".loading-overlay .progress-bar",
    );
    elements.loadingText = document.querySelector(
      ".loading-overlay .loading-text",
    );

    // Add missing elements used later
    elements.applyFiltersBtn = document.getElementById("apply-filters");
    elements.resetFiltersBtn = document.getElementById("reset-filters");
  }

  // Initialize Map Controls to Prevent Event Propagation
  function initMapControls() {
    const mapControls =
      elements.mapControls || document.getElementById("map-controls");
    if (!mapControls) return;

    // Apply touch-action CSS to enable vertical scrolling
    mapControls.style.touchAction = "pan-y";
    mapControls.style.webkitOverflowScrolling = "touch";
    mapControls.style.overflowY = "auto";

    // Set up controls toggle functionality
    const controlsToggle = document.getElementById("controls-toggle");
    if (controlsToggle) {
      controlsToggle.addEventListener("click", function () {
        const controlsContent = document.getElementById("controls-content");
        mapControls.classList.toggle("minimized");

        if (controlsContent) {
          if (window.bootstrap?.Collapse) {
            const bsCollapse =
              window.bootstrap.Collapse.getInstance(controlsContent);
            if (bsCollapse) {
              mapControls.classList.contains("minimized")
                ? bsCollapse.hide()
                : bsCollapse.show();
            } else {
              new window.bootstrap.Collapse(controlsContent, {
                toggle: !mapControls.classList.contains("minimized"),
              });
            }
          }
        }

        // Toggle icon
        const icon = this.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-up");
          icon.classList.toggle("fa-chevron-down");
        }
      });
    }

    // Events that should be prevented from propagating to the map
    const events = [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "touchstart",
      "touchend",
      "wheel",
      "contextmenu",
      "drag",
      "dragstart",
      "dragend",
    ];

    // Add event listeners to prevent propagation
    events.forEach((eventType) => {
      mapControls.addEventListener(
        eventType,
        (e) => {
          // Don't stop propagation from form elements to allow them to work properly
          const target = e.target;
          const isFormElement =
            target.tagName === "INPUT" ||
            target.tagName === "SELECT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "BUTTON" ||
            target.closest("button") ||
            target.closest("a") ||
            target.closest(".form-check") ||
            target.closest(".nav-item");

          // Allow normal interaction with form elements but prevent map actions
          if (!isFormElement) {
            e.stopPropagation();
          }
        },
        { passive: true },
      );
    });

    // Handle touchmove separately - allows scrolling the panel but prevents map interactions
    mapControls.addEventListener(
      "touchmove",
      (e) => {
        // Allow the default behavior (scrolling) but stop propagation to the map
        e.stopPropagation();
      },
      { passive: true },
    );

    // Set the cursor style to indicate the panel is interactive
    mapControls.style.cursor = "default";

    // Add CSS class to properly handle events
    mapControls.classList.add("map-controls-event-handler");

    // Add CSS to ensure controls are properly isolated from map
    const style = document.createElement("style");
    style.textContent = `
      .map-controls-event-handler {
        pointer-events: auto;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
      }
      #map-controls .card,
      #map-controls .form-control,
      #map-controls .btn,
      #map-controls .form-check,
      #map-controls .form-select,
      #map-controls .nav-item,
      #map-controls .list-group-item {
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);

    console.log(
      "Map controls initialized and event propagation handlers set up",
    );
  }

  // Theme Toggle Functionality
  function initThemeToggle() {
    const { themeToggle, darkModeToggle } = elements;
    if (!themeToggle && !darkModeToggle) return;

    // Check preferences
    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const isLight =
      savedTheme === "light" || (!savedTheme && !prefersDarkScheme);
    const themeName = isLight ? "light" : "dark";

    // Apply theme
    applyTheme(themeName);

    // Set toggle states
    if (themeToggle) {
      themeToggle.checked = isLight;
      themeToggle.addEventListener("change", () => {
        const newTheme = themeToggle.checked ? "light" : "dark";
        applyTheme(newTheme);
        localStorage.setItem(CONFIG.storage.theme, newTheme);

        // Sync with app settings dark mode toggle
        if (darkModeToggle) {
          darkModeToggle.checked = newTheme === "dark";
        }

        document.dispatchEvent(
          new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
        );
      });
    }
  }

  // Apply theme to document and map
  function applyTheme(theme) {
    const isLight = theme === "light";

    // Update document
    document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
    document.documentElement.setAttribute("data-bs-theme", theme);

    // Update theme-color meta tag for mobile browsers
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", isLight ? "#f8f9fa" : "#121212");
    }

    updateMapTheme(theme);
  }

  // Update map theme if map exists
  function updateMapTheme(theme) {
    if (!window.map || typeof window.map.eachLayer !== "function") return;

    // Container background
    document.querySelectorAll(".leaflet-container").forEach((container) => {
      container.style.background = theme === "light" ? "#e0e0e0" : "#1a1a1a";
    });

    // Remove existing tile layers
    window.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        window.map.removeLayer(layer);
      }
    });

    // Add new tile layer
    const tileUrl = CONFIG.selectors.mapTileUrl[theme];
    L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution: "",
    }).addTo(window.map);

    // Fix rendering issues
    window.map.invalidateSize();

    // Dispatch map theme change event
    document.dispatchEvent(
      new CustomEvent("mapThemeChanged", { detail: { theme } }),
    );
  }

  // Mobile Drawer Functionality
  function initMobileDrawer() {
    const { mobileDrawer, menuToggle, closeBtn, contentOverlay } = elements;
    if (!mobileDrawer || !menuToggle) return;

    // Close drawer function
    const closeDrawer = () => {
      mobileDrawer.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
      document.body.style.overflow = "";
    };

    // Open drawer
    menuToggle.addEventListener("click", () => {
      mobileDrawer.classList.add(CONFIG.classes.open);
      contentOverlay.classList.add(CONFIG.classes.visible);
      document.body.style.overflow = "hidden";
    });

    // Close drawer with button
    closeBtn?.addEventListener("click", closeDrawer);

    // Close drawer with overlay
    contentOverlay?.addEventListener("click", closeDrawer);

    // Close drawer with Escape key
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        mobileDrawer.classList.contains(CONFIG.classes.open)
      ) {
        closeDrawer();
      }
    });
  }

  // Filters Panel Functionality
  function initFilterPanel() {
    const {
      filterToggle,
      filtersPanel,
      contentOverlay,
      filtersClose,
      applyFiltersBtn, // Use cached element
      resetFiltersBtn, // Use cached element
      quickSelectBtns, // Use cached element
    } = elements;

    // Add filter indicator
    addFilterIndicator();

    // Toggle filter panel
    if (filterToggle && filtersPanel) {
      filterToggle.addEventListener("click", () => {
        filtersPanel.classList.toggle(CONFIG.classes.open);
        contentOverlay.classList.toggle(CONFIG.classes.visible);
        updateFilterIndicator();
      });
    }

    // Close panel handlers
    const closePanel = () => {
      filtersPanel?.classList.remove(CONFIG.classes.open);
      contentOverlay?.classList.remove(CONFIG.classes.visible);
    };

    filtersClose?.addEventListener("click", closePanel);
    contentOverlay?.addEventListener("click", closePanel);

    // Handle quick select buttons
    if (quickSelectBtns?.length) {
      quickSelectBtns.forEach((btn) => {
        btn.addEventListener("click", function () {
          // Use function to access `this`
          const range = this.dataset.range; // Use `this`
          if (!range) return;

          setDateRange(range); // This will now also apply filters

          // Update active button state
          quickSelectBtns.forEach((b) =>
            b.classList.remove(CONFIG.classes.active),
          );
          this.classList.add(CONFIG.classes.active); // Use `this`
        });
      });
    }

    // Apply filters button
    applyFiltersBtn?.addEventListener("click", applyFilters);

    // Reset filters button
    resetFiltersBtn?.addEventListener("click", resetFilters);
  }

  // Initialize all date pickers
  function initDatePickers() {
    const { datepickers, startDateInput, endDateInput } = elements;

    // Get dates from localStorage or use defaults
    const today = DateUtils.getCurrentDate();
    const startDate = localStorage.getItem(CONFIG.storage.startDate) || today;
    const endDate = localStorage.getItem(CONFIG.storage.endDate) || today;

    // Create configuration
    const dateConfig = {
      maxDate: "today",
      disableMobile: true,
      theme: document.body.classList.contains(CONFIG.classes.lightMode)
        ? "light"
        : "dark",
    };

    // Initialize all date pickers
    if (datepickers?.length) {
      datepickers.forEach((input) => {
        if (!input._flatpickr) {
          DateUtils.initDatePicker(input, dateConfig);
        }
      });
    }

    // Set values for the main date filters
    // Ensure elements are cached before accessing
    if (!elements.startDateInput)
      elements.startDateInput = document.querySelector(
        CONFIG.selectors.startDate,
      );
    if (!elements.endDateInput)
      elements.endDateInput = document.querySelector(CONFIG.selectors.endDate);

    if (elements.startDateInput) {
      elements.startDateInput.value = startDate;
      if (elements.startDateInput._flatpickr) {
        elements.startDateInput._flatpickr.setDate(startDate);
      }
    }

    if (elements.endDateInput) {
      elements.endDateInput.value = endDate;
      if (elements.endDateInput._flatpickr) {
        elements.endDateInput._flatpickr.setDate(endDate);
      }
    }
  }

  // Add a persistent filter indicator to the header
  function addFilterIndicator() {
    const toolsSection = document.querySelector(".tools-section");
    if (!toolsSection || document.getElementById("filter-indicator")) return;

    const indicator = document.createElement("div");
    indicator.className = "filter-indicator";
    indicator.id = "filter-indicator";
    indicator.setAttribute("title", "Current date range filter");
    indicator.innerHTML = `
      <i class="fas fa-calendar-alt"></i>
      <span class="filter-date-range">Today</span>
    `;

    // Insert before the filters toggle
    const { filtersToggle } = elements;
    if (filtersToggle) {
      toolsSection.insertBefore(indicator, filtersToggle);
    } else {
      toolsSection.appendChild(indicator);
    }

    // Add click event to open filters panel
    indicator.addEventListener("click", () => {
      if (elements.filtersPanel && elements.contentOverlay) {
        elements.filtersPanel.classList.add(CONFIG.classes.open);
        elements.contentOverlay.classList.add(CONFIG.classes.visible);
      }
    });

    // Initial update
    updateFilterIndicator();
  }

  // Update the filter indicator with current date range
  function updateFilterIndicator() {
    const indicator = document.getElementById("filter-indicator");
    if (!indicator) return;

    const rangeSpan = indicator.querySelector(".filter-date-range");
    if (!rangeSpan) return;

    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      DateUtils.getCurrentDate();
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      DateUtils.getCurrentDate();

    // Format dates for display using DateUtils if available
    const formatDisplayDate = (dateStr) =>
      window.DateUtils?.formatForDisplay(dateStr, { dateStyle: "medium" }) ||
      dateStr;

    // Handle case where dates might be the same
    if (startDate === endDate) {
      rangeSpan.textContent = formatDisplayDate(startDate);
    } else {
      rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
    }
  }

  // Set date range based on preset and apply filters
  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;
    // Add a check here to ensure elements exist before proceeding
    if (!startDateInput || !endDateInput) {
      console.error(
        "Date input elements not found in modern-ui.js cache. Cannot set date range.",
      );
      window.notificationManager?.show(
        "UI Error: Date inputs not found.",
        "danger",
      );
      return; // Exit if elements are missing
    }

    // Show loading indicator
    if (window.loadingManager) {
      window.loadingManager.startOperation("DateRangeSet", 100);
    }

    // Use DateUtils
    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
          // Update inputs and localStorage
          updateDateInputs(startDate, endDate);
          localStorage.setItem(CONFIG.storage.startDate, startDate);
          localStorage.setItem(CONFIG.storage.endDate, endDate);
          updateFilterIndicator();
          // Apply filters immediately after setting range from preset
          applyFilters();
        }
      })
      .catch((error) => {
        console.error("Error setting date range:", error);
        window.notificationManager?.show(
          "Error setting date range. Please try again.",
          "error",
        );
      })
      .finally(() => {
        if (window.loadingManager) {
          window.loadingManager.finish("DateRangeSet");
        }
      });
  }

  // Update all instances of date inputs with the same ID
  function updateDateInputs(startStr, endStr) {
    // Update the cached start date input
    if (elements.startDateInput) {
      elements.startDateInput.value = startStr;
      if (elements.startDateInput._flatpickr) {
        elements.startDateInput._flatpickr.setDate(startStr);
      }
    } else {
      console.warn("Cached start date input not found in updateDateInputs");
    }

    // Update the cached end date input
    if (elements.endDateInput) {
      elements.endDateInput.value = endStr;
      if (elements.endDateInput._flatpickr) {
        elements.endDateInput._flatpickr.setDate(endStr);
      }
    } else {
      console.warn("Cached end date input not found in updateDateInputs");
    }
  }

  // Apply the current filters
  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;
    // Add check for inputs
    if (!startDateInput || !endDateInput) {
      console.error("Cannot apply filters: Date input elements not found.");
      window.notificationManager?.show(
        "UI Error: Date inputs missing.",
        "danger",
      );
      return;
    }

    // Get values safely
    const startDateValue = startDateInput.value;
    const endDateValue = endDateInput.value;

    // Save to localStorage
    localStorage.setItem(CONFIG.storage.startDate, startDateValue);
    localStorage.setItem(CONFIG.storage.endDate, endDateValue);

    // Update the indicator
    updateFilterIndicator();

    // Close the panel
    if (filtersPanel && contentOverlay) {
      filtersPanel.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
    }

    // Trigger event for data updates
    document.dispatchEvent(
      new CustomEvent("filtersApplied", {
        detail: {
          startDate: startDateValue, // Use saved value
          endDate: endDateValue, // Use saved value
        },
      }),
    );

    // Show confirmation
    window.notificationManager?.show(
      `Filters applied: ${startDateValue} to ${endDateValue}`,
      "success",
    );
  }

  // Reset filters to today
  function resetFilters() {
    const { quickSelectBtns } = elements;
    const today = new Date().toISOString().split("T")[0];

    // Update inputs using the centralized function
    updateDateInputs(today, today);

    // Save to localStorage
    localStorage.setItem(CONFIG.storage.startDate, today);
    localStorage.setItem(CONFIG.storage.endDate, today);

    // Remove active class from quick select buttons
    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) =>
        btn.classList.remove(CONFIG.classes.active),
      );
    }

    // Update the indicator
    updateFilterIndicator();

    // Apply the reset filters immediately
    applyFilters();

    // Show notification
    window.notificationManager?.show(
      "Date filters reset to Today and applied.", // Updated message
      "info",
    );
  }

  // Action Handlers moved to other UI elements
  // These functions remain as they may be called from other places
  // in the application

  // Initialize scroll effects
  function initScrollEffects() {
    const { header } = elements;
    if (!header) return;

    // Add shadow to header on scroll
    const scrollHandler = () => {
      header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
    };

    window.addEventListener("scroll", scrollHandler);
    scrollHandler(); // Initial check
  }

  // Handle window resize
  function handleResize() {
    // Close mobile drawer on larger screens
    if (window.innerWidth >= CONFIG.mobileBreakpoint) {
      const { mobileDrawer, contentOverlay } = elements;
      if (mobileDrawer?.classList.contains(CONFIG.classes.open)) {
        mobileDrawer.classList.remove(CONFIG.classes.open);
        contentOverlay?.classList.remove(CONFIG.classes.visible);
        document.body.style.overflow = "";
      }
    }
  }

  // Simple debounce function if utils not available
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Refresh map data by calling appropriate functions
  function refreshMapData() {
    if (window.map) {
      if (typeof window.EveryStreet?.App?.fetchTrips === "function") {
        window.EveryStreet.App.fetchTrips();
      } else if (typeof window.fetchTrips === "function") {
        window.fetchTrips();
      }
    }
  }

  // Refresh places data
  function refreshPlacesData() {
    if (window.customPlaces?.loadPlaces) {
      window.customPlaces.loadPlaces();
    }
  }

  // Loading Overlay Functions
  function showLoading(message = "Loading...") {
    const { loadingOverlay, loadingText, progressBar } = elements;
    if (!loadingOverlay) return;

    if (loadingText) loadingText.textContent = message;
    if (progressBar) progressBar.style.width = "0%";
    loadingOverlay.style.display = "flex";
  }

  function hideLoading() {
    const { loadingOverlay, progressBar } = elements;
    if (!loadingOverlay) return;

    if (progressBar) progressBar.style.width = "100%";
    setTimeout(() => {
      loadingOverlay.style.display = "none";
    }, 400);
  }

  function updateProgress(percent, message) {
    const { progressBar, loadingText } = elements;
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (loadingText && message) loadingText.textContent = message;
  }

  // Legacy Code Bridge
  function setupLegacyCodeBridge() {
    // Bridge to make modern components work with legacy code
    window.modernUI = {
      showLoading: showLoading,
      hideLoading: hideLoading,
      updateProgress: updateProgress,
      setDateRange: setDateRange,
      applyTheme: applyTheme,
    };

    // Enhanced map interaction
    window.addEventListener("load", enhanceMapInteraction);
  }

  // Add enhance map interaction function
  function enhanceMapInteraction() {
    // Only run on pages with a map
    if (!document.getElementById("map")) return;

    // Map should be initialized by the time this is called
    applyMapEnhancements();
  }

  function applyMapEnhancements() {
    try {
      const map = window.map;
      if (!map || !map.options) {
        console.warn("Map object or options not available for enhancements.");
        return;
      }

      // Add smooth zoom feature
      if (map.options) map.options.zoomSnap = 0.5;

      // Enhance zoom controls with tooltips if Bootstrap is available
      const zoomControls = document.querySelectorAll(".leaflet-control-zoom a");
      if (window.bootstrap && window.bootstrap.Tooltip) {
        zoomControls.forEach((control) => {
          if (control.classList.contains("leaflet-control-zoom-in")) {
            new bootstrap.Tooltip(control, {
              title: "Zoom In",
              placement: "left",
              delay: { show: 500, hide: 100 },
            });
          } else if (control.classList.contains("leaflet-control-zoom-out")) {
            new bootstrap.Tooltip(control, {
              title: "Zoom Out",
              placement: "left",
              delay: { show: 500, hide: 100 },
            });
          }
        });
      }

      // Add pulse animation to connection status indicator when connected
      const updateConnectionIndicator = () => {
        const statusIndicator = document.querySelector(".status-indicator");
        const statusText = document.querySelector(".status-text");

        if (statusIndicator && statusText) {
          if (statusText.textContent.toLowerCase().includes("connected")) {
            statusIndicator.classList.add("connected");
            statusIndicator.classList.remove("disconnected");
          } else if (
            statusText.textContent.toLowerCase().includes("disconnected")
          ) {
            statusIndicator.classList.add("disconnected");
            statusIndicator.classList.remove("connected");
          }
        }
      };

      // Check connection status periodically
      updateConnectionIndicator();
      setInterval(updateConnectionIndicator, 3000);

      // Add fading transition for map controls panel
      const controlsToggle = document.getElementById("controls-toggle");
      const mapControls = document.getElementById("map-controls");

      if (controlsToggle && mapControls) {
        controlsToggle.addEventListener("click", () => {
          requestAnimationFrame(() => {
            if (mapControls.classList.contains("minimized")) {
              mapControls.style.opacity = "0.8";
            } else {
              mapControls.style.opacity = "1";
            }
          });
        });

        // Show controls fully when hovering
        mapControls.addEventListener("mouseenter", () => {
          mapControls.style.opacity = "1";
        });

        // Reduce opacity slightly when not hovering (if minimized)
        mapControls.addEventListener("mouseleave", () => {
          if (mapControls.classList.contains("minimized")) {
            mapControls.style.opacity = "0.8";
          }
        });
      }

      console.log("Map enhancements applied successfully");
    } catch (error) {
      console.warn("Error applying map enhancements:", error);
    }
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", init);
})();
