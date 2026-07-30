import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildServiceCardMarkup,
  renderServiceDetails,
} from "../static/js/modules/features/settings/control-center-overview.js";

test("service cards preserve brand names and escape API content", () => {
  const markup = buildServiceCardMarkup("mongodb", {
    status: "healthy",
    label: "Healthy",
    message: '<script>alert("nope")</script>',
  });

  assert.match(markup, /<h4>MongoDB<\/h4>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test("typed details render dates and copyable URLs without prose separators", () => {
  const details = renderServiceDetails([
    {
      label: "Last delivery",
      value: "2026-07-30T19:00:00+00:00",
      format: "relative_datetime",
    },
    {
      label: "Webhook URL",
      value: "https://www.everystreet.me/api/webhooks/bouncie/live",
      format: "url",
      copyable: true,
    },
  ]);

  assert.match(details, /<dt>Last delivery<\/dt>/);
  assert.match(details, /<time datetime=/);
  assert.match(details, /control-center-service-copy-btn/);
  assert.doesNotMatch(details, /\s\|\s/);
});

test("service grid is mobile-first and contains long values", async () => {
  const css = await readFile(
    new URL("../static/css/settings.css", import.meta.url),
    "utf8"
  );

  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-height: 44px/);
});
