document.addEventListener('DOMContentLoaded', () => {
    fetchTrips();
    fetchUniqueImeis(); 

    document.getElementById('apply-filters').addEventListener('click', fetchTrips);
});

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/trips';
    if (startDate || endDate || imei) {
        url += '?';
        if (startDate) url += `start_date=${startDate}&`;
        if (endDate) url += `end_date=${endDate}&`;
        if (imei) url += `imei=${imei}`;
        if (url.endsWith('&')) url = url.slice(0, -1); 
    }

    fetch(url)
        .then(response => response.json())
        .then(trips => {
            console.log('Fetched trips:', trips); // Log the fetched trips
            const tripsList = document.querySelector('#trips-list tbody');
            tripsList.innerHTML = ''; 

            trips.forEach(trip => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${trip.transactionId}</td>
                    <td>${trip.imei}</td>
                    <td>${trip.startTime}</td>
                    <td>${trip.endTime}</td>
                    <td>${trip.distance}</td>
                `;
                tripsList.appendChild(row);
            });
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        });
}

function fetchUniqueImeis() {
    fetch('/api/trips') 
        .then(response => response.json())
        .then(trips => {
            const imeis = [...new Set(trips.map(trip => trip.imei))];
            const imeiSelect = document.getElementById('imei');

            imeis.forEach(imei => {
                const option = document.createElement('option');
                option.value = imei;
                option.text = imei;
                imeiSelect.appendChild(option);
            });
        })
        .catch(error => {
            console.error('Error fetching unique IMEIs:', error);
        });
}