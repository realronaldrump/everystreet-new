import apiClient from "../../../core/api-client.js";

export function buildRemapJobPayload({
  start_date,
  end_date,
  interval_days = null,
  unmatched_only = false,
  rematch = true,
} = {}) {
  return {
    mode: "date_range",
    start_date,
    end_date,
    interval_days,
    unmatched_only,
    rematch,
  };
}

export async function queueRemapJob(payload) {
  const response = await apiClient.raw("/api/map_matching/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRemapJobPayload(payload)),
  });
  if (!response.ok) {
    throw new Error("Failed to queue rematch job");
  }
  await response.json();
}
