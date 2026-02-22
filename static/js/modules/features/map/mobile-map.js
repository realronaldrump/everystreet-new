/* Mobile Map Interface - Unified DOM Bottom Sheet
 *
 * Handles mobile-specific behaviors for the map page:
 * - Bottom sheet drag/gesture with velocity-based snapping
 * - 3-state sheet (collapsed / half / expanded) with rubber-banding
 * - Body scroll prevention when sheet is open
 * - Content-scroll-to-drag dismissal
 *
 * DOM is unified between desktop and mobile — no sync needed.
 */

const MOBILE_TOGGLE_EVENT = "es:mapControls:toggle";

/** Number of recent touch samples to keep for velocity calculation */
const VELOCITY_SAMPLES = 6;
/** Rubber-band resistance factor (0 = locked, 1 = no resistance) */
const RUBBER_FACTOR = 0.25;
/** Below this velocity (px/ms) we snap to nearest state */
const FLING_VELOCITY_THRESHOLD = 0.4;
/** Minimum distance (px) to count as a drag (vs. a tap) */
const TAP_THRESHOLD = 10;
/** Distance (px) content must be dragged down before sheet takes over scroll */
const CONTENT_DRAG_THRESHOLD = 12;
/** Minimum gap (px) between adjacent state offsets to keep that state */
const MIN_STATE_GAP = 50;

class MobileMapInterface {
  constructor() {
    this.isMobile = MobileMapInterface.detectMobileViewport();
    if (!this.isMobile) {
      return;
    }

    // DOM
    this.sheet = null;
    this.backdrop = null;
    this.handle = null;
    this.header = null;
    this.sheetContent = null;

    // State machine
    this.cleanupCallbacks = [];
    this.stateOffsets = { collapsed: 0, half: 0, expanded: 0 };
    this.sortedStates = []; // [{state, offset}] sorted descending by offset
    this.activeStates = [];
    this.currentState = "collapsed";
    this.currentOffset = 0;
    this.sheetHeight = 0;

    // Drag / velocity
    this.isDragging = false;
    this.dragStartY = 0;
    this.dragStartOffset = 0;
    this.dragCandidateStartY = 0;
    /** @type {{y: number, t: number}[]} */
    this.velocitySamples = [];

    this.resizeHandler = MobileMapInterface.debounce(() => this.recomputeLayout(), 150);
    this.init();
  }

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------

  static detectMobileViewport() {
    const narrowScreen = window.matchMedia
      ? window.matchMedia("(max-width: 768px)").matches
      : window.innerWidth <= 768;
    if (narrowScreen) {
      return true;
    }

    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const compactViewport = window.innerWidth <= 1024 && window.innerHeight <= 900;
    return coarsePointer && compactViewport;
  }

  // ---------------------------------------------------------------------------
  // Init / teardown
  // ---------------------------------------------------------------------------

  init() {
    this.cacheElements();
    if (!this.sheet) {
      return;
    }

    document.body.classList.add("map-page");
    this.cleanupCallbacks.push(() => document.body.classList.remove("map-page"));

    this.calculateSheetMetrics();
    this.setState("collapsed", { immediate: true });

    this.setupDragInteractions();
    this.setupProgrammaticToggle();

    window.addEventListener("resize", this.resizeHandler);
    this.cleanupCallbacks.push(() =>
      window.removeEventListener("resize", this.resizeHandler)
    );

    this.orientationQuery = window.matchMedia("(orientation: landscape)");
    this.orientationHandler = MobileMapInterface.debounce(
      () => this.recomputeLayout(),
      100
    );
    this.orientationQuery.addEventListener("change", this.orientationHandler);
    this.cleanupCallbacks.push(() =>
      this.orientationQuery.removeEventListener("change", this.orientationHandler)
    );
  }

