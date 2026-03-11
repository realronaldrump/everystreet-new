/**
 * Map Controls - Desktop panel state + shared map control actions.
 *
 * Mobile sheet drag/toggle behavior is owned by mobile-map.js.
 * Desktop uses CSS class `.desktop-collapsed` for smooth animated collapse.
 */

const MOBILE_BREAKPOINT = "(max-width: 768px)";
const MOBILE_TOGGLE_EVENT = "es:mapControls:toggle";
const COVERAGE_SELECTION_EVENT = "es:coverage-area-selection-changed";
const FOCUS_COVERAGE_EVENT = "es:focus-selected-coverage-area";
const PANEL_EDGE_MARGIN_PX = 12;
const DESKTOP_COLLAPSE_SYNC_DELAY_MS = 260;

export default function initMapControls({ signal, cleanup } = {}) {
  const noopTeardown = () => {};
  const controls = document.getElementById("map-controls");
  const header = controls?.querySelector?.(".control-panel-header") || null;
  const toggleBtn = document.getElementById("controls-toggle");
  const locationSelect = document.getElementById("streets-location");
  const focusCoverageBtn = document.getElementById("focus-coverage-area-btn");
  if (!controls) {
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  let isExpandedDesktop = true;
  let resizeTimeout = null;
  let positionSyncTimeout = null;
  let dragState = null;
  let desktopCustomPosition = null;

  const isMobile = () =>
    window.matchMedia
      ? window.matchMedia(MOBILE_BREAKPOINT).matches
      : window.innerWidth <= 768;

  const clearDesktopPosition = () => {
    controls.style.left = "";
    controls.style.top = "";
    controls.style.right = "";
    controls.style.bottom = "";
  };

  const stopDesktopDrag = () => {
    const pointerId = dragState?.pointerId;
    header?.removeEventListener("pointermove", onDesktopDragMove);
    header?.removeEventListener("pointerup", onDesktopDragEnd);
    header?.removeEventListener("pointercancel", onDesktopDragEnd);
    if (pointerId != null) {
      header?.releasePointerCapture?.(pointerId);
    }
    controls.classList.remove("desktop-dragging");
    header?.classList.remove("dragging");
    dragState = null;
  };

  const applyDesktopPosition = (left, top) => {
    const container = controls.parentElement;
    if (!container) {
      return;
    }

    const panelRect = controls.getBoundingClientRect();
    const panelWidth = controls.offsetWidth || panelRect.width || 0;
    const panelHeight = controls.offsetHeight || panelRect.height || 0;
    const maxLeft = Math.max(0, container.clientWidth - panelWidth);
    const maxTop = Math.max(0, container.clientHeight - panelHeight);
    const minLeft = Math.min(PANEL_EDGE_MARGIN_PX, maxLeft);
    const minTop = Math.min(PANEL_EDGE_MARGIN_PX, maxTop);
    const clampedLeft = Math.min(Math.max(left, minLeft), maxLeft);
    const clampedTop = Math.min(Math.max(top, minTop), maxTop);

    controls.style.left = `${clampedLeft}px`;
    controls.style.top = `${clampedTop}px`;
    controls.style.right = "auto";
    controls.style.bottom = "auto";
    desktopCustomPosition = { left: clampedLeft, top: clampedTop };
  };

  const syncDesktopPosition = () => {
    if (isMobile()) {
      stopDesktopDrag();
      clearDesktopPosition();
      return;
    }

    if (!desktopCustomPosition) {
      clearDesktopPosition();
      return;
    }

    applyDesktopPosition(desktopCustomPosition.left, desktopCustomPosition.top);
  };

  const scheduleDesktopPositionSync = (delayMs = 0) => {
    if (positionSyncTimeout) {
      clearTimeout(positionSyncTimeout);
    }
    positionSyncTimeout = setTimeout(() => {
      positionSyncTimeout = null;
      syncDesktopPosition();
    }, delayMs);
  };

  const getDesktopBounds = () => {
    const container = controls.parentElement;
    if (!container) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    const panelRect = controls.getBoundingClientRect();

    return {
      left: panelRect.left - containerRect.left,
      top: panelRect.top - containerRect.top,
    };
  };

  const onDesktopDragMove = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startClientX;
    const deltaY = event.clientY - dragState.startClientY;
    applyDesktopPosition(dragState.startLeft + deltaX, dragState.startTop + deltaY);
  };

  const onDesktopDragEnd = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }
    stopDesktopDrag();
  };

  const onDesktopDragStart = (event) => {
    if (!header || isMobile()) {
      return;
    }
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    if (event.target?.closest?.("button, a, input, select, textarea")) {
      return;
    }

    const bounds = getDesktopBounds();
    if (!bounds) {
      return;
    }

    event.preventDefault?.();
    applyDesktopPosition(bounds.left, bounds.top);

    dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: desktopCustomPosition?.left ?? bounds.left,
      startTop: desktopCustomPosition?.top ?? bounds.top,
    };

    controls.classList.add("desktop-dragging");
    header.classList.add("dragging");
    header.setPointerCapture?.(event.pointerId);
    header.addEventListener("pointermove", onDesktopDragMove);
    header.addEventListener("pointerup", onDesktopDragEnd);
    header.addEventListener("pointercancel", onDesktopDragEnd);
  };

  const updateToggleButton = () => {
    if (!toggleBtn) {
      return;
    }
    const expanded = isMobile()
      ? controls.classList.contains("expanded")
      : isExpandedDesktop;
    toggleBtn.setAttribute("aria-expanded", expanded.toString());
    const icon = toggleBtn.querySelector("i");
    if (icon) {
      icon.style.transform = expanded ? "rotate(0deg)" : "rotate(180deg)";
    }
  };

  const setDesktopExpanded = (expanded) => {
    isExpandedDesktop = expanded;
    controls.classList.toggle("desktop-collapsed", !expanded);
    updateToggleButton();
    scheduleDesktopPositionSync(DESKTOP_COLLAPSE_SYNC_DELAY_MS);
  };

  const requestMobileToggle = () => {
    document.dispatchEvent(new CustomEvent(MOBILE_TOGGLE_EVENT, { bubbles: true }));
  };

  const toggleMapControls = () => {
    if (isMobile()) {
      requestMobileToggle();
      return;
    }
    setDesktopExpanded(!isExpandedDesktop);
  };

  const getSelectedCoverageAreaId = () => String(locationSelect?.value || "").trim();

  const hasSelectedCoverageArea = () => Boolean(getSelectedCoverageAreaId());

  const updateCoverageActionState = (areaId = null) => {
    const normalizedAreaId =
      areaId === null ? getSelectedCoverageAreaId() : String(areaId || "").trim();
    const hasSelectedArea = Boolean(normalizedAreaId);
    const streetModeButtons = document.querySelectorAll(
      ".quick-action-btn[data-street-mode]"
    );
    streetModeButtons.forEach((button) => {
      button.disabled = !hasSelectedArea;
      if (!hasSelectedArea) {
        button.classList.remove("active");
      }
    });
    if (focusCoverageBtn) {
      focusCoverageBtn.disabled = !hasSelectedArea;
    }
  };

  const setStreetMode = (mode) => {
    if (!hasSelectedCoverageArea()) {
      return;
    }

    const buttons = document.querySelectorAll(".quick-action-btn[data-street-mode]");
    const currentlyActive = [...buttons].some(
      (btn) => btn.classList.contains("active") && btn.dataset.streetMode === mode
    );

    buttons.forEach((btn) => {
      const isTarget = btn.dataset.streetMode === mode;
      if (currentlyActive) {
        btn.classList.toggle("active", false);
      } else {
        btn.classList.toggle("active", isTarget);
      }
    });

    document.dispatchEvent(
      new CustomEvent("es:streetModeChange", {
        detail: { mode, shouldHide: currentlyActive },
        bubbles: true,
      })
    );
  };

  const focusSelectedCoverageArea = () => {
    const areaId = getSelectedCoverageAreaId();
    if (!areaId) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent(FOCUS_COVERAGE_EVENT, {
        detail: { areaId },
        bubbles: true,
      })
    );
  };

  const initState = () => {
    if (isMobile()) {
      // Ensure no desktop-collapsed class lingers on mobile
      controls.classList.remove("desktop-collapsed");
      clearDesktopPosition();
      updateToggleButton();
    } else {
      setDesktopExpanded(true);
      syncDesktopPosition();
    }
    updateCoverageActionState();
  };

  const onToggleClick = (event) => {
    event.preventDefault();
    toggleMapControls();
  };

  const onLocationChange = (event) => {
    updateCoverageActionState(event?.target?.value || "");
  };

  const onCoverageSelectionChanged = (event) => {
    updateCoverageActionState(event?.detail?.areaId || "");
  };
  const onStreetModeClick = (event) => {
    const button = event.currentTarget;
    const mode = String(button?.dataset?.streetMode || "").trim();
    if (mode) {
      setStreetMode(mode);
    }
  };
  const onFocusCoverageClick = () => {
    focusSelectedCoverageArea();
  };
  const streetModeButtons = document.querySelectorAll(
    ".quick-action-btn[data-street-mode]"
  );

  if (toggleBtn) {
    toggleBtn.addEventListener("click", onToggleClick, signal ? { signal } : false);
  }
  if (locationSelect) {
    locationSelect.addEventListener(
      "change",
      onLocationChange,
      signal ? { signal } : false
    );
  }
  document.addEventListener(
    COVERAGE_SELECTION_EVENT,
    onCoverageSelectionChanged,
    signal ? { signal } : false
  );
  streetModeButtons.forEach((button) => {
    button.addEventListener("click", onStreetModeClick, signal ? { signal } : false);
  });
  focusCoverageBtn?.addEventListener(
    "click",
    onFocusCoverageClick,
    signal ? { signal } : false
  );
  header?.addEventListener("pointerdown", onDesktopDragStart);
  initState();

  const onResize = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      if (!controls) {
        return;
      }
      if (isMobile()) {
        controls.classList.remove("desktop-collapsed");
        stopDesktopDrag();
        clearDesktopPosition();
      } else {
        setDesktopExpanded(isExpandedDesktop);
        syncDesktopPosition();
      }
      updateToggleButton();
    }, 100);
  };

  window.addEventListener("resize", onResize, signal ? { signal } : false);

  const teardown = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
      resizeTimeout = null;
    }
    if (positionSyncTimeout) {
      clearTimeout(positionSyncTimeout);
      positionSyncTimeout = null;
    }
    stopDesktopDrag();
    if (toggleBtn) {
      toggleBtn.removeEventListener("click", onToggleClick);
    }
    if (locationSelect) {
      locationSelect.removeEventListener("change", onLocationChange);
    }
    streetModeButtons.forEach((button) => {
      button.removeEventListener("click", onStreetModeClick);
    });
    focusCoverageBtn?.removeEventListener("click", onFocusCoverageClick);
    header?.removeEventListener("pointerdown", onDesktopDragStart);
    document.removeEventListener(COVERAGE_SELECTION_EVENT, onCoverageSelectionChanged);
    window.removeEventListener("resize", onResize);
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }

  return teardown;
}
