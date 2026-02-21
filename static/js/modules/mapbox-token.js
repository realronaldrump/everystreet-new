const HARD_CODED_MAPBOX_TOKEN =
  "pk.eyJ1IjoicmVhbHJvbmFsZHJ1bXAiLCJhIjoiY204eXBvMzRhMDNubTJrb2NoaDIzN2dodyJ9.3Hnv3_ps0T7YS8cwSE3XKA";

const readConfiguredToken = () => HARD_CODED_MAPBOX_TOKEN;

export const getMapboxToken = () => readConfiguredToken();

export const isMapboxStyleUrl = (styleUrl) => {
  if (!styleUrl || typeof styleUrl !== "string") {
    return false;
  }
  const url = styleUrl.trim();
  return url.startsWith("mapbox://") || url.includes("api.mapbox.com");
};

export const waitForMapboxToken = async ({ timeoutMs = 2000 } = {}) => {
  const existing = getMapboxToken();
  if (existing) {
    return existing;
  }
  const timeoutValue = Number(timeoutMs);
  if (Number.isFinite(timeoutValue) && timeoutValue > 0) {
    await Promise.resolve();
  }
  throw new Error("Mapbox access token not configured");
};
