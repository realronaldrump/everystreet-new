/* Mobile Map Interface - iOS Native Feel */

"use strict";

class MobileMapInterface {
  constructor() {
    this.isMobile = MobileMapInterface.detectMobileViewport();
    if (!this.isMobile) {
      return;
    }

    // DOM references
    this.sheet = null;
    this.backdrop = null;
    this.handle = null;
    this.header = null;
    this.sheetContent = null;

    this.mobileSearch = null;
    this.desktopSearch = null;
    this.mobileClearBtn = null;
    this.mobileHighlight = null;
    this.desktopHighlight = null;
    this.mobileLocation = null;
    this.desktopLocation = null;
    this.mobileLayerContainer = null;
    this.desktopLayerContainer = null;

    // State management
    this.layerBindings = new Map();
    this.cleanupCallbacks = [];
    this.observers = [];
    this.syncGuards = Object.create(null);

    this.stateOffsets = {
      collapsed: 0,
      peek: 0,
      half: 0,
      expanded: 0,
    };
    this.sortedStates = [];
    this.activeStates = [];
    this.currentState = "collapsed";
    this.currentOffset = 0;

    // Drag handling
    this.dragStartOffset = 0;
    this.dragStartY = 0;
    this.dragCandidateStartY = 0;
    this.dragStartThreshold = 8;
    this.isDragging = false;
    this.dragSource = null;
    this.flingThreshold = 80;
    this.minStateGap = 40;

    this.resizeHandler = this.debounce(() => this.recomputeLayout(), 150);

    this.init();
  }

  static detectMobileViewport() {
    const touchCapable =
      "ontouchstart" in window || navigator.maxTouchPoints > 1;
    const narrowScreen = window.matchMedia
      ? window.matchMedia("(max-width: 768px)").matches
      : window.innerWidth <= 768;
    return narrowScreen || touchCapable;
  }

  init() {
    this.cacheElements();

    if (!this.sheet || !this.backdrop) {
      console.warn("Mobile sheet elements not found");
      return;
    }

    this.addBodyClass();
    this.calculateSheetMetrics();
    this.setState(this.currentState, { immediate: true });

    this.setupStaticActions();
    this.setupDragInteractions();
    this.setupDesktopBridges();

    this.syncAll();

    window.addEventListener("resize", this.resizeHandler);
    this.cleanupCallbacks.push(() =>
      window.removeEventListener("resize", this.resizeHandler),
    );
  }

  cacheElements() {
    this.sheet = document.querySelector(".mobile-bottom-sheet");
    this.backdrop = document.querySelector(".mobile-sheet-backdrop");
    this.handle = document.querySelector(".mobile-sheet-handle-container");
    this.header = document.querySelector(".mobile-sheet-header");
    this.sheetContent = document.querySelector(".mobile-sheet-content");

    this.mobileSearch = document.getElementById("mobile-map-search");
    this.desktopSearch = document.getElementById("map-search-input");
    this.mobileClearBtn = document.getElementById("mobile-clear-search");
    this.mobileHighlight = document.getElementById("mobile-highlight-recent");
    this.desktopHighlight = document.getElementById("highlight-recent-trips");
    this.mobileLocation = document.getElementById("mobile-streets-location");
    this.desktopLocation = document.getElementById("streets-location");
    this.mobileLayerContainer = document.getElementById("mobile-layer-toggles");
    this.desktopLayerContainer = document.getElementById("layer-toggles");
  }

  addBodyClass() {
    document.body.classList.add("map-page");
  }

