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
