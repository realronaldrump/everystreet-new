const swipeActions = {
  init() {
    this.bindItems();
    document.addEventListener("es:page-load", () => this.bindItems());
  },

  bindItems() {
    document.querySelectorAll("[data-swipe-actions]").forEach((item) => {
      if (item.dataset.swipeBound === "true") {
        return;
      }
      item.dataset.swipeBound = "true";
      const content =
        item.querySelector(".swipe-content") || item.firstElementChild;
      const maxShift = 120;
      let startX = 0;
      let currentX = 0;
      let dragging = false;

      const onStart = (event) => {
        if (!event.touches || event.touches.length !== 1) {
          return;
        }
        dragging = true;
        startX = event.touches[0].clientX;
        currentX = 0;
      };

      const onMove = (event) => {
        if (!dragging || !content || !event.touches) {
          return;
        }
        const deltaX = event.touches[0].clientX - startX;
        currentX = Math.max(-maxShift, Math.min(0, deltaX));
        content.style.transform = `translateX(${currentX}px)`;
      };

      const onEnd = () => {
        if (!dragging || !content) {
          return;
        }
        dragging = false;
        if (currentX < -60) {
          item.classList.add("open");
          content.style.transform = `translateX(-${maxShift}px)`;
        } else {
          item.classList.remove("open");
          content.style.transform = "";
        }
      };

      item.addEventListener("touchstart", onStart, { passive: true });
      item.addEventListener("touchmove", onMove, { passive: true });
      item.addEventListener("touchend", onEnd, { passive: true });
    });
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => swipeActions.init());
} else {
  swipeActions.init();
}

export default swipeActions;
