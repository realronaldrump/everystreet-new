/**
 * App Settings Module - Handles app preferences, tab switching, and settings form
 */

export function setupTabSwitching() {
  const tabs = document.querySelectorAll(".settings-tab");

  tabs.forEach((tab) => {
    tab.addEventListener("click", function () {
      const tabName = this.dataset.tab;

      // Update tab buttons
      document.querySelectorAll(".settings-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.tab === tabName);
      });

      // Update tab content
      document.querySelectorAll(".settings-tab-content").forEach((content) => {
        content.classList.remove("active");
      });
      const tabContent = document.getElementById(`${tabName}-tab`);
      if (tabContent) tabContent.classList.add("active");
    });
  });
}

export function setupAppSettingsForm() {
  const darkModeToggle = document.getElementById("dark-mode-toggle");
  const highlightRecentTrips = document.getElementById(
    "highlight-recent-trips",
  );
  const autoCenterToggle = document.getElementById("auto-center-toggle");
  const showLiveTracking = document.getElementById("show-live-tracking");
  const polylineColor = document.getElementById("polyline-color");
  const polylineOpacity = document.getElementById("polyline-opacity");
  const opacityValue = document.getElementById("opacity-value");
  const geocodeTripsOnFetch = document.getElementById("geocode-trips-on-fetch");
  const form = document.getElementById("app-settings-form");
  const themeToggleCheckbox = document.getElementById("theme-toggle-checkbox");

  // Function to apply settings to UI
  function applySettings(settings = {}) {
    const {
      highlightRecentTrips: hrt,
      autoCenter,
      showLiveTracking: slt,
      polylineColor: pc,
      polylineOpacity: po,
      geocodeTripsOnFetch: gtof,
    } = settings;

    const isDarkMode =
      document.documentElement.getAttribute("data-bs-theme") === "dark";

    // Apply settings to form elements
    if (darkModeToggle) darkModeToggle.checked = isDarkMode;
    if (highlightRecentTrips) highlightRecentTrips.checked = hrt !== false;
    if (autoCenterToggle) autoCenterToggle.checked = autoCenter !== false;
    if (showLiveTracking) showLiveTracking.checked = slt !== false;
    if (geocodeTripsOnFetch) geocodeTripsOnFetch.checked = gtof !== false;
    if (polylineColor)
      polylineColor.value =
        pc || localStorage.getItem("polylineColor") || "#00FF00";
    if (polylineOpacity) {
      polylineOpacity.value =
        po || localStorage.getItem("polylineOpacity") || "0.8";
      if (opacityValue) opacityValue.textContent = polylineOpacity.value;
    }
  }

  // Load settings from server
  (async () => {
    try {
      const res = await fetch("/api/app_settings");
      if (res.ok) {
        const data = await res.json();
        applySettings(data);
      } else {
        console.warn("Failed to fetch app settings. HTTP", res.status);
        applySettings();
      }
    } catch (_err) {
      applySettings();
    }
  })();

  // Sync opacity display
  if (polylineOpacity && opacityValue) {
    polylineOpacity.addEventListener("input", function () {
      opacityValue.textContent = this.value;
    });
  }

  // Save preferences function
  async function savePreferences() {
    const payload = {
      highlightRecentTrips: highlightRecentTrips?.checked,
      autoCenter: autoCenterToggle?.checked,
      showLiveTracking: showLiveTracking?.checked,
      polylineColor: polylineColor?.value,
      polylineOpacity: polylineOpacity?.value,
      geocodeTripsOnFetch: geocodeTripsOnFetch?.checked,
    };

    try {
      const resp = await fetch("/api/app_settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        throw new Error(`Server returned ${resp.status}`);
      }
    } catch (err) {
      window.notificationManager?.show(
        "Failed to save settings on server",
        "danger",
      );
      return;
    }

    // Mirror to localStorage
    localStorage.setItem("highlightRecentTrips", payload.highlightRecentTrips);
    localStorage.setItem("autoCenter", payload.autoCenter);
    localStorage.setItem("showLiveTracking", payload.showLiveTracking);
    localStorage.setItem("polylineColor", payload.polylineColor);
    localStorage.setItem("polylineOpacity", payload.polylineOpacity);

    // Show success
    if (window.notificationManager) {
      window.notificationManager.show("Settings saved successfully", "success");
    }

    // Update live tracker if active
    if (window.liveTracker) {
      try {
        window.liveTracker.updatePolylineStyle(
          payload.polylineColor,
          payload.polylineOpacity,
        );
      } catch (_err) {}
    }
  }

  // Form submission
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await savePreferences();
    });
  }

  // Dark mode toggle sync
  if (darkModeToggle) {
    darkModeToggle.addEventListener("change", function () {
      if (themeToggleCheckbox) {
        themeToggleCheckbox.checked = !this.checked;
        themeToggleCheckbox.dispatchEvent(new Event("change"));
      }
    });
  }
}

/**
 * Initialize all app settings functionality
 */
export function initAppSettings() {
  setupTabSwitching();
  setupAppSettingsForm();
}
