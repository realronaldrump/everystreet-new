import apiClient from "../../core/api-client.js";
import {
  fetchBouncieCredentials,
  saveBouncieCredentials,
  syncBouncieVehicles,
} from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { isAbortError } from "../../utils.js";

const DEFAULT_FETCH_CONCURRENCY = 50;

const BOUNCIE_AUTHORIZE_URL = "/api/bouncie/authorize";
const BOUNCIE_REDIRECT_URI_API = "/api/bouncie/redirect-uri";
const VEHICLES_API = "/api/vehicles?active_only=true";
const BOUNCIE_ADD_VEHICLE_API = "/api/profile/bouncie-credentials/vehicles";
const APP_SETTINGS_API = "/api/app_settings";
const FETCH_CONCURRENCY_MIN = 1;
const FETCH_CONCURRENCY_MAX = 50;

function normalizeFetchConcurrency(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < FETCH_CONCURRENCY_MIN) {
    return DEFAULT_FETCH_CONCURRENCY;
  }
  return parsed;
}

function parseFetchConcurrencyInput(value) {
  if (value === "" || value === undefined || value === null) {
    return DEFAULT_FETCH_CONCURRENCY;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function validateFetchConcurrency(value) {
  if (!Number.isFinite(value)) {
    return false;
  }
  return value >= FETCH_CONCURRENCY_MIN && value <= FETCH_CONCURRENCY_MAX;
}

export function setupCredentialsSettings({ signal } = {}) {
  setupGoogleMapsCredentials({ signal });
  setupBouncieCredentials({ signal });
  setupBouncieVehicles({ signal });
}

async function setupGoogleMapsCredentials({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;
  const form = document.getElementById("credentials-google-form");
  const saveBtn = document.getElementById("credentials-save-google-btn");
  const keyInput = document.getElementById("credentials-google-maps-api-key");

  if (!form || !saveBtn || !keyInput) {
    return;
  }

  try {
    const settings = await apiClient.get(APP_SETTINGS_API, { signal });
    keyInput.value = settings?.google_maps_api_key || "";
  } catch (error) {
    if (!isAbortError(error)) {
      notificationManager.show(
        `Failed to load Google Maps key: ${error.message}`,
        "danger"
      );
    }
  }

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      const googleKey = keyInput.value.trim();
      if (!googleKey) {
        notificationManager.show("Google Maps API key is required.", "danger");
        return;
      }

      try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        await apiClient.post(
          APP_SETTINGS_API,
          { google_maps_api_key: googleKey },
          { signal }
        );
        notificationManager.show("Google Maps API key saved.", "success");
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
        setTimeout(() => {
          saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Google Key';
          saveBtn.disabled = false;
        }, 2000);
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(error.message, "danger");
        }
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Google Key';
        saveBtn.disabled = false;
      }
    },
    eventOptions
  );
}

async function setupBouncieCredentials({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;
  const form = document.getElementById("credentials-bouncie-form");
  const saveBtn = document.getElementById("credentials-save-bouncie-btn");
  const connectBtn = document.getElementById("credentials-connect-bouncie-btn");
  const syncBtn = document.getElementById("credentials-sync-vehicles-btn");
  const toggleBtn = document.getElementById("credentials-toggle-client-secret");
  const secretInput = document.getElementById("credentials-clientSecret");
  const clientId = document.getElementById("credentials-clientId");
  const redirectUri = document.getElementById("credentials-redirectUri");
  const fetchConcurrencyInput = document.getElementById("credentials-fetchConcurrency");

  if (!form || !saveBtn) {
    return;
  }

  try {
    const creds = await fetchBouncieCredentials({ signal });
    if (clientId) {
      clientId.value = creds.client_id || "";
    }
    if (secretInput) {
      secretInput.value = creds.client_secret || "";
    }
    if (redirectUri) {
      redirectUri.value =
        creds.redirect_uri || (await getExpectedRedirectUri({ signal }));
    }
    if (fetchConcurrencyInput) {
      fetchConcurrencyInput.value = String(
        normalizeFetchConcurrency(creds.fetch_concurrency)
      );
    }
  } catch (error) {
    if (!isAbortError(error)) {
      notificationManager.show(
        `Failed to load Bouncie credentials: ${error.message}`,
        "danger"
      );
    }
  }

  if (toggleBtn && secretInput) {
    toggleBtn.addEventListener(
      "click",
      () => {
        const type =
          secretInput.getAttribute("type") === "password" ? "text" : "password";
        secretInput.setAttribute("type", type);
        toggleBtn.querySelector("i")?.classList.toggle("fa-eye");
        toggleBtn.querySelector("i")?.classList.toggle("fa-eye-slash");
      },
      eventOptions
    );
  }

  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      const fetchConcurrency = parseFetchConcurrencyInput(fetchConcurrencyInput?.value);
      if (fetchConcurrencyInput && !validateFetchConcurrency(fetchConcurrency)) {
        notificationManager.show(
          `Fetch concurrency must be between ${FETCH_CONCURRENCY_MIN} and ${FETCH_CONCURRENCY_MAX}.`,
          "danger"
        );
        return;
      }

      const redirectUriVal = redirectUri?.value?.trim() || "";
      const payload = {
        client_id: clientId?.value?.trim() || "",
        client_secret: secretInput?.value?.trim() || "",
        redirect_uri: redirectUriVal,
        fetch_concurrency: fetchConcurrency,
      };

      try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        const response = await saveBouncieCredentials(payload, { signal });
        notificationManager.show(
          response?.message || "Bouncie credentials saved",
          "success"
        );
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
        setTimeout(() => {
          saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Credentials';
          saveBtn.disabled = false;
        }, 2000);
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(error.message, "danger");
        }
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Credentials';
        saveBtn.disabled = false;
      }
    },
    eventOptions
  );

  if (connectBtn) {
    connectBtn.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        const fetchConcurrency = parseFetchConcurrencyInput(
          fetchConcurrencyInput?.value
        );
        if (fetchConcurrencyInput && !validateFetchConcurrency(fetchConcurrency)) {
          notificationManager.show(
            `Fetch concurrency must be between ${FETCH_CONCURRENCY_MIN} and ${FETCH_CONCURRENCY_MAX}.`,
            "danger"
          );
          return;
        }
        const payload = {
          client_id: clientId?.value?.trim() || "",
          client_secret: secretInput?.value?.trim() || "",
          redirect_uri: redirectUri?.value?.trim() || "",
          fetch_concurrency: fetchConcurrency,
        };
        try {
          await saveBouncieCredentials(payload, { signal });
          window.location.href = BOUNCIE_AUTHORIZE_URL;
        } catch (error) {
          if (!isAbortError(error)) {
            notificationManager.show(error.message, "danger");
          }
        }
      },
      eventOptions
    );
  }

  if (syncBtn) {
    syncBtn.addEventListener(
      "click",
      async () => {
        try {
          syncBtn.disabled = true;
          syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
          const response = await syncBouncieVehicles({ signal });
          notificationManager.show(
            response?.message || "Vehicles synced from Bouncie",
            "success"
          );
          await loadBouncieVehicles({ signal });
        } catch (error) {
          if (!isAbortError(error)) {
            notificationManager.show(error.message, "danger");
          }
        } finally {
          syncBtn.innerHTML = '<i class="fas fa-sync"></i> Sync Vehicles';
          syncBtn.disabled = false;
        }
      },
      eventOptions
    );
  }
}

