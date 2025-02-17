(() => {
  "use strict";

  class Sidebar {
    constructor() {
      this.elements = {
        sidebar: document.getElementById("sidebar"),
        toggleButton: document.getElementById("sidebar-toggle"),
        collapseButton: document.getElementById("sidebar-collapse"),
        startDateInput: document.getElementById("start-date"),
        endDateInput: document.getElementById("end-date"),
        mainContent: document.querySelector("main"),
        body: document.body,
        filtersToggle: document.getElementById("toggle-filters"),
        sidebarBody: document.querySelector(".sidebar-body"),
      };

      this.config = {
        mobileBreakpoint: 992,
        storageKeys: {
          sidebarState: "sidebarCollapsed",
          startDate: "startDate",
          endDate: "endDate",
          filtersCollapsed: "filtersCollapsed",
        },
      };

      this.init();
    }

    init() {
      this.validateElements();
      this.initializeEventListeners();
      this.loadStoredDates();
      this.handleResponsiveLayout();
      this.loadSidebarState();
      this.highlightCurrentPage();
      this.initializeScrollIndicator();
      this.initializeKeyboardNavigation();
      this.loadFiltersState();
    }

    validateElements() {
      const requiredElements = [
        "sidebar",
        "toggleButton",
        "mainContent",
        "body",
      ];
      const missingElements = requiredElements.filter(
        (el) => !this.elements[el],
      );
      if (missingElements.length > 0) {
        throw new Error(
          `Missing required elements: ${missingElements.join(", ")}`,
        );
      }
    }

    initializeEventListeners() {
      [this.elements.toggleButton, this.elements.collapseButton].forEach(
        (button) => {
          button?.addEventListener("click", this.handleToggleClick.bind(this));
        },
      );

      [this.elements.startDateInput, this.elements.endDateInput].forEach(
        (input) => {
          input?.addEventListener("change", this.handleDateChange.bind(this));
        },
      );

      window.addEventListener(
        "resize",
        this.debounce(this.handleResponsiveLayout.bind(this), 250),
      );

      document.addEventListener("click", this.handleOutsideClick.bind(this));

      if (this.elements.filtersToggle) {
        this.elements.filtersToggle.addEventListener(
          "click",
          this.handleFiltersToggle.bind(this),
        );
      }
    }

    handleToggleClick(e) {
      e.preventDefault();
      this.toggleSidebar();
    }

    handleOutsideClick(e) {
      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const isOutsideClick =
        !this.elements.sidebar.contains(e.target) &&
        !this.elements.toggleButton.contains(e.target);
      const isSidebarActive =
        this.elements.sidebar.classList.contains("active");

      if (isMobile && isOutsideClick && isSidebarActive) {
        this.toggleSidebar();
      }
    }

    toggleSidebar() {
      const { sidebar, toggleButton, body, mainContent } = this.elements;
      const isMobile = window.innerWidth < this.config.mobileBreakpoint;

      if (isMobile) {
        sidebar.classList.toggle("active");
      } else {
        sidebar.classList.toggle("collapsed");
        body.classList.toggle("sidebar-collapsed");
        mainContent?.classList.toggle("expanded");
      }

      toggleButton.classList.toggle("active");
      this.updateToggleButtonIcon();
      this.storeSidebarState();
    }

    updateToggleButtonIcon() {
      const icon = this.elements.toggleButton.querySelector("i");
      icon?.classList.toggle("fa-bars");
      icon?.classList.toggle("fa-times");
    }

    storeSidebarState() {
      localStorage.setItem(
        this.config.storageKeys.sidebarState,
        this.elements.sidebar.classList.contains("collapsed"),
      );
    }

    loadSidebarState() {
      const isCollapsed =
        localStorage.getItem(this.config.storageKeys.sidebarState) === "true";
      if (isCollapsed && window.innerWidth >= this.config.mobileBreakpoint) {
        const { body, sidebar, toggleButton, mainContent } = this.elements;
        body.classList.add("sidebar-collapsed");
        sidebar.classList.add("collapsed");
        toggleButton.classList.add("active");
        mainContent?.classList.add("expanded");
      }
    }

    loadStoredDates() {
      ["startDate", "endDate"].forEach((key) => {
        const storedValue = localStorage.getItem(this.config.storageKeys[key]);
        const inputId = key.toLowerCase().replace("date", "-date");
        const input = document.getElementById(inputId);
        if (storedValue && input) {
          input.value = storedValue;
        }
      });
    }

    handleDateChange(event) {
      const key = event.target.id.includes("start") ? "startDate" : "endDate";
      localStorage.setItem(this.config.storageKeys[key], event.target.value);
    }

    handleResponsiveLayout() {
      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const { sidebar, body, mainContent } = this.elements;

      if (isMobile) {
        if (!sidebar.classList.contains("active")) {
          sidebar.classList.remove("collapsed");
          body.classList.remove("sidebar-collapsed");
          mainContent?.classList.remove("expanded");
        }
      } else {
        const isCollapsed =
          localStorage.getItem(this.config.storageKeys.sidebarState) === "true";
        if (isCollapsed) {
          body.classList.add("sidebar-collapsed");
          sidebar.classList.add("collapsed");
          mainContent?.classList.add("expanded");
        } else {
          body.classList.remove("sidebar-collapsed");
          sidebar.classList.remove("collapsed");
          mainContent?.classList.remove("expanded");
        }
      }
    }

    handleFiltersToggle(e) {
      const isCollapsed = e.currentTarget.classList.toggle("collapsed");
      localStorage.setItem(
        this.config.storageKeys.filtersCollapsed,
        isCollapsed,
      );
    }

    loadFiltersState() {
      const isCollapsed =
        localStorage.getItem(this.config.storageKeys.filtersCollapsed) ===
        "true";
      if (isCollapsed && this.elements.filtersToggle) {
        this.elements.filtersToggle.classList.add("collapsed");
        const filtersContent = document.getElementById("filters-content");
        if (filtersContent) {
          filtersContent.classList.remove("show");
        }
      }
    }

    highlightCurrentPage() {
      const currentPath = window.location.pathname;
      const navLinks = this.elements.sidebar.querySelectorAll(".nav-link");
      navLinks.forEach((link) => {
        if (link.getAttribute("href") === currentPath) {
          link.classList.add("active");
        }
      });
    }

    initializeScrollIndicator() {
      if (this.elements.sidebarBody) {
        this.elements.sidebarBody.addEventListener(
          "scroll",
          this.handleScrollIndicator,
        );
        // Initial check
        this.handleScrollIndicator({ target: this.elements.sidebarBody });
      }
    }

    handleScrollIndicator(event) {
      const element = event.target;
      const isScrollable = element.scrollHeight > element.clientHeight;
      const isScrolledToBottom =
        Math.abs(
          element.scrollHeight - element.scrollTop - element.clientHeight,
        ) < 1;
      element.classList.toggle(
        "is-scrollable",
        isScrollable && !isScrolledToBottom,
      );
    }

    initializeKeyboardNavigation() {
      document.addEventListener("keydown", (e) => {
        // Toggle sidebar with Ctrl + B
        if (e.ctrlKey && e.key === "b") {
          e.preventDefault();
          this.toggleSidebar();
        }
      });
    }

    setButtonLoading(buttonId, isLoading) {
      const button = document.getElementById(buttonId);
      if (!button) return;

      const originalContent = button.innerHTML;
      if (isLoading) {
        button.disabled = true;
        button.innerHTML =
          '<span class="spinner-border spinner-border-sm me-1"></span> Loading...';
      } else {
        button.disabled = false;
        button.innerHTML = originalContent;
      }
    }

    debounce(func, wait) {
      let timeout;
      return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    try {
      new Sidebar();
    } catch (error) {
      console.error("Failed to initialize sidebar:", error);
    }
  });
})();
