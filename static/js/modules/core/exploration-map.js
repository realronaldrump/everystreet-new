import { createMap } from "../map-core.js";

// Coverage and Planner lease one canvas. Each lease owns its own layers/listeners;
// the renderer and camera survive panel navigation without retaining page code.
let session = null;
let selectedArea = null;
let selectedRoute = null;

export function getExplorationSelection() {
  return { areaId: selectedArea, routeId: selectedRoute };
}
export function setExplorationSelection(areaId, routeId = null) {
  selectedArea = areaId || null;
  selectedRoute = routeId || null;
}

export function acquireExplorationMap(containerId, options = {}) {
  const host = document.getElementById(containerId);
  if (!host) throw new Error(`Exploration map host missing: ${containerId}`);
  if (!session) {
    const canvas = document.createElement("div");
    canvas.id = "exploration-map-canvas";
    canvas.className = "exploration-map-canvas";
    host.replaceChildren(canvas);
    session = {
      canvas,
      map: createMap(canvas.id, options),
      release: null,
      areaId: selectedArea,
    };
  } else {
    session.release?.();
    host.replaceChildren(session.canvas);
    if (options.bounds && session.areaId !== selectedArea)
      session.map.fitBounds(
        options.bounds,
        options.fitBoundsOptions || { padding: 50, duration: 0 }
      );
  }
  const map = session.map;
  const events = [];
  const layers = new Set();
  const sources = new Set();
  const images = new Set();
  const controls = new Set();
  let closed = false;
  let proxy;
  const release = () => {
    if (closed) return;
    closed = true;
    session.areaId = selectedArea;
    map.stop?.();
    for (const args of events) map.off(...args);
    for (const id of [...layers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of sources) if (map.getSource(id)) map.removeSource(id);
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    for (const control of controls) map.removeControl(control);
    document.getElementById("exploration-map-parking")?.append(session.canvas);
  };
  proxy = new Proxy(map, {
    get(target, key) {
      if (key === "remove") return release;
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (closed) return undefined;
        if (key === "on" || key === "once") {
          const handler = args.at(-1);
          const guarded = (...eventArgs) => {
            if (!closed) handler(...eventArgs);
          };
          const eventArgs = [...args.slice(0, -1), guarded];
          guarded.original = handler;
          events.push(eventArgs);
          // Existing consumers use load as a readiness signal on a new map.
          if (args[0] === "load" && target.isStyleLoaded())
            queueMicrotask(() => guarded({ target: proxy }));
          else value.apply(target, eventArgs);
          return proxy;
        }
        if (key === "off") {
          const original = args.at(-1);
          for (const entry of events) {
            if (
              entry[0] === args[0] &&
              entry.at(-1).original === original &&
              (args.length === 2 || entry[1] === args[1])
            )
              target.off(...entry);
          }
          return proxy;
        }
        if (key === "addLayer") layers.add(args[0].id);
        if (key === "addSource") sources.add(args[0]);
        if (key === "addImage") images.add(args[0]);
        if (key === "addControl") controls.add(args[0]);
        if (key === "removeControl") controls.delete(args[0]);
        const result = value.apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  session.release = release;
  requestAnimationFrame(() => {
    if (!closed) map.resize();
  });
  return proxy;
}

export function disposeExplorationMap() {
  session?.release?.();
  session?.map.remove();
  session?.canvas.remove();
  session = null;
  selectedArea = null;
  selectedRoute = null;
}
