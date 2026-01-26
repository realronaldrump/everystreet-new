import apiClient from "../core/api-client.js";

const APP_SETTINGS_API = "/api/app_settings";
const BOUNCIE_CREDENTIALS_API = "/api/profile/bouncie-credentials";
const BOUNCIE_UNMASK_API = "/api/profile/bouncie-credentials/unmask";
const BOUNCIE_SYNC_API = "/api/profile/bouncie-credentials/sync-vehicles";

export const MAPBOX_TOKEN_MIN_LENGTH = 20;

export function isValidMapboxToken(token) {
  return Boolean(token?.startsWith("pk.") && token.length >= MAPBOX_TOKEN_MIN_LENGTH);
}

export async function fetchMapboxToken({ signal } = {}) {
  const data = await apiClient.get(APP_SETTINGS_API, { signal });
  return data?.mapbox_token || "";
}

export async function saveMapboxToken(token, { signal } = {}) {
  if (!isValidMapboxToken(token)) {
    throw new Error("Mapbox token must start with 'pk.' and be valid length.");
  }
  return apiClient.post(APP_SETTINGS_API, { mapbox_token: token }, { signal });
}

export async function fetchBouncieCredentials({ signal, unmask = true } = {}) {
  const url = unmask ? BOUNCIE_UNMASK_API : BOUNCIE_CREDENTIALS_API;
  const data = await apiClient.get(url, { signal });
  return data?.credentials || data || {};
}

export async function saveBouncieCredentials(payload, { signal } = {}) {
  const clientId = payload?.client_id?.trim();
  const clientSecret = payload?.client_secret?.trim();
  const redirectUri = payload?.redirect_uri?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("All Bouncie fields are required.");
  }

  const body = {
    ...payload,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  };

  return apiClient.post(BOUNCIE_CREDENTIALS_API, body, { signal });
}

export async function syncBouncieVehicles({ signal } = {}) {
  return apiClient.post(BOUNCIE_SYNC_API, null, { signal });
}
