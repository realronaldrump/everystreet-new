import apiClient from "../core/api-client.js";
import { MAPBOX_PUBLIC_ACCESS_TOKEN } from "../core/config.js";

const BOUNCIE_CREDENTIALS_API = "/api/profile/bouncie-credentials";
const BOUNCIE_UNMASK_API = "/api/profile/bouncie-credentials/unmask";
const BOUNCIE_SYNC_API = "/api/profile/bouncie-credentials/sync-vehicles";
const GOOGLE_PHOTOS_CREDENTIALS_API = "/api/google-photos/credentials";
const GOOGLE_PHOTOS_STATUS_API = "/api/google-photos/status";
const GOOGLE_PHOTOS_DISCONNECT_API = "/api/google-photos/disconnect";

export const MAPBOX_TOKEN_MIN_LENGTH = 20;

export function isValidMapboxToken(token) {
  return String(token || "").trim() === MAPBOX_PUBLIC_ACCESS_TOKEN;
}

export async function fetchMapboxToken({ signal } = {}) {
  if (signal?.aborted) {
    throw new DOMException("signal is aborted without reason", "AbortError");
  }
  return MAPBOX_PUBLIC_ACCESS_TOKEN;
}

export async function saveMapboxToken(token, { signal } = {}) {
  if (signal?.aborted) {
    throw new DOMException("signal is aborted without reason", "AbortError");
  }
  if (!isValidMapboxToken(token)) {
    throw new Error("Mapbox token is hard-coded and cannot be changed.");
  }
  return { mapbox_token: MAPBOX_PUBLIC_ACCESS_TOKEN, immutable: true };
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

  const data = await apiClient.post(BOUNCIE_CREDENTIALS_API, body, { signal });
  return data;
}

export async function syncBouncieVehicles({ signal } = {}) {
  const data = await apiClient.post(BOUNCIE_SYNC_API, null, { signal });
  return data;
}

export async function fetchGooglePhotosCredentials({ signal } = {}) {
  const data = await apiClient.get(GOOGLE_PHOTOS_CREDENTIALS_API, { signal });
  return data?.credentials || data || {};
}

export async function fetchGooglePhotosStatus({ signal } = {}) {
  const data = await apiClient.get(GOOGLE_PHOTOS_STATUS_API, { signal });
  return data || {};
}

export async function saveGooglePhotosCredentials(payload, { signal } = {}) {
  const body = {
    client_id: payload?.client_id?.trim() || "",
    client_secret: payload?.client_secret?.trim() || "",
    redirect_uri: payload?.redirect_uri?.trim() || "",
    postcard_export_enabled: Boolean(payload?.postcard_export_enabled),
  };
  if (!body.client_id || !body.client_secret || !body.redirect_uri) {
    throw new Error("Google Photos client credentials are required.");
  }
  return apiClient.post(GOOGLE_PHOTOS_CREDENTIALS_API, body, { signal });
}

export async function disconnectGooglePhotos({ signal, purgeData = false } = {}) {
  const suffix = purgeData ? "?purge_data=true" : "";
  return apiClient.delete(`${GOOGLE_PHOTOS_DISCONNECT_API}${suffix}`, { signal });
}
