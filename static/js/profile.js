/**
 * Profile Settings Page JavaScript
 * Handles Bouncie API credentials management
 */

(function () {
  'use strict';

  let unmaskedCredentials = null;
  let currentDevices = [];

  // Initialize page
  document.addEventListener('DOMContentLoaded', function () {
    initializeEventListeners();
    loadCredentials();
    initializeMobileToggles();
  });

  /**
   * Initialize all event listeners
   */
  function initializeEventListeners() {
    // Desktop event listeners
    const desktopForm = document.getElementById('bouncieCredentialsForm');
    if (desktopForm) {
      desktopForm.addEventListener('submit', handleSaveCredentials);
    }

    const loadBtn = document.getElementById('loadCredentialsBtn');
    if (loadBtn) {
      loadBtn.addEventListener('click', loadCredentials);
    }

    const unmaskBtn = document.getElementById('unmaskCredentialsBtn');
    if (unmaskBtn) {
      unmaskBtn.addEventListener('click', unmaskAllCredentials);
    }

    const addDeviceBtn = document.getElementById('addDeviceBtn');
    if (addDeviceBtn) {
      addDeviceBtn.addEventListener('click', () => addDeviceInput());
    }

    const toggleSecretBtn = document.getElementById('toggleClientSecret');
    if (toggleSecretBtn) {
      toggleSecretBtn.addEventListener('click', () => togglePasswordVisibility('clientSecret', 'toggleClientSecret'));
    }

    const toggleAuthBtn = document.getElementById('toggleAuthCode');
    if (toggleAuthBtn) {
      toggleAuthBtn.addEventListener('click', () => togglePasswordVisibility('authorizationCode', 'toggleAuthCode'));
    }

    // Mobile event listeners
    const mobileForm = document.getElementById('mobile-bouncieCredentialsForm');
    if (mobileForm) {
      mobileForm.addEventListener('submit', handleSaveCredentials);
    }

    const mobileLoadBtn = document.getElementById('mobile-loadCredentialsBtn');
    if (mobileLoadBtn) {
      mobileLoadBtn.addEventListener('click', loadCredentials);
    }

    const mobileAddDeviceBtn = document.getElementById('mobile-addDeviceBtn');
    if (mobileAddDeviceBtn) {
      mobileAddDeviceBtn.addEventListener('click', () => addDeviceInput('mobile'));
    }

    const mobileToggleSecretBtn = document.getElementById('mobile-toggleClientSecret');
    if (mobileToggleSecretBtn) {
      mobileToggleSecretBtn.addEventListener('click', () => togglePasswordVisibility('mobile-clientSecret', 'mobile-toggleClientSecret'));
    }

    const mobileToggleAuthBtn = document.getElementById('mobile-toggleAuthCode');
    if (mobileToggleAuthBtn) {
      mobileToggleAuthBtn.addEventListener('click', () => togglePasswordVisibility('mobile-authorizationCode', 'mobile-toggleAuthCode'));
    }
  }

  /**
   * Initialize mobile section toggles
   */
  function initializeMobileToggles() {
    const headers = document.querySelectorAll('.mobile-settings-section-header');
    headers.forEach(header => {
      header.addEventListener('click', function () {
        const content = this.nextElementSibling;
        const chevron = this.querySelector('.mobile-settings-section-chevron');
        
        if (content && content.classList.contains('mobile-settings-section-content')) {
          this.classList.toggle('expanded');
          content.classList.toggle('expanded');
          if (chevron) {
            chevron.style.transform = this.classList.contains('expanded') ? 'rotate(180deg)' : 'rotate(0deg)';
          }
        }
      });
    });
  }

  /**
   * Load credentials from the server
   */
  async function loadCredentials() {
    try {
      showStatus('Loading credentials...', 'info');
      
      const response = await fetch('/api/profile/bouncie-credentials');
      const data = await response.json();

      if (data.status === 'success' && data.credentials) {
        populateForm(data.credentials);
        showStatus('Credentials loaded successfully', 'success');
      } else {
        showStatus('No credentials found. Please enter your Bouncie credentials.', 'warning');
      }
    } catch (error) {
      console.error('Error loading credentials:', error);
      showStatus('Error loading credentials: ' + error.message, 'error');
    }
  }

  /**
   * Unmask all credentials (loads full unmasked values)
   */
  async function unmaskAllCredentials() {
    try {
      showStatus('Loading unmasked credentials...', 'info');
      
      const response = await fetch('/api/profile/bouncie-credentials/unmask');
      const data = await response.json();

      if (data.status === 'success' && data.credentials) {
        unmaskedCredentials = data.credentials;
        populateForm(data.credentials, false);
        showStatus('Credentials unmasked', 'success');
      } else {
        showStatus('Failed to unmask credentials', 'error');
      }
    } catch (error) {
      console.error('Error unmasking credentials:', error);
      showStatus('Error unmasking credentials: ' + error.message, 'error');
    }
  }

  /**
   * Populate form with credential data
   * @param {Object} credentials - Credential data
   * @param {boolean} masked - Whether credentials are masked
   */
  function populateForm(credentials, masked = true) {
    // Desktop form
    const clientIdInput = document.getElementById('clientId');
    const clientSecretInput = document.getElementById('clientSecret');
    const redirectUriInput = document.getElementById('redirectUri');
    const authCodeInput = document.getElementById('authorizationCode');

    if (clientIdInput) clientIdInput.value = credentials.client_id || '';
    if (clientSecretInput) clientSecretInput.value = credentials.client_secret || '';
    if (redirectUriInput) redirectUriInput.value = credentials.redirect_uri || '';
    if (authCodeInput) authCodeInput.value = credentials.authorization_code || '';

    // Mobile form
    const mobileClientIdInput = document.getElementById('mobile-clientId');
    const mobileClientSecretInput = document.getElementById('mobile-clientSecret');
    const mobileRedirectUriInput = document.getElementById('mobile-redirectUri');
    const mobileAuthCodeInput = document.getElementById('mobile-authorizationCode');

    if (mobileClientIdInput) mobileClientIdInput.value = credentials.client_id || '';
    if (mobileClientSecretInput) mobileClientSecretInput.value = credentials.client_secret || '';
    if (mobileRedirectUriInput) mobileRedirectUriInput.value = credentials.redirect_uri || '';
    if (mobileAuthCodeInput) mobileAuthCodeInput.value = credentials.authorization_code || '';

    // Handle devices
    currentDevices = credentials.authorized_devices || [];
    renderDevices();

    // Add CSS class for masked fields
    if (masked) {
      if (clientSecretInput) clientSecretInput.classList.add('credential-masked');
      if (authCodeInput) authCodeInput.classList.add('credential-masked');
      if (mobileClientSecretInput) mobileClientSecretInput.classList.add('credential-masked');
      if (mobileAuthCodeInput) mobileAuthCodeInput.classList.add('credential-masked');
    } else {
      if (clientSecretInput) clientSecretInput.classList.remove('credential-masked');
      if (authCodeInput) authCodeInput.classList.remove('credential-masked');
      if (mobileClientSecretInput) mobileClientSecretInput.classList.remove('credential-masked');
      if (mobileAuthCodeInput) mobileAuthCodeInput.classList.remove('credential-masked');
    }
  }

  /**
   * Render device input fields
   */
  function renderDevices() {
    const desktopContainer = document.getElementById('devicesList');
    const mobileContainer = document.getElementById('mobile-devicesList');

    if (desktopContainer) {
      desktopContainer.innerHTML = '';
      currentDevices.forEach((device, index) => {
        desktopContainer.appendChild(createDeviceInput(device, index));
      });

      if (currentDevices.length === 0) {
        desktopContainer.appendChild(createDeviceInput('', 0));
      }
    }

    if (mobileContainer) {
      mobileContainer.innerHTML = '';
      currentDevices.forEach((device, index) => {
        mobileContainer.appendChild(createDeviceInput(device, index, 'mobile'));
      });

      if (currentDevices.length === 0) {
        mobileContainer.appendChild(createDeviceInput('', 0, 'mobile'));
      }
    }
  }

  /**
   * Create a device input element
   * @param {string} value - Device IMEI value
   * @param {number} index - Device index
   * @param {string} prefix - Prefix for mobile/desktop
   */
  function createDeviceInput(value, index, prefix = '') {
    const container = document.createElement('div');
    container.className = 'device-list-item';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = prefix ? 'mobile-form-input' : 'form-control';
    input.placeholder = 'Enter device IMEI';
    input.value = value;
    input.dataset.index = index;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-outline-danger';
    removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
    removeBtn.onclick = () => removeDevice(index, prefix);

    container.appendChild(input);
    container.appendChild(removeBtn);

    return container;
  }

  /**
   * Add a new device input
   * @param {string} prefix - Prefix for mobile/desktop
   */
  function addDeviceInput(prefix = '') {
    currentDevices.push('');
    renderDevices();
  }

  /**
   * Remove a device input
   * @param {number} index - Index to remove
   * @param {string} prefix - Prefix for mobile/desktop
   */
  function removeDevice(index, prefix = '') {
    if (currentDevices.length > 1) {
      currentDevices.splice(index, 1);
      renderDevices();
    } else {
      showStatus('At least one device is required', 'warning');
    }
  }

  /**
   * Handle save credentials form submission
   * @param {Event} event - Form submit event
   */
  async function handleSaveCredentials(event) {
    event.preventDefault();

    const isMobile = event.target.id.includes('mobile');
    const prefix = isMobile ? 'mobile-' : '';

    // Collect form data
    const clientId = document.getElementById(prefix + 'clientId').value.trim();
    const clientSecret = document.getElementById(prefix + 'clientSecret').value.trim();
    const redirectUri = document.getElementById(prefix + 'redirectUri').value.trim();
    const authorizationCode = document.getElementById(prefix + 'authorizationCode').value.trim();

    // Collect devices
    const deviceInputs = document.querySelectorAll(`#${isMobile ? 'mobile-' : ''}devicesList input`);
    const devices = Array.from(deviceInputs)
      .map(input => input.value.trim())
      .filter(val => val.length > 0);

    // Validate
    if (!clientId || !clientSecret || !redirectUri || !authorizationCode) {
      showStatus('All credential fields are required', 'error', isMobile);
      return;
    }

    if (devices.length === 0) {
      showStatus('At least one authorized device is required', 'error', isMobile);
      return;
    }

    try {
      showStatus('Saving credentials...', 'info', isMobile);

      const response = await fetch('/api/profile/bouncie-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          authorization_code: authorizationCode,
          authorized_devices: devices,
        }),
      });

      const data = await response.json();

      if (response.ok && data.status === 'success') {
        showStatus('Credentials saved successfully!', 'success', isMobile);
        currentDevices = devices;
        
        // Reload to show masked values
        setTimeout(() => {
          loadCredentials();
        }, 1500);
      } else {
        showStatus('Error saving credentials: ' + (data.detail || data.message || 'Unknown error'), 'error', isMobile);
      }
    } catch (error) {
      console.error('Error saving credentials:', error);
      showStatus('Error saving credentials: ' + error.message, 'error', isMobile);
    }
  }

  /**
   * Toggle password visibility
   * @param {string} inputId - Input element ID
   * @param {string} buttonId - Button element ID
   */
  function togglePasswordVisibility(inputId, buttonId) {
    const input = document.getElementById(inputId);
    const button = document.getElementById(buttonId);

    if (input && button) {
      const icon = button.querySelector('i');
      if (input.type === 'password') {
        input.type = 'text';
        if (icon) icon.className = 'fas fa-eye-slash';
      } else {
        input.type = 'password';
        if (icon) icon.className = 'fas fa-eye';
      }
    }
  }

  /**
   * Show status message
   * @param {string} message - Status message
   * @param {string} type - Status type (success, error, warning, info)
   * @param {boolean} isMobile - Whether to show on mobile view
   */
  function showStatus(message, type, isMobile = false) {
    const statusId = isMobile ? 'mobile-credentialsSaveStatus' : 'credentialsSaveStatus';
    const bannerId = isMobile ? 'mobile-credentials-status-banner' : 'credentials-status-banner';
    const bannerTextId = isMobile ? 'mobile-credentials-status-text' : 'credentials-status-text';

    const statusEl = document.getElementById(statusId);
    const bannerEl = document.getElementById(bannerId);
    const bannerTextEl = document.getElementById(bannerTextId);

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `alert alert-${getBootstrapClass(type)} mt-3`;
      statusEl.style.display = 'block';

      setTimeout(() => {
        statusEl.style.display = 'none';
      }, 5000);
    }

    if (bannerEl && bannerTextEl) {
      bannerTextEl.textContent = message;
      bannerEl.className = `credentials-status ${type}`;
      bannerEl.style.display = 'block';

      if (type === 'success') {
        setTimeout(() => {
          bannerEl.style.display = 'none';
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
      success: 'success',
      error: 'danger',
      warning: 'warning',
      info: 'info',
    };
    return map[type] || 'info';
  }
})();

