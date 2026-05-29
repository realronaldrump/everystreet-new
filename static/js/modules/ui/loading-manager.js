/**
 * Simple Loading Manager
 * A lightweight, unified loading indicator for the application.
 */
class LoadingManager {
  constructor() {
    this.hasDom = typeof document !== "undefined" && Boolean(document.body);
    this.overlay = null;
    this.textElement = null;
    this.isVisible = false;
    this.activeCount = 0;
    this.hideTimeout = null;
    this.minShowTime = 200; // Minimum time to show overlay (prevents flicker)
    this.showStartTime = null;

    if (!this.hasDom) {
      return;
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.init());
    } else {
      this.init();
    }
  }

  init() {
    if (!this.hasDom) {
      return;
    }

    this.overlay = document.querySelector(".loading-overlay");
    this.textElement = this.overlay?.querySelector(".loading-text") ?? null;
  }

  /**
   * Show the loading overlay
   * @param {string} message - Optional message to display
   * @param {Object} options - Optional display options
   * @param {boolean} options.blocking - Whether overlay should block interactions
   * @param {boolean} options.compact - Use compact positioning (top-right badge)
   * @returns {LoadingManager} - Returns this for chaining
   */
  show(message = "Loading...", options = {}) {
    if (!this.hasDom) {
      return this;
    }

    if (!this.overlay) {
      this.init();
    }
    if (!this.overlay) {
      return this;
    }

    const messageOptions =
      typeof message === "object" && message !== null ? message : options;
    const messageText =
      typeof message === "object" && message !== null
        ? messageOptions.message || "Loading..."
        : message;

    const blocking =
      typeof messageOptions.blocking === "boolean" ? messageOptions.blocking : false;
    const compact = blocking
      ? false
      : typeof messageOptions.compact === "boolean"
        ? messageOptions.compact
        : true;

    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    this.activeCount++;

    if (this.textElement) {
      this.textElement.textContent = messageText;
    }

    if (blocking === false) {
      this.overlay.classList.add("non-blocking");
    } else {
      this.overlay.classList.remove("non-blocking");
    }
    if (compact) {
      this.overlay.classList.add("compact");
    } else {
      this.overlay.classList.remove("compact");
    }

    if (!this.isVisible) {
      this.showStartTime = Date.now();
      this.overlay.classList.add("visible");
      document.body?.classList.add("is-busy");
      this.isVisible = true;
    }

    return this;
  }

  /**
   * Hide the loading overlay
   * @returns {LoadingManager} - Returns this for chaining
   */
  hide() {
    if (!this.hasDom) {
      return this;
    }
    if (!this.overlay) {
      this.activeCount = 0;
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
      this.isVisible = false;
      this.showStartTime = null;
      document.body?.classList.remove("is-busy");
      return this;
    }

    this.activeCount = Math.max(0, this.activeCount - 1);

    if (this.activeCount > 0) {
      return this;
    }

    const elapsed = this.showStartTime ? Date.now() - this.showStartTime : Infinity;
    const delay = Math.max(0, this.minShowTime - elapsed);

    this.hideTimeout = setTimeout(() => {
      if (this.activeCount === 0) {
        this.overlay?.classList.remove("visible");
        this.overlay?.classList.remove("non-blocking");
        this.overlay?.classList.remove("compact");
        this.isVisible = false;
        this.showStartTime = null;
        document.body?.classList.remove("is-busy");
      }
    }, delay);

    return this;
  }

  /**
   * Force hide regardless of active count
   * @returns {LoadingManager} - Returns this for chaining
   */
  forceHide() {
    if (!this.hasDom) {
      return this;
    }

    this.activeCount = 0;
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.overlay?.classList.remove("visible");
    this.overlay?.classList.remove("non-blocking");
    this.overlay?.classList.remove("compact");
    this.isVisible = false;
    this.showStartTime = null;
    document.body?.classList.remove("is-busy");
    return this;
  }

  /**
   * Update the loading message
   * @param {string} message - New message to display
   * @returns {LoadingManager} - Returns this for chaining
   */
  updateMessage(message) {
    if (!this.textElement) {
      this.init();
    }
    if (this.textElement) {
      this.textElement.textContent = message;
    }
    return this;
  }

  /**
   * Show a brief notification pulse (non-blocking)
   * @param {string} message - Message to display
   * @param {number} duration - How long to show (ms)
   */
  pulse(message, duration = 2000) {
    if (!this.hasDom) {
      return;
    }

    const notification = document.createElement("div");
    notification.className = "loading-pulse";
    notification.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: var(--glass-2, #1e1e1e);
      color: var(--text-primary, #fff);
      padding: 10px 20px;
      border-radius: 50px;
      border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      backdrop-filter: blur(12px);
      font-size: 13px;
      font-weight: 500;
      z-index: 9998;
      opacity: 0;
      transition: opacity 180ms cubic-bezier(0, 0, 0.2, 1), transform 180ms cubic-bezier(0, 0, 0.2, 1);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Animate in
    requestAnimationFrame(() => {
      notification.style.opacity = "1";
      notification.style.transform = "translateX(-50%) translateY(0)";
    });

    // Animate out and remove
    setTimeout(() => {
      notification.style.opacity = "0";
      notification.style.transform = "translateX(-50%) translateY(6px)";
      setTimeout(() => notification.remove(), 200);
    }, duration);
  }

  /**
   * Show an error state
   * @param {string} message - Error message
   */
  error(message) {
    console.error("Loading Error:", message);
    this.show(`Error: ${message}`);

    // Auto-hide after showing error
    setTimeout(() => this.forceHide(), 3000);
  }
}

const loadingManager = new LoadingManager();

export default loadingManager;
