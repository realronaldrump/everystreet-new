const modalEffects = {
  init() {
    const cleanupBackdrops = () => {
      if (document.querySelector(".modal.show")) {
        return;
      }
      document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.remove());
      document.body.classList.remove("modal-open");
      document.body.style.removeProperty("padding-right");
    };

    document.addEventListener("shown.bs.modal", (event) => {
      const modal = event.target;
      if (!modal) {
        return;
      }
      modal.classList.remove("is-closing");

      const focusable = modal.querySelector(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
      );
      if (focusable) {
        focusable.classList.add("focus-pulse");
        setTimeout(() => focusable.classList.remove("focus-pulse"), 700);
      }
    });

    document.addEventListener("hide.bs.modal", (event) => {
      const modal = event.target;
      if (modal) {
        modal.classList.add("is-closing");
      }
    });

    document.addEventListener("hidden.bs.modal", (event) => {
      const modal = event.target;
      if (modal) {
        modal.classList.remove("is-closing");
      }
      cleanupBackdrops();
    });

    document.addEventListener("es:page-load", cleanupBackdrops);
    document.addEventListener("es:page-unload", cleanupBackdrops);
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => modalEffects.init());
} else {
  modalEffects.init();
}

export default modalEffects;
