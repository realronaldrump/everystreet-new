const modalEffects = {
  init() {
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
    });
  },
};

export default modalEffects;
