/* Mobile Map Interface - Simplified for Unified DOM
 *
 * This file handles mobile-specific behaviors for the map page:
 * - Bottom sheet drag/gesture handling (targeting unified #map-controls)
 * - FAB button click handlers
 * - Mobile viewport detection
 *
 * Note: No sync logic needed - DOM is unified between desktop and mobile
 */

class MobileMapInterface {
  constructor() {
    this.isMobile = MobileMapInterface.detectMobileViewport();
    if (!this.isMobile) {
      return;
    }

    // DOM references - now targeting unified control panel
    this.sheet = null;
    this.backdrop = null;
    this.handle = null;
    this.header = null;
    this.sheetContent = null;

    // State management
    this.cleanupCallbacks = [];
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
    this.flingThreshold = 80;
    this.minStateGap = 40;

    this.resizeHandler = this.debounce(() => this.recomputeLayout(), 150);

    this.init();
  }

  static detectMobileViewport() {
    const touchCapable = "ontouchstart" in window || navigator.maxTouchPoints > 1;
    const narrowScreen = window.matchMedia
      ? window.matchMedia("(max-width: 768px)").matches
      : window.innerWidth <= 768;
    return narrowScreen || touchCapable;
  }

  init() {
    this.cacheElements();

    if (!this.sheet) {
      console.warn("Unified control panel (#map-controls) not found");
      return;
    }

    MobileMapInterface.addBodyClass();
    this.calculateSheetMetrics();
    this.setState(this.currentState, { immediate: true });

    this.setupDragInteractions();
    this.setupFABActions();

    window.addEventListener("resize", this.resizeHandler);
    this.cleanupCallbacks.push(() =>
      window.removeEventListener("resize", this.resizeHandler)
    );
  }

  cacheElements() {
    // Now targeting unified control panel instead of separate mobile sheet
    this.sheet = document.getElementById("map-controls");
    this.backdrop = document.querySelector(".mobile-sheet-backdrop");
    this.handle = this.sheet?.querySelector(".mobile-sheet-handle-container");
    this.header = this.sheet?.querySelector(".control-panel-header");
    this.sheetContent = this.sheet?.querySelector(".control-panel-body");
  }

  static addBodyClass() {
    document.body.classList.add("map-page");
  }

  setupFABActions() {
    const centerBtn = document.getElementById("mobile-center-location");
    this.bind(centerBtn, "click", () =>
      document.getElementById("center-on-location")?.click()
    );

    const fitBtn = document.getElementById("mobile-fit-bounds");
    this.bind(fitBtn, "click", () => document.getElementById("fit-bounds")?.click());

    const refreshBtn = document.getElementById("mobile-refresh");
    this.bind(refreshBtn, "click", () => {
      document.getElementById("refresh-map")?.click();
      MobileMapInterface.showFeedback("Refreshing map...");
    });
  }

  setupDragInteractions() {
    const dragTargets = [this.handle, this.header].filter(Boolean);
    dragTargets.forEach((target) => {
      const start = (event) => this.beginDrag(event);
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

    // Header click to expand/collapse
    if (this.header) {
      const onHeaderClick = (event) => {
        if (event.target.closest("button, a, input, select")) return;
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

    // Backdrop click to collapse
    if (this.backdrop) {
      this.bind(this.backdrop, "click", () => {
        const collapsedState = this.sortedStates[0]?.state || "collapsed";
        this.setState(collapsedState);
      });
    }

    // Content scroll to drag
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

  beginDrag(event) {
    if (!event.touches || event.touches.length > 1) return;

    this.isDragging = true;
    this.dragStartY = event.touches[0].clientY;
    this.dragStartOffset = this.currentOffset;
    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop?.classList.add("visible");

    event.preventDefault();
  }

  beginDragFromContent(currentY) {
    if (this.isDragging) return;
    this.isDragging = true;
    this.dragStartY = currentY;
    this.dragStartOffset = this.currentOffset;
    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop?.classList.add("visible");
  }

  handleContentDrag(event) {
    if (!this.sheetContent || !event.touches || event.touches.length > 1) return;

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
      ({ clientY } = event.changedTouches[0]);
    } else if (event.touches?.length > 0) {
      ({ clientY } = event.touches[0]);
    }

    const deltaY = clientY - this.dragStartY;
    this.isDragging = false;
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
    const denominator = Number.isFinite(maxOffset) && maxOffset > 0 ? maxOffset : 1;
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
    let validState = state;
    if (!this.activeStates.includes(state)) {
      validState = this.activeStates[0] || "collapsed";
    }

    const { immediate = false } = options;

    this.currentState = validState;
    this.currentOffset = this.stateOffsets[validState] ?? 0;

    this.updateSheetClasses(validState);
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
    if (index === -1) return this.sortedStates[this.sortedStates.length - 1].state;
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
      Math.max(150, Math.round(viewportHeight * 0.25))
    );
    const peekVisible = Math.min(
      sheetHeight,
      Math.max(collapsedVisible + 80, Math.round(viewportHeight * 0.45))
    );
    const halfVisible = Math.min(
      sheetHeight,
      Math.max(peekVisible + 80, Math.round(viewportHeight * 0.65))
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

  bind(target, event, handler) {
    if (!target) return;
    target.addEventListener(event, handler);
    this.cleanupCallbacks.push(() => target.removeEventListener(event, handler));
  }

  static showFeedback(message) {
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
    this.cleanupCallbacks.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn("Failed to cleanup mobile interface listener", err);
      }
    });
    this.cleanupCallbacks = [];
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
