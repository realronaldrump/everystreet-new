import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Watchtower replies after the pull/restart, not when the request is accepted.
export async function triggerDeployment({
  url,
  token,
  image,
  fetchImpl = globalThis.fetch,
  sleep = delay,
  log = console.log,
  timeoutMs = 180_000,
  attempts = 3,
}) {
  if (!url || !token || !image) {
    throw new Error("WATCHTOWER_URL, WATCHTOWER_TOKEN and WATCHTOWER_IMAGE are required.");
  }
  let endpoint;
  try {
    endpoint = new URL(`${url.replace(/\/+$/, "")}/v1/update`);
  } catch {
    throw new Error("WATCHTOWER_URL must be a valid HTTPS URL.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("WATCHTOWER_URL must use HTTPS without embedded credentials.");
  }
  endpoint.searchParams.set("image", image);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let failure;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Do not print proxy response bodies, URLs, or raw network errors: they
      // can contain credentials. The HTTP status is sufficient for diagnosis.
      await response.body?.cancel();
      if (response.status === 200) {
        log("Watchtower update request completed. Verify the running revision separately.");
        return true;
      }
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new Error(`Watchtower rejected the deployment request (HTTP ${response.status}).`);
      }
      failure = `HTTP ${response.status}`;
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        log("::warning::Watchtower request timed out after three minutes. The update may still be running; automatic polling checks every minute.");
        return false;
      }
      if (error.message.startsWith("Watchtower rejected")) {
        throw error;
      }
      failure = "network error";
    }
    if (attempt < attempts) {
      log(`::notice::Watchtower request failed (${failure}); retrying (${attempt}/${attempts}).`);
      await sleep(attempt * 5_000);
    } else {
      log(`::warning::Immediate deployment request failed (${failure}) after ${attempts} attempts. Automatic polling checks every minute.`);
    }
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  triggerDeployment({
    url: process.env.WATCHTOWER_URL,
    token: process.env.WATCHTOWER_TOKEN,
    image: process.env.WATCHTOWER_IMAGE,
  }).catch((error) => {
    // Only controlled configuration/status messages are emitted.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
