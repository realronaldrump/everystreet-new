/* global DateUtils */

"use strict";

/**
 * Sidebar Management - Handles sidebar UI component and related functionality
 */
(() => {
  // Configuration constants
  const CONFIG = {
    mobileBreakpoint: 992,
    storageKeys: {
      sidebarState: "sidebarCollapsed",
      startDate: "startDate",
      endDate: "endDate",
      filtersCollapsed: "filtersCollapsed",
    },
  };

  // Cache DOM elements once on initialization
  const elements = {};

  /**
   * Initialize the sidebar functionality
   */
  function init() {
    cacheElements();

    if (!elements.sidebar) return;

    initEventListeners();
    loadSavedState();
    handleResponsiveLayout();

    // Handle initial window size
    window.addEventListener("resize", debounce(handleResponsiveLayout, 250));
  }

  /**
   * Cache all required DOM elements
   */
  function cacheElements() {
    // Main sidebar elements
    elements.sidebar = document.getElementById("sidebar");
    elements.toggleButton = document.getElementById("sidebar-toggle");
    elements.collapseButton = document.getElementById("sidebar-collapse");
    elements.mainContent = document.querySelector("main");
    elements.body = document.body;

    // Filter elements
    elements.filtersToggle = document.getElementById("toggle-filters");
    elements.filtersContent = document.getElementById("filters-content");
    elements.applyFiltersBtn = document.getElementById("apply-filters");
    elements.startDateInput = document.getElementById("start-date");
    elements.endDateInput = document.getElementById("end-date");
    elements.datePresetButtons = document.querySelectorAll(".date-preset");
  }

  /**
   * Initialize all event listeners
   */
  function initEventListeners() {
    // Toggle sidebar buttons
    [elements.toggleButton, elements.collapseButton]
      .filter(Boolean)
      .forEach((btn) => btn.addEventListener("click", toggleSidebar));

    // Date inputs
    [elements.startDateInput, elements.endDateInput]
      .filter(Boolean)
      .forEach((input) => {
        input?.addEventListener("change", handleDateChange);
      });

    // Filters toggle
    elements.filtersToggle?.addEventListener("click", toggleFiltersSection);

    // Apply filters button
    elements.applyFiltersBtn?.addEventListener("click", applyFilters);

    // Date preset buttons
    elements.datePresetButtons.forEach((btn) => {
      btn.addEventListener("click", (e) =>
        handleDatePreset(e.currentTarget.dataset.range),
      );
    });

    // Keyboard shortcut for sidebar toggle (Ctrl+B)
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    });

    // Close sidebar on mobile when clicking outside
    document.addEventListener("click", handleClickOutside);
  }

  /**
   * Handle date input changes
   * @param {Event} e - Change event
   */
  function handleDateChange(e) {
    const key = e.target.id.includes("start") ? "startDate" : "endDate";
    setStorage(CONFIG.storageKeys[key], e.target.value);
  }

  /**
   * Toggle the filters section visibility
   */
  function toggleFiltersSection() {
    if (!elements.filtersToggle || !elements.filtersContent) return;

    const isCollapsing =
      !elements.filtersToggle.classList.contains("collapsed");
    elements.filtersToggle.classList.toggle("collapsed");

    if (isCollapsing) {
      elements.filtersContent.classList.remove("show");
    } else {
      elements.filtersContent.classList.add("show");
    }

    setStorage(CONFIG.storageKeys.filtersCollapsed, isCollapsing);
  }

  /**
   * Handle click outside sidebar on mobile
   * @param {Event} e - Click event
   */
  function handleClickOutside(e) {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;
    const sidebarActive = elements.sidebar.classList.contains("active");
    const clickedOutside =
      !elements.sidebar.contains(e.target) &&
      (!elements.toggleButton || !elements.toggleButton.contains(e.target));

    if (isMobile && sidebarActive && clickedOutside) {
      toggleSidebar();
    }
  }

  /**
   * Load saved state from localStorage
   */
  function loadSavedState() {
    // Load dates
    const startDate = getStorage(CONFIG.storageKeys.startDate);
    const endDate = getStorage(CONFIG.storageKeys.endDate);

    if (startDate && elements.startDateInput) {
      elements.startDateInput.value = startDate;
    }

    if (endDate && elements.endDateInput) {
      elements.endDateInput.value = endDate;
    }

    // Load sidebar state
    const isCollapsed = getStorage(CONFIG.storageKeys.sidebarState) === "true";
    if (isCollapsed && window.innerWidth >= CONFIG.mobileBreakpoint) {
      elements.body?.classList.add("sidebar-collapsed");
      elements.sidebar?.classList.add("collapsed");
      elements.toggleButton?.classList.add("active");
      elements.mainContent?.classList.add("expanded");
    }

    // Load filters collapsed state
    const filtersCollapsed =
      getStorage(CONFIG.storageKeys.filtersCollapsed) === "true";
    if (filtersCollapsed && elements.filtersToggle) {
      elements.filtersToggle.classList.add("collapsed");
      elements.filtersContent?.classList.remove("show");
    }
  }

  /**
   * Toggle sidebar visibility
   */
  function toggleSidebar() {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;

    if (isMobile) {
      elements.sidebar.classList.toggle("active");
    } else {
      elements.sidebar.classList.toggle("collapsed");
      elements.body.classList.toggle("sidebar-collapsed");
      elements.mainContent?.classList.toggle("expanded");
    }

    // Update toggle button if it exists
    if (elements.toggleButton) {
      elements.toggleButton.classList.toggle("active");
      const icon = elements.toggleButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-bars");
        icon.classList.toggle("fa-times");
      }
    }

    // Store state (only for desktop mode)
    if (!isMobile) {
      setStorage(
        CONFIG.storageKeys.sidebarState,
        elements.sidebar.classList.contains("collapsed"),
      );
    }
  }

  /**
   * Handle responsive layout adjustments
   */
  function handleResponsiveLayout() {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;
    const isCollapsed = getStorage(CONFIG.storageKeys.sidebarState) === "true";

    if (isMobile) {
      // Remove desktop-specific classes on mobile
      elements.sidebar.classList.remove("collapsed");
      elements.body.classList.remove("sidebar-collapsed");
      elements.mainContent?.classList.remove("expanded");
    } else if (isCollapsed) {
      // Apply collapsed state on desktop
      elements.body.classList.add("sidebar-collapsed");
      elements.sidebar.classList.add("collapsed");
      elements.mainContent?.classList.add("expanded");
    } else {
      // Apply expanded state on desktop
      elements.body.classList.remove("sidebar-collapsed");
      elements.sidebar.classList.remove("collapsed");
      elements.mainContent?.classList.remove("expanded");
    }
  }

  /**
   * Handle date preset button clicks
   * @param {string} range - Range identifier
   */
  async function handleDatePreset(range) {
    if (!range) return;

    try {
      // Use the unified DateUtils function to get date range
      const { startDate, endDate } = await DateUtils.getDateRangePreset(range);

      if (startDate && endDate) {
        // Update inputs directly with string values
        if (elements.startDateInput && elements.endDateInput) {
          if (elements.startDateInput._flatpickr) {
            elements.startDateInput._flatpickr.setDate(startDate);
          } else {
            elements.startDateInput.value = startDate;
          }

          if (elements.endDateInput._flatpickr) {
            elements.endDateInput._flatpickr.setDate(endDate);
          } else {
            elements.endDateInput.value = endDate;
          }
        }

        // Store in localStorage
        setStorage(CONFIG.storageKeys.startDate, startDate);
        setStorage(CONFIG.storageKeys.endDate, endDate);

        // Apply filters
        applyFilters();
      }
    } catch (error) {
      console.error("Error setting date range:", error);
      // Show notification if available
      if (window.notificationManager) {
        window.notificationManager.show(
          "Error setting date range. Please try again.",
          "error",
        );
      }
    }
  }

  /**
   * Apply filters and trigger data refresh
   */
  function applyFilters() {
    if (!elements.applyFiltersBtn) return;

    // Save current dates to storage
    if (elements.startDateInput) {
      setStorage(CONFIG.storageKeys.startDate, elements.startDateInput.value);
    }

    if (elements.endDateInput) {
      setStorage(CONFIG.storageKeys.endDate, elements.endDateInput.value);
    }

    // Dispatch event for components to refresh data
    document.dispatchEvent(
      new CustomEvent("filtersApplied", {
        detail: {
          startDate: elements.startDateInput?.value,
          endDate: elements.endDateInput?.value,
        },
      }),
    );
  }

  /**
   * Simple debounce function
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in ms
   * @returns {Function} Debounced function
   */
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  /**
   * Get a value from localStorage with error handling
   * @param {string} key - Storage key
   * @param {*} defaultValue - Default value if not found
   * @returns {*} Retrieved value or default
   */
  function getStorage(key, defaultValue = null) {
    try {
      return localStorage.getItem(key) || defaultValue;
    } catch (e) {
      console.warn(`Error reading from localStorage: ${e.message}`);
      return defaultValue;
    }
  }

  /**
   * Set a value in localStorage with error handling
   * @param {string} key - Storage key
   * @param {*} value - Value to store
   */
  function setStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`Error writing to localStorage: ${e.message}`);
    }
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", init);

  // Theme toggle functionality
  document.addEventListener("DOMContentLoaded", initThemeToggle);

  /**
   * Initialize theme toggle functionality
   */
  function initThemeToggle() {
    const themeToggle = document.getElementById("theme-toggle-checkbox");
    if (!themeToggle) return;

    // Load saved theme
    const savedTheme = getStorage("theme");
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const useLight =
      savedTheme === "light" || (!savedTheme && !prefersDarkScheme);

    if (useLight) {
      document.body.classList.add("light-mode");
      themeToggle.checked = true;
    }

    // Handle theme changes
    themeToggle.addEventListener("change", () => {
      if (themeToggle.checked) {
        document.body.classList.add("light-mode");
        setStorage("theme", "light");
      } else {
        document.body.classList.remove("light-mode");
        setStorage("theme", "dark");
      }

      // Trigger theme change event
      document.dispatchEvent(
        new CustomEvent("themeChanged", {
          detail: { theme: themeToggle.checked ? "light" : "dark" },
        }),
      );
    });
  }
})();
