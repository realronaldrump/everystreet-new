import { uiState as state } from "../ui-state.js";

/**
 * Lightweight event management helper extracted from legacy modern-ui.js.
 * Provides add / delegate / once wrappers with internal bookkeeping so
 * listeners can be removed later if needed.
 */
const eventManager = {
  /**
   * Add event listeners to a single element (or selector).
   * - element: DOM node or selector string.
   * - events : single event or Array of events ("click", "keyup" …)
   * - handler: callback
   * - options: { passive: true, leftClickOnly: true }
   */
  add(element, events, handler, options = {}) {
    const el =
      typeof element === "string" ? state.getElement(element) : element;
    if (!el) return false;

    if (!state.listeners.has(el)) state.listeners.set(el, new Map());
    const eventList = Array.isArray(events) ? events : [events];
    const elementListeners = state.listeners.get(el);

    eventList.forEach((eventType) => {
      const key = `${eventType}_${handler.name || Math.random()}`;
      if (elementListeners.has(key)) return; // already registered

      const wrapped =
        options.leftClickOnly && eventType === "click"
          ? (e) => {
              if (e.button === 0) handler(e);
            }
          : handler;

      el.addEventListener(
        eventType,
        wrapped,
        options.passive ? { passive: true } : false,
      );
      elementListeners.set(key, { handler: wrapped, eventType });
    });

    return true;
  },

  /**
   * Event delegation.
   */
  delegate(container, selector, eventType, handler) {
    const containerEl =
      typeof container === "string" ? state.getElement(container) : container;
    if (!containerEl) return false;

    const delegated = (e) => {
      const target = e.target.closest(selector);
      if (target && containerEl.contains(target)) handler.call(target, e);
    };

    containerEl.addEventListener(eventType, delegated);
    return true;
  },

  /**
   * One–time listener.
   */
  once(element, event, handler) {
    const el =
      typeof element === "string" ? state.getElement(element) : element;
    if (!el) return false;

    const onceHandler = (e) => {
      handler(e);
      el.removeEventListener(event, onceHandler);
    };
    el.addEventListener(event, onceHandler);
    return true;
  },

  /**
   * Shorthand for adding a normal listener to a target (defaults to document).
   * Equivalent to: document.addEventListener(event, handler).
   */
  on(event, handler, target = document) {
    const el = typeof target === "string" ? state.getElement(target) : target;
    if (!el) return false;
    el.addEventListener(event, handler);
    return true;
  },

  /**
   * Emit a DOM CustomEvent on a target (defaults to document).
   * Consumers can listen via: document.addEventListener(eventName, handler)
   */
  emit(event, detail = {}, target = document) {
    const el = typeof target === "string" ? state.getElement(target) : target;
    if (!el) return false;
    el.dispatchEvent(new CustomEvent(event, { detail }));
    return true;
  },
};

export { eventManager as default };
