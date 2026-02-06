import { swupReady } from "../core/navigation.js";

const STORAGE_KEYS = {
  accent: "es:accent-color",
  density: "es:ui-density",
  motion: "es:motion-mode",
  widgetEdit: "es:widget-editing",
};

const personalization = {
  baseVars: null,
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }

    this.captureBaseVars();
    if (typeof window !== "undefined") {
      window.personalization = this;
    }
    this.applyFromStorage();
    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.applyFromStorage());
      })
      .catch(() => {});
    document.addEventListener("personalization:update", (event) => {
      this.applyPreferences(event.detail || {});
    });
    this.initialized = true;
  },

  captureBaseVars() {
    if (this.baseVars) {
      return;
    }
    const style = getComputedStyle(document.documentElement);
    this.baseVars = {
      primary: style.getPropertyValue("--primary").trim(),
      primaryLight: style.getPropertyValue("--primary-light").trim(),
      primaryDark: style.getPropertyValue("--primary-dark").trim(),
      primaryRgb: style.getPropertyValue("--primary-rgb").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      accentRgb: style.getPropertyValue("--accent-rgb").trim(),
    };
  },

  applyFromStorage() {
    const accent = localStorage.getItem(STORAGE_KEYS.accent);
    const density = localStorage.getItem(STORAGE_KEYS.density);
    const motion = localStorage.getItem(STORAGE_KEYS.motion);
    const widgetEditing = localStorage.getItem(STORAGE_KEYS.widgetEdit);

    if (accent) {
      this.applyAccent(accent);
    } else {
      this.resetAccent();
    }
    this.applyDensity(density || "comfortable");
    this.applyMotion(motion || "balanced");
    if (widgetEditing !== null) {
      document.dispatchEvent(
        new CustomEvent("widgets:set-edit", {
          detail: { enabled: widgetEditing === "true" },
        })
      );
    }
  },

  applyPreferences({
    accentColor,
    density,
    motion,
    widgetEditing,
    persist = true,
  } = {}) {
    if (accentColor !== undefined) {
      if (accentColor) {
        this.applyAccent(accentColor);
      } else {
        this.resetAccent();
      }
      if (persist) {
        localStorage.setItem(STORAGE_KEYS.accent, accentColor || "");
      }
    }

    if (density) {
      this.applyDensity(density);
      if (persist) {
        localStorage.setItem(STORAGE_KEYS.density, density);
      }
    }

    if (motion) {
      this.applyMotion(motion);
      if (persist) {
        localStorage.setItem(STORAGE_KEYS.motion, motion);
      }
    }

    if (widgetEditing !== undefined) {
      if (persist) {
        localStorage.setItem(STORAGE_KEYS.widgetEdit, widgetEditing ? "true" : "false");
      }
      document.dispatchEvent(
        new CustomEvent("widgets:set-edit", { detail: { enabled: widgetEditing } })
      );
    }
  },

  applyDensity(mode) {
    const { body } = document;
    if (!body) {
      return;
    }
    body.classList.remove("density-compact", "density-spacious");
    if (mode === "compact") {
      body.classList.add("density-compact");
    } else if (mode === "spacious") {
      body.classList.add("density-spacious");
    }
  },

  applyMotion(mode) {
    const { body } = document;
    if (!body) {
      return;
    }
    body.classList.remove("motion-subtle", "motion-playful");
    if (mode === "subtle") {
      body.classList.add("motion-subtle");
    } else if (mode === "playful") {
      body.classList.add("motion-playful");
    }
  },

  applyAccent(hex) {
    const normalized = this.normalizeHex(hex);
    if (!normalized) {
      return;
    }
    const rgb = this.hexToRgb(normalized);
    const light = this.blend(rgb, { r: 255, g: 255, b: 255 }, 0.28);
    const dark = this.blend(rgb, { r: 0, g: 0, b: 0 }, 0.2);

    const root = document.documentElement;
    root.style.setProperty("--primary", normalized);
    root.style.setProperty("--primary-rgb", this.rgbToString(rgb));
    root.style.setProperty("--primary-light", this.rgbToHex(light));
    root.style.setProperty("--primary-dark", this.rgbToHex(dark));
    root.style.setProperty("--accent", normalized);
    root.style.setProperty("--accent-rgb", this.rgbToString(rgb));
    document.dispatchEvent(new CustomEvent("contextual:refresh"));
  },

  resetAccent() {
    if (!this.baseVars) {
      return;
    }
    const root = document.documentElement;
    root.style.setProperty("--primary", this.baseVars.primary);
    root.style.setProperty("--primary-light", this.baseVars.primaryLight);
    root.style.setProperty("--primary-dark", this.baseVars.primaryDark);
    root.style.setProperty("--primary-rgb", this.baseVars.primaryRgb);
    root.style.setProperty("--accent", this.baseVars.accent || this.baseVars.primary);
    root.style.setProperty(
      "--accent-rgb",
      this.baseVars.accentRgb || this.baseVars.primaryRgb
    );
    document.dispatchEvent(new CustomEvent("contextual:refresh"));
  },

  normalizeHex(value) {
    if (!value || typeof value !== "string") {
      return null;
    }
    let hex = value.trim();
    if (!hex.startsWith("#")) {
      hex = `#${hex}`;
    }
    if (hex.length === 4) {
      hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
      return null;
    }
    return hex.toLowerCase();
  },

  hexToRgb(hex) {
    const normalized = hex.replace("#", "");
    const value = Number.parseInt(normalized, 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  },

  rgbToHex({ r, g, b }) {
    const toHex = (channel) => channel.toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  },

  rgbToString({ r, g, b }) {
    return `${r}, ${g}, ${b}`;
  },

  blend(color, target, amount) {
    return {
      r: Math.round(color.r + (target.r - color.r) * amount),
      g: Math.round(color.g + (target.g - color.g) * amount),
      b: Math.round(color.b + (target.b - color.b) * amount),
    };
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => personalization.init());
} else {
  personalization.init();
}

export default personalization;
