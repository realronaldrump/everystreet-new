/**
 * Map Controls - Optimized Interaction Script
 * Fast, minimal, clean
 */

(() => {
  // Cache DOM references
  const controls = document.getElementById("map-controls");
  const toggleBtn = document.getElementById("controls-toggle");
  let isExpanded = true;

  // Toggle controls visibility (desktop and mobile)
  window.toggleMapControls = () => {
    if (!controls) return;

    isExpanded = !isExpanded;

    // Mobile: toggle expanded class
    if (window.innerWidth <= 768) {
      controls.classList.toggle("expanded", isExpanded);
    } else {
      // Desktop: collapse/expand content
      const body = controls.querySelector(".control-panel-body");
      const quickActions = controls.querySelector(".control-panel-quick-actions");

      if (body) {
        body.style.display = isExpanded ? "block" : "none";
      }
      if (quickActions) {
        quickActions.style.display = isExpanded ? "flex" : "none";
      }
    }

    // Update toggle button
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", isExpanded);
      const icon = toggleBtn.querySelector("i");
      if (icon) {
        icon.style.transform = isExpanded ? "rotate(0deg)" : "rotate(180deg)";
      }
    }
  };

  // Street mode selection (optimized)
  window.setStreetMode = (mode) => {
    // Update quick action buttons
    document.querySelectorAll(".quick-action-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.streetMode === mode);
    });

    // Dispatch event for map manager
    document.dispatchEvent(
      new CustomEvent("es:streetModeChange", {
        detail: { mode },
        bubbles: true,
      })
    );
  };

  // Initialize on load
  document.addEventListener("DOMContentLoaded", () => {
    // Mobile: start collapsed
    if (window.innerWidth <= 768 && controls) {
      isExpanded = false;
      controls.classList.remove("expanded");
    }

    // Touch optimization for mobile sheet
    if (controls && window.innerWidth <= 768) {
      let startY = 0;
      let currentY = 0;

      controls.addEventListener(
        "touchstart",
        (e) => {
          startY = e.touches[0].clientY;
          controls.style.transition = "none";
        },
        { passive: true }
      );

      controls.addEventListener(
        "touchmove",
        (e) => {
          currentY = e.touches[0].clientY;
          const delta = currentY - startY;

          if (isExpanded && delta > 0) {
            // Dragging down when expanded
            controls.style.transform = `translateY(${delta}px)`;
          } else if (!isExpanded && delta < 0) {
            // Dragging up when collapsed
            const offset = Math.min(Math.abs(delta), window.innerHeight * 0.7);
            controls.style.transform = `translateY(calc(100% - 60px - ${offset}px))`;
          }
        },
        { passive: true }
      );

      controls.addEventListener("touchend", () => {
        controls.style.transition = "";
        const delta = currentY - startY;

        // Toggle based on drag direction
        if (Math.abs(delta) > 50) {
          if (delta > 0 && isExpanded) {
            toggleMapControls(); // Collapse
          } else if (delta < 0 && !isExpanded) {
            toggleMapControls(); // Expand
          }
        } else {
          // Snap back
          controls.classList.toggle("expanded", isExpanded);
        }
      });
    }
  });

  // Debounced resize handler
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (controls) {
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
      }
    }, 100);
  });
})();
