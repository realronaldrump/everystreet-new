/**
 * Sidebar class for managing sidebar functionality and state
 */
(() => {
    'use strict';
  
    class Sidebar {
      constructor() {
        this.elements = {
          sidebar: document.getElementById('sidebar'),
          toggleButton: document.getElementById('sidebar-toggle'),
          collapseButton: document.getElementById('sidebar-collapse'),
          startDateInput: document.getElementById('start-date'),
          endDateInput: document.getElementById('end-date'),
          mainContent: document.querySelector('main'),
          body: document.body,
        };
  
        this.config = {
          mobileBreakpoint: 992,
          storageKeys: {
            sidebarState: 'sidebarCollapsed',
            startDate: 'startDate',
            endDate: 'endDate',
          },
        };
  
        this.init();
      }
  
      // Initialize sidebar functionality
      init() {
        this.validateElements();
        this.initializeEventListeners();
        this.loadStoredDates();
        this.handleResponsiveLayout();
        this.loadSidebarState();
      }
  
      // Ensure required DOM elements exist
      validateElements() {
        const requiredElements = ['sidebar', 'toggleButton', 'mainContent', 'body'];
        const missingElements = requiredElements.filter(
          (el) => !this.elements[el]
        );
        if (missingElements.length > 0) {
          throw new Error(
            `Missing required elements: ${missingElements.join(', ')}`
          );
        }
      }
  
      // Set up all event listeners
      initializeEventListeners() {
        // Toggle buttons
        [this.elements.toggleButton, this.elements.collapseButton].forEach(
          (button) => {
            button?.addEventListener('click', this.handleToggleClick.bind(this));
          }
        );
        // Date inputs
        [this.elements.startDateInput, this.elements.endDateInput].forEach(
          (input) => {
            input?.addEventListener('change', this.handleDateChange.bind(this));
          }
        );
        // Window resize with debounce
        window.addEventListener(
          'resize',
          this.debounce(this.handleResponsiveLayout.bind(this), 250)
        );
        // Clicks outside sidebar on mobile
        document.addEventListener('click', this.handleOutsideClick.bind(this));
      }
  
      // Toggle button click handler
      handleToggleClick(e) {
        e.preventDefault();
        this.toggleSidebar();
      }
  
      // Handle clicks outside the sidebar on mobile devices
      handleOutsideClick(e) {
        const isMobile = window.innerWidth < this.config.mobileBreakpoint;
        const isOutsideClick =
          !this.elements.sidebar.contains(e.target) &&
          !this.elements.toggleButton.contains(e.target);
        const isSidebarActive = this.elements.sidebar.classList.contains('active');
        if (isMobile && isOutsideClick && isSidebarActive) {
          this.toggleSidebar();
        }
      }
  
      // Toggle sidebar open/close state
      toggleSidebar() {
        const { sidebar, toggleButton, body, mainContent } = this.elements;
        const isMobile = window.innerWidth < this.config.mobileBreakpoint;
        if (isMobile) {
          sidebar.classList.toggle('active');
        } else {
          sidebar.classList.toggle('collapsed');
          body.classList.toggle('sidebar-collapsed');
          mainContent?.classList.toggle('expanded');
        }
        toggleButton.classList.toggle('active');
        this.updateToggleButtonIcon();
        this.storeSidebarState();
      }
  
      // Update the icon on the toggle button
      updateToggleButtonIcon() {
        const icon = this.elements.toggleButton.querySelector('i');
        icon?.classList.toggle('fa-bars');
        icon?.classList.toggle('fa-times');
      }
  
      // Save the sidebar's collapsed state to localStorage
      storeSidebarState() {
        localStorage.setItem(
          this.config.storageKeys.sidebarState,
          this.elements.sidebar.classList.contains('collapsed')
        );
      }
  
      // Load sidebar state from localStorage and update UI accordingly
      loadSidebarState() {
        const isCollapsed =
          localStorage.getItem(this.config.storageKeys.sidebarState) === 'true';
        if (isCollapsed && window.innerWidth >= this.config.mobileBreakpoint) {
          const { body, sidebar, toggleButton, mainContent } = this.elements;
          body.classList.add('sidebar-collapsed');
          sidebar.classList.add('collapsed');
          toggleButton.classList.add('active');
          mainContent?.classList.add('expanded');
        }
      }
  
      // Load stored date values from localStorage into date inputs
      loadStoredDates() {
        ['startDate', 'endDate'].forEach((key) => {
          const storedValue = localStorage.getItem(this.config.storageKeys[key]);
          const inputId = key.toLowerCase().replace('date', '-date');
          const input = document.getElementById(inputId);
          if (storedValue) {
            input.value = storedValue;
          }
        });
      }
  
      // Save date input changes to localStorage
      handleDateChange(event) {
        const key = event.target.id.includes('start') ? 'startDate' : 'endDate';
        localStorage.setItem(this.config.storageKeys[key], event.target.value);
      }
  
      // Adjust layout based on viewport size
      handleResponsiveLayout() {
        const isMobile = window.innerWidth < this.config.mobileBreakpoint;
        const { sidebar, body, mainContent } = this.elements;
        if (isMobile) {
          if (!sidebar.classList.contains('active')) {
            sidebar.classList.remove('collapsed');
            body.classList.remove('sidebar-collapsed');
            mainContent?.classList.remove('expanded');
          }
        } else {
          const isCollapsed =
            localStorage.getItem(this.config.storageKeys.sidebarState) === 'true';
          if (isCollapsed) {
            body.classList.add('sidebar-collapsed');
            sidebar.classList.add('collapsed');
            mainContent?.classList.add('expanded');
          } else {
            body.classList.remove('sidebar-collapsed');
            sidebar.classList.remove('collapsed');
            mainContent?.classList.remove('expanded');
          }
        }
      }
  
      // Simple debounce helper to limit function calls
      debounce(func, wait) {
        let timeout;
        return function (...args) {
          clearTimeout(timeout);
          timeout = setTimeout(() => func(...args), wait);
        };
      }
    }
  
    // Initialize the sidebar when the DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
      try {
        new Sidebar();
      } catch (error) {
        console.error('Failed to initialize sidebar:', error);
      }
    });
  })();