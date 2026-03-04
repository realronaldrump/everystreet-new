function setVisible(element, visible, display) {
  if (!element) {
    return;
  }
  if (visible) {
    element.hidden = false;
    if (display) {
      element.style.display = display;
    } else {
      element.style.removeProperty("display");
    }
    return;
  }
  element.hidden = true;
  element.style.display = "none";
}

export function createViewStateController(states = {}) {
  const entries = new Map();

  Object.entries(states).forEach(([stateName, config]) => {
    if (config?.element) {
      entries.set(stateName, {
        element: config.element,
        display: config.display || "",
      });
    }
  });

  return {
    show(stateName) {
      entries.forEach((config, name) => {
        setVisible(config.element, name === stateName, config.display);
      });
    },
    hideAll() {
      entries.forEach((config) => setVisible(config.element, false, config.display));
    },
  };
}

export default createViewStateController;
