/**
 * Modern UI JavaScript
 * Handles all UI interactions for the redesigned interface
 */

document.addEventListener("DOMContentLoaded", () => {
  // Initialize all UI components
  ModernUI.init();
});

const ModernUI = {
  /**
   * Initialize all UI components
   */
  init() {
    try {
      this.initThemeToggle();
      this.initMobileDrawer();
      this.initFilterPanel();
      this.initFloatingActionButton();
      this.initTooltips();
      this.initScrollEffects();
      this.initNotifications();

      // Listen for window resize events
      window.addEventListener("resize", this.handleResize.bind(this));

      // Initial resize handler call to set proper states
      this.handleResize();

      // Add bridge between Modern UI and legacy code
      this.setupLegacyCodeBridge();

      console.log("Modern UI initialized");
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
    }
  },

  /**
   * Initialize theme toggle
   */
  initThemeToggle() {
    const themeToggle = document.getElementById("theme-toggle-checkbox");
    if (!themeToggle) return;

    // Check for saved theme preference or prefer-color-scheme
    const savedTheme = localStorage.getItem("theme");
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;

    // Apply saved theme or use system preference
    if (savedTheme === "light" || (!savedTheme && !prefersDarkScheme)) {
      document.body.classList.add("light-mode");
      document.documentElement.setAttribute("data-bs-theme", "light");
      themeToggle.checked = true;
      this.updateMapTheme("light");
    } else {
      document.body.classList.remove("light-mode");
      document.documentElement.setAttribute("data-bs-theme", "dark");
      themeToggle.checked = false;
      this.updateMapTheme("dark");
    }

    // Handle theme toggle change
    themeToggle.addEventListener("change", () => {
      if (themeToggle.checked) {
        document.body.classList.add("light-mode");
        document.documentElement.setAttribute("data-bs-theme", "light");
        localStorage.setItem("theme", "light");
        this.updateMapTheme("light");
      } else {
        document.body.classList.remove("light-mode");
        document.documentElement.setAttribute("data-bs-theme", "dark");
        localStorage.setItem("theme", "dark");
        this.updateMapTheme("dark");
      }

      // Dispatch theme change event for other scripts
      document.dispatchEvent(
        new CustomEvent("themeChanged", {
          detail: { theme: themeToggle.checked ? "light" : "dark" },
        })
      );
    });
  },

  /**
   * Update map theme if map exists
   * @param {string} theme - Theme name ('light' or 'dark')
   */
  updateMapTheme(theme) {
    if (window.map) {
      // Update container background
      document.querySelectorAll(".leaflet-container").forEach((container) => {
        container.style.background = theme === "light" ? "#e0e0e0" : "#1a1a1a";
      });

      // Remove existing tile layers
      window.map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
          window.map.removeLayer(layer);
        }
      });

      // Add new tile layer based on theme
      const tileUrl =
        theme === "light"
          ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

      L.tileLayer(tileUrl, {
        maxZoom: 19,
        attribution: "",
      }).addTo(window.map);

      // Refresh map size to fix display issues
      window.map.invalidateSize();

      // Dispatch map theme change event for other scripts
      document.dispatchEvent(
        new CustomEvent("mapThemeChanged", {
          detail: { theme },
        })
      );
    }
  },

  /**
   * Initialize mobile navigation drawer
   */
  initMobileDrawer() {
    const mobileDrawer = document.getElementById("mobile-nav-drawer");
    const menuToggle = document.getElementById("menu-toggle");
    const closeBtn = document.querySelector(".drawer-close-btn");
    const contentOverlay = document.getElementById("content-overlay");

    if (!mobileDrawer || !menuToggle) return;

    // Open drawer
    menuToggle.addEventListener("click", () => {
      mobileDrawer.classList.add("open");
      contentOverlay.classList.add("visible");
      document.body.style.overflow = "hidden";
    });

    // Close drawer function
    const closeDrawer = () => {
      mobileDrawer.classList.remove("open");
      contentOverlay.classList.remove("visible");
      document.body.style.overflow = "";
    };

    // Close drawer with button
    closeBtn?.addEventListener("click", closeDrawer);

    // Close drawer with overlay
    contentOverlay?.addEventListener("click", closeDrawer);

    // Close drawer with Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mobileDrawer.classList.contains("open")) {
        closeDrawer();
      }
    });
  },

  /**
   * Initialize filters panel
   */
  initFilterPanel() {
    const filtersToggle = document.getElementById("filters-toggle");
    const filtersPanel = document.getElementById("filters-panel");
    const contentOverlay = document.getElementById("content-overlay");
    const panelCloseBtn = filtersPanel?.querySelector(".panel-close-btn");
    const applyFiltersBtn = document.getElementById("apply-filters");
    const resetFiltersBtn = document.getElementById("reset-filters");
    const startDateInput = document.getElementById("start-date");
    const endDateInput = document.getElementById("end-date");
    const quickSelectBtns = document.querySelectorAll(".quick-select-btn");

    // Add current filter indicator to the header
    this.addFilterIndicator();

    // Initialize flatpickr date pickers
    if (window.flatpickr && startDateInput && endDateInput) {
      const dateConfig = {
        dateFormat: "Y-m-d",
        maxDate: "today",
        disableMobile: true,
        theme: document.body.classList.contains("light-mode")
          ? "light"
          : "dark",
      };

      window.flatpickr(startDateInput, dateConfig);
      window.flatpickr(endDateInput, dateConfig);

      // Initialize with stored values or defaults
      const today = new Date().toISOString().split("T")[0];
      startDateInput.value = localStorage.getItem("startDate") || today;
      endDateInput.value = localStorage.getItem("endDate") || today;
    }

    if (filtersToggle && filtersPanel) {
      filtersToggle.addEventListener("click", () => {
        filtersPanel.classList.toggle("open");
        contentOverlay.classList.toggle("visible");

        // Update the current date range in the panel
        this.updateFilterIndicator();
      });
    }

    if (panelCloseBtn) {
      panelCloseBtn.addEventListener("click", () => {
        filtersPanel.classList.remove("open");
        contentOverlay.classList.remove("visible");
      });
    }

    if (contentOverlay) {
      contentOverlay.addEventListener("click", () => {
        filtersPanel.classList.remove("open");
        contentOverlay.classList.remove("visible");
      });
    }

    // Handle quick select buttons
    quickSelectBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const range = btn.dataset.range;
        if (!range) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let startDate = new Date(today);
        let endDate = new Date(today);

        switch (range) {
          case "today":
            // Keep as is
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
          case "last-year":
            startDate.setFullYear(startDate.getFullYear() - 1);
            break;
          case "all-time":
            // This would need to fetch the first trip date from API
            // For now, just set a very old date
            startDate = new Date(2010, 0, 1);
            break;
        }

        // Format dates as YYYY-MM-DD
        const formatDate = (date) => date.toISOString().split("T")[0];

        // Update inputs
        if (startDateInput) startDateInput._flatpickr.setDate(startDate);
        if (endDateInput) endDateInput._flatpickr.setDate(endDate);

        // Highlight the active button
        quickSelectBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    // Apply filters button
    if (applyFiltersBtn) {
      applyFiltersBtn.addEventListener("click", () => {
        if (startDateInput && endDateInput) {
          localStorage.setItem("startDate", startDateInput.value);
          localStorage.setItem("endDate", endDateInput.value);

          // Update the filter indicator
          this.updateFilterIndicator();

          // Close the panel
          filtersPanel.classList.remove("open");
          contentOverlay.classList.remove("visible");

          // Trigger fetch trips event
          document.dispatchEvent(
            new CustomEvent("filtersApplied", {
              detail: {
                startDate: startDateInput.value,
                endDate: endDateInput.value,
              },
            })
          );

          // Show notification
          this.showNotification({
            title: "Filters Applied",
            message: `Date range: ${startDateInput.value} to ${endDateInput.value}`,
            type: "success",
            duration: 3000,
          });
        }
      });
    }

    // Reset filters button
    if (resetFiltersBtn) {
      resetFiltersBtn.addEventListener("click", () => {
        const today = new Date().toISOString().split("T")[0];

        if (startDateInput) startDateInput._flatpickr.setDate(today);
        if (endDateInput) endDateInput._flatpickr.setDate(today);

        // Remove active class from quick select buttons
        quickSelectBtns.forEach((btn) => btn.classList.remove("active"));

        // Show notification
        this.showNotification({
          title: "Filters Reset",
          message: "Date filters have been reset to today",
          type: "info",
          duration: 3000,
        });
      });
    }
  },

  /**
   * Add a persistent filter indicator to the header
   */
  addFilterIndicator() {
    // Find the tools section in the header
    const toolsSection = document.querySelector(".tools-section");
    if (!toolsSection) return;

    // Create the filter indicator
    const indicator = document.createElement("div");
    indicator.className = "filter-indicator";
    indicator.id = "filter-indicator";
    indicator.setAttribute("title", "Current date range filter");
    indicator.innerHTML = `
      <i class="fas fa-calendar-alt"></i>
      <span class="filter-date-range">Today</span>
    `;

    // Insert before the filters toggle
    const filtersToggle = document.getElementById("filters-toggle");
    if (filtersToggle) {
      toolsSection.insertBefore(indicator, filtersToggle);
    } else {
      toolsSection.appendChild(indicator);
    }

    // Add click event to open filters panel
    indicator.addEventListener("click", () => {
      const filtersPanel = document.getElementById("filters-panel");
      const contentOverlay = document.getElementById("content-overlay");

      if (filtersPanel && contentOverlay) {
        filtersPanel.classList.add("open");
        contentOverlay.classList.add("visible");
      }
    });

    // Initial update
    this.updateFilterIndicator();

    // Add styles for the filter indicator
    const style = document.createElement("style");
    style.textContent = `
      .filter-indicator {
        display: flex;
        align-items: center;
        padding: 0 var(--space-3);
        height: 32px;
        background-color: var(--surface-2);
        border-radius: var(--radius-md);
        margin-right: var(--space-2);
        cursor: pointer;
        transition: all var(--transition-fast);
        font-size: var(--font-size-sm);
        color: var(--text-secondary);
      }
      
      body.light-mode .filter-indicator {
        background-color: var(--light-surface-2);
        color: var(--light-text-secondary);
      }
      
      .filter-indicator:hover {
        background-color: var(--surface-3);
      }
      
      body.light-mode .filter-indicator:hover {
        background-color: var(--light-surface-3);
      }
      
      .filter-indicator i {
        margin-right: var(--space-2);
        color: var(--primary);
      }
      
      .filter-date-range {
        max-width: 150px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      @media (max-width: 576px) {
        .filter-indicator .filter-date-range {
          display: none;
        }
        
        .filter-indicator {
          padding: 0;
          width: 32px;
          justify-content: center;
        }
        
        .filter-indicator i {
          margin-right: 0;
        }
      }
    `;
    document.head.appendChild(style);
  },

  /**
   * Update the filter indicator with current date range
   */
  updateFilterIndicator() {
    const indicator = document.getElementById("filter-indicator");
    if (!indicator) return;

    const rangeSpan = indicator.querySelector(".filter-date-range");
    if (!rangeSpan) return;

    const startDate = localStorage.getItem("startDate");
    const endDate = localStorage.getItem("endDate");

    if (!startDate || !endDate) {
      rangeSpan.textContent = "Today";
      return;
    }

    // Format dates for display
    const formatDisplayDate = (dateStr) => {
      const date = new Date(dateStr);
      return date.toLocaleDateString();
    };

    // Set the text
    rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
  },

  /**
   * Initialize floating action button
   */
  initFloatingActionButton() {
    const actionButton = document.getElementById("action-button");
    const actionMenu = document.getElementById("action-menu");
    const actionItems = document.querySelectorAll(".action-menu-item");

    if (!actionButton || !actionMenu) return;

    // Toggle action menu
    actionButton.addEventListener("click", () => {
      actionMenu.classList.toggle("open");
      actionButton.classList.toggle("active");

      // Toggle icon between plus and times
      const icon = actionButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-plus");
        icon.classList.toggle("fa-times");
      }
    });

    // Handle action menu item clicks
    actionItems.forEach((item) => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;

        // Close menu
        actionMenu.classList.remove("open");
        actionButton.classList.remove("active");

        // Reset icon
        const icon = actionButton.querySelector("i");
        if (icon) {
          icon.classList.add("fa-plus");
          icon.classList.remove("fa-times");
        }

        // Handle different actions
        switch (action) {
          case "fetch-trips":
            this.handleFetchTrips();
            break;
          case "map-match":
            this.handleMapMatch();
            break;
          case "new-place":
            this.handleAddPlace();
            break;
          default:
            break;
        }
      });
    });

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (
        !actionButton.contains(e.target) &&
        !actionMenu.contains(e.target) &&
        actionMenu.classList.contains("open")
      ) {
        actionMenu.classList.remove("open");
        actionButton.classList.remove("active");

        // Reset icon
        const icon = actionButton.querySelector("i");
        if (icon) {
          icon.classList.add("fa-plus");
          icon.classList.remove("fa-times");
        }
      }
    });
  },

  /**
   * Initialize tooltips
   */
  initTooltips() {
    const tooltipTriggerList = document.querySelectorAll(
      '[data-bs-toggle="tooltip"]'
    );
    if (tooltipTriggerList.length > 0 && window.bootstrap?.Tooltip) {
      tooltipTriggerList.forEach((el) => new bootstrap.Tooltip(el));
    }
  },

  /**
   * Initialize scroll effects
   */
  initScrollEffects() {
    const header = document.querySelector(".app-header");

    if (!header) return;

    // Add shadow to header on scroll
    window.addEventListener("scroll", () => {
      if (window.scrollY > 10) {
        header.classList.add("scrolled");
      } else {
        header.classList.remove("scrolled");
      }
    });

    // Initial check
    if (window.scrollY > 10) {
      header.classList.add("scrolled");
    }
  },

  /**
   * Initialize notifications system
   */
  initNotifications() {
    // Find existing notifications and add close handlers
    const notifications = document.querySelectorAll(".notification");
    notifications.forEach((notification) => {
      const closeBtn = notification.querySelector(".notification-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          this.removeNotification(notification);
        });
      }
    });

    // Set up event listener for custom notification events
    document.addEventListener("showNotification", (e) => {
      if (e.detail) {
        this.showNotification(e.detail);
      }
    });

    // Clean up any existing bootstrap alerts for compatibility
    const bootstrapAlerts = document.querySelectorAll(".alert");
    bootstrapAlerts.forEach((alert) => {
      const closeBtn = alert.querySelector(".btn-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          alert.classList.remove("show");
          setTimeout(() => {
            alert.remove();
          }, 300);
        });
      }
    });
  },

  /**
   * Show notification
   * @param {Object} options - Notification options
   * @param {string} options.title - Notification title
   * @param {string} options.message - Notification message
   * @param {string} options.type - Notification type (success, error, warning, info)
   * @param {number} options.duration - Duration in ms (default: 5000)
   */
  showNotification({ title, message, type = "info", duration = 5000 }) {
    // Find notification container or create it
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
      default:
        icon = "info-circle";
    }

    // Set notification content
    notification.innerHTML = `
      <div class="notification-icon">
        <i class="fas fa-${icon}"></i>
      </div>
      <div class="notification-content">
        <div class="notification-title">${title}</div>
        <div class="notification-message">${message}</div>
      </div>
      <button type="button" class="notification-close">
        <i class="fas fa-times"></i>
      </button>
    `;

    // Add notification to container
    container.appendChild(notification);

    // Show notification (add with delay to trigger animation)
    setTimeout(() => {
      notification.classList.add("show");
    }, 10);

    // Attach close button handler
    const closeBtn = notification.querySelector(".notification-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        this.removeNotification(notification);
      });
    }

    // Auto remove after duration
    setTimeout(() => {
      this.removeNotification(notification);
    }, duration);

    return notification;
  },

  /**
   * Remove notification with animation
   * @param {HTMLElement} notification - Notification element
   */
  removeNotification(notification) {
    notification.classList.remove("show");

    // Remove after animation completes
    setTimeout(() => {
      notification.remove();
    }, 300);
  },

  /**
   * Show loading overlay
   * @param {string} message - Loading message
   */
  showLoading(message = "Loading...") {
    const loadingOverlay = document.querySelector(".loading-overlay");
    if (!loadingOverlay) return;

    // Set loading message
    const loadingText = loadingOverlay.querySelector(".loading-text");
    if (loadingText) {
      loadingText.textContent = message;
    }

    // Reset progress bar
    const progressBar = loadingOverlay.querySelector(".progress-bar");
    if (progressBar) {
      progressBar.style.width = "0%";
    }

    // Show loading overlay
    loadingOverlay.style.display = "flex";

    // Simulate progress (replace with actual progress updates)
    this.simulateLoadingProgress();
  },

  /**
   * Hide loading overlay
   */
  hideLoading() {
    const loadingOverlay = document.querySelector(".loading-overlay");
    if (!loadingOverlay) return;

    // Finish progress animation
    const progressBar = loadingOverlay.querySelector(".progress-bar");
    if (progressBar) {
      progressBar.style.width = "100%";
    }

    // Hide with small delay for smooth animation
    setTimeout(() => {
      loadingOverlay.style.display = "none";
    }, 400);

    // Clear any progress simulation
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
  },

  /**
   * Simulate loading progress
   */
  simulateLoadingProgress() {
    const progressBar = document.querySelector(
      ".loading-overlay .progress-bar"
    );
    if (!progressBar) return;

    // Clear any existing interval
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
    }

    let progress = 0;

    // Update progress bar every 100ms
    this.loadingInterval = setInterval(() => {
      // Increment progress
      progress += Math.random() * 3;

      // Cap at 95% (100% will be set when actually complete)
      if (progress > 95) {
        progress = 95;
        clearInterval(this.loadingInterval);
        this.loadingInterval = null;
      }

      // Update progress bar
      progressBar.style.width = `${progress}%`;
    }, 100);
  },

  /**
   * Handle window resize
   */
  handleResize() {
    // Close mobile drawer on larger screens
    if (window.innerWidth >= 768) {
      const mobileDrawer = document.getElementById("mobile-nav-drawer");
      const contentOverlay = document.getElementById("content-overlay");

      if (mobileDrawer?.classList.contains("open")) {
        mobileDrawer.classList.remove("open");
        contentOverlay?.classList.remove("visible");
        document.body.style.overflow = "";
      }
    }
  },

  /**
   * Handle fetch trips action
   */
  async handleFetchTrips() {
    const notification = notificationManager.show(
      "Fetching new trips...",
      "info",
      0
    );
    loadingManager.startOperation("fetchTrips");

    try {
      // Use the endpoint that only fetches trips since the last one
      const response = await fetch("/api/trips/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json();
      notificationManager.update(
        notification,
        data.message || "New trips fetched successfully!",
        "success",
        3000
      );

      // Reload trips data
      if (typeof fetchTrips === "function") {
        await fetchTrips();
      }

      return data;
    } catch (error) {
      notificationManager.update(
        notification,
        `Error fetching trips: ${error.message}`,
        "danger",
        5000
      );
      throw error;
    } finally {
      loadingManager.finish("fetchTrips");
    }
  },

  /**
   * Handle map match action
   */
  handleMapMatch() {
    this.showLoading("Map matching trips...");

    // Get date range from localStorage or use current date
    const startDate =
      localStorage.getItem("startDate") ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem("endDate") || new Date().toISOString().split("T")[0];

    // Create request data
    const requestData = {
      start_date: startDate,
      end_date: endDate,
      force_rematch: false,
    };

    // Track the loading operation
    const opId = window.loadingManager
      ? window.loadingManager.startOperation("mapMatching", 100)
      : null;

    // Call the API
    fetch("/api/trips/map_match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestData),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        // Update the loading manager
        if (opId && window.loadingManager) {
          window.loadingManager.finish(opId);
        }

        // Hide loading overlay
        this.hideLoading();

        // Show notification with actual data
        this.showNotification({
          title: "Map Matching Complete",
          message: `Successfully matched ${data.matched_count || 0} trips to the road network.`,
          type: "success",
          duration: 5000,
        });

        // Reload the map data if map exists
        if (window.map && typeof window.refreshMapData === "function") {
          window.refreshMapData();
        }

        // Update trip statistics if the function exists
        if (typeof window.updateTripStatistics === "function") {
          window.updateTripStatistics();
        }
      })
      .catch((error) => {
        console.error("Error map matching trips:", error);

        // Hide loading and show error notification
        if (opId && window.loadingManager) {
          window.loadingManager.finish(opId);
        }
        this.hideLoading();

        this.showNotification({
          title: "Error Map Matching",
          message: `There was an error: ${error.message}`,
          type: "error",
          duration: 8000,
        });
      });
  },

  /**
   * Handle add place action
   */
  handleAddPlace() {
    // First check if the CustomPlacesManager is available
    if (window.customPlaces) {
      // If the app has 'start-drawing' button, use that workflow
      const startDrawingBtn = document.getElementById("start-drawing");
      if (startDrawingBtn) {
        startDrawingBtn.click();

        // Show a notification with instructions
        this.showNotification({
          title: "Draw Mode Activated",
          message: "Draw a polygon on the map to create a new place",
          type: "info",
          duration: 5000,
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

    // If customPlaces manager isn't available or if we're on a different page,
    // fall back to our own simple modal
    this.createSimplePlaceModal();
  },

  /**
   * Create a simple modal for adding places
   */
  createSimplePlaceModal() {
    // Check if modal already exists
    if (document.getElementById("add-place-modal")) {
      return this.showAddPlaceModal();
    }

    // Create modal HTML
    const modalHTML = `
      <div class="modal fade" id="add-place-modal" tabindex="-1" aria-labelledby="add-place-modal-label" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="add-place-modal-label">Add New Place</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <form id="add-place-form">
                <div class="mb-3">
                  <label for="place-name" class="form-label">Place Name</label>
                  <input type="text" class="form-control" id="place-name" required>
                </div>
                <div class="mb-3">
                  <label for="place-lat" class="form-label">Latitude</label>
                  <input type="number" step="any" class="form-control" id="place-lat" required>
                </div>
                <div class="mb-3">
                  <label for="place-lng" class="form-label">Longitude</label>
                  <input type="number" step="any" class="form-control" id="place-lng" required>
                </div>
                <div class="mb-3">
                  <label for="place-radius" class="form-label">Radius (meters)</label>
                  <input type="number" min="1" step="1" class="form-control" id="place-radius" value="100">
                </div>
                <div class="mb-3">
                  <label for="place-type" class="form-label">Place Type</label>
                  <select class="form-select" id="place-type">
                    <option value="custom">Custom</option>
                    <option value="home">Home</option>
                    <option value="work">Work</option>
                    <option value="poi">Point of Interest</option>
                  </select>
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" id="save-place-btn">Save Place</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Add modal to body
    const modalContainer = document.createElement("div");
    modalContainer.innerHTML = modalHTML;
    document.body.appendChild(modalContainer);

    // Set up event handlers
    document.getElementById("save-place-btn").addEventListener("click", () => {
      this.submitPlace();
    });

    // Initialize modal
    this.showAddPlaceModal();
  },

  /**
   * Show the add place modal
   */
  showAddPlaceModal() {
    const modal = document.getElementById("add-place-modal");
    if (modal && window.bootstrap?.Modal) {
      const modalInstance = new bootstrap.Modal(modal);
      modalInstance.show();

      // Initialize with map center if available
      if (window.map) {
        const center = window.map.getCenter();
        document.getElementById("place-lat").value = center.lat.toFixed(6);
        document.getElementById("place-lng").value = center.lng.toFixed(6);
      }
    } else {
      // Fallback if modal doesn't work
      this.handleAddPlaceFallback();
    }
  },

  /**
   * Fallback for adding a place without modal
   */
  handleAddPlaceFallback() {
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
      this.showNotification({
        title: "Invalid Coordinates",
        message: "Please enter valid latitude and longitude values.",
        type: "error",
      });
      return;
    }

    this.submitPlaceData({
      name: placeName,
      latitude: lat,
      longitude: lng,
      radius: 100,
      type: "custom",
    });
  },

  /**
   * Submit place form
   */
  submitPlace() {
    const form = document.getElementById("add-place-form");

    // Get form values
    const name = document.getElementById("place-name").value;
    const lat = parseFloat(document.getElementById("place-lat").value);
    const lng = parseFloat(document.getElementById("place-lng").value);
    const radius =
      parseInt(document.getElementById("place-radius").value) || 100;
    const type = document.getElementById("place-type").value;

    // Validate inputs
    if (!name || isNaN(lat) || isNaN(lng)) {
      this.showNotification({
        title: "Invalid Input",
        message: "Please fill in all required fields with valid values.",
        type: "error",
      });
      return;
    }

    // Hide modal
    if (window.bootstrap?.Modal) {
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("add-place-modal")
      );
      if (modal) modal.hide();
    }

    // Submit the data
    this.submitPlaceData({
      name,
      latitude: lat,
      longitude: lng,
      radius,
      type,
    });
  },

  /**
   * Submit place data to API
   */
  submitPlaceData(placeData) {
    // Call the API
    this.showLoading("Adding place...");

    fetch("/api/places/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(placeData),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        this.hideLoading();

        this.showNotification({
          title: "Place Added",
          message: `Successfully added place: ${placeData.name}`,
          type: "success",
        });

        // Refresh the places list or map if needed
        if (typeof window.refreshPlaces === "function") {
          window.refreshPlaces();
        } else if (window.map) {
          // If no refresh function exists but map does, add a marker
          const marker = L.marker([placeData.latitude, placeData.longitude])
            .addTo(window.map)
            .bindPopup(`<strong>${placeData.name}</strong><br>New place added`)
            .openPopup();
        }
      })
      .catch((error) => {
        console.error("Error adding place:", error);

        this.hideLoading();

        this.showNotification({
          title: "Error Adding Place",
          message: `There was an error: ${error.message}`,
          type: "error",
        });
      });
  },

  /**
   * Update progress in the loading overlay
   * @param {number} percent - Progress percentage (0-100)
   * @param {string} message - Optional message to display
   */
  updateProgress(percent, message) {
    const progressBar = document.querySelector(
      ".loading-overlay .progress-bar"
    );
    if (progressBar) {
      progressBar.style.width = `${percent}%`;
    }

    const loadingText = document.querySelector(
      ".loading-overlay .loading-text"
    );
    if (loadingText && message) {
      loadingText.textContent = message;
    }
  },

  /**
   * Setup bridge between Modern UI filters and legacy code
   */
  setupLegacyCodeBridge() {
    // Listen for filter application
    document.addEventListener("filtersApplied", (e) => {
      const { startDate, endDate } = e.detail;

      console.log("Filters applied, triggering fetch trips");

      // Check if app.js fetchTrips function exists
      if (typeof fetchTrips === "function") {
        // Call it directly
        fetchTrips();
      } else {
        // Try to find it in the global scope or as a property of window
        if (window.fetchTrips) {
          window.fetchTrips();
        } else {
          // As a last resort, trigger a click on any "apply-filters" button that might exist
          const applyFiltersBtn = document.getElementById("apply-filters");
          if (
            applyFiltersBtn &&
            applyFiltersBtn !==
              document.querySelector(".filters-panel #apply-filters")
          ) {
            applyFiltersBtn.click();
          }
        }
      }
    });

    // Listen for map theme changes to update map
    document.addEventListener("themeChanged", (e) => {
      console.log("Theme changed, updating map theme");

      // Check if app.js updateMapTheme function exists
      if (typeof updateMapTheme === "function") {
        updateMapTheme(e.detail.theme);
      } else if (window.updateMapTheme) {
        window.updateMapTheme(e.detail.theme);
      }
    });

    // Expose key methods to global scope for legacy code to call
    window.modernUI = {
      showNotification: this.showNotification.bind(this),
      showLoading: this.showLoading.bind(this),
      updateProgress: this.updateProgress.bind(this),
      hideLoading: this.hideLoading.bind(this),
      updateFilterIndicator: this.updateFilterIndicator.bind(this),
    };
  },
};

// Backward compatibility layer for loadingManager reference
window.loadingManager = {
  // Basic loading operations
  showLoading: (message, options) => {
    ModernUI.showLoading(message);
  },
  updateProgress: (percent, message) => {
    ModernUI.updateProgress(percent, message);
  },
  hideLoading: () => {
    ModernUI.hideLoading();
  },

  // Operations tracking system (compatibility with app.js)
  operations: new Map(),

  // Start a new operation
  startOperation: (operationName, totalSteps = 100) => {
    console.log(`Starting operation: ${operationName}`);
    window.loadingManager.operations.set(operationName, {
      name: operationName,
      totalSteps,
      currentStep: 0,
      subOperations: new Map(),
      message: `Starting ${operationName}...`,
    });

    ModernUI.showLoading(`Starting ${operationName}...`);
    return operationName;
  },

  // Add a sub-operation to a parent operation
  addSubOperation: (parentOperation, subOperationName, weight = 1) => {
    const operation = window.loadingManager.operations.get(parentOperation);
    if (!operation) return;

    operation.subOperations.set(subOperationName, {
      name: subOperationName,
      weight,
      progress: 0,
      message: `Starting ${subOperationName}...`,
    });

    console.log(
      `Added sub-operation ${subOperationName} to ${parentOperation}`
    );
  },

  // Update a sub-operation's progress
  updateSubOperation: (
    parentOperation,
    subOperationName,
    progress,
    message
  ) => {
    const operation = window.loadingManager.operations.get(parentOperation);
    if (!operation || !operation.subOperations.has(subOperationName)) return;

    const subOp = operation.subOperations.get(subOperationName);
    subOp.progress = progress;
    if (message) subOp.message = message;

    // Calculate overall progress
    let totalWeight = 0;
    let totalProgress = 0;

    operation.subOperations.forEach((sub) => {
      totalWeight += sub.weight;
      totalProgress += sub.progress * sub.weight;
    });

    const overallProgress = totalWeight > 0 ? totalProgress / totalWeight : 0;

    // Update the UI
    ModernUI.updateProgress(overallProgress, message || subOp.message);
  },

  // Mark an operation as complete
  finish: (operationName) => {
    if (!window.loadingManager.operations.has(operationName)) return;

    console.log(`Finishing operation: ${operationName}`);
    window.loadingManager.operations.delete(operationName);

    // If no more operations, hide the loading UI
    if (window.loadingManager.operations.size === 0) {
      ModernUI.hideLoading();
    }
  },
};
