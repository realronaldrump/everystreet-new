/**
 * App Settings Module - Handles app preferences, tab switching, and settings form
 */

import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";

export function setupTabSwitching({ signal } = {}) {
  const tabs = document.querySelectorAll(".settings-tab");
  const tabContents = document.querySelectorAll(".settings-tab-content");
  const TAB_STORAGE_KEY = "es:settings-active-tab";
  const LEGACY_TAB_MAP = {
    "background-tasks": "sync-settings",
    bouncie: "credentials",
    database: "storage",
  };

  const normalizeTabName = (value) => {
    if (!value) {
      return "";
    }
    const name = value.replace(/^#/, "").trim();
    const normalized = name.endsWith("-tab") ? name.slice(0, -4) : name;
    return LEGACY_TAB_MAP[normalized] || normalized;
  };

  function setActiveTab(tabName, { persist = true, updateHash = false } = {}) {
    if (!tabName) {
      return false;
    }

    const tabButton = document.querySelector(`.settings-tab[data-tab="${tabName}"]`);
    const tabContent = document.getElementById(`${tabName}-tab`);

    if (!tabButton || !tabContent) {
      return false;
    }

    tabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === tabName);
    });

    tabContents.forEach((content) => {
      content.classList.toggle("active", content.id === `${tabName}-tab`);
    });

    if (persist) {
      localStorage.setItem(TAB_STORAGE_KEY, tabName);
    }

    if (updateHash) {
      const url = new URL(window.location.href);
      url.hash = tabName;
      window.history.replaceState(window.history.state, document.title, url.toString());
    }

    return true;
  }

  const hashTab = normalizeTabName(window.location.hash);
  if (!hashTab || !setActiveTab(hashTab, { persist: true })) {
    const storedTab = normalizeTabName(localStorage.getItem(TAB_STORAGE_KEY));
    if (storedTab && !setActiveTab(storedTab, { persist: false })) {
      localStorage.removeItem(TAB_STORAGE_KEY);
    }
  }

  const eventOptions = signal ? { signal } : false;

  tabs.forEach((tab) => {
    tab.addEventListener(
      "click",
      function () {
        const tabName = this.dataset.tab;

        setActiveTab(tabName, { updateHash: true });
      },
      eventOptions
    );
  });

  window.addEventListener(
    "hashchange",
    () => {
      const tabName = normalizeTabName(window.location.hash);
      setActiveTab(tabName);
    },
    eventOptions
  );
}

export function setupAppSettingsForm() {
  const darkModeToggle = document.getElementById("dark-mode-toggle");
  const highlightRecentTrips = document.getElementById("highlight-recent-trips");
  const autoCenterToggle = document.getElementById("auto-center-toggle");
  const geocodeTripsOnFetch = document.getElementById("geocode-trips-on-fetch");
  const mapMatchTripsOnFetch = document.getElementById("map-match-trips-on-fetch");
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
      geocodeTripsOnFetch: gtof,
      mapMatchTripsOnFetch: mmtof,
      accentColor,
      uiDensity,
      motionMode,
      widgetEditing,
    } = settings;

    const isDarkMode =
      document.documentElement.getAttribute("data-bs-theme") === "dark";

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
    if (geocodeTripsOnFetch) {
      geocodeTripsOnFetch.checked = gtof !== false;
    }
    if (mapMatchTripsOnFetch) {
      mapMatchTripsOnFetch.checked = mmtof === true;
    }

    const storedAccent =
      accentColor || localStorage.getItem("es:accent-color") || "#b87a4a";
    if (accentColorPicker) {
      accentColorPicker.value = storedAccent;
    }
    const densityValue =
      uiDensity || localStorage.getItem("es:ui-density") || "comfortable";
    densityOptions.forEach((input) => {
      input.checked = input.value === densityValue;
    });
    const motionValue =
      motionMode || localStorage.getItem("es:motion-mode") || "balanced";
    motionOptions.forEach((input) => {
      input.checked = input.value === motionValue;
    });
    if (widgetEditToggle) {
      const storedWidgetEditing =
        widgetEditing ?? localStorage.getItem("es:widget-editing");
      widgetEditToggle.checked =
        storedWidgetEditing === true || storedWidgetEditing === "true";
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
      const data = await apiClient.get("/api/app_settings");
      applySettings(data);
    } catch {
      applySettings();
    }
  })();

  // Save preferences function
  async function savePreferences() {
    const densityValue = [...densityOptions].find((input) => input.checked)?.value;
    const motionValue = [...motionOptions].find((input) => input.checked)?.value;
    const payload = {
      highlightRecentTrips: highlightRecentTrips?.checked,
      autoCenter: autoCenterToggle?.checked,
      geocodeTripsOnFetch: geocodeTripsOnFetch?.checked,
      mapMatchTripsOnFetch: mapMatchTripsOnFetch?.checked,
      accentColor: accentColorPicker?.value,
      uiDensity: densityValue || "comfortable",
      motionMode: motionValue || "balanced",
      widgetEditing: widgetEditToggle?.checked || false,
    };

    try {
      await apiClient.post("/api/app_settings", payload);
    } catch {
      notificationManager.show("Failed to save settings on server", "danger");
      return;
    }

    // Mirror to localStorage
    localStorage.setItem("highlightRecentTrips", payload.highlightRecentTrips);
    localStorage.setItem("autoCenter", payload.autoCenter);
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
    notificationManager.show("Settings saved successfully", "success");
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
export function initAppSettings({ signal } = {}) {
  setupTabSwitching({ signal });
  setupAppSettingsForm();
}