function setupBouncieVehicles({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;

  const summaryEl = document.getElementById("credentials-vehicles-summary");
  const refreshBtn = document.getElementById("credentials-refresh-vehicles-btn");

  const addForm = document.getElementById("credentials-add-vehicle-form");
  const addBtn = document.getElementById("credentials-add-vehicle-btn");
  const imeiInput = document.getElementById("credentials-add-vehicle-imei");
  const nameInput = document.getElementById("credentials-add-vehicle-name");

  if (!summaryEl) {
    return;
  }

  if (refreshBtn) {
    refreshBtn.addEventListener(
      "click",
      () => loadBouncieVehicles({ signal }),
      eventOptions
    );
  }

  if (addForm) {
    addForm.addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();

        const imei = String(imeiInput?.value || "").trim();
        const customName = String(nameInput?.value || "").trim();

        if (!imei) {
          notificationManager.show("IMEI is required.", "danger");
          return;
        }

        const originalHtml = addBtn?.innerHTML;
        try {
          if (addBtn) {
            addBtn.disabled = true;
            addBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
          }

          const response = await apiClient.post(
            BOUNCIE_ADD_VEHICLE_API,
            {
              imei,
              custom_name: customName || null,
            },
            { signal }
          );

          notificationManager.show(
            response?.message || "Vehicle added successfully.",
            "success"
          );

          if (imeiInput) {
            imeiInput.value = "";
          }
          if (nameInput) {
            nameInput.value = "";
          }

          await loadBouncieVehicles({ signal });
        } catch (error) {
          if (!isAbortError(error)) {
            notificationManager.show(error.message, "danger");
          }
        } finally {
          if (addBtn) {
            addBtn.disabled = false;
            addBtn.innerHTML =
              originalHtml || '<i class="fas fa-plus"></i> Add Vehicle';
          }
        }
      },
      eventOptions
    );
  }

  loadBouncieVehicles({ signal });
}

async function getExpectedRedirectUri({ signal } = {}) {
  try {
    const data = await apiClient.get(BOUNCIE_REDIRECT_URI_API, { signal });
    if (data?.redirect_uri) {
      return data.redirect_uri;
    }
  } catch {
    // use constructing from window.location
  }
  return `${window.location.origin}/api/bouncie/callback`;
}

function describeVehicle(vehicle) {
  if (vehicle?.custom_name) {
    return vehicle.custom_name;
  }
  if (vehicle?.bouncie_nickname) {
    return vehicle.bouncie_nickname;
  }
  const parts = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Unnamed device";
}

async function loadBouncieVehicles({ signal } = {}) {
  const summaryEl = document.getElementById("credentials-vehicles-summary");
  if (!summaryEl) {
    return;
  }

  summaryEl.textContent = "Loading vehicles\u2026";

  try {
    const response = await apiClient.raw(VEHICLES_API, { signal, cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.detail || "Failed to load vehicles.");
    }

    const vehicles = await response.json();
    const list = Array.isArray(vehicles) ? vehicles : [];

    if (list.length === 0) {
      summaryEl.textContent =
        "No vehicles yet. Sync with Bouncie above to pull them in.";
      return;
    }

    const names = list.map(describeVehicle).sort((a, b) => a.localeCompare(b));
    summaryEl.textContent = `Tracking ${names.length} ${
      names.length === 1 ? "vehicle" : "vehicles"
    }: ${names.join(", ")}.`;
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    summaryEl.textContent = error.message || "Failed to load vehicles.";
  }
}