  cacheElements() {
    this.sheet = document.getElementById("map-controls");
    this.backdrop = document.querySelector(".mobile-sheet-backdrop");
    this.handle = this.sheet?.querySelector(".mobile-sheet-handle-container");
    this.header = this.sheet?.querySelector(".control-panel-header");
    this.sheetContent = this.sheet?.querySelector(".control-panel-body");
  }

  // ---------------------------------------------------------------------------
  // Touch interactions
  // ---------------------------------------------------------------------------

  setupDragInteractions() {
    // Handle + header are primary drag targets
    for (const target of [this.handle, this.header].filter(Boolean)) {
      const start = (e) => this.onTouchStart(e);
      const move = (e) => this.onTouchMove(e);
      const end = (e) => this.onTouchEnd(e);

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
    }

    // Tap on header / handle to toggle
    for (const target of [this.handle, this.header].filter(Boolean)) {
      this.bind(target, "click", (e) => {
        if (e.target.closest("button, a, input, select")) {
          return;
        }
        this.toggleState();
      });
    }

    // Backdrop tap collapses
    if (this.backdrop) {
      this.bind(this.backdrop, "click", () => this.setState("collapsed"));
    }

    // Content scroll-to-drag: when scrolled to top, pull down to dismiss
    if (this.sheetContent) {
      const onStart = (e) => {
        if (!e.touches || e.touches.length > 1) {
          return;
        }
        this.dragCandidateStartY = e.touches[0].clientY;
      };
      const onMove = (e) => this.handleContentDrag(e);
      const onEnd = (e) => this.onTouchEnd(e);

      this.sheetContent.addEventListener("touchstart", onStart, { passive: true });
      this.sheetContent.addEventListener("touchmove", onMove, { passive: false });
      this.sheetContent.addEventListener("touchend", onEnd);
      this.sheetContent.addEventListener("touchcancel", onEnd);
      this.cleanupCallbacks.push(() => {
        this.sheetContent.removeEventListener("touchstart", onStart);
        this.sheetContent.removeEventListener("touchmove", onMove);
        this.sheetContent.removeEventListener("touchend", onEnd);
        this.sheetContent.removeEventListener("touchcancel", onEnd);
      });
    }
  }

  onTouchStart(event) {
    if (!event.touches || event.touches.length > 1) {
      return;
    }

    this.isDragging = true;
    this.dragStartY = event.touches[0].clientY;
    this.dragStartOffset = this.currentOffset;
    this.velocitySamples = [{ y: this.dragStartY, t: Date.now() }];

    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop?.classList.add("visible");

    event.preventDefault();
  }

  beginDragFromContent(currentY) {
    if (this.isDragging) {
      return;
    }
    this.isDragging = true;
    this.dragStartY = currentY;
    this.dragStartOffset = this.currentOffset;
    this.velocitySamples = [{ y: currentY, t: Date.now() }];

    this.sheet.classList.add("dragging");
    this.sheet.style.transition = "none";
    this.backdrop?.classList.add("visible");
  }

  handleContentDrag(event) {
    if (!this.sheetContent || !event.touches || event.touches.length > 1) {
      return;
    }

    const touch = event.touches[0];
    const deltaY = touch.clientY - this.dragCandidateStartY;
    const atTop = this.sheetContent.scrollTop <= 0;

    if (this.isDragging) {
      this.onTouchMove(event);
      return;
    }

    if (atTop && deltaY > CONTENT_DRAG_THRESHOLD) {
      this.beginDragFromContent(touch.clientY);
      this.onTouchMove(event);
    }
  }

  onTouchMove(event) {
    if (!this.isDragging || !event.touches || event.touches.length > 1) {
      return;
    }

    const touch = event.touches[0];
    const deltaY = touch.clientY - this.dragStartY;
    const rawOffset = this.dragStartOffset + deltaY;

    // Rubber-band past bounds
    const offset = this.rubberBand(rawOffset);

    this.currentOffset = offset;
    this.applySheetOffset(offset);
    this.updateBackdropForOffset(offset);

    // Track velocity
    this.velocitySamples.push({ y: touch.clientY, t: Date.now() });
    if (this.velocitySamples.length > VELOCITY_SAMPLES) {
      this.velocitySamples.shift();
    }

    event.preventDefault();
  }

