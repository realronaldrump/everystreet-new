import { CONFIG } from "../core/config.js";
import store from "../core/store.js";
import mapCore from "../map-core.js";
import { utils } from "../utils.js";
import eventManager from "./event-manager.js";

const themeManager = {
  init() {
    const saved = utils.getStorage(CONFIG.STORAGE_KEYS.theme);
    const systemPref = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    const initial = saved || systemPref;
    this.apply(initial, false);
    this.setupToggles();
    this.watchSystemPreference();
  },

  apply(theme, animate = true) {
    if (store.ui.theme === theme) {
      return;
    }
    const isLight = theme === "light";
    store.ui.theme = theme;

    if (animate && CONFIG.UI.animations.enabled) {
      document.documentElement.style.transition =
        "background-color 0.3s ease, color 0.3s ease";
    }

    (
      utils.batchDOMUpdates ??
      ((updates) => {
        updates.forEach((fn) => {
          fn();
        });
      })
    )([
      () => {
        document.body.classList.toggle(CONFIG.UI.classes.lightMode, isLight);
        document.documentElement.setAttribute("data-bs-theme", theme);
      },
      () => this.updateMetaColor(theme),
      () => this.updateMapTheme(theme),
      () => this.syncToggles(theme),
      () => this.updateChartThemes(theme),
    ]);

    if (animate && CONFIG.UI.animations.enabled) {
      setTimeout(() => {
        document.documentElement.style.transition = "";
      }, 300);
    }

    utils.setStorage(CONFIG.STORAGE_KEYS.theme, theme);
    document.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme } }));
  },

  updateMetaColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", CONFIG.UI.themeColors[theme]);
    }
  },

  updateMapTheme(theme) {
    if (!mapCore.isReady()) {
      document.addEventListener("appReady", () => this.updateMapTheme(theme), {
        once: true,
      });
      return;
    }

    if (CONFIG.MAP.styles?.[theme]) {
      void mapCore
        .setStyle(theme, { persistPreference: false })
        .catch((error) => {
          console.warn("Theme map style update failed:", error);
        });
    }
    document.dispatchEvent(new CustomEvent("mapThemeChanged", { detail: { theme } }));
  },

  updateChartThemes(theme) {
    if (!window.Chart) {
      return;
    }
    const charts = window.Chart.instances;
    if (!charts) {
      return;
    }
    Object.values(charts).forEach((chart) => {
      if (!chart || !chart.options) {
        return;
      }
      const isDark = theme === "dark";
      const textColor = isDark ? "#ffffff" : "#000000";
      const gridColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
      if (chart.options.scales) {
        Object.values(chart.options.scales).forEach((scale) => {
          if (scale.ticks) {
            scale.ticks.color = textColor;
          }
          if (scale.grid) {
            scale.grid.color = gridColor;
          }
        });
      }
      if (chart.options.plugins?.legend?.labels) {
        chart.options.plugins.legend.labels.color = textColor;
      }
      chart.update("none");
    });
  },

  syncToggles(theme) {
    const toggle = store.getElement(CONFIG.UI.selectors.themeToggle);
    if (toggle) {
      toggle.checked = theme === "light";
    }
  },

  setupToggles() {
    const toggle = store.getElement(CONFIG.UI.selectors.themeToggle);
    if (toggle) {
      eventManager.add(toggle, "change", () =>
        this.apply(toggle.checked ? "light" : "dark")
      );
    }
  },

  watchSystemPreference() {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      if (!utils.getStorage(CONFIG.STORAGE_KEYS.theme)) {
        this.apply(e.matches ? "dark" : "light");
      }
    };
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
    } else {
      mq.addListener(handler);
    }
  },
};

export default themeManager;
