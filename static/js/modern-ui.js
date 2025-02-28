/* global L, flatpickr, notificationManager, bootstrap, $ */

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
    notificationDuration: 5000,
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
      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initFloatingActionButton();
      initScrollEffects();
      initNotifications();
      setupLegacyCodeBridge();

      // Handle resize events
      window.addEventListener("resize", debounce(handleResize, 250));
      handleResize();

      // Removed console.log and replaced with notification manager
      if (window.notificationManager) {
        window.notificationManager.show("Modern UI initialized", "info");
      }
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
    }
  }

  /**
   * Cache frequently accessed DOM elements
   */
  function cacheElements() {
    const selectors = CONFIG.selectors;

    // Main UI elements
    elements.themeToggle = document.querySelector(selectors.themeToggle);
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

    // Action elements
    elements.actionButton = document.querySelector(selectors.actionButton);
    elements.actionMenu = document.querySelector(selectors.actionMenu);
    elements.actionItems = document.querySelectorAll(".action-menu-item");

    // Other UI elements
    elements.header = document.querySelector(selectors.header);
    elements.loadingOverlay = document.querySelector(".loading-overlay");
    elements.progressBar = document.querySelector(
      ".loading-overlay .progress-bar"
    );
    elements.loadingText = document.querySelector(
      ".loading-overlay .loading-text"
    );
  }

  // ==============================
  // Theme Toggle Functionality
  // ==============================

  /**
   * Initialize theme toggle functionality
   */
  function initThemeToggle() {
    const { themeToggle } = elements;
    if (!themeToggle) return;

    // Check for saved theme preference or system preference
    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;

    // Apply theme
    if (savedTheme === "light" || (!savedTheme && !prefersDarkScheme)) {
      applyTheme("light");
      themeToggle.checked = true;
    } else {
      applyTheme("dark");
      themeToggle.checked = false;
    }

    // Handle theme toggle
    themeToggle.addEventListener("change", () => {
      const themeName = themeToggle.checked ? "light" : "dark";
      applyTheme(themeName);
      localStorage.setItem(CONFIG.storage.theme, themeName);

      document.dispatchEvent(
        new CustomEvent("themeChanged", { detail: { theme: themeName } })
      );
    });
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
      new CustomEvent("mapThemeChanged", { detail: { theme } })
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
      startDateInput,
      endDateInput,
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

    // Initialize datepickers if available
    initDatePickers(startDateInput, endDateInput);

    // Handle quick select buttons
    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const range = btn.dataset.range;
          if (!range) return;

          setDateRange(range, startDateInput, endDateInput);

          // Update active button state
          quickSelectBtns.forEach((b) =>
            b.classList.remove(CONFIG.classes.active)
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
   * Initialize date pickers
   * @param {HTMLElement} startInput - Start date input element
   * @param {HTMLElement} endInput - End date input element
   */
  function initDatePickers(startInput, endInput) {
    if (!window.flatpickr || !startInput || !endInput) return;

    // Get dates from localStorage or use defaults
    const today = new Date().toISOString().split("T")[0];
    startInput.value = localStorage.getItem(CONFIG.storage.startDate) || today;
    endInput.value = localStorage.getItem(CONFIG.storage.endDate) || today;

    // Create configuration
    const dateConfig = {
      dateFormat: "Y-m-d",
      maxDate: "today",
      disableMobile: true,
      theme: document.body.classList.contains(CONFIG.classes.lightMode)
        ? "light"
        : "dark",
    };

    // Initialize flatpickr
    window.flatpickr(startInput, dateConfig);
    window.flatpickr(endInput, dateConfig);
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
      new Date(dateStr).toLocaleDateString();
    rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
  }

  /**
   * Set date range based on preset
   * @param {string} range - Range identifier
   * @param {HTMLElement} startInput - Start date input
   * @param {HTMLElement} endInput - End date input
   */
  function setDateRange(range, startInput, endInput) {
    const today = new Date();
    const startDate = new Date(today);
    const endDate = new Date(today);

    // Calculate dates based on range
    switch (range) {
      case "today":
        // Keep default
        break;
      case "yesterday":
        startDate.setDate(startDate.getDate() - 1);
        endDate.setDate(endDate.getDate() - 1);
        break;
      case "last-week":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "last-month":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "all-time":
        startDate.setFullYear(startDate.getFullYear() - 10);
        break;
      default:
        return;
    }

    // Format dates as strings
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    // Update inputs and localStorage
    updateDateInputs(startInput, endInput, startDateStr, endDateStr);
    localStorage.setItem(CONFIG.storage.startDate, startDateStr);
    localStorage.setItem(CONFIG.storage.endDate, endDateStr);
  }

  /**
   * Update date inputs (both DOM value and flatpickr instance if available)
   * @param {HTMLElement} startInput - Start date input
   * @param {HTMLElement} endInput - End date input
   * @param {string} startStr - Start date string
   * @param {string} endStr - End date string
   */
  function updateDateInputs(startInput, endInput, startStr, endStr) {
    if (startInput) {
      startInput.value = startStr;
      if (startInput._flatpickr) {
        startInput._flatpickr.setDate(startStr);
      }
    }

    if (endInput) {
      endInput.value = endStr;
      if (endInput._flatpickr) {
        endInput._flatpickr.setDate(endStr);
      }
    }
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
        })
      );

      // Show confirmation
      showNotification({
        title: "Filters Applied",
        message: `Date range: ${startDateInput.value} to ${endDateInput.value}`,
        type: "success",
        duration: 3000,
      });
    }
  }

  /**
   * Reset filters to today
   */
  function resetFilters() {
    const { startDateInput, endDateInput, quickSelectBtns } = elements;
    const today = new Date().toISOString().split("T")[0];

    // Update inputs
    updateDateInputs(startDateInput, endDateInput, today, today);

    // Remove active class from quick select buttons
    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) =>
        btn.classList.remove(CONFIG.classes.active)
      );
    }

    // Show notification
    showNotification({
      title: "Filters Reset",
      message: "Date filters have been reset to today",
      type: "info",
      duration: 3000,
    });
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
  // Notification Management
  // ==============================

  /**
   * Initialize notifications system
   */
  function initNotifications() {
    // Find container or create if needed
    let container = document.querySelector(".notification-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "notification-container";
      document.body.appendChild(container);
    }

    // Find existing notifications and add close handlers
    const notifications = container.querySelectorAll(".notification");
    notifications.forEach((notification) => {
      const closeBtn = notification.querySelector(".notification-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          removeNotification(notification);
        });
      }
    });

    // Set up event listener for custom notification events
    document.addEventListener("showNotification", (e) => {
      if (e.detail) {
        showNotification(e.detail);
      }
    });
  }

  /**
   * Show notification
   * @param {Object} options - Notification options
   * @param {string} options.title - Notification title
   * @param {string} options.message - Notification message
   * @param {string} options.type - Notification type (success, error, warning, info)
   * @param {number} options.duration - Duration in ms (default: 5000)
   * @returns {HTMLElement} The notification element
   */
  function showNotification({
    title,
    message,
    type = "info",
    duration = CONFIG.notificationDuration,
  }) {
    // Find container or create it
    let container = document.querySelector(".notification-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "notification-container";
      document.body.appendChild(container);
    }

    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;

    // Define icon based on type
    let icon = "info-circle";
    switch (type) {
      case "success":
        icon = "check-circle";
        break;
      case "error":
        icon = "exclamation-circle";
        break;
      case "warning":
        icon = "exclamation-triangle";
        break;
    }

    // Set notification content
    notification.innerHTML = `
      <div class="notification-icon">
        <i class="fas fa-${icon}"></i>
      </div>
      <div class="notification-content">
        <div class="notification-title">${title || "Notification"}</div>
        <div class="notification-message">${message}</div>
      </div>
      <button type="button" class="notification-close">
        <i class="fas fa-times"></i>
      </button>
    `;

    // Add to container
    container.appendChild(notification);

    // Show notification (add with delay to trigger animation)
    setTimeout(() => {
      notification.classList.add(CONFIG.classes.show);
    }, 10);

    // Attach close button handler
    const closeBtn = notification.querySelector(".notification-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        removeNotification(notification);
      });
    }

    // Auto remove after duration
    setTimeout(() => {
      removeNotification(notification);
    }, duration);

    return notification;
  }

  /**
   * Remove notification with animation
   * @param {HTMLElement} notification - Notification element
   */
  function removeNotification(notification) {
    notification.classList.remove(CONFIG.classes.show);

    // Remove after animation completes
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 300);
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

    // Simulate progress (replace with actual progress updates)
    simulateLoadingProgress();
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

    // Clear any progress simulation
    if (window.loadingInterval) {
      clearInterval(window.loadingInterval);
      window.loadingInterval = null;
    }
  }

  /**
   * Simulate loading progress
   */
  function simulateLoadingProgress() {
    const { progressBar } = elements;
    if (!progressBar) return;

    // Clear any existing interval
    if (window.loadingInterval) {
      clearInterval(window.loadingInterval);
    }

    let progress = 0;

    // Update progress bar every 100ms
    window.loadingInterval = setInterval(() => {
      // Increment progress
      progress += Math.random() * 3;

      // Cap at 95% (100% will be set when actually complete)
      if (progress > 95) {
        progress = 95;
        clearInterval(window.loadingInterval);
        window.loadingInterval = null;
      }

      // Update progress bar
      progressBar.style.width = `${progress}%`;
    }, 100);
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
      showNotification({
        title: "Trips Fetched",
        message: `Successfully fetched ${data.trips_count || 0} trips.`,
        type: "success",
      });

      // Reload map data if applicable
      refreshMapData();
    } catch (error) {
      console.error("Error fetching trips:", error);
      hideLoading();

      showNotification({
        title: "Error Fetching Trips",
        message: `There was an error: ${error.message}`,
        type: "error",
        duration: 8000,
      });
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
      showNotification({
        title: "Map Matching Complete",
        message: `Successfully matched ${data.matched_count || 0} trips to the road network.`,
        type: "success",
      });

      // Reload map data if applicable
      refreshMapData();
    } catch (error) {
      console.error("Error map matching trips:", error);
      hideLoading();

      showNotification({
        title: "Error Map Matching",
        message: `There was an error: ${error.message}`,
        type: "error",
        duration: 8000,
      });
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
        showNotification({
          title: "Draw Mode Activated",
          message: "Draw a polygon on the map to create a new place",
          type: "info",
        });

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
      showNotification({
        title: "Invalid Coordinates",
        message: "Please enter valid latitude and longitude values.",
        type: "error",
      });
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

      showNotification({
        title: "Place Added",
        message: `Successfully added place: ${placeData.name}`,
        type: "success",
      });

      // Refresh the places list or map
      refreshPlacesData();
    } catch (error) {
      console.error("Error adding place:", error);
      hideLoading();

      showNotification({
        title: "Error Adding Place",
        message: `There was an error: ${error.message}`,
        type: "error",
      });
    }
  }

  /**
   * Refresh map data by calling appropriate functions
   */
  function refreshMapData() {
    if (window.map) {
      // Try different refresh methods
      if (typeof window.refreshMapData === "function") {
        window.refreshMapData();
      } else if (typeof window.EveryStreet?.App?.fetchTrips === "function") {
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
    if (typeof window.refreshPlaces === "function") {
      window.refreshPlaces();
    } else if (
      window.customPlaces &&
      typeof window.customPlaces.loadPlaces === "function"
    ) {
      window.customPlaces.loadPlaces();
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
      showNotification,
      showLoading,
      updateProgress,
      hideLoading,
      updateFilterIndicator,
    };

    // Backward compatibility layer for loadingManager reference
    window.loadingManager = createCompatibilityLoadingManager();
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

      startOperation: (operationName, _totalSteps = 100) => {
        showLoading(`Starting ${operationName}...`);
        return operationName;
      },

      addSubOperation: () => {},

      updateSubOperation: (
        _parentOperation,
        _subOperationName,
        progress,
        message
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
        showNotification({
          title: "Error",
          message,
          type: "error",
        });
      },
    };
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", init);
})();
