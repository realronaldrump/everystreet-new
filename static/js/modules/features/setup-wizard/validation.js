export async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function responseErrorMessage(response, data, fallback) {
  if (data && typeof data === "object") {
    const detail = data.detail || data.message || data.error;
    if (detail) {
      if (typeof detail === "string") {
        return detail;
      }
      if (typeof detail === "object") {
        return detail.message || detail.detail || JSON.stringify(detail);
      }
    }
  }
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return fallback || `Request failed (${response.status}${statusText})`;
}
