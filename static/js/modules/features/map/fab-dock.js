const MOBILE_BREAKPOINT = "(max-width: 768px)";
const DOCK_COLLAPSED_CLASS = "is-collapsed";

function isButtonActive(button) {
  return (
    button.classList.contains("active") ||
    button.getAttribute("aria-pressed") === "true"
  );
}

export default function initMapFabDock() {
  const dock = document.getElementById("map-fab-dock");
  const stack = document.getElementById("map-fab-dock-stack");
  const toggle = document.getElementById("map-fab-dock-toggle");
  const countBadge = document.getElementById("map-fab-dock-count");
  const icon = toggle?.querySelector?.("i") || null;
  const items = Array.from(stack?.querySelectorAll?.("[data-map-fab-item]") || []);

  if (!dock || !stack || !toggle || !items.length) {
    return {
      destroy() {},
      setExpanded() {},
      sync() {},
    };
  }

  let isExpanded = false;

  const isMobileViewport = () =>
    window.matchMedia
      ? window.matchMedia(MOBILE_BREAKPOINT).matches
      : window.innerWidth <= 768;

  const getActiveCount = () =>
    items.filter((button) => !button.hidden && isButtonActive(button)).length;

  const sync = () => {
    const activeCount = getActiveCount();
    const countLabel =
      activeCount > 0 ? `${activeCount} active feature${activeCount === 1 ? "" : "s"}` : "";

    dock.classList.toggle("has-active-items", activeCount > 0);
    toggle.classList.toggle("active", isExpanded || activeCount > 0);
    toggle.setAttribute("aria-expanded", String(isExpanded));
    toggle.setAttribute(
      "aria-label",
      isExpanded
        ? "Hide map feature toggles"
        : activeCount > 0
          ? `Show map feature toggles (${countLabel})`
          : "Show map feature toggles"
    );
    toggle.title = isExpanded
      ? "Hide map feature toggles"
      : activeCount > 0
        ? `Map feature toggles (${countLabel})`
        : "Map feature toggles";
    stack.setAttribute("aria-hidden", String(!isExpanded));

    if (countBadge) {
      countBadge.hidden = activeCount <= 0;
      countBadge.textContent = activeCount > 9 ? "9+" : String(activeCount);
      countBadge.setAttribute("aria-hidden", "true");
    }

    if (icon) {
      icon.className = isExpanded ? "fas fa-xmark" : "fas fa-sliders";
    }
  };

  const setExpanded = (expanded) => {
    isExpanded = Boolean(expanded);
    dock.classList.toggle(DOCK_COLLAPSED_CLASS, !isExpanded);
    sync();
  };

  const handleToggleClick = () => {
    setExpanded(!isExpanded);
  };

  const handleDocumentClick = (event) => {
    if (!isExpanded || dock.contains(event.target)) {
      return;
    }
    setExpanded(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape" && isExpanded) {
      setExpanded(false);
    }
  };

  const handleStackClick = (event) => {
    if (!isMobileViewport()) {
      return;
    }
    if (event.target.closest?.("[data-map-fab-item]")) {
      setExpanded(false);
    }
  };

  toggle.addEventListener("click", handleToggleClick);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeyDown);
  stack.addEventListener("click", handleStackClick);

  setExpanded(false);

  return {
    destroy() {
      toggle.removeEventListener("click", handleToggleClick);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
      stack.removeEventListener("click", handleStackClick);
    },
    setExpanded,
    sync,
  };
}
