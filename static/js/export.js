/* global */

"use strict";
(() => {
  const elements = {};

  const activeExports = {};

  const EXPORT_CONFIG = {
    trips: {
      id: "export-trips-form",
      dateStart: "trips-start-date",
      dateEnd: "trips-end-date",
      format: "trips-format",
      endpoint: "/api/export/trips",
      name: "trips",
    },
    matchedTrips: {
      id: "export-matched-trips-form",
      dateStart: "matched-trips-start-date",
      dateEnd: "matched-trips-end-date",
      format: "matched-trips-format",
      endpoint: "/api/export/matched_trips",
      name: "map-matched trips",
    },
    streets: {
      id: "export-streets-form",
      location: "streets-location",
      format: "streets-format",
      endpoint: "/api/export/streets",
      name: "streets",
    },
    boundary: {
      id: "export-boundary-form",
      location: "boundary-location",
      format: "boundary-format",
      endpoint: "/api/export/boundary",
      name: "boundary",
    },
    advanced: {
      id: "advanced-export-form",
      dateStart: "adv-start-date",
      dateEnd: "adv-end-date",
      format: "adv-format",
      endpoint: "/api/export/advanced",
      name: "advanced export",
    },
    undrivenStreets: {
      id: "export-undriven-streets-form",
      location: "undriven-streets-location",
      format: "undriven-streets-format",
      endpoint: "/api/undriven_streets",
      name: "undriven streets",
    },
  };

  function init() {
    cacheElements();
    initEventListeners();
    initDatePickers();
    loadSavedExportSettings();
    initUndrivenStreetsExport();

    const formatSelect = document.getElementById("adv-format");
    if (formatSelect) {
      const initialFormat = formatSelect.value;
      if (elements.csvOptionsContainer) {
        elements.csvOptionsContainer.style.display =
          initialFormat === "csv" ? "block" : "none";
      }
    }
  }

  function cacheElements() {
    Object.values(EXPORT_CONFIG).forEach((config) => {
      elements[config.id] = document.getElementById(config.id);

      if (config.location) {
        elements[config.location] = document.getElementById(config.location);
      }

      if (config.format) {
        elements[config.format] = document.getElementById(config.format);
      }

      if (config.dateStart) {
        elements[config.dateStart] = document.getElementById(config.dateStart);
      }

      if (config.dateEnd) {
        elements[config.dateEnd] = document.getElementById(config.dateEnd);
      }
    });

    elements.validateButtons = document.querySelectorAll(
      ".validate-location-btn",
    );

    elements.exportAllDates = document.getElementById("export-all-dates");
    elements.saveExportSettings = document.getElementById(
      "save-export-settings",
    );

    elements.includeTrips = document.getElementById("include-trips");
    elements.includeMatchedTrips = document.getElementById(
      "include-matched-trips",
    );
    elements.includeUploadedTrips = document.getElementById(
      "include-uploaded-trips",
    );

    elements.includeBasicInfo = document.getElementById("include-basic-info");
    elements.includeLocations = document.getElementById("include-locations");
    elements.includeTelemetry = document.getElementById("include-telemetry");
    elements.includeGeometry = document.getElementById("include-geometry");
    elements.includeMeta = document.getElementById("include-meta");
    elements.includeCustom = document.getElementById("include-custom");

    elements.csvOptionsContainer = document.getElementById("csv-options");
    elements.includeGpsInCsv = document.getElementById("include-gps-in-csv");
    elements.flattenLocationFields = document.getElementById(
      "flatten-location-fields",
    );
  }

  function initDatePickers() {
    if (!window.DateUtils || !window.DateUtils.initDatePicker) {
      console.warn("DateUtils not available for initializing date pickers");
      return;
    }

    const dateInputs = document.querySelectorAll('input[type="date"]');
    dateInputs.forEach((input) => {
      if (input.id) {
        window.DateUtils.initDatePicker(`#${input.id}`, {
          maxDate: "today",
          onClose(selectedDates, dateStr) {
            if (input.id.includes("start")) {
              const endInputId = input.id.replace("start", "end");
              const endInput = document.getElementById(endInputId);
              if (endInput && window.flatpickr && endInput._flatpickr) {
                endInput._flatpickr.set("minDate", dateStr);
              }
            }
          },
        });
      }
    });

    const setDefaultDates = async () => {
      try {
        const dateRange = await window.DateUtils.getDateRangePreset("30days");
        Object.entries(EXPORT_CONFIG).forEach(([, config]) => {
          if (config.dateStart && config.dateEnd) {
            const startInput = elements[config.dateStart];
            const endInput = elements[config.dateEnd];
            if (startInput && !startInput.value && startInput._flatpickr) {
              startInput._flatpickr.setDate(dateRange.startDate);
            }
            if (endInput && !endInput.value && endInput._flatpickr) {
              endInput._flatpickr.setDate(dateRange.endDate);
            }
          }
        });
      } catch (error) {
        console.warn("Error setting default dates:", error);
      }
    };

    setTimeout(setDefaultDates, 200);
  }

  function initEventListeners() {
    Object.keys(EXPORT_CONFIG).forEach((formKey) => {
      const form = elements[EXPORT_CONFIG[formKey].id];
      if (form) {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          handleFormSubmit(formKey);
        });
      }
    });

    elements.validateButtons.forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        const targetId = event.currentTarget.dataset.target;
        if (targetId) {
          validateLocation(targetId);
        }
      });
    });

    if (elements.exportAllDates) {
      elements.exportAllDates.addEventListener("change", (event) => {
        const checked = event.target.checked;
        const startDateInput = document.getElementById("adv-start-date");
        const endDateInput = document.getElementById("adv-end-date");

        if (startDateInput && endDateInput) {
          startDateInput.disabled = checked;
          endDateInput.disabled = checked;
        }
      });
    }

    const formatSelect = document.getElementById("adv-format");
    if (formatSelect) {
      formatSelect.addEventListener("change", (event) => {
        updateUIBasedOnFormat(event.target.value);
      });

      updateUIBasedOnFormat(formatSelect.value);
    }
  }

  function updateUIBasedOnFormat(format) {
    const checkboxes = [
      elements.includeBasicInfo,
      elements.includeLocations,
      elements.includeTelemetry,
      elements.includeGeometry,
      elements.includeMeta,
      elements.includeCustom,
    ];

    checkboxes.forEach((checkbox) => {
      if (checkbox) {
        checkbox.disabled = false;
        checkbox.parentElement.classList.remove("text-muted");
      }
    });

    if (elements.csvOptionsContainer) {
      elements.csvOptionsContainer.style.display =
        format === "csv" ? "block" : "none";
    }

    switch (format) {
      case "geojson":
        if (elements.includeGeometry) {
          elements.includeGeometry.checked = true;
          elements.includeGeometry.disabled = true;
        }
        break;

      case "gpx":
        if (elements.includeGeometry) {
          elements.includeGeometry.checked = true;
          elements.includeGeometry.disabled = true;
        }
        if (elements.includeTelemetry) {
          elements.includeTelemetry.disabled = true;
          elements.includeTelemetry.parentElement.classList.add("text-muted");
          elements.includeTelemetry.title =
            "Limited telemetry support in GPX format";
        }
        if (elements.includeMeta) {
          elements.includeMeta.disabled = true;
          elements.includeMeta.parentElement.classList.add("text-muted");
          elements.includeMeta.title = "Limited metadata support in GPX format";
        }
        if (elements.includeCustom) {
          elements.includeCustom.disabled = true;
          elements.includeCustom.parentElement.classList.add("text-muted");
          elements.includeCustom.title =
            "Custom data not supported in GPX format";
        }
        break;

      case "shapefile":
        if (elements.includeGeometry) {
          elements.includeGeometry.checked = true;
          elements.includeGeometry.disabled = true;
        }
        if (elements.includeCustom) {
          elements.includeCustom.disabled = true;
          elements.includeCustom.parentElement.classList.add("text-muted");
          elements.includeCustom.title =
            "Custom data may have limited support in Shapefile format";
        }
        break;

      case "csv":
        if (elements.includeGeometry) {
          elements.includeGeometry.disabled = true;
          elements.includeGeometry.parentElement.classList.add("text-muted");
          elements.includeGeometry.title =
            "Complex geometry not fully supported in CSV format";
        }
        break;

      case "json":
        // All checkboxes enabled by default
        break;

      default:
        // No specific UI changes for other formats
        break;
    }

    if (elements.saveExportSettings?.checked) {
      saveExportSettings();
    }
  }

  async function handleFormSubmit(formType) {
    // Skip undrivenStreets, handled by its own handler
    if (formType === "undrivenStreets") {
      return;
    }
    const config = EXPORT_CONFIG[formType];
    if (!config) return;
    if (activeExports[formType]) {
      showNotification(
        `Already exporting ${config.name}. Please wait...`,
        "info",
      );
      return;
    }
    const formElement = elements[config.id];
    if (!formElement) return;
    let submitButton = null;
    let originalText = "";
    submitButton = formElement.querySelector('button[type="submit"]');
    if (submitButton) {
      originalText = submitButton.textContent || `Export ${config.name}`;
      submitButton.disabled = true;
      submitButton.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Exporting...';
    }
    try {
      activeExports[formType] = true;
      showNotification(`Starting ${config.name} export...`, "info");
      let url = buildExportUrl(formType, config);
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        window.handleError(
          `Export operation timed out after 120 seconds: ${config.name}`,
        );
      }, 120000);
      try {
        await downloadFile(url, config.name, abortController.signal);
        showNotification(`${config.name} export completed`, "success");
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error("Export error:", error);
      showNotification(
        `Export failed: ${error.message || "Unknown error"}`,
        "error",
      );
    } finally {
      activeExports[formType] = false;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = originalText;
      }
    }
  }

  // Helper function for building Trips/Matched Trips export URL
  function buildTripsExportUrl(config) {
    const startDate = elements[config.dateStart]?.value;
    const endDate = elements[config.dateEnd]?.value;
    const format = elements[config.format]?.value;
    if (!startDate || !endDate) {
      throw new Error("Please select both start and end dates");
    }
    if (!window.DateUtils.isValidDateRange(startDate, endDate)) {
      throw new Error("Start date must be before or equal to end date");
    }
    return `${config.endpoint}?start_date=${startDate}&end_date=${endDate}&format=${format}`;
  }

  // Helper function for building Streets/Boundary export URL
  function buildLocationExportUrl(config) {
    const locationInput = elements[config.location];
    const format = elements[config.format]?.value;
    if (!validateLocationInput(locationInput)) {
      throw new Error("Invalid location. Please validate it first.");
    }
    const locationData = locationInput.getAttribute("data-location");
    return `${config.endpoint}?location=${encodeURIComponent(
      locationData,
    )}&format=${format}`;
  }

  // Helper function for building Advanced export URL
  function buildAdvancedExportUrl(config) {
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
      if (!window.DateUtils.isValidDateRange(startDate, endDate)) {
        throw new Error("Start date must be before or equal to end date");
      }
      url += `&start_date=${startDate}&end_date=${endDate}`;
    }

    // Optionally save settings
    if (elements.saveExportSettings?.checked) {
      saveExportSettings();
    }

    return url;
  }

  // Main function (refactored)
  function buildExportUrl(formType, config) {
    switch (formType) {
      case "trips":
      case "matchedTrips":
        return buildTripsExportUrl(config);
      case "streets":
      case "boundary":
        return buildLocationExportUrl(config);
      case "advanced":
        return buildAdvancedExportUrl(config);
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

  function saveExportSettings() {
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

      localStorage.setItem("advancedExportSettings", JSON.stringify(settings));
    } catch (error) {
      console.warn("Error saving export settings:", error);
    }
  }

  function loadSavedExportSettings() {
    try {
      const savedSettingsJSON = localStorage.getItem("advancedExportSettings");
      if (!savedSettingsJSON) return;
      const settings = JSON.parse(savedSettingsJSON);
      setDataSources(settings.dataSources);
      setDataFields(settings.dataFields);
      setDateSettings(settings.dateSettings);
      setFormat(settings.format);
    } catch (error) {
      console.warn("Error loading saved export settings:", error);
    }
  }

  function setDataSources(dataSources) {
    if (!dataSources) return;
    if (elements.includeTrips && dataSources.includeTrips !== undefined) {
      elements.includeTrips.checked = dataSources.includeTrips;
    }
    if (
      elements.includeMatchedTrips &&
      dataSources.includeMatchedTrips !== undefined
    ) {
      elements.includeMatchedTrips.checked = dataSources.includeMatchedTrips;
    }
    if (
      elements.includeUploadedTrips &&
      dataSources.includeUploadedTrips !== undefined
    ) {
      elements.includeUploadedTrips.checked = dataSources.includeUploadedTrips;
    }
  }

  function setDataFields(dataFields) {
    if (!dataFields) return;
    if (
      elements.includeBasicInfo &&
      dataFields.includeBasicInfo !== undefined
    ) {
      elements.includeBasicInfo.checked = dataFields.includeBasicInfo;
    }
    if (
      elements.includeLocations &&
      dataFields.includeLocations !== undefined
    ) {
      elements.includeLocations.checked = dataFields.includeLocations;
    }
    if (
      elements.includeTelemetry &&
      dataFields.includeTelemetry !== undefined
    ) {
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

  function setDateSettings(dateSettings) {
    if (
      !dateSettings ||
      !elements.exportAllDates ||
      dateSettings.exportAllDates === undefined
    )
      return;
    elements.exportAllDates.checked = dateSettings.exportAllDates;
    const startDateInput = document.getElementById("adv-start-date");
    const endDateInput = document.getElementById("adv-end-date");
    if (startDateInput && endDateInput) {
      startDateInput.disabled = dateSettings.exportAllDates;
      endDateInput.disabled = dateSettings.exportAllDates;
    }
  }

  function setFormat(format) {
    if (format && elements["adv-format"]) {
      elements["adv-format"].value = format;
      updateUIBasedOnFormat(format);
    }
  }

  function validateLocationInput(locationInput) {
    if (!locationInput) {
      showNotification("Location input not found", "warning");
      return false;
    }

    if (!locationInput.value.trim()) {
      showNotification("Please enter a location", "warning");
      return false;
    }

    const locationData = locationInput.getAttribute("data-location");
    if (!locationData) {
      showNotification("Please validate the location first", "warning");
      return false;
    }

    return true;
  }

  async function validateLocation(inputId) {
    const locationInput = document.getElementById(inputId);

    if (!locationInput || !locationInput.value.trim()) {
      showNotification("Please enter a location", "warning");
      return;
    }

    let validateButton = null;
    let originalText = "";

    const form = locationInput.closest("form");
    validateButton = form?.querySelector(".validate-location-btn");

    if (validateButton) {
      originalText = validateButton.textContent || "Validate";
      validateButton.disabled = true;
      validateButton.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Validating...';
    }

    try {
      showNotification(
        `Validating location: "${locationInput.value}"...`,
        "info",
      );

      const response = await fetch("/api/validate_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locationInput.value,
          locationType: "city",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      if (data) {
        locationInput.setAttribute("data-location", JSON.stringify(data));
        locationInput.setAttribute(
          "data-display-name",
          data.display_name || data.name || locationInput.value,
        );

        locationInput.value =
          data.display_name || data.name || locationInput.value;

        locationInput.classList.add("is-valid");
        locationInput.classList.remove("is-invalid");

        const submitButton = form?.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = false;
        }

        showNotification(
          `Location validated: "${
            data.display_name || data.name || locationInput.value
          }"`,
          "success",
        );
      } else {
        locationInput.classList.add("is-invalid");
        locationInput.classList.remove("is-valid");
        showNotification(
          "Location not found. Please try a different search term",
          "warning",
        );
      }
    } catch (error) {
      if (window.handleError) {
        window.handleError(error, "validating location");
      } else {
        console.error("Error validating location:", error);
        showNotification(`Validation failed: ${error.message}`, "danger");
      }

      locationInput.classList.add("is-invalid");
      locationInput.classList.remove("is-valid");
    } finally {
      if (validateButton) {
        validateButton.disabled = false;
        validateButton.innerHTML = originalText;
      }
    }
  }

  async function downloadFile(url, exportName, signal) {
    const urlWithTimestamp = `${url}${url.includes("?") ? "&" : "?"}timestamp=${new Date().getTime()}`;
    try {
      showNotification(`Requesting ${exportName} data...`, "info");
      console.info(`Requesting export from: ${urlWithTimestamp}`);
      showLoading(exportName);
      const fetchOptions = { signal };
      console.info(`Starting fetch for ${exportName} export...`);
      const response = await fetch(urlWithTimestamp, fetchOptions);
      console.info(
        `Received response: status=${response.status}, ok=${response.ok}`,
      );
      // Check for Content-Disposition header to identify file downloads
      const contentDisposition = response.headers.get("Content-Disposition");
      const isFileDownload =
        contentDisposition && contentDisposition.includes("attachment");

      // Only throw an error if response is not ok AND it's not a file download
      if (!response.ok && !isFileDownload) {
        let errorMsg = `Server error (${response.status})`;
        try {
          const errorText = await response.text();
          console.error(`Server error details for ${exportName}: ${errorText}`);
          if (errorText) {
            try {
              const errorJson = JSON.parse(errorText);
              errorMsg = errorJson.detail || errorJson.message || errorText;
            } catch {
              errorMsg = errorText.substring(0, 100);
            }
          }
        } catch {
          // ignore
        }
        throw new Error(errorMsg);
      }
      // If it's a file download or response.ok is true, proceed with download logic
      const contentLength = response.headers.get("Content-Length");
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
      console.info(
        `Content-Length: ${contentLength}, parsed size: ${totalSize}`,
      );
      console.info("Response headers:");
      response.headers.forEach((value, name) => {
        console.info(`${name}: ${value}`);
      });
      const formatMatch = urlWithTimestamp.match(/format=([^&]+)/);
      const format = formatMatch ? formatMatch[1] : null;
      const filename = getFilenameFromHeaders(
        contentDisposition,
        exportName,
        format,
      );
      showNotification(`Downloading ${filename}...`, "info");
      console.info(`Starting download of ${filename}...`);
      await processDownloadStream(response, filename, format, totalSize);
    } catch (error) {
      console.error(`Export error for ${exportName}:`, error);
      if (error.name === "AbortError") {
        throw new Error(
          "Export timed out. The file might be too large or the server is busy.",
        );
      }
      const errorMsg = `Export failed: ${error.message || "Unknown error"}`;
      showNotification(errorMsg, "error");
      throw error;
    } finally {
      hideLoading();
    }
  }

  function showLoading(exportName) {
    if (
      window.loadingManager &&
      typeof window.loadingManager.show === "function"
    ) {
      window.loadingManager.show(`Exporting ${exportName}...`);
    } else if (
      window.LoadingManager &&
      typeof window.LoadingManager.show === "function"
    ) {
      window.LoadingManager.show(`Exporting ${exportName}...`);
    } else {
      const loadingOverlay = document.querySelector(".loading-overlay");
      if (loadingOverlay) {
        loadingOverlay.style.display = "flex";
        const loadingText = loadingOverlay.querySelector(".loading-text");
        if (loadingText) {
          loadingText.textContent = `Exporting ${exportName}...`;
        }
      }
    }
  }

  function hideLoading() {
    if (
      window.loadingManager &&
      typeof window.loadingManager.hide === "function"
    ) {
      window.loadingManager.hide();
    } else if (
      window.LoadingManager &&
      typeof window.LoadingManager.hide === "function"
    ) {
      window.LoadingManager.hide();
    } else {
      const loadingOverlay = document.querySelector(".loading-overlay");
      if (loadingOverlay) {
        loadingOverlay.style.display = "none";
      }
    }
  }

  function getFilenameFromHeaders(contentDisposition, exportName, format) {
    let filename = null;
    if (contentDisposition) {
      const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
      if (quotedMatch) {
        filename = quotedMatch[1];
      } else {
        const unquotedMatch = contentDisposition.match(/filename=([^;]+)/);
        if (unquotedMatch) {
          filename = unquotedMatch[1].trim();
        }
      }
    }
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const extension = getExtensionForFormat(format);
      filename = `${exportName}-${timestamp}${extension}`;
    }
    if (format && !filename.endsWith(getExtensionForFormat(format))) {
      filename = `${filename}${getExtensionForFormat(format)}`;
    }
    return filename;
  }

  async function processDownloadStream(response, filename, format, totalSize) {
    const reader = response.body.getReader();
    let receivedLength = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.info(
          `Finished reading response body, total size: ${receivedLength} bytes`,
        );
        break;
      }
      chunks.push(value);
      receivedLength += value.length;
      if (
        totalSize &&
        receivedLength % Math.max(totalSize / 10, 1024 * 1024) < value.length
      ) {
        console.info(
          `Download progress: ${Math.round((receivedLength / totalSize) * 100)}% (${receivedLength}/${totalSize} bytes)`,
        );
      }
      if (totalSize) {
        const progress = Math.min(
          Math.round((receivedLength / totalSize) * 100),
          100,
        );
        if (
          window.loadingManager &&
          typeof window.loadingManager.updateProgress === "function"
        ) {
          window.loadingManager.updateProgress(progress);
        } else if (
          window.LoadingManager &&
          typeof window.LoadingManager.updateProgress === "function"
        ) {
          window.LoadingManager.updateProgress(progress);
        } else {
          const progressBar = document.getElementById("loading-progress-bar");
          if (progressBar) {
            progressBar.style.width = `${progress}%`;
          }
        }
      }
    }
    console.info(`Combining ${chunks.length} chunks into final blob...`);
    const chunksAll = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      chunksAll.set(chunk, position);
      position += chunk.length;
    }
    const contentType = getContentTypeForFormat(format);
    console.info(`Creating blob with type: ${contentType}`);
    const blob = new Blob([chunksAll], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    console.info(`Blob URL created: ${blobUrl.substring(0, 30)}...`);
    console.info(`Triggering download of ${filename}`);
    const downloadLink = document.createElement("a");
    downloadLink.style.display = "none";
    downloadLink.href = blobUrl;
    downloadLink.download = filename;
    if ("download" in downloadLink) {
      downloadLink.type = contentType;
    }
    document.body.appendChild(downloadLink);
    downloadLink.click();
    setTimeout(() => {
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(blobUrl);
      console.info(`Download cleanup completed for ${filename}`);
    }, 100);
    showNotification(`Successfully exported ${filename}`, "success");
  }

  function getExtensionForFormat(format) {
    if (!format) return ".dat";

    switch (format.toLowerCase()) {
      case "json":
        return ".json";
      case "geojson":
        return ".geojson";
      case "gpx":
        return ".gpx";
      case "csv":
        return ".csv";
      case "shapefile":
        return ".zip";
      case "kml":
        return ".kml";
      default:
        return `.${format.toLowerCase()}`;
    }
  }

  function getContentTypeForFormat(format) {
    if (!format) return "application/octet-stream";

    switch (format.toLowerCase()) {
      case "json":
        return "application/json";
      case "geojson":
        return "application/geo+json";
      case "gpx":
        return "application/gpx+xml";
      case "csv":
        return "text/csv";
      case "shapefile":
        return "application/zip";
      case "kml":
        return "application/vnd.google-earth.kml+xml";
      default:
        return "application/octet-stream";
    }
  }

  function showNotification(message, type) {
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      window.handleError(`${type.toUpperCase()}: ${message}`);
    }
  }

  function initUndrivenStreetsExport() {
    const locationSelect = document.getElementById("undriven-streets-location");
    const formatSelect = document.getElementById("undriven-streets-format");
    const exportBtn = document.getElementById("export-undriven-streets-btn");
    const form = document.getElementById("export-undriven-streets-form");

    // Fetch areas and populate dropdown
    fetch("/api/coverage_areas")
      .then((res) => res.json())
      .then((data) => {
        locationSelect.innerHTML = '<option value="">Select an area...</option>';
        if (data.success && Array.isArray(data.areas)) {
          data.areas.forEach((area) => {
            if (area.location && area.location.display_name) {
              const opt = document.createElement("option");
              opt.value = JSON.stringify(area.location);
              opt.textContent = area.location.display_name;
              locationSelect.appendChild(opt);
            }
          });
        } else {
          locationSelect.innerHTML = '<option value="">No areas found</option>';
        }
      })
      .catch((err) => {
        locationSelect.innerHTML = '<option value="">Failed to load areas</option>';
        showNotification("Failed to load areas: " + err.message, "error");
      });

    // Enable export button only if area is selected
    locationSelect.addEventListener("change", () => {
      exportBtn.disabled = !locationSelect.value;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!locationSelect.value) return;
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Exporting...';
      showNotification("Exporting undriven streets...", "info");
      try {
        const format = formatSelect.value;
        const area = JSON.parse(locationSelect.value);
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
          } catch {}
          throw new Error(msg);
        }
        let blob;
        let displayName = area.display_name || "undriven_streets";
        let sanitizedName = displayName.replace(/[^a-zA-Z0-9]/g, "_");
        let now = new Date();
        let pad = n => n.toString().padStart(2, '0');
        let dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        let filename = `${sanitizedName}_undriven_${dateStr}`;
        if (format === "gpx") {
          // Convert GeoJSON to GPX client-side (simple, for LineStrings)
          const geojson = await response.json();
          blob = new Blob([geojsonToGpx(geojson)], { type: "application/gpx+xml" });
          filename += ".gpx";
        } else {
          blob = await response.blob();
          filename += ".geojson";
        }
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 100);
        showNotification("Undriven streets export completed", "success");
      } catch (err) {
        showNotification("Export failed: " + err.message, "error");
      } finally {
        exportBtn.disabled = false;
        exportBtn.innerHTML = "Export Undriven Streets";
      }
    });
  }

  // Simple GeoJSON to GPX converter for LineStrings (for demo purposes)
  function geojsonToGpx(geojson) {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="EveryStreet" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    if (geojson && Array.isArray(geojson.features)) {
      geojson.features.forEach((f, i) => {
        if (f.geometry && f.geometry.type === "LineString" && Array.isArray(f.geometry.coordinates)) {
          gpx += `<trk><name>Undriven Street ${i + 1}</name><trkseg>`;
          f.geometry.coordinates.forEach(([lon, lat]) => {
            gpx += `<trkpt lat="${lat}" lon="${lon}"></trkpt>`;
          });
          gpx += `</trkseg></trk>\n`;
        }
      });
    }
    gpx += "</gpx>\n";
    return gpx;
  }

  document.addEventListener("DOMContentLoaded", init);

  window.validateLocation = validateLocation;
})();
