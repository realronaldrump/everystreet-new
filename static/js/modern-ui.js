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
      mapControls: "#map-controls", // Added selector for map controls
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

      // Check for map
      const shouldHaveMap = document.querySelector("#map") !== null;
      if (
        shouldHaveMap &&
        (!window.map || typeof window.map.eachLayer !== "function")
      ) {
        console.warn(
          "Map not properly initialized. Some features may not work correctly.",
        );
      }

      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initFloatingActionButton();
      initScrollEffects();
      initDatePickers();
      initMapControls(); // Added initialization for map controls
      setupLegacyCodeBridge();

      // Handle resize events
      window.addEventListener(
        "resize",
        window.utils?.debounce(handleResize, 250) ||
          debounce(handleResize, 250),
      );
      handleResize();
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
      elements[key] = document.querySelector(selectors[key]);
    });

    // These are collections that need special handling
    elements.quickSelectBtns = document.querySelectorAll(".quick-select-btn");
    elements.datepickers = document.querySelectorAll(selectors.datepicker);
    elements.actionItems = document.querySelectorAll(".action-menu-item");
    elements.loadingOverlay = document.querySelector(".loading-overlay");
    elements.progressBar = document.querySelector(
      ".loading-overlay .progress-bar",
    );
    elements.loadingText = document.querySelector(
      ".loading-overlay .loading-text",
    );
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
      applyFiltersBtn,
      resetFiltersBtn,
      quickSelectBtns,
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
        btn.addEventListener("click", () => {
          const range = btn.dataset.range;
          if (!range) return;

          setDateRange(range);

          // Update active button state
          quickSelectBtns.forEach((b) =>
            b.classList.remove(CONFIG.classes.active),
          );
          btn.classList.add(CONFIG.classes.active);
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
    if (startDateInput) {
      startDateInput.value = startDate;
      if (startDateInput._flatpickr) {
        startDateInput._flatpickr.setDate(startDate);
      }
    }

    if (endDateInput) {
      endDateInput.value = endDate;
      if (endDateInput._flatpickr) {
        endDateInput._flatpickr.setDate(endDate);
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

    const startDate = localStorage.getItem(CONFIG.storage.startDate);
    const endDate = localStorage.getItem(CONFIG.storage.endDate);

    if (!startDate || !endDate) {
      rangeSpan.textContent = "Today";
      return;
    }

    // Format dates for display
    const formatDisplayDate = (dateStr) =>
      DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" });
    rangeSpan.textContent = `${formatDisplayDate(
      startDate,
    )} - ${formatDisplayDate(endDate)}`;
  }

  // Set date range based on preset
  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;
    if (!startDateInput || !endDateInput) {
      console.warn("Date inputs not found");
      return;
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
    // Update all start date inputs
    document.querySelectorAll("#start-date").forEach((input) => {
      input.value = startStr;
      if (input._flatpickr) {
        input._flatpickr.setDate(startStr);
      }
    });

    // Update all end date inputs
    document.querySelectorAll("#end-date").forEach((input) => {
      input.value = endStr;
      if (input._flatpickr) {
        input._flatpickr.setDate(endStr);
      }
    });
  }

  // Apply the current filters
  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;
    if (!startDateInput || !endDateInput) return;

    // Save to localStorage
    localStorage.setItem(CONFIG.storage.startDate, startDateInput.value);
    localStorage.setItem(CONFIG.storage.endDate, endDateInput.value);

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
          startDate: startDateInput.value,
          endDate: endDateInput.value,
        },
      }),
    );

    // Show confirmation
    window.notificationManager?.show(
      `Filters applied: ${startDateInput.value} to ${endDateInput.value}`,
      "success",
    );
  }

  // Reset filters to today
  function resetFilters() {
    const { quickSelectBtns } = elements;
    const today = new Date().toISOString().split("T")[0];

    // Update inputs
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

    // Show notification
    window.notificationManager?.show(
      "Date filters have been reset to today",
      "info",
    );
  }

  // Floating Action Button Functionality
  function initFloatingActionButton() {
    const { actionButton, actionMenu, actionItems } = elements;
    if (!actionButton || !actionMenu) return;

    // Toggle FAB menu function
    const toggleActionMenu = (show) => {
      actionMenu.classList.toggle(CONFIG.classes.open, show);
      actionButton.classList.toggle(CONFIG.classes.active, show);

      // Toggle icon
      const icon = actionButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-plus", !show);
        icon.classList.toggle("fa-times", show);
      }
    };

    // Toggle action menu on click
    actionButton.addEventListener("click", () => {
      const isOpen = actionMenu.classList.contains(CONFIG.classes.open);
      toggleActionMenu(!isOpen);
    });

    // Handle action menu item clicks
    if (actionItems) {
      actionItems.forEach((item) => {
        item.addEventListener("click", () => {
          const action = item.dataset.action;
          toggleActionMenu(false);
          handleAction(action);
        });
      });
    }

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (
        actionButton &&
        actionMenu.classList.contains(CONFIG.classes.open) &&
        !actionButton.contains(e.target) &&
        !actionMenu.contains(e.target)
      ) {
        toggleActionMenu(false);
      }
    });
  }

  // Handle action menu item click
  function handleAction(action) {
    switch (action) {
      case "fetch-trips":
        handleFetchTrips();
        break;
      case "map-match":
        handleMapMatch();
        break;

    }
  }

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

  // Action Handlers
  async function handleFetchTrips() {
    showLoading("Fetching trips...");

    // Get date range
    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      new Date().toISOString().split("T")[0];

    try {
      const response = await fetch("/api/fetch_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          include_points: true,
        }),
      });

      if (!response.ok)
        throw new Error(`HTTP error! Status: ${response.status}`);

      const data = await response.json();
      hideLoading();

      // Show notification
      window.notificationManager?.show(
        `Successfully fetched ${data.trips_count || 0} trips.`,
        "success",
      );

      // Reload map data
      refreshMapData();
    } catch (error) {
      console.error("Error fetching trips:", error);
      hideLoading();
      window.notificationManager?.show(
        `Error fetching trips: ${error.message}`,
        "danger",
      );
    }
  }

  async function handleMapMatch() {
    showLoading("Map matching trips...");

    // Get date range
    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      new Date().toISOString().split("T")[0];

    try {
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          force_rematch: false,
        }),
      });

      if (!response.ok)
        throw new Error(`HTTP error! Status: ${response.status}`);

      const data = await response.json();
      hideLoading();

      // Show notification
      window.notificationManager?.show(
        `Successfully matched ${
          data.matched_count || 0
        } trips to the road network.`,
        "success",
      );

      // Reload map data
      refreshMapData();
    } catch (error) {
      console.error("Error map matching trips:", error);
      hideLoading();
      window.notificationManager?.show(
        `Error map matching: ${error.message}`,
        "danger",
      );
    }
  }

  // Place-related handlers removed - places should only be added from the Visits page

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
    // Expose key methods for legacy code
    window.modernUI = {
      showNotification: (message, type) =>
        window.notificationManager?.show(message, type),
      showLoading,
      updateProgress,
      hideLoading,
      updateFilterIndicator,
      applyTheme,
      initDatePickers,
    };

    // Backward compatibility for loadingManager
    if (!window.loadingManager) {
      window.loadingManager = createCompatibilityLoadingManager();
    }

    // Set up theme change event listener
    document.addEventListener("themeChanged", (e) => {
      if (e.detail?.theme) applyTheme(e.detail.theme);
    });
  }

  // Create compatibility layer for legacy loadingManager
  function createCompatibilityLoadingManager() {
    return {
      showLoading,
      updateProgress,
      hideLoading,
      operations: new Map(),
      startOperation: (operationName) => {
        showLoading(`Starting ${operationName}...`);
        return operationName;
      },
      addSubOperation: () => {},
      updateSubOperation: (
        _parentOperation,
        _subOperationName,
        progress,
        message,
      ) => {
        if (message) updateProgress(progress, message);
      },
      finish: () => hideLoading(),
      error: (message) => {
        hideLoading();
        window.notificationManager?.show(message, "danger");
      },
    };
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", init);
})();
