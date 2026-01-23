import apiClient from "../modules/core/api-client.js";
import {
  readJsonResponse,
  responseErrorMessage,
} from "../modules/features/setup/validation.js";
import notificationManager from "../modules/ui/notifications.js";

export function setupBouncieSettings() {
  const form = document.getElementById("settings-bouncie-form");
  const _saveBtn = document.getElementById("settings-saveBouncieBtn");
  const toggleBtn = document.getElementById("settings-toggleClientSecret");
  const secretInput = document.getElementById("settings-clientSecret");

  if (!form) {
    return;
  }

  loadBouncieCredentials();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveBouncieCredentials();
  });

  if (toggleBtn && secretInput) {
    toggleBtn.addEventListener("click", () => {
      const type
        = secretInput.getAttribute("type") === "password" ? "text" : "password";
      secretInput.setAttribute("type", type);
      toggleBtn.querySelector("i").classList.toggle("fa-eye");
      toggleBtn.querySelector("i").classList.toggle("fa-eye-slash");
    });
  }

  const connectBtn = document.getElementById("settings-connectBouncieBtn");
  if (connectBtn) {
    connectBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const success = await saveBouncieCredentials();
      if (success) {
        window.location.href = "/api/bouncie/authorize";
      }
    });
  }
}

async function loadBouncieCredentials() {
  try {
    const response = await apiClient.raw("/api/profile/bouncie-credentials/unmask");
    const data = await readJsonResponse(response);

    if (response.ok) {
      const creds = data.credentials || data;
      const clientId = document.getElementById("settings-clientId");
      const clientSecret = document.getElementById("settings-clientSecret");
      const redirectUri = document.getElementById("settings-redirectUri");

      if (clientId) {
        clientId.value = creds.client_id || "";
      }
      if (clientSecret) {
        clientSecret.value = creds.client_secret || "";
      }
      if (redirectUri) {
        redirectUri.value = creds.redirect_uri || "";
      }
    }
  } catch (error) {
    console.error("Failed to load Bouncie credentials", error);
  }
}

async function saveBouncieCredentials() {
  const saveBtn = document.getElementById("settings-saveBouncieBtn");
  const clientId = document.getElementById("settings-clientId")?.value.trim();
  const clientSecret = document.getElementById("settings-clientSecret")?.value.trim();
  const redirectUri = document.getElementById("settings-redirectUri")?.value.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    notificationManager.show("All Bouncie fields are required", "warning");
    return false;
  }

  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  };

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    const response = await apiClient.raw("/api/profile/bouncie-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(
        responseErrorMessage(response, data, "Failed to save credentials")
      );
    }

    notificationManager.show("Bouncie credentials saved", "success");
    if (saveBtn) {
      saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
      setTimeout(() => {
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Credentials';
        saveBtn.disabled = false;
      }, 2000);
    }
    return true;
  } catch (error) {
    notificationManager.show(error.message, "danger");
    if (saveBtn) {
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Credentials';
      saveBtn.disabled = false;
    }
    return false;
  }
}
