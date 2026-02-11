/**
 * Map Controls - Optimized Interaction Script
 * Fast, minimal, clean
 */

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

  let isExpanded = true;
  let resizeTimeout = null;
  let touchStartY = 0;
  let currentY = 0;

  const isMobile = () => window.innerWidth <= 768;

  const updateToggleButton = () => {
    if (!toggleBtn) {
      return;
    }
    toggleBtn.setAttribute("aria-expanded", isExpanded);
    const icon = toggleBtn.querySelector("i");
    if (icon) {
      icon.style.transform = isExpanded ? "rotate(0deg)" : "rotate(180deg)";
    }
  };

  const toggleMapControls = () => {
    isExpanded = !isExpanded;

    if (isMobile()) {
      controls.classList.toggle("expanded", isExpanded);
    } else {
      const body = controls.querySelector(".control-panel-body");
      const quickActions = controls.querySelector(".control-panel-quick-actions");

      if (body) {
        body.style.display = isExpanded ? "block" : "none";
      }
      if (quickActions) {
        quickActions.style.display = isExpanded ? "flex" : "none";
      }
    }

    updateToggleButton();
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

  window.toggleMapControls = toggleMapControls;
  window.setStreetMode = setStreetMode;

  const initMobileState = () => {
    if (isMobile()) {
      isExpanded = false;
      controls.classList.remove("expanded");
    } else {
      isExpanded = true;
      controls.classList.remove("expanded");
      controls.style.transform = "";
    }
    updateToggleButton();
  };

  initMobileState();

  const onTouchStart = (e) => {
    if (!isMobile() || !e.touches || e.touches.length < 1) {
      return;
    }
    touchStartY = e.touches[0].clientY;
    currentY = touchStartY;
    controls.style.transition = "none";
  };

  const onTouchMove = (e) => {
    if (!isMobile() || !e.touches || e.touches.length < 1) {
      return;
    }
    currentY = e.touches[0].clientY;
    const delta = currentY - touchStartY;

    if (isExpanded && delta > 0) {
      controls.style.transform = `translateY(${delta}px)`;
    } else if (!isExpanded && delta < 0) {
      const offset = Math.min(Math.abs(delta), window.innerHeight * 0.7);
      controls.style.transform = `translateY(calc(100% - 60px - ${offset}px))`;
    }
  };

  const onTouchEnd = () => {
    if (!isMobile()) {
      return;
    }
    controls.style.transition = "";
    const delta = currentY - touchStartY;

    if (Math.abs(delta) > 50) {
      if (delta > 0 && isExpanded) {
        toggleMapControls();
      } else if (delta < 0 && !isExpanded) {
        toggleMapControls();
      }
    } else {
      controls.classList.toggle("expanded", isExpanded);
    }
  };

  const touchOptions = signal ? { passive: true, signal } : { passive: true };
  const touchEndOptions = signal ? { signal } : false;
  controls.addEventListener("touchstart", onTouchStart, touchOptions);
  controls.addEventListener("touchmove", onTouchMove, touchOptions);
  controls.addEventListener("touchend", onTouchEnd, touchEndOptions);

  const onResize = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      if (!controls) {
        return;
      }
      controls.style.transition = "none";

      if (window.innerWidth > 768) {
        controls.classList.remove("expanded");
        controls.style.transform = "";
        isExpanded = true;
      } else {
        controls.classList.toggle("expanded", isExpanded);
      }

      setTimeout(() => {
        controls.style.transition = "";
      }, 50);
    }, 100);
  };

  window.addEventListener("resize", onResize, signal ? { signal } : false);

  const teardown = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
      resizeTimeout = null;
    }
    controls.removeEventListener("touchstart", onTouchStart);
    controls.removeEventListener("touchmove", onTouchMove);
    controls.removeEventListener("touchend", onTouchEnd);
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
