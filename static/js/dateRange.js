/* global flatpickr */
document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const storedStartDate = localStorage.getItem('startDate');
    const storedEndDate = localStorage.getItem('endDate');

    const startDate = storedStartDate ? new Date(storedStartDate) : today;
    const endDate = storedEndDate ? new Date(storedEndDate) : today;

    flatpickr("#start-date", {
        dateFormat: "Y-m-d",
        maxDate: "today",
        defaultDate: startDate,
        onChange(selectedDates) {
            const date = selectedDates[0];
            localStorage.setItem('startDate', date.toISOString().split('T')[0]);
        }
    });

    flatpickr("#end-date", {
        dateFormat: "Y-m-d",
        maxDate: "today",
        defaultDate: endDate,
        onChange(selectedDates) {
            const date = selectedDates[0];
            localStorage.setItem('endDate', date.toISOString().split('T')[0]);
        }
    });
});