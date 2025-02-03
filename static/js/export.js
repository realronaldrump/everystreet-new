document.addEventListener("DOMContentLoaded", () => {
  initializeExportForms();
  // Add a new init for the "Export All" form
  const exportAllForm = document.getElementById("export-all-form");
  if (exportAllForm) {
    exportAllForm.addEventListener("submit", (event) => {
      event.preventDefault();
      exportAllTrips();
    });
  }
});

function initializeExportForms() {
  initializeFormListener("export-trips-form", exportTrips);
  initializeFormListener("export-matched-trips-form", exportMatchedTrips);
  initializeFormListener("export-streets-form", exportStreets);
  initializeFormListener("export-boundary-form", exportBoundary);
}

function initializeFormListener(formId, submitHandler) {
  const form = document.getElementById(formId);
  if (form)
    form.addEventListener("submit", (event) =>
      handleFormSubmit(event, submitHandler),
    );
}

function handleFormSubmit(event, handler) {
  event.preventDefault();
  handler();
}

function exportTrips() {
  const url = getExportUrl(
    "trips-start-date",
    "trips-end-date",
    "trips-format",
  );
  downloadFile(url, `trips.${document.getElementById("trips-format").value}`);
}

function exportMatchedTrips() {
  const url = getExportUrl(
    "matched-trips-start-date",
    "matched-trips-end-date",
    "matched-trips-format",
  );
  downloadFile(
    url,
    `matched_trips.${document.getElementById("matched-trips-format").value}`,
  );
}

function exportStreets() {
  const locationInput = document.getElementById("streets-location");
  const format = document.getElementById("streets-format").value;
  if (!locationInput) return alert("Please enter a location.");

  const locationData = locationInput.getAttribute("data-location");
  if (!locationData) return alert("Please validate the location first.");

  const url = `/api/export/streets?location=${encodeURIComponent(locationData)}&format=${format}`;
  downloadFile(url, `streets.${format}`);
}

function exportBoundary() {
  const locationInput = document.getElementById("boundary-location");
  const format = document.getElementById("boundary-format").value;
  if (!locationInput) return alert("Please enter a location.");

  const locationData = locationInput.getAttribute("data-location");
  if (!locationData) return alert("Please validate the location first.");

  const url = `/api/export/boundary?location=${encodeURIComponent(locationData)}&format=${format}`;
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
    .then((response) => response.blob())
    .then((blob) => {
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
    })
    .catch((error) => {
      console.error("Error downloading file:", error);
      alert("An error occurred while downloading the file. Please try again.");
    });
}

function validateLocation(inputId) {
  const locationInput = document.getElementById(inputId);
  if (!locationInput || !locationInput.value.trim()) {
    alert("Please enter a location.");
    return;
  }

  fetch("/api/validate_location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: locationInput.value,
      locationType: "city",
    }),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data) {
        locationInput.setAttribute("data-location", JSON.stringify(data));
        locationInput.setAttribute(
          "data-display-name",
          data.display_name || data.name || locationInput.value,
        );
        // Enable the submit button in the parent form
        const form = locationInput.closest("form");
        if (form) {
          const submitButton = form.querySelector('button[type="submit"]');
          if (submitButton) {
            submitButton.disabled = false;
          }
        }
        alert("Location validated successfully!");
      } else {
        alert("Location not found. Please try a different search term.");
      }
    })
    .catch((error) => {
      console.error("Error validating location:", error);
      alert("Error validating location. Please try again.");
    });
}

// The new function to handle "Export All"
function exportAllTrips() {
  const format = document.getElementById("all-format").value;
  const url = `/api/export/all_trips?format=${format}`;
  downloadFile(url, `all_trips.${format}`);
}
