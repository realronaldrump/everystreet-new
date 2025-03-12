/* global L, flatpickr, notificationManager, bootstrap, DateUtils, $ */

/**
 * Modern UI - Main UI controller for the application
 * Handles theme, navigation, notifications, and interactive components
 */
"use strict";
(function () {
  // ==============================
  // Configuration
  // ==============================
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

  // ==============================
  // Application State
  // ==============================
  const elements = {};
  let timeout = null;

  // ==============================
  // Main Initialization
  // ==============================

  /**
   * Initialize the UI system
   */
  function init() {
    try {
      cacheElements();

      // Check if we're on a page that should have a map
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
      setupLegacyCodeBridge();

      // Handle resize events
      window.addEventListener("resize", debounce(handleResize, 250));
      handleResize();
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      if (window.notificationManager) {
        window.notificationManager.show(
          "Error initializing UI: " + error.message,
          "danger",
        );
      }
    }
  }

  /**
   * Cache frequently accessed DOM elements
   */
  function cacheElements() {
    const selectors = CONFIG.selectors;

    // Main UI elements
    elements.themeToggle = document.querySelector(selectors.themeToggle);
    elements.darkModeToggle = document.querySelector(selectors.darkModeToggle);
    elements.mobileDrawer = document.querySelector(selectors.mobileDrawer);
    elements.menuToggle = document.querySelector(selectors.menuToggle);
    elements.closeBtn = document.querySelector(selectors.closeBtn);
    elements.contentOverlay = document.querySelector(selectors.contentOverlay);

    // Filter elements
    elements.filtersToggle = document.querySelector(selectors.filterToggle);
    elements.filtersPanel = document.querySelector(selectors.filtersPanel);
    elements.filtersClose = document.querySelector(selectors.filtersClose);
    elements.startDateInput = document.querySelector(selectors.startDate);
    elements.endDateInput = document.querySelector(selectors.endDate);
    elements.applyFiltersBtn = document.querySelector(selectors.applyFilters);
    elements.resetFiltersBtn = document.querySelector(selectors.resetFilters);
    elements.quickSelectBtns = document.querySelectorAll(".quick-select-btn");
    elements.datepickers = document.querySelectorAll(selectors.datepicker);

    // Action elements
    elements.actionButton = document.querySelector(selectors.actionButton);
    elements.actionMenu = document.querySelector(selectors.actionMenu);
    elements.actionItems = document.querySelectorAll(".action-menu-item");

    // Other UI elements
    elements.header = document.querySelector(selectors.header);
    elements.loadingOverlay = document.querySelector(".loading-overlay");
    elements.progressBar = document.querySelector(
      ".loading-overlay .progress-bar",
    );
    elements.loadingText = document.querySelector(
      ".loading-overlay .loading-text",
    );
  }

  // ==============================
  // Theme Toggle Functionality
  // ==============================

  /**
   * Initialize theme toggle functionality
   */
  function initThemeToggle() {
    const { themeToggle, darkModeToggle } = elements;
    if (!themeToggle && !darkModeToggle) return;

    // Check for saved theme preference or system preference
    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;

    // Apply theme
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

        // Sync with app settings dark mode toggle if it exists
        if (darkModeToggle) {
          darkModeToggle.checked = newTheme === "dark";
        }

        document.dispatchEvent(
          new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
        );
      });
    }
  }

  /**
   * Apply theme to document and map (if available)
   * @param {string} theme - Theme name ('light' or 'dark')
   */
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

    // Update map theme if map exists
    updateMapTheme(theme);
  }

  /**
   * Update map theme if map exists
   * @param {string} theme - Theme name ('light' or 'dark')
   */
  function updateMapTheme(theme) {
    if (!window.map) return;

    // Container background
    document.querySelectorAll(".leaflet-container").forEach((container) => {
      container.style.background = theme === "light" ? "#e0e0e0" : "#1a1a1a";
    });

    // Make sure map is a valid Leaflet map with eachLayer method
    if (!window.map || typeof window.map.eachLayer !== "function") {
      console.warn("Map not fully initialized, skipping theme update");
      return;
    }

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

  // ==============================
  // Mobile Drawer Functionality
  // ==============================

  /**
   * Initialize mobile navigation drawer
   */
  function initMobileDrawer() {
    const { mobileDrawer, menuToggle, closeBtn, contentOverlay } = elements;
    if (!mobileDrawer || !menuToggle) return;

    // Open drawer
    menuToggle.addEventListener("click", () => {
      mobileDrawer.classList.add(CONFIG.classes.open);
      contentOverlay.classList.add(CONFIG.classes.visible);
      document.body.style.overflow = "hidden";
    });

    // Close drawer function
    const closeDrawer = () => {
      mobileDrawer.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
      document.body.style.overflow = "";
    };

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

  // ==============================
  // Filters Panel Functionality
  // ==============================

  /**
   * Initialize filters panel
   */
  function initFilterPanel() {
    const {
      filtersToggle,
      filtersPanel,
      contentOverlay,
      filtersClose,
      applyFiltersBtn,
      resetFiltersBtn,
      quickSelectBtns,
    } = elements;

    // Add filter indicator to the header
    addFilterIndicator();

    // Toggle filter panel
    if (filtersToggle && filtersPanel) {
      filtersToggle.addEventListener("click", () => {
        filtersPanel.classList.toggle(CONFIG.classes.open);
        contentOverlay.classList.toggle(CONFIG.classes.visible);
        updateFilterIndicator();
      });
    }

    // Close with panel close button
    if (filtersClose) {
      filtersClose.addEventListener("click", () => {
        filtersPanel.classList.remove(CONFIG.classes.open);
        contentOverlay.classList.remove(CONFIG.classes.visible);
      });
    }

    // Close with overlay
    if (contentOverlay) {
      contentOverlay.addEventListener("click", () => {
        filtersPanel.classList.remove(CONFIG.classes.open);
        contentOverlay.classList.remove(CONFIG.classes.visible);
      });
    }

    // Handle quick select buttons
    if (quickSelectBtns) {
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
    if (applyFiltersBtn) {
      applyFiltersBtn.addEventListener("click", () => applyFilters());
    }

    // Reset filters button
    if (resetFiltersBtn) {
      resetFiltersBtn.addEventListener("click", () => resetFilters());
    }
  }

  /**
   * Initialize all date pickers
   */
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

    // Initialize all date pickers with the datepicker class
    if (datepickers && datepickers.length > 0) {
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

  /**
   * Add a persistent filter indicator to the header
   */
  function addFilterIndicator() {
    // Find the tools section in the header
    const toolsSection = document.querySelector(".tools-section");
    if (!toolsSection) return;

    // Create the filter indicator if it doesn't exist
    if (document.getElementById("filter-indicator")) return;

    const indicator = document.createElement("div");
    indicator.className = "filter-indicator";
    indicator.id = "filter-indicator";
    indicator.setAttribute("title", "Current date range filter");
    indicator.innerHTML = `
      <i class="fas fa-calendar-alt"></i>
      <span class="filter-date-range">Today</span>
    `;

    // Insert before the filters toggle
    const filtersToggle = elements.filtersToggle;
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

  /**
   * Update the filter indicator with current date range
   */
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

  /**
   * Set date range based on preset
   * @param {string} range - Range identifier
   */
  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;

    if (!startDateInput || !endDateInput) {
      console.warn("Date inputs not found");
      return;
    }

    // Show loading indicator if available
    if (window.loadingManager) {
      window.loadingManager.startOperation("DateRangeSet", 100);
    }

    // Use the unified DateUtils.getDateRangePreset
    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
          // Update inputs and localStorage
          updateDateInputs(startDate, endDate);
          localStorage.setItem(CONFIG.storage.startDate, startDate);
          localStorage.setItem(CONFIG.storage.endDate, endDate);

          // Update filter indicator
          updateFilterIndicator();
        }
      })
      .catch((error) => {
        console.error("Error setting date range:", error);
        if (window.notificationManager) {
          window.notificationManager.show(
            "Error setting date range. Please try again.",
            "error",
          );
        }
      })
      .finally(() => {
        if (window.loadingManager) {
          window.loadingManager.finish("DateRangeSet");
        }
      });
  }

  /**
   * Update all instances of date inputs with the same ID
   * @param {string} startStr - Start date string
   * @param {string} endStr - End date string
   */
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

  /**
   * Apply the current filters
   */
  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;

    if (startDateInput && endDateInput) {
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
      if (window.notificationManager) {
        window.notificationManager.show(
          `Filters applied: ${startDateInput.value} to ${endDateInput.value}`,
          "success",
        );
      }
    }
  }

  /**
   * Reset filters to today
   */
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
    if (window.notificationManager) {
      window.notificationManager.show(
        "Date filters have been reset to today",
        "info",
      );
    }
  }

  // ==============================
  // Floating Action Button Functionality
  // ==============================

  /**
   * Initialize floating action button
   */
  function initFloatingActionButton() {
    const { actionButton, actionMenu, actionItems } = elements;
    if (!actionButton || !actionMenu) return;

    // Toggle action menu
    actionButton.addEventListener("click", () => {
      actionMenu.classList.toggle(CONFIG.classes.open);
      actionButton.classList.toggle(CONFIG.classes.active);

      // Toggle icon between plus and times
      const icon = actionButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-plus");
        icon.classList.toggle("fa-times");
      }
    });

    // Handle action menu item clicks
    if (actionItems) {
      actionItems.forEach((item) => {
        item.addEventListener("click", () => {
          const action = item.dataset.action;

          // Close menu
          actionMenu.classList.remove(CONFIG.classes.open);
          actionButton.classList.remove(CONFIG.classes.active);

          // Reset icon
          const icon = actionButton.querySelector("i");
          if (icon) {
            icon.classList.add("fa-plus");
            icon.classList.remove("fa-times");
          }

          // Handle different actions
          handleAction(action);
        });
      });
    }

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (
        actionButton &&
        actionMenu &&
        !actionButton.contains(e.target) &&
        !actionMenu.contains(e.target) &&
        actionMenu.classList.contains(CONFIG.classes.open)
      ) {
        actionMenu.classList.remove(CONFIG.classes.open);
        actionButton.classList.remove(CONFIG.classes.active);

        // Reset icon
        const icon = actionButton.querySelector("i");
        if (icon) {
          icon.classList.add("fa-plus");
          icon.classList.remove("fa-times");
        }
      }
    });
  }

  /**
   * Handle action menu item click
   * @param {string} action - Action identifier
   */
  function handleAction(action) {
    switch (action) {
      case "fetch-trips":
        handleFetchTrips();
        break;
      case "map-match":
        handleMapMatch();
        break;
      case "new-place":
        handleAddPlace();
        break;
    }
  }

  /**
   * Initialize scroll effects
   */
  function initScrollEffects() {
    const { header } = elements;
    if (!header) return;

    // Add shadow to header on scroll
    const scrollHandler = () => {
      if (window.scrollY > 10) {
        header.classList.add(CONFIG.classes.scrolled);
      } else {
        header.classList.remove(CONFIG.classes.scrolled);
      }
    };

    window.addEventListener("scroll", scrollHandler);

    // Initial check
    scrollHandler();
  }

  // ==============================
  // Utility Functions
  // ==============================

  /**
   * Handle window resize
   */
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

  /**
   * Simple debounce function
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in ms
   * @returns {Function} Debounced function
   */
  function debounce(func, wait) {
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // ==============================
  // Action Handlers
  // ==============================

  /**
   * Handle fetch trips action
   */
  async function handleFetchTrips() {
    showLoading("Fetching trips...");

    // Get date range from localStorage or use current date
    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      new Date().toISOString().split("T")[0];

    // Create request data
    const requestData = {
      start_date: startDate,
      end_date: endDate,
      include_points: true,
    };

    try {
      const response = await fetch("/api/fetch_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json();
      hideLoading();

      // Show notification with actual data
      if (window.notificationManager) {
        window.notificationManager.show(
          `Successfully fetched ${data.trips_count || 0} trips.`,
          "success",
        );
      }

      // Reload map data if applicable
      refreshMapData();
    } catch (error) {
      console.error("Error fetching trips:", error);
      hideLoading();

      if (window.notificationManager) {
        window.notificationManager.show(
          `Error fetching trips: ${error.message}`,
          "danger",
        );
      }
    }
  }

  /**
   * Handle map match action
   */
  async function handleMapMatch() {
    showLoading("Map matching trips...");

    // Get date range from localStorage or use current date
    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      new Date().toISOString().split("T")[0];

    // Create request data
    const requestData = {
      start_date: startDate,
      end_date: endDate,
      force_rematch: false,
    };

    try {
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json();
      hideLoading();

      // Show notification with actual data
      if (window.notificationManager) {
        window.notificationManager.show(
          `Successfully matched ${
            data.matched_count || 0
          } trips to the road network.`,
          "success",
        );
      }

      // Reload map data if applicable
      refreshMapData();
    } catch (error) {
      console.error("Error map matching trips:", error);
      hideLoading();

      if (window.notificationManager) {
        window.notificationManager.show(
          `Error map matching: ${error.message}`,
          "danger",
        );
      }
    }
  }

  /**
   * Handle add place action
   */
  function handleAddPlace() {
    // First check if the CustomPlacesManager is available
    if (window.customPlaces) {
      // If the app has 'start-drawing' button, use that workflow
      const startDrawingBtn = document.getElementById("start-drawing");
      if (startDrawingBtn) {
        startDrawingBtn.click();

        // Show a notification with instructions
        if (window.notificationManager) {
          window.notificationManager.show(
            "Draw a polygon on the map to create a new place",
            "info",
          );
        }

        // Focus the map if possible
        if (window.map) {
          window.map.getContainer().focus();
        }
        return;
      }

      // Alternative - check for existing place management modal
      const manageModal = document.getElementById("manage-places-modal");
      if (manageModal && window.bootstrap?.Modal) {
        const modalInstance = new bootstrap.Modal(manageModal);
        modalInstance.show();
        return;
      }
    }

    // Fallback to simple location prompt
    handleAddPlaceFallback();
  }

  /**
   * Fallback for adding a place without modal
   */
  function handleAddPlaceFallback() {
    // Show form dialog using built-in prompt as fallback
    const placeName = prompt("Enter place name:");
    if (!placeName) return;

    const latitude = prompt("Enter latitude (e.g. 34.0522):");
    const longitude = prompt("Enter longitude (e.g. -118.2437):");

    if (!latitude || !longitude) return;

    // Validate inputs
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      if (window.notificationManager) {
        window.notificationManager.show(
          "Please enter valid latitude and longitude values.",
          "warning",
        );
      }
      return;
    }

    submitPlaceData({
      name: placeName,
      latitude: lat,
      longitude: lng,
      radius: 100,
      type: "custom",
    });
  }

  /**
   * Submit place data to API
   * @param {Object} placeData - Place data
   */
  async function submitPlaceData(placeData) {
    showLoading("Adding place...");

    try {
      const response = await fetch("/api/places/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(placeData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to add place");
      }

      hideLoading();

      if (window.notificationManager) {
        window.notificationManager.show(
          `Successfully added place: ${placeData.name}`,
          "success",
        );
      }

      // Refresh the places list or map
      refreshPlacesData();
    } catch (error) {
      console.error("Error adding place:", error);
      hideLoading();

      if (window.notificationManager) {
        window.notificationManager.show(
          `Error adding place: ${error.message}`,
          "danger",
        );
      }
    }
  }

  /**
   * Refresh map data by calling appropriate functions
   */
  function refreshMapData() {
    if (window.map) {
      // Try different refresh methods in order of preference
      if (typeof window.EveryStreet?.App?.fetchTrips === "function") {
        window.EveryStreet.App.fetchTrips();
      } else if (typeof window.fetchTrips === "function") {
        window.fetchTrips();
      }
    }
  }

  /**
   * Refresh places data by calling appropriate functions
   */
  function refreshPlacesData() {
    if (
      window.customPlaces &&
      typeof window.customPlaces.loadPlaces === "function"
    ) {
      window.customPlaces.loadPlaces();
    }
  }

  // ==============================
  // Loading Overlay Functions
  // ==============================

  /**
   * Show loading overlay
   * @param {string} message - Loading message
   */
  function showLoading(message = "Loading...") {
    const { loadingOverlay, loadingText, progressBar } = elements;
    if (!loadingOverlay) return;

    // Set loading message
    if (loadingText) {
      loadingText.textContent = message;
    }

    // Reset progress bar
    if (progressBar) {
      progressBar.style.width = "0%";
    }

    // Show loading overlay
    loadingOverlay.style.display = "flex";
  }

  /**
   * Hide loading overlay
   */
  function hideLoading() {
    const { loadingOverlay, progressBar } = elements;
    if (!loadingOverlay) return;

    // Finish progress animation
    if (progressBar) {
      progressBar.style.width = "100%";
    }

    // Hide with small delay for smooth animation
    setTimeout(() => {
      loadingOverlay.style.display = "none";
    }, 400);
  }

  /**
   * Update progress in the loading overlay
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Optional message to display
   */
  function updateProgress(percent, message) {
    const { progressBar, loadingText } = elements;

    if (progressBar) {
      progressBar.style.width = `${percent}%`;
    }

    if (loadingText && message) {
      loadingText.textContent = message;
    }
  }

  // ==============================
  // Legacy Code Bridge
  // ==============================

  /**
   * Setup bridge between Modern UI and legacy code
   */
  function setupLegacyCodeBridge() {
    // Expose key methods to global scope for legacy code to call
    window.modernUI = {
      showNotification: (message, type) => {
        if (window.notificationManager) {
          window.notificationManager.show(message, type);
        }
      },
      showLoading,
      updateProgress,
      hideLoading,
      updateFilterIndicator,
      applyTheme,
      initDatePickers,
    };

    // Backward compatibility layer for loadingManager reference
    if (!window.loadingManager) {
      window.loadingManager = createCompatibilityLoadingManager();
    }

    // Set up theme change event listener
    document.addEventListener("themeChanged", function (e) {
      if (e.detail && e.detail.theme) {
        applyTheme(e.detail.theme);
      }
    });
  }

  /**
   * Create a compatibility layer for legacy loadingManager
   * @returns {Object} Compatible loadingManager interface
   */
  function createCompatibilityLoadingManager() {
    return {
      showLoading,
      updateProgress,
      hideLoading,

      // Operations tracking system (compatibility with app.js)
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
        if (message) {
          updateProgress(progress, message);
        }
      },

      finish: () => {
        hideLoading();
      },

      error: (message) => {
        hideLoading();
        if (window.notificationManager) {
          window.notificationManager.show(message, "danger");
        }
      },
    };
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", init);
})();
