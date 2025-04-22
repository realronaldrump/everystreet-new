/* global L, bootstrap, DateUtils */

"use strict";
(function () {
  // Configuration object for selectors, classes, and storage keys
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
      centerOnLocationButton: "#center-on-location", // Added for clarity
      controlsToggle: "#controls-toggle", // Added for clarity
      controlsContent: "#controls-content", // Added for clarity
      loadingOverlay: ".loading-overlay", // Added for clarity
      progressBar: ".loading-overlay .progress-bar", // Added for clarity
      loadingText: ".loading-overlay .loading-text", // Added for clarity
      quickSelectBtns: ".quick-select-btn", // Added for clarity
      statusIndicator: ".status-indicator", // Added for clarity
      statusText: ".status-text", // Added for clarity
      mapContainer: "#map", // Added for clarity
      filterIndicator: "#filter-indicator", // Added for clarity
      filterDateRange: ".filter-date-range", // Added for clarity
      toolsSection: ".tools-section", // Added for clarity
    },
    classes: {
      active: "active",
      open: "open",
      visible: "visible",
      show: "show",
      scrolled: "scrolled",
      lightMode: "light-mode",
      minimized: "minimized", // Added for clarity
      connected: "connected", // Added for clarity
      disconnected: "disconnected", // Added for clarity
      mapControlsEventHandler: "map-controls-event-handler", // Added for clarity
    },
    storage: {
      theme: "theme",
      startDate: "startDate",
      endDate: "endDate",
    },
    mobileBreakpoint: 768,
    map: {
      defaultZoom: 14,
      flyToDuration: 1.5, // seconds
      zoomSnap: 0.5,
      lightBg: "#e0e0e0",
      darkBg: "#1a1a1a",
    },
    themeMetaColor: {
      light: "#f8f9fa",
      dark: "#121212",
    },
    tooltipDelay: { show: 500, hide: 100 },
  };

  // Cache for frequently accessed DOM elements
  const elements = {};

  /**
   * Initializes the Modern UI components.
   */
  function init() {
    try {
      cacheElements();

      // Initialize various UI components
      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initScrollEffects();
      initDatePickers();
      initMapControls();
      setupLegacyCodeBridge(); // Expose functions to older parts of the app

      // Handle responsive design adjustments
      window.addEventListener(
        "resize",
        window.utils?.debounce(handleResize, 250) || handleResize, // Use debounce if available
      );
      handleResize(); // Initial check

      // Enhance map interaction once the map is ready
      document.addEventListener("mapInitialized", () => {
        console.info("Map initialization detected by modern-ui.js");
        enhanceMapInteraction();
      });

      // Add filter indicator to the UI
      addFilterIndicator();

    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      window.notificationManager?.show(
        `Error initializing UI: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Caches DOM elements based on CONFIG selectors for performance.
   */
  function cacheElements() {
    const { selectors } = CONFIG;

    // Cache elements using direct selectors
    for (const key in selectors) {
      if (typeof selectors[key] === "string" && !elements[key]) {
        // Special handling for date inputs within the filters panel
        if (key === "startDate" || key === "endDate") {
           elements[`${key}Input`] = document.querySelector(
             `${selectors.filtersPanel} ${selectors[key]}`,
           );
        } else {
           elements[key] = document.querySelector(selectors[key]);
        }
      }
    }

    // Fallback for date inputs if not found within the panel (shouldn't happen with correct HTML)
    if (!elements.startDateInput && elements.startDate) elements.startDateInput = elements.startDate;
    if (!elements.endDateInput && elements.endDate) elements.endDateInput = elements.endDate;

    // Cache NodeLists
    elements.quickSelectBtns = document.querySelectorAll(selectors.quickSelectBtns);
    elements.datepickers = document.querySelectorAll(selectors.datepicker);
    elements.zoomControls = document.querySelectorAll(".leaflet-control-zoom a"); // Cache zoom controls

    // Ensure essential elements are cached, log warning if not found
    const essential = ['loadingOverlay', 'progressBar', 'loadingText', 'applyFiltersBtn', 'resetFiltersBtn', 'mapControls'];
    essential.forEach(key => {
        if (!elements[key]) {
            console.warn(`Essential element '${key}' with selector '${selectors[key]}' not found during cache.`);
        }
    });
  }

  /**
   * Initializes map control interactions, including minimizing,
   * event propagation handling, and the 'center on location' button.
   */
  function initMapControls() {
    const { mapControls, controlsToggle, centerOnLocationButton } = elements;
    if (!mapControls) {
        console.warn("Map controls container not found.");
        return;
    }

    // Improve touch scrolling on mobile for the controls panel
    mapControls.style.touchAction = "pan-y";
    mapControls.style.webkitOverflowScrolling = "touch";
    mapControls.style.overflowY = "auto"; // Ensure vertical scroll is possible

    // --- Minimize/Expand Toggle ---
    if (controlsToggle) {
      controlsToggle.addEventListener("click", function () {
        const controlsContent = elements.controlsContent || document.getElementById(CONFIG.selectors.controlsContent); // Re-query if needed
        mapControls.classList.toggle(CONFIG.classes.minimized);

        // Use Bootstrap Collapse component if available
        if (controlsContent && window.bootstrap?.Collapse) {
            const bsCollapse = window.bootstrap.Collapse.getOrCreateInstance(controlsContent);
            mapControls.classList.contains(CONFIG.classes.minimized) ? bsCollapse.hide() : bsCollapse.show();
        }

        // Toggle icon indicator
        const icon = this.querySelector("i");
        icon?.classList.toggle("fa-chevron-up");
        icon?.classList.toggle("fa-chevron-down");

        // Adjust opacity for minimized state (handled in enhanceMapInteraction)
        requestAnimationFrame(() => updateMapControlsOpacity());
      });
    } else {
        console.warn("Controls toggle button not found.");
    }

    // --- Event Propagation Handling ---
    // Prevent map interaction when interacting with controls
    const stopPropagationEvents = [
      "mousedown", "mouseup", "click", "dblclick",
      "touchstart", "touchend", "wheel", "contextmenu",
      "drag", "dragstart", "dragend", "touchmove" // Added touchmove
    ];

    stopPropagationEvents.forEach((eventType) => {
      mapControls.addEventListener(
        eventType,
        (e) => {
          // Allow interaction with form elements, buttons, links, etc. within the controls
          const target = e.target;
          const isInteractiveElement = target.closest(
            'input, select, textarea, button, a, .form-check, .nav-item, .list-group-item'
          );

          if (!isInteractiveElement) {
            e.stopPropagation();
          }
        },
        // Use passive where possible, but not for events that might need preventDefault (like drag)
        { passive: !['drag', 'dragstart', 'dragend', 'touchmove'].includes(eventType) }
      );
    });

    // Ensure the cursor indicates the controls are interactive
    mapControls.style.cursor = "default";
    mapControls.classList.add(CONFIG.classes.mapControlsEventHandler);

    // Add CSS for pointer events (ensure this doesn't conflict with other styles)
    const styleId = 'map-controls-pointer-events-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          .${CONFIG.classes.mapControlsEventHandler} {
            pointer-events: auto; /* Make the container itself clickable */
            touch-action: pan-y;
            -webkit-overflow-scrolling: touch;
          }
          /* Ensure specific interactive elements within controls are clickable */
          #${mapControls.id} .card,
          #${mapControls.id} .form-control,
          #${mapControls.id} .btn,
          #${mapControls.id} .form-check,
          #${mapControls.id} .form-select,
          #${mapControls.id} .nav-item,
          #${mapControls.id} .list-group-item {
            pointer-events: auto;
          }
        `;
        document.head.appendChild(style);
    }

    // --- Center on Location Button ---
    if (centerOnLocationButton) {
      centerOnLocationButton.addEventListener('click', handleCenterOnLocation);
    } else {
        console.warn("Center on location button not found.");
    }

    window.handleError?.( // Use optional chaining for safety
      "Map controls initialized",
      "initMapControls",
      "info",
    );
  }

  /**
   * Handles the logic for the 'Center on Location' button click.
   * Attempts to find the best location (live, last known, last trip end)
   * and flies the map to it.
   */
  function handleCenterOnLocation() {
    if (!window.map) {
      console.warn("Map not available to center.");
      window.notificationManager?.show("Map is not ready yet.", "warning");
      return;
    }

    const locationInfo = findBestLocationToCenter();

    if (locationInfo.targetLatLng) {
      console.info(`Centering map on ${locationInfo.source}:`, locationInfo.targetLatLng);
      // Fly to the location, zooming in if currently zoomed out
      window.map.flyTo(
          locationInfo.targetLatLng,
          window.map.getZoom() < CONFIG.map.defaultZoom ? CONFIG.map.defaultZoom : window.map.getZoom(),
          {
              animate: true,
              duration: CONFIG.map.flyToDuration
          }
      );
      window.notificationManager?.show(`Centered map on ${locationInfo.source}.`, "info");
    } else {
      console.warn("Could not determine location to center on.");
      window.notificationManager?.show("Could not determine current or last known location.", "warning");
    }
  }

  /**
   * Determines the best available location to center the map on.
   * Priority: Live Tracker > Last Known (DrivingNav) > Last Trip End Point.
   * @returns {{targetLatLng: [number, number]|null, source: string|null}}
   */
  function findBestLocationToCenter() {
    let targetLatLng = null;
    let locationSource = null;

    // 1. Try live tracker location
    const liveCoords = window.liveTracker?.activeTrip?.coordinates; // Optional chaining
    if (liveCoords?.length > 0) {
      const lastCoord = liveCoords[liveCoords.length - 1];
      if (lastCoord && typeof lastCoord.lat === 'number' && typeof lastCoord.lon === 'number') {
        targetLatLng = [lastCoord.lat, lastCoord.lon];
        locationSource = "live location";
        // console.log("Using live location from tracker."); // Removed debug log
      }
    }

    // 2. Try last known location from DrivingNavigation (if live location not found)
    if (!targetLatLng && window.drivingNavigation?.lastKnownLocation) { // Optional chaining
        const { lat, lon } = window.drivingNavigation.lastKnownLocation;
        if (typeof lat === 'number' && typeof lon === 'number') {
            targetLatLng = [lat, lon];
            locationSource = "last known location";
            // console.log("Using last known location from DrivingNavigation."); // Removed debug log
        }
    }

    // 3. Fallback: Last point of the most recent trip (if other locations not found)
    if (!targetLatLng) {
      const lastTripInfo = findLastTripEndPoint();
      if (lastTripInfo) {
          targetLatLng = lastTripInfo.coords;
          locationSource = "last trip end";
          // console.log("Using last trip end point as fallback."); // Removed debug log
      }
    }

    // Log if fallback failed and why (using handleError for better visibility)
    if (!targetLatLng && !locationSource) {
        logFallbackFailureReason();
    }


    return { targetLatLng, source: locationSource };
  }

  /**
   * Finds the coordinates of the end point of the most recent trip feature.
   * @returns {{coords: [number, number], featureId: string|number}|null} Coordinates [lat, lon] and feature ID or null.
   */
  function findLastTripEndPoint() {
      const tripsLayerData = window.AppState?.mapLayers?.trips?.layer; // Optional chaining

      if (!tripsLayerData?.features?.length > 0) { // Check features array existence and length
          return null;
      }

      let lastTripFeature = null;
      let latestTime = 0;

      // Find the feature with the latest end time
      tripsLayerData.features.forEach(feature => {
          const endTime = feature.properties?.endTime; // Optional chaining
          if (endTime) {
              const time = new Date(endTime).getTime();
              // Ensure time is valid and later than the current latest
              if (!isNaN(time) && time > latestTime) {
                  latestTime = time;
                  lastTripFeature = feature;
              }
          }
      });

      if (!lastTripFeature) {
          // console.warn("Could not determine the most recent trip feature."); // Removed debug log
          return null;
      }

      // Extract coordinates from the last feature
      const coords = extractCoordsFromFeature(lastTripFeature);
      if (coords) {
          // console.log("Found last trip feature:", lastTripFeature.properties?.id || lastTripFeature.properties?.transactionId, "ended at", new Date(latestTime)); // Removed debug log
          return { coords, featureId: lastTripFeature.properties?.id || lastTripFeature.properties?.transactionId };
      } else {
          // console.warn("Could not extract valid coordinates from the most recent trip feature:", lastTripFeature); // Removed debug log
          return null;
      }
  }

  /**
   * Extracts the last coordinate pair from a GeoJSON feature (Point or LineString).
   * @param {object} feature - The GeoJSON feature.
   * @returns {[number, number]|null} Coordinates as [lat, lon] or null if invalid.
   */
  function extractCoordsFromFeature(feature) {
      const geomType = feature?.geometry?.type; // Optional chaining
      const coords = feature?.geometry?.coordinates; // Optional chaining

      let lastCoord = null;

      if (geomType === "LineString" && Array.isArray(coords) && coords.length > 0) {
          lastCoord = coords[coords.length - 1]; // Get the last point of the line
      } else if (geomType === "Point" && Array.isArray(coords)) {
          lastCoord = coords; // Point coordinates are directly the array
      }

      // Validate and return as [lat, lon]
      if (Array.isArray(lastCoord) && lastCoord.length === 2 && typeof lastCoord[0] === 'number' && typeof lastCoord[1] === 'number') {
          return [lastCoord[1], lastCoord[0]]; // GeoJSON is [lng, lat], Leaflet needs [lat, lng]
      }

      return null;
  }

  /**
   * Logs detailed reasons why the fallback mechanism for finding a location failed.
   */
  function logFallbackFailureReason() {
      // Use handleError with 'info' level for logging structured debug information
      let reason = "Fallback location finding failed. Reasons:\n";
      reason += `- window.AppState exists: ${Boolean(window.AppState)}\n`; // Use Boolean() as suggested
      if (window.AppState) {
          reason += `- window.AppState.mapLayers exists: ${Boolean(window.AppState.mapLayers)}\n`; // Use Boolean()
          if (window.AppState.mapLayers) {
              const tripsLayer = window.AppState.mapLayers.trips;
              reason += `- window.AppState.mapLayers.trips exists: ${Boolean(tripsLayer)}\n`; // Use Boolean()
              if (tripsLayer) {
                  reason += `- window.AppState.mapLayers.trips.layer exists: ${Boolean(tripsLayer.layer)}\n`; // Use Boolean()
                  if (tripsLayer.layer) {
                      const features = tripsLayer.layer.features;
                      reason += `- .features is Array: ${Array.isArray(features)}\n`;
                      if (Array.isArray(features)) {
                          reason += `- .features.length: ${features.length}\n`;
                          if (features.length > 0) {
                              reason += `- No feature found with a valid 'endTime' property or valid coordinates.\n`
                          }
                      }
                  }
              }
          }
      }
      window.handleError?.(reason, "findBestLocationToCenter", "warn"); // Log as warning
  }


  /**
   * Initializes the theme toggle functionality (light/dark mode).
   */
  function initThemeToggle() {
    const { themeToggle, darkModeToggle } = elements;
    // If neither toggle exists, we can't initialize this feature
    if (!themeToggle && !darkModeToggle) return;

    // Determine the initial theme based on storage or system preference
    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    // Default to light unless saved theme is dark or system prefers dark and no theme is saved
    const initialTheme = savedTheme || (prefersDarkScheme ? "dark" : "light");

    applyTheme(initialTheme);

    // Setup the primary theme toggle (checkbox style)
    if (themeToggle) {
      themeToggle.checked = initialTheme === "light"; // Check if light mode is active
      themeToggle.addEventListener("change", () => {
        const newTheme = themeToggle.checked ? "light" : "dark";
        applyTheme(newTheme);
        localStorage.setItem(CONFIG.storage.theme, newTheme);

        // Sync the secondary dark mode toggle if it exists
        if (darkModeToggle) {
          darkModeToggle.checked = newTheme === "dark";
        }

        // Notify other parts of the application about the theme change
        document.dispatchEvent(
          new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
        );
      });
    }

    // Setup the secondary dark mode toggle (potentially a different UI element)
    // This assumes it should reflect the state set by the primary toggle or initial load
    if (darkModeToggle && !themeToggle) { // Only add listener if primary doesn't exist
         darkModeToggle.checked = initialTheme === "dark";
         darkModeToggle.addEventListener("change", () => {
            const newTheme = darkModeToggle.checked ? "dark" : "light";
            applyTheme(newTheme);
            localStorage.setItem(CONFIG.storage.theme, newTheme);
            document.dispatchEvent(
              new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
            );
         });
    } else if (darkModeToggle) {
         darkModeToggle.checked = initialTheme === "dark"; // Ensure it's synced initially
    }
  }

  /**
   * Applies the selected theme (light/dark) to the document.
   * @param {string} theme - The theme name ('light' or 'dark').
   */
  function applyTheme(theme) {
    const isLight = theme === "light";

    // Toggle body class for general styling
    document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
    // Set Bootstrap theme attribute
    document.documentElement.setAttribute("data-bs-theme", theme);

    // Update meta theme color for browser UI consistency
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", isLight ? CONFIG.themeMetaColor.light : CONFIG.themeMetaColor.dark);
    }

    // Update map tiles and background
    updateMapTheme(theme);
  }

  /**
   * Updates the map's tile layer and background based on the current theme.
   * @param {string} theme - The theme name ('light' or 'dark').
   */
  function updateMapTheme(theme) {
    // Ensure map and its methods are available
    if (!window.map?.eachLayer) return; // Use optional chaining

    // Update map container background
    const mapContainer = elements.mapContainer || document.getElementById(CONFIG.selectors.mapContainer);
    if (mapContainer) {
        mapContainer.style.background = theme === "light" ? CONFIG.map.lightBg : CONFIG.map.darkBg;
    }

    // Remove existing tile layers before adding the new one
    window.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        window.map.removeLayer(layer);
      }
    });

    // Add the new tile layer based on the theme
    const tileUrl = CONFIG.selectors.mapTileUrl[theme];
    if (tileUrl) {
        L.tileLayer(tileUrl, {
          maxZoom: 19, // Consider making this configurable
          attribution: "", // Add attribution if required by the tile provider
        }).addTo(window.map);
    } else {
        console.warn(`Map tile URL for theme '${theme}' not found in config.`);
    }


    // Refresh map size to prevent rendering issues
    window.map.invalidateSize();

    // Notify other components about the map theme change
    document.dispatchEvent(
      new CustomEvent("mapThemeChanged", { detail: { theme } }),
    );
  }

  /**
   * Initializes the mobile navigation drawer functionality.
   */
  function initMobileDrawer() {
    const { mobileDrawer, menuToggle, closeBtn, contentOverlay } = elements;
    if (!mobileDrawer || !menuToggle) {
        // console.warn("Mobile drawer or menu toggle not found, skipping initialization."); // Removed debug log
        return;
    }


    const closeDrawer = () => {
      mobileDrawer.classList.remove(CONFIG.classes.open);
      contentOverlay?.classList.remove(CONFIG.classes.visible); // Use optional chaining
      document.body.style.overflow = ""; // Restore body scroll
    };

    // Open drawer on menu toggle click
    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent potential conflicts
      mobileDrawer.classList.add(CONFIG.classes.open);
      contentOverlay?.classList.add(CONFIG.classes.visible); // Use optional chaining
      document.body.style.overflow = "hidden"; // Prevent body scroll when drawer is open
    });

    // Close drawer using the close button
    closeBtn?.addEventListener("click", closeDrawer); // Use optional chaining

    // Close drawer when clicking the overlay
    contentOverlay?.addEventListener("click", closeDrawer); // Use optional chaining

    // Close drawer on Escape key press
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        mobileDrawer.classList.contains(CONFIG.classes.open)
      ) {
        closeDrawer();
      }
    });
  }

  /**
   * Initializes the filters panel, including toggle, close,
   * date range quick selects, apply, and reset buttons.
   */
  function initFilterPanel() {
    const {
      filterToggle,
      filtersPanel,
      contentOverlay,
      filtersClose,
      applyFiltersBtn, // Renamed from applyFilters for clarity
      resetFiltersBtn, // Renamed from resetFilters for clarity
      quickSelectBtns,
    } = elements;

    // Toggle panel visibility
    if (filterToggle && filtersPanel) {
      filterToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        filtersPanel.classList.toggle(CONFIG.classes.open);
        contentOverlay?.classList.toggle(CONFIG.classes.visible); // Use optional chaining
        // updateFilterIndicator(); // Update indicator when panel opens/closes
      });
    } else {
        console.warn("Filter toggle or panel not found.");
    }


    const closePanel = () => {
      filtersPanel?.classList.remove(CONFIG.classes.open); // Use optional chaining
      contentOverlay?.classList.remove(CONFIG.classes.visible); // Use optional chaining
    };

    // Close panel using the close button or overlay click
    filtersClose?.addEventListener("click", closePanel); // Use optional chaining
    contentOverlay?.addEventListener("click", closePanel); // Use optional chaining

    // Initialize quick select date range buttons
    if (quickSelectBtns?.length) {
      quickSelectBtns.forEach((btn) => {
        btn.addEventListener("click", function () {
          const range = this.dataset.range;
          if (!range) return;

          setDateRange(range); // Set the date range based on button's data attribute

          // Update active state for visual feedback
          quickSelectBtns.forEach((b) =>
            b.classList.remove(CONFIG.classes.active),
          );
          this.classList.add(CONFIG.classes.active);
        });
      });
    }

    // Apply filters button
    applyFiltersBtn?.addEventListener("click", applyFilters); // Use optional chaining

    // Reset filters button
    resetFiltersBtn?.addEventListener("click", resetFilters); // Use optional chaining
  }

  /**
   * Initializes date pickers using Flatpickr.
   */
  function initDatePickers() {
    const { datepickers, startDateInput, endDateInput } = elements;

    // Ensure DateUtils is available
    if (!window.DateUtils) {
        console.error("DateUtils not found. Cannot initialize date pickers.");
        return;
    }

    const today = DateUtils.getCurrentDate();
    // Retrieve saved dates or default to today
    const startDate = localStorage.getItem(CONFIG.storage.startDate) || today;
    const endDate = localStorage.getItem(CONFIG.storage.endDate) || today;

    // Common Flatpickr configuration
    const dateConfig = {
      maxDate: "today", // Don't allow future dates
      disableMobile: true, // Use native date pickers on mobile if desired (false)
      dateFormat: "Y-m-d", // Ensure consistent format
      altInput: true, // Show user-friendly format
      altFormat: "M j, Y", // User-friendly format
      theme: document.body.classList.contains(CONFIG.classes.lightMode)
        ? "light" // Use Flatpickr light theme
        : "dark", // Use Flatpickr dark theme
        errorHandler: (error) => console.warn("Flatpickr error:", error) // Handle Flatpickr errors
    };

    // Initialize all elements with the datepicker class
    if (datepickers?.length) {
      datepickers.forEach((input) => {
        // Avoid re-initializing if Flatpickr instance already exists
        if (!input._flatpickr) {
          DateUtils.initDatePicker(input, dateConfig); // Use utility function
        }
      });
    }

    // Set initial values for the specific start/end date inputs
    // Note: Linter might flag startDateInput/endDateInput as unused here,
    // but they are used later in setDateRange, applyFilters etc. This seems
    // like a potential linter scope issue or false positive.
    if (startDateInput) {
      // Use setDate method if Flatpickr is initialized, otherwise set value directly
      startDateInput._flatpickr ? startDateInput._flatpickr.setDate(startDate, true) : startDateInput.value = startDate;
    } else {
        console.warn("Start date input element not found for setting initial value.");
    }

    if (endDateInput) {
      endDateInput._flatpickr ? endDateInput._flatpickr.setDate(endDate, true) : endDateInput.value = endDate;
    } else {
        console.warn("End date input element not found for setting initial value.");
    }
  }

  /**
   * Adds the filter indicator element to the DOM if it doesn't exist.
   */
  function addFilterIndicator() {
    const toolsSection = elements.toolsSection || document.querySelector(CONFIG.selectors.toolsSection);
    // Exit if the indicator already exists or the target section isn't found
    if (!toolsSection || document.getElementById(CONFIG.selectors.filterIndicator.substring(1))) return;

    const indicator = document.createElement("div");
    indicator.className = "filter-indicator me-2"; // Added margin
    indicator.id = CONFIG.selectors.filterIndicator.substring(1); // Use ID from config
    indicator.setAttribute("title", "Current date range filter");
    indicator.style.cursor = "pointer"; // Indicate it's clickable
    indicator.innerHTML = `
      <i class="fas fa-calendar-alt me-1"></i>
      <span class="${CONFIG.selectors.filterDateRange.substring(1)}">Today</span>
    `;

    // Insert before the filter toggle button if available, otherwise append
    const { filterToggle } = elements;
    if (filterToggle) {
      toolsSection.insertBefore(indicator, filterToggle);
    } else {
      toolsSection.appendChild(indicator);
    }

    // Make the indicator clickable to open the filter panel
    indicator.addEventListener("click", () => {
      if (elements.filtersPanel && elements.contentOverlay) {
        elements.filtersPanel.classList.add(CONFIG.classes.open);
        elements.contentOverlay.classList.add(CONFIG.classes.visible);
      }
    });

    // Set the initial text of the indicator
    updateFilterIndicator();
  }

  /**
   * Updates the text content of the filter indicator based on stored dates.
   */
  function updateFilterIndicator() {
    const indicator = elements.filterIndicator || document.getElementById(CONFIG.selectors.filterIndicator.substring(1));
    if (!indicator) return;

    const rangeSpan = indicator.querySelector(CONFIG.selectors.filterDateRange);
    if (!rangeSpan) return;

    // Ensure DateUtils is available
    if (!window.DateUtils) {
        console.error("DateUtils not found. Cannot update filter indicator.");
        rangeSpan.textContent = "Error";
        return;
    }

    // Get dates from storage or default to today
    const startDate = localStorage.getItem(CONFIG.storage.startDate) || DateUtils.getCurrentDate();
    const endDate = localStorage.getItem(CONFIG.storage.endDate) || DateUtils.getCurrentDate();

    // Format dates for display using DateUtils
    const formatDisplayDate = (dateStr) =>
      DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" }) || dateStr; // Fallback to raw string

    // Update the text based on whether the dates are the same
    if (startDate === endDate) {
      rangeSpan.textContent = formatDisplayDate(startDate);
    } else {
      rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
    }
  }

  /**
   * Sets the date range based on a preset string (e.g., 'today', '7days').
   * @param {string} range - The preset range string.
   */
  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;
    // Ensure date inputs are available
    if (!startDateInput || !endDateInput) {
      console.error(
        "Date input elements not found. Cannot set date range.",
      );
      window.notificationManager?.show(
        "UI Error: Date inputs not found.",
        "danger",
      );
      return;
    }
    // Ensure DateUtils is available
     if (!window.DateUtils) {
        console.error("DateUtils not found. Cannot set date range.");
        window.notificationManager?.show("Error: Date utility missing.", "danger");
        return;
     }

    // Show loading indicator if available
    window.loadingManager?.startOperation("DateRangeSet", 100);

    // Use DateUtils to get the start and end dates for the preset
    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
          // Update the input fields and Flatpickr instances
          updateDateInputs(startDate, endDate);
          // Store the new dates in localStorage
          localStorage.setItem(CONFIG.storage.startDate, startDate);
          localStorage.setItem(CONFIG.storage.endDate, endDate);
          // Update the visual indicator
          updateFilterIndicator();
        } else {
            throw new Error("Received invalid date range from preset."); // Throw error if dates are missing
        }
      })
      .catch((error) => {
        console.error("Error setting date range preset:", error);
        window.notificationManager?.show(
          `Error setting date range: ${error.message || 'Please try again.'}`, // Show error message
          "danger", // Use 'danger' for errors
        );
      })
      .finally(() => {
        // Hide loading indicator
        window.loadingManager?.finish("DateRangeSet");
      });
  }

  /**
   * Updates the values of the start and end date input fields and their Flatpickr instances.
   * @param {string} startStr - The start date string (YYYY-MM-DD).
   * @param {string} endStr - The end date string (YYYY-MM-DD).
   */
  function updateDateInputs(startStr, endStr) {
    const { startDateInput, endDateInput } = elements;

    if (startDateInput) {
        // Use setDate for Flatpickr, fallback to value for standard input
        startDateInput._flatpickr ? startDateInput._flatpickr.setDate(startStr, true) : startDateInput.value = startStr;
    } else {
      console.warn("Cached start date input not found in updateDateInputs");
    }

    if (endDateInput) {
        endDateInput._flatpickr ? endDateInput._flatpickr.setDate(endStr, true) : endDateInput.value = endStr;
    } else {
      console.warn("Cached end date input not found in updateDateInputs");
    }
  }

  /**
   * Applies the currently selected date filters, stores them, and triggers an event.
   */
  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;
    // Ensure date inputs are available
    if (!startDateInput || !endDateInput) {
      console.error("Cannot apply filters: Date input elements not found.");
      window.notificationManager?.show(
        "UI Error: Date inputs missing.",
        "danger",
      );
      return;
    }

    const startDateValue = startDateInput.value;
    const endDateValue = endDateInput.value;

    // --- Validation (Optional but Recommended) ---
    if (!window.DateUtils?.isValidDateRange(startDateValue, endDateValue)) {
         window.notificationManager?.show(
            "Invalid date range: Start date must be before or same as end date.",
            "warning",
         );
         return; // Prevent applying invalid range
    }
    // --- End Validation ---


    // Store the selected dates in localStorage
    localStorage.setItem(CONFIG.storage.startDate, startDateValue);
    localStorage.setItem(CONFIG.storage.endDate, endDateValue);

    // Update the visual indicator
    updateFilterIndicator();

    // Close the filter panel
    if (filtersPanel && contentOverlay) {
      filtersPanel.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
    }

    // Dispatch an event to notify other parts of the application
    document.dispatchEvent(
      new CustomEvent("filtersApplied", {
        detail: {
          startDate: startDateValue,
          endDate: endDateValue,
        },
      }),
    );

    // Provide user feedback
    window.notificationManager?.show(
      `Filters applied: ${DateUtils.formatForDisplay(startDateValue)} to ${DateUtils.formatForDisplay(endDateValue)}`,
      "success",
    );

    // Optionally trigger data refresh here if needed immediately
    // refreshMapData(); // Example: Uncomment if map data should refresh on apply
    // refreshPlacesData(); // Example: Uncomment if places data should refresh
  }

  /**
   * Resets the date filters to 'Today' and applies them.
   */
  function resetFilters() {
    const { quickSelectBtns } = elements;

    // Ensure DateUtils is available
    if (!window.DateUtils) {
        console.error("DateUtils not found. Cannot reset filters.");
        window.notificationManager?.show("Error: Date utility missing.", "danger");
        return;
    }
    const today = DateUtils.getCurrentDate(); // Get today's date in YYYY-MM-DD format

    // Update input fields to today's date
    updateDateInputs(today, today);

    // Update localStorage
    localStorage.setItem(CONFIG.storage.startDate, today);
    localStorage.setItem(CONFIG.storage.endDate, today);

    // Deactivate all quick select buttons
    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) =>
        btn.classList.remove(CONFIG.classes.active),
      );
      // Optionally activate the 'Today' button if it exists
       const todayBtn = document.querySelector('.quick-select-btn[data-range="today"]');
       todayBtn?.classList.add(CONFIG.classes.active);
    }

    // Update the visual indicator
    updateFilterIndicator();

    // Apply the reset filters immediately
    applyFilters(); // This will also close the panel and show notification

    // Optional: Add a specific notification for reset action
    // window.notificationManager?.show(
    //   "Date filters reset to Today.",
    //   "info",
    // );
  }

  /**
   * Initializes scroll effects, like adding a class to the header on scroll.
   */
  function initScrollEffects() {
    const { header } = elements;
    if (!header) return; // Exit if header element is not found

    // Debounced scroll handler for performance
    const scrollHandler = window.utils?.debounce(() => {
      // Add 'scrolled' class if page is scrolled down, remove otherwise
      header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
    }, 50); // Short debounce interval for responsiveness

    window.addEventListener("scroll", scrollHandler, { passive: true }); // Use passive listener
    scrollHandler(); // Initial check on load
  }

  /**
   * Handles window resize events, primarily for adjusting mobile drawer visibility.
   */
  function handleResize() {
    // If window width is larger than mobile breakpoint, ensure mobile drawer is closed
    if (window.innerWidth >= CONFIG.mobileBreakpoint) {
      const { mobileDrawer, contentOverlay } = elements;
      if (mobileDrawer?.classList.contains(CONFIG.classes.open)) { // Optional chaining
        mobileDrawer.classList.remove(CONFIG.classes.open);
        contentOverlay?.classList.remove(CONFIG.classes.visible); // Optional chaining
        document.body.style.overflow = ""; // Restore body scroll
      }
    }
    // Add other resize adjustments here if needed
  }

  /*
   * Functions `refreshMapData` and `refreshPlacesData` were removed
   * as they were defined but never used within this script or exposed globally.
   * If they are needed by external code, they should be explicitly attached
   * to a global object (e.g., window.modernUI).
   */
  // function refreshMapData() { ... } // Removed
  // function refreshPlacesData() { ... } // Removed


  /**
   * Shows the loading overlay with a message and progress.
   * @param {string} [message="Loading..."] - The message to display.
   */
  function showLoading(message = "Loading...") {
    const { loadingOverlay, loadingText, progressBar } = elements;
    if (!loadingOverlay) return;

    if (loadingText) loadingText.textContent = message;
    if (progressBar) progressBar.style.width = "0%"; // Reset progress
    loadingOverlay.style.display = "flex"; // Show the overlay
    loadingOverlay.style.opacity = "1"; // Ensure visible
  }

  /**
   * Hides the loading overlay.
   */
  function hideLoading() {
    const { loadingOverlay, progressBar } = elements;
    if (!loadingOverlay) return;

    // Animate progress bar to 100% before hiding
    if (progressBar) progressBar.style.width = "100%";

    // Fade out and hide
    loadingOverlay.style.opacity = "0";
    setTimeout(() => {
      loadingOverlay.style.display = "none";
    }, 400); // Match transition duration
  }

  /**
   * Updates the progress bar and loading message.
   * @param {number} percent - The progress percentage (0-100).
   * @param {string} [message] - Optional message to update.
   */
  function updateProgress(percent, message) {
    const { progressBar, loadingText } = elements;
    if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; // Clamp percentage
    if (loadingText && message) loadingText.textContent = message;
  }

  /**
   * Sets up a bridge to expose modern UI functions to potentially older/legacy code.
   */
  function setupLegacyCodeBridge() {
    window.modernUI = {
      showLoading,
      hideLoading,
      updateProgress,
      setDateRange, // Expose function to set date range programmatically
      applyTheme, // Expose function to change theme programmatically
      // Add other functions here if they need to be accessible globally
    };

    // Enhance map interaction after the initial page load as well
    window.addEventListener("load", enhanceMapInteraction);
  }

  /**
   * Entry point for applying enhancements after the map is initialized or page loads.
   */
  function enhanceMapInteraction() {
    // Ensure map container exists before proceeding
    if (!elements.mapContainer && !document.getElementById(CONFIG.selectors.mapContainer.substring(1))) {
        // console.warn("Map container not found, skipping map enhancements."); // Removed debug log
        return;
    }
    applyMapEnhancements();
  }

    /**
     * Applies various enhancements to the Leaflet map interface.
     */
    function applyMapEnhancements() {
        try {
            const map = window.map;
            // Ensure map object and its properties are valid
            if (!map?.options) { // Check if map and options exist
                // console.warn("Map object or map options not available for enhancements."); // Removed debug log
                return;
            }

            // Adjust map behavior
            map.options.zoomSnap = CONFIG.map.zoomSnap; // Set smoother zoom increments

            // Add tooltips to zoom controls using Bootstrap Tooltip
            if (window.bootstrap?.Tooltip && elements.zoomControls?.length) {
                elements.zoomControls.forEach((control) => {
                // Check if tooltip is already initialized
                if (!bootstrap.Tooltip.getInstance(control)) {
                    let title = "";
                    if (control.classList.contains("leaflet-control-zoom-in")) {
                        title = "Zoom In";
                    } else if (control.classList.contains("leaflet-control-zoom-out")) {
                        title = "Zoom Out";
                    }

                    if (title) {
                        // Instantiating Tooltip for side effect of attaching it.
                        // The instance itself is not stored (JS-R1002 can be ignored here).
                        new bootstrap.Tooltip(control, {
                            title: title,
                            placement: "left",
                            delay: CONFIG.tooltipDelay,
                            trigger: 'hover' // Show on hover
                        });
                    }
                }
                });
            }

            // Enhance connection status indicator (if elements exist)
            const { statusIndicator, statusText } = elements;
            if (statusIndicator && statusText) {
                const updateConnectionIndicator = () => {
                    const textContentLower = statusText.textContent.toLowerCase();
                    if (textContentLower.includes("connected")) {
                        statusIndicator.classList.add(CONFIG.classes.connected);
                        statusIndicator.classList.remove(CONFIG.classes.disconnected);
                    } else if (textContentLower.includes("disconnected")) {
                        statusIndicator.classList.add(CONFIG.classes.disconnected);
                        statusIndicator.classList.remove(CONFIG.classes.connected);
                    } else {
                        // Handle unknown state if necessary
                        statusIndicator.classList.remove(CONFIG.classes.connected, CONFIG.classes.disconnected);
                    }
                };
                updateConnectionIndicator(); // Initial check
                // Periodically update indicator (consider event-based updates if possible)
                setInterval(updateConnectionIndicator, 3000);
            }

            // Opacity handling for minimized map controls
            const { mapControls } = elements;
            if (mapControls) {
                mapControls.addEventListener("mouseenter", () => {
                    mapControls.style.opacity = "1"; // Fully opaque on hover
                });
                mapControls.addEventListener("mouseleave", () => {
                    updateMapControlsOpacity(); // Update opacity based on state
                });
                // Initial opacity check
                updateMapControlsOpacity();
            }

            window.handleError?.( // Use optional chaining
                "Map enhancements applied successfully",
                "applyMapEnhancements",
                "info",
            );

        } catch (error) {
            window.handleError?.(error, "Error applying map enhancements"); // Use optional chaining
        }
    }

    /**
     * Updates the opacity of the map controls based on minimized state.
     */
    function updateMapControlsOpacity() {
        const { mapControls } = elements;
        if (!mapControls) return;

        if (mapControls.classList.contains(CONFIG.classes.minimized)) {
            mapControls.style.opacity = "0.8"; // Slightly transparent when minimized and not hovered
        } else {
            mapControls.style.opacity = "1"; // Fully opaque when expanded
        }
    }


  // Initialize the UI components when the application signals readiness
  // or fallback to DOMContentLoaded if 'appReady' isn't fired.
  if (document.readyState === 'loading') {
      document.addEventListener("DOMContentLoaded", () => {
          // Check if init has already run via appReady
          if (!window.modernUIInitialized) {
              init();
              window.modernUIInitialized = true;
          }
      });
  } else {
      // DOM is already ready
      if (!window.modernUIInitialized) {
            init();
            window.modernUIInitialized = true;
      }
  }

  document.addEventListener("appReady", () => {
       if (!window.modernUIInitialized) {
           init();
           window.modernUIInitialized = true;
       }
  });

})(); // IIFE ends here
