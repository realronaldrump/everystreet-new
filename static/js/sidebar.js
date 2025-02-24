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
      const missing = requiredElements.filter((el) => !this.elements[el]);
      if (missing.length) {
        throw new Error(`Missing required elements: ${missing.join(", ")}`);
      }
    }

    initializeEventListeners() {
      [this.elements.toggleButton, this.elements.collapseButton].forEach(
        (button) => {
          button?.addEventListener("click", (e) => {
            e.preventDefault();
            this.toggleSidebar();
          });
        },
      );

      [this.elements.startDateInput, this.elements.endDateInput].forEach(
        (input) => {
          input?.addEventListener("change", (e) => {
            const key = e.target.id.includes("start") ? "startDate" : "endDate";
            localStorage.setItem(this.config.storageKeys[key], e.target.value);
          });
        },
      );

      window.addEventListener(
        "resize",
        this.debounce(() => this.handleResponsiveLayout(), 250),
      );
      document.addEventListener("click", (e) => this.handleOutsideClick(e));
      this.elements.filtersToggle?.addEventListener("click", (e) =>
        this.handleFiltersToggle(e),
      );
    }

    handleOutsideClick(e) {
      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const clickedOutside =
        !this.elements.sidebar.contains(e.target) &&
        !this.elements.toggleButton.contains(e.target);
      if (
        isMobile &&
        clickedOutside &&
        this.elements.sidebar.classList.contains("active")
      ) {
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
        const stored = localStorage.getItem(this.config.storageKeys[key]);
        const input = document.getElementById(
          key.toLowerCase().replace("date", "-date"),
        );
        if (stored && input) input.value = stored;
      });
    }

    handleResponsiveLayout() {
      const isMobile = window.innerWidth < this.config.mobileBreakpoint;
      const { sidebar, body, mainContent } = this.elements;
      if (isMobile) {
        sidebar.classList.remove("collapsed");
        body.classList.remove("sidebar-collapsed");
        mainContent?.classList.remove("expanded");
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
      const collapsed = e.currentTarget.classList.toggle("collapsed");
      localStorage.setItem(this.config.storageKeys.filtersCollapsed, collapsed);
    }

    loadFiltersState() {
      const isCollapsed =
        localStorage.getItem(this.config.storageKeys.filtersCollapsed) ===
        "true";
      if (isCollapsed && this.elements.filtersToggle) {
        this.elements.filtersToggle.classList.add("collapsed");
        const filtersContent = document.getElementById("filters-content");
        if (filtersContent) filtersContent.classList.remove("show");
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
        this.elements.sidebarBody.addEventListener("scroll", (e) =>
          this.handleScrollIndicator(e),
        );
        this.handleScrollIndicator({ target: this.elements.sidebarBody });
      }
    }

    handleScrollIndicator(e) {
      const el = e.target;
      const isScrollable = el.scrollHeight > el.clientHeight;
      const atBottom =
        Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 1;
      el.classList.toggle("is-scrollable", isScrollable && !atBottom);
    }

    initializeKeyboardNavigation() {
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key === "b") {
          e.preventDefault();
          this.toggleSidebar();
        }
      });
    }

    setButtonLoading(buttonId, isLoading) {
      const button = document.getElementById(buttonId);
      if (!button) return;
      const original = button.innerHTML;
      if (isLoading) {
        button.disabled = true;
        button.innerHTML =
          '<span class="spinner-border spinner-border-sm me-1"></span> Loading...';
      } else {
        button.disabled = false;
        button.innerHTML = original;
      }
    }

    debounce(func, wait) {
      let timeout;
      return (...args) => {
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
