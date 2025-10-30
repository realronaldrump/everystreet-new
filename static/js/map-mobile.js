/* Mobile Map Interface - iOS Native Feel */

"use strict";

class MobileMapInterface {
  constructor() {
    this.isMobile = window.innerWidth <= 768;
    this.sheet = null;
    this.backdrop = null;
    this.handle = null;
    this.sheetContent = null;

    // Sheet states
    this.states = {
      collapsed: { transform: "calc(100% - 120px)" },
      peek: { transform: "calc(100% - 200px)" },
      half: { transform: "50%" },
      expanded: { transform: "0" },
    };
    this.currentState = "collapsed";

    // Touch handling
    this.startY = 0;
    this.currentY = 0;
    this.isDragging = false;
    this.startScrollTop = 0;

    this.init();
  }

  init() {
    if (!this.isMobile) return;

    // Get DOM elements
    this.sheet = document.querySelector(".mobile-bottom-sheet");
    this.backdrop = document.querySelector(".mobile-sheet-backdrop");
    this.handle = document.querySelector(".mobile-sheet-handle");
    this.sheetContent = document.querySelector(".mobile-sheet-content");

    if (!this.sheet || !this.backdrop || !this.handle) {
      console.warn("Mobile sheet elements not found");
      return;
    }

    this.setupEventListeners();
    this.syncWithDesktop();
    this.addBodyClass();
  }

  addBodyClass() {
    document.body.classList.add("map-page");
  }

