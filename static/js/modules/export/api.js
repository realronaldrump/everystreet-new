import apiClient from "../core/api-client.js";

export async function fetchCoverageAreas(signal) {
  const data = await apiClient.get("/api/coverage/areas", { signal });
  return data?.areas || [];
}

export async function fetchVehicles(signal) {
  try {
    const data = await apiClient.get("/api/vehicles?active_only=true", { signal });
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn("Failed to load vehicles:", error);
    return [];
  }
}

export function createExportJob(payload, signal) {
  return apiClient.post("/api/exports", payload, { signal });
}

export function fetchExportStatus(jobId, signal) {
  return apiClient.get(`/api/exports/${jobId}`, { signal });
}
