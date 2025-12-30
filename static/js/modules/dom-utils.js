/**
 * DOM Utilities Module
 * Safe DOM manipulation helpers to prevent XSS and memory leaks
 */

/**
 * Create an element with safe attributes and content
 * @param {string} tag - HTML tag name
 * @param {Object} options - Element options
 * @returns {HTMLElement}
 */
export function el(tag, options = {}) {
  const element = document.createElement(tag);

  if (options.text) {
    element.textContent = options.text;
  }

  if (options.html && options.trusted) {
    // Only use innerHTML for trusted, developer-controlled content
    element.innerHTML = options.html;
  }

  if (options.className) {
    element.className = options.className;
  }

  if (options.id) {
    element.id = options.id;
  }

  if (options.attrs) {
    Object.entries(options.attrs).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        element.setAttribute(key, String(value));
      }
    });
  }

  if (options.style) {
    Object.assign(element.style, options.style);
  }

  if (options.data) {
    Object.entries(options.data).forEach(([key, value]) => {
      element.dataset[key] = String(value);
    });
  }

  if (options.children) {
    const fragment = document.createDocumentFragment();
    options.children.forEach((child) => {
      if (child instanceof Node) {
        fragment.appendChild(child);
      } else if (typeof child === "string") {
        fragment.appendChild(document.createTextNode(child));
      }
    });
    element.appendChild(fragment);
  }

  if (options.on) {
    Object.entries(options.on).forEach(([event, handler]) => {
      element.addEventListener(event, handler);
    });
  }

  return element;
}

/**
 * Event delegation manager for dynamic content
 * Avoids memory leaks by using event delegation on a static parent
 */
export class EventDelegator {
  constructor(container) {
    this.container =
      typeof container === "string" ? document.querySelector(container) : container;
    this.handlers = new Map();
  }

  /**
   * Add delegated event listener
   * @param {string} event - Event type (click, change, etc.)
   * @param {string} selector - CSS selector to match
   * @param {Function} handler - Event handler
   */
  on(event, selector, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);

      const delegatedHandler = (e) => {
        const handlers = this.handlers.get(event) || [];
        for (const { selector: sel, handler: h } of handlers) {
          const target = e.target.closest(sel);
          if (target && this.container.contains(target)) {
            h.call(target, e, target);
          }
        }
      };

      this.container.addEventListener(event, delegatedHandler);
    }

    this.handlers.get(event).push({ selector, handler });
    return this;
  }

  /**
   * Remove all handlers for an event/selector combination
   */
  off(event, selector = null) {
    if (!this.handlers.has(event)) return this;

    if (selector) {
      const handlers = this.handlers.get(event);
      const filtered = handlers.filter((h) => h.selector !== selector);
      this.handlers.set(event, filtered);
    } else {
      this.handlers.delete(event);
    }

    return this;
  }

  /**
   * Cleanup all handlers
   */
  destroy() {
    this.handlers.clear();
  }
}

/**
 * Batch DOM updates using requestAnimationFrame
 * @param {Function[]} updates - Array of update functions
 */
export function batchUpdate(updates) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const fragment = document.createDocumentFragment();
      updates.forEach((update) => {
        const result = update(fragment);
        if (result instanceof Node) {
          fragment.appendChild(result);
        }
      });
      resolve(fragment);
    });
  });
}

/**
 * Safely update innerHTML by first removing all event listeners
 * @param {HTMLElement} element - Target element
 * @param {string} html - HTML content (should be developer-controlled only)
 */
export function safeReplaceContent(element, html) {
  // Clone and replace to remove all event listeners
  const clone = element.cloneNode(false);
  clone.innerHTML = html;
  element.replaceWith(clone);
  return clone;
}

/**
 * Create a document fragment from an array of elements
 * @param {HTMLElement[]} elements - Array of elements
 * @returns {DocumentFragment}
 */
export function createFragment(elements) {
  const fragment = document.createDocumentFragment();
  elements.forEach((el) => {
    if (el instanceof Node) {
      fragment.appendChild(el);
    }
  });
  return fragment;
}

/**
 * Wait for an element to appear in the DOM
 * @param {string} selector - CSS selector
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<Element|null>}
 */
export function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver((_mutations, obs) => {
      const element = document.querySelector(selector);
      if (element) {
        obs.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

export default {
  el,
  EventDelegator,
  batchUpdate,
  safeReplaceContent,
  createFragment,
  waitForElement,
};
