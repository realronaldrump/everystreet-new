/**
 * Undriven Streets Export
 * Handles the undriven streets export functionality
 */

import { fetchCoverageAreas, fetchUndrivenStreets } from "./api.js";
import { triggerDownload } from "./download.js";
import { generateTimestamp, geojsonToGpx, sanitizeFilename } from "./format-utils.js";
import { setButtonLoading } from "./ui.js";

/**
 * Initialize the undriven streets export form
 */
export function initUndrivenStreetsExport() {
  const locationSelect = document.getElementById("undriven-streets-location");
  const formatSelect = document.getElementById("undriven-streets-format");
  const exportBtn = document.getElementById("export-undriven-streets-btn");
  const form = document.getElementById("export-undriven-streets-form");

  if (!locationSelect || !form) {
    console.warn("Undriven streets form elements not found");
    return;
  }

  // Fetch areas and populate dropdown
  loadCoverageAreas(locationSelect);

  // Enable export button only if area is selected
  locationSelect.addEventListener("change", () => {
    if (exportBtn) {
      exportBtn.disabled = !locationSelect.value;
    }
  });

  // Handle form submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleUndrivenStreetsExport(locationSelect, formatSelect, exportBtn);
  });
}

/**
 * Load coverage areas into the location select dropdown
 * @param {HTMLSelectElement} locationSelect - Location select element
 */
async function loadCoverageAreas(locationSelect) {
  try {
    const areas = await fetchCoverageAreas();

    locationSelect.innerHTML = '<option value="">Select an area...</option>';

    if (areas.length > 0) {
      areas.forEach((area) => {
        if (area.location?.display_name) {
          const opt = document.createElement("option");
          opt.value = JSON.stringify(area.location);
          opt.textContent = area.location.display_name;
          locationSelect.appendChild(opt);
        }
      });
    } else {
      locationSelect.innerHTML = '<option value="">No areas found</option>';
    }
  } catch (err) {
    locationSelect.innerHTML = '<option value="">Failed to load areas</option>';
    window.notificationManager?.show(`Failed to load areas: ${err.message}`, "error");
  }
}

/**
 * Handle the undriven streets export submission
 * @param {HTMLSelectElement} locationSelect - Location select element
 * @param {HTMLSelectElement} formatSelect - Format select element
 * @param {HTMLButtonElement} exportBtn - Export button element
 */
async function handleUndrivenStreetsExport(locationSelect, formatSelect, exportBtn) {
  if (!locationSelect.value) {
    return;
  }

  const originalText = setButtonLoading(exportBtn, true, "Export Undriven Streets");
  window.notificationManager?.show("Exporting undriven streets...", "info");

  try {
    const format = formatSelect?.value || "geojson";
    const area = JSON.parse(locationSelect.value);

    const response = await fetchUndrivenStreets(area);

    let blob = null;
    const displayName = area.display_name || "undriven_streets";
    const sanitizedName = sanitizeFilename(displayName);
    const timestamp = generateTimestamp();
    // Use underscores for timestamp in filename
    const dateStr = timestamp.replace(/-/g, "_").substring(0, 16);
    let filename = `${sanitizedName}_undriven_${dateStr}`;

    if (format === "gpx") {
      // Convert GeoJSON to GPX client-side
      const geojson = await response.json();
      blob = new Blob([geojsonToGpx(geojson)], {
        type: "application/gpx+xml",
      });
      filename += ".gpx";
    } else {
      blob = await response.blob();
      filename += ".geojson";
    }

    triggerDownload(
      blob,
      filename,
      format === "gpx" ? "application/gpx+xml" : "application/geo+json"
    );

    window.notificationManager?.show("Undriven streets export completed", "success");
  } catch (err) {
    window.notificationManager?.show(`Export failed: ${err.message}`, "error");
  } finally {
    setButtonLoading(exportBtn, false, originalText);
  }
}

export default {
  initUndrivenStreetsExport,
};
