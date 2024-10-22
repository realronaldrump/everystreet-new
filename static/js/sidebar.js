document.addEventListener('DOMContentLoaded', () => {
    initializeSidebar();
    loadStoredDates();
});

function initializeSidebar() {
    const sidebarToggleButton = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');

    if (sidebarToggleButton) {
        sidebarToggleButton.addEventListener('click', () => toggleSidebar(sidebar));
    }
}

function loadStoredDates() {
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');

    if (localStorage.getItem('startDate')) startDateInput.value = localStorage.getItem('startDate');
    if (localStorage.getItem('endDate')) endDateInput.value = localStorage.getItem('endDate');

    startDateInput.addEventListener('change', () => storeDate('startDate', startDateInput.value));
    endDateInput.addEventListener('change', () => storeDate('endDate', endDateInput.value));
}

function toggleSidebar(sidebar) {
    sidebar.classList.toggle('active');
    document.querySelector('main').classList.toggle('expanded');
}

function storeDate(key, value) {
    localStorage.setItem(key, value);
}