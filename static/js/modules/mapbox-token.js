const TOKEN_EVENT = "es:mapbox-token-ready";

const readMetaToken = () => {
  if (typeof document === "undefined") {
    return "";
  }
  const meta = document.querySelector('meta[name="mapbox-access-token"]');
  return meta?.getAttribute("content")?.trim() || "";
};

export const getMapboxToken = () => {
  const token = typeof window !== "undefined" ? window.MAPBOX_ACCESS_TOKEN : "";
  return (token || readMetaToken() || "").trim();
};

export const waitForMapboxToken = async ({ timeoutMs = 2000 } = {}) => {
  const existing = getMapboxToken();
  if (existing) {
    return existing;
  }

  if (typeof document === "undefined") {
    throw new Error("Mapbox access token not configured");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      document.removeEventListener(TOKEN_EVENT, handler);
    };

    const handler = (event) => {
      const token = event?.detail?.token || getMapboxToken();
      if (token) {
        cleanup();
        resolve(token);
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Mapbox access token not configured"));
    }, timeoutMs);

    document.addEventListener(TOKEN_EVENT, handler);
  });
};

export const MAPBOX_TOKEN_EVENT = TOKEN_EVENT;
