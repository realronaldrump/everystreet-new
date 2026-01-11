/**
 * Export Settings Manager
 * Handles saving and loading export settings from local storage
 */

import { EXPORT_SETTINGS_STORAGE_KEY } from "./config.js";

/**
 * Save current export settings to local storage
 * @param {Object} elements - Cached DOM elements
 */
export function saveExportSettings(elements) {
  try {
    const settings = {
      dataSources: {
        includeTrips: elements.includeTrips?.checked,
        includeMatchedTrips: elements.includeMatchedTrips?.checked,
        includeUploadedTrips: elements.includeUploadedTrips?.checked,
      },
      dataFields: {
        includeBasicInfo: elements.includeBasicInfo?.checked,
        includeLocations: elements.includeLocations?.checked,
        includeTelemetry: elements.includeTelemetry?.checked,
        includeGeometry: elements.includeGeometry?.checked,
        includeMeta: elements.includeMeta?.checked,
        includeCustom: elements.includeCustom?.checked,
      },
      dateSettings: {
        exportAllDates: elements.exportAllDates?.checked,
      },
      format: elements["adv-format"]?.value,
    };

    window.utils?.setStorage(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Error saving export settings:", error);
  }
}

/**
 * Load saved export settings from local storage
 * @param {Object} elements - Cached DOM elements
 * @param {Function} updateUIBasedOnFormat - Function to update UI for format changes
 */
export function loadSavedExportSettings(elements, updateUIBasedOnFormat) {
  try {
    const savedSettingsJSON = window.utils?.getStorage(EXPORT_SETTINGS_STORAGE_KEY);
    if (!savedSettingsJSON) {
      return;
    }

    const settings = JSON.parse(savedSettingsJSON);
    setDataSources(settings.dataSources, elements);
    setDataFields(settings.dataFields, elements);
    setDateSettings(settings.dateSettings, elements);
    setFormat(settings.format, elements, updateUIBasedOnFormat);
  } catch (error) {
    console.warn("Error loading saved export settings:", error);
  }
}

/**
 * Set data source checkboxes from saved settings
 * @param {Object} dataSources - Data source settings
 * @param {Object} elements - Cached DOM elements
 */
function setDataSources(dataSources, elements) {
  if (!dataSources) {
    return;
  }

  if (elements.includeTrips && dataSources.includeTrips !== undefined) {
    elements.includeTrips.checked = dataSources.includeTrips;
  }
  if (elements.includeMatchedTrips && dataSources.includeMatchedTrips !== undefined) {
    elements.includeMatchedTrips.checked = dataSources.includeMatchedTrips;
  }
  if (elements.includeUploadedTrips && dataSources.includeUploadedTrips !== undefined) {
    elements.includeUploadedTrips.checked = dataSources.includeUploadedTrips;
  }
}

/**
 * Set data field checkboxes from saved settings
 * @param {Object} dataFields - Data field settings
 * @param {Object} elements - Cached DOM elements
 */
function setDataFields(dataFields, elements) {
  if (!dataFields) {
    return;
  }

  if (elements.includeBasicInfo && dataFields.includeBasicInfo !== undefined) {
    elements.includeBasicInfo.checked = dataFields.includeBasicInfo;
  }
  if (elements.includeLocations && dataFields.includeLocations !== undefined) {
    elements.includeLocations.checked = dataFields.includeLocations;
  }
  if (elements.includeTelemetry && dataFields.includeTelemetry !== undefined) {
    elements.includeTelemetry.checked = dataFields.includeTelemetry;
  }
  if (elements.includeGeometry && dataFields.includeGeometry !== undefined) {
    elements.includeGeometry.checked = dataFields.includeGeometry;
  }
  if (elements.includeMeta && dataFields.includeMeta !== undefined) {
    elements.includeMeta.checked = dataFields.includeMeta;
  }
  if (elements.includeCustom && dataFields.includeCustom !== undefined) {
    elements.includeCustom.checked = dataFields.includeCustom;
  }
}

/**
 * Set date settings from saved settings
 * @param {Object} dateSettings - Date settings
 * @param {Object} elements - Cached DOM elements
 */
function setDateSettings(dateSettings, elements) {
  if (
    !dateSettings
    || !elements.exportAllDates
    || dateSettings.exportAllDates === undefined
  ) {
    return;
  }

  elements.exportAllDates.checked = dateSettings.exportAllDates;

  const startDateInput = document.getElementById("adv-start-date");
  const endDateInput = document.getElementById("adv-end-date");

  if (startDateInput && endDateInput) {
    startDateInput.disabled = dateSettings.exportAllDates;
    endDateInput.disabled = dateSettings.exportAllDates;
  }
}

/**
 * Set format from saved settings
 * @param {string} format - Format value
 * @param {Object} elements - Cached DOM elements
 * @param {Function} updateUIBasedOnFormat - Function to update UI for format changes
 */
function setFormat(format, elements, updateUIBasedOnFormat) {
  if (format && elements?.["adv-format"]) {
    elements["adv-format"].value = format;
    if (updateUIBasedOnFormat) {
      updateUIBasedOnFormat(format);
    }
  }
}

export default {
  saveExportSettings,
  loadSavedExportSettings,
};