  setupStaticActions() {
    if (this.header) {
      const onHeaderClick = (event) => {
        if (event.target.closest("button, a")) return;
        const collapsedState = this.sortedStates[0]?.state || "collapsed";
        const expandedState =
          this.sortedStates[this.sortedStates.length - 1]?.state || "expanded";

        if (this.currentState === collapsedState) {
          this.setState(this.getNextStateUp(collapsedState));
        } else if (this.currentState === expandedState) {
          this.setState(collapsedState);
        } else {
          this.setState(this.getNextStateUp(this.currentState));
        }
      };
      this.bind(this.header, "click", onHeaderClick);
    }

    this.bind(this.backdrop, "click", () => {
      const collapsedState = this.sortedStates[0]?.state || "collapsed";
      this.setState(collapsedState);
    });

    const centerBtn = document.getElementById("mobile-center-location");
    this.bind(centerBtn, "click", () =>
      document.getElementById("center-on-location")?.click(),
    );

    const fitBtn = document.getElementById("mobile-fit-bounds");
    this.bind(fitBtn, "click", () =>
      document.getElementById("fit-bounds")?.click(),
    );

    const refreshBtn = document.getElementById("mobile-refresh");
    this.bind(refreshBtn, "click", () => {
      document.getElementById("refresh-map")?.click();
      this.showFeedback("Refreshing map...");
    });

    const downloadBtn = document.getElementById("mobile-download-view");
    this.bind(downloadBtn, "click", () => {
      document.getElementById("download-view")?.click();
      this.showFeedback("Preparing download...");
    });

    const tripsBtn = document.getElementById("mobile-view-trips");
    this.bind(tripsBtn, "click", () => {
      window.location.href = "/trips";
    });

    document.querySelectorAll(".mobile-street-mode-btn").forEach((btn) => {
      this.bind(btn, "click", () => this.handleMobileStreetToggle(btn));
    });
  }

  setupDragInteractions() {
    const dragTargets = [this.handle, this.header];
    dragTargets.forEach((target) => {
      if (!target) return;
      const start = (event) =>
        this.beginDrag(event, target === this.header ? "header" : "handle");
      const move = (event) => this.continueDrag(event);
      const end = (event) => this.finishDrag(event);

      target.addEventListener("touchstart", start, { passive: false });
      target.addEventListener("touchmove", move, { passive: false });
      target.addEventListener("touchend", end);
      target.addEventListener("touchcancel", end);
      this.cleanupCallbacks.push(() => {
        target.removeEventListener("touchstart", start);
        target.removeEventListener("touchmove", move);
        target.removeEventListener("touchend", end);
        target.removeEventListener("touchcancel", end);
      });
    });

    if (this.sheetContent) {
      const onContentStart = (event) => {
        if (!event.touches || event.touches.length > 1) return;
        this.dragCandidateStartY = event.touches[0].clientY;
      };
      const onContentMove = (event) => this.handleContentDrag(event);
      const onContentEnd = (event) => this.finishDrag(event);

      this.sheetContent.addEventListener("touchstart", onContentStart, {
        passive: true,
      });
      this.sheetContent.addEventListener("touchmove", onContentMove, {
        passive: false,
      });
      this.sheetContent.addEventListener("touchend", onContentEnd);
      this.sheetContent.addEventListener("touchcancel", onContentEnd);
      this.cleanupCallbacks.push(() => {
        this.sheetContent.removeEventListener("touchstart", onContentStart);
        this.sheetContent.removeEventListener("touchmove", onContentMove);
        this.sheetContent.removeEventListener("touchend", onContentEnd);
        this.sheetContent.removeEventListener("touchcancel", onContentEnd);
      });
    }
  }

  beginDrag(event, source = "handle") {
    if (!event.touches || event.touches.length > 1) return;

    this.isDragging = true;
    this.dragSource = source;
    this.dragStartY = event.touches[0].clientY;
    this.dragStartOffset = this.currentOffset;
    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop.classList.add("visible");

    event.preventDefault();
  }

  beginDragFromContent(currentY) {
    if (this.isDragging) return;
    this.isDragging = true;
    this.dragSource = "content";
    this.dragStartY = currentY;
    this.dragStartOffset = this.currentOffset;
    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop.classList.add("visible");
  }

  handleContentDrag(event) {
    if (!this.sheetContent || !event.touches || event.touches.length > 1)
      return;

    const touch = event.touches[0];
    const deltaY = touch.clientY - this.dragCandidateStartY;
    const atTop = this.sheetContent.scrollTop <= 0;

    if (this.isDragging) {
      this.continueDrag(event);
      return;
    }

    if (atTop && deltaY > this.dragStartThreshold) {
      this.beginDragFromContent(touch.clientY);
      this.continueDrag(event);
    }
  }

