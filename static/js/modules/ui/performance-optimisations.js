import utils from "../utils.js";

const perfOptim = {
  _resizeHandler: null,

  init() {
    // Pause CSS animations/transitions when the tab is not visible to save CPU
    document.addEventListener("visibilitychange", () => {
      const root = document.documentElement;
      if (document.hidden) {
        root.style.setProperty("--transition-duration", "0ms");
      } else {
        root.style.removeProperty("--transition-duration");
      }
    });

    // Throttle window resize events using debounce
    this._resizeHandler = utils.debounce(() => {
      window.dispatchEvent(new Event("appResized"));
    }, 150);

    window.addEventListener("resize", this._resizeHandler);
  },
};

export default perfOptim;
