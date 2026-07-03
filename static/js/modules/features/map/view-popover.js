/**
 * View popover — one quiet button housing the basemap style select,
 * the 3D buildings and terrain switches, and the simulator entry.
 * Replaces the old FAB dock.
 */

import store from "../../core/store.js";
import {
  getUserBuildingsPreference,
  isMapbox3DStyleSupported,
  MAP_3D_SETTING_EVENT,
  setMap3dBuildingsPreference,
} from "./buildings-3d.js";
import {
  getTerrainReliefPreference,
  isTerrainReliefSupported,
  MAP_TERRAIN_RELIEF_SETTING_EVENT,
  setTerrainReliefPreference,
} from "./terrain-relief.js";

export default function initViewPopover({ registerCleanup }) {
  const toggle = document.getElementById("view-popover-toggle");
  const popover = document.getElementById("view-popover");
  if (!toggle || !popover) {
    return;
  }

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  // ---- Open / close -------------------------------------------------
  const setOpen = (open) => {
    popover.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  on(toggle, "click", () => setOpen(popover.hidden));
  on(document, "click", (event) => {
    if (
      !popover.hidden &&
      !popover.contains(event.target) &&
      !toggle.contains(event.target)
    ) {
      setOpen(false);
    }
  });
  on(document, "keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  registerCleanup(() => setOpen(false));

  // ---- Scene switches -------------------------------------------------
  const bindSwitch = ({ button, isSupported, getPreference, setPreference, event }) => {
    if (!button) {
      return;
    }

    const sync = () => {
      const map = store.map || window.map;
      const supported = isSupported(map);
      button.hidden = !supported;
      button.setAttribute("aria-pressed", String(supported && getPreference()));
    };

    on(button, "click", () => {
      const map = store.map || window.map;
      if (!isSupported(map)) {
        sync();
        return;
      }
      setPreference(!getPreference());
      sync();
    });
    on(document, event, sync);
    on(document, "mapStyleLoaded", sync);
    sync();
  };

  bindSwitch({
    button: document.getElementById("view-3d-buildings"),
    isSupported: isMapbox3DStyleSupported,
    getPreference: getUserBuildingsPreference,
    setPreference: setMap3dBuildingsPreference,
    event: MAP_3D_SETTING_EVENT,
  });

  bindSwitch({
    button: document.getElementById("view-terrain-relief"),
    isSupported: isTerrainReliefSupported,
    getPreference: getTerrainReliefPreference,
    setPreference: setTerrainReliefPreference,
    event: MAP_TERRAIN_RELIEF_SETTING_EVENT,
  });
}
