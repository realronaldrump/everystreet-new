const widgetManager = {
  editMode: false,
  dragItem: null,
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }
    this.refresh();
    document.addEventListener("widgets:toggle-edit", () => this.toggleEdit());
    document.addEventListener("widgets:set-edit", (event) => {
      this.setEdit(Boolean(event.detail?.enabled));
    });
    document.addEventListener("es:page-load", () => this.refresh());
    this.initialized = true;
  },

  refresh() {
    this.containers = Array.from(document.querySelectorAll("[data-widget-container]"));
    this.containers.forEach((container) => {
      this.applyOrder(container);
      if (this.editMode) {
        this.enableEdit(container, true);
      }
    });
  },

  toggleEdit() {
    this.editMode = !this.editMode;
    this.containers.forEach((container) => this.enableEdit(container, this.editMode));
    this.storeEditState();
    document.dispatchEvent(
      new CustomEvent("widgets:edit-toggled", { detail: { enabled: this.editMode } })
    );
  },

  setEdit(enabled) {
    if (this.editMode === enabled) {
      return;
    }
    this.editMode = enabled;
    this.containers.forEach((container) => this.enableEdit(container, this.editMode));
    this.storeEditState();
    document.dispatchEvent(
      new CustomEvent("widgets:edit-toggled", { detail: { enabled: this.editMode } })
    );
  },

  storeEditState() {
    try {
      localStorage.setItem("es:widget-editing", this.editMode ? "true" : "false");
    } catch {
      // Ignore storage failures.
    }
  },

  enableEdit(container, enable) {
    container.dataset.widgetEditing = enable ? "true" : "false";
    const items = container.querySelectorAll("[data-widget-id]");
    items.forEach((item) => {
      item.setAttribute("draggable", enable ? "true" : "false");
      item.classList.toggle("is-draggable", enable);

      if (enable && !item.dataset.dragBound) {
        item.dataset.dragBound = "true";
        item.addEventListener("dragstart", (event) => {
          this.dragItem = item;
          item.classList.add("is-dragging");
          event.dataTransfer.effectAllowed = "move";
        });
        item.addEventListener("dragend", () => {
          item.classList.remove("is-dragging");
          this.dragItem = null;
          this.saveOrder(container);
        });
      }
    });

    if (enable && !container.dataset.dragContainerBound) {
      container.dataset.dragContainerBound = "true";
      container.addEventListener("dragover", (event) => {
        event.preventDefault();
        const after = this.getDragAfterElement(container, event.clientY);
        if (!this.dragItem) {
          return;
        }
        if (after == null) {
          container.appendChild(this.dragItem);
        } else {
          container.insertBefore(this.dragItem, after);
        }
      });
    }
  },

  getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll("[data-widget-id]:not(.is-dragging)")];
    return items
      .map((item) => {
        const box = item.getBoundingClientRect();
        return { item, offset: y - box.top - box.height / 2 };
      })
      .filter((entry) => entry.offset < 0)
      .sort((a, b) => a.offset - b.offset)[0]?.item;
  },

  applyOrder(container) {
    const key = this.getStorageKey(container);
    const raw = localStorage.getItem(key);
    if (!raw) {
      return;
    }
    try {
      const order = JSON.parse(raw);
      if (!Array.isArray(order)) {
        return;
      }
      order.forEach((id) => {
        const item = container.querySelector(`[data-widget-id="${id}"]`);
        if (item) {
          container.appendChild(item);
        }
      });
    } catch {
      // Ignore parse errors.
    }
  },

  saveOrder(container) {
    const key = this.getStorageKey(container);
    const order = Array.from(container.querySelectorAll("[data-widget-id]")).map(
      (item) => item.dataset.widgetId
    );
    localStorage.setItem(key, JSON.stringify(order));
  },

  getStorageKey(container) {
    const id = container.dataset.widgetContainer || container.id || "widgets";
    const path = document.body.dataset.route || window.location.pathname;
    return `es:widget-order:${path}:${id}`;
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => widgetManager.init());
} else {
  widgetManager.init();
}

export default widgetManager;
