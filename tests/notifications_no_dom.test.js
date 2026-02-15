import assert from "node:assert/strict";
import test from "node:test";

import { notificationManager, notify } from "../static/js/modules/ui/notifications.js";

test("notifications module is safe without a DOM", () => {
  assert.equal(notificationManager.container, null);
  assert.equal(notify.info("Hello from Node"), null);
  assert.equal(notify.error("Hello from Node"), null);
});
