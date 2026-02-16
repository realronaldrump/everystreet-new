import apiClient from "../../core/api-client.js";
import {
  disconnectGooglePhotos,
  fetchBouncieCredentials,
  fetchGooglePhotosCredentials,
  fetchGooglePhotosStatus,
  fetchMapboxToken,
  isValidMapboxToken,
  saveBouncieCredentials,
  saveGooglePhotosCredentials,
  saveMapboxToken,
  syncBouncieVehicles,
} from "../../settings/credentials.js";
import notificationManager from "../../ui/notifications.js";
import { formatDateTime } from "../../utils.js";
import { DEFAULT_FETCH_CONCURRENCY } from "../profile/state.js";

const BOUNCIE_AUTHORIZE_URL = "/api/bouncie/authorize";
const BOUNCIE_REDIRECT_URI_API = "/api/bouncie/redirect-uri";
const VEHICLES_API = "/api/vehicles?active_only=false";
const BOUNCIE_ADD_VEHICLE_API = "/api/profile/bouncie-credentials/vehicles";
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
  setupGooglePhotosCredentials({ signal });
  setupBouncieVehicles({ signal });
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
        const type =
          tokenInput.getAttribute("type") === "password" ? "text" : "password";
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

async function setupGooglePhotosCredentials({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;
  const clientIdInput = document.getElementById("google-photos-client-id-input");
  const clientSecretInput = document.getElementById(
    "google-photos-client-secret-input"
  );
  const redirectUriInput = document.getElementById(
    "google-photos-redirect-uri-input"
  );
  const exportToggle = document.getElementById("google-photos-export-toggle");
  const saveBtn = document.getElementById("google-photos-save-btn");
  const connectBtn = document.getElementById("google-photos-connect-btn");
  const disconnectBtn = document.getElementById("google-photos-disconnect-btn");
  const statusEl = document.getElementById("google-photos-status");

  if (
    !clientIdInput ||
    !clientSecretInput ||
    !redirectUriInput ||
    !saveBtn ||
    !connectBtn
  ) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const connectedFlag = params.get("google_photos_connected");
  const errorFlag = params.get("google_photos_error");
  if (connectedFlag) {
    notificationManager.show("Google Photos connected successfully.", "success");
    params.delete("google_photos_connected");
  }
  if (errorFlag) {
    notificationManager.show(`Google Photos error: ${errorFlag}`, "danger");
    params.delete("google_photos_error");
  }
  if (connectedFlag || errorFlag) {
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState({}, "", url.toString());
  }

  const setStatus = (message, tone = "muted") => {
    if (!statusEl) {
      return;
    }
    statusEl.className = `form-text text-${tone}`;
    statusEl.textContent = message;
  };

  const readPayload = () => ({
    client_id: clientIdInput.value,
    client_secret: clientSecretInput.value,
    redirect_uri: redirectUriInput.value,
    postcard_export_enabled: Boolean(exportToggle?.checked),
  });

  const refreshStatus = async () => {
    try {
      const status = await fetchGooglePhotosStatus({ signal });
      if (status.connected) {
        if (connectBtn) {
          connectBtn.innerHTML = '<i class="fas fa-sync"></i> Reconnect / Upgrade Scopes';
        }
        if (status.picker_ready === false) {
          setStatus(
            "Connected, but picker permission is missing. Reconnect once to restore Smart Import.",
            "warning"
          );
        } else {
          setStatus(
            "Connected. Smart Import should stay hands-off without reconnecting per trip.",
            "success"
          );
        }
      } else if (status.last_auth_error) {
        if (connectBtn) {
          connectBtn.innerHTML = '<i class="fas fa-plug"></i> Connect Google Photos';
        }
        setStatus(
          `Not connected. ${status.last_auth_error_detail || status.last_auth_error}.`,
          "warning"
        );
      } else {
        if (connectBtn) {
          connectBtn.innerHTML = '<i class="fas fa-plug"></i> Connect Google Photos';
        }
        setStatus("Not connected yet. Save credentials, then connect.", "muted");
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setStatus("Unable to load Google Photos status.", "danger");
      }
    }
  };

  try {
    const creds = await fetchGooglePhotosCredentials({ signal });
    clientIdInput.value = creds.client_id || "";
    clientSecretInput.value = creds.client_secret || "";
    redirectUriInput.value =
      creds.redirect_uri || `${window.location.origin}/api/google-photos/callback`;
    if (exportToggle) {
      exportToggle.checked = Boolean(creds.postcard_export_enabled);
    }
  } catch (error) {
    if (!isAbortError(error)) {
      notificationManager.show(
        `Failed to load Google Photos credentials: ${error.message}`,
        "danger"
      );
    }
  }

  await refreshStatus();

  saveBtn.addEventListener(
    "click",
    async () => {
      const originalHtml = saveBtn.innerHTML;
      try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        const response = await saveGooglePhotosCredentials(readPayload(), { signal });
        notificationManager.show(
          response?.message || "Google Photos credentials saved.",
          "success"
        );
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
        await refreshStatus();
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(error.message, "danger");
        }
      } finally {
        setTimeout(() => {
          saveBtn.innerHTML = originalHtml;
          saveBtn.disabled = false;
        }, 800);
      }
    },
    eventOptions
  );

  connectBtn.addEventListener(
    "click",
    async (event) => {
      event.preventDefault();
      try {
        await saveGooglePhotosCredentials(readPayload(), { signal });
      } catch (error) {
        if (!isAbortError(error)) {
          notificationManager.show(error.message, "danger");
        }
        return;
      }
      const mode = exportToggle?.checked ? "postcard_export" : "picker";
      window.location.href = `/api/google-photos/authorize?mode=${encodeURIComponent(mode)}`;
    },
    eventOptions
  );

  if (disconnectBtn) {
    disconnectBtn.addEventListener(
      "click",
      async () => {
        const purgeData = window.confirm(
          "Also remove all Memory Atlas moments and postcards from this app?"
        );
        try {
          const response = await disconnectGooglePhotos({ signal, purgeData });
          notificationManager.show(
            response?.message || "Google Photos disconnected.",
            "success"
          );
          await refreshStatus();
        } catch (error) {
          if (!isAbortError(error)) {
            notificationManager.show(error.message, "danger");
          }
        }
      },
      eventOptions
    );
  }
}

