/**
 * Flow lens — every trip in motion.
 *
 * Activates the particle-flow visualization while the lens is active
 * and keeps it refreshed as data and basemap styles change.
 */

import store from "../../core/store.js";
import particleFlow from "./particle-flow.js";

export default function createFlowLens({ registerCleanup }) {
  let isActive = false;

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  // Refresh particles when trip data changes (date filter, new trips loaded)
  const handleDataRefresh = () => {
    if (isActive && particleFlow.isActive()) {
      setTimeout(() => particleFlow.refresh(), 200);
    }
  };
  on(document, "tripsDataLoaded", handleDataRefresh);
  on(document, "matchedTripsDataLoaded", handleDataRefresh);
  on(document, "es:filters-change", handleDataRefresh);

  // A style change restores trip layers; re-hide them under the particles.
  const handleStyleChange = () => {
    if (!isActive || !particleFlow.isActive()) {
      return;
    }
    setTimeout(() => {
      const { map } = store;
      if (!map) {
        return;
      }
      particleFlow.refresh();
      const style = map.getStyle();
      if (!style?.layers) {
        return;
      }
      for (const layer of style.layers) {
        if (
          (layer.id.startsWith("trips-layer") ||
            layer.id.startsWith("matchedTrips-layer")) &&
          !layer.id.includes("hitbox")
        ) {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      }
    }, 300);
  };
  on(document, "mapStyleLoaded", handleStyleChange);

  registerCleanup(() => {
    particleFlow.destroy();
  });

  return {
    id: "flow",
    activate() {
      isActive = true;
      if (!particleFlow.isActive()) {
        particleFlow.activate();
      }
    },
    deactivate() {
      isActive = false;
      if (particleFlow.isActive()) {
        particleFlow.deactivate();
      }
    },
  };
}