  setupEventListeners() {
    // Handle dragging
    this.handle.addEventListener(
      "touchstart",
      this.handleTouchStart.bind(this),
      { passive: false },
    );
    this.handle.addEventListener("touchmove", this.handleTouchMove.bind(this), {
      passive: false,
    });
    this.handle.addEventListener("touchend", this.handleTouchEnd.bind(this), {
      passive: false,
    });

    // Prevent content scrolling when at top and trying to expand
    this.sheetContent.addEventListener("touchstart", (e) => {
      this.startScrollTop = this.sheetContent.scrollTop;
    });

    this.sheetContent.addEventListener(
      "touchmove",
      (e) => {
        const scrollTop = this.sheetContent.scrollTop;
        const isAtTop = scrollTop <= 0;

        // If at top and pulling down, allow sheet drag
        if (isAtTop && this.startScrollTop <= 0) {
          const touch = e.touches[0];
          if (touch.clientY > this.startY) {
            // Pulling down
            e.preventDefault();
          }
        }
      },
      { passive: false },
    );

    // Backdrop click to collapse
    this.backdrop.addEventListener("click", () => {
      this.setState("collapsed");
    });

    // FAB buttons
    document
      .getElementById("mobile-center-location")
      ?.addEventListener("click", () => {
        document.getElementById("center-on-location")?.click();
      });

    document
      .getElementById("mobile-fit-bounds")
      ?.addEventListener("click", () => {
        document.getElementById("fit-bounds")?.click();
      });

    document.getElementById("mobile-refresh")?.addEventListener("click", () => {
      document.getElementById("refresh-map")?.click();
      this.showFeedback("Refreshing map...");
    });

    // Search
    const mobileSearch = document.getElementById("mobile-map-search");
    const desktopSearch = document.getElementById("map-search-input");

    if (mobileSearch && desktopSearch) {
      mobileSearch.addEventListener("input", (e) => {
        desktopSearch.value = e.target.value;
        desktopSearch.dispatchEvent(new Event("input", { bubbles: true }));
      });

      // Clear search
      document
        .getElementById("mobile-clear-search")
        ?.addEventListener("click", () => {
          mobileSearch.value = "";
          desktopSearch.value = "";
          document
            .getElementById("mobile-clear-search")
            .classList.add("d-none");
          desktopSearch.dispatchEvent(new Event("input", { bubbles: true }));
        });

      mobileSearch.addEventListener("input", (e) => {
        const clearBtn = document.getElementById("mobile-clear-search");
        if (clearBtn) {
          clearBtn.classList.toggle("d-none", !e.target.value);
        }
      });
    }

    // Highlight recent toggle
    const mobileHighlight = document.getElementById("mobile-highlight-recent");
    const desktopHighlight = document.getElementById("highlight-recent-trips");

    if (mobileHighlight && desktopHighlight) {
      mobileHighlight.addEventListener("change", (e) => {
        desktopHighlight.checked = e.target.checked;
        desktopHighlight.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    // Street location
    const mobileLocation = document.getElementById("mobile-streets-location");
    const desktopLocation = document.getElementById("streets-location");

    if (mobileLocation && desktopLocation) {
      mobileLocation.addEventListener("change", (e) => {
        desktopLocation.value = e.target.value;
        desktopLocation.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Sync options
      this.syncLocationOptions();
    }

    // Street mode buttons
    document.querySelectorAll(".mobile-street-mode-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const mode = e.currentTarget.dataset.mode;
        document
          .querySelectorAll(".mobile-street-mode-btn")
          .forEach((b) => b.classList.remove("active"));
        e.currentTarget.classList.add("active");

        // Trigger desktop buttons
        const desktopBtn = document.querySelector(
          `.street-toggle-btn[data-street-mode="${mode}"]`,
        );
        if (desktopBtn) {
          desktopBtn.click();
        }
      });
    });

    // Actions
    document
      .getElementById("mobile-download-view")
      ?.addEventListener("click", () => {
        document.getElementById("download-view")?.click();
        this.showFeedback("Preparing download...");
      });

    document
      .getElementById("mobile-view-trips")
      ?.addEventListener("click", () => {
        window.location.href = "/trips";
      });

    // Listen for desktop updates
    this.listenForDesktopUpdates();
  }

  handleTouchStart(e) {
    this.isDragging = true;
    this.startY = e.touches[0].clientY;
    this.sheet.style.transition = "none";
  }

  handleTouchMove(e) {
    if (!this.isDragging) return;

    e.preventDefault();
    this.currentY = e.touches[0].clientY;
    const deltaY = this.currentY - this.startY;

    // Only allow dragging down from expanded, or up from collapsed
    if (this.currentState === "expanded" && deltaY < 0) return;
    if (this.currentState === "collapsed" && deltaY > 0) return;

    // Calculate new position
    const currentTransform = this.getTransformValue(this.currentState);
    const newTransform = Math.max(
      0,
      Math.min(window.innerHeight, currentTransform + deltaY),
    );

    this.sheet.style.transform = `translateY(${newTransform}px)`;

    // Update backdrop opacity
    const progress = 1 - newTransform / window.innerHeight;
    this.backdrop.style.opacity = progress * 0.3;

    if (progress > 0.1) {
      this.backdrop.classList.add("visible");
    }
  }

  handleTouchEnd(e) {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.sheet.style.transition = "";

    const deltaY = this.currentY - this.startY;
    const velocity = Math.abs(deltaY);

    // Determine new state based on direction and velocity
    let newState = this.currentState;

    if (velocity > 50) {
      // Fast swipe
      if (deltaY > 0) {
        // Swiping down
        newState = this.getNextStateDown();
      } else {
        // Swiping up
        newState = this.getNextStateUp();
      }
    } else {
      // Slow drag - snap to nearest state
      const currentTransform = this.getTransformValue(this.currentState);
      const newTransform = currentTransform + deltaY;
      newState = this.getNearestState(newTransform);
    }

    this.setState(newState);
  }

  getTransformValue(state) {
    const transform = this.states[state].transform;
    if (transform === "0") return 0;

    // Parse calc expression
    const match = transform.match(/calc\(100% - (\d+)px\)/);
    if (match) {
      return window.innerHeight - parseInt(match[1]);
    }

    const percentMatch = transform.match(/(\d+)%/);
    if (percentMatch) {
      return window.innerHeight * (parseInt(percentMatch[1]) / 100);
    }

    return 0;
  }

  getNextStateUp() {
    switch (this.currentState) {
      case "collapsed":
        return "peek";
      case "peek":
        return "half";
      case "half":
        return "expanded";
      case "expanded":
        return "expanded";
      default:
        return "peek";
    }
  }

  getNextStateDown() {
    switch (this.currentState) {
      case "expanded":
        return "half";
      case "half":
        return "peek";
      case "peek":
        return "collapsed";
      case "collapsed":
        return "collapsed";
      default:
        return "collapsed";
    }
  }

  getNearestState(transformValue) {
    const states = ["collapsed", "peek", "half", "expanded"];
    let nearest = "collapsed";
    let minDistance = Infinity;

    states.forEach((state) => {
      const stateValue = this.getTransformValue(state);
      const distance = Math.abs(transformValue - stateValue);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = state;
      }
    });

    return nearest;
  }

  setState(state) {
    this.currentState = state;

    // Remove all state classes
    Object.keys(this.states).forEach((s) => {
      this.sheet.classList.remove(s);
    });

    // Add new state class
    this.sheet.classList.add(state);

    // Update backdrop
    if (state === "expanded" || state === "half") {
      this.backdrop.classList.add("visible");
    } else {
      this.backdrop.classList.remove("visible");
    }
  }

  syncWithDesktop() {
    // Sync initial values
    this.syncMetrics();
    this.syncLayers();
    this.syncLocationOptions();
    this.syncLiveTracking();

    // Set up periodic sync for metrics
    setInterval(() => {
      this.syncMetrics();
      this.syncLiveTracking();
    }, 2000);
  }

  syncMetrics() {
    // Sync trip metrics
    const metrics = {
      "mobile-total-trips": "total-trips",
      "mobile-total-distance": "total-distance",
      "mobile-avg-speed": "avg-speed",
      "mobile-max-speed": "max-speed",
    };

    Object.entries(metrics).forEach(([mobileId, desktopId]) => {
      const desktopEl = document.getElementById(desktopId);
      const mobileEl = document.getElementById(mobileId);

      if (desktopEl && mobileEl) {
        mobileEl.textContent = desktopEl.textContent;
      }
    });
  }

  syncLayers() {
    const desktopToggles = document.getElementById("layer-toggles");
    const mobileContainer = document.getElementById("mobile-layer-toggles");

    if (!desktopToggles || !mobileContainer) return;

    // Clear mobile container
    mobileContainer.innerHTML = "";

    // Create mobile layer buttons from desktop toggles
    const checkboxes = desktopToggles.querySelectorAll(
      'input[type="checkbox"]',
    );
    checkboxes.forEach((checkbox) => {
      const label = checkbox.closest(".form-check")?.querySelector("label");
      if (!label) return;

      const btn = document.createElement("button");
      btn.className = `mobile-layer-btn ${checkbox.checked ? "active" : ""}`;
      btn.innerHTML = `<i class="fas fa-layer-group"></i> ${label.textContent.trim()}`;

      btn.addEventListener("click", () => {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        btn.classList.toggle("active", checkbox.checked);
      });

      mobileContainer.appendChild(btn);

      // Listen for desktop changes
      checkbox.addEventListener("change", () => {
        btn.classList.toggle("active", checkbox.checked);
      });
    });
  }

  syncLocationOptions() {
    const desktopLocation = document.getElementById("streets-location");
    const mobileLocation = document.getElementById("mobile-streets-location");

    if (!desktopLocation || !mobileLocation) return;

    // Copy options
    mobileLocation.innerHTML = desktopLocation.innerHTML;
    mobileLocation.value = desktopLocation.value;
  }

  syncLiveTracking() {
    const desktopCount = document.getElementById("active-trips-count");
    const mobileCount = document.getElementById("mobile-active-count");
    const mobileStatus = document.getElementById("mobile-live-status");
    const desktopStatus = document.querySelector(".live-status-text");

    if (desktopCount && mobileCount) {
      mobileCount.textContent = desktopCount.textContent;
    }

    if (desktopStatus && mobileStatus) {
      const isConnected = desktopStatus.textContent
        .toLowerCase()
        .includes("connected");
      mobileStatus.classList.toggle("disconnected", !isConnected);
      mobileStatus.querySelector("span:last-child").textContent = isConnected
        ? "Live"
        : "Offline";
    }

    // Sync trip metrics
    const desktopMetrics = document.querySelector(
      "#live-tracking-panel .live-trip-metrics",
    );
    const mobileMetrics = document.getElementById("mobile-trip-metrics");

    if (desktopMetrics && mobileMetrics) {
      mobileMetrics.innerHTML = desktopMetrics.innerHTML;
    }
  }

  listenForDesktopUpdates() {
    // Listen for custom events from desktop controls
    document.addEventListener("metricsUpdated", () => {
      this.syncMetrics();
    });

    document.addEventListener("layersUpdated", () => {
      this.syncLayers();
    });

    document.addEventListener("liveTrackingUpdated", () => {
      this.syncLiveTracking();
    });
  }

  showFeedback(message) {
    if (window.notificationManager) {
      window.notificationManager.show(message, "info");
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.mobileMapInterface = new MobileMapInterface();
  });
} else {
  window.mobileMapInterface = new MobileMapInterface();
}