function setupBouncieVehicles({ signal } = {}) {
  const eventOptions = signal ? { signal } : false;

  const loadingEl = document.getElementById("credentials-vehicles-loading");
  const emptyEl = document.getElementById("credentials-vehicles-empty");
  const tableWrapper = document.getElementById("credentials-vehicles-table-wrapper");
  const tbody = document.getElementById("credentials-vehicles-tbody");
  const refreshBtn = document.getElementById("credentials-refresh-vehicles-btn");

  const addForm = document.getElementById("credentials-add-vehicle-form");
  const addBtn = document.getElementById("credentials-add-vehicle-btn");
  const imeiInput = document.getElementById("credentials-add-vehicle-imei");
  const nameInput = document.getElementById("credentials-add-vehicle-name");

  if (!loadingEl || !emptyEl || !tableWrapper || !tbody) {
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
    // Fall back to constructing from window.location
  }
  return `${window.location.origin}/api/bouncie/callback`;
}

async function loadBouncieVehicles({ signal } = {}) {
  const loadingEl = document.getElementById("credentials-vehicles-loading");
  const emptyEl = document.getElementById("credentials-vehicles-empty");
  const tableWrapper = document.getElementById("credentials-vehicles-table-wrapper");
  const tbody = document.getElementById("credentials-vehicles-tbody");

  if (!loadingEl || !emptyEl || !tableWrapper || !tbody) {
    return;
  }

  loadingEl.style.display = "";
  emptyEl.style.display = "none";
  tableWrapper.style.display = "none";
  tbody.innerHTML = "";

  try {
    const response = await apiClient.raw(VEHICLES_API, { signal, cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.detail || "Failed to load vehicles.");
    }

    const vehicles = await response.json();
    const list = Array.isArray(vehicles) ? vehicles : [];

    loadingEl.style.display = "none";

    if (list.length === 0) {
      emptyEl.style.display = "";
      tableWrapper.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";
    tableWrapper.style.display = "";

    const getVehicleName = (vehicle) => {
      if (vehicle?.custom_name) {
        return vehicle.custom_name;
      }
      const parts = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
      return parts.length > 0
        ? parts.join(" ")
        : `Vehicle ${vehicle?.imei || ""}`.trim();
    };

    const getVehicleSubtitle = (vehicle) => {
      if (!vehicle) {
        return "";
      }
      if (vehicle.custom_name) {
        const parts = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
        return parts.length > 0 ? parts.join(" ") : "";
      }
      return vehicle?.vin ? String(vehicle.vin) : "";
    };

    list
      .slice()
      .sort((a, b) => getVehicleName(a).localeCompare(getVehicleName(b)))
      .forEach((vehicle) => {
        const row = document.createElement("tr");

        const nameCell = document.createElement("td");
        const title = document.createElement("div");
        title.className = "fw-semibold";
        title.textContent = getVehicleName(vehicle);
        nameCell.appendChild(title);

        const subtitleText = getVehicleSubtitle(vehicle);
        if (subtitleText) {
          const subtitle = document.createElement("div");
          subtitle.className = "text-muted small";
          subtitle.textContent = subtitleText;
          nameCell.appendChild(subtitle);
        }

        const imeiCell = document.createElement("td");
        const imeiCode = document.createElement("code");
        imeiCode.textContent = vehicle?.imei || "--";
        imeiCell.appendChild(imeiCode);

        const vinCell = document.createElement("td");
        vinCell.textContent = vehicle?.vin || "--";

        const syncedCell = document.createElement("td");
        const stamp = vehicle?.last_synced_at || vehicle?.updated_at || null;
        syncedCell.textContent = stamp ? formatDateTime(stamp) : "--";

        row.appendChild(nameCell);
        row.appendChild(imeiCell);
        row.appendChild(vinCell);
        row.appendChild(syncedCell);
        tbody.appendChild(row);
      });
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    loadingEl.style.display = "none";
    emptyEl.textContent = error.message || "Failed to load vehicles.";
    emptyEl.style.display = "";
    tableWrapper.style.display = "none";
  }
}
