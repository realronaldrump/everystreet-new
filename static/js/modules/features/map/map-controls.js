/**
 * Map Controls - Desktop panel state + shared map control actions.
 *
 * Mobile sheet drag/toggle behavior is owned by mobile-map.js.
 */

const MOBILE_BREAKPOINT = "(max-width: 768px)";
const MOBILE_TOGGLE_EVENT = "es:mapControls:toggle";

export default function initMapControls({ signal, cleanup } = {}) {
  const noopTeardown = () => {};
  const controls = document.getElementById("map-controls");
  const toggleBtn = document.getElementById("controls-toggle");
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

  const getDesktopSections = () => ({
    body: controls.querySelector(".control-panel-body"),
    quickActions: controls.querySelector(".control-panel-quick-actions"),
  });

  const updateToggleButton = () => {
    if (!toggleBtn) {
      return;
    }
    const expanded = isMobile() ? controls.classList.contains("expanded") : isExpandedDesktop;
    toggleBtn.setAttribute("aria-expanded", expanded.toString());
    const icon = toggleBtn.querySelector("i");
    if (icon) {
      icon.style.transform = expanded ? "rotate(0deg)" : "rotate(180deg)";
    }
  };

  const setDesktopExpanded = (expanded) => {
    const { body, quickActions } = getDesktopSections();
    isExpandedDesktop = expanded;
    if (body) {
      body.style.display = expanded ? "block" : "none";
    }
    if (quickActions) {
      quickActions.style.display = expanded ? "flex" : "none";
    }
    updateToggleButton();
  };

  const clearDesktopInlineStyles = () => {
    const { body, quickActions } = getDesktopSections();
    if (body) {
      body.style.display = "";
    }
    if (quickActions) {
      quickActions.style.display = "";
    }
  };

  const requestMobileToggle = () => {
    document.dispatchEvent(
      new CustomEvent(MOBILE_TOGGLE_EVENT, {
        bubbles: true,
      })
    );
  };

  const toggleMapControls = () => {
    if (isMobile()) {
      requestMobileToggle();
      return;
    }
    setDesktopExpanded(!isExpandedDesktop);
  };

  const setStreetMode = (mode) => {
    document.querySelectorAll(".quick-action-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.streetMode === mode);
    });

    document.dispatchEvent(
      new CustomEvent("es:streetModeChange", {
        detail: { mode },
        bubbles: true,
      })
    );
  };

  const initState = () => {
    if (isMobile()) {
      clearDesktopInlineStyles();
      updateToggleButton();
      return;
    }
    setDesktopExpanded(true);
  };

  const onToggleClick = (event) => {
    event.preventDefault();
    toggleMapControls();
  };

  if (toggleBtn) {
    toggleBtn.addEventListener("click", onToggleClick, signal ? { signal } : false);
  }

  window.toggleMapControls = toggleMapControls;
  window.setStreetMode = setStreetMode;
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
        clearDesktopInlineStyles();
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
    window.removeEventListener("resize", onResize);
    if (window.toggleMapControls === toggleMapControls) {
      window.toggleMapControls = undefined;
    }
    if (window.setStreetMode === setStreetMode) {
      window.setStreetMode = undefined;
    }
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  }

  return teardown;
}
