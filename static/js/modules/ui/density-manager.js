import { swupReady } from "../core/navigation.js";

const STORAGE_KEY = "es:ui-density";

const densityManager = {
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }

    window.densityManager = this;
    this.applyFromStorage();
    swupReady
      .then((swup) => {
        swup.hooks.on("page:view", () => this.applyFromStorage());
      })
      .catch(() => {});
    this.initialized = true;
  },

  applyFromStorage() {
    this.apply(localStorage.getItem(STORAGE_KEY) || "comfortable", {
      persist: false,
    });
  },

  apply(mode, { persist = true } = {}) {
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

    if (persist) {
      localStorage.setItem(STORAGE_KEY, mode);
    }
  },
};

export default densityManager;
