import apiClient from "../core/api-client.js";

const BOUNCIE_CREDENTIALS_API = "/api/profile/bouncie-credentials";
const BOUNCIE_UNMASK_API = "/api/profile/bouncie-credentials/unmask";
const BOUNCIE_SYNC_API = "/api/profile/bouncie-credentials/sync-vehicles";

function getBouncieRedirectUriValidationError(redirectUri) {
  const uri = String(redirectUri || "")
    .trim()
    .toLowerCase();
  if (!uri.includes("localhost")) {
    return null;
  }
  if (uri.startsWith("https://")) {
    return "Localhost redirect URIs are not supported for this deployment. Use the prefilled public callback URL.";
  }
  if (uri.includes("www.localhost")) {
    return "www.localhost redirect URIs are not supported. Use the prefilled public callback URL.";
  }
  return null;
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

  const redirectUriError = getBouncieRedirectUriValidationError(redirectUri);
  if (redirectUriError) {
    throw new Error(redirectUriError);
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
