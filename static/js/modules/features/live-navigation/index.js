/**
 * Live Navigation Entry Point
 *
 * This file initializes the modular live navigation system.
 * The implementation is split across multiple modules in
 * /static/js/modules/live-navigation/ for better organization and maintainability.
 */

import LiveNavigationNavigator from "../../live-navigation/live-navigation-navigator.js";

export default function initLiveNavigationPage({ cleanup } = {}) {
  const navigator = new LiveNavigationNavigator();
  navigator.init();
  const teardown = () => navigator.destroy();
  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}