  onTouchEnd(event) {
    if (!this.isDragging) {
      return;
    }

    let clientY = this.dragStartY;
    if (event.changedTouches?.length > 0) {
      ({ clientY } = event.changedTouches[0]);
    } else if (event.touches?.length > 0) {
      ({ clientY } = event.touches[0]);
    }

    const deltaY = clientY - this.dragStartY;
    this.isDragging = false;
    this.sheet.classList.remove("dragging");

    // Compute velocity (px/ms, positive = dragging down / closing)
    const velocity = this.computeVelocity();

    // Clamp offset back into valid range (remove rubber-band overshoot)
    this.currentOffset = this.clampOffset(this.dragStartOffset + deltaY);

    // Decide target state
    let targetState;
    if (Math.abs(deltaY) <= TAP_THRESHOLD) {
      targetState = this.getTapTargetState();
    } else if (Math.abs(velocity) > FLING_VELOCITY_THRESHOLD) {
      // Fling: velocity decides direction
      targetState =
        velocity > 0
          ? this.getNextStateDown(this.currentState)
          : this.getNextStateUp(this.currentState);
    } else {
      // Slow drag: snap to nearest
      targetState = this.getNearestState(this.currentOffset);
    }

    // Velocity-based duration: faster flings get shorter transitions
    const targetOffset = this.stateOffsets[targetState] ?? 0;
    const distance = Math.abs(this.currentOffset - targetOffset);
    const speed = Math.max(Math.abs(velocity), 0.3); // px/ms floor
    const dynamicDuration = Math.round(Math.max(120, Math.min(400, distance / speed)));

    this.setStateAnimated(targetState, dynamicDuration);
  }

  // ---------------------------------------------------------------------------
  // Velocity helpers
  // ---------------------------------------------------------------------------

  computeVelocity() {
    const s = this.velocitySamples;
    if (s.length < 2) {
      return 0;
    }
    const first = s[0];
    const last = s[s.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) {
      return 0;
    }
    return (last.y - first.y) / dt; // px/ms
  }

  // ---------------------------------------------------------------------------
  // Rubber-banding
  // ---------------------------------------------------------------------------

  rubberBand(offset) {
    const maxOffset = this.stateOffsets.collapsed;
    if (offset < 0) {
      return offset * RUBBER_FACTOR;
    }
    if (offset > maxOffset) {
      const over = offset - maxOffset;
      return maxOffset + over * RUBBER_FACTOR;
    }
    return offset;
  }

  clampOffset(offset) {
    const maxOffset = this.stateOffsets.collapsed;
    const max = Number.isFinite(maxOffset) ? maxOffset : 0;
    return Math.min(Math.max(offset, 0), max);
  }

  // ---------------------------------------------------------------------------
  // Sheet positioning
  // ---------------------------------------------------------------------------

  applySheetOffset(offset, { immediate = false } = {}) {
    if (!this.sheet) {
      return;
    }
    const value = `${Math.max(0, Math.round(offset))}px`;
    if (immediate) {
      const prev = this.sheet.style.transition;
      this.sheet.style.transition = "none";
      this.sheet.style.setProperty("--sheet-offset", value);
      requestAnimationFrame(() => {
        this.sheet.style.transition = prev;
      });
    } else {
      this.sheet.style.setProperty("--sheet-offset", value);
    }
    this.updateVisibleHeight(offset);
  }

  updateVisibleHeight(offset = this.currentOffset) {
    const h =
      this.sheetHeight ||
      this.sheet?.getBoundingClientRect?.().height ||
      window.innerHeight * 0.85;
    const visible = Math.max(0, Math.round(h - Math.max(0, offset)));
    document.documentElement.style.setProperty(
      "--map-sheet-visible-height",
      `${visible}px`
    );
  }

