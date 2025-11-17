// UI-utils shim – exports the global utils (defined in legacy utils.js) for ESM consumers.
import "../utils.js";
const { utils } = window;

// Polyfills for fadeIn/fadeOut if the legacy utils didn't have them
if (!utils.fadeIn) {
  utils.fadeIn = (el, duration = 200) =>
    new Promise((resolve) => {
      if (!el) return resolve();
      el.style.opacity = 0;
      el.style.display = el.style.display || "block";
      el.style.transition = `opacity ${duration}ms`;
      requestAnimationFrame(() => {
        el.style.opacity = 1;
      });
      setTimeout(resolve, duration);
    });
}

if (!utils.fadeOut) {
  utils.fadeOut = (el, duration = 200) =>
    new Promise((resolve) => {
      if (!el) return resolve();
      el.style.opacity = 1;
      el.style.transition = `opacity ${duration}ms`;
      requestAnimationFrame(() => {
        el.style.opacity = 0;
      });
      setTimeout(() => {
        el.style.display = "none";
        resolve();
      }, duration);
    });
}

if (!utils.measureScrollbarWidth) {
  utils.measureScrollbarWidth = () =>
    window.innerWidth - document.documentElement.clientWidth;
}

if (!utils.showNotification) {
  utils.showNotification = (...args) =>
    window.notificationManager?.show?.(...args);
}

export { utils as default };

export const { handleError } = window;
