document.addEventListener('DOMContentLoaded', () => {
	initializeExportForms();
});

function initializeExportForms() {
	initializeFormListener('export-trips-form', exportTrips);
	initializeFormListener('export-matched-trips-form', exportMatchedTrips);
	initializeFormListener('export-streets-form', exportStreets);
	initializeFormListener('export-boundary-form', exportBoundary);
}

function initializeFormListener(formId, submitHandler) {
	const form = document.getElementById(formId);
	if (form) form.addEventListener('submit', event => handleFormSubmit(event, submitHandler));
}

function handleFormSubmit(event, handler) {
	event.preventDefault();
	handler();
}

function exportTrips() {
	const url = getExportUrl('trips-start-date', 'trips-end-date', 'trips-format');
	downloadFile(url, `trips.${document.getElementById('trips-format').value}`);
}

function exportMatchedTrips() {
	const url = getExportUrl('matched-trips-start-date', 'matched-trips-end-date', 'matched-trips-format');
	downloadFile(url, `matched_trips.${document.getElementById('matched-trips-format').value}`);
}

function exportStreets() {
	const location = document.getElementById('streets-location').value;
	const format = document.getElementById('streets-format').value;
	if (!location) return alert('Please enter a location.');
	const url = `/api/export/streets?location=${encodeURIComponent(location)}&format=${format}`;
	downloadFile(url, `streets.${format}`);
}

function exportBoundary() {
	const location = document.getElementById('boundary-location').value;
	const format = document.getElementById('boundary-format').value;
	if (!location) return alert('Please enter a location.');
	const url = `/api/export/boundary?location=${encodeURIComponent(location)}&format=${format}`;
	downloadFile(url, `boundary.${format}`);
}

function getExportUrl(startDateId, endDateId, formatId) {
	const startDate = document.getElementById(startDateId).value;
	const endDate = document.getElementById(endDateId).value;
	const format = document.getElementById(formatId).value;
	return `/api/export/trips?start_date=${startDate}&end_date=${endDate}&format=${format}`;
}

function downloadFile(url, filename) {
	fetch(url)
		.then(response => response.blob())
		.then(blob => {
			const blobUrl = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.style.display = 'none';
			a.href = blobUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(blobUrl);
		})
		.catch(error => {
			console.error('Error downloading file:', error);
			alert('An error occurred while downloading the file. Please try again.');
		});
}