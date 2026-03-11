import assert from "node:assert/strict";
import test from "node:test";

import apiClient from "../static/js/modules/core/api-client.js";
import { CONFIG } from "../static/js/modules/core/config.js";
import store from "../static/js/modules/core/store.js";
import { fetchWithRetry } from "../static/js/modules/utils/data.js";

test("fetchWithRetry rethrows aborts instead of masking them as null data", async () => {
  const originalRequest = apiClient.request;

  apiClient.request = async (_url, options = {}) =>
    await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("Request aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });

  try {
    const request = fetchWithRetry("/api/test/abort", {}, 1, 0, "test-abort");
    store.cancelRequest("test-abort");

    await assert.rejects(request, (error) => error?.name === "AbortError");
  } finally {
    apiClient.request = originalRequest;
    store.cancelRequest("test-abort");
  }
});

test("fetchWithRetry converts its own abort timeout into a TimeoutError", async () => {
  const originalRequest = apiClient.request;
  const originalTimeout = CONFIG.API.timeout;
  CONFIG.API.timeout = 10;

  apiClient.request = async (_url, options = {}) =>
    await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("Request aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });

  try {
    await assert.rejects(
      fetchWithRetry("/api/test/timeout", {}, 1, 0, "test-timeout"),
      (error) => error?.name === "TimeoutError"
    );
  } finally {
    apiClient.request = originalRequest;
    CONFIG.API.timeout = originalTimeout;
    store.cancelRequest("test-timeout");
  }
});
