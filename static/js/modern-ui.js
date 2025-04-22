/* global L, flatpickr, notificationManager, bootstrap, DateUtils, $ */

"use strict";
(function () {
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

  const elements = {};

  function init() {
    try {
      cacheElements();

      initThemeToggle();
      initMobileDrawer();
      initFilterPanel();
      initScrollEffects();
      initDatePickers();
      initMapControls();
      setupLegacyCodeBridge();

      window.addEventListener(
        "resize",
        window.utils?.debounce(handleResize, 250) ||
          window.utils.debounce(handleResize, 250),
      );
      handleResize();

      document.addEventListener("mapInitialized", () => {
        console.info("Map initialization detected by modern-ui.js");
        enhanceMapInteraction();
      });
    } catch (error) {
      console.error("Error initializing Modern UI:", error);
      window.notificationManager?.show(
        `Error initializing UI: ${error.message}`,
        "danger",
      );
    }
  }

  function cacheElements() {
    const selectors = CONFIG.selectors;
    const selectorKeys = Object.keys(selectors).filter(
      (key) => typeof selectors[key] === "string",
    );

    selectorKeys.forEach((key) => {
      if (key === "startDate" || key === "endDate") {
        elements[`${key}Input`] = document.querySelector(
          `#filters-panel ${selectors[key]}`,
        );
      } else {
        elements[key] = document.querySelector(selectors[key]);
      }
    });
    if (!elements.startDateInput) elements.startDateInput = elements.startDate;
    if (!elements.endDateInput) elements.endDateInput = elements.endDate;

    elements.quickSelectBtns = document.querySelectorAll(".quick-select-btn");
    elements.datepickers = document.querySelectorAll(
      CONFIG.selectors.datepicker,
    );
    elements.loadingOverlay = document.querySelector(".loading-overlay");
    elements.progressBar = document.querySelector(
      ".loading-overlay .progress-bar",
    );
    elements.loadingText = document.querySelector(
      ".loading-overlay .loading-text",
    );

    elements.applyFiltersBtn = document.getElementById("apply-filters");
    elements.resetFiltersBtn = document.getElementById("reset-filters");
  }

  function initMapControls() {
    const mapControls =
      elements.mapControls || document.getElementById("map-controls");
    if (!mapControls) return;

    mapControls.style.touchAction = "pan-y";
    mapControls.style.webkitOverflowScrolling = "touch";
    mapControls.style.overflowY = "auto";

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
              const _ = new window.bootstrap.Collapse(controlsContent, {
                toggle: !mapControls.classList.contains("minimized"),
              });
            }
          }
        }

        const icon = this.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-up");
          icon.classList.toggle("fa-chevron-down");
        }
      });
    }

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

    events.forEach((eventType) => {
      mapControls.addEventListener(
        eventType,
        (e) => {
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

          if (!isFormElement) {
            e.stopPropagation();
          }
        },
        { passive: true },
      );
    });

    mapControls.addEventListener(
      "touchmove",
      (e) => {
        e.stopPropagation();
      },
      { passive: true },
    );

    mapControls.style.cursor = "default";

    mapControls.classList.add("map-controls-event-handler");

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

    window.handleError(
      "Map controls initialized and event propagation handlers set up",
      "initMapControls",
      "info",
    );

    // Add event listener for the center on location button
    const centerButton = document.getElementById('center-on-location');
    if (centerButton) {
      centerButton.addEventListener('click', () => {
        if (!window.map) {
          console.warn("Map not available to center.");
          window.notificationManager?.show("Map is not ready yet.", "warning");
          return;
        }

        let targetLatLng = null;
        let locationSource = null;

        // 1. Try live tracker location
        if (window.liveTracker && window.liveTracker.activeTrip && window.liveTracker.activeTrip.coordinates && window.liveTracker.activeTrip.coordinates.length > 0) {
          const coords = window.liveTracker.activeTrip.coordinates;
          const lastCoord = coords[coords.length - 1]; // Assuming last is latest
          if (lastCoord && typeof lastCoord.lat === 'number' && typeof lastCoord.lon === 'number') {
            targetLatLng = [lastCoord.lat, lastCoord.lon];
            locationSource = "live location";
            console.log("Using live location from tracker.");
          }
        }

        // 2. Try last known location from DrivingNavigation (if it exists)
        if (!targetLatLng && window.drivingNavigation && window.drivingNavigation.lastKnownLocation) {
            targetLatLng = [window.drivingNavigation.lastKnownLocation.lat, window.drivingNavigation.lastKnownLocation.lon];
            locationSource = "last known location";
            console.log("Using last known location from DrivingNavigation.");
        }

        // 3. Fallback: Last point of the most recent trip
        const tripsLayerData = window.AppState?.mapLayers?.trips?.layer;
        if (!targetLatLng && tripsLayerData && Array.isArray(tripsLayerData.features) && tripsLayerData.features.length > 0) {
          console.log("Attempting fallback: Found trips layer with features.", tripsLayerData.features.length, "features found.");
          const features = tripsLayerData.features;
          let lastTripFeature = null;
          let latestTime = 0;

          features.forEach(feature => {
            const endTime = feature.properties?.endTime;
            if (endTime) {
              const time = new Date(endTime).getTime();
              if (!isNaN(time) && time > latestTime) {
                latestTime = time;
                lastTripFeature = feature;
              }
            }
          });

          if (lastTripFeature) {
            console.log("Found last trip feature:", lastTripFeature.properties?.id || lastTripFeature.properties?.transactionId, " ended at ", new Date(latestTime));
            const geomType = lastTripFeature.geometry?.type;
            const coords = lastTripFeature.geometry?.coordinates;
            let lastCoord = null;
            if (geomType === "LineString" && Array.isArray(coords) && coords.length > 0) {
              lastCoord = coords[coords.length - 1];
            } else if (geomType === "Point" && Array.isArray(coords)) {
              lastCoord = coords;
            }

            if (Array.isArray(lastCoord) && lastCoord.length === 2 && typeof lastCoord[0] === 'number' && typeof lastCoord[1] === 'number') {
              targetLatLng = [lastCoord[1], lastCoord[0]]; // GeoJSON is [lng, lat]
               locationSource = "last trip end";
               console.log("Extracted last coordinate:", targetLatLng);
            } else {
               console.warn("Could not extract valid last coordinate from the most recent trip feature:", lastTripFeature);
            }
          } else {
              console.warn("Could not find the most recent trip feature among available features (latestTime=", latestTime, "). Ensure trips have valid 'endTime' properties.");
          }
        } else if (!targetLatLng) {
           // Log why the fallback condition failed
           console.log("Fallback condition not met. Checking AppState and trips layer:");
           console.log(`- window.AppState exists: ${!!window.AppState}`);
           if (window.AppState) {
               console.log(`- window.AppState.mapLayers exists: ${!!window.AppState.mapLayers}`);
               if (window.AppState.mapLayers) {
                   const tripsLayer = window.AppState.mapLayers.trips;
                   console.log(`- window.AppState.mapLayers.trips exists: ${!!tripsLayer}`);
                   if (tripsLayer) {
                       console.log(`- window.AppState.mapLayers.trips.layer exists: ${!!tripsLayer.layer}`);
                       if (tripsLayer.layer) {
                           const features = tripsLayer.layer.features;
                           console.log(`- window.AppState.mapLayers.trips.layer.features is Array: ${Array.isArray(features)}`);
                           if (Array.isArray(features)) {
                               console.log(`- window.AppState.mapLayers.trips.layer.features.length: ${features.length}`);
                           }
                       }
                   }
               }
           }
        }

        // Final action based on targetLatLng
        if (targetLatLng) {
          console.info(`Centering map on ${locationSource}:`, targetLatLng);
          window.map.flyTo(targetLatLng, window.map.getZoom() < 14 ? 14 : window.map.getZoom(), { // Zoom in if far out
            animate: true,
            duration: 1.5 // seconds
          });
           window.notificationManager?.show(`Centered map on ${locationSource}.`, "info");
        } else {
          console.warn("Could not determine location to center on.");
          window.notificationManager?.show("Could not determine current or last known location.", "warning");
        }
      });
    }
  }

  function initThemeToggle() {
    const { themeToggle, darkModeToggle } = elements;
    if (!themeToggle && !darkModeToggle) return;

    const savedTheme = localStorage.getItem(CONFIG.storage.theme);
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const isLight =
      savedTheme === "light" || (!savedTheme && !prefersDarkScheme);
    const themeName = isLight ? "light" : "dark";

    applyTheme(themeName);

    if (themeToggle) {
      themeToggle.checked = isLight;
      themeToggle.addEventListener("change", () => {
        const newTheme = themeToggle.checked ? "light" : "dark";
        applyTheme(newTheme);
        localStorage.setItem(CONFIG.storage.theme, newTheme);

        if (darkModeToggle) {
          darkModeToggle.checked = newTheme === "dark";
        }

        document.dispatchEvent(
          new CustomEvent("themeChanged", { detail: { theme: newTheme } }),
        );
      });
    }
  }

  function applyTheme(theme) {
    const isLight = theme === "light";

    document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
    document.documentElement.setAttribute("data-bs-theme", theme);

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", isLight ? "#f8f9fa" : "#121212");
    }

    updateMapTheme(theme);
  }

  function updateMapTheme(theme) {
    if (!window.map || typeof window.map.eachLayer !== "function") return;

    document.querySelectorAll(".leaflet-container").forEach((container) => {
      container.style.background = theme === "light" ? "#e0e0e0" : "#1a1a1a";
    });

    window.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        window.map.removeLayer(layer);
      }
    });

    const tileUrl = CONFIG.selectors.mapTileUrl[theme];
    L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution: "",
    }).addTo(window.map);

    window.map.invalidateSize();

    document.dispatchEvent(
      new CustomEvent("mapThemeChanged", { detail: { theme } }),
    );
  }

  function initMobileDrawer() {
    const { mobileDrawer, menuToggle, closeBtn, contentOverlay } = elements;
    if (!mobileDrawer || !menuToggle) return;

    const closeDrawer = () => {
      mobileDrawer.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
      document.body.style.overflow = "";
    };

    menuToggle.addEventListener("click", () => {
      mobileDrawer.classList.add(CONFIG.classes.open);
      contentOverlay.classList.add(CONFIG.classes.visible);
      document.body.style.overflow = "hidden";
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

    addFilterIndicator();

    if (filterToggle && filtersPanel) {
      filterToggle.addEventListener("click", () => {
        filtersPanel.classList.toggle(CONFIG.classes.open);
        contentOverlay.classList.toggle(CONFIG.classes.visible);
        updateFilterIndicator();
      });
    }

    const closePanel = () => {
      filtersPanel?.classList.remove(CONFIG.classes.open);
      contentOverlay?.classList.remove(CONFIG.classes.visible);
    };

    filtersClose?.addEventListener("click", closePanel);
    contentOverlay?.addEventListener("click", closePanel);

    if (quickSelectBtns?.length) {
      quickSelectBtns.forEach((btn) => {
        btn.addEventListener("click", function () {
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

    applyFiltersBtn?.addEventListener("click", applyFilters);

    resetFiltersBtn?.addEventListener("click", resetFilters);
  }

  function initDatePickers() {
    const { datepickers, startDateInput, endDateInput } = elements;

    const today = DateUtils.getCurrentDate();
    const startDate = localStorage.getItem(CONFIG.storage.startDate) || today;
    const endDate = localStorage.getItem(CONFIG.storage.endDate) || today;

    const dateConfig = {
      maxDate: "today",
      disableMobile: true,
      theme: document.body.classList.contains(CONFIG.classes.lightMode)
        ? "light"
        : "dark",
    };

    if (datepickers?.length) {
      datepickers.forEach((input) => {
        if (!input._flatpickr) {
          DateUtils.initDatePicker(input, dateConfig);
        }
      });
    }

    if (!elements.startDateInput)
      elements.startDateInput = document.querySelector(
        CONFIG.selectors.startDate,
      );
    if (!elements.endDateInput)
      elements.endDateInput = document.querySelector(CONFIG.selectors.endDate);

    if (elements.startDateInput) {
      elements.startDateInput.value = startDate;
      if (elements.startDateInput._flatpickr) {
        elements.startDateInput._flatpickr.setDate(startDate);
      }
    }

    if (elements.endDateInput) {
      elements.endDateInput.value = endDate;
      if (elements.endDateInput._flatpickr) {
        elements.endDateInput._flatpickr.setDate(endDate);
      }
    }
  }

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

    const { filtersToggle } = elements;
    if (filtersToggle) {
      toolsSection.insertBefore(indicator, filtersToggle);
    } else {
      toolsSection.appendChild(indicator);
    }

    indicator.addEventListener("click", () => {
      if (elements.filtersPanel && elements.contentOverlay) {
        elements.filtersPanel.classList.add(CONFIG.classes.open);
        elements.contentOverlay.classList.add(CONFIG.classes.visible);
      }
    });

    updateFilterIndicator();
  }

  function updateFilterIndicator() {
    const indicator = document.getElementById("filter-indicator");
    if (!indicator) return;

    const rangeSpan = indicator.querySelector(".filter-date-range");
    if (!rangeSpan) return;

    const startDate =
      localStorage.getItem(CONFIG.storage.startDate) ||
      DateUtils.getCurrentDate();
    const endDate =
      localStorage.getItem(CONFIG.storage.endDate) ||
      DateUtils.getCurrentDate();

    const formatDisplayDate = (dateStr) =>
      window.DateUtils?.formatForDisplay(dateStr, { dateStyle: "medium" }) ||
      dateStr;

    if (startDate === endDate) {
      rangeSpan.textContent = formatDisplayDate(startDate);
    } else {
      rangeSpan.textContent = `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;
    }
  }

  function setDateRange(range) {
    const { startDateInput, endDateInput } = elements;
    if (!startDateInput || !endDateInput) {
      console.error(
        "Date input elements not found in modern-ui.js cache. Cannot set date range.",
      );
      window.notificationManager?.show(
        "UI Error: Date inputs not found.",
        "danger",
      );
      return;
    }

    if (window.loadingManager) {
      window.loadingManager.startOperation("DateRangeSet", 100);
    }

    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
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

  function updateDateInputs(startStr, endStr) {
    if (elements.startDateInput) {
      elements.startDateInput.value = startStr;
      if (elements.startDateInput._flatpickr) {
        elements.startDateInput._flatpickr.setDate(startStr);
      }
    } else {
      console.warn("Cached start date input not found in updateDateInputs");
    }

    if (elements.endDateInput) {
      elements.endDateInput.value = endStr;
      if (elements.endDateInput._flatpickr) {
        elements.endDateInput._flatpickr.setDate(endStr);
      }
    } else {
      console.warn("Cached end date input not found in updateDateInputs");
    }
  }

  function applyFilters() {
    const { startDateInput, endDateInput, filtersPanel, contentOverlay } =
      elements;
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

    localStorage.setItem(CONFIG.storage.startDate, startDateValue);
    localStorage.setItem(CONFIG.storage.endDate, endDateValue);

    updateFilterIndicator();

    if (filtersPanel && contentOverlay) {
      filtersPanel.classList.remove(CONFIG.classes.open);
      contentOverlay.classList.remove(CONFIG.classes.visible);
    }

    document.dispatchEvent(
      new CustomEvent("filtersApplied", {
        detail: {
          startDate: startDateValue,
          endDate: endDateValue,
        },
      }),
    );

    window.notificationManager?.show(
      `Filters applied: ${startDateValue} to ${endDateValue}`,
      "success",
    );
  }

  function resetFilters() {
    const { quickSelectBtns } = elements;
    const today = new Date().toISOString().split("T")[0];

    updateDateInputs(today, today);

    localStorage.setItem(CONFIG.storage.startDate, today);
    localStorage.setItem(CONFIG.storage.endDate, today);

    if (quickSelectBtns) {
      quickSelectBtns.forEach((btn) =>
        btn.classList.remove(CONFIG.classes.active),
      );
    }

    updateFilterIndicator();

    applyFilters();

    window.notificationManager?.show(
      "Date filters reset to Today and applied.",
      "info",
    );
  }

  function initScrollEffects() {
    const { header } = elements;
    if (!header) return;

    const scrollHandler = () => {
      header.classList.toggle(CONFIG.classes.scrolled, window.scrollY > 10);
    };

    window.addEventListener("scroll", scrollHandler);
    scrollHandler();
  }

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

  function refreshMapData() {
    if (window.map) {
      if (typeof window.EveryStreet?.App?.fetchTrips === "function") {
        window.EveryStreet.App.fetchTrips();
      } else if (typeof window.fetchTrips === "function") {
        window.fetchTrips();
      }
    }
  }

  function refreshPlacesData() {
    if (window.customPlaces?.loadPlaces) {
      window.customPlaces.loadPlaces();
    }
  }

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

  function setupLegacyCodeBridge() {
    window.modernUI = {
      showLoading,
      hideLoading,
      updateProgress,
      setDateRange,
      applyTheme,
    };

    window.addEventListener("load", enhanceMapInteraction);
  }

  function enhanceMapInteraction() {
    if (!document.getElementById("map")) return;

    applyMapEnhancements();
  }

  function applyMapEnhancements() {
    try {
      const map = window.map;
      if (!map || typeof map.eachLayer !== "function" || !map.options) {
        return;
      }

      if (map.options) map.options.zoomSnap = 0.5;

      const zoomControls = document.querySelectorAll(".leaflet-control-zoom a");
      if (window.bootstrap?.Tooltip) {
        zoomControls.forEach((control) => {
          if (control.classList.contains("leaflet-control-zoom-in")) {
            new bootstrap.Tooltip(control, {
              title: "Zoom In",
              placement: "left",
              delay: { show: 500, hide: 100 },
            });
          } else if (control.classList.contains("leaflet-control-zoom-out")) {
            new bootstrap.Tooltip(control, {
              title: "Zoom Out",
              placement: "left",
              delay: { show: 500, hide: 100 },
            });
          }
        });
      }

      const updateConnectionIndicator = () => {
        const statusIndicator = document.querySelector(".status-indicator");
        const statusText = document.querySelector(".status-text");

        if (statusIndicator && statusText) {
          if (statusText.textContent.toLowerCase().includes("connected")) {
            statusIndicator.classList.add("connected");
            statusIndicator.classList.remove("disconnected");
          } else if (
            statusText.textContent.toLowerCase().includes("disconnected")
          ) {
            statusIndicator.classList.add("disconnected");
            statusIndicator.classList.remove("connected");
          }
        }
      };

      updateConnectionIndicator();
      setInterval(updateConnectionIndicator, 3000);

      const controlsToggle = document.getElementById("controls-toggle");
      const mapControls = document.getElementById("map-controls");

      if (controlsToggle && mapControls) {
        controlsToggle.addEventListener("click", () => {
          requestAnimationFrame(() => {
            if (mapControls.classList.contains("minimized")) {
              mapControls.style.opacity = "0.8";
            } else {
              mapControls.style.opacity = "1";
            }
          });
        });

        mapControls.addEventListener("mouseenter", () => {
          mapControls.style.opacity = "1";
        });

        mapControls.addEventListener("mouseleave", () => {
          if (mapControls.classList.contains("minimized")) {
            mapControls.style.opacity = "0.8";
          }
        });
      }

      window.handleError(
        "Map enhancements applied successfully",
        "applyMapEnhancements",
        "info",
      );
    } catch (error) {
      window.handleError(error, "Error applying map enhancements");
    }
  }

  document.addEventListener("appReady", init);
})();
