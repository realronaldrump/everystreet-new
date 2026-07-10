import apiClient from "../../core/api-client.js";
import { fetchBouncieCredentials, saveBouncieCredentials } from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { isAbortError } from "../../utils.js";

const APP_SETTINGS_API = "/api/app_settings";
const BOUNCIE_AUTHORIZE_URL = "/api/bouncie/authorize";
const BOUNCIE_REDIRECT_URI_API = "/api/bouncie/redirect-uri";
const BOUNCIE_STATUS_API = "/api/bouncie/status";
const VEHICLES_API = "/api/vehicles?active_only=false";

async function setupGoogleMapsCredentials(signal) {
  const form = document.getElementById("credentials-google-form");
  const input = document.getElementById("credentials-google-maps-api-key");
  const button = document.getElementById("credentials-save-google-btn");
  if (!form || !input || !button) return;

  try {
    const settings = await apiClient.get(APP_SETTINGS_API, { signal });
    input.value = settings?.google_maps_api_key || "";
  } catch (error) {
    if (!isAbortError(error)) {
      notificationManager.show("Couldn’t load the Google Maps connection.", "danger");
    }
  }

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      try {
        button.disabled = true;
        button.textContent = "Saving…";
        await apiClient.post(
          APP_SETTINGS_API,
          { google_maps_api_key: input.value.trim() || null },
          { signal }
        );
        button.textContent = "Saved";
      } catch (error) {
        if (!isAbortError(error)) notificationManager.show(error.message, "danger");
        button.textContent = "Save key";
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = "Save key";
        }, 1200);
      }
    },
    signal ? { signal } : undefined
  );
}

async function setupBouncieConnection(signal) {
  const form = document.getElementById("credentials-bouncie-form");
  const clientId = document.getElementById("credentials-clientId");
  const clientSecret = document.getElementById("credentials-clientSecret");
  const redirectUri = document.getElementById("credentials-redirectUri");
  const callback = document.getElementById("bouncie-callback-url");
  const statusBadge = document.getElementById("bouncie-connection-state");
  const connectButton = document.getElementById("credentials-connect-bouncie-btn");
  const secretToggle = document.getElementById("credentials-toggle-client-secret");
  if (!form || !clientId || !clientSecret || !redirectUri || !connectButton) return;

  try {
    const [credentials, redirect, status] = await Promise.all([
      fetchBouncieCredentials({ signal }),
      apiClient.get(BOUNCIE_REDIRECT_URI_API, { signal }),
      apiClient.get(BOUNCIE_STATUS_API, { signal }),
    ]);
    clientId.value = credentials.client_id || "";
    clientSecret.value = credentials.client_secret || "";
    redirectUri.value = redirect.redirect_uri || `${window.location.origin}/api/bouncie/callback`;
    if (callback) callback.textContent = redirectUri.value;
    if (statusBadge) {
      statusBadge.dataset.state = status.connected ? "connected" : "required";
      statusBadge.textContent = status.connected ? "Connected" : "Connection required";
    }
    connectButton.innerHTML = status.connected
      ? '<i class="fas fa-rotate" aria-hidden="true"></i> Reconnect Bouncie'
      : '<i class="fas fa-link" aria-hidden="true"></i> Connect Bouncie';
  } catch (error) {
    if (!isAbortError(error) && statusBadge) {
      statusBadge.dataset.state = "required";
      statusBadge.textContent = "Connection unavailable";
    }
  }

  secretToggle?.addEventListener(
    "click",
    () => {
      const visible = clientSecret.type === "text";
      clientSecret.type = visible ? "password" : "text";
      secretToggle.querySelector("i")?.classList.toggle("fa-eye", visible);
      secretToggle.querySelector("i")?.classList.toggle("fa-eye-slash", !visible);
    },
    signal ? { signal } : undefined
  );

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      try {
        connectButton.disabled = true;
        connectButton.textContent = "Connecting…";
        await saveBouncieCredentials(
          {
            client_id: clientId.value,
            client_secret: clientSecret.value,
            redirect_uri: redirectUri.value,
          },
          { signal }
        );
        window.location.href = BOUNCIE_AUTHORIZE_URL;
      } catch (error) {
        connectButton.disabled = false;
        connectButton.textContent = "Connect Bouncie";
        if (!isAbortError(error)) notificationManager.show(error.message, "danger");
      }
    },
    signal ? { signal } : undefined
  );
}

function vehicleName(vehicle) {
  if (vehicle?.custom_name) return vehicle.custom_name;
  const description = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
  return description.join(" ") || `Vehicle ${vehicle?.imei || ""}`.trim();
}

async function loadVehicles(signal) {
  const container = document.getElementById("connected-vehicles");
  if (!container) return;
  try {
    const vehicles = await apiClient.get(VEHICLES_API, { signal, cache: "no-store" });
    const list = Array.isArray(vehicles) ? vehicles : [];
    if (!list.length) {
      container.innerHTML =
        '<span class="text-muted">Vehicles will appear here after Bouncie authorization.</span>';
      return;
    }
    container.innerHTML = "";
    list.sort((a, b) => vehicleName(a).localeCompare(vehicleName(b))).forEach((vehicle) => {
      const row = document.createElement("div");
      row.className = "connected-vehicle";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = vehicleName(vehicle);
      const imei = document.createElement("small");
      imei.textContent = vehicle.imei ? `IMEI ${vehicle.imei}` : "Provider-managed";
      copy.append(name, imei);
      const state = document.createElement("span");
      state.className = vehicle.is_active === false ? "text-muted" : "text-success";
      state.textContent = vehicle.is_active === false ? "Excluded" : "Active";
      row.append(copy, state);
      container.appendChild(row);
    });
  } catch (error) {
    if (!isAbortError(error)) {
      container.innerHTML = '<span class="text-muted">Vehicle status is temporarily unavailable.</span>';
    }
  }
}

export function setupCredentialsSettings({ signal } = {}) {
  setupGoogleMapsCredentials(signal);
  setupBouncieConnection(signal);
  loadVehicles(signal);
}
