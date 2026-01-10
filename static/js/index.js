// Performance monitoring
if ("PerformanceObserver" in window) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "largest-contentful-paint") {

      }
    }
  });
  observer.observe({ entryTypes: ["largest-contentful-paint"] });
}

// Script for toggling chevron in metrics collapse
document.addEventListener("DOMContentLoaded", () => {
  const metricsButton = document.querySelector('[data-bs-target="#metrics-content"]');
  if (metricsButton) {
    const chevron = metricsButton.querySelector(".fa-chevron-down");
    metricsButton.addEventListener("click", () => {
      const isExpanded = metricsButton.getAttribute("aria-expanded") === "true";
      if (chevron) {
        chevron.style.transform = isExpanded ? "rotate(0deg)" : "rotate(180deg)";
      }
    });
    // Initial state check for chevron if panel is collapsed by default
    if (metricsButton.getAttribute("aria-expanded") === "false" && chevron) {
      chevron.style.transform = "rotate(0deg)";
    } else if (chevron) {
      chevron.style.transform = "rotate(180deg)";
    }

    // Toggle Live Tracking Panel visibility based on user setting
    const liveTrackingPanel = document.getElementById("live-tracking-panel");
    function updateLiveTrackingVisibility() {
      if (!liveTrackingPanel) return;
      const showLiveTracking = window.localStorage.getItem("showLiveTracking");
      // Default: show panel unless setting exists and is explicitly "false"
      const shouldShow = showLiveTracking !== "false";
      liveTrackingPanel.classList.toggle("d-none", !shouldShow);
    }

    // Initial state
    updateLiveTrackingVisibility();

    // Fetch server-side setting once and reconcile localStorage
    (async () => {
      try {
        const res = await fetch("/api/app_settings");
        if (res.ok) {
          const data = await res.json();
          if (typeof data.showLiveTracking !== "undefined") {
            window.localStorage.setItem("showLiveTracking", data.showLiveTracking);
            updateLiveTrackingVisibility();
          }
        }
      } catch (err) {
        console.warn("Unable to sync showLiveTracking setting:", err);
      }
    })();

    // Respond to changes from other tabs/windows or settings page
    window.addEventListener("storage", (e) => {
      if (e.key === "showLiveTracking") {
        updateLiveTrackingVisibility();
      }
    });
  }
});
