import { CONFIG } from "./config.js";

class UIState {
  constructor() {
    this.elementCache = new Map();
    this.initialized = false;
    this.currentTheme = null;
    this.listeners = new WeakMap();
    this.activeModals = new Set();
    this.touchStartX = null;
    this.touchStartY = null;
    this.isMobile = typeof window !== "undefined" && window.innerWidth < CONFIG.UI.mobileBreakpoint;
    this.reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.uiState = this.loadUIState();
  }

  getElement(selector) {
    if (this.elementCache.has(selector)) return this.elementCache.get(selector);
    const el = document.querySelector(selector);
    if (el) this.elementCache.set(selector, el);
    return el;
  }

  getAllElements(selector) {
    const key = `all_${selector}`;
    if (this.elementCache.has(key)) return this.elementCache.get(key);
    const nodes = document.querySelectorAll(selector);
    this.elementCache.set(key, nodes);
    return nodes;
  }

  clearCache() {
    this.elementCache.clear();
  }

  loadUIState() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.uiState);
      return saved
        ? JSON.parse(saved)
        : {
            controlsMinimized: false,
            filtersOpen: false,
            lastFilterPreset: null,
          };
    } catch {
      return {
        controlsMinimized: false,
        filtersOpen: false,
        lastFilterPreset: null,
      };
    }
  }

  saveUIState() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.uiState, JSON.stringify(this.uiState));
    } catch (e) {
      console.warn("Failed to save UI state:", e);
    }
  }

  updateMobileState() {
    this.isMobile = window.innerWidth < CONFIG.UI.mobileBreakpoint;
    return this.isMobile;
  }
}

export const uiState = new UIState();
export default uiState;
