import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import { onPageLoad } from "../static/js/modules/utils.js";

test("onPageLoad composes registered and returned cleanup handlers", async () => {
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalAppReady = store.appReady;

  const calls = [];

  global.window = {
    location: {
      origin: "https://example.test",
      pathname: "/coverage-navigator",
    },
  };

  global.document = {
    readyState: "complete",
    body: { dataset: { route: "/coverage-navigator" } },
    addEventListener() {},
  };

  store.appReady = true;

  try {
    const dispose = onPageLoad(
      ({ cleanup } = {}) => {
        cleanup(() => calls.push("registered"));
        return () => calls.push("returned");
      },
      { route: "/coverage-navigator" }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    dispose();

    assert.deepEqual(calls, ["returned", "registered"]);
  } finally {
    store.appReady = originalAppReady;
    global.document = originalDocument;
    global.window = originalWindow;
  }
});
