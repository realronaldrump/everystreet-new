/* global L, bootstrap, DateUtils */

"use strict";
// Cached base tile layer so we can just swap URLs on theme change
let baseTileLayer = null;
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
      applyFiltersBtn: "#apply-filters",
      resetFilters: "#reset-filters",
      header: ".app-header",
      datepicker: ".datepicker",
      mapControls: "#map-controls",
      mapTileUrl: {
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      },
      centerOnLocationButton: "#center-on-location",
      controlsToggle: "#controls-toggle",
      controlsContent: "#controls-content",
      loadingOverlay: ".loading-overlay",
      progressBar: ".loading-overlay .progress-bar",
      loadingText: ".loading-overlay .loading-text",
      quickSelectBtns: ".quick-select-btn",
      statusIndicator: ".status-indicator",
      statusText: ".status-text",
      mapContainer: "#map",
      filterIndicator: "#filter-indicator",
      filterDateRange: ".filter-date-range",
      toolsSection: ".tools-section",
    },
    classes: {
      active: "active",
      open: "open",
      visible: "visible",
      show: "show",
      scrolled: "scrolled",
      lightMode: "light-mode",
      minimized: "minimized",
      connected: "connected",
      disconnected: "disconnected",
      mapControlsEventHandler: "map-controls-event-handler",
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

  const elements = {}; // Cache for DOM elements

  window.requestIdleCallback =
    window.requestIdleCallback ||
    function (cb) {
      var start = Date.now();
      return setTimeout(function () {
        cb({
          didTimeout: false,
          timeRemaining: function () {
            return Math.max(0, 50 - (Date.now() - start));
          },
        });
      }, 1);
    };

  window.cancelIdleCallback =
    window.cancelIdleCallback ||
    function (id) {
      clearTimeout(id);
    };

  /**
   * Initializes the Modern UI components.
   */
  function init() {
    try {
      cacheElements();
      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initScrollEffects();
      requestIdleCallback(() => {
        initDatePickers();
      });
      initMapControls();
      setupLegacyCodeBridge();

      window.addEventListener(
        "resize",
        window.utils?.debounce(handleResize, 250) || handleResize,
      );
      handleResize(); // Initial call

      document.addEventListener("mapInitialized", enhanceMapInteraction);
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
   * Caches DOM elements based on CONFIG selectors.
   */
  function cacheElements() {
    const { selectors } = CONFIG;
    for (const key in selectors) {
      if (typeof selectors[key] === "string" && !elements[key]) {
        if (key === "startDate" || key === "endDate") {
          // Date inputs are specifically within the filters panel
          elements[`${key}Input`] = document.querySelector(
            `${selectors.filtersPanel} ${selectors[key]}`,
          );
        } else {
          elements[key] = document.querySelector(selectors[key]);
        }
      }
    }

    // Fallback if date inputs were not found inside filter panel (e.g. if selectors were just #start-date)
    if (!elements.startDateInput && elements.startDate)
      elements.startDateInput = elements.startDate;
    if (!elements.endDateInput && elements.endDate)
      elements.endDateInput = elements.endDate;

    elements.quickSelectBtns = document.querySelectorAll(
      selectors.quickSelectBtns,
    );
    elements.datepickers = document.querySelectorAll(selectors.datepicker);
    elements.zoomControls = document.querySelectorAll(
      ".leaflet-control-zoom a",
    );

    // Check for essential elements and warn if not found
    const essentialElements = [
      "loadingOverlay",
      "progressBar",
      "loadingText",
      "applyFiltersBtn",
      "resetFilters",
      "mapControls",
    ];
    essentialElements.forEach((key) => {
      if (!elements[key]) {
        console.warn(
          `Essential element '${key}' with selector '${selectors[key]}' not found.`,
        );
      }
    });
  }

  /**
   * Initializes map control interactions, including toggle and event propagation.
   */
  function initMapControls() {
    const {
      mapControls,
      controlsToggle,
      centerOnLocationButton,
      controlsContent: controlsContentSelector,
    } = elements;
    if (!mapControls) return;

    // Apply styles for better touch interaction on mobile
    mapControls.style.touchAction = "pan-y"; // Allow vertical scrolling within controls
    mapControls.style.webkitOverflowScrolling = "touch"; // Smooth scrolling on iOS
    mapControls.style.overflowY = "auto"; // Ensure content is scrollable if it overflows

    if (controlsToggle) {
      controlsToggle.addEventListener("click", function () {
        const controlsContent =
          elements.controlsContent ||
          document.querySelector(CONFIG.selectors.controlsContent); // Re-query if not cached
        mapControls.classList.toggle(CONFIG.classes.minimized);

        if (controlsContent && window.bootstrap?.Collapse) {
          const bsCollapse =
            window.bootstrap.Collapse.getOrCreateInstance(controlsContent);
          if (mapControls.classList.contains(CONFIG.classes.minimized)) {
            bsCollapse.hide();
          } else {
            bsCollapse.show();
          }
        }
        const icon = this.querySelector("i");
        icon?.classList.toggle("fa-chevron-up");
        icon?.classList.toggle("fa-chevron-down");
        requestAnimationFrame(updateMapControlsOpacity); // Ensure opacity updates after class change
      });
    }

    // Prevent map interaction when interacting with controls
    const stopPropagationEvents = [
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
      "touchmove",
    ];
    stopPropagationEvents.forEach((eventType) => {
      mapControls.addEventListener(
        eventType === "click" ? "mousedown" : eventType, // Use mousedown for click to catch it earlier
        (e) => {
          if (eventType === "click" && e.button !== 0) return; // Only process left clicks for 'click'
          const target = e.target;
          // Allow events on interactive elements within the controls
          const isInteractiveElement = target.closest(
            "input, select, textarea, button, a, .form-check, .nav-item, .list-group-item",
          );
          if (!isInteractiveElement) {
            e.stopPropagation();
          }
        },
        {
          passive: !["drag", "dragstart", "dragend", "touchmove"].includes(
            eventType,
          ),
        }, // Use passive where appropriate
      );
    });

    mapControls.style.cursor = "default"; // Set a default cursor for the controls area
    mapControls.classList.add(CONFIG.classes.mapControlsEventHandler); // Marker class for styles

    // Add specific styles for pointer events on controls
    const styleId = "map-controls-pointer-events-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .${CONFIG.classes.mapControlsEventHandler} { pointer-events: auto; touch-action: pan-y; -webkit-overflow-scrolling: touch; }
        #${mapControls.id} .card, #${mapControls.id} .form-control, #${mapControls.id} .btn, #${mapControls.id} .form-check, #${mapControls.id} .form-select, #${mapControls.id} .nav-item, #${mapControls.id} .list-group-item { pointer-events: auto; }
      `;
      document.head.appendChild(style);
    }

    if (centerOnLocationButton) {
      centerOnLocationButton.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // Only left click
        handleCenterOnLocation(e);
      });
    }
  }

  /**
   * Handles centering the map on the best available location (live, last known, or last trip end).
   * @param {Event} e - The event object.
   */
  function handleCenterOnLocation(e) {
    e.preventDefault(); // Prevent any default action
    if (!window.map) {
      window.notificationManager?.show("Map is not ready yet.", "warning");
      return;
    }
    const locationInfo = findBestLocationToCenter();
    if (locationInfo.targetLatLng) {
      window.map.flyTo(
        locationInfo.targetLatLng,
        window.map.getZoom() < CONFIG.map.defaultZoom
          ? CONFIG.map.defaultZoom
          : window.map.getZoom(),
        { animate: true, duration: CONFIG.map.flyToDuration },
      );
      window.notificationManager?.show(
        `Centered map on ${locationInfo.source}.`,
        "info",
      );
    } else {
      window.notificationManager?.show(
        "Could not determine current or last known location.",
        "warning",
      );
    }
  }

  /**
   * Finds the best location to center the map, prioritizing live data, then last known, then last trip.
   * @returns {object} An object with targetLatLng and source string.
   */
  function findBestLocationToCenter() {
    let targetLatLng = null;
    let locationSource = null;

    // 1. Try live tracker coordinates
    const liveCoords = window.liveTracker?.activeTrip?.coordinates;
    if (liveCoords?.length > 0) {
      const lastCoord = liveCoords[liveCoords.length - 1];
      if (
        lastCoord &&
        typeof lastCoord.lat === "number" &&
        typeof lastCoord.lon === "number"
      ) {
        targetLatLng = [lastCoord.lat, lastCoord.lon];
        locationSource = "live location";
      }
    }

    // 2. Try driving navigation's last known location
    if (!targetLatLng && window.drivingNavigation?.lastKnownLocation) {
      const { lat, lon } = window.drivingNavigation.lastKnownLocation;
      if (typeof lat === "number" && typeof lon === "number") {
        targetLatLng = [lat, lon];
        locationSource = "last known location";
      }
    }

    // 3. Try the end point of the most recent trip from AppState
    if (!targetLatLng) {
      const lastTripInfo = findLastTripEndPoint();
      if (lastTripInfo) {
        targetLatLng = lastTripInfo.coords;
        locationSource = "last trip end";
      }
    }
    if (!targetLatLng && !locationSource) {
      logFallbackFailureReason(); // Log if no location could be determined
    }
    return { targetLatLng, source: locationSource };
  }

  /**
   * Finds the end point of the most recent trip from AppState.
   * @returns {object|null} Object with coords and featureId, or null if not found.
   */
  function findLastTripEndPoint() {
    const tripsLayerData = window.AppState?.mapLayers?.trips?.layer;
    if (!tripsLayerData?.features?.length > 0) return null;

    let lastTripFeature = null;
    let latestTime = 0;

    tripsLayerData.features.forEach((feature) => {
      const endTime = feature.properties?.endTime;
      if (endTime) {
        const time = new Date(endTime).getTime();
        if (!isNaN(time) && time > latestTime) {
          latestTime = time;
          lastTripFeature = feature;
        }
      }
    });

    if (!lastTripFeature) return null;

    const coords = extractCoordsFromFeature(lastTripFeature);
    return coords
      ? {
          coords,
          featureId:
            lastTripFeature.properties?.id ||
            lastTripFeature.properties?.transactionId,
        }
      : null;
  }

  /**
   * Extracts coordinates from a GeoJSON feature (Point or last coordinate of LineString).
   * @param {object} feature - The GeoJSON feature.
   * @returns {Array|null} Coordinates as [lat, lng] or null.
   */
  function extractCoordsFromFeature(feature) {
    const geomType = feature?.geometry?.type;
    const coords = feature?.geometry?.coordinates;
    let lastCoord = null;

    if (
      geomType === "LineString" &&
      Array.isArray(coords) &&
      coords.length > 0
    ) {
      lastCoord = coords[coords.length - 1]; // [lng, lat]
    } else if (geomType === "Point" && Array.isArray(coords)) {
      lastCoord = coords; // [lng, lat]
    }

    // Ensure valid coordinates and convert to [lat, lng] for Leaflet
    if (
      Array.isArray(lastCoord) &&
      lastCoord.length === 2 &&
      typeof lastCoord[0] === "number" &&
      typeof lastCoord[1] === "number"
    ) {
      return [lastCoord[1], lastCoord[0]]; // Leaflet needs [lat, lng]
    }
    return null;
  }

  /**
   * Logs detailed reasons if fallback location finding fails.
   */
  function logFallbackFailureReason() {
    let reason = "Fallback location finding failed. Detailed check:\n";
    reason += `- window.AppState exists: ${Boolean(window.AppState)}\n`;
    if (window.AppState) {
      reason += `  - window.AppState.mapLayers exists: ${Boolean(window.AppState.mapLayers)}\n`;
      if (window.AppState.mapLayers) {
        const tripsLayer = window.AppState.mapLayers.trips;
        reason += `    - window.AppState.mapLayers.trips exists: ${Boolean(tripsLayer)}\n`;
        if (tripsLayer?.layer) {
          const features = tripsLayer.layer.features;
          reason += `      - .features is Array: ${Array.isArray(features)}\n`;
          if (Array.isArray(features)) {
            reason += `      - .features.length: ${features.length}\n`;
            if (features.length > 0) {
              reason +=
                "      - Checked features but none had a valid 'endTime' or extractable coordinates.\n";
            }
          }
        } else {
          reason += `    - window.AppState.mapLayers.trips.layer is missing.\n`;
        }
      }
    }
    window.handleError?.(reason, "findBestLocationToCenter", "warn");
  }

  /**
   * Initializes theme toggle functionality (light/dark mode).
   */
  function initThemeToggle() {
    const { themeToggle, darkModeToggle } = elements;
    if (!themeToggle && !darkModeToggle) return; // No toggle elements found

    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const initialTheme = savedTheme || (prefersDarkScheme ? "dark" : "light");

    applyTheme(initialTheme);

    const handleThemeChange = (newTheme) => {
      applyTheme(newTheme);
      localStorage.setItem(CONFIG.storage.theme, newTheme);
      // Synchronize both toggles if they exist
      if (themeToggle) themeToggle.checked = newTheme === "light";
      if (darkModeToggle) darkModeToggle.checked = newTheme === "dark";
      document.dispatchEvent(
        new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
      );
    };

    if (themeToggle) {
      themeToggle.checked = initialTheme === "light";
      themeToggle.addEventListener("change", () => {
        handleThemeChange(themeToggle.checked ? "light" : "dark");
      });
    }

    // If only dark mode toggle exists, or if it's a secondary toggle
    if (darkModeToggle) {
      darkModeToggle.checked = initialTheme === "dark";
      if (!themeToggle) {
        // Only add listener if themeToggle isn't primary
        darkModeToggle.addEventListener("change", () => {
          handleThemeChange(darkModeToggle.checked ? "dark" : "light");
        });
      }
    }
  }

  /**
   * Applies the selected theme to the document and map.
   * @param {string} theme - The theme to apply ("light" or "dark").
   */
  function applyTheme(theme) {
    const isLight = theme === "light";
    document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
    document.documentElement.setAttribute("data-bs-theme", theme); // For Bootstrap components

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute(
        "content",
        isLight ? CONFIG.themeMetaColor.light : CONFIG.themeMetaColor.dark,
      );
    }
    updateMapTheme(theme);
  }

  /**
   * Updates the map's tiles and background without the white‑flash
   * caused by removing/adding layers. Swaps URL on a single cached
   * baseTileLayer instead.
   * @param {"light"|"dark"} theme
   */
  function updateMapTheme(theme) {
    if (!window.map || typeof window.map.addLayer !== "function") return;

    // 1. Change map container background
    const mapContainer =
      elements.mapContainer ||
      document.getElementById(CONFIG.selectors.mapContainer.substring(1));
    if (mapContainer) {
      mapContainer.style.background =
        theme === "light" ? CONFIG.map.lightBg : CONFIG.map.darkBg;
    }

    // 2. Swap or create the base tile layer
    const tileUrl = CONFIG.selectors.mapTileUrl[theme];
    if (!tileUrl) {
      console.warn(`Tile URL for theme “${theme}” not found in CONFIG.`);
      return;
    }

    if (baseTileLayer) {
      baseTileLayer.setUrl(tileUrl); // just swap!
    } else {
      baseTileLayer = L.tileLayer(tileUrl, {
        maxZoom: 19,
        attribution: "",
      }).addTo(window.map);
    }

    window.map.invalidateSize();
    document.dispatchEvent(
      new CustomEvent("mapThemeChanged", { detail: { theme } }),
    );
  }

  /**
   * Initializes the mobile navigation drawer.
   */
  function initMobileDrawer() {
    const { mobileDrawer, menuToggle, closeBtn, contentOverlay } = elements;
    if (!mobileDrawer || !menuToggle) return;

    const closeDrawer = () => {
      mobileDrawer.classList.remove(CONFIG.classes.open);
      contentOverlay?.classList.remove(CONFIG.classes.visible);
      document.body.style.overflow = ""; // Restore body scroll
    };

    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent event bubbling
      mobileDrawer.classList.add(CONFIG.classes.open);
      contentOverlay?.classList.add(CONFIG.classes.visible);
      document.body.style.overflow = "hidden"; // Prevent body scroll when drawer is open
    });

    closeBtn?.addEventListener("click", closeDrawer);
    contentOverlay?.addEventListener("click", closeDrawer);
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
   * Initializes the filters panel functionality.
   */
  function initFilterPanel() {
    const {
      filterToggle,
      filtersPanel,
      contentOverlay,
      filtersClose,
      quickSelectBtns,
      applyFiltersBtn,
      resetFilters,
    } = elements;

    if (filterToggle && filtersPanel) {
      filterToggle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // Only left click
        e.stopPropagation();
        filtersPanel.classList.toggle(CONFIG.classes.open);
        contentOverlay?.classList.toggle(CONFIG.classes.visible);
      });
    }

    const closePanel = () => {
      filtersPanel?.classList.remove(CONFIG.classes.open);
      contentOverlay?.classList.remove(CONFIG.classes.visible);
    };

    filtersClose?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      closePanel();
    });
    contentOverlay?.addEventListener("mousedown", (e) => {
      // Also close if clicking overlay when panel is open
      if (e.button !== 0) return;
      if (filtersPanel?.classList.contains(CONFIG.classes.open)) {
        closePanel();
      }
    });

    if (quickSelectBtns?.length) {
      quickSelectBtns.forEach((btn) => {
        btn.addEventListener("mousedown", function (e) {
          if (e.button !== 0) return; // Only left click
          const range = this.dataset.range;
          if (!range) return;

          setDateRange(range);
          quickSelectBtns.forEach((b) =>
            b.classList.remove(CONFIG.classes.active),
          );
          this.classList.add(CONFIG.classes.active);
        });
      });
    }

    applyFiltersBtn?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      applyFilters();
    });
    resetFilters?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      handleResetFiltersClick();
    });
  }

  /**
   * Initializes date pickers using Flatpickr via DateUtils.
   */
  function initDatePickers() {
    const { datepickers, startDateInput, endDateInput } = elements;
    if (!window.DateUtils) {
      console.error("DateUtils not found. Cannot initialize date pickers.");
      return;
    }

    const today = DateUtils.getCurrentDate(); // YYYY-MM-DD format
    const startDate = localStorage.getItem(CONFIG.storage.startDate) || today;
    const endDate = localStorage.getItem(CONFIG.storage.endDate) || today;

    const dateConfig = {
      maxDate: "today",
      disableMobile: true, // Use native mobile pickers if false
      dateFormat: "Y-m-d", // For the hidden input
      altInput: true, // Show a human-friendly format
      altFormat: "M j, Y", // Human-friendly format
      theme: document.body.classList.contains(CONFIG.classes.lightMode)
        ? "light"
        : "dark",
      errorHandler: (error) => console.warn("Flatpickr error:", error), // Basic error handling
    };

    if (datepickers?.length) {
      datepickers.forEach((input) => {
        // Initialize if not already initialized
        if (!input._flatpickr) {
          // _flatpickr is the instance property Flatpickr adds
          DateUtils.initDatePicker(input, dateConfig);
        }
      });
    }

    // Set initial dates for specific start/end inputs
    if (startDateInput) {
      if (startDateInput._flatpickr)
        startDateInput._flatpickr.setDate(startDate, true);
      else startDateInput.value = startDate;
    }
    if (endDateInput) {
      if (endDateInput._flatpickr)
        endDateInput._flatpickr.setDate(endDate, true);
      else endDateInput.value = endDate;
    }
  }

  /**
   * Adds the filter indicator to the DOM if it doesn't exist.
   */
  function addFilterIndicator() {
    const toolsSection =
      elements.toolsSection ||
      document.querySelector(CONFIG.selectors.toolsSection);
    if (
      !toolsSection ||
      document.getElementById(CONFIG.selectors.filterIndicator.substring(1))
    ) {
      return; // Already exists or no place to put it
    }

    const indicator = document.createElement("div");
    indicator.className = "filter-indicator me-2"; // Bootstrap margin end
    indicator.id = CONFIG.selectors.filterIndicator.substring(1); // Remove '#' for ID
    indicator.title = "Current date range filter";
    indicator.style.cursor = "pointer";
    indicator.innerHTML = `<i class="fas fa-calendar-alt me-1"></i><span class="${CONFIG.selectors.filterDateRange.substring(1)}">Today</span>`;

    const { filterToggle } = elements;
    if (filterToggle) {
      toolsSection.insertBefore(indicator, filterToggle); // Insert before the filter toggle button
    } else {
      toolsSection.appendChild(indicator); // Append if toggle not found
    }
    elements.filterIndicator = indicator; // Cache it

    indicator.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // Only left click
      // Open the filter panel when indicator is clicked
      if (elements.filtersPanel && elements.contentOverlay) {
        elements.filtersPanel.classList.add(CONFIG.classes.open);
        elements.contentOverlay.classList.add(CONFIG.classes.visible);
      }
    });
    updateFilterIndicator(); // Set initial text
  }

  /**
   * Updates the filter indicator's text to reflect the current date range.
   */
  function updateFilterIndicator() {
    const indicator =
      elements.filterIndicator ||
      document.getElementById(CONFIG.selectors.filterIndicator.substring(1));
    if (!indicator) return;
    const rangeSpan = indicator.querySelector(CONFIG.selectors.filterDateRange);
    if (!rangeSpan) return;

    if (!window.DateUtils) {
      console.error("DateUtils not found for updating filter indicator.");
      rangeSpan.textContent = "Error";
      return;
    }

    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      DateUtils.getCurrentDate();
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      DateUtils.getCurrentDate();

    const formatDisplayDate = (dateStr) =>
      DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" }) || dateStr;

    if (startDate === endDate) {
      rangeSpan.textContent = formatDisplayDate(startDate);
    } else {
      rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
    }
  }

  /**
   * Sets the date range based on a preset string (e.g., "today", "yesterday").
   * @param {string} range - The preset range key.
   */
  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;
    if (!startDateInput || !endDateInput) {
      window.notificationManager?.show(
        "UI Error: Date input elements not found.",
        "danger",
      );
      return;
    }
    if (!window.DateUtils) {
      window.notificationManager?.show(
        "Error: Date utility (DateUtils) is missing.",
        "danger",
      );
      return;
    }

    window.loadingManager?.startOperation("DateRangeSet", 100); // Indicate loading
    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
          updateDateInputs(startDate, endDate);
          localStorage.setItem(CONFIG.storage.startDate, startDate);
          localStorage.setItem(CONFIG.storage.endDate, endDate);
          updateFilterIndicator();
        } else {
          throw new Error("Received invalid date range from preset.");
        }
      })
      .catch((error) => {
        console.error("Error setting date range:", error);
        window.notificationManager?.show(
          `Error setting date range: ${error.message || "Please try again."}`,
          "danger",
        );
      })
      .finally(() => {
        window.loadingManager?.finish("DateRangeSet");
      });
  }

  /**
   * Updates date input fields with new start and end dates.
   * @param {string} startStr - The start date string (YYYY-MM-DD).
   * @param {string} endStr - The end date string (YYYY-MM-DD).
   */
  function updateDateInputs(startStr, endStr) {
    const { startDateInput, endDateInput } = elements;
    if (startDateInput) {
      if (startDateInput._flatpickr) {
        startDateInput._flatpickr.setDate(startStr, true); // Update Flatpickr instance
      } else {
        startDateInput.value = startStr; // Fallback for non-Flatpickr inputs
      }
    }
    if (endDateInput) {
      if (endDateInput._flatpickr) {
        endDateInput._flatpickr.setDate(endStr, true);
      } else {
        endDateInput.value = endStr;
      }
    }
  }

  /**
   * Initializes scroll effects, like adding a class to the header on scroll.
   */
  function initScrollEffects() {
    const { header } = elements;
    if (!header) return;

    const scrollHandler =
      window.utils?.debounce(() => {
        header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
      }, 50) ||
      (() => {
        // Fallback if debounce is not available
        header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
      });

    window.addEventListener("scroll", scrollHandler, { passive: true });
    scrollHandler(); // Initial check
  }

  /**
   * Handles window resize events, primarily for closing the mobile drawer on larger screens.
   */
  function handleResize() {
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
   * Shows the loading overlay with an optional message.
   * @param {string} [message="Loading..."] - The message to display.
   */
  function showLoading(message = "Loading...") {
    const { loadingOverlay, loadingText, progressBar } = elements;
    if (!loadingOverlay) return;

    if (loadingText) loadingText.textContent = message;
    if (progressBar) progressBar.style.width = "0%"; // Reset progress

    loadingOverlay.style.display = "flex";
    requestAnimationFrame(() => {
      // Ensure display is set before opacity transition
      loadingOverlay.style.opacity = "1";
    });
  }

  /**
   * Hides the loading overlay.
   */
  function hideLoading() {
    const { loadingOverlay, progressBar } = elements;
    if (!loadingOverlay) return;

    if (progressBar) progressBar.style.width = "100%"; // Visually complete progress
    loadingOverlay.style.opacity = "0";
    setTimeout(() => {
      loadingOverlay.style.display = "none";
    }, 400); // Match CSS transition duration
  }

  /**
   * Updates the loading progress bar and message.
   * @param {number} percent - The progress percentage (0-100).
   * @param {string} [message] - An optional message to display.
   */
  function updateProgress(percent, message) {
    const { progressBar, loadingText } = elements;
    if (progressBar) {
      progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
    if (loadingText && message) {
      loadingText.textContent = message;
    }
  }

  /**
   * Sets up a bridge for legacy code to interact with modern UI functions.
   */
  function setupLegacyCodeBridge() {
    window.modernUI = {
      showLoading,
      hideLoading,
      updateProgress,
      setDateRange,
      applyTheme,
      // Expose other necessary functions here
    };
    // Enhance map interaction once the window is fully loaded,
    // as map initialization might depend on other scripts.
    window.addEventListener("load", enhanceMapInteraction);
  }

  /**
   * Entry point for map enhancements. Called on 'mapInitialized' or 'load'.
   */
  function enhanceMapInteraction() {
    // Ensure map container exists before trying to enhance
    if (
      !elements.mapContainer &&
      !document.getElementById(CONFIG.selectors.mapContainer.substring(1))
    ) {
      // console.warn("Map container not found for enhancements.");
      return;
    }
    applyMapEnhancements();
  }

  /**
   * Applies enhancements to the Leaflet map (zoom tooltips, connection status).
   */
  function applyMapEnhancements() {
    try {
      const map = window.map; // Assumes map is globally available
      if (!map?.options) {
        // console.warn("Leaflet map object (window.map) not found or not initialized.");
        return;
      }

      map.options.zoomSnap = CONFIG.map.zoomSnap; // Standardize zoom snap

      // Add tooltips to zoom controls if Bootstrap is available
      if (window.bootstrap?.Tooltip && elements.zoomControls?.length) {
        elements.zoomControls.forEach((control) => {
          if (!bootstrap.Tooltip.getInstance(control)) {
            // Avoid re-initializing
            let title = "";
            if (control.classList.contains("leaflet-control-zoom-in"))
              title = "Zoom In";
            else if (control.classList.contains("leaflet-control-zoom-out"))
              title = "Zoom Out";

            if (title) {
              new bootstrap.Tooltip(control, {
                title: title,
                placement: "left",
                delay: CONFIG.tooltipDelay,
                trigger: "hover", // Show on hover
              });
            }
          }
        });
      }

      // Update connection status indicator
      const { statusIndicator, statusText } = elements;
      if (statusIndicator && statusText) {
        const updateConnectionIndicator = () => {
          const textContentLower = statusText.textContent.toLowerCase();
          statusIndicator.classList.toggle(
            CONFIG.classes.connected,
            textContentLower.includes("connected"),
          );
          statusIndicator.classList.toggle(
            CONFIG.classes.disconnected,
            textContentLower.includes("disconnected") &&
              !textContentLower.includes("connected"),
          );
        };
        updateConnectionIndicator(); // Initial update
        setInterval(updateConnectionIndicator, 3000); // Periodically update
      }

      // Map controls opacity behavior
      const { mapControls } = elements;
      if (mapControls) {
        mapControls.addEventListener("mouseenter", () => {
          mapControls.style.opacity = "1";
        });
        mapControls.addEventListener("mouseleave", updateMapControlsOpacity);
        updateMapControlsOpacity(); // Set initial opacity
      }
    } catch (error) {
      console.error("Error applying map enhancements:", error);
      window.handleError?.(error, "Error applying map enhancements");
    }
  }

  /**
   * Updates map controls opacity based on whether it's minimized or hovered.
   */
  function updateMapControlsOpacity() {
    const { mapControls } = elements;
    if (!mapControls) return;
    // If mouse is over the controls, it should be fully opaque (handled by mouseenter)
    // Otherwise, set opacity based on minimized state
    if (!mapControls.matches(":hover")) {
      mapControls.style.opacity = mapControls.classList.contains(
        CONFIG.classes.minimized,
      )
        ? "0.8"
        : "1";
    }
  }

  /**
   * Applies selected date filters, updates storage, and dispatches an event.
   */
  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;
    if (!startDateInput || !endDateInput) {
      window.notificationManager?.show(
        "UI Error: Date input elements are missing.",
        "danger",
      );
      return;
    }
    const startDateValue = startDateInput.value; // Assumes YYYY-MM-DD from Flatpickr
    const endDateValue = endDateInput.value;

    if (!window.DateUtils?.isValidDateRange(startDateValue, endDateValue)) {
      window.notificationManager?.show(
        "Invalid date range: Start date must be before or the same as the end date.",
        "warning",
      );
      return;
    }

    localStorage.setItem(CONFIG.storage.startDate, startDateValue);
    localStorage.setItem(CONFIG.storage.endDate, endDateValue);
    updateFilterIndicator();

    // Close filter panel
    if (filtersPanel && contentOverlay) {
      filtersPanel.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
    }

    document.dispatchEvent(
      new CustomEvent("filtersApplied", {
        detail: { startDate: startDateValue, endDate: endDateValue },
      }),
    );
    window.notificationManager?.show(
      `Filters applied: ${DateUtils.formatForDisplay(startDateValue)} to ${DateUtils.formatForDisplay(endDateValue)}`,
      "success",
    );
  }

  /**
   * Handles resetting filters to "today" and updates UI accordingly.
   */
  function handleResetFiltersClick() {
    const { quickSelectBtns } = elements;
    if (!window.DateUtils) {
      window.notificationManager?.show(
        "Error: Date utility (DateUtils) is missing.",
        "danger",
      );
      return;
    }

    const today = DateUtils.getCurrentDate(); // YYYY-MM-DD
    updateDateInputs(today, today);
    localStorage.setItem(CONFIG.storage.startDate, today);
    localStorage.setItem(CONFIG.storage.endDate, today);

    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) =>
        btn.classList.remove(CONFIG.classes.active),
      );
      const todayBtn = document.querySelector(
        `.quick-select-btn[data-range="today"]`,
      );
      todayBtn?.classList.add(CONFIG.classes.active);
    }
    updateFilterIndicator();
    applyFilters(); // Apply the reset dates
  }

  // --- Initialization ---
  // Ensure init() is called only once.
  function runInit() {
    if (!window.modernUIInitialized) {
      init();
      window.modernUIInitialized = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInit);
  } else {
    // DOMContentLoaded has already fired
    runInit();
  }
  // Fallback or alternative trigger for initialization
  document.addEventListener("appReady", runInit);
})();

/* ===== Global passive event listeners for scroll‑related events ===== */
(function () {
  const passiveEvents = ["wheel", "touchmove", "mousemove", "pointermove"];
  passiveEvents.forEach((evt) => {
    window.addEventListener(evt, () => {}, { passive: true });
  });
})();
