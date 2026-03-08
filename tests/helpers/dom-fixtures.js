export function createClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    contains(token) {
      return values.has(token);
    },
    toggle(token, force) {
      if (force === true) {
        values.add(token);
        return true;
      }
      if (force === false) {
        values.delete(token);
        return false;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
  };
}

export function createEventTarget(initial = {}) {
  const listeners = new Map();

  const addEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };

  const removeEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    listeners.set(
      type,
      handlers.filter((candidate) => candidate !== handler)
    );
  };

  const dispatchEvent = (event = {}) => {
    const handlers = listeners.get(event?.type || "") || [];
    handlers.forEach((handler) => handler(event));
    return true;
  };

  const dispatch = (typeOrEvent, payload = {}) => {
    if (typeof typeOrEvent === "string") {
      return dispatchEvent({ type: typeOrEvent, ...payload });
    }
    return dispatchEvent(typeOrEvent ?? {});
  };

  return {
    ...initial,
    listeners,
    style: initial.style || {},
    className: initial.className || "",
    textContent: initial.textContent || "",
    innerHTML: initial.innerHTML || "",
    addEventListener,
    removeEventListener,
    dispatch,
    dispatchEvent,
  };
}

export function createStorageMock(seed = {}) {
  const values = new Map(
    Object.entries(seed).map(([key, value]) => [key, String(value)])
  );
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

export function createCustomEventClass() {
  return class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail || null;
      this.bubbles = Boolean(init.bubbles);
    }
  };
}
