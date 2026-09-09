import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 1,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  webServer: {
    command: "node tests/browser/server.js",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
