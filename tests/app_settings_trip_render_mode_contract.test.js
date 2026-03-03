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
const appControllerPath = path.join(root, "static", "js", "modules", "app-controller.js");
const layerManagerPath = path.join(root, "static", "js", "modules", "layer-manager.js");

test("settings UI exposes trip/matched render mode toggle", () => {
  const settingsHtml = fs.readFileSync(settingsTemplatePath, "utf8");

  assert.match(
    settingsHtml,
    /Use Heatmap Style for Trips & Matched Trips/,
    "Expected trip/matched style toggle label in settings UI"
  );
  assert.match(
    settingsHtml,
    /id="trip-layers-use-heatmap"/,
    "Expected trip layer mode toggle input id in settings UI"
  );
});

test("trip layer render mode wiring persists through settings and app bootstrap", () => {
  const configSource = fs.readFileSync(configJsPath, "utf8");
  const appSettingsSource = fs.readFileSync(appSettingsJsPath, "utf8");
  const baseTemplate = fs.readFileSync(baseTemplatePath, "utf8");
  const appControllerSource = fs.readFileSync(appControllerPath, "utf8");
  const layerManagerSource = fs.readFileSync(layerManagerPath, "utf8");

  assert.match(
    configSource,
    /tripLayersUseHeatmap:\s*"tripLayersUseHeatmap"/,
    "Expected storage key for tripLayersUseHeatmap"
  );

  assert.match(
    appSettingsSource,
    /document\.getElementById\(\s*"trip-layers-use-heatmap"\s*\)/,
    "Expected settings form to read the trip layer style toggle element"
  );
  assert.match(
    appSettingsSource,
    /tripLayersUseHeatmap:\s*tripLayersUseHeatmapToggle\?\.checked\s*\?\?\s*true/,
    "Expected save payload to include tripLayersUseHeatmap"
  );
  assert.match(
    appSettingsSource,
    /localStorage\.setItem\(\s*CONFIG\.STORAGE_KEYS\.tripLayersUseHeatmap,/,
    "Expected localStorage mirror write for tripLayersUseHeatmap"
  );

  assert.match(
    baseTemplate,
    /APP_SETTINGS_FLAGS[\s\S]*tripLayersUseHeatmap:/,
    "Expected base template to expose tripLayersUseHeatmap flag globally"
  );

  assert.match(
    appControllerSource,
    /APP_SETTINGS_FLAGS\?\.tripLayersUseHeatmap\s*!==\s*false/,
    "Expected app-controller fallback to server-provided trip layer mode flag"
  );
  assert.match(
    appControllerSource,
    /layerManager\.setTripLayerRenderMode\(useHeatmap\)/,
    "Expected app-controller to apply trip layer mode via layer-manager"
  );

  assert.match(
    layerManagerSource,
    /async setTripLayerRenderMode\(useHeatmap\)/,
    "Expected layer-manager API for switching trip layer render mode"
  );
  assert.match(
    layerManagerSource,
    /`\$\{layerName\}-layer-0`[\s\S]*`\$\{layerName\}-layer-1`[\s\S]*`\$\{layerName\}-layer`/,
    "Expected cleanup to remove both heatmap and standard layer variants"
  );
});
