/**
 * Location Validator
 * Handles location input validation and API validation
 */

import { validateLocationApi } from "./api.js";

/**
 * Validate that a location input has required data
 * @param {HTMLInputElement} locationInput - Location input element
 * @returns {boolean} True if valid
 */
export function validateLocationInput(locationInput) {
  if (!locationInput) {
    window.notificationManager?.show("Location input not found", "warning");
    return false;
  }

  if (!locationInput.value.trim()) {
    window.notificationManager?.show("Please enter a location", "warning");
    return false;
  }

  const locationData = locationInput.getAttribute("data-location");
  if (!locationData) {
    window.notificationManager?.show("Please validate the location first", "warning");
    return false;
  }

  return true;
}

/**
 * Validate a location input by querying the API
 * @param {string} inputId - ID of the location input element
 * @returns {Promise<void>}
 */
export async function validateLocation(inputId) {
  const locationInput = document.getElementById(inputId);

  if (!locationInput || !locationInput.value.trim()) {
    window.notificationManager?.show("Please enter a location", "warning");
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
    window.notificationManager?.show(
      `Validating location: "${locationInput.value}"...`,
      "info"
    );

    const data = await validateLocationApi(locationInput.value);

    if (data) {
      locationInput.setAttribute("data-location", JSON.stringify(data));
      locationInput.setAttribute(
        "data-display-name",
        data.display_name || data.name || locationInput.value
      );

      locationInput.value = data.display_name || data.name || locationInput.value;

      locationInput.classList.add("is-valid");
      locationInput.classList.remove("is-invalid");

      const submitButton = form?.querySelector('button[type="submit"]');
      if (submitButton) {
        submitButton.disabled = false;
      }

      window.notificationManager?.show(
        `Location validated: "${data.display_name || data.name || locationInput.value}"`,
        "success"
      );
    } else {
      locationInput.classList.add("is-invalid");
      locationInput.classList.remove("is-valid");
      window.notificationManager?.show(
        "Location not found. Please try a different search term",
        "warning"
      );
    }
  } catch (error) {
    if (window.handleError) {
      window.handleError(error, "validating location");
    } else {
      console.error("Error validating location:", error);
      window.notificationManager?.show(`Validation failed: ${error.message}`, "danger");
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

export default {
  validateLocationInput,
  validateLocation,
};
