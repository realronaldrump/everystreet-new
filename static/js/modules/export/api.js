/**
 * Export API Module
 * Handles building export URLs and API-related operations
 */

/**
 * Build export URL for trips or matched trips
 * @param {Object} config - Export configuration
 * @param {Object} elements - Cached DOM elements
 * @returns {string} Export URL
 * @throws {Error} If date validation fails
 */
export function buildTripsExportUrl(config, elements) {
  const startDate = elements[config.dateStart]?.value;
  const endDate = elements[config.dateEnd]?.value;
  const format = elements[config.format]?.value;

  if (!startDate || !endDate) {
    throw new Error("Please select both start and end dates");
  }

  if (!window.DateUtils?.isValidDateRange(startDate, endDate)) {
    throw new Error("Start date must be before or equal to end date");
  }

  return `${config.endpoint}?start_date=${startDate}&end_date=${endDate}&format=${format}`;
}

/**
 * Build export URL for streets or boundary exports
 * @param {Object} config - Export configuration
 * @param {Object} elements - Cached DOM elements
 * @param {Function} validateLocationInput - Location validation function
 * @returns {string} Export URL
 * @throws {Error} If location validation fails
 */
export function buildLocationExportUrl(
  config,
  elements,
  validateLocationInput,
) {
  const locationInput = elements[config.location];
  const format = elements[config.format]?.value;

  if (!validateLocationInput(locationInput)) {
    throw new Error("Invalid location. Please validate it first.");
  }

  const locationData = locationInput.getAttribute("data-location");
  return `${config.endpoint}?location=${encodeURIComponent(locationData)}&format=${format}`;
}

/**
 * Build export URL for advanced exports
 * @param {Object} config - Export configuration
 * @param {Object} elements - Cached DOM elements
 * @param {Function} saveSettings - Function to save settings
 * @returns {string} Export URL
 * @throws {Error} If date validation fails
 */
export function buildAdvancedExportUrl(config, elements, saveSettings) {
  const format = elements[config.format]?.value;
  let url = `${config.endpoint}?format=${format}`;

  // Append boolean flags
  const flags = {
    include_trips: elements.includeTrips,
    include_matched_trips: elements.includeMatchedTrips,
    include_uploaded_trips: elements.includeUploadedTrips,
    include_basic_info: elements.includeBasicInfo,
    include_locations: elements.includeLocations,
    include_telemetry: elements.includeTelemetry,
    include_geometry: elements.includeGeometry,
    include_meta: elements.includeMeta,
    include_custom: elements.includeCustom,
  };

  for (const [key, element] of Object.entries(flags)) {
    if (element) {
      url += `&${key}=${element.checked}`;
    }
  }

  // Append CSV specific flags
  if (format === "csv") {
    if (elements.includeGpsInCsv) {
      url += `&include_gps_in_csv=${elements.includeGpsInCsv.checked}`;
    }
    if (elements.flattenLocationFields) {
      url += `&flatten_location_fields=${elements.flattenLocationFields.checked}`;
    }
  }

  // Append date range if not exporting all dates
  if (elements.exportAllDates && !elements.exportAllDates.checked) {
    const startDate = elements[config.dateStart]?.value;
    const endDate = elements[config.dateEnd]?.value;

    if (!startDate || !endDate) {
      throw new Error(
        "Please select both start and end dates or check 'Export all dates'",
      );
    }

    if (!window.DateUtils?.isValidDateRange(startDate, endDate)) {
      throw new Error("Start date must be before or equal to end date");
    }

    url += `&start_date=${startDate}&end_date=${endDate}`;
  }

  // Optionally save settings
  if (elements.saveExportSettings?.checked && saveSettings) {
    saveSettings();
  }

  return url;
}

/**
 * Build export URL based on form type
 * @param {string} formType - Type of export form
 * @param {Object} config - Export configuration
 * @param {Object} elements - Cached DOM elements
 * @param {Function} validateLocationInput - Location validation function
 * @param {Function} saveSettings - Function to save settings
 * @returns {string} Export URL
 * @throws {Error} If validation fails
 */
export function buildExportUrl(
  formType,
  config,
  elements,
  validateLocationInput,
  saveSettings,
) {
  switch (formType) {
    case "trips":
    case "matchedTrips":
      return buildTripsExportUrl(config, elements);

    case "streets":
    case "boundary":
      return buildLocationExportUrl(config, elements, validateLocationInput);

    case "advanced":
      return buildAdvancedExportUrl(config, elements, saveSettings);

    default: {
      // Fallback for any potentially added simple formats
      const format = elements[config.format]?.value;
      if (!format) {
        throw new Error(
          `Could not determine format for export type '${formType}'`,
        );
      }
      return `${config.endpoint}?format=${format}`;
    }
  }
}

/**
 * Fetch coverage areas from the API
 * @returns {Promise<Array>} Array of coverage areas
 */
export async function fetchCoverageAreas() {
  const response = await fetch("/api/coverage_areas");
  const data = await response.json();

  if (data.success && Array.isArray(data?.areas)) {
    return data.areas;
  }

  return [];
}

/**
 * Validate a location via the API
 * @param {string} location - Location string to validate
 * @param {string} locationType - Type of location (default: "city")
 * @returns {Promise<Object>} Validated location data
 */
export async function validateLocationApi(location, locationType = "city") {
  const response = await fetch("/api/validate_location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location,
      locationType,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Fetch undriven streets for an area
 * @param {Object} area - Area object with location data
 * @returns {Promise<Response>} Fetch response
 */
export async function fetchUndrivenStreets(area) {
  const response = await fetch("/api/undriven_streets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(area),
  });

  if (!response.ok) {
    let msg = `Export failed (${response.status})`;
    try {
      const errData = await response.json();
      msg = errData.detail || msg;
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(msg);
  }

  return response;
}

export default {
  buildTripsExportUrl,
  buildLocationExportUrl,
  buildAdvancedExportUrl,
  buildExportUrl,
  fetchCoverageAreas,
  validateLocationApi,
  fetchUndrivenStreets,
};
