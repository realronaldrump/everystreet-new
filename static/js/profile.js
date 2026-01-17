/**
 * Profile Settings Page JavaScript
 * Handles Bouncie API credentials management
 */

(() => {
  const editorState = window.ProfileState?.createEditorState
    ? window.ProfileState.createEditorState()
    : null;
  const normalizeValues = window.ProfileState?.normalizeValues;
  const DEFAULT_FETCH_CONCURRENCY
    = window.ProfileState?.DEFAULT_FETCH_CONCURRENCY || 12;

  let currentDevices = [];
  let pageSignal = null;

  // Initialize page
  window.utils?.onPageLoad(
    ({ signal, cleanup } = {}) => {
      pageSignal = signal || null;
      initializeEventListeners(signal);
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
      form.addEventListener(
        "submit",
        handleSaveCredentials,
        signal ? { signal } : false
      );
      form.addEventListener("input", handleFormInput, signal ? { signal } : false);
      form.addEventListener("change", handleFormInput, signal ? { signal } : false);
    }

    const editBtn = document.getElementById("editProfileBtn");
    if (editBtn) {
      editBtn.addEventListener("click", enterEditMode, signal ? { signal } : false);
    }

    const cancelBtn = document.getElementById("cancelEditBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener(
        "click",
        handleCancelEdit,
        signal ? { signal } : false
      );
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
      addDeviceBtn.addEventListener(
        "click",
        addDeviceInput,
        signal ? { signal } : false
      );
    }

    const toggleSecretBtn = document.getElementById("toggleClientSecret");
    if (toggleSecretBtn) {
      toggleSecretBtn.addEventListener(
        "click",
        () => togglePasswordVisibility("clientSecret", "toggleClientSecret"),
        signal ? { signal } : false
      );
    }

    const toggleAuthBtn = document.getElementById("toggleAuthCode");
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener(
        "click",
        () => togglePasswordVisibility("authorizationCode", "toggleAuthCode"),
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
    const authorizationCode
      = document.getElementById("authorizationCode")?.value.trim() || "";
    const fetchConcurrencyRaw = document.getElementById("fetchConcurrency")?.value;
    const fetchConcurrency = parseInt(fetchConcurrencyRaw, 10);

    const deviceInputs = document.querySelectorAll("#devicesList input");
    const devices = Array.from(deviceInputs).map((input) => input.value.trim());

    return {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      authorization_code: authorizationCode,
      authorized_devices: devices,
      fetch_concurrency: Number.isFinite(fetchConcurrency)
        ? fetchConcurrency
        : DEFAULT_FETCH_CONCURRENCY,
    };
  }

  function validateDraftValues(values) {
    if (
      !values.client_id
      || !values.client_secret
      || !values.redirect_uri
      || !values.authorization_code
    ) {
      return "All credential fields are required.";
    }

    const redirectUriInput = document.getElementById("redirectUri");
    if (redirectUriInput && !redirectUriInput.checkValidity()) {
      return "Enter a valid redirect URL.";
    }

    const devices = values.authorized_devices.filter((val) => val.length > 0);
    if (devices.length === 0) {
      return "At least one authorized device is required.";
    }

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
    showStatus("Changes discarded.", "info");
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
        showStatus(
          masked ? "Loading credentials..." : "Loading unmasked credentials...",
          "info"
        );
      }

      const response = await fetch(endpoint, withSignal());
      const data = await response.json();
      const credentials = data.credentials || {};

      if (data.status === "success") {
        populateForm(credentials, masked);
        if (forEdit) {
          editorState?.startEditing(credentials);
        }
        applyEditorStateUI();

        if (!silent) {
          if (forEdit) {
            showStatus("Editing enabled. Credentials unlocked.", "success");
          } else if (data.credentials) {
            showStatus("Credentials loaded successfully", "success");
          } else {
            showStatus(
              "No credentials found. Enter your Bouncie credentials to save.",
              "warning"
            );
          }
        }
      } else {
        showStatus(
          "No credentials found. Enter your Bouncie credentials to save.",
          "warning"
        );
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      showStatus(`Error loading credentials: ${error.message}`, "error");
    }
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
    const authCodeInput = document.getElementById("authorizationCode");
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
    if (authCodeInput) {
      authCodeInput.value = normalized.authorization_code || "";
    }
    if (fetchConcurrencyInput) {
      fetchConcurrencyInput.value = String(
        normalized.fetch_concurrency || DEFAULT_FETCH_CONCURRENCY
      );
    }

    resetPasswordToggle("clientSecret", "toggleClientSecret");
    resetPasswordToggle("authorizationCode", "toggleAuthCode");

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
      if (authCodeInput) {
        authCodeInput.classList.add("credential-masked");
      }
    } else {
      if (clientSecretInput) {
        clientSecretInput.classList.remove("credential-masked");
      }
      if (authCodeInput) {
        authCodeInput.classList.remove("credential-masked");
      }
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
      showStatus("Enable editing to modify devices.", "warning");
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
      showStatus("At least one device is required", "warning");
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
      showStatus("Enable editing to make changes.", "warning");
      return;
    }

    const draftValues = getFormValues();
    editorState?.updateDraft(draftValues);
    applyEditorStateUI();

    const validationError = validateDraftValues(draftValues);
    if (validationError) {
      showStatus(validationError, "error");
      return;
    }

    const devices = draftValues.authorized_devices
      .map((val) => val.trim())
      .filter((val) => val.length > 0);

    try {
      showStatus("Saving credentials...", "info");

      const response = await fetch(
        "/api/profile/bouncie-credentials",
        withSignal({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: draftValues.client_id,
            client_secret: draftValues.client_secret,
            redirect_uri: draftValues.redirect_uri,
            authorization_code: draftValues.authorization_code,
            authorized_devices: devices,
            fetch_concurrency: draftValues.fetch_concurrency,
          }),
        })
      );

      const data = await response.json();

      if (response.ok && data.status === "success") {
        showStatus("Credentials saved successfully!", "success");
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
        showStatus(
          `Error saving credentials: ${data.detail || data.message || "Unknown error"}`,
          "error"
        );
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      showStatus(`Error saving credentials: ${error.message}`, "error");
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

  async function confirmDiscardChanges() {
    if (window.confirmationDialog?.show) {
      return window.confirmationDialog.show({
        title: "Discard changes?",
        message: "You have unsaved changes. Discard them and leave this page?",
        confirmText: "Discard changes",
        cancelText: "Stay on page",
        confirmButtonClass: "btn-danger",
      });
    }
    return window.confirm("You have unsaved changes. Discard them and leave?");
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
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
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
   * Show status message
   * @param {string} message - Status message
   * @param {string} type - Status type (success, error, warning, info)
   */
  function showStatus(message, type) {
    const statusEl = document.getElementById("credentialsSaveStatus");
    const bannerEl = document.getElementById("credentials-status-banner");
    const bannerTextEl = document.getElementById("credentials-status-text");
    const isError = type === "error";

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `alert alert-${getBootstrapClass(type)} mt-3`;
      statusEl.style.display = "block";
      statusEl.setAttribute("role", isError ? "alert" : "status");
      statusEl.setAttribute("aria-live", isError ? "assertive" : "polite");

      setTimeout(() => {
        statusEl.style.display = "none";
      }, 5000);
    }

    if (bannerEl && bannerTextEl) {
      bannerTextEl.textContent = message;
      bannerEl.className = `credentials-status ${type}`;
      bannerEl.style.display = "block";
      bannerEl.setAttribute("role", isError ? "alert" : "status");
      bannerEl.setAttribute("aria-live", isError ? "assertive" : "polite");

      if (type === "success") {
        setTimeout(() => {
          bannerEl.style.display = "none";
        }, 5000);
      }
    }
  }

  /**
   * Map status type to Bootstrap class
   * @param {string} type - Status type
   */
  function getBootstrapClass(type) {
    const map = {
      success: "success",
      error: "danger",
      warning: "warning",
      info: "info",
    };
    return map[type] || "info";
  }

  /**
   * Sync vehicles from Bouncie (updates authorized devices in credentials)
   */
  async function syncVehiclesFromBouncie() {
    if (pageSignal?.aborted) {
      return;
    }
    try {
      showStatus("Syncing vehicles from Bouncie...", "info");

      const response = await fetch(
        "/api/profile/bouncie-credentials/sync-vehicles",
        withSignal({
          method: "POST",
        })
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to sync vehicles");
      }

      showStatus(data.message || "Vehicles synced successfully!", "success");

      // Reload credentials to update authorized devices
      await loadCredentials();
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      showStatus(`Error syncing vehicles: ${error.message}`, "error");
    }
  }
})();
