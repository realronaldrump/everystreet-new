/**
 * Profile Settings Page JavaScript
 * Handles Bouncie API credentials management
 */

import apiClient from "./modules/core/api-client.js";
import confirmationDialog from "./modules/ui/confirmation-dialog.js";
import { notify } from "./modules/ui/notifications.js";
import { onPageLoad } from "./modules/utils.js";
import {
  createEditorState,
  DEFAULT_FETCH_CONCURRENCY,
  normalizeValues,
} from "./profile-state.js";

const editorState = createEditorState();

let currentDevices = [];
let pageSignal = null;

// Initialize page
onPageLoad(
  ({ signal, cleanup } = {}) => {
    pageSignal = signal || null;
    const hasCredentialsForm = Boolean(
      document.getElementById("bouncieCredentialsForm")
    );
    if (!hasCredentialsForm) {
      if (typeof cleanup === "function") {
        cleanup(() => {
          pageSignal = null;
        });
      }
      return;
    }

    initializeEventListeners(signal);
    initServiceConfigForm(signal);
    applyEditorStateUI();
    loadCredentials();
    if (typeof cleanup === "function") {
      cleanup(() => {
        pageSignal = null;
        currentDevices = [];
        editorState?.cancelEditing();
      });
    }
  },
  { route: "/profile" }
);

function withSignal(options = {}) {
  if (pageSignal) {
    return { ...options, signal: pageSignal };
  }
  return options;
}

function getEditorSnapshot() {
  if (!editorState) {
    return {
      savedValues: null,
      draftValues: null,
      isEditing: false,
      isDirty: false,
    };
  }
  return editorState.getState();
}

/**
 * Initialize all event listeners
 */
function initializeEventListeners(signal) {
  const form = document.getElementById("bouncieCredentialsForm");
  if (form) {
    form.addEventListener("submit", handleSaveCredentials, signal ? { signal } : false);
    form.addEventListener("input", handleFormInput, signal ? { signal } : false);
    form.addEventListener("change", handleFormInput, signal ? { signal } : false);
  }

  const editBtn = document.getElementById("editProfileBtn");
  if (editBtn) {
    editBtn.addEventListener("click", enterEditMode, signal ? { signal } : false);
  }

  const cancelBtn = document.getElementById("cancelEditBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", handleCancelEdit, signal ? { signal } : false);
  }

  const loadBtn = document.getElementById("loadCredentialsBtn");
  if (loadBtn) {
    loadBtn.addEventListener(
      "click",
      () => loadCredentials(),
      signal ? { signal } : false
    );
  }

  const unmaskBtn = document.getElementById("unmaskCredentialsBtn");
  if (unmaskBtn) {
    unmaskBtn.addEventListener(
      "click",
      unmaskAllCredentials,
      signal ? { signal } : false
    );
  }

  const addDeviceBtn = document.getElementById("addDeviceBtn");
  if (addDeviceBtn) {
    addDeviceBtn.addEventListener("click", addDeviceInput, signal ? { signal } : false);
  }

  const toggleSecretBtn = document.getElementById("toggleClientSecret");
  if (toggleSecretBtn) {
    toggleSecretBtn.addEventListener(
      "click",
      () => togglePasswordVisibility("clientSecret", "toggleClientSecret"),
      signal ? { signal } : false
    );
  }

  // Navigation protection for unsaved changes
  window.addEventListener(
    "beforeunload",
    handleBeforeUnload,
    signal ? { signal } : false
  );
  document.addEventListener(
    "click",
    handleNavigationAttempt,
    signal ? { capture: true, signal } : { capture: true }
  );

  // Vehicle sync for authorized devices (syncs to credentials)
  const syncVehiclesBtn = document.getElementById("syncVehiclesBtn");
  if (syncVehiclesBtn) {
    syncVehiclesBtn.addEventListener(
      "click",
      syncVehiclesFromBouncie,
      signal ? { signal } : false
    );
  }
}

