// Performance monitoring
if ("PerformanceObserver" in window) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "largest-contentful-paint") {
        // LCP monitoring - could log metrics here if needed
      }
    }
  });
  observer.observe({ entryTypes: ["largest-contentful-paint"] });
}

// Helper function for updating live tracking visibility
function updateLiveTrackingVisibility() {
  const liveTrackingPanel = document.getElementById("live-tracking-panel");
  if (!liveTrackingPanel) {
    return;
  }
  const showLiveTracking = window.localStorage.getItem("showLiveTracking");
  // Default: show panel unless setting exists and is explicitly "false"
  const shouldShow = showLiveTracking !== "false";
  liveTrackingPanel.classList.toggle("d-none", !shouldShow);
}

// Script for toggling chevron in metrics collapse
window.utils?.onPageLoad(
  ({ signal } = {}) => {
    const metricsButton = document.querySelector(
      '[data-bs-target="#metrics-content"]',
    );
    if (metricsButton) {
      const chevron = metricsButton.querySelector(".fa-chevron-down");
      metricsButton.addEventListener(
        "click",
        () => {
          const isExpanded =
            metricsButton.getAttribute("aria-expanded") === "true";
          if (chevron) {
            chevron.style.transform = isExpanded
              ? "rotate(0deg)"
              : "rotate(180deg)";
          }
        },
        signal ? { signal } : false,
      );
      // Initial state check for chevron if panel is collapsed by default
      if (metricsButton.getAttribute("aria-expanded") === "false" && chevron) {
        chevron.style.transform = "rotate(0deg)";
      } else if (chevron) {
        chevron.style.transform = "rotate(180deg)";
      }

      // Toggle Live Tracking Panel visibility based on user setting - initial state
      updateLiveTrackingVisibility();

      // Fetch server-side setting once and reconcile localStorage
      (async () => {
        try {
          const res = await fetch("/api/app_settings");
          if (res.ok) {
            const data = await res.json();
            if (typeof data.showLiveTracking !== "undefined") {
              window.localStorage.setItem(
                "showLiveTracking",
                data.showLiveTracking,
              );
              updateLiveTrackingVisibility();
            }
          }
        } catch (error) {
          console.warn("Failed to load app settings", error);
        }
      })();

      // Respond to changes from other tabs/windows or settings page
      window.addEventListener(
        "storage",
        (e) => {
          if (e.key === "showLiveTracking") {
            updateLiveTrackingVisibility();
          }
        },
        signal ? { signal } : false,
      );
    }

    const setupMapTilt = () => {
      const map = window.map || window.coverageMasterMap;
      if (!map || typeof map.easeTo !== "function") {
        return;
      }
      let ticking = false;
      const maxPitch = 12;
      const maxScroll = 320;

      const applyTilt = () => {
        ticking = false;
        if (window.liveTripTracker?.followMode) {
          return;
        }
        const scrollY = window.scrollY || 0;
        const ratio = Math.min(scrollY / maxScroll, 1);
        map.easeTo({
          pitch: ratio * maxPitch,
          duration: 300,
          essential: true,
        });
      };

      window.addEventListener(
        "scroll",
        () => {
          if (ticking) {
            return;
          }
          ticking = true;
          requestAnimationFrame(applyTilt);
        },
        signal ? { signal, passive: true } : { passive: true },
      );
    };

    setupMapTilt();
  },
  { route: "/map" },
);
