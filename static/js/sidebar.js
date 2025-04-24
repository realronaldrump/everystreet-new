/* global DateUtils */

"use strict";

(() => {
  const CONFIG = {
    mobileBreakpoint: 992,
    storageKeys: {
      sidebarState: "sidebarCollapsed",
    },
  };

  const elements = {};

  function init() {
    cacheElements();

    if (!elements.sidebar) return;

    initEventListeners();
    loadSavedState();
    handleResponsiveLayout();

    window.addEventListener("resize", debounce(handleResponsiveLayout, 250));
  }

  function cacheElements() {
    elements.sidebar = document.getElementById("sidebar");
    elements.toggleButton = document.getElementById("sidebar-toggle");
    elements.collapseButton = document.getElementById("sidebar-collapse");
    elements.mainContent = document.querySelector("main");
    elements.body = document.body;
  }

  function initEventListeners() {
    [elements.toggleButton, elements.collapseButton]
      .filter(Boolean)
      .forEach((btn) =>
        btn.addEventListener("mousedown", function (e) {
          if (e.button !== 0) return;
          toggleSidebar(e);
        }),
      );

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    });

    document.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      handleClickOutside(e);
    });
  }

  function handleClickOutside(e) {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;
    const sidebarActive = elements.sidebar.classList.contains("active");
    const clickedOutside =
      !elements.sidebar.contains(e.target) &&
      (!elements.toggleButton || !elements.toggleButton.contains(e.target));

    if (isMobile && sidebarActive && clickedOutside) {
      toggleSidebar();
    }
  }

  function loadSavedState() {
    const isCollapsed = getStorage(CONFIG.storageKeys.sidebarState) === "true";
    if (isCollapsed && window.innerWidth >= CONFIG.mobileBreakpoint) {
      elements.body?.classList.add("sidebar-collapsed");
      elements.sidebar?.classList.add("collapsed");
      elements.toggleButton?.classList.add("active");
      elements.mainContent?.classList.add("expanded");
    }
  }

  function toggleSidebar() {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;

    if (isMobile) {
      elements.sidebar.classList.toggle("active");
    } else {
      elements.sidebar.classList.toggle("collapsed");
      elements.body.classList.toggle("sidebar-collapsed");
      elements.mainContent?.classList.toggle("expanded");
    }

    if (elements.toggleButton) {
      elements.toggleButton.classList.toggle("active");
      const icon = elements.toggleButton.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-bars");
        icon.classList.toggle("fa-times");
      }
    }

    if (!isMobile) {
      setStorage(
        CONFIG.storageKeys.sidebarState,
        elements.sidebar.classList.contains("collapsed"),
      );
    }
  }

  function handleResponsiveLayout() {
    if (!elements.sidebar) return;

    const isMobile = window.innerWidth < CONFIG.mobileBreakpoint;
    const isCollapsed = getStorage(CONFIG.storageKeys.sidebarState) === "true";

    if (isMobile) {
      elements.sidebar.classList.remove("collapsed");
      elements.body.classList.remove("sidebar-collapsed");
      elements.mainContent?.classList.remove("expanded");
    } else if (isCollapsed) {
      elements.body.classList.add("sidebar-collapsed");
      elements.sidebar.classList.add("collapsed");
      elements.mainContent?.classList.add("expanded");
    } else {
      elements.body.classList.remove("sidebar-collapsed");
      elements.sidebar.classList.remove("collapsed");
      elements.mainContent?.classList.remove("expanded");
    }
  }

  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function getStorage(key, defaultValue = null) {
    try {
      return localStorage.getItem(key) || defaultValue;
    } catch (e) {
      console.warn(`Error reading from localStorage: ${e.message}`);
      return defaultValue;
    }
  }

  function setStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`Error writing to localStorage: ${e.message}`);
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  document.addEventListener("DOMContentLoaded", initThemeToggle);

  function initThemeToggle() {
    const themeToggle = document.getElementById("theme-toggle-checkbox");
    if (!themeToggle) return;

    const savedTheme = getStorage("theme");
    const prefersDarkScheme = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const useLight =
      savedTheme === "light" || (!savedTheme && !prefersDarkScheme);

    if (useLight) {
      document.body.classList.add("light-mode");
      themeToggle.checked = true;
    }

    themeToggle.addEventListener("change", () => {
      if (themeToggle.checked) {
        document.body.classList.add("light-mode");
        setStorage("theme", "light");
      } else {
        document.body.classList.remove("light-mode");
        setStorage("theme", "dark");
      }

      document.dispatchEvent(
        new CustomEvent("themeChanged", {
          detail: { theme: themeToggle.checked ? "light" : "dark" },
        }),
      );
    });
  }
})();
