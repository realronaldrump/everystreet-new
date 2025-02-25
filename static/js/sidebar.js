(() => {
  "use strict";

  /**
   * Sidebar class for managing sidebar UI component
   */
  class Sidebar {
    /**
     * Initialize the sidebar component
     */
    constructor() {
      // Configuration
      this.config = {
        mobileBreakpoint: 992,
        storageKeys: {
          sidebarState: "sidebarCollapsed",
          startDate: "startDate",
          endDate: "endDate",
          filtersCollapsed: "filtersCollapsed",
        },
        defaultRefreshInterval: 250,
      };

      // Initialize
      this.initializeDOMCache();
      this.init();
    }

    /**
     * Cache DOM elements for better performance
     */
    initializeDOMCache() {
      this.elements = {
        sidebar: document.getElementById("sidebar"),
        toggleButton: document.getElementById("sidebar-toggle"),
        collapseButton: document.getElementById("sidebar-collapse"),
        startDateInput: document.getElementById("start-date"),
        endDateInput: document.getElementById("end-date"),
        mainContent: document.querySelector("main"),
        body: document.body,
        filtersToggle: document.getElementById("toggle-filters"),
        sidebarBody: document.querySelector(".sidebar-body"),
        applyFiltersBtn: document.getElementById("apply-filters"),
      };
    }

    /**
     * Initialize the sidebar
     */
    init() {
      try {
        if (!this.validateElements()) return;

        this.initializeEventListeners();
        this.loadStoredDates();
        this.handleResponsiveLayout();
        this.loadSidebarState();
        this.highlightCurrentPage();
        this.initializeScrollIndicator();
        this.initializeKeyboardNavigation();
        this.loadFiltersState();

        // Trigger an event that sidebar is ready - for ModernUI coordination
        document.dispatchEvent(new CustomEvent("sidebarInitialized"));

        console.log("Sidebar initialized");
      } catch (error) {
        console.error("Error initializing sidebar:", error);
      }
    }

    /**
     * Validate required DOM elements exist
     * @returns {boolean} Whether all required elements are present
     */
    validateElements() {
      const requiredElements = ["sidebar"];

      const missing = requiredElements.filter((el) => !this.elements[el]);

      if (missing.length) {
        console.log(
          `Sidebar elements not found: ${missing.join(", ")}. This is normal if using ModernUI.`
        );
        return false;
      }

      return true;
    }

    /**
     * Initialize all event listeners
     */
    initializeEventListeners() {
      this.setupToggleListeners();
      this.setupDateInputListeners();
      this.setupWindowListeners();
      this.setupFiltersToggleListener();

      // Listen for ModernUI filter changes
      document.addEventListener(
        "filtersApplied",
        this.handleModernUIFilterChange.bind(this)
      );
    }

    /**
     * Handle filter changes from ModernUI
     * @param {CustomEvent} e - Filter change event
     */
    handleModernUIFilterChange(e) {
      const { startDate, endDate } = e.detail || {};

      if (startDate && this.elements.startDateInput) {
        this.elements.startDateInput.value = startDate;
      }

      if (endDate && this.elements.endDateInput) {
        this.elements.endDateInput.value = endDate;
      }
    }

    /**
     * Setup sidebar toggle button listeners
     */
    setupToggleListeners() {
      const toggleButtons = [
        this.elements.toggleButton,
        this.elements.collapseButton,
      ].filter(Boolean);

      toggleButtons.forEach((button) => {
        button?.addEventListener("click", (e) => {
          e.preventDefault();
          this.toggleSidebar();
        });
      });
    }

    /**
     * Setup date input listeners
     */
    setupDateInputListeners() {
      const dateInputs = [
        this.elements.startDateInput,
        this.elements.endDateInput,
      ].filter(Boolean);

      dateInputs.forEach((input) => {
        input?.addEventListener("change", (e) => {
          const key = e.target.id.includes("start") ? "startDate" : "endDate";
          this.safelyStoreItem(this.config.storageKeys[key], e.target.value);

          // Trigger an event for ModernUI to detect
          document.dispatchEvent(
            new CustomEvent("sidebarDateChanged", {
              detail: {
                startDate: this.elements.startDateInput?.value,
                endDate: this.elements.endDateInput?.value,
              },
            })
          );
        });
      });
    }

    /**
     * Setup window-level event listeners
     */
    setupWindowListeners() {
      // Resize event with debounce
      window.addEventListener(
        "resize",
        this.debounce(
          () => this.handleResponsiveLayout(),
          this.config.defaultRefreshInterval
        )
      );

      // Outside click handler to close sidebar on mobile
      document.addEventListener("click", (e) => this.handleOutsideClick(e));
    }

    /**
     * Setup filters toggle listener
     */
    setupFiltersToggleListener() {
      this.elements.filtersToggle?.addEventListener("click", (e) =>
        this.handleFiltersToggle(e)
      );

      // Set up apply filters button
      if (this.elements.applyFiltersBtn) {
        this.elements.applyFiltersBtn.addEventListener("click", (e) =>
          this.handleApplyFilters(e)
        );
      }
    }

    /**
     * Handle click outside the sidebar (for mobile)
     * @param {Event} e - Click event
     */
    handleOutsideClick(e) {
      const { sidebar, toggleButton } = this.elements;

      if (!sidebar) return;

      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const clickedOutside =
        !sidebar.contains(e.target) &&
        toggleButton &&
        !toggleButton.contains(e.target);

      if (isMobile && clickedOutside && sidebar.classList.contains("active")) {
        this.toggleSidebar();
      }
    }

    /**
     * Toggle sidebar visibility state
     */
    toggleSidebar() {
      const { sidebar, toggleButton, body, mainContent } = this.elements;

      if (!sidebar) return;

      const isMobile = window.innerWidth < this.config.mobileBreakpoint;

      if (isMobile) {
        sidebar.classList.toggle("active");
      } else {
        sidebar.classList.toggle("collapsed");
        body.classList.toggle("sidebar-collapsed");
        mainContent?.classList.toggle("expanded");
      }

      if (toggleButton) {
        toggleButton.classList.toggle("active");
        this.updateToggleButtonIcon();
      }

      this.storeSidebarState();
    }

    /**
     * Update toggle button icon based on sidebar state
     */
    updateToggleButtonIcon() {
      if (!this.elements.toggleButton) return;

      const icon = this.elements.toggleButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-bars");
        icon.classList.toggle("fa-times");
      }
    }

    /**
     * Store sidebar state in localStorage
     */
    storeSidebarState() {
      if (!this.elements.sidebar) return;

      const isCollapsed = this.elements.sidebar.classList.contains("collapsed");
      this.safelyStoreItem(this.config.storageKeys.sidebarState, isCollapsed);
    }

    /**
     * Load sidebar state from localStorage
     */
    loadSidebarState() {
      try {
        if (!this.elements.sidebar) return;

        const isCollapsed =
          this.safelyGetItem(this.config.storageKeys.sidebarState) === "true";

        if (isCollapsed && window.innerWidth >= this.config.mobileBreakpoint) {
          const { body, sidebar, toggleButton, mainContent } = this.elements;

          body.classList.add("sidebar-collapsed");
          sidebar.classList.add("collapsed");

          if (toggleButton) toggleButton.classList.add("active");
          if (mainContent) mainContent.classList.add("expanded");
        }
      } catch (error) {
        console.warn("Failed to load sidebar state:", error);
      }
    }

    /**
     * Load stored dates from localStorage
     */
    loadStoredDates() {
      ["startDate", "endDate"].forEach((key) => {
        try {
          const stored = this.safelyGetItem(this.config.storageKeys[key]);
          const inputId = key.toLowerCase().replace("date", "-date");
          const input = document.getElementById(inputId);

          if (stored && input) {
            input.value = stored;
          }
        } catch (error) {
          console.warn(`Failed to load stored ${key}:`, error);
        }
      });
    }

    /**
     * Handle responsive layout changes
     */
    handleResponsiveLayout() {
      if (!this.elements.sidebar) return;

      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const { sidebar, body, mainContent } = this.elements;

      if (isMobile) {
        sidebar.classList.remove("collapsed");
        body.classList.remove("sidebar-collapsed");
        mainContent?.classList.remove("expanded");
      } else {
        const isCollapsed =
          this.safelyGetItem(this.config.storageKeys.sidebarState) === "true";

        if (isCollapsed) {
          body.classList.add("sidebar-collapsed");
          sidebar.classList.add("collapsed");
          mainContent?.classList.add("expanded");
        } else {
          body.classList.remove("sidebar-collapsed");
          sidebar.classList.remove("collapsed");
          mainContent?.classList.remove("expanded");
        }
      }
    }

    /**
     * Handle filters toggle click
     * @param {Event} e - Click event
     */
    handleFiltersToggle(e) {
      if (!e.currentTarget) return;

      const collapsed = e.currentTarget.classList.toggle("collapsed");
      this.safelyStoreItem(this.config.storageKeys.filtersCollapsed, collapsed);
    }

    /**
     * Load filters state from localStorage
     */
    loadFiltersState() {
      try {
        if (!this.elements.filtersToggle) return;

        const isCollapsed =
          this.safelyGetItem(this.config.storageKeys.filtersCollapsed) ===
          "true";

        if (isCollapsed) {
          this.elements.filtersToggle.classList.add("collapsed");
          const filtersContent = document.getElementById("filters-content");
          if (filtersContent) {
            filtersContent.classList.remove("show");
          }
        }
      } catch (error) {
        console.warn("Failed to load filters state:", error);
      }
    }

    /**
     * Highlight current page in sidebar navigation
     */
    highlightCurrentPage() {
      if (!this.elements.sidebar) return;

      const currentPath = window.location.pathname;
      const navLinks = this.elements.sidebar.querySelectorAll(".nav-link");

      navLinks.forEach((link) => {
        if (link.getAttribute("href") === currentPath) {
          link.classList.add("active");
        }
      });
    }

    /**
     * Initialize scroll indicator for sidebar
     */
    initializeScrollIndicator() {
      const { sidebarBody } = this.elements;

      if (sidebarBody) {
        sidebarBody.addEventListener("scroll", (e) =>
          this.handleScrollIndicator(e)
        );
        this.handleScrollIndicator({ target: sidebarBody });
      }
    }

    /**
     * Handle sidebar scroll indicator
     * @param {Event} e - Scroll event
     */
    handleScrollIndicator(e) {
      const el = e.target;
      const isScrollable = el.scrollHeight > el.clientHeight;
      const atBottom =
        Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 1;

      el.classList.toggle("is-scrollable", isScrollable && !atBottom);
    }

    /**
     * Initialize keyboard navigation for sidebar
     */
    initializeKeyboardNavigation() {
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key === "b") {
          e.preventDefault();
          this.toggleSidebar();
        }
      });
    }

    /**
     * Handle apply filters button click
     * @param {Event} e - Click event
     */
    handleApplyFilters(e) {
      if (e) e.preventDefault();

      this.setButtonLoading("apply-filters", true);

      try {
        const startDate = this.elements.startDateInput?.value;
        const endDate = this.elements.endDateInput?.value;

        if (startDate)
          this.safelyStoreItem(this.config.storageKeys.startDate, startDate);
        if (endDate)
          this.safelyStoreItem(this.config.storageKeys.endDate, endDate);

        // Trigger the global event for updating data - compatible with ModernUI
        document.dispatchEvent(
          new CustomEvent("filtersApplied", {
            detail: { startDate, endDate },
          })
        );
      } catch (error) {
        console.error("Error applying filters:", error);
      } finally {
        // Reset button state after a short delay
        setTimeout(() => this.setButtonLoading("apply-filters", false), 500);
      }
    }

    /**
     * Set a button to loading state
     * @param {string} buttonId - Button ID
     * @param {boolean} isLoading - Whether button is in loading state
     */
    setButtonLoading(buttonId, isLoading) {
      const button = document.getElementById(buttonId);
      if (!button) return;

      const original = button.innerHTML;

      if (isLoading) {
        button.disabled = true;
        button.innerHTML =
          '<span class="spinner-border spinner-border-sm me-1"></span> Loading...';
        button._originalContent = original;
      } else {
        button.disabled = false;
        button.innerHTML = button._originalContent || original;
      }
    }

    /**
     * Safely store an item in localStorage with error handling
     * @param {string} key - Storage key
     * @param {*} value - Value to store
     */
    safelyStoreItem(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        console.warn(`Failed to store ${key}:`, error);
      }
    }

    /**
     * Safely get an item from localStorage with error handling
     * @param {string} key - Storage key
     * @returns {string|null} Stored value or null
     */
    safelyGetItem(key) {
      try {
        return localStorage.getItem(key);
      } catch (error) {
        console.warn(`Failed to retrieve ${key}:`, error);
        return null;
      }
    }

    /**
     * Debounce a function call
     * @param {Function} func - Function to debounce
     * @param {number} wait - Wait time in ms
     * @returns {Function} Debounced function
     */
    debounce(func, wait) {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    }
  }

  // Initialize sidebar when DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    try {
      window.sidebarManager = new Sidebar();
    } catch (error) {
      console.error("Failed to initialize sidebar:", error);
    }
  });

  // Theme Toggle Functionality - coordinated with ModernUI
  document.addEventListener("DOMContentLoaded", () => {
    try {
      const themeToggle = document.getElementById("theme-toggle-checkbox");

      if (!themeToggle) {
        console.log(
          "Theme toggle not found in sidebar.js. This is normal if using ModernUI."
        );
        return;
      }

      const body = document.body;

      // Check for saved theme preference or prefer-color-scheme
      const savedTheme = localStorage.getItem("theme");
      const prefersDarkScheme = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;

      // Apply saved theme or use system preference
      if (savedTheme === "light") {
        body.classList.add("light-mode");
        themeToggle.checked = true;
      } else if (!savedTheme && !prefersDarkScheme) {
        body.classList.add("light-mode");
        themeToggle.checked = true;
      }

      // Handle theme toggle click
      themeToggle.addEventListener("change", () => {
        if (themeToggle.checked) {
          body.classList.add("light-mode");
          localStorage.setItem("theme", "light");
        } else {
          body.classList.remove("light-mode");
          localStorage.setItem("theme", "dark");
        }

        // Trigger a custom event for other scripts that might need to react to theme changes
        body.dispatchEvent(
          new CustomEvent("themeChanged", {
            detail: { theme: themeToggle.checked ? "light" : "dark" },
          })
        );
      });
    } catch (error) {
      console.warn("Theme toggle initialization error:", error);
    }
  });
})();
