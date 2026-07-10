import assert from "node:assert/strict";
import test from "node:test";
import apiClient from "../static/js/modules/core/api-client.js";
import * as RegionalCoverageExplorerAPI from "../static/js/modules/regional-coverage-explorer/api.js";

test("region explorer API forwards abort signals", async () => {
  const signal = AbortSignal.abort();

  const originalGet = apiClient.get;
  const calls = [];

  apiClient.get = async (url, options = {}) => {
    calls.push(["get", url, options]);
    if (url === "/api/geo-coverage/topology?level=county") {
      return { success: true, topology: { type: "Topology", objects: {} } };
    }
    return { success: true };
  };
  try {
    await RegionalCoverageExplorerAPI.fetchCountyTopology({ signal });
    await RegionalCoverageExplorerAPI.fetchVisitedCounties({ signal });
    await RegionalCoverageExplorerAPI.fetchCacheStatus({ signal });
  } finally {
    apiClient.get = originalGet;
  }

  assert.deepEqual(calls, [
    ["get", "/api/geo-coverage/topology?level=county", { signal }],
    ["get", "/api/geo-coverage/visits?level=county", { signal }],
    ["get", "/api/geo-coverage/cache-status", { signal }],
  ]);
});
