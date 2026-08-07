import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildServiceRowMarkup,
  renderChatGptStatus,
  renderServiceDetails,
} from "../static/js/modules/features/settings/control-center-overview.js";

test("service rows preserve brand names and escape API content", () => {
  const markup = buildServiceRowMarkup("mongodb", {
    status: "healthy",
    label: "Healthy",
    message: '<script>alert("nope")</script>',
  });

  assert.match(markup, /<h4>MongoDB<\/h4>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test("warning rows use a semantic state marker instead of a generic badge", () => {
  const markup = buildServiceRowMarkup("bouncie", {
    status: "warning",
    label: "Stale",
    message: "No recent deliveries",
  });

  assert.match(markup, /control-center-service-state" data-status="warning"/);
  assert.doesNotMatch(markup, /class="badge/);
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

test("service ledger is mobile-first and contains long values", async () => {
  const css = await readFile(
    new URL("../static/css/settings.css", import.meta.url),
    "utf8"
  );

  assert.match(css, /\.control-center-service-ledger-head/);
  assert.match(css, /\.control-center-service-row/);
  assert.doesNotMatch(css, /\.control-center-service-card/);
  assert.doesNotMatch(css, /box-shadow: inset 3px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-height: 44px/);
});

test("ChatGPT status explains anonymous access and confirmed writes", () => {
  const originalDocument = globalThis.document;
  const container = { innerHTML: "" };
  globalThis.document = {
    getElementById: (id) => (id === "cc-chatgpt-status" ? container : null),
  };
  try {
    renderChatGptStatus({
      status: "ready",
      endpoint: "https://www.everystreet.me/mcp",
      authentication: "none",
      mtls_required: false,
      tools: { model_visible: 15 },
      activity_24h: { calls: 3 },
      latest_call: null,
    });
  } finally {
    globalThis.document = originalDocument;
  }

  assert.match(container.innerHTML, /Anonymous MCP/);
  assert.match(container.innerHTML, /explicit click/);
  assert.match(
    container.innerHTML,
    /https:&#x2F;&#x2F;www\.everystreet\.me&#x2F;mcp/
  );
});
