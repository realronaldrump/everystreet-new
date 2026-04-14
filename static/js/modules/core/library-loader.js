const cdnFallbacks = {
  chartjs: "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js",
  datatablesJs: "https://cdn.datatables.net/2.3.6/js/dataTables.min.js",
  deckGl: "https://cdn.jsdelivr.net/npm/deck.gl@9.2.7/dist.min.js",
  jquery: "https://code.jquery.com/jquery-3.7.1.min.js",
  mapboxDrawJs:
    "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-draw/v1.5.0/mapbox-gl-draw.js",
  mapboxGlJs: "https://api.mapbox.com/mapbox-gl-js/v3.17.0/mapbox-gl.js",
  observablePlot: "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/+esm",
  topojson:
    "https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js",
};

const pending = new Map();
const loadedModules = new Map();
const cdnUrl = (key) => globalThis.ES_CDN?.[key] || cdnFallbacks[key];
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
  if (!src) {
    return Promise.resolve();
  }
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

async function loadModule(key) {
  if (loadedModules.has(key)) {
    return loadedModules.get(key);
  }

  const src = cdnUrl(key);
  if (!src) {
    return null;
  }
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

const loaders = {
  chart: () => loadScript("chartjs", "es-chart-js", () => globalThis.Chart),
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
  for (const name of new Set(names.filter(Boolean))) {
    await loaders[name]?.();
  }
}

export function getLoadedLibrary(name) {
  if (name === "plot") {
    return loadedModules.get("observablePlot") || null;
  }
  return null;
}
