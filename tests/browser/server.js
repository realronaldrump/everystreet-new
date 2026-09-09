// Synthetic browser fixture server. Only the committed CI workflow starts it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.env.CI)
  throw new Error("Run browser fixtures in CI, not on the source workstation.");
const root = process.cwd();
const pages = {
  landing: "/",
  trips: "/trips",
  "trip-detail": "/trips/1",
  "coverage-management": "/coverage-management",
  "coverage-route-planner": "/coverage-route-planner",
  vehicles: "/vehicles",
  "coverage-journal": "/coverage-management/a/journal",
};
const markup = (path) => {
  const detail = /^\/trips\/[^/]+$/.test(path) || path.endsWith("/journal");
  return `<!doctype html><html lang="en"><head><title>${path}</title><meta name="es-build" content="fixture"><link rel="stylesheet" href="/static/css/navigation-experience.css"></head>
  <body data-route="${path}" data-auth-role="owner"><nav><a href="/" id="home">Home</a><a href="/trips" id="trips">Trips</a><a href="/coverage-management" id="coverage">Coverage</a><a href="/coverage-route-planner" id="planner">Planner</a><a href="/vehicles" id="vehicles">Vehicles</a><a href="/login" id="login">Login</a></nav>
  <div id="persistent-shell"></div><main id="route-content"><h1>${path}</h1><input id="query" aria-label="Search"><button id="counter">Count</button><a href="/trips/1" id="detail" data-trip-id="1">Trip one</a><a href="/coverage-management/a/journal" id="journal">Journal</a><a href="/trips" data-no-swup id="native">Native link</a><div id="coverage-map" style="height:200px"></div></main>
  <dialog id="detail-dialog" class="detail-drawer" ${detail ? "open" : ""}><a href="/trips" data-detail-close>Back</a><div id="detail-content">${detail ? `<article><h1>Details</h1><button id="detail-counter">Detail action</button></article>` : ""}</div></dialog><div id="exploration-map-parking" hidden></div><script type="module" src="/tests/browser/entry.js"></script></body></html>`;
};
createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture.test");
  try {
    if (url.pathname === "/mutation") {
      response.setHeader("Content-Type", "application/json");
      response.end('{"ok":true}');
      return;
    }
    const pageName = url.pathname.match(/^\/static\/js\/pages\/(.+)\.js$/)?.[1];
    if (pageName && pages[pageName]) {
      if (pageName === "vehicles") await new Promise((done) => setTimeout(done, 300));
      response.setHeader("Content-Type", "text/javascript");
      response.end(
        `import { mount } from '/tests/browser/feature.js'; mount(${JSON.stringify(pages[pageName])});`
      );
      return;
    }
    if (
      url.pathname.startsWith("/static/") ||
      url.pathname.startsWith("/tests/browser/")
    ) {
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader(
        "Content-Type",
        path.endsWith(".css") ? "text/css" : "text/javascript"
      );
      response.end(await readFile(path));
      return;
    }
    if (url.searchParams.has("slow"))
      await new Promise((done) => setTimeout(done, 500));
    response.setHeader("Content-Type", "text/html");
    response.end(markup(url.pathname));
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(4179, "127.0.0.1");