  continueDrag(event) {
    if (!this.isDragging || !event.touches || event.touches.length > 1) return;

    const touch = event.touches[0];
    const deltaY = touch.clientY - this.dragStartY;
    const newOffset = this.clampOffset(this.dragStartOffset + deltaY);

    this.currentOffset = newOffset;
    this.applySheetOffset(newOffset, { immediate: false });
    this.updateBackdropForOffset(newOffset);

    event.preventDefault();
  }

  finishDrag(event) {
    if (!this.isDragging) return;

    let clientY = this.dragStartY;
    if (event.changedTouches?.length > 0) {
      clientY = event.changedTouches[0].clientY;
    } else if (event.touches?.length > 0) {
      clientY = event.touches[0].clientY;
    }

    const deltaY = clientY - this.dragStartY;
    this.isDragging = false;
    this.dragSource = null;
    this.sheet.classList.remove("dragging");
    this.sheet.style.transition = "";

    this.currentOffset = this.clampOffset(this.dragStartOffset + deltaY);
    this.applySheetOffset(this.currentOffset, { immediate: false });

    const targetState =
      Math.abs(deltaY) > this.flingThreshold
        ? deltaY > 0
          ? this.getNextStateDown(this.currentState)
          : this.getNextStateUp(this.currentState)
        : this.getNearestState(this.currentOffset);

    this.setState(targetState);
  }

  clampOffset(offset) {
    const maxOffset =
      this.sortedStates.length > 0
        ? this.sortedStates[0].offset
        : this.stateOffsets.collapsed;
    const clampedMax = Number.isFinite(maxOffset) ? maxOffset : 0;
    return Math.min(Math.max(offset, 0), clampedMax);
  }

  applySheetOffset(offset, { immediate = false } = {}) {
    if (!this.sheet) return;
    const value = `${Math.max(0, Math.round(offset))}px`;
    if (immediate) {
      const previous = this.sheet.style.transition;
      this.sheet.style.transition = "none";
      this.sheet.style.setProperty("--sheet-offset", value);
      requestAnimationFrame(() => {
        this.sheet.style.transition = previous;
      });
    } else {
      this.sheet.style.setProperty("--sheet-offset", value);
    }
  }

  updateBackdropForOffset(offset) {
    if (!this.backdrop) return;
    const maxOffset =
      this.sortedStates.length > 0
        ? this.sortedStates[0].offset
        : this.stateOffsets.collapsed;
    const denominator =
      Number.isFinite(maxOffset) && maxOffset > 0 ? maxOffset : 1;
    const progress = 1 - offset / denominator;
    const normalized = Math.max(0, Math.min(1, progress));
    const visible = normalized > 0.05;
    this.backdrop.classList.toggle("visible", visible);
    this.backdrop.style.opacity = visible
      ? String(Number((normalized * 0.6).toFixed(3)))
      : "";
  }

  setState(state, options = {}) {
    if (!this.sheet) return;
    if (!this.activeStates.includes(state)) {
      state = this.activeStates[0] || "collapsed";
    }

    const { immediate = false } = options;

    this.currentState = state;
    this.currentOffset = this.stateOffsets[state] ?? 0;

    this.updateSheetClasses(state);
    this.applySheetOffset(this.currentOffset, { immediate });
    this.updateBackdropForOffset(this.currentOffset);
  }

  updateSheetClasses(state) {
    if (!this.sheet) return;
    ["collapsed", "peek", "half", "expanded"].forEach((name) => {
      this.sheet.classList.toggle(name, name === state);
    });
  }

  getNextStateUp(state = this.currentState) {
    if (!this.sortedStates.length) return state;
    const index = this.sortedStates.findIndex((item) => item.state === state);
    if (index === -1)
      return this.sortedStates[this.sortedStates.length - 1].state;
    const nextIndex = Math.min(this.sortedStates.length - 1, index + 1);
    return this.sortedStates[nextIndex].state;
  }

