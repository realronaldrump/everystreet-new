import apiClient from "../modules/core/api-client.js";
import notificationManager from "../modules/ui/notifications.js";
import {
  fetchBouncieCredentials,
  fetchMapboxToken,
  isValidMapboxToken,
  saveBouncieCredentials,
  saveMapboxToken,
  syncBouncieVehicles,
} from "../modules/settings/credentials.js";

const BOUNCIE_AUTHORIZE_URL = "/api/bouncie/authorize";
const BOUNCIE_REDIRECT_URI_API = "/api/bouncie/redirect-uri";

export function setupCredentialsSettings({ signal } = {}) {
  setupMapboxCredentials({ signal });
  setupBouncieCredentials({ signal });
}

async function setupMapboxCredentials({ signal } = {}) {
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
    notificationManager.show(`Failed to load Mapbox token: ${error.message}`, "danger");
  }

  tokenInput.addEventListener("input", () => {
    const nextValue = tokenInput.value.trim();
    saveBtn.disabled = !isValidMapboxToken(nextValue);
  });

  saveBtn.addEventListener("click", async () => {
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
      notificationManager.show(error.message, "danger");
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Token';
      saveBtn.disabled = !isValidMapboxToken(tokenInput.value.trim());
    }
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const type = tokenInput.getAttribute("type") === "password" ? "text" : "password";
      tokenInput.setAttribute("type", type);
      toggleBtn.querySelector("i")?.classList.toggle("fa-eye");
      toggleBtn.querySelector("i")?.classList.toggle("fa-eye-slash");
    });
  }
}

async function setupBouncieCredentials({ signal } = {}) {
  const form = document.getElementById("credentials-bouncie-form");
  const saveBtn = document.getElementById("credentials-save-bouncie-btn");
  const connectBtn = document.getElementById("credentials-connect-bouncie-btn");
  const syncBtn = document.getElementById("credentials-sync-vehicles-btn");
  const toggleBtn = document.getElementById("credentials-toggle-client-secret");
  const secretInput = document.getElementById("credentials-clientSecret");
  const clientId = document.getElementById("credentials-clientId");
  const redirectUri = document.getElementById("credentials-redirectUri");

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
      redirectUri.value = creds.redirect_uri || (await getExpectedRedirectUri({ signal }));
    }
  } catch (error) {
    notificationManager.show(`Failed to load Bouncie credentials: ${error.message}`, "danger");
  }

  if (toggleBtn && secretInput) {
    toggleBtn.addEventListener("click", () => {
      const type = secretInput.getAttribute("type") === "password" ? "text" : "password";
      secretInput.setAttribute("type", type);
      toggleBtn.querySelector("i")?.classList.toggle("fa-eye");
      toggleBtn.querySelector("i")?.classList.toggle("fa-eye-slash");
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      client_id: clientId?.value?.trim() || "",
      client_secret: secretInput?.value?.trim() || "",
      redirect_uri: redirectUri?.value?.trim() || "",
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
      notificationManager.show(error.message, "danger");
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Credentials';
      saveBtn.disabled = false;
    }
  });

  if (connectBtn) {
    connectBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const payload = {
        client_id: clientId?.value?.trim() || "",
        client_secret: secretInput?.value?.trim() || "",
        redirect_uri: redirectUri?.value?.trim() || "",
      };
      try {
        await saveBouncieCredentials(payload, { signal });
        window.location.href = BOUNCIE_AUTHORIZE_URL;
      } catch (error) {
        notificationManager.show(error.message, "danger");
      }
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      try {
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
        const response = await syncBouncieVehicles({ signal });
        notificationManager.show(
          response?.message || "Vehicles synced from Bouncie",
          "success"
        );
      } catch (error) {
        notificationManager.show(error.message, "danger");
      } finally {
        syncBtn.innerHTML = '<i class="fas fa-sync"></i> Sync Vehicles';
        syncBtn.disabled = false;
      }
    });
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
