import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/trips");
  await page.waitForFunction(() => window.fixtureReady);
});

test("detail drawer preserves the list, focus, and browser history", async ({
  page,
}) => {
  await page.locator("#query").fill("keep my search");
  await page.locator("#detail").click();
  await expect(page.locator("#detail-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/trips\/1$/);
  await expect(page.locator("#detail-content h1")).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.mounts["/trips/1"])).toBe(1);
  await page.goBack();
  await expect(page.locator("#detail-dialog")).not.toBeVisible();
  await expect(page.locator("#query")).toHaveValue("keep my search");
  expect(await page.evaluate(() => window.mounts["/trips"])).toBe(1);
  await expect(page.locator("#detail")).toBeFocused();
  await page.goForward();
  await expect(page.locator("#detail-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/trips$/);
});

test("route modules finish loading before replacement and interrupted visits keep the page alive", async ({
  page,
}) => {
  await page.evaluate(() => window.navigate("/vehicles"));
  await expect(page).toHaveURL(/\/vehicles$/);
  await expect.poll(() => page.evaluate(() => window.mounts["/vehicles"])).toBe(1);
  await page.evaluate(() => {
    window.navigate("/trips?slow=1");
  });
  await page.evaluate(() => window.navigate("/coverage-management"));
  await expect(page).toHaveURL(/\/coverage-management$/);
  await expect
    .poll(() => page.evaluate(() => window.mounts["/coverage-management"]))
    .toBe(1);
  expect(await page.evaluate(() => window.unmounts["/vehicles"])).toBe(1);
});

test("coverage and planner retain the same canvas and renderer", async ({ page }) => {
  await page.locator("#coverage").click();
  await expect.poll(() => page.evaluate(() => window.mapCreations)).toBe(1);
  await page.evaluate(() => {
    window.firstCanvas = document.getElementById("exploration-map-canvas");
  });
  await page.locator("#planner").click();
  await expect
    .poll(() => page.evaluate(() => window.mounts["/coverage-route-planner"]))
    .toBe(1);
  expect(await page.evaluate(() => window.mapCreations)).toBe(1);
  expect(
    await page.evaluate(
      () => window.firstCanvas === document.getElementById("exploration-map-canvas")
    )
  ).toBe(true);
});

test("drawer query history leaves the background date filter untouched", async ({
  page,
}) => {
  await page.evaluate(() =>
    window.store.updateFilters({ startDate: "2026-08-01" }, { syncUrl: false })
  );
  await page.locator("#journal").click();
  await expect(page.locator("#detail-dialog")).toBeVisible();
  await page.evaluate(() => {
    history.replaceState({ ...history.state, source: "es-store" }, "", "?range=90d");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  expect(await page.evaluate(() => window.store.get("filters.startDate"))).toBe(
    "2026-08-01"
  );
});

test("store-only history, mutation cache invalidation, and bypass links", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.store.updateFilters({ vehicle: "test" }, { syncUrl: false });
    window.store.syncUrl({ push: true });
  });
  await page.locator("#home").click();
  await page.goBack();
  await expect(page.locator("#route-content h1")).toHaveText("/trips");
  await page.evaluate(async () => {
    window.swup.cache.set("/old", { url: "/old", html: "old" });
    await window.api.post("/mutation", {});
  });
  expect(await page.evaluate(() => window.swup.cache.has("/old"))).toBe(false);
  await page.evaluate(() => {
    window.documentMarker = true;
  });
  await page.locator("#native").click();
  expect(await page.evaluate(() => window.documentMarker)).toBeUndefined();
});

test("direct details, reduced motion, and failed bundle startup remain usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/trips/1");
  await page.waitForFunction(() => window.fixtureReady);
  await expect(page.locator("#detail-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/trips$/);
  await page.route("**/vendor/swup.js", (route) => route.abort());
  await page.goto("/trips");
  await page.waitForFunction(() => window.fixtureReady);
  expect(await page.evaluate(() => window.swup)).toBeNull();
  await page.evaluate(() => window.navigate("/vehicles"));
  await expect(page).toHaveURL(/\/vehicles$/);
});
