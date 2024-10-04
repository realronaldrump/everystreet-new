document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    document.getElementById('start-date').value = sevenDaysAgo.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];

    initializeTabulator();
    fetchUniqueImeis().then(fetchTrips);

    document.getElementById('apply-filters').addEventListener('click', fetchTrips);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('fetch-trips').addEventListener('click', fetchAndStoreTrips);
    document.getElementById('export-geojson').addEventListener('click', exportGeojson);
});

let tripsTable = null; // Initialize outside to reuse the table instance

/* global Tabulator */
/* global flatpickr */

function initializeTabulator() {
    tripsTable = new Tabulator("#trips-table", {
        layout: "fitColumns",
        pagination: "local",
        paginationSize: 25,
        responsiveLayout: "hide",
        columns: [{
                title: "Transaction ID",
                field: "transactionId",
                headerFilter: "input"
            },
            {
                title: "IMEI",
                field: "imei",
                headerFilter: "input"
            },
            {
                title: "Start Time",
                field: "startTime",
                formatter: function(cell, formatterParams, onRendered) {
                    const date = new Date(cell.getValue());
                    const options = { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit', 
                        hour: '2-digit', 
                        minute: '2-digit', 
                        second: '2-digit',
                        timeZone: cell.getData().timezone
                    };
                    return date.toLocaleString('en-US', options);
                },
                sorter: "datetime"
            },
            {
                title: "End Time",
                field: "endTime",
                formatter: function(cell, formatterParams, onRendered) {
                    const date = new Date(cell.getValue());
                    const options = { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit', 
                        hour: '2-digit', 
                        minute: '2-digit', 
                        second: '2-digit',
                        timeZone: cell.getData().timezone
                    };
                    return date.toLocaleString('en-US', options);
                },
                sorter: "datetime"
            },
            {
                title: "Distance (miles)",
                field: "distance",
                formatter: "money",
                formatterParams: {
                    precision: 2
                },
                sorter: "number",
                headerFilter: "input"
            },
            {
                title: "Destination",
                field: "destination",
                headerFilter: "input"
            }
        ]
    });
}

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/trips';
    const params = new URLSearchParams();

    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    fetch(url)
        .then(response => response.json())
        .then(geojson => {
            const trips = geojson.features.map(feature => ({
                ...feature.properties,
                gps: feature.geometry,
            }));
            tripsTable.setData(trips);
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        });
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(geojson => {
            const imeis = [...new Set(geojson.features.map(feature => feature.properties.imei))];
            const imeiSelect = document.getElementById('imei');

            imeiSelect.innerHTML = ''; // Clear existing options
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
    fetch('/api/fetch_trips', {
            method: 'POST'
        })
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips(); // Refresh trips table after successful fetch
            } else {
                alert(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error fetching and storing trips:', error);
            alert('An error occurred while fetching and storing trips.');
        });
}

function exportGeojson() {
    fetch('/export/geojson')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(geojson => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "trips.geojson");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        })
        .catch(error => {
            console.error('Error exporting GeoJSON:', error);
        });
}

// Initialize date pickers with Flatpickr
flatpickr("#start-date", {
    dateFormat: "Y-m-d",
    maxDate: "today"
});

flatpickr("#end-date", {
    dateFormat: "Y-m-d",
    maxDate: "today"
});