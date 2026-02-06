/**
 * Simple Loading Manager
 * A lightweight, unified loading indicator for the application.
 */
class LoadingManager {
  constructor() {
    this.overlay = null;
    this.textElement = null;
    this.isVisible = false;
    this.activeCount = 0;
    this.activeOptions = { blocking: true, compact: false };
    this.hideTimeout = null;
    this.minShowTime = 200; // Minimum time to show overlay (prevents flicker)
    this.showStartTime = null;

    // Initialize when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.init());
    } else {
      this.init();
    }
  }

  init() {
    // Find or create the loading overlay
    this.overlay = document.querySelector(".loading-overlay");

    if (!this.overlay) {
      this.createOverlay();
    } else {
      this.textElement = this.overlay.querySelector(".loading-text");
    }
  }

  createOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.className = "loading-overlay";
    this.overlay.setAttribute("role", "status");
    this.overlay.setAttribute("aria-live", "polite");

    const indicator = document.createElement("div");
    indicator.className = "loading-indicator";

    const spinner = document.createElement("div");
    spinner.className = "loading-spinner";
    spinner.setAttribute("aria-hidden", "true");

    this.textElement = document.createElement("span");
    this.textElement.className = "loading-text";
    this.textElement.textContent = "Loading...";

    indicator.appendChild(spinner);
    indicator.appendChild(this.textElement);
    this.overlay.appendChild(indicator);
    document.body.appendChild(this.overlay);
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
    const messageOptions
      = typeof message === "object" && message !== null ? message : options;
    const messageText
      = typeof message === "object" && message !== null
        ? messageOptions.message || "Loading..."
        : message;

    const blocking
      = typeof messageOptions.blocking === "boolean" ? messageOptions.blocking : false;
    const compact = blocking
      ? false
      : typeof messageOptions.compact === "boolean"
        ? messageOptions.compact
        : true;
    this.activeOptions = { blocking, compact };

    // Cancel any pending hide
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    this.activeCount++;

    if (this.textElement) {
      this.textElement.textContent = messageText;
    }

    if (blocking === false) {
      this.overlay?.classList.add("non-blocking");
    } else {
      this.overlay?.classList.remove("non-blocking");
    }
    if (compact) {
      this.overlay?.classList.add("compact");
    } else {
      this.overlay?.classList.remove("compact");
    }

    if (!this.isVisible) {
      this.showStartTime = Date.now();
      this.overlay?.classList.add("visible");
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
    this.activeCount = Math.max(0, this.activeCount - 1);

    // Only hide if no active operations
    if (this.activeCount > 0) {
      return this;
    }

    // Ensure minimum show time to prevent flicker
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
    this.lastPulse = { message, duration, timestamp: Date.now() };
    // Create a temporary notification that doesn't block the UI
    const notification = document.createElement("div");
    notification.className = "loading-pulse";
    notification.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--surface-1, #1e1e1e);
      color: var(--text-primary, #fff);
      padding: 12px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      font-size: 14px;
      z-index: 9998;
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
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
      notification.style.transform = "translateX(-50%) translateY(20px)";
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

export { LoadingManager, loadingManager };
export default loadingManager;
