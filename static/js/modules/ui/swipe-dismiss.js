const swipeDismiss = {
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }
    document.addEventListener("shown.bs.modal", (event) => {
      const modal = event.target;
      if (modal) {
        this.bindModal(modal);
      }
    });
    this.initialized = true;
  },

  bindModal(modal) {
    if (modal.dataset.swipeBound === "true") {
      return;
    }
    const dialog = modal.querySelector(".modal-dialog");
    if (!dialog) {
      return;
    }
    modal.dataset.swipeBound = "true";

    let startY = 0;
    let currentY = 0;
    let startTime = 0;
    let dragging = false;

    const onPointerDown = (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      if (!this.canStartSwipe(event, modal, dialog)) {
        return;
      }
      dragging = true;
      startY = event.clientY;
      currentY = startY;
      startTime = performance.now();
      dialog.style.transition = "none";
      modal.classList.add("swipe-active");
    };

    const onPointerMove = (event) => {
      if (!dragging) {
        return;
      }
      currentY = event.clientY;
      const delta = Math.max(0, currentY - startY);
      if (delta < 4) {
        return;
      }
      dialog.style.transform = `translateY(${delta}px)`;
      dialog.style.opacity = `${Math.max(0.4, 1 - delta / 240)}`;
    };

    const onPointerUp = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      const delta = Math.max(0, currentY - startY);
      const duration = Math.max(1, performance.now() - startTime);
      const velocity = delta / duration;
      const shouldClose = delta > 120 || velocity > 0.6;

      dialog.style.transition = "";
      dialog.style.opacity = "";
      modal.classList.remove("swipe-active");

      if (shouldClose) {
        const instance = window.bootstrap?.Modal?.getInstance(modal);
        instance?.hide();
      } else {
        dialog.style.transform = "";
      }
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointermove", onPointerMove);
    dialog.addEventListener("pointerup", onPointerUp);
    dialog.addEventListener("pointercancel", onPointerUp);
  },

  canStartSwipe(event, modal, dialog) {
    if (modal.dataset.swipeDismiss === "false") {
      return false;
    }
    const rect = dialog.getBoundingClientRect();
    const inHandleZone = event.clientY - rect.top < 80;
    if (event.target.closest(".modal-header, [data-swipe-handle]")) {
      return true;
    }
    if (!inHandleZone) {
      return false;
    }
    const body = modal.querySelector(".modal-body");
    if (body && body.scrollTop > 0) {
      return false;
    }
    return true;
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => swipeDismiss.init());
} else {
  swipeDismiss.init();
}

export default swipeDismiss;