  updateBackdropForOffset(offset) {
    if (!this.backdrop) {
      return;
    }
    const maxOffset = this.stateOffsets.collapsed;
    const denom = Number.isFinite(maxOffset) && maxOffset > 0 ? maxOffset : 1;
    const progress = Math.max(0, Math.min(1, 1 - offset / denom));
    const visible = progress > 0.05;
    this.backdrop.classList.toggle("visible", visible);
    this.backdrop.style.opacity = visible
      ? String(Number((progress * 0.5).toFixed(3)))
      : "";
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  setState(state, options = {}) {
    if (!this.sheet) {
      return;
    }
    const validState = this.activeStates.includes(state)
      ? state
      : this.activeStates[0] || "collapsed";

    const { immediate = false } = options;

    this.currentState = validState;
    this.currentOffset = this.stateOffsets[validState] ?? 0;

    this.updateSheetClasses(validState);
    this.applySheetOffset(this.currentOffset, { immediate });
    this.updateBackdropForOffset(this.currentOffset);
    this.updateBodyScrollLock(validState);
  }

  /** Animate to a state with a custom duration (velocity-based) */
  setStateAnimated(state, durationMs) {
    if (!this.sheet) {
      return;
    }
    const validState = this.activeStates.includes(state)
      ? state
      : this.activeStates[0] || "collapsed";

    this.currentState = validState;
    this.currentOffset = this.stateOffsets[validState] ?? 0;

    // Apply dynamic duration via CSS custom property + snap-transition class
    this.sheet.style.setProperty("--snap-duration", `${durationMs}ms`);
    this.sheet.classList.add("snap-transition");
    this.sheet.style.transition = "";

    this.updateSheetClasses(validState);
    this.applySheetOffset(this.currentOffset);
    this.updateBackdropForOffset(this.currentOffset);
    this.updateBodyScrollLock(validState);

    // Clean up snap class after transition ends
    const cleanup = () => {
      this.sheet.classList.remove("snap-transition");
      this.sheet.style.removeProperty("--snap-duration");
      this.sheet.removeEventListener("transitionend", cleanup);
    };
    this.sheet.addEventListener("transitionend", cleanup, { once: true });
    // Safety timeout in case transitionend doesn't fire
    setTimeout(cleanup, durationMs + 50);
  }

  toggleState() {
    this.setState(this.getTapTargetState());
  }

  getTapTargetState() {
    const collapsed = this.sortedStates[0]?.state || "collapsed";
    const expanded =
      this.sortedStates[this.sortedStates.length - 1]?.state || "expanded";
    // If already at top, collapse; otherwise go one step up
    return this.currentState === expanded
      ? collapsed
      : this.getNextStateUp(this.currentState);
  }

  setupProgrammaticToggle() {
    const handler = () => this.toggleState();
    document.addEventListener(MOBILE_TOGGLE_EVENT, handler);
    this.cleanupCallbacks.push(() =>
      document.removeEventListener(MOBILE_TOGGLE_EVENT, handler)
    );
  }

  updateSheetClasses(state) {
    if (!this.sheet) {
      return;
    }
    for (const name of ["collapsed", "half", "expanded"]) {
      this.sheet.classList.toggle(name, name === state);
    }
  }

  updateBodyScrollLock(state) {
    const shouldLock = state !== "collapsed";
    document.body.classList.toggle("sheet-open", shouldLock);
  }

  // ---------------------------------------------------------------------------
  // State navigation
  // ---------------------------------------------------------------------------

  getNextStateUp(state = this.currentState) {
    if (!this.sortedStates.length) {
      return state;
    }
    const idx = this.sortedStates.findIndex((s) => s.state === state);
    if (idx === -1) {
      return this.sortedStates[this.sortedStates.length - 1].state;
    }
    return this.sortedStates[Math.min(this.sortedStates.length - 1, idx + 1)].state;
  }

  getNextStateDown(state = this.currentState) {
    if (!this.sortedStates.length) {
      return state;
    }
    const idx = this.sortedStates.findIndex((s) => s.state === state);
    if (idx === -1) {
      return this.sortedStates[0].state;
    }
    return this.sortedStates[Math.max(0, idx - 1)].state;
  }

  getNearestState(offset) {
    if (!this.sortedStates.length) {
      return this.currentState;
    }
    let nearest = this.sortedStates[0].state;
    let minDist = Infinity;
    for (const { state, offset: o } of this.sortedStates) {
      const d = Math.abs(offset - o);
      if (d < minDist) {
        minDist = d;
        nearest = state;
      }
    }
    return nearest;
  }

  // ---------------------------------------------------------------------------
  // Layout metrics
  // ---------------------------------------------------------------------------

  recomputeLayout() {
    this.calculateSheetMetrics();
    this.setState(this.currentState, { immediate: true });
  }

  calculateSheetMetrics() {
    if (!this.sheet) {
      return;
    }

    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const sheetRect = this.sheet.getBoundingClientRect();
    const sheetHeight = sheetRect.height || vh * 0.85 || 0;
    this.sheetHeight = sheetHeight;

    // Collapsed: handle + header visible (~88-100px)
    const collapsedVisible = Math.min(sheetHeight, Math.max(88, Math.round(vh * 0.14)));

    // Half: ~48% of viewport
    const halfVisible = Math.min(
      sheetHeight,
      Math.max(collapsedVisible + 120, Math.round(vh * 0.48))
    );

    const offsets = {
      collapsed: Math.max(0, Math.round(sheetHeight - collapsedVisible)),
      half: Math.max(0, Math.round(sheetHeight - halfVisible)),
      expanded: 0,
    };

    this.stateOffsets = offsets;

    // Build active states — skip half if too close to collapsed or expanded
    const states = ["collapsed"];
    if (
      offsets.collapsed - offsets.half >= MIN_STATE_GAP &&
      offsets.half > MIN_STATE_GAP
    ) {
      states.push("half");
    }
    states.push("expanded");

    this.activeStates = states;
    this.sortedStates = states
      .map((state) => ({ state, offset: offsets[state] ?? 0 }))
      .sort((a, b) => b.offset - a.offset);

    if (!this.activeStates.includes(this.currentState)) {
      this.currentState = this.sortedStates[0]?.state || "collapsed";
    }

    this.currentOffset = offsets[this.currentState] ?? 0;
    this.applySheetOffset(this.currentOffset, { immediate: true });
    this.updateBackdropForOffset(this.currentOffset);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  bind(target, event, handler) {
    if (!target) {
      return;
    }
    target.addEventListener(event, handler);
    this.cleanupCallbacks.push(() => target.removeEventListener(event, handler));
  }

  static debounce(fn, wait = 150) {
    let id = null;
    return (...args) => {
      if (id) {
        clearTimeout(id);
      }
      id = setTimeout(() => {
        id = null;
        fn(...args);
      }, wait);
    };
  }

  destroy() {
    if (!this.cleanupCallbacks) {
      return;
    }
    for (const fn of this.cleanupCallbacks) {
      try {
        fn();
      } catch (e) {
        console.warn("Cleanup failed", e);
      }
    }
    this.cleanupCallbacks = [];
    document.body.classList.remove("sheet-open");
    document.documentElement.style.removeProperty("--map-sheet-visible-height");
  }
}

let mobileMapInterface = null;

export const initMobileMap = ({ cleanup } = {}) => {
  if (mobileMapInterface?.destroy) {
    mobileMapInterface.destroy();
  }
  mobileMapInterface = new MobileMapInterface();

  if (typeof cleanup === "function") {
    cleanup(() => {
      if (mobileMapInterface?.destroy) {
        mobileMapInterface.destroy();
      }
      mobileMapInterface = null;
    });
  }
};
