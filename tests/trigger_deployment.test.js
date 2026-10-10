import assert from "node:assert/strict";
import test from "node:test";

import { triggerDeployment } from "../scripts/trigger-deployment.mjs";

function harness(statuses) {
  const requests = [];
  const waits = [];
  const logs = [];
  const options = {
    url: "https://deploy.example.test/watchtower/",
    token: "synthetic-token",
    image: "ghcr.io/example/app",
    log: (message) => logs.push(message),
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const status = statuses.shift();
      if (status instanceof Error) throw status;
      return { status };
    },
  };
  return { options, requests, waits, logs };
}

test("deployment request retries a gateway error and targets only the app image", async () => {
  const h = harness([502, 200]);
  assert.equal(await triggerDeployment(h.options), true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url.pathname, "/watchtower/v1/update");
  assert.equal(h.requests[0].url.searchParams.get("image"), "ghcr.io/example/app");
  assert.equal(h.requests[0].init.headers.Authorization, "Bearer synthetic-token");
  assert.equal(h.requests[0].init.redirect, "error");
  assert.deepEqual(h.waits, [5_000]);
});

test("authentication failures are reported without retries", async () => {
  const h = harness([401]);
  await assert.rejects(triggerDeployment(h.options), /HTTP 401/);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.waits, []);
});

test("transient failures stop after bounded retries without exposing response data", async () => {
  const secretError = new TypeError("https://deploy.example.test/synthetic-token");
  const h = harness([secretError, 503, 502]);
  assert.equal(await triggerDeployment(h.options), false);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.waits, [5_000, 10_000]);
  assert.match(h.logs.at(-1), /polling checks every minute/);
  assert.ok(h.logs.every((line) => !line.includes("synthetic-token")));
  assert.ok(h.logs.every((line) => !line.includes("deploy.example.test")));
});

test("a slow accepted request is not queued again after its timeout", async () => {
  const h = harness([new DOMException("timed out", "TimeoutError")]);
  assert.equal(await triggerDeployment(h.options), false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.waits, []);
  assert.match(h.logs.at(-1), /may still be running/);
});

test("missing credentials fail before any request", async () => {
  const h = harness([200]);
  await assert.rejects(triggerDeployment({ ...h.options, token: "" }), /are required/);
  assert.equal(h.requests.length, 0);
});

test("deployment credentials cannot be sent over HTTP", async () => {
  const h = harness([200]);
  await assert.rejects(
    triggerDeployment({ ...h.options, url: "http://deploy.example.test" }),
    /must use HTTPS/,
  );
  assert.equal(h.requests.length, 0);
});
