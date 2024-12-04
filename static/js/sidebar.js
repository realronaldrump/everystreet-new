/**
 * Sidebar class for managing sidebar functionality and state
 */
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
		dateElement: document.getElementById('current-date'),
		timeElement: document.getElementById('current-time'),
	  };
  
	  this.config = {
		mobileBreakpoint: 992, // Bootstrap's lg breakpoint
		clockUpdateInterval: 1000,
		storageKeys: {
		  sidebarState: 'sidebarCollapsed',
		  startDate: 'startDate',
		  endDate: 'endDate',
		},
	  };
  
	  this.init();
	}
  
	/**
	 * Initialize all sidebar functionality
	 */
	init() {
	  this.validateElements();
	  this.initializeEventListeners();
	  this.loadStoredDates();
	  this.initializeClock();
	  this.handleResponsiveLayout();
	  this.loadSidebarState();
	}
  
	/**
	 * Validate that all required DOM elements exist
	 * @throws {Error} If required elements are missing
	 */
	validateElements() {
	  const requiredElements = ['sidebar', 'toggleButton', 'mainContent', 'body'];
	  const missingElements = requiredElements.filter(
		(element) => !this.elements[element]
	  );
  
	  if (missingElements.length > 0) {
		throw new Error(`Missing required elements: ${missingElements.join(', ')}`);
	  }
	}
  
	/**
	 * Initialize all event listeners
	 */
	initializeEventListeners() {
	  // Toggle button listeners
	  [this.elements.toggleButton, this.elements.collapseButton].forEach((button) => {
		if (button) {
		  button.addEventListener('click', this.handleToggleClick.bind(this));
		}
	  });
  
	  // Date input listeners
	  [this.elements.startDateInput, this.elements.endDateInput].forEach((input) => {
		if (input) {
		  input.addEventListener('change', this.handleDateChange.bind(this));
		}
	  });
  
	  // Window resize handler with debounce
	  window.addEventListener(
		'resize',
		this.debounce(this.handleResponsiveLayout.bind(this), 250)
	  );
  
	  // Handle clicks outside sidebar on mobile
	  document.addEventListener('click', this.handleOutsideClick.bind(this));
	}
  
	/**
	 * Handle toggle button clicks
	 * @param {Event} e - Click event
	 */
	handleToggleClick(e) {
	  e.preventDefault();
	  this.toggleSidebar();
	}
  
	/**
	 * Handle clicks outside the sidebar
	 * @param {Event} e - Click event
	 */
	handleOutsideClick(e) {
	  const isMobile = window.innerWidth < this.config.mobileBreakpoint;
	  const isOutsideClick =
		!this.elements.sidebar.contains(e.target) &&
		!this.elements.toggleButton.contains(e.target);
	  const isSidebarActive = this.elements.sidebar.classList.contains('active');
  
	  // Only handle outside clicks on mobile when the sidebar is actually visible
	  if (
		isMobile &&
		isOutsideClick &&
		isSidebarActive &&
		!this.elements.body.classList.contains('sidebar-collapsed')
	  ) {
		this.toggleSidebar();
	  }
	}
  
	/**
	 * Toggle sidebar state
	 */
	toggleSidebar() {
	  const { sidebar, toggleButton, body, mainContent } = this.elements;
	  const isMobile = window.innerWidth < this.config.mobileBreakpoint;
  
	  if (isMobile) {
		// For mobile, toggle 'active' class on sidebar
		sidebar.classList.toggle('active');
	  } else {
		// For desktop, toggle 'collapsed' class on sidebar
		sidebar.classList.toggle('collapsed');
		body.classList.toggle('sidebar-collapsed');
		if (mainContent) {
		  mainContent.classList.toggle('expanded');
		}
	  }
  
	  toggleButton.classList.toggle('active');
  
	  this.updateToggleButtonIcon();
	  this.storeSidebarState();
	}
  
	/**
	 * Update toggle button icon
	 */
	updateToggleButtonIcon() {
	  const icon = this.elements.toggleButton.querySelector('i');
	  if (icon) {
		icon.classList.toggle('fa-bars');
		icon.classList.toggle('fa-times');
	  }
	}
  
	/**
	 * Store sidebar state in localStorage
	 */
	storeSidebarState() {
	  localStorage.setItem(
		this.config.storageKeys.sidebarState,
		this.elements.sidebar.classList.contains('collapsed')
	  );
	}
  
	/**
	 * Load sidebar state from localStorage
	 */
	loadSidebarState() {
	  const isCollapsed =
		localStorage.getItem(this.config.storageKeys.sidebarState) === 'true';
	  if (isCollapsed && window.innerWidth >= this.config.mobileBreakpoint) {
		const { body, sidebar, toggleButton, mainContent } = this.elements;
		body.classList.add('sidebar-collapsed');
		sidebar.classList.add('collapsed');
		toggleButton.classList.add('active');
		if (mainContent) {
		  mainContent.classList.add('expanded');
		}
	  }
	}
  
	/**
	 * Load stored dates from localStorage
	 */
	loadStoredDates() {
	  ['startDate', 'endDate'].forEach((key) => {
		const storedValue = localStorage.getItem(this.config.storageKeys[key]);
		const inputId = key.toLowerCase().replace('date', '-date');
		const input = document.getElementById(inputId);
  
		if (storedValue && input) {
		  input.value = storedValue;
		}
	  });
	}
  
	/**
	 * Handle date input changes
	 * @param {Event} event - Change event
	 */
	handleDateChange(event) {
	  const key = event.target.id.includes('start') ? 'startDate' : 'endDate';
	  localStorage.setItem(this.config.storageKeys[key], event.target.value);
	}
  
	/**
	 * Initialize clock functionality
	 */
	initializeClock() {
	  const updateClock = () => {
		const now = new Date();
		const { dateElement, timeElement } = this.elements;
  
		if (dateElement) {
		  dateElement.textContent = now.toLocaleDateString();
		}
		if (timeElement) {
		  timeElement.textContent = now.toLocaleTimeString();
		}
	  };
  
	  updateClock();
	  setInterval(updateClock, this.config.clockUpdateInterval);
	}
  
	/**
	 * Handle responsive layout changes
	 */
	handleResponsiveLayout() {
	  const isMobile = window.innerWidth < this.config.mobileBreakpoint;
	  const { sidebar, body, mainContent } = this.elements;
  
	  if (isMobile) {
		// For mobile, ensure sidebar is hidden initially
		sidebar.classList.remove('collapsed');
		body.classList.remove('sidebar-collapsed');
		sidebar.classList.remove('active');
		if (mainContent) {
		  mainContent.classList.remove('expanded');
		}
	  } else {
		// For desktop, apply collapsed state if stored
		const isCollapsed =
		  localStorage.getItem(this.config.storageKeys.sidebarState) === 'true';
		if (isCollapsed) {
		  body.classList.add('sidebar-collapsed');
		  sidebar.classList.add('collapsed');
		  if (mainContent) {
			mainContent.classList.add('expanded');
		  }
		} else {
		  body.classList.remove('sidebar-collapsed');
		  sidebar.classList.remove('collapsed');
		  if (mainContent) {
			mainContent.classList.remove('expanded');
		  }
		}
	  }
	}
  
	/**
	 * Debounce helper function
	 * @param {Function} func - Function to debounce
	 * @param {number} wait - Wait time in milliseconds
	 * @returns {Function} Debounced function
	 */
	debounce(func, wait) {
	  let timeout;
	  return function executedFunction(...args) {
		const later = () => {
		  clearTimeout(timeout);
		  func(...args);
		};
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
	  };
	}
  }
  
  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
	try {
	  new Sidebar();
	} catch (error) {
	  console.error('Failed to initialize sidebar:', error);
	}
  });