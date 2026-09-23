import { readToken } from "./theme-tokens.js";

const pending = new Map();
const loadedModules = new Map();
const cdnUrl = (key) => {
  const src = globalThis.ES_CDN?.[key];
  if (!src) {
    throw new Error(`Missing CDN URL for library: ${key}`);
  }
  return src;
};
const isGoogleProvider = () =>
  String(globalThis.MAP_PROVIDER || "self_hosted").toLowerCase() === "google";

function findScript(src, id) {
  return (
    (id && document.getElementById(id)) ||
    [...document.scripts].find(
      (script) => script.src === src || script.getAttribute("src") === src
    )
  );
}

function loadScript(key, id, isReady) {
  if (isReady?.() || typeof document === "undefined") {
    return Promise.resolve();
  }

  const src = cdnUrl(key);
  if (pending.has(src)) {
    return pending.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const script = findScript(src, id) || document.createElement("script");
    let timer = null;

    const done = (error) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else if (isReady && !isReady()) {
        reject(new Error(`Library loaded without expected global: ${key}`));
      } else {
        resolve();
      }
    };

    script.addEventListener("load", () => done(), { once: true });
    script.addEventListener(
      "error",
      () => done(new Error(`Failed to load library: ${src}`)),
      { once: true }
    );
    timer = setTimeout(
      () => done(new Error(`Timed out loading library: ${src}`)),
      15000
    );

    if (!script.parentNode) {
      if (id) {
        script.id = id;
      }
      script.src = src;
      script.async = false;
      (document.head || document.body).appendChild(script);
    }
  });

  pending.set(src, promise);
  promise.catch(() => pending.delete(src));
  return promise;
}

function loadModule(key) {
  if (loadedModules.has(key)) {
    return loadedModules.get(key);
  }

  const src = cdnUrl(key);
  if (pending.has(src)) {
    return pending.get(src);
  }

  const promise = import(src).then((module) => {
    loadedModules.set(key, module);
    return module;
  });

  pending.set(src, promise);
  promise.catch(() => pending.delete(src));
  return promise;
}

async function ensureMap() {
  if (isGoogleProvider()) {
    await globalThis.__esGoogleMapsLoadPromise;
    return;
  }
  await loadScript("mapboxGlJs", "es-mapbox-gl-js", () => globalThis.mapboxgl);
  document.dispatchEvent(new CustomEvent("es:mapbox-gl-ready"));
}

// Chart.js ships its own type, greys, and rounded tooltips. Print charts
// like the rest of the manual instead: the text face for ticks, Franklin
// labels in legends and tooltips, ink rules for axes, and square marks.
// Colours are read from the theme tokens, so a theme switch re-applies them.
function applyChartTheme(chart) {
  const defaults = chart?.defaults;
  if (!defaults?.font) {
    return;
  }
  const text = readToken("--font-family-text") || readToken("--font-family");
  const label = readToken("--font-family-label") || text;
  const ink = readToken("--manual-ink");
  const paper = readToken("--manual-paper");
  const rule = readToken("--manual-rule");
  const faint = readToken("--manual-rule-faint");

  defaults.font.family = text;
  defaults.color = readToken("--text-secondary") || defaults.color;
  defaults.borderColor = faint || defaults.borderColor;
  if (defaults.scale) {
    defaults.scale.grid.color = faint || defaults.scale.grid.color;
    defaults.scale.border.color = rule || defaults.scale.border.color;
  }
  const { legend, tooltip } = defaults.plugins;
  legend.labels.font = { family: label, size: 11, weight: "600" };
  legend.labels.boxWidth = 12;
  legend.labels.boxHeight = 12;
  Object.assign(tooltip, {
    backgroundColor: ink,
    titleColor: paper,
    bodyColor: paper,
    footerColor: paper,
    borderWidth: 0,
    cornerRadius: 0,
    caretSize: 5,
    padding: 8,
    titleFont: { family: label, size: 11, weight: "700" },
    bodyFont: { family: text, size: 12 },
  });
  defaults.elements.bar.borderRadius = 0;
  defaults.elements.line.borderWidth = 2;
  defaults.elements.point.radius = 0;
  defaults.elements.point.hoverRadius = 4;
}

async function ensureChart() {
  await loadScript("chartjs", "es-chart-js", () => globalThis.Chart);
  const chart = globalThis.Chart;
  if (!chart?.defaults || chart.__esThemed) {
    return;
  }
  chart.__esThemed = true;
  applyChartTheme(chart);
  document.addEventListener("themeChanged", () => applyChartTheme(chart));
}

const loaders = {
  chart: ensureChart,
  datatables: async () => {
    await loadScript("jquery", "es-jquery", () => globalThis.$);
    await loadScript(
      "datatablesJs",
      "es-datatables-js",
      () => globalThis.$?.fn?.DataTable
    );
  },
  deck: () => loadScript("deckGl", "es-deck-gl", () => globalThis.deck),
  map: ensureMap,
  mapDraw: async () => {
    await ensureMap();
    if (!isGoogleProvider()) {
      await loadScript(
        "mapboxDrawJs",
        "es-mapbox-draw-js",
        () => globalThis.MapboxDraw
      );
    }
  },
  plot: () => loadModule("observablePlot"),
  topojson: () => loadScript("topojson", "es-topojson", () => globalThis.topojson),
};

export async function ensureLibraries(names = []) {
  const requested = [...new Set(names.filter(Boolean))];
  await Promise.all(
    requested.map((name) => {
      const load = loaders[name];
      if (!load) {
        throw new Error(`Unknown library requested: ${name}`);
      }
      return load();
    })
  );
}

export function getLoadedLibrary(name) {
  if (name === "plot") {
    return loadedModules.get("observablePlot") || null;
  }
  return null;
}
