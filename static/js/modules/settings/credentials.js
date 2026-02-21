import apiClient from "../core/api-client.js";

const BOUNCIE_CREDENTIALS_API = "/api/profile/bouncie-credentials";
const BOUNCIE_UNMASK_API = "/api/profile/bouncie-credentials/unmask";
const BOUNCIE_SYNC_API = "/api/profile/bouncie-credentials/sync-vehicles";

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
