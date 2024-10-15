document.addEventListener('DOMContentLoaded', function() {
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');

    // Load date range from local storage
    if (localStorage.getItem('startDate')) {
        startDateInput.value = localStorage.getItem('startDate');
    }
    if (localStorage.getItem('endDate')) {
        endDateInput.value = localStorage.getItem('endDate');
    }

    // Save date range to local storage on change
    startDateInput.addEventListener('change', () => {
        localStorage.setItem('startDate', startDateInput.value);
    });
    endDateInput.addEventListener('change', () => {
        localStorage.setItem('endDate', endDateInput.value);
    });

    // Sidebar toggle functionality
    const sidebarToggleButton = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');

    if (sidebarToggleButton) {
        sidebarToggleButton.addEventListener('click', () => {
            sidebar.classList.toggle('active');
        });
    }
});
