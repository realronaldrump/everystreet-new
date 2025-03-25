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
      sidebarState: "sidebarCollapsed"
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


  }

  /**
   * Initialize all event listeners
   */
  function initEventListeners() {
    // Toggle sidebar buttons
    [elements.toggleButton, elements.collapseButton]
      .filter(Boolean)
      .forEach((btn) => btn.addEventListener("click", toggleSidebar));



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


    // Load sidebar state
    const isCollapsed = getStorage(CONFIG.storageKeys.sidebarState) === "true";
    if (isCollapsed && window.innerWidth >= CONFIG.mobileBreakpoint) {
      elements.body?.classList.add("sidebar-collapsed");
      elements.sidebar?.classList.add("collapsed");
      elements.toggleButton?.classList.add("active");
      elements.mainContent?.classList.add("expanded");
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
        elements.sidebar.classList.contains("collapsed")
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
      "(prefers-color-scheme: dark)"
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
        })
      );
    });
  }
})();
