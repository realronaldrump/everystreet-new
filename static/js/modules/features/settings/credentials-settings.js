import apiClient from "../../core/api-client.js";
import {
  fetchBouncieCredentials,
  fetchMapboxToken,
  isValidMapboxToken,
  saveBouncieCredentials,
  saveMapboxToken,
  syncBouncieVehicles,
} from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { DEFAULT_FETCH_CONCURRENCY } from "../profile/state.js";

const BOUNCIE_AUTHORIZE_URL = "/api/bouncie/authorize";
const BOUNCIE_REDIRECT_URI_API = "/api/bouncie/redirect-uri";
const FETCH_CONCURRENCY_MIN = 1;
const FETCH_CONCURRENCY_MAX = 50;
const isAbortError = (error) => error?.name === "AbortError";

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
  setupMapboxCredentials({ signal });
  setupBouncieCredentials({ signal });
}

async function setupMapboxCredentials({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;
  const tokenInput = document.getElementById("mapbox-token-input");
  const saveBtn = document.getElementById("save-mapbox-token-btn");
  const toggleBtn = document.getElementById("toggle-mapbox-token");

  if (!tokenInput || !saveBtn) {
    return;
  }

  try {
    const token = await fetchMapboxToken({ signal });
    tokenInput.value = token;
    saveBtn.disabled = true;
  } catch (error) {
    if (!isAbortError(error)) {
      notificationManager.show(
        `Failed to load Mapbox token: ${error.message}`,
        "danger"
      );
    }
  }

  tokenInput.addEventListener(
    "input",
    () => {
      const nextValue = tokenInput.value.trim();
      saveBtn.disabled = !isValidMapboxToken(nextValue);
    },
    eventOptions
  );

  saveBtn.addEventListener(
    "click",
    async () => {
      const token = tokenInput.value.trim();
      try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        await saveMapboxToken(token, { signal });
        notificationManager.show("Mapbox token saved successfully", "success");
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
        setTimeout(() => {
          saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Token';
          saveBtn.disabled = !isValidMapboxToken(tokenInput.value.trim());
        }, 2000);
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(error.message, "danger");
        }
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Token';
        saveBtn.disabled = !isValidMapboxToken(tokenInput.value.trim());
      }
    },
    eventOptions
  );

  if (toggleBtn) {
    toggleBtn.addEventListener(
      "click",
      () => {
        const type
          = tokenInput.getAttribute("type") === "password" ? "text" : "password";
        tokenInput.setAttribute("type", type);
        toggleBtn.querySelector("i")?.classList.toggle("fa-eye");
        toggleBtn.querySelector("i")?.classList.toggle("fa-eye-slash");
      },
      eventOptions
    );
  }
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
      redirectUri.value
        = creds.redirect_uri || (await getExpectedRedirectUri({ signal }));
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
        const type
          = secretInput.getAttribute("type") === "password" ? "text" : "password";
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
      const payload = {
        client_id: clientId?.value?.trim() || "",
        client_secret: secretInput?.value?.trim() || "",
        redirect_uri: redirectUri?.value?.trim() || "",
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

async function getExpectedRedirectUri({ signal } = {}) {
  try {
    const data = await apiClient.get(BOUNCIE_REDIRECT_URI_API, { signal });
    if (data?.redirect_uri) {
      return data.redirect_uri;
    }
  } catch (_error) {
    // Fall back to constructing from window.location
  }
  return `${window.location.origin}/api/bouncie/callback`;
}
