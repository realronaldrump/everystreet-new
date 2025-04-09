/* global config, url */

"use strict";
(() => {
  const elements = {};

  let activeExports = {};

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
  };

  function init() {
    cacheElements();
    initEventListeners();
    initDatePickers();
    loadSavedExportSettings();

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
          onClose: function (selectedDates, dateStr) {
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

        for (const [formKey, config] of Object.entries(EXPORT_CONFIG)) {
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
        }
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
      button.addEventListener("click", (event) => {
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
        break;
    }

    if (elements.includeBasicInfo) {
      url += `&include_basic_info=${elements.includeBasicInfo.checked}`;
    }
    if (elements.includeLocations) {
      url += `&include_locations=${elements.includeLocations.checked}`;
    }
    if (elements.includeTelemetry) {
      url += `&include_telemetry=${elements.includeTelemetry.checked}`;
    }
    if (elements.includeGeometry) {
      url += `&include_geometry=${elements.includeGeometry.checked}`;
    }
    if (elements.includeMeta) {
      url += `&include_meta=${elements.includeMeta.checked}`;
    }
    if (elements.includeCustom) {
      url += `&include_custom=${elements.includeCustom.checked}`;
    }

    if (format === "csv") {
      if (elements.includeGpsInCsv) {
        url += `&include_gps_in_csv=${elements.includeGpsInCsv.checked}`;
      }
      if (elements.flattenLocationFields) {
        url += `&flatten_location_fields=${elements.flattenLocationFields.checked}`;
      }
    }

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

    if (elements.saveExportSettings?.checked) {
      saveExportSettings();
    }
  }

  async function handleFormSubmit(formType) {
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

      let url = "";

      if (formType === "trips" || formType === "matchedTrips") {
        const startDate = elements[config.dateStart]?.value;
        const endDate = elements[config.dateEnd]?.value;
        const format = elements[config.format]?.value;

        if (!startDate || !endDate) {
          throw new Error("Please select both start and end dates");
        }

        if (!window.DateUtils.isValidDateRange(startDate, endDate)) {
          throw new Error("Start date must be before or equal to end date");
        }

        url = `${config.endpoint}?start_date=${startDate}&end_date=${endDate}&format=${format}`;
      } else if (formType === "streets" || formType === "boundary") {
        const locationInput = elements[config.location];
        const format = elements[config.format]?.value;

        if (!validateLocationInput(locationInput)) {
          throw new Error("Invalid location. Please validate it first.");
        }

        const locationData = locationInput.getAttribute("data-location");
        url = `${config.endpoint}?location=${encodeURIComponent(
          locationData,
        )}&format=${format}`;
      } else if (formType === "advanced") {
        const format = elements[config.format]?.value;
        url = `${config.endpoint}?format=${format}`;

        if (elements.includeTrips) {
          url += `&include_trips=${elements.includeTrips.checked}`;
        }
        if (elements.includeMatchedTrips) {
          url += `&include_matched_trips=${elements.includeMatchedTrips.checked}`;
        }
        if (elements.includeUploadedTrips) {
          url += `&include_uploaded_trips=${elements.includeUploadedTrips.checked}`;
        }

        if (elements.includeBasicInfo) {
          url += `&include_basic_info=${elements.includeBasicInfo.checked}`;
        }
        if (elements.includeLocations) {
          url += `&include_locations=${elements.includeLocations.checked}`;
        }
        if (elements.includeTelemetry) {
          url += `&include_telemetry=${elements.includeTelemetry.checked}`;
        }
        if (elements.includeGeometry) {
          url += `&include_geometry=${elements.includeGeometry.checked}`;
        }
        if (elements.includeMeta) {
          url += `&include_meta=${elements.includeMeta.checked}`;
        }
        if (elements.includeCustom) {
          url += `&include_custom=${elements.includeCustom.checked}`;
        }

        if (format === "csv") {
          if (elements.includeGpsInCsv) {
            url += `&include_gps_in_csv=${elements.includeGpsInCsv.checked}`;
          }
          if (elements.flattenLocationFields) {
            url += `&flatten_location_fields=${elements.flattenLocationFields.checked}`;
          }
        }

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

        if (elements.saveExportSettings?.checked) {
          saveExportSettings();
        }
      } else {
        const format = elements[config.format]?.value;
        url = `${config.endpoint}?format=${format}`;
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        console.log(
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
      console.error(`Export error:`, error);
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

      if (settings.dataSources) {
        if (
          elements.includeTrips &&
          settings.dataSources.includeTrips !== undefined
        ) {
          elements.includeTrips.checked = settings.dataSources.includeTrips;
        }
        if (
          elements.includeMatchedTrips &&
          settings.dataSources.includeMatchedTrips !== undefined
        ) {
          elements.includeMatchedTrips.checked =
            settings.dataSources.includeMatchedTrips;
        }
        if (
          elements.includeUploadedTrips &&
          settings.dataSources.includeUploadedTrips !== undefined
        ) {
          elements.includeUploadedTrips.checked =
            settings.dataSources.includeUploadedTrips;
        }
      }

      if (settings.dataFields) {
        if (
          elements.includeBasicInfo &&
          settings.dataFields.includeBasicInfo !== undefined
        ) {
          elements.includeBasicInfo.checked =
            settings.dataFields.includeBasicInfo;
        }
        if (
          elements.includeLocations &&
          settings.dataFields.includeLocations !== undefined
        ) {
          elements.includeLocations.checked =
            settings.dataFields.includeLocations;
        }
        if (
          elements.includeTelemetry &&
          settings.dataFields.includeTelemetry !== undefined
        ) {
          elements.includeTelemetry.checked =
            settings.dataFields.includeTelemetry;
        }
        if (
          elements.includeGeometry &&
          settings.dataFields.includeGeometry !== undefined
        ) {
          elements.includeGeometry.checked =
            settings.dataFields.includeGeometry;
        }
        if (
          elements.includeMeta &&
          settings.dataFields.includeMeta !== undefined
        ) {
          elements.includeMeta.checked = settings.dataFields.includeMeta;
        }
        if (
          elements.includeCustom &&
          settings.dataFields.includeCustom !== undefined
        ) {
          elements.includeCustom.checked = settings.dataFields.includeCustom;
        }
      }

      if (
        settings.dateSettings &&
        elements.exportAllDates &&
        settings.dateSettings.exportAllDates !== undefined
      ) {
        elements.exportAllDates.checked = settings.dateSettings.exportAllDates;

        const startDateInput = document.getElementById("adv-start-date");
        const endDateInput = document.getElementById("adv-end-date");
        if (startDateInput && endDateInput) {
          startDateInput.disabled = settings.dateSettings.exportAllDates;
          endDateInput.disabled = settings.dateSettings.exportAllDates;
        }
      }

      if (settings.format && elements["adv-format"]) {
        elements["adv-format"].value = settings.format;
        updateUIBasedOnFormat(settings.format);
      }
    } catch (error) {
      console.warn("Error loading saved export settings:", error);
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
    const urlWithTimestamp =
      url +
      (url.includes("?") ? "&" : "?") +
      "timestamp=" +
      new Date().getTime();

    try {
      showNotification(`Requesting ${exportName} data...`, "info");
      console.log(`Requesting export from: ${urlWithTimestamp}`);

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

      const fetchOptions = { signal };

      console.log(`Starting fetch for ${exportName} export...`);
      const response = await fetch(urlWithTimestamp, fetchOptions);
      console.log(
        `Received response: status=${response.status}, ok=${response.ok}`,
      );

      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;

        try {
          const errorText = await response.text();
          console.error(`Server error details for ${exportName}: ${errorText}`);

          if (errorText) {
            try {
              const errorJson = JSON.parse(errorText);
              errorMsg = errorJson.detail || errorJson.message || errorText;
            } catch (e) {
              errorMsg = errorText.substring(0, 100);
            }
          }
        } catch (e) {
          console.error(`Error parsing server error for ${exportName}:`, e);
        }

        throw new Error(errorMsg);
      }

      const contentLength = response.headers.get("Content-Length");
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
      console.log(
        `Content-Length: ${contentLength}, parsed size: ${totalSize}`,
      );

      console.log("Response headers:");
      response.headers.forEach((value, name) => {
        console.log(`${name}: ${value}`);
      });

      const formatMatch = urlWithTimestamp.match(/format=([^&]+)/);
      const format = formatMatch ? formatMatch[1] : null;

      const contentDisposition = response.headers.get("Content-Disposition");
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

      showNotification(`Downloading ${filename}...`, "info");
      console.log(`Starting download of ${filename}...`);

      try {
        const reader = response.body.getReader();
        let receivedLength = 0;
        const chunks = [];

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            console.log(
              `Finished reading response body, total size: ${receivedLength} bytes`,
            );
            break;
          }

          chunks.push(value);
          receivedLength += value.length;

          if (
            totalSize &&
            receivedLength % Math.max(totalSize / 10, 1024 * 1024) <
              value.length
          ) {
            console.log(
              `Download progress: ${Math.round(
                (receivedLength / totalSize) * 100,
              )}% (${receivedLength}/${totalSize} bytes)`,
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
              const progressBar = document.getElementById(
                "loading-progress-bar",
              );
              if (progressBar) {
                progressBar.style.width = `${progress}%`;
              }
            }
          }
        }

        console.log(`Combining ${chunks.length} chunks into final blob...`);
        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
          chunksAll.set(chunk, position);
          position += chunk.length;
        }

        const contentType = getContentTypeForFormat(format);
        console.log(`Creating blob with type: ${contentType}`);
        const blob = new Blob([chunksAll], { type: contentType });
        const blobUrl = URL.createObjectURL(blob);
        console.log(`Blob URL created: ${blobUrl.substring(0, 30)}...`);

        console.log(`Triggering download of ${filename}`);
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
          console.log(`Download cleanup completed for ${filename}`);
        }, 100);

        showNotification(`Successfully exported ${filename}`, "success");
      } catch (streamError) {
        console.error(
          `Error processing download stream for ${exportName}:`,
          streamError,
        );
        throw new Error(`Error while downloading: ${streamError.message}`);
      }
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
      console.log(`${type.toUpperCase()}: ${message}`);
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  window.validateLocation = validateLocation;
})();
