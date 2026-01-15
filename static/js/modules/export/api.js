async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail?.detail || response.statusText;
    throw new Error(message);
  }
  return response.json();
}

export async function fetchCoverageAreas(signal) {
  const data = await fetchJson("/api/coverage/areas", { signal });
  return data?.areas || [];
}

export async function fetchVehicles(signal) {
  try {
    const data = await fetchJson("/api/vehicles?active_only=true", { signal });
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn("Failed to load vehicles:", error);
    return [];
  }
}

export async function createExportJob(payload, signal) {
  return fetchJson("/api/exports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function fetchExportStatus(jobId, signal) {
  return fetchJson(`/api/exports/${jobId}`, { signal });
}