function applyEditorStateUI(snapshot = null) {
  const state = snapshot || getEditorSnapshot();
  const form = document.getElementById("bouncieCredentialsForm");
  const editLabel = document.getElementById("profileEditStateLabel");
  const helpText = document.getElementById("editModeHelpText");
  const editBtn = document.getElementById("editProfileBtn");
  const cancelBtn = document.getElementById("cancelEditBtn");
  const saveBtn = document.getElementById("saveCredentialsBtn");
  const dirtyIndicator = document.getElementById("profileEditDirty");

  if (form) {
    form.dataset.editing = state.isEditing ? "true" : "false";
    form.setAttribute("aria-disabled", state.isEditing ? "false" : "true");
  }

  if (editLabel) {
    editLabel.textContent = state.isEditing ? "Editing enabled" : "Read-only";
    editLabel.classList.toggle("is-editing", state.isEditing);
  }

  if (helpText) {
    helpText.textContent = state.isEditing
      ? "Editing is on. Save changes to apply updates or cancel to discard."
      : "Editing is locked to prevent accidental changes. Enable editing to update your credentials.";
  }

  if (editBtn) {
    editBtn.disabled = state.isEditing;
    editBtn.setAttribute("aria-pressed", state.isEditing ? "true" : "false");
  }

  if (cancelBtn) {
    cancelBtn.disabled = !state.isEditing;
  }

  if (saveBtn) {
    saveBtn.disabled = !state.isEditing || !state.isDirty;
  }

  if (dirtyIndicator) {
    dirtyIndicator.hidden = !state.isEditing || !state.isDirty;
  }

  setEditableControlsEnabled(state.isEditing);
}

function setEditableControlsEnabled(enabled) {
  const form = document.getElementById("bouncieCredentialsForm");
  if (!form) {
    return;
  }
  const fieldset = document.getElementById("profileEditableFields");
  if (fieldset) {
    fieldset.disabled = !enabled;
    fieldset.setAttribute("aria-disabled", (!enabled).toString());
    if (fieldset.toggleAttribute) {
      fieldset.toggleAttribute("inert", !enabled);
    }
  }
  const editableControls = form.querySelectorAll("[data-editable]");
  editableControls.forEach((control) => {
    control.disabled = !enabled;
    control.setAttribute("aria-disabled", (!enabled).toString());
  });
}

function handleFormInput() {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    return;
  }
  updateDraftState();
}

function updateDraftState() {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    return;
  }
  const values = getFormValues();
  editorState?.updateDraft(values);
  applyEditorStateUI();
}

function getFormValues() {
  const clientId = document.getElementById("clientId")?.value.trim() || "";
  const clientSecret = document.getElementById("clientSecret")?.value.trim() || "";
  const redirectUri = document.getElementById("redirectUri")?.value.trim() || "";
  const fetchConcurrencyRaw = document.getElementById("fetchConcurrency")?.value;
  const fetchConcurrency = parseInt(fetchConcurrencyRaw, 10);

  const deviceInputs = document.querySelectorAll("#devicesList input");
  const devices = Array.from(deviceInputs).map((input) => input.value.trim());

  return {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    authorized_devices: devices,
    fetch_concurrency: Number.isFinite(fetchConcurrency)
      ? fetchConcurrency
      : DEFAULT_FETCH_CONCURRENCY,
  };
}

function validateDraftValues(values) {
  if (!values.client_id || !values.client_secret || !values.redirect_uri) {
    return "All credential fields are required.";
  }

  const redirectUriInput = document.getElementById("redirectUri");
  if (redirectUriInput && !redirectUriInput.checkValidity()) {
    return "Enter a valid redirect URL.";
  }

  const _devices = values.authorized_devices.filter((val) => val.length > 0);

  if (values.fetch_concurrency < 1 || values.fetch_concurrency > 50) {
    return "Fetch concurrency must be between 1 and 50.";
  }

  return null;
}

async function enterEditMode() {
  const state = getEditorSnapshot();
  if (state.isEditing) {
    return;
  }
  await loadCredentials({ masked: false, forEdit: true });
  const updated = getEditorSnapshot();
  if (updated.isEditing) {
    document.getElementById("clientId")?.focus();
  }
}

function handleCancelEdit() {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    return;
  }
  editorState?.cancelEditing();
  applyEditorStateUI();
  notify.info("Changes discarded.");
  loadCredentials();
}

/**
 * Load credentials from the server
 */
