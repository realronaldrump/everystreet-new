document.addEventListener('DOMContentLoaded', () => {
    initializeTabulator();
    fetchTrips();
    fetchUniqueImeis();

    document.getElementById('apply-filters').addEventListener('click', fetchTrips);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('fetch-trips').addEventListener('click', fetchAndStoreTrips);
});

function initializeTabulator() {
    new Tabulator("#trips-table", {
        layout: "fitColumns",
        columns: [
            { title: "Transaction ID", field: "transactionId" },
            { title: "IMEI", field: "imei" },
            { title: "Start Time", field: "startTime", formatter: "datetime" },
            { title: "End Time", field: "endTime", formatter: "datetime" },
            { title: "Distance", field: "distance", formatter: "money", formatterParams: { precision: 2 } },
            { title: "Destination", field: "destination" }
        ],
    });
}

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
        .then(geojson => {
            const trips = geojson.features.map(feature => ({
                ...feature.properties,
                gps: feature.geometry
            }));
            Tabulator("#trips-table").setData(trips);
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        });
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then(response => response.json())
        .then(geojson => {
            const imeis = [...new Set(geojson.features.map(feature => feature.properties.imei))];
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

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('main');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}

function fetchAndStoreTrips() {
    fetch('/api/fetch_trips', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips();
            } else {
                alert(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error fetching and storing trips:', error);
            alert('An error occurred while fetching and storing trips.');
        });
}

document.getElementById('export-geojson').addEventListener('click', () => {
    fetch('/export/geojson')
        .then(response => response.json())
        .then(geojson => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "trips.geojson");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        })
        .catch(error => console.error('Error exporting GeoJSON:', error));
});

// Initialize date pickers
flatpickr("#start-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});

flatpickr("#end-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});
