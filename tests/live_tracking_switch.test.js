import assert from "node:assert/strict";
import test from "node:test";

import apiClient from "../static/js/modules/core/api-client.js";
import {
  disableBouncieLiveTracking,
  isBouncieLiveTrackingEnabled,
} from "../static/js/modules/features/tracking/availability.js";
import LiveTripTracker from "../static/js/modules/features/tracking/index.js";

test.afterEach(() => {
  delete global.window;
});

test("tracking requires an explicit server flag and owner session", () => {
  assert.equal(isBouncieLiveTrackingEnabled(), false);
  global.window = { APP_SETTINGS_FLAGS: {}, AUTH_CONTEXT: { isOwner: true } };
  assert.equal(isBouncieLiveTrackingEnabled(), false);
  window.APP_SETTINGS_FLAGS.bouncieLiveTrackingEnabled = true;
  assert.equal(isBouncieLiveTrackingEnabled(), true);
  window.AUTH_CONTEXT.isOwner = false;
  assert.equal(isBouncieLiveTrackingEnabled(), false);
  window.AUTH_CONTEXT.isOwner = true;
  disableBouncieLiveTracking();
  assert.equal(isBouncieLiveTrackingEnabled(), false);
});

test("disabled tracker never creates layers, connections, or timers", () => {
  global.window = { APP_SETTINGS_FLAGS: { bouncieLiveTrackingEnabled: false } };
  const map = new Proxy({}, { get() { assert.fail("disabled tracker touched map"); } });
  const initialize = test.mock.method(LiveTripTracker.prototype, "initialize", () => {
    assert.fail("disabled tracker started live requests");
  });
  const freshness = test.mock.method(LiveTripTracker.prototype, "startFreshnessMonitor", () => {
    assert.fail("disabled tracker started a timer");
  });
  new LiveTripTracker(map);
  initialize.mock.restore();
  freshness.mock.restore();
});

test("a disabled polling response shuts down an already open tracker without rescheduling", async () => {
  global.window = {
    APP_SETTINGS_FLAGS: { bouncieLiveTrackingEnabled: true },
    AUTH_CONTEXT: { isOwner: true },
  };
  const get = test.mock.method(apiClient, "get", async () => ({ enabled: false }));
  let cleared = false;
  let destroyed = false;
  const tracker = {
    isDestroyed: false,
    stopForDisabledTracking: LiveTripTracker.prototype.stopForDisabledTracking,
    clearTrip() { cleared = true; },
    destroy() { this.isDestroyed = true; destroyed = true; },
  };
  await LiveTripTracker.prototype.poll.call(tracker);
  assert.equal(cleared, true);
  assert.equal(destroyed, true);
  assert.equal(tracker.pollingTimer, undefined);
  assert.equal(isBouncieLiveTrackingEnabled(), false);
  get.mock.restore();
});

test("disabled initial response cannot start polling or a WebSocket afterwards", async () => {
  const calls = [];
  const tracker = {
    isDestroyed: false,
    async loadInitialTrip() { this.isDestroyed = true; },
    startPolling() { calls.push("poll"); },
    connectWebSocket() { calls.push("socket"); },
    setupMapStyleListener() { calls.push("style"); },
  };
  await LiveTripTracker.prototype.initialize.call(tracker);
  assert.deepEqual(calls, []);
});