async function loadCredentials(options = {}) {
  if (pageSignal?.aborted) {
    return;
  }
  const { masked = true, forEdit = false, silent = false } = options;
  const endpoint = masked
    ? "/api/profile/bouncie-credentials"
    : "/api/profile/bouncie-credentials/unmask";

  try {
    if (!silent) {
      // Optional: could show a loading toast if desired, but usually we just wait for success/error
      // unless it's a long process. For now, we'll skip the "loading" toast to reduce noise
      // or use a loading spinner elsewhere.
      // notify.info(masked ? "Loading credentials..." : "Loading unmasked credentials...");
    }

    const data = await apiClient.get(endpoint, withSignal());
    const credentials = data.credentials || {};
    if (!credentials.redirect_uri) {
      const expectedRedirectUri = await getExpectedRedirectUri();
      if (expectedRedirectUri) {
        credentials.redirect_uri = expectedRedirectUri;
      }
    }

    if (data.status === "success") {
      populateForm(credentials, masked);
      if (forEdit) {
        editorState?.startEditing(credentials);
      }
      applyEditorStateUI();

      if (!silent) {
        if (forEdit) {
          notify.success("Editing enabled. Credentials unlocked.");
        } else if (data.credentials) {
          notify.success("Credentials loaded successfully");
        } else {
          notify.warning(
            "No credentials found. Enter your Bouncie credentials to save."
          );
        }
      }
    } else {
      notify.warning("No credentials found. Enter your Bouncie credentials to save.");
    }
  } catch (error) {
    if (pageSignal?.aborted) {
      return;
    }
    notify.error(`Error loading credentials: ${error.message}`);
  }
}

async function getExpectedRedirectUri() {
  try {
    const data = await apiClient.get("/api/bouncie/redirect-uri", withSignal());
    if (data?.redirect_uri) {
      return data.redirect_uri;
    }
  } catch (_error) {
    // Fall back to constructing from window.location
  }
  return `${window.location.origin}/api/bouncie/callback`;
}

/**
 * Unmask all credentials (loads full unmasked values)
 */
async function unmaskAllCredentials() {
  const state = getEditorSnapshot();
  if (state.isEditing) {
    return;
  }
  await loadCredentials({ masked: false });
}

/**
 * Populate form with credential data
 * @param {Object} credentials - Credential data
 * @param {boolean} masked - Whether credentials are masked
 */
function populateForm(credentials, masked = true) {
  const normalized = normalizeValues
    ? normalizeValues(credentials)
    : { ...credentials };
  const clientIdInput = document.getElementById("clientId");
  const clientSecretInput = document.getElementById("clientSecret");
  const redirectUriInput = document.getElementById("redirectUri");
  const fetchConcurrencyInput = document.getElementById("fetchConcurrency");

  if (clientIdInput) {
    clientIdInput.value = normalized.client_id || "";
  }
  if (clientSecretInput) {
    clientSecretInput.value = normalized.client_secret || "";
  }
  if (redirectUriInput) {
    redirectUriInput.value = normalized.redirect_uri || "";
  }
  if (fetchConcurrencyInput) {
    fetchConcurrencyInput.value = String(
      normalized.fetch_concurrency || DEFAULT_FETCH_CONCURRENCY
    );
  }

  resetPasswordToggle("clientSecret", "toggleClientSecret");

  // Handle devices
  currentDevices = Array.isArray(normalized.authorized_devices)
    ? normalized.authorized_devices
    : [];
  renderDevices();

  // Add CSS class for masked fields
  if (masked) {
    if (clientSecretInput) {
      clientSecretInput.classList.add("credential-masked");
    }
  } else if (clientSecretInput) {
    clientSecretInput.classList.remove("credential-masked");
  }
}

/**
 * Render device input fields
 */
function renderDevices() {
  const container = document.getElementById("devicesList");
  const state = getEditorSnapshot();

  if (container) {
    container.innerHTML = "";
    if (!Array.isArray(currentDevices) || currentDevices.length === 0) {
      currentDevices = [""];
    }
    currentDevices.forEach((device, index) => {
      container.appendChild(createDeviceInput(device, index));
    });
  }

  setEditableControlsEnabled(state.isEditing);
}

/**
 * Create a device input element
 * @param {string} value - Device IMEI value
 * @param {number} index - Device index
 */
