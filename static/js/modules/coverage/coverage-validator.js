/**
 * Coverage Validator
 * Handles validation of locations and custom boundaries
 */
import COVERAGE_API from "./coverage-api.js";

export class CoverageValidator {
  constructor(notificationManager, drawingModule) {
    this.notificationManager = notificationManager;
    this.drawing = drawingModule;

    // State
    this.validatedLocation = null;
    this.validatedCustomBoundary = null;
  }

  /**
   * Validate location
   */
  async validateLocation() {
    const locationInputEl = document.getElementById("location-input");
    const locationTypeEl = document.getElementById("location-type");
    const validateButton = document.getElementById("validate-location");
    const addButton = document.getElementById("add-coverage-area");

    if (!locationInputEl || !locationTypeEl || !validateButton || !addButton) {
      console.error("Validation form elements not found.");
      return;
    }

    const locationInput = locationInputEl.value.trim();
    const locType = locationTypeEl.value;

    locationInputEl.classList.remove("is-invalid", "is-valid");
    addButton.disabled = true;
    this.validatedLocation = null;

    if (!locationInput) {
      locationInputEl.classList.add("is-invalid", "shake-animation");
      this.notificationManager.show("Please enter a location.", "warning");
      return;
    }

    const originalButtonContent = validateButton.innerHTML;
    validateButton.disabled = true;
    validateButton.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Validating...';

    try {
      const data = await COVERAGE_API.validateLocation(locationInput, locType);

      if (!data || !data.osm_id || !data.display_name) {
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show(
          "Location not found. Please check your input.",
          "warning",
        );
      } else {
        locationInputEl.classList.add("is-valid");
        this.validatedLocation = data;
        addButton.disabled = false;

        const validationResult = document.getElementById("validation-result");
        if (validationResult) {
          validationResult.classList.remove("d-none");
          validationResult.querySelector(".validation-message").textContent =
            `Found: ${data.display_name}`;
        }

        this.notificationManager.show(
          `Location validated: ${data.display_name}`,
          "success",
        );
        addButton.focus();
      }
    } catch (error) {
      console.error("Error validating location:", error);
      locationInputEl.classList.add("is-invalid");
      this.notificationManager.show(
        `Validation failed: ${error.message}`,
        "danger",
      );
    } finally {
      validateButton.disabled = false;
      validateButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Validate custom boundary
   */
  async validateCustomBoundary() {
    const customAreaNameInput = document.getElementById("custom-area-name");
    const validateButton = document.getElementById("validate-drawing");
    const addButton = document.getElementById("add-custom-area");

    if (!customAreaNameInput || !validateButton) {
      console.error("Required form elements not found.");
      return;
    }

    const areaName = customAreaNameInput.value.trim();
    if (!areaName) {
      customAreaNameInput.classList.add("is-invalid", "shake-animation");
      this.notificationManager.show("Please enter an area name.", "warning");
      return;
    }

    const drawnFeatures = this.drawing.getAllDrawnFeatures();
    if (!drawnFeatures.features || drawnFeatures.features.length === 0) {
      this.notificationManager.show(
        "Please draw a polygon boundary first.",
        "warning",
      );
      return;
    }

    const polygon = drawnFeatures.features[0];
    if (polygon.geometry.type !== "Polygon") {
      this.notificationManager.show(
        "Please draw a polygon boundary.",
        "warning",
      );
      return;
    }

    customAreaNameInput.classList.remove("is-invalid", "is-valid");
    if (addButton) {
      addButton.disabled = true;
    }
    this.validatedCustomBoundary = null;
    this.drawing.hideDrawingValidationResult();

    const originalButtonContent = validateButton.innerHTML;
    validateButton.disabled = true;
    validateButton.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Validating...';

    try {
      const data = await COVERAGE_API.validateCustomBoundary(
        areaName,
        polygon.geometry,
      );

      if (!data || !data.valid) {
        customAreaNameInput.classList.add("is-invalid");
        this.notificationManager.show(
          "Custom boundary validation failed. Please check your drawing.",
          "warning",
        );
      } else {
        customAreaNameInput.classList.add("is-valid");
        this.validatedCustomBoundary = data;
        this.drawing.validatedCustomBoundary = data;
        if (addButton) {
          addButton.disabled = false;
        }

        this.drawing.showDrawingValidationResult(data);

        this.notificationManager.show(
          `Custom boundary "${data.display_name}" validated successfully!`,
          "success",
        );

        if (addButton) {
          addButton.focus();
        }
      }
    } catch (error) {
      console.error("Error validating custom boundary:", error);
      customAreaNameInput.classList.add("is-invalid");
      this.notificationManager.show(
        `Validation failed: ${error.message}`,
        "danger",
      );
    } finally {
      validateButton.disabled = false;
      validateButton.innerHTML = originalButtonContent;
    }
  }

  resetValidationState() {
    this.validatedLocation = null;
    this.validatedCustomBoundary = null;

    const validationResult = document.getElementById("validation-result");
    const drawingValidationResult = document.getElementById(
      "drawing-validation-result",
    );

    if (validationResult) {
      validationResult.classList.add("d-none");
    }
    if (drawingValidationResult) {
      drawingValidationResult.classList.add("d-none");
    }

    const addLocationButton = document.getElementById("add-coverage-area");
    const addCustomButton = document.getElementById("add-custom-area");

    if (addLocationButton) {
      addLocationButton.disabled = true;
    }
    if (addCustomButton) {
      addCustomButton.disabled = true;
    }
  }
}
