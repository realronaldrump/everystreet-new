import { CONFIG as MAP_CONFIG, UI_CONFIG as CONFIG } from "../config.js";
import uiState from "../ui-state.js";
import utils from "../ui-utils.js";
import eventManager from "./event-manager.js";

const themeManager = {
  init() {
    const saved = utils.getStorage(CONFIG.storage.theme);
    const systemPref = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    const initial = saved || systemPref;
    this.apply(initial, false);
    this.setupToggles();
    this.watchSystemPreference();
  },

  apply(theme, animate = true) {
    if (uiState.currentTheme === theme) return;
    const isLight = theme === "light";
    uiState.currentTheme = theme;

    if (animate && CONFIG.animations.enabled) {
      document.documentElement.style.transition =
        "background-color 0.3s ease, color 0.3s ease";
    }

    (
      utils.batchDOMUpdates ??
      utils.batchDomUpdates ??
      ((updates) => {
        updates.forEach((fn) => {
          fn();
        });
      })
    )([
      () => {
        document.body.classList.toggle(CONFIG.classes.lightMode, isLight);
        document.documentElement.setAttribute("data-bs-theme", theme);
      },
      () => this.updateMetaColor(theme),
      () => this.updateMapTheme(theme),
      () => this.syncToggles(theme),
      () => this.updateChartThemes(theme),
    ]);

    if (animate && CONFIG.animations.enabled) {
      setTimeout(() => {
        document.documentElement.style.transition = "";
      }, 300);
    }

    utils.setStorage(CONFIG.storage.theme, theme);
    document.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme } }));
  },

  updateMetaColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", CONFIG.themeColors[theme]);
  },

  updateMapTheme(theme) {
    if (!window.map || !window.map.setStyle) {
      document.addEventListener("appReady", () => this.updateMapTheme(theme), {
        once: true,
      });
      return;
    }
    const center = window.map.getCenter();
    const zoom = window.map.getZoom();
    const bearing = window.map.getBearing();
    const pitch = window.map.getPitch();

    if (MAP_CONFIG?.MAP?.styles?.[theme]) {
      const styleUrl = MAP_CONFIG.MAP.styles[theme];
      const restoreState = () => {
        window.map.jumpTo({ center, zoom, bearing, pitch });
        setTimeout(() => window.map.resize(), 100);
        document.dispatchEvent(
          new CustomEvent("mapStyleLoaded", { detail: { theme } })
        );
      };
      window.map.once("styledata", restoreState);
      window.map.setStyle(styleUrl);
    }
    document.dispatchEvent(new CustomEvent("mapThemeChanged", { detail: { theme } }));
  },

  updateChartThemes(theme) {
    if (!window.Chart) return;
    const charts = window.Chart.instances;
    if (!charts) return;
    Object.values(charts).forEach((chart) => {
      if (!chart || !chart.options) return;
      const isDark = theme === "dark";
      const textColor = isDark ? "#ffffff" : "#000000";
      const gridColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
      if (chart.options.scales) {
        Object.values(chart.options.scales).forEach((scale) => {
          if (scale.ticks) scale.ticks.color = textColor;
          if (scale.grid) scale.grid.color = gridColor;
        });
      }
      if (chart.options.plugins?.legend?.labels) {
        chart.options.plugins.legend.labels.color = textColor;
      }
      chart.update("none");
    });
  },

  syncToggles(theme) {
    const toggle = uiState.getElement(CONFIG.selectors.themeToggle);
    if (toggle) toggle.checked = theme === "light";
  },

  setupToggles() {
    const toggle = uiState.getElement(CONFIG.selectors.themeToggle);
    if (toggle) {
      eventManager.add(toggle, "change", () =>
        this.apply(toggle.checked ? "light" : "dark")
      );
    }
  },

  watchSystemPreference() {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      if (!utils.getStorage(CONFIG.storage.theme))
        this.apply(e.matches ? "dark" : "light");
    };
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
  },
};

if (!window.themeManager) window.themeManager = themeManager;
export { themeManager as default };
