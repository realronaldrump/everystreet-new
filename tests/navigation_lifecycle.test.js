import assert from "node:assert/strict";
import test from "node:test";
import store from "../static/js/modules/core/store.js";
import { createPageContext } from "../static/js/modules/core/page-context.js";
import { updateUrlHistory } from "../static/js/modules/core/url-history.js";
import { onPageLoad } from "../static/js/modules/core/page-lifecycle.js";
import { emitNavigation } from "../static/js/modules/core/navigation-events.js";
import {
  detailParent,
  shouldSkipPopState,
  transitionKind,
} from "../static/js/modules/core/navigation-policy.js";

function environment(t) {
  const original = {
    document: global.document,
    window: global.window,
    ready: store.appReady,
  };
  global.document = Object.assign(new EventTarget(), {
    body: { dataset: { route: "/trips" } },
  });
  global.window = { location: { pathname: "/trips", origin: "https://example.test" } };
  store.appReady = true;
  t.after(() => {
    global.document = original.document;
    global.window = original.window;
    store.appReady = original.ready;
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("page context runs late cleanup immediately and deduplicates returned teardown", () => {
  const context = createPageContext();
  let calls = 0;
  const teardown = () => calls++;
  context.onCleanup(teardown);
  context.cleanup(teardown);
  context.dispose();
  context.onCleanup(teardown);
  context.onCleanup(() => calls++);
  context.dispose();
  assert.equal(calls, 2);
});

test("URL-only updates preserve history metadata but replace its recorded URL", (t) => {
  environment(t);
  let record;
  window.location.href = "https://example.test/trips";
  window.history = {
    state: { source: "swup", index: 3, url: "/trips" },
    pushState: (state, _title, url) => {
      record = { state, url };
    },
  };
  updateUrlHistory("/trips?vehicle=example", { push: true });
  assert.equal(record.state.index, 3);
  assert.equal(record.state.source, "es-store");
  assert.equal(record.state.url, new URL(record.url, window.location.href).href);
  assert.equal(record.state.url, "https://example.test/trips?vehicle=example");
});

test("opening and closing a detail keeps its underlying page mounted", async (t) => {
  environment(t);
  let mounts = 0;
  let unmounts = 0;
  let signal;
  const dispose = onPageLoad(
    (context) => {
      mounts++;
      signal = context.signal;
      return () => unmounts++;
    },
    { route: "/trips" }
  );
  t.after(dispose);
  await tick();
  const open = {
    from: { url: "/trips" },
    to: { url: "/trips/123" },
    meta: { detailVisit: true, backgroundPath: "/trips" },
  };
  emitNavigation("page:leave", open);
  emitNavigation("page:view", open);
  assert.equal(signal.aborted, false);
  const close = {
    ...open,
    to: { url: "/trips" },
    meta: { ...open.meta, closeDetail: true },
  };
  emitNavigation("page:leave", close);
  emitNavigation("page:view", close);
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);
  emitNavigation("page:leave", { to: { url: "/insights" }, meta: {} });
  assert.equal(unmounts, 1);
  assert.equal(signal.aborted, true);
});

test("aborted visits do not tear down the current page, late async cleanup runs once", async (t) => {
  environment(t);
  let resolve;
  let cleaned = 0;
  const cleanup = () => cleaned++;
  const dispose = onPageLoad(
    async ({ cleanup: register }) => {
      register(cleanup);
      await new Promise((done) => {
        resolve = done;
      });
      register(cleanup);
      return cleanup;
    },
    { route: "/trips" }
  );
  t.after(dispose);
  await tick();
  emitNavigation("visit:start", {});
  emitNavigation("visit:abort", {});
  assert.equal(cleaned, 0);
  dispose();
  resolve();
  await tick();
  assert.equal(cleaned, 1);
});

test("disposal before the scheduled initial mount prevents initialization", async (t) => {
  environment(t);
  let mounted = false;
  const dispose = onPageLoad(() => {
    mounted = true;
  });
  dispose();
  await tick();
  assert.equal(mounted, false);
});

test("app-ready and page-view events win over the pending initial timer", async (t) => {
  environment(t);
  let mounts = 0;
  const dispose = onPageLoad(
    () => {
      mounts++;
    },
    { route: "/trips" }
  );
  document.dispatchEvent(new Event("appReady"));
  await tick();
  assert.equal(mounts, 1);
  dispose();
  const disposeLater = onPageLoad(
    () => {
      mounts++;
    },
    { route: "/trips" }
  );
  emitNavigation("page:view", { to: { url: "/trips" } });
  await tick();
  assert.equal(mounts, 2);
  disposeLater();
});

test("history and motion distinguish detail, driving, and same-page filter visits", () => {
  assert.equal(detailParent("/trips/123"), "/trips");
  assert.equal(
    detailParent("/coverage-management/abc/journal"),
    "/coverage-management"
  );
  assert.equal(detailParent("/trips"), null);
  assert.equal(
    shouldSkipPopState({ state: { source: "es-store" } }, "/trips", "/trips"),
    true
  );
  assert.equal(
    shouldSkipPopState({ state: { source: "es-store" } }, "/trips", "/map"),
    false
  );
  assert.equal(
    transitionKind("/coverage-management", "/coverage-route-planner"),
    "explore"
  );
  assert.equal(transitionKind("/coverage-route-planner", "/live-navigation"), "drive");
  assert.equal(transitionKind("/trips", "/trips/1", { detail: true }), "detail-open");
  assert.equal(transitionKind("/trips/1", "/trips", { closing: true }), "detail-close");
});
