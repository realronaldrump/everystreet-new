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

export default function initMapControls({ signal, cleanup } = {}) {
  const noopTeardown = () => {};
  const controls = document.getElementById("map-controls");
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

  const isMobile = () =>
    window.matchMedia
      ? window.matchMedia(MOBILE_BREAKPOINT).matches
      : window.innerWidth <= 768;

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
    const streetModeButtons = document.querySelectorAll(".quick-action-btn[data-street-mode]");
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
      updateToggleButton();
    } else {
      setDesktopExpanded(true);
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
  const streetModeButtons = document.querySelectorAll(".quick-action-btn[data-street-mode]");

  if (toggleBtn) {
    toggleBtn.addEventListener("click", onToggleClick, signal ? { signal } : false);
  }
  if (locationSelect) {
    locationSelect.addEventListener("change", onLocationChange, signal ? { signal } : false);
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
      } else {
        setDesktopExpanded(isExpandedDesktop);
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
    document.removeEventListener(COVERAGE_SELECTION_EVENT, onCoverageSelectionChanged);
    window.removeEventListener("resize", onResize);
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }

  return teardown;
}
