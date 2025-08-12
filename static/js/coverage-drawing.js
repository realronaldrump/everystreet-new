"use strict";

// Classic script exposing drawing-related features for coverage management.
// Usage: window.CoverageModules.Drawing.method(manager, ...)

(() => {
  window.CoverageModules = window.CoverageModules || {};

  const Drawing = {
    handleAreaDefinitionTypeChange(manager, type) {
      manager.currentAreaDefinitionType = type;

      const locationSearchForm = document.getElementById("location-search-form");
      const drawingInterface = document.getElementById("drawing-interface");
      const locationSearchButtons = document.getElementById("location-search-buttons");
      const drawingButtons = document.getElementById("drawing-buttons");

      if (type === "location") {
        locationSearchForm?.classList.remove("d-none");
        drawingInterface?.classList.add("d-none");
        locationSearchButtons?.classList.remove("d-none");
        drawingButtons?.classList.add("d-none");
        Drawing.cleanupDrawingMap(manager);
      } else if (type === "draw") {
        locationSearchForm?.classList.add("d-none");
        drawingInterface?.classList.remove("d-none");
        locationSearchButtons?.classList.add("d-none");
        drawingButtons?.classList.remove("d-none");
        Drawing.initializeDrawingMap(manager);
      }

      Drawing.resetModalValidationState(manager);
    },

    initializeDrawingMap(manager) {
      if (manager.drawingMap) {
        Drawing.cleanupDrawingMap(manager);
      }
      if (!window.MAPBOX_ACCESS_TOKEN) {
        Drawing.showDrawingError(manager, "Mapbox token not configured. Cannot initialize drawing map.");
        return;
      }

      try {
        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
        manager.drawingMap = new mapboxgl.Map({
          container: "drawing-map",
          style: "mapbox://styles/mapbox/dark-v11",
          center: [-97.1467, 31.5494],
          zoom: 10,
          attributionControl: false,
        });

        if (window.MapboxDraw) {
          manager.drawingMapDraw = new MapboxDraw({
            displayControlsDefault: false,
            controls: { polygon: true, trash: true },
            defaultMode: "draw_polygon",
            styles: [
              { id: "gl-draw-polygon-fill-inactive", type: "fill", filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"], ["!=", "mode", "static"]], paint: { "fill-color": "#3bb2d0", "fill-outline-color": "#3bb2d0", "fill-opacity": 0.1 } },
              { id: "gl-draw-polygon-stroke-inactive", type: "line", filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"], ["!=", "mode", "static"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#3bb2d0", "line-width": 2 } },
              { id: "gl-draw-polygon-fill-active", type: "fill", filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]], paint: { "fill-color": "#fbb03b", "fill-outline-color": "#fbb03b", "fill-opacity": 0.1 } },
              { id: "gl-draw-polygon-stroke-active", type: "line", filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fbb03b", "line-width": 2 } },
              { id: "gl-draw-polygon-midpoint", type: "circle", filter: ["all", ["==", "$type", "Point"], ["==", "meta", "midpoint"]], paint: { "circle-radius": 3, "circle-color": "#fbb03b" } },
              { id: "gl-draw-polygon-vertex-active", type: "circle", filter: ["all", ["==", "$type", "Point"], ["==", "meta", "vertex"], ["==", "active", "true"]], paint: { "circle-radius": 5, "circle-color": "#fbb03b" } },
              { id: "gl-draw-polygon-vertex-inactive", type: "circle", filter: ["all", ["==", "$type", "Point"], ["==", "meta", "vertex"], ["==", "active", "false"]], paint: { "circle-radius": 3, "circle-color": "#3bb2d0" } },
            ],
          });
          manager.drawingMap.addControl(manager.drawingMapDraw);
          manager.drawingMap.on("draw.create", (e) => Drawing.handleDrawingCreate(manager, e));
          manager.drawingMap.on("draw.update", (e) => Drawing.handleDrawingUpdate(manager, e));
          manager.drawingMap.on("draw.delete", (e) => Drawing.handleDrawingDelete(manager, e));
        } else {
          Drawing.showDrawingError(manager, "MapboxDraw library not loaded. Cannot enable drawing functionality.");
        }

        manager.drawingMap.addControl(new mapboxgl.NavigationControl(), "top-right");
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error initializing drawing map:", error);
        Drawing.showDrawingError(manager, `Failed to initialize drawing map: ${error.message}`);
      }
    },

    handleDrawingCreate(manager, e) {
      if (e.features && e.features.length > 0) {
        const feature = e.features[0];
        Drawing.updateDrawingValidationState(manager, feature);
      }
    },

    handleDrawingUpdate(manager, e) {
      if (e.features && e.features.length > 0) {
        const feature = e.features[0];
        Drawing.updateDrawingValidationState(manager, feature);
      }
    },

    handleDrawingDelete(manager) {
      Drawing.clearDrawingValidationState(manager);
    },

    updateDrawingValidationState(manager) {
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");
      if (validateButton) validateButton.disabled = false;
      if (addButton) addButton.disabled = true;
      manager.validatedCustomBoundary = null;
      Drawing.hideDrawingValidationResult(manager);
    },

    clearDrawingValidationState(manager) {
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");
      if (validateButton) validateButton.disabled = true;
      if (addButton) addButton.disabled = true;
      manager.validatedCustomBoundary = null;
      Drawing.hideDrawingValidationResult(manager);
    },

    clearDrawing(manager) {
      if (manager.drawingMapDraw) {
        manager.drawingMapDraw.deleteAll();
        Drawing.clearDrawingValidationState(manager);
      }
    },

    cleanupDrawingMap(manager) {
      if (manager.drawingMap) {
        try {
          manager.drawingMap.remove();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("Error removing drawing map:", e);
        }
        manager.drawingMap = null;
        manager.drawingMapDraw = null;
      }
    },

    resetModalState(manager) {
      const locationRadio = document.getElementById("area-type-location");
      if (locationRadio) {
        locationRadio.checked = true;
        Drawing.handleAreaDefinitionTypeChange(manager, "location");
      }
      const locationInput = document.getElementById("location-input");
      const customAreaName = document.getElementById("custom-area-name");
      if (locationInput) {
        locationInput.value = "";
        locationInput.classList.remove("is-valid", "is-invalid");
      }
      if (customAreaName) customAreaName.value = "";
      Drawing.resetModalValidationState(manager);
    },

    resetModalValidationState(manager) {
      manager.validatedLocation = null;
      manager.validatedCustomBoundary = null;
      const validationResult = document.getElementById("validation-result");
      const drawingValidationResult = document.getElementById("drawing-validation-result");
      if (validationResult) validationResult.classList.add("d-none");
      if (drawingValidationResult) drawingValidationResult.classList.add("d-none");
      const addLocationButton = document.getElementById("add-coverage-area");
      const addCustomButton = document.getElementById("add-custom-area");
      if (addLocationButton) addLocationButton.disabled = true;
      if (addCustomButton) addCustomButton.disabled = true;
    },

    showDrawingError(manager, message) {
      const mapContainer = document.getElementById("drawing-map");
      if (mapContainer) {
        mapContainer.innerHTML = `
          <div class="alert alert-danger m-3">
            <i class="fas fa-exclamation-circle me-2"></i>
            <strong>Drawing Error:</strong> ${message}
          </div>`;
      }
    },

    showDrawingValidationResult(manager, data) {
      const resultDiv = document.getElementById("drawing-validation-result");
      const messageSpan = resultDiv?.querySelector(".drawing-validation-message");
      if (resultDiv && messageSpan) {
        messageSpan.textContent = `Custom area "${data.display_name}" validated successfully! (${data.stats.total_points} points, ${data.stats.rings} ring${data.stats.rings > 1 ? "s" : ""})`;
        resultDiv.classList.remove("d-none");
      }
    },

    hideDrawingValidationResult() {
      const resultDiv = document.getElementById("drawing-validation-result");
      if (resultDiv) resultDiv.classList.add("d-none");
    },

    async validateCustomBoundary(manager) {
      const customAreaNameInput = document.getElementById("custom-area-name");
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");
      if (!customAreaNameInput || !validateButton) return;

      const areaName = customAreaNameInput.value.trim();
      if (!areaName) {
        customAreaNameInput.classList.add("is-invalid", "shake-animation");
        manager.notificationManager?.show("Please enter an area name.", "warning");
        return;
      }
      if (!manager.drawingMapDraw) {
        manager.notificationManager?.show("Drawing functionality not initialized.", "danger");
        return;
      }
      const drawnFeatures = manager.drawingMapDraw.getAll();
      if (!drawnFeatures.features || drawnFeatures.features.length === 0) {
        manager.notificationManager?.show("Please draw a polygon boundary first.", "warning");
        return;
      }
      const polygon = drawnFeatures.features[0];
      if (polygon.geometry.type !== "Polygon") {
        manager.notificationManager?.show("Please draw a polygon boundary.", "warning");
        return;
      }
      customAreaNameInput.classList.remove("is-invalid", "is-valid");
      if (addButton) addButton.disabled = true;
      manager.validatedCustomBoundary = null;
      Drawing.hideDrawingValidationResult(manager);
      const originalButtonContent = validateButton.innerHTML;
      validateButton.disabled = true;
      validateButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Validating...';

      try {
        const response = await fetch("/api/validate_custom_boundary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ area_name: areaName, geometry: polygon.geometry }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Validation failed`);
        if (!data || !data.valid) {
          customAreaNameInput.classList.add("is-invalid");
          manager.notificationManager?.show(
            "Custom boundary validation failed. Please check your drawing.",
            "warning",
          );
        } else {
          customAreaNameInput.classList.add("is-valid");
          manager.validatedCustomBoundary = data;
          if (addButton) addButton.disabled = false;
          Drawing.showDrawingValidationResult(manager, data);
          manager.notificationManager?.show(
            `Custom boundary "${data.display_name}" validated successfully!`,
            "success",
          );
          if (addButton) addButton.focus();
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error validating custom boundary:", error);
        customAreaNameInput.classList.add("is-invalid");
        manager.notificationManager?.show(`Validation failed: ${error.message}`, "danger");
      } finally {
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonContent;
      }
    },

    async addCustomCoverageArea(manager) {
      if (!manager.validatedCustomBoundary?.display_name) {
        manager.notificationManager?.show("Please validate your custom boundary first.", "warning");
        return;
      }

      const addButton = document.getElementById("add-custom-area");
      const modal = bootstrap.Modal.getInstance(document.getElementById("addAreaModal"));
      if (!addButton) return;
      const originalButtonContent = addButton.innerHTML;
      addButton.disabled = true;
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      const customAreaToAdd = { ...manager.validatedCustomBoundary };
      const segLenEl2 = document.getElementById("segment-length-input");
      if (segLenEl2?.value) {
        const v = parseInt(segLenEl2.value, 10);
        if (!isNaN(v) && v > 0) customAreaToAdd.segment_length_meters = v;
      }
      const bufEl = document.getElementById("match-buffer-input");
      if (bufEl?.value) {
        const v = parseFloat(bufEl.value);
        if (!isNaN(v) && v > 0) customAreaToAdd.match_buffer_meters = v;
      }
      const minEl = document.getElementById("min-match-length-input");
      if (minEl?.value) {
        const v2 = parseFloat(minEl.value);
        if (!isNaN(v2) && v2 > 0) customAreaToAdd.min_match_length_meters = v2;
      }

      try {
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok) throw new Error("Failed to fetch current coverage areas");
        const { areas } = await currentAreasResponse.json();
        const exists = areas.some((area) => area.location?.display_name === customAreaToAdd.display_name);
        if (exists) {
          manager.notificationManager?.show("This area name is already being tracked.", "warning");
          return;
        }
        if (modal) modal.hide();
        manager.currentProcessingLocation = customAreaToAdd;
        manager.currentTaskId = null;
        manager._addBeforeUnloadListener();
        manager.showProgressModal?.(`Starting processing for ${customAreaToAdd.display_name}...`, 0);
        const preprocessResponse = await fetch("/api/preprocess_custom_boundary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(customAreaToAdd),
        });
        const taskData = await preprocessResponse.json();
        if (!preprocessResponse.ok) {
          manager.hideProgressModal?.();
          throw new Error(taskData.detail || "Failed to start processing");
        }
        manager.notificationManager?.show("Custom coverage area processing started.", "info");
        if (taskData?.task_id) {
          manager.currentTaskId = taskData.task_id;
          manager.activeTaskIds.add(taskData.task_id);
          manager.saveProcessingState?.();
          await manager.pollCoverageProgress?.(taskData.task_id);
          manager.notificationManager?.show(
            `Processing for ${customAreaToAdd.display_name} completed.`,
            "success",
          );
          await manager.loadCoverageAreas?.();
        } else {
          manager.hideProgressModal?.();
          manager.notificationManager?.show("Processing started, but no task ID received.", "warning");
          await manager.loadCoverageAreas?.();
        }
        const customAreaName = document.getElementById("custom-area-name");
        if (customAreaName) customAreaName.value = "";
        manager.validatedCustomBoundary = null;
        manager.updateTotalAreasCount?.();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error adding custom coverage area:", error);
        manager.notificationManager?.show(`Failed to add custom coverage area: ${error.message}`, "danger");
        manager.hideProgressModal?.();
        await manager.loadCoverageAreas?.();
      } finally {
        addButton.disabled = true;
        addButton.innerHTML = originalButtonContent;
      }
    },
  };

  window.CoverageModules.Drawing = Drawing;
})();


