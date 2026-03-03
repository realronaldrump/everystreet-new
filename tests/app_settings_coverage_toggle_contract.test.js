import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const settingsTemplatePath = path.join(root, "templates", "control_center.html");
const appSettingsJsPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "features",
  "settings",
  "app-settings.js"
);
const configJsPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "core",
  "config.js"
);
const baseTemplatePath = path.join(root, "templates", "base.html");

test("settings UI exposes coverage-scoped trip rendering toggle", () => {
  const settingsHtml = fs.readFileSync(settingsTemplatePath, "utf8");

  assert.match(
    settingsHtml,
    /Show Only Trips Inside Selected Coverage Area/,
    "Expected coverage clipping toggle label in settings UI"
  );
  assert.match(
    settingsHtml,
    /id="map-trips-within-coverage-only"/,
    "Expected map coverage toggle input id in settings UI"
  );
});

test("settings persistence wiring includes mapTripsWithinCoverageOnly", () => {
  const configSource = fs.readFileSync(configJsPath, "utf8");
  const appSettingsSource = fs.readFileSync(appSettingsJsPath, "utf8");
  const baseTemplate = fs.readFileSync(baseTemplatePath, "utf8");

  assert.match(
    configSource,
    /mapTripsWithinCoverageOnly:\s*"mapTripsWithinCoverageOnly"/,
    "Expected storage key for mapTripsWithinCoverageOnly"
  );

  assert.match(
    appSettingsSource,
    /document\.getElementById\(\s*"map-trips-within-coverage-only"\s*\)/,
    "Expected settings form to read the coverage toggle element"
  );
  assert.match(
    appSettingsSource,
    /mapTripsWithinCoverageOnly:\s*mapTripsWithinCoverageOnlyToggle\?\.checked\s*\?\?\s*false/,
    "Expected save payload to include mapTripsWithinCoverageOnly"
  );
  assert.match(
    appSettingsSource,
    /localStorage\.setItem\(\s*CONFIG\.STORAGE_KEYS\.mapTripsWithinCoverageOnly,/,
    "Expected localStorage mirror write for mapTripsWithinCoverageOnly"
  );

  assert.match(
    baseTemplate,
    /APP_SETTINGS_FLAGS[\s\S]*mapTripsWithinCoverageOnly:/,
    "Expected base template to expose mapTripsWithinCoverageOnly flag globally"
  );
});