function createDeviceInput(value, index) {
  const container = document.createElement("div");
  container.className = "device-list-item";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "form-control";
  input.placeholder = "Enter device IMEI";
  input.value = value;
  input.dataset.index = index;
  input.dataset.editable = "true";
  input.addEventListener("input", (event) => {
    const idx = Number(event.target.dataset.index);
    if (Number.isFinite(idx)) {
      currentDevices[idx] = event.target.value;
    }
    updateDraftState();
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn btn-sm btn-outline-danger";
  removeBtn.dataset.editable = "true";
  removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
  removeBtn.addEventListener("click", () => removeDevice(index));

  container.appendChild(input);
  container.appendChild(removeBtn);

  return container;
}

function syncDevicesFromInputs() {
  const deviceInputs = document.querySelectorAll("#devicesList input");
  currentDevices = Array.from(deviceInputs).map((input) => input.value);
}

/**
 * Add a new device input
 */
function addDeviceInput() {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    notify.warning("Enable editing to modify devices.");
    return;
  }
  syncDevicesFromInputs();
  currentDevices.push("");
  renderDevices();
  updateDraftState();
  const deviceInputs = document.querySelectorAll("#devicesList input");
  deviceInputs[deviceInputs.length - 1]?.focus();
}

/**
 * Remove a device input
 * @param {number} index - Index to remove
 */
function removeDevice(index) {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    return;
  }
  syncDevicesFromInputs();
  if (currentDevices.length > 1) {
    currentDevices.splice(index, 1);
    renderDevices();
    updateDraftState();
  } else {
    notify.warning("At least one device is required");
  }
}

/**
 * Handle save credentials form submission
 * @param {Event} event - Form submit event
 */
async function handleSaveCredentials(event) {
  event.preventDefault();
  if (pageSignal?.aborted) {
    return;
  }

  const state = getEditorSnapshot();
  if (!state.isEditing) {
    notify.warning("Enable editing to make changes.");
    return;
  }

  const draftValues = getFormValues();
  editorState?.updateDraft(draftValues);
  applyEditorStateUI();

  const validationError = validateDraftValues(draftValues);
  if (validationError) {
    notify.error(validationError);
    return;
  }

  const devices = draftValues.authorized_devices
    .map((val) => val.trim())
    .filter((val) => val.length > 0);

  try {
    showStatus("Saving credentials...", "info");

    const data = await apiClient.post(
      "/api/profile/bouncie-credentials",
      {
        client_id: draftValues.client_id,
        client_secret: draftValues.client_secret,
        redirect_uri: draftValues.redirect_uri,
        authorized_devices: devices,
        fetch_concurrency: draftValues.fetch_concurrency,
      },
      withSignal()
    );

    if (data.status === "success") {
      notify.success("Credentials saved successfully!");
      currentDevices = draftValues.authorized_devices;
      editorState?.commitDraft();
      editorState?.cancelEditing();
      applyEditorStateUI();

      // Reload to show masked values
      setTimeout(() => {
        if (!pageSignal?.aborted) {
          loadCredentials({ silent: true });
        }
      }, 1500);
    } else {
      notify.error(
        `Error saving credentials: ${data.detail || data.message || "Unknown error"}`
      );
    }
  } catch (error) {
    if (pageSignal?.aborted) {
      return;
    }
    notify.error(`Error saving credentials: ${error.message}`);
  }
}

/**
 * Toggle password visibility
 * @param {string} inputId - Input element ID
 * @param {string} buttonId - Button element ID
 */
function togglePasswordVisibility(inputId, buttonId) {
  const state = getEditorSnapshot();
  if (!state.isEditing) {
    return;
  }
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);

  if (input && button) {
    const icon = button.querySelector("i");
    if (input.type === "password") {
      input.type = "text";
      if (icon) {
        icon.className = "fas fa-eye-slash";
      }
    } else {
      input.type = "password";
      if (icon) {
        icon.className = "fas fa-eye";
      }
    }
  }
}

function resetPasswordToggle(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);
  if (!input || !button) {
    return;
  }
  input.type = "password";
  const icon = button.querySelector("i");
  if (icon) {
    icon.className = "fas fa-eye";
  }
}

function shouldPromptOnNavigate() {
  return editorState?.hasUnsavedChanges() || false;
}

