(() => {
  "use strict";

  /**
   * Sidebar class for managing sidebar UI component
   */
  class Sidebar {
    constructor() {
      this.config = {
        mobileBreakpoint: 992,
        storageKeys: {
          sidebarState: "sidebarCollapsed",
          startDate: "startDate",
          endDate: "endDate",
          filtersCollapsed: "filtersCollapsed",
        },
      };

      // Cache DOM elements once
      this.elements = this.getDOMElements();

      // Initialize only if critical elements exist
      if (this.elements.sidebar) {
        this.initializeEventListeners();
        this.loadSavedState();
        this.handleResponsiveLayout();
      }
    }

    /**
     * Get all required DOM elements
     * @returns {Object} DOM elements
     */
    getDOMElements() {
      return {
        sidebar: document.getElementById("sidebar"),
        toggleButton: document.getElementById("sidebar-toggle"),
        collapseButton: document.getElementById("sidebar-collapse"),
        startDateInput: document.getElementById("start-date"),
        endDateInput: document.getElementById("end-date"),
        mainContent: document.querySelector("main"),
        body: document.body,
        filtersToggle: document.getElementById("toggle-filters"),
        filtersContent: document.getElementById("filters-content"),
        applyFiltersBtn: document.getElementById("apply-filters"),
      };
    }

    /**
     * Initialize event listeners
     */
    initializeEventListeners() {
      // Toggle sidebar buttons
      [this.elements.toggleButton, this.elements.collapseButton]
        .filter(Boolean)
        .forEach((btn) =>
          btn?.addEventListener("click", () => this.toggleSidebar())
        );

      // Date inputs
      [this.elements.startDateInput, this.elements.endDateInput]
        .filter(Boolean)
        .forEach((input) => {
          input?.addEventListener("change", (e) => {
            const key = e.target.id.includes("start") ? "startDate" : "endDate";
            localStorage.setItem(this.config.storageKeys[key], e.target.value);
          });
        });

      // Filters toggle
      this.elements.filtersToggle?.addEventListener("click", () => {
        if (this.elements.filtersToggle.classList.toggle("collapsed")) {
          this.elements.filtersContent?.classList.remove("show");
        } else {
          this.elements.filtersContent?.classList.add("show");
        }
        localStorage.setItem(
          this.config.storageKeys.filtersCollapsed,
          this.elements.filtersToggle.classList.contains("collapsed")
        );
      });

      // Apply filters button
      this.elements.applyFiltersBtn?.addEventListener("click", () =>
        this.applyFilters()
      );

      // Date preset buttons
      document.querySelectorAll(".date-preset").forEach((btn) => {
        btn.addEventListener("click", (e) =>
          this.handleDatePreset(e.currentTarget.dataset.range)
        );
      });

      // Responsive behavior
      window.addEventListener(
        "resize",
        this.debounce(() => this.handleResponsiveLayout(), 250)
      );

      // Keyboard shortcut
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key === "b") {
          e.preventDefault();
          this.toggleSidebar();
        }
      });

      // Click outside to close on mobile
      document.addEventListener("click", (e) => {
        const isMobile = window.innerWidth < this.config.mobileBreakpoint;
        const { sidebar, toggleButton } = this.elements;

        if (
          isMobile &&
          sidebar?.classList.contains("active") &&
          !sidebar.contains(e.target) &&
          toggleButton &&
          !toggleButton.contains(e.target)
        ) {
          this.toggleSidebar();
        }
      });
    }

    /**
     * Load saved state from localStorage
     */
    loadSavedState() {
      // Load dates
      const startDate = localStorage.getItem(this.config.storageKeys.startDate);
      const endDate = localStorage.getItem(this.config.storageKeys.endDate);

      if (startDate && this.elements.startDateInput) {
        this.elements.startDateInput.value = startDate;
      }

      if (endDate && this.elements.endDateInput) {
        this.elements.endDateInput.value = endDate;
      }

      // Load sidebar state
      const isCollapsed =
        localStorage.getItem(this.config.storageKeys.sidebarState) === "true";
      if (isCollapsed && window.innerWidth >= this.config.mobileBreakpoint) {
        this.elements.body?.classList.add("sidebar-collapsed");
        this.elements.sidebar?.classList.add("collapsed");
        this.elements.toggleButton?.classList.add("active");
        this.elements.mainContent?.classList.add("expanded");
      }

      // Load filters collapsed state
      const filtersCollapsed =
        localStorage.getItem(this.config.storageKeys.filtersCollapsed) ===
        "true";
      if (filtersCollapsed && this.elements.filtersToggle) {
        this.elements.filtersToggle.classList.add("collapsed");
        this.elements.filtersContent?.classList.remove("show");
      }
    }

    /**
     * Toggle sidebar visibility
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

      // Update toggle button if it exists
      if (toggleButton) {
        toggleButton.classList.toggle("active");
        const icon = toggleButton.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-bars");
          icon.classList.toggle("fa-times");
        }
      }

      // Store state
      localStorage.setItem(
        this.config.storageKeys.sidebarState,
        !isMobile && sidebar.classList.contains("collapsed")
      );
    }

    /**
     * Handle responsive layout adjustments
     */
    handleResponsiveLayout() {
      const { sidebar, body, mainContent } = this.elements;
      if (!sidebar) return;

      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const isCollapsed =
        localStorage.getItem(this.config.storageKeys.sidebarState) === "true";

      if (isMobile) {
        sidebar.classList.remove("collapsed");
        body.classList.remove("sidebar-collapsed");
        mainContent?.classList.remove("expanded");
      } else if (isCollapsed) {
        body.classList.add("sidebar-collapsed");
        sidebar.classList.add("collapsed");
        mainContent?.classList.add("expanded");
      } else {
        body.classList.remove("sidebar-collapsed");
        sidebar.classList.remove("collapsed");
        mainContent?.classList.remove("expanded");
      }
    }

    /**
     * Handle date preset selection
     * @param {string} range - Preset range
     */
    async handleDatePreset(range) {
      if (!range) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let startDate = new Date(today);
      let endDate = new Date(today);

      // Handle different range presets
      switch (range) {
        case "today":
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
        case "last-6-months":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        case "last-year":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        case "all-time":
          try {
            const response = await fetch("/api/first_trip_date");
            if (response.ok) {
              const data = await response.json();
              startDate = new Date(data.first_trip_date);
            } else {
              // Fallback if API fails
              startDate = new Date(2020, 0, 1);
            }
          } catch (error) {
            console.warn("Error fetching first trip date:", error);
            startDate = new Date(2020, 0, 1); // Fallback date
          }
          break;
        default:
          return;
      }

      // Format and update inputs
      const formatDate = (date) => date.toISOString().split("T")[0];
      const startDateStr = formatDate(startDate);
      const endDateStr = formatDate(endDate);

      // Update DOM and storage
      if (this.elements.startDateInput) {
        this.elements.startDateInput.value = startDateStr;
        if (this.elements.startDateInput._flatpickr) {
          this.elements.startDateInput._flatpickr.setDate(startDate);
        }
      }

      if (this.elements.endDateInput) {
        this.elements.endDateInput.value = endDateStr;
        if (this.elements.endDateInput._flatpickr) {
          this.elements.endDateInput._flatpickr.setDate(endDate);
        }
      }

      localStorage.setItem(this.config.storageKeys.startDate, startDateStr);
      localStorage.setItem(this.config.storageKeys.endDate, endDateStr);

      // Apply the filters
      this.applyFilters();
    }

    /**
     * Apply date filters and trigger data refresh
     */
    applyFilters() {
      const { startDateInput, endDateInput, applyFiltersBtn } = this.elements;

      if (applyFiltersBtn) {
        const originalText = applyFiltersBtn.innerHTML;
        applyFiltersBtn.disabled = true;
        applyFiltersBtn.innerHTML =
          '<span class="spinner-border spinner-border-sm"></span> Loading...';

        // Save dates
        if (startDateInput) {
          localStorage.setItem(
            this.config.storageKeys.startDate,
            startDateInput.value
          );
        }

        if (endDateInput) {
          localStorage.setItem(
            this.config.storageKeys.endDate,
            endDateInput.value
          );
        }

        // Dispatch event for components to refresh data
        document.dispatchEvent(
          new CustomEvent("filtersApplied", {
            detail: {
              startDate: startDateInput?.value,
              endDate: endDateInput?.value,
            },
          })
        );

        // Reset button state
        setTimeout(() => {
          applyFiltersBtn.disabled = false;
          applyFiltersBtn.innerHTML = originalText;
        }, 500);
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

  // Initialize sidebar on DOM content loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.sidebarManager = new Sidebar();
  });

  // Theme toggle functionality
  document.addEventListener("DOMContentLoaded", () => {
    const themeToggle = document.getElementById("theme-toggle-checkbox");
    if (!themeToggle) return;

    // Load saved theme
    const savedTheme = localStorage.getItem("theme");
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
        localStorage.setItem("theme", "light");
      } else {
        document.body.classList.remove("light-mode");
        localStorage.setItem("theme", "dark");
      }

      // Trigger theme change event
      document.dispatchEvent(
        new CustomEvent("themeChanged", {
          detail: { theme: themeToggle.checked ? "light" : "dark" },
        })
      );
    });
  });
})();
