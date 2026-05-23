const SELECT_SELECTOR =
  "select:not([multiple]):not([hidden]):not([data-native-select])";
const ENHANCED_CLASS = "es-native-select";
const WRAPPER_CLASS = "es-select";

let initialized = false;
let documentObserver = null;
let openInstance = null;
const instances = new WeakMap();

function cssEscape(value) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function getSelectLabel(select) {
  if (select.getAttribute("aria-label")) {
    return select.getAttribute("aria-label");
  }

  if (select.id) {
    const label = document.querySelector(`label[for="${cssEscape(select.id)}"]`);
    const text = label?.textContent?.replace(/\s+/g, " ").trim();
    if (text) {
      return text;
    }
  }

  const wrappingLabel = select.closest("label");
  const text = wrappingLabel?.textContent?.replace(/\s+/g, " ").trim();
  return text || "Select option";
}

function optionText(option) {
  return option?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function optionsForSelect(select) {
  return Array.from(select.options || []);
}

function selectedIndexFor(select) {
  if (select.selectedIndex >= 0) {
    return select.selectedIndex;
  }
  return optionsForSelect(select).findIndex((option) => !option.disabled);
}

function isPlaceholderOption(option) {
  if (!option) {
    return false;
  }
  return option.disabled && option.value === "";
}

function dispatchNativeSelectEvents(select) {
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

class AppSelect {
  constructor(select) {
    this.select = select;
    this.activeIndex = selectedIndexFor(select);
    this.optionButtons = [];

    this.wrapper = document.createElement("div");
    this.wrapper.className = WRAPPER_CLASS;
    if (select.classList.contains("form-select-sm")) {
      this.wrapper.classList.add("es-select--sm");
    }

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "es-select__button";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-label", getSelectLabel(select));
    this.button.innerHTML = `
      <span class="es-select__value"></span>
      <i class="fas fa-chevron-down es-select__chevron" aria-hidden="true"></i>
    `;
    this.valueEl = this.button.querySelector(".es-select__value");

    this.menu = document.createElement("div");
    this.menu.className = "es-select__menu";
    this.menu.setAttribute("role", "listbox");
    this.menu.setAttribute("tabindex", "-1");

    this.wrapper.append(this.button, this.menu);
    select.after(this.wrapper);
    select.classList.add(ENHANCED_CLASS);
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    this.handleButtonClick = () => this.toggle();
    this.handleButtonKeydown = (event) => this.onButtonKeydown(event);
    this.handleMenuKeydown = (event) => this.onMenuKeydown(event);
    this.handleSelectChange = () => this.render();
    this.handleInvalid = () => {
      this.wrapper.classList.add("is-invalid");
      this.button.focus();
    };

    this.button.addEventListener("click", this.handleButtonClick);
    this.button.addEventListener("keydown", this.handleButtonKeydown);
    this.menu.addEventListener("keydown", this.handleMenuKeydown);
    select.addEventListener("change", this.handleSelectChange);
    select.addEventListener("invalid", this.handleInvalid);

    this.optionsObserver = new MutationObserver(() => this.render());
    this.optionsObserver.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "label", "selected", "value"],
    });

    this.render();
  }

  render() {
    const options = optionsForSelect(this.select);
    const selectedIndex = selectedIndexFor(this.select);
    const selected = options[selectedIndex];
    const hasPlaceholder = isPlaceholderOption(selected);

    this.wrapper.classList.toggle("is-disabled", this.select.disabled);
    this.wrapper.classList.toggle("has-value", !hasPlaceholder);
    this.wrapper.classList.remove("is-invalid");
    this.button.disabled = this.select.disabled;
    this.valueEl.textContent = optionText(selected) || getSelectLabel(this.select);
    this.valueEl.classList.toggle("is-placeholder", hasPlaceholder);

    this.menu.innerHTML = "";
    this.optionButtons = options.map((option, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "es-select__option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
      item.dataset.index = String(index);
      item.disabled = option.disabled;
      item.textContent = optionText(option);
      item.addEventListener("click", () => this.commit(index));
      this.menu.append(item);
      return item;
    });

    this.activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  }

  open() {
    if (this.select.disabled) {
      return;
    }

    if (openInstance && openInstance !== this) {
      openInstance.close();
    }

    openInstance = this;
    this.wrapper.classList.add("is-open");
    this.button.setAttribute("aria-expanded", "true");
    this.focusOption(this.activeIndex);
  }

  close({ restoreFocus = false } = {}) {
    this.wrapper.classList.remove("is-open");
    this.button.setAttribute("aria-expanded", "false");
    if (openInstance === this) {
      openInstance = null;
    }
    if (restoreFocus) {
      this.button.focus();
    }
  }

  toggle() {
    if (this.wrapper.classList.contains("is-open")) {
      this.close();
      return;
    }
    this.open();
  }

  commit(index) {
    const option = this.select.options[index];
    if (!option || option.disabled) {
      return;
    }

    this.select.selectedIndex = index;
    this.activeIndex = index;
    this.render();
    dispatchNativeSelectEvents(this.select);
    this.close({ restoreFocus: true });
  }

  focusOption(index) {
    const nextIndex = this.findEnabledIndex(index, 1);
    const item = this.optionButtons[nextIndex];
    if (!item) {
      return;
    }
    this.activeIndex = nextIndex;
    item.focus();
  }

  findEnabledIndex(startIndex, direction) {
    if (!this.optionButtons.length) {
      return -1;
    }

    let index = Math.max(0, Math.min(startIndex, this.optionButtons.length - 1));
    for (let attempts = 0; attempts < this.optionButtons.length; attempts += 1) {
      if (!this.optionButtons[index]?.disabled) {
        return index;
      }
      index =
        (index + direction + this.optionButtons.length) % this.optionButtons.length;
    }
    return -1;
  }

  move(direction) {
    const next =
      direction > 0
        ? (this.activeIndex + 1) % this.optionButtons.length
        : (this.activeIndex - 1 + this.optionButtons.length) %
          this.optionButtons.length;
    this.focusOption(next);
  }

  onButtonKeydown(event) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      this.open();
    }
  }

  onMenuKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close({ restoreFocus: true });
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.move(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.focusOption(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      this.focusOption(this.optionButtons.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.commit(this.activeIndex);
    }
  }
}

export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || instances.has(select)) {
    return null;
  }

  if (!select.matches(SELECT_SELECTOR)) {
    return null;
  }

  if (select.closest(`.${WRAPPER_CLASS}`)) {
    return null;
  }

  const instance = new AppSelect(select);
  instances.set(select, instance);
  return instance;
}

export function enhanceSelects(root = document) {
  if (!root?.querySelectorAll) {
    return [];
  }
  return Array.from(root.querySelectorAll(SELECT_SELECTOR))
    .map((select) => enhanceSelect(select))
    .filter(Boolean);
}

export function initAppSelects() {
  if (initialized || typeof document === "undefined") {
    return;
  }

  initialized = true;
  enhanceSelects(document);

  document.addEventListener("click", (event) => {
    if (openInstance && !openInstance.wrapper.contains(event.target)) {
      openInstance.close();
    }
  });

  document.addEventListener("app:enhance-selects", (event) => {
    enhanceSelects(event.detail?.root || document);
  });

  documentObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) {
          return;
        }
        if (node.matches?.(SELECT_SELECTOR)) {
          enhanceSelect(node);
        }
        enhanceSelects(node);
      });
    });
  });
  documentObserver.observe(document.body, { childList: true, subtree: true });
}

export function resetAppSelectsForTests() {
  initialized = false;
  openInstance = null;
  documentObserver?.disconnect();
  documentObserver = null;
}