  getNextStateDown(state = this.currentState) {
    if (!this.sortedStates.length) return state;
    const index = this.sortedStates.findIndex((item) => item.state === state);
    if (index === -1) return this.sortedStates[0].state;
    const nextIndex = Math.max(0, index - 1);
    return this.sortedStates[nextIndex].state;
  }

  getNearestState(offset) {
    if (!this.sortedStates.length) return this.currentState;
    let nearest = this.sortedStates[0].state;
    let minDistance = Infinity;
    this.sortedStates.forEach(({ state, offset: stateOffset }) => {
      const distance = Math.abs(offset - stateOffset);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = state;
      }
    });
    return nearest;
  }

  recomputeLayout() {
    this.calculateSheetMetrics();
    this.setState(this.currentState, { immediate: true });
  }

  calculateSheetMetrics() {
    if (!this.sheet) return;

    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    const sheetRect = this.sheet.getBoundingClientRect();
    const sheetHeight = sheetRect.height || viewportHeight * 0.85 || 0;

    const collapsedVisible = Math.min(
      sheetHeight,
      Math.max(150, Math.round(viewportHeight * 0.25)),
    );
    const peekVisible = Math.min(
      sheetHeight,
      Math.max(collapsedVisible + 80, Math.round(viewportHeight * 0.45)),
    );
    const halfVisible = Math.min(
      sheetHeight,
      Math.max(peekVisible + 80, Math.round(viewportHeight * 0.65)),
    );

    const offsets = {
      collapsed: Math.max(0, Math.round(sheetHeight - collapsedVisible)),
      peek: Math.max(0, Math.round(sheetHeight - peekVisible)),
      half: Math.max(0, Math.round(sheetHeight - halfVisible)),
      expanded: 0,
    };

    this.stateOffsets = offsets;

    const availableStates = ["collapsed"];
    if (offsets.collapsed - offsets.peek >= this.minStateGap) {
      availableStates.push("peek");
    }
    if (offsets.peek - offsets.half >= this.minStateGap && offsets.half > 0) {
      availableStates.push("half");
    }
    availableStates.push("expanded");

    this.activeStates = [...new Set(availableStates)];
    this.sortedStates = this.activeStates
      .map((state) => ({ state, offset: offsets[state] ?? 0 }))
      .sort((a, b) => b.offset - a.offset);

    if (!this.activeStates.includes(this.currentState)) {
      this.currentState = this.sortedStates[0]?.state || "collapsed";
    }

    this.currentOffset = offsets[this.currentState] ?? 0;
    this.applySheetOffset(this.currentOffset, { immediate: true });
    this.updateBackdropForOffset(this.currentOffset);
  }

  syncAll() {
    this.syncMetrics();
    this.syncLayers();
    this.syncLocationOptions();
    this.syncHighlightToggle();
    this.syncSearchField();
    this.syncStreetModes();
    this.syncLiveTracking();
  }

  syncMetrics(detail) {
    const metricsMap = {
      "mobile-total-trips": "total-trips",
      "mobile-total-distance": "total-distance",
      "mobile-avg-speed": "avg-speed",
      "mobile-max-speed": "max-speed",
    };

    Object.entries(metricsMap).forEach(([mobileId, desktopId]) => {
      const mobileEl = document.getElementById(mobileId);
      const desktopEl = document.getElementById(desktopId);
      if (mobileEl && desktopEl) {
        mobileEl.textContent = desktopEl.textContent;
      }
    });

    const quickMap = {
      "mobile-quick-trips": "total-trips",
      "mobile-quick-distance": "total-distance",
      "mobile-quick-speed": "avg-speed",
    };

    Object.entries(quickMap).forEach(([mobileId, desktopId]) => {
      const mobileEl = document.getElementById(mobileId);
      const desktopEl = document.getElementById(desktopId);
      if (mobileEl && desktopEl) {
        mobileEl.textContent = desktopEl.textContent;
      }
    });

    if (detail && typeof detail === "object") {
      this.syncQuickMetricsFromData(detail);
    }
  }

  syncQuickMetricsFromData(detail) {
    try {
      const totals = detail?.totals || detail;
      if (!totals || typeof totals !== "object") return;

      const assignments = [
        ["mobile-total-trips", totals.totalTrips ?? totals.trips],
        ["mobile-quick-trips", totals.totalTrips ?? totals.trips],
        [
          "mobile-total-distance",
          MobileMapInterface.formatNumber(
            totals.totalDistanceMiles ?? totals.totalDistance,
          ),
        ],
        [
          "mobile-quick-distance",
          MobileMapInterface.formatNumber(
            totals.totalDistanceMiles ?? totals.totalDistance,
          ),
        ],
        [
          "mobile-avg-speed",
          MobileMapInterface.formatNumber(totals.avgSpeed, 1),
        ],
        [
          "mobile-quick-speed",
          MobileMapInterface.formatNumber(totals.avgSpeed, 1),
        ],
        [
          "mobile-max-speed",
          MobileMapInterface.formatNumber(totals.maxSpeed, 1),
        ],
      ];

      assignments.forEach(([id, value]) => {
        if (value === undefined || value === null) return;
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
      });
    } catch (err) {
      console.warn("Failed to apply metrics detail to mobile UI", err);
    }
  }

  static formatNumber(value, precision = 0) {
    if (typeof value !== "number" || Number.isNaN(value)) return value;
    return precision > 0 ? value.toFixed(precision) : Math.round(value);
  }

  syncLayers() {
    if (!this.desktopLayerContainer || !this.mobileLayerContainer) return;

    this.resetLayerBindings();
    this.mobileLayerContainer.innerHTML = "";

    const checkboxes = this.desktopLayerContainer.querySelectorAll(
      'input[type="checkbox"]',
    );
    checkboxes.forEach((checkbox) => {
      const label = checkbox.closest(".form-check")?.querySelector("label");
      if (!label) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mobile-layer-btn ${checkbox.checked ? "active" : ""}`;
      btn.innerHTML = `<i class="fas fa-layer-group"></i> ${label.textContent.trim()}`;

      btn.addEventListener("click", () => {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        btn.classList.toggle("active", checkbox.checked);
      });

      const listener = () => {
        btn.classList.toggle("active", checkbox.checked);
      };
      checkbox.addEventListener("change", listener);

      const bindingKey =
        checkbox.id || checkbox.name || label.textContent.trim();
      this.layerBindings.set(bindingKey, { checkbox, listener });

      this.mobileLayerContainer.appendChild(btn);
    });
  }

  resetLayerBindings() {
    if (!this.layerBindings.size) return;
    this.layerBindings.forEach(({ checkbox, listener }) => {
      checkbox.removeEventListener("change", listener);
    });
    this.layerBindings.clear();
  }

  syncLocationOptions() {
    if (!this.desktopLocation || !this.mobileLocation) return;

    const fragment = document.createDocumentFragment();
    Array.from(this.desktopLocation.options).forEach((option) => {
      fragment.appendChild(option.cloneNode(true));
    });

    this.mobileLocation.innerHTML = "";
    this.mobileLocation.appendChild(fragment);
    this.mobileLocation.value = this.desktopLocation.value;
  }

  syncHighlightToggle() {
    if (!this.desktopHighlight || !this.mobileHighlight) return;
    this.mobileHighlight.checked = this.desktopHighlight.checked;
  }

  syncSearchField() {
    if (!this.desktopSearch || !this.mobileSearch) return;
    this.mobileSearch.value = this.desktopSearch.value || "";
    this.updateMobileClearButton();
  }

  syncStreetModes() {
    const desktopButtons = document.querySelectorAll(".street-toggle-btn");
    if (!desktopButtons.length) return;

    const activeModes = new Set();
    desktopButtons.forEach((btn) => {
      if (btn.classList.contains("active")) {
        const mode = btn.dataset.streetMode;
        if (mode) activeModes.add(mode);
      }
    });

    document.querySelectorAll(".mobile-street-mode-btn").forEach((btn) => {
      const mode = btn.dataset.mode;
      btn.classList.toggle("active", mode ? activeModes.has(mode) : false);
    });
  }

  syncLiveTracking(detail) {
    const desktopCount = document.getElementById("active-trips-count");
    const mobileCount = document.getElementById("mobile-active-count");
    if (mobileCount && desktopCount) {
      mobileCount.textContent = desktopCount.textContent;
    }

    const statusBadge = document.getElementById("mobile-live-status");
    const statusText = document.querySelector(".live-status-text");
    if (statusBadge) {
      let connected = statusText?.textContent
        ?.toLowerCase()
        .includes("connected");
      if (detail && typeof detail.connected === "boolean") {
        connected = detail.connected;
      }
      statusBadge.classList.toggle("disconnected", connected === false);
      const label = statusBadge.querySelector("span:last-child");
      if (label) {
        label.textContent = connected === false ? "Offline" : "Live";
      }
    }

    const mobileMetrics = document.getElementById("mobile-trip-metrics");
    if (mobileMetrics) {
      if (detail && typeof detail.metricsHtml === "string") {
        mobileMetrics.innerHTML = detail.metricsHtml;
      } else {
        const desktopMetrics = document.querySelector(
          "#live-tracking-panel .live-trip-metrics",
        );
        if (desktopMetrics) {
          mobileMetrics.innerHTML = desktopMetrics.innerHTML;
        }
      }
    }
  }

  setupDesktopBridges() {
    this.setupSearchBridge();
    this.setupHighlightBridge();
    this.setupLocationBridge();
    this.attachLayerObserver();
    this.attachLocationObserver();
    this.attachStreetModeListeners();

    const metricsHandler = (event) => this.syncMetrics(event?.detail);
    document.addEventListener("metricsUpdated", metricsHandler);
    this.cleanupCallbacks.push(() =>
      document.removeEventListener("metricsUpdated", metricsHandler),
    );

    const liveTrackingHandler = (event) => this.syncLiveTracking(event?.detail);
    document.addEventListener("liveTrackingUpdated", liveTrackingHandler);
    this.cleanupCallbacks.push(() =>
      document.removeEventListener("liveTrackingUpdated", liveTrackingHandler),
    );

    const appReadyHandler = () => this.syncAll();
    document.addEventListener("appReady", appReadyHandler, { once: true });
  }

  setupSearchBridge() {
    if (!this.desktopSearch || !this.mobileSearch) return;
    const key = "search";

    const mobileHandler = (event) => {
      this.syncGuards[key] = "mobile";
      this.desktopSearch.value = event.target.value;
      this.desktopSearch.dispatchEvent(new Event("input", { bubbles: true }));
      this.updateMobileClearButton();
      requestAnimationFrame(() => {
        this.syncGuards[key] = null;
      });
    };

    const desktopHandler = (event) => {
      if (this.syncGuards[key] === "mobile") return;
      this.mobileSearch.value = event.target.value;
      this.updateMobileClearButton();
    };

    this.mobileSearch.addEventListener("input", mobileHandler);
    this.desktopSearch.addEventListener("input", desktopHandler);
    this.cleanupCallbacks.push(() =>
      this.mobileSearch.removeEventListener("input", mobileHandler),
    );
    this.cleanupCallbacks.push(() =>
      this.desktopSearch.removeEventListener("input", desktopHandler),
    );

    if (this.mobileClearBtn) {
      const clearHandler = () => {
        this.syncGuards[key] = "mobile";
        this.mobileSearch.value = "";
        this.desktopSearch.value = "";
        this.desktopSearch.dispatchEvent(new Event("input", { bubbles: true }));
        this.updateMobileClearButton();
        requestAnimationFrame(() => {
          this.syncGuards[key] = null;
        });
      };
      this.mobileClearBtn.addEventListener("click", clearHandler);
      this.cleanupCallbacks.push(() =>
        this.mobileClearBtn.removeEventListener("click", clearHandler),
      );
    }
  }

  setupHighlightBridge() {
    if (!this.desktopHighlight || !this.mobileHighlight) return;
    const key = "highlight";

    const mobileHandler = (event) => {
      this.syncGuards[key] = "mobile";
      this.desktopHighlight.checked = event.target.checked;
      this.desktopHighlight.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      requestAnimationFrame(() => {
        this.syncGuards[key] = null;
      });
    };

    const desktopHandler = (event) => {
      if (this.syncGuards[key] === "mobile") return;
      this.mobileHighlight.checked = event.target.checked;
    };

    this.mobileHighlight.addEventListener("change", mobileHandler);
    this.desktopHighlight.addEventListener("change", desktopHandler);
    this.cleanupCallbacks.push(() =>
      this.mobileHighlight.removeEventListener("change", mobileHandler),
    );
    this.cleanupCallbacks.push(() =>
      this.desktopHighlight.removeEventListener("change", desktopHandler),
    );
  }

  setupLocationBridge() {
    if (!this.desktopLocation || !this.mobileLocation) return;
    const key = "location";

    const mobileHandler = (event) => {
      this.syncGuards[key] = "mobile";
      this.desktopLocation.value = event.target.value;
      this.desktopLocation.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      requestAnimationFrame(() => {
        this.syncGuards[key] = null;
      });
    };

    const desktopHandler = (event) => {
      if (this.syncGuards[key] === "mobile") return;
      this.mobileLocation.value = event.target.value;
    };

    this.mobileLocation.addEventListener("change", mobileHandler);
    this.desktopLocation.addEventListener("change", desktopHandler);
    this.cleanupCallbacks.push(() =>
      this.mobileLocation.removeEventListener("change", mobileHandler),
    );
    this.cleanupCallbacks.push(() =>
      this.desktopLocation.removeEventListener("change", desktopHandler),
    );
  }

  attachLayerObserver() {
    if (!this.desktopLayerContainer || !("MutationObserver" in window)) return;
    const observer = new MutationObserver(() => this.syncLayers());
    observer.observe(this.desktopLayerContainer, {
      childList: true,
      subtree: true,
    });
    this.observers.push(observer);
  }

  attachLocationObserver() {
    if (!this.desktopLocation || !("MutationObserver" in window)) return;
    const observer = new MutationObserver(() => this.syncLocationOptions());
    observer.observe(this.desktopLocation, { childList: true });
    this.observers.push(observer);
  }

  attachStreetModeListeners() {
    const desktopButtons = document.querySelectorAll(".street-toggle-btn");
    if (!desktopButtons.length) return;

    desktopButtons.forEach((btn) => {
      const handler = () => requestAnimationFrame(() => this.syncStreetModes());
      btn.addEventListener("click", handler);
      this.cleanupCallbacks.push(() =>
        btn.removeEventListener("click", handler),
      );
    });

    this.syncStreetModes();
  }

  handleMobileStreetToggle(button) {
    if (!button) return;
    const mode = button.dataset.mode;
    if (!mode) return;

    const desktopBtn = document.querySelector(
      `.street-toggle-btn[data-street-mode="${mode}"]`,
    );
    if (!desktopBtn) return;

    const willActivate = !button.classList.contains("active");
    button.classList.toggle("active", willActivate);

    const desktopActive = desktopBtn.classList.contains("active");
    if (desktopActive !== willActivate) {
      desktopBtn.click();
    }
  }

  updateMobileClearButton() {
    if (!this.mobileClearBtn) return;
    const hasValue = Boolean(this.mobileSearch?.value);
    this.mobileClearBtn.classList.toggle("d-none", !hasValue);
  }

  bind(target, event, handler) {
    if (!target) return;
    target.addEventListener(event, handler);
    this.cleanupCallbacks.push(() =>
      target.removeEventListener(event, handler),
    );
  }

  showFeedback(message) {
    if (window.notificationManager) {
      window.notificationManager.show(message, "info");
    }
  }

  debounce(fn, wait = 150) {
    let timerId = null;
    return (...args) => {
      if (timerId) {
        clearTimeout(timerId);
      }
      timerId = window.setTimeout(() => {
        timerId = null;
        fn.apply(this, args);
      }, wait);
    };
  }

  destroy() {
    this.resetLayerBindings();
    this.cleanupCallbacks.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn("Failed to cleanup mobile interface listener", err);
      }
    });
    this.cleanupCallbacks = [];
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
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
