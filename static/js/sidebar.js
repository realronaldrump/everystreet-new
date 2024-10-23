class Sidebar {
    constructor() {
        this.sidebar = document.getElementById('sidebar');
        this.toggleButton = document.getElementById('sidebar-toggle');
        this.collapseButton = document.getElementById('sidebar-collapse');
        this.startDateInput = document.getElementById('start-date');
        this.endDateInput = document.getElementById('end-date');
        this.mainContent = document.querySelector('main');
        this.body = document.body;
        
        this.init();
    }

    init() {
        this.initializeEventListeners();
        this.loadStoredDates();
        this.initializeClock();
        this.handleResponsiveLayout();
        this.loadSidebarState();
    }

    initializeEventListeners() {
        // Toggle buttons
        [this.toggleButton, this.collapseButton].forEach(button => {
            if (button) {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.toggleSidebar();
                });
            }
        });

        // Date inputs
        [this.startDateInput, this.endDateInput].forEach(input => {
            if (input) {
                input.addEventListener('change', (e) => this.handleDateChange(e));
            }
        });

        // Window resize handler
        window.addEventListener('resize', () => this.handleResponsiveLayout());

        // Handle clicks outside sidebar on mobile
        document.addEventListener('click', (e) => {
            if (window.innerWidth < 992) {
                if (!this.sidebar.contains(e.target) && 
                    !this.toggleButton.contains(e.target) && 
                    this.sidebar.classList.contains('active')) {
                    this.toggleSidebar();
                }
            }
        });
    }

    toggleSidebar() {
        this.sidebar.classList.toggle('active');
        this.toggleButton.classList.toggle('active');
        this.body.classList.toggle('sidebar-collapsed');
        
        if (this.mainContent) {
            this.mainContent.classList.toggle('expanded');
        }

        // Store state
        localStorage.setItem('sidebarCollapsed', this.body.classList.contains('sidebar-collapsed'));

        // Update toggle button icon
        const icon = this.toggleButton.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-bars');
            icon.classList.toggle('fa-times');
        }
    }

    loadSidebarState() {
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
        if (isCollapsed) {
            this.body.classList.add('sidebar-collapsed');
            this.sidebar.classList.add('active');
            this.toggleButton.classList.add('active');
            if (this.mainContent) {
                this.mainContent.classList.add('expanded');
            }
        }
    }

    loadStoredDates() {
        ['startDate', 'endDate'].forEach(key => {
            const storedValue = localStorage.getItem(key);
            const input = document.getElementById(key.toLowerCase().replace('date', '-date'));
            if (storedValue && input) {
                input.value = storedValue;
            }
        });
    }

    handleDateChange(event) {
        const key = event.target.id.replace('-', '') === 'startdate' ? 'startDate' : 'endDate';
        this.storeDate(key, event.target.value);
    }

    storeDate(key, value) {
        localStorage.setItem(key, value);
    }

    initializeClock() {
        const updateClock = () => {
            const now = new Date();
            const dateElement = document.getElementById('current-date');
            const timeElement = document.getElementById('current-time');

            if (dateElement) {
                dateElement.textContent = now.toLocaleDateString();
            }
            if (timeElement) {
                timeElement.textContent = now.toLocaleTimeString();
            }
        };

        updateClock();
        setInterval(updateClock, 1000);
    }

    handleResponsiveLayout() {
        const isMobile = window.innerWidth < 992; // Bootstrap's lg breakpoint
        if (isMobile) {
            this.sidebar.classList.remove('active');
            document.querySelector('main')?.classList.remove('expanded');
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = new Sidebar();
});
