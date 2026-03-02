import apiClient from "../../core/api-client.js";
import { CONFIG } from "../../core/config.js";

const MAX_LIMIT = 2000;

function normalizeLimit(limit) {
  if (!Number.isFinite(Number(limit))) {
    return 500;
  }
  const parsed = Math.floor(Number(limit));
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function appendIfPresent(params, key, value) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  params.set(key, String(value));
}

export function fetchJourneyFeed({
  startDate,
  endDate,
  vehicle,
  cursor,
  limit = 500,
  signal,
} = {}) {
  const params = new URLSearchParams();
  appendIfPresent(params, "start_date", startDate);
  appendIfPresent(params, "end_date", endDate);
  appendIfPresent(params, "vehicle", vehicle);
  appendIfPresent(params, "cursor", cursor);
  params.set("limit", String(normalizeLimit(limit)));

  const query = params.toString();
  const url = `${CONFIG.API.journeyFeed}${query ? `?${query}` : ""}`;
  return apiClient.get(url, { signal, retry: false });
}
