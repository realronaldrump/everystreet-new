import { MAPBOX_PUBLIC_ACCESS_TOKEN } from "./core/config.js";

const readConfiguredToken = () => String(MAPBOX_PUBLIC_ACCESS_TOKEN || "").trim();

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