function confirmDiscardChanges() {
  if (confirmationDialog?.show) {
    return confirmationDialog.show({
      title: "Discard changes?",
      message: "You have unsaved changes. Discard them and leave this page?",
      confirmText: "Discard changes",
      cancelText: "Stay on page",
      confirmButtonClass: "btn-danger",
    });
  }
  console.warn("Confirmation dialog module not available");
  return Promise.resolve(true); // Allow navigation if dialog fails, rather than blocking or using ugly alert
}

function handleBeforeUnload(event) {
  if (!shouldPromptOnNavigate()) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
}

function handleNavigationAttempt(event) {
  if (!shouldPromptOnNavigate()) {
    return;
  }
  if (event.defaultPrevented) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const anchor = event.target.closest("a");
  if (!anchor) {
    return;
  }

  if (anchor.target && anchor.target !== "_self") {
    return;
  }

  if (anchor.hasAttribute("download") || anchor.dataset.bsToggle) {
    return;
  }

  const href = anchor.getAttribute("href");
  const scriptProtocol = "javascript".concat(":");
  if (
    !href
    || href.startsWith("#")
    || href.trim().toLowerCase().startsWith(scriptProtocol)
  ) {
    return;
  }

  event.preventDefault();
  confirmDiscardChanges().then((confirmed) => {
    if (confirmed) {
      window.location.assign(anchor.href);
    }
  });
}

/**
 * Deleted showStatus and getBootstrapClass functions as they are replaced by notify module
 */

/**
 * Sync vehicles from Bouncie (updates authorized devices in credentials)
 */
async function syncVehiclesFromBouncie() {
  if (pageSignal?.aborted) {
    return;
  }
  try {
    notify.info("Syncing vehicles from Bouncie...");

    const data = await apiClient.post(
      "/api/profile/bouncie-credentials/sync-vehicles",
      null,
      withSignal()
    );

    notify.success(data.message || "Vehicles synced successfully!");

    // Reload credentials to update authorized devices
    await loadCredentials();
  } catch (error) {
    if (pageSignal?.aborted) {
      return;
    }
    notify.error(`Error syncing vehicles: ${error.message}`);
  }
}

// ==========================================================================
// Service Configuration Handling
// ==========================================================================

/**
 * Initialize service configuration form
 */
function initServiceConfigForm(signal) {
  const form = document.getElementById("serviceConfigForm");
  if (!form) {
    return;
  }

  form.addEventListener("submit", handleSaveServiceConfig, signal ? { signal } : false);

  const reloadBtn = document.getElementById("reloadServiceConfigBtn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", loadServiceConfig, signal ? { signal } : false);
  }

  // Load settings on page load
  loadServiceConfig();
}

/**
 * Load service configuration from the server
 */
async function loadServiceConfig() {
  try {
    const settings = await apiClient.get("/api/app_settings", withSignal());
    populateServiceConfigForm(settings);
  } catch (error) {
    if (pageSignal?.aborted) {
      return;
    }
    notify.error(`Error loading settings: ${error.message}`);
  }
}

/**
 * Populate service config form with settings
 */
function populateServiceConfigForm(settings) {
  const mapboxToken = document.getElementById("mapboxToken");

  if (mapboxToken) {
    mapboxToken.value = settings.mapbox_token || "";
  }
}

/**
 * Handle save service configuration
 */
async function handleSaveServiceConfig(event) {
  event.preventDefault();
  if (pageSignal?.aborted) {
    return;
  }

  const mapboxToken = document.getElementById("mapboxToken")?.value.trim() || null;

  // Validate Mapbox token format if provided
  if (mapboxToken && !mapboxToken.startsWith("pk.")) {
    notify.error("Mapbox token must start with 'pk.'");
    return;
  }

  try {
    notify.info("Saving service configuration...");

    await apiClient.post(
      "/api/app_settings",
      { mapbox_token: mapboxToken },
      withSignal()
    );

    notify.success("Service configuration saved successfully!");
  } catch (error) {
    if (pageSignal?.aborted) {
      return;
    }
    notify.error(`Error saving settings: ${error.message}`);
  }
}

/**
 * Show service config status message
 */
/**
 * Deleted showServiceConfigStatus as it is replaced by notify module
 */

if (document.getElementById("serviceConfigForm")) {
  initServiceConfigForm(pageSignal);
}
