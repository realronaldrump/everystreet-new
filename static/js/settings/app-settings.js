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
      if (tabContent) {
        tabContent.classList.add("active");
      }
    });
  });
}

export function setupAppSettingsForm() {
  const darkModeToggle = document.getElementById("dark-mode-toggle");
  const highlightRecentTrips = document.getElementById("highlight-recent-trips");
  const autoCenterToggle = document.getElementById("auto-center-toggle");
  const showLiveTracking = document.getElementById("show-live-tracking");
  const polylineColor = document.getElementById("polyline-color");
  const polylineOpacity = document.getElementById("polyline-opacity");
  const opacityValue = document.getElementById("opacity-value");
  const geocodeTripsOnFetch = document.getElementById("geocode-trips-on-fetch");
  const form = document.getElementById("app-settings-form");
  const themeToggleCheckbox = document.getElementById("theme-toggle-checkbox");
  const accentColorPicker = document.getElementById("accent-color-picker");
  const densityOptions = document.querySelectorAll("input[name='ui-density']");
  const motionOptions = document.querySelectorAll("input[name='motion-mode']");
  const widgetEditToggle = document.getElementById("widget-edit-mode");

  // Function to apply settings to UI
  function applySettings(settings = {}) {
    const {
      highlightRecentTrips: hrt,
      autoCenter,
      showLiveTracking: slt,
      polylineColor: pc,
      polylineOpacity: po,
      geocodeTripsOnFetch: gtof,
      accentColor,
      uiDensity,
      motionMode,
      widgetEditing,
    } = settings;

    const isDarkMode
      = document.documentElement.getAttribute("data-bs-theme") === "dark";

    // Apply settings to form elements
    if (darkModeToggle) {
      darkModeToggle.checked = isDarkMode;
    }
    if (highlightRecentTrips) {
      highlightRecentTrips.checked = hrt !== false;
    }
    if (autoCenterToggle) {
      autoCenterToggle.checked = autoCenter !== false;
    }
    if (showLiveTracking) {
      showLiveTracking.checked = slt !== false;
    }
    if (geocodeTripsOnFetch) {
      geocodeTripsOnFetch.checked = gtof !== false;
    }
    if (polylineColor) {
      polylineColor.value = pc || localStorage.getItem("polylineColor") || "#00FF00";
    }
    if (polylineOpacity) {
      polylineOpacity.value = po || localStorage.getItem("polylineOpacity") || "0.8";
      if (opacityValue) {
        opacityValue.textContent = polylineOpacity.value;
      }
    }

    const storedAccent
      = accentColor || localStorage.getItem("es:accent-color") || "#7c9d96";
    if (accentColorPicker) {
      accentColorPicker.value = storedAccent;
    }
    const densityValue
      = uiDensity || localStorage.getItem("es:ui-density") || "comfortable";
    densityOptions.forEach((input) => {
      input.checked = input.value === densityValue;
    });
    const motionValue
      = motionMode || localStorage.getItem("es:motion-mode") || "balanced";
    motionOptions.forEach((input) => {
      input.checked = input.value === motionValue;
    });
    if (widgetEditToggle) {
      const storedWidgetEditing
        = widgetEditing ?? localStorage.getItem("es:widget-editing");
      widgetEditToggle.checked
        = storedWidgetEditing === true || storedWidgetEditing === "true";
    }

    window.personalization?.applyPreferences?.({
      accentColor: storedAccent,
      density: densityValue,
      motion: motionValue,
      widgetEditing: widgetEditToggle?.checked,
      persist: false,
    });
  }

  // Load settings from server
  (async () => {
    try {
      const res = await fetch("/api/app_settings");
      if (res.ok) {
        const data = await res.json();
        applySettings(data);
      } else {
        applySettings();
      }
    } catch {
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
    const densityValue = [...densityOptions].find((input) => input.checked)?.value;
    const motionValue = [...motionOptions].find((input) => input.checked)?.value;
    const payload = {
      highlightRecentTrips: highlightRecentTrips?.checked,
      autoCenter: autoCenterToggle?.checked,
      showLiveTracking: showLiveTracking?.checked,
      polylineColor: polylineColor?.value,
      polylineOpacity: polylineOpacity?.value,
      geocodeTripsOnFetch: geocodeTripsOnFetch?.checked,
      accentColor: accentColorPicker?.value,
      uiDensity: densityValue || "comfortable",
      motionMode: motionValue || "balanced",
      widgetEditing: widgetEditToggle?.checked || false,
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
    } catch {
      window.notificationManager?.show("Failed to save settings on server", "danger");
      return;
    }

    // Mirror to localStorage
    localStorage.setItem("highlightRecentTrips", payload.highlightRecentTrips);
    localStorage.setItem("autoCenter", payload.autoCenter);
    localStorage.setItem("showLiveTracking", payload.showLiveTracking);
    localStorage.setItem("polylineColor", payload.polylineColor);
    localStorage.setItem("polylineOpacity", payload.polylineOpacity);
    localStorage.setItem("es:accent-color", payload.accentColor || "");
    localStorage.setItem("es:ui-density", payload.uiDensity);
    localStorage.setItem("es:motion-mode", payload.motionMode);
    localStorage.setItem("es:widget-editing", payload.widgetEditing ? "true" : "false");

    window.personalization?.applyPreferences?.({
      accentColor: payload.accentColor,
      density: payload.uiDensity,
      motion: payload.motionMode,
      widgetEditing: payload.widgetEditing,
      persist: false,
    });
    document.dispatchEvent(
      new CustomEvent("widgets:set-edit", {
        detail: { enabled: payload.widgetEditing },
      })
    );

    // Show success
    if (window.notificationManager) {
      window.notificationManager.show("Settings saved successfully", "success");
    }

    // Update live tracker if active
    if (window.liveTracker) {
      try {
        window.liveTracker.updatePolylineStyle(
          payload.polylineColor,
          payload.polylineOpacity
        );
      } catch (error) {
        console.warn("Failed to update live tracker polyline style", error);
      }
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

  accentColorPicker?.addEventListener("input", () => {
    window.personalization?.applyPreferences?.({
      accentColor: accentColorPicker.value,
      persist: false,
    });
  });

  densityOptions.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        window.personalization?.applyPreferences?.({
          density: input.value,
          persist: false,
        });
      }
    });
  });

  motionOptions.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        window.personalization?.applyPreferences?.({
          motion: input.value,
          persist: false,
        });
      }
    });
  });

  widgetEditToggle?.addEventListener("change", () => {
    document.dispatchEvent(
      new CustomEvent("widgets:set-edit", {
        detail: { enabled: widgetEditToggle.checked },
      })
    );
  });
}

/**
 * Initialize all app settings functionality
 */
export function initAppSettings() {
  setupTabSwitching();
  setupAppSettingsForm();
}
