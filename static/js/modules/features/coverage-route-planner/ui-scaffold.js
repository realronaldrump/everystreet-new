const MOBILE_QUERY = "(max-width: 1023px)";

export function setPlannerView(view) {
  const root = document.querySelector(".coverage-route-planner");
  const panel = document.getElementById("control-panel");
  const toggle = document.getElementById("mobile-panel-toggle");
  if (!root || !panel || !toggle) return;
  const isMap = view === "map";
  const isMobile = window.matchMedia(MOBILE_QUERY).matches;
  root.dataset.view = isMap ? "map" : "plan";
  panel.inert = isMobile && isMap;
  const map = root.querySelector(".map-container");
  if (map) map.inert = isMobile && !isMap;
  toggle.setAttribute("aria-expanded", String(!isMap));
  toggle.setAttribute("aria-label", isMap ? "Back to plan" : "View map");
  const label = toggle.querySelector(".toggle-text");
  if (label) label.textContent = isMap ? "Back to plan" : "View map";
  const icon = toggle.querySelector("i");
  if (icon) icon.className = isMap ? "fas fa-list" : "fas fa-map";
  document.dispatchEvent(new CustomEvent("plannerViewChanged", { detail: { view } }));
}

export function revealPlannerSection(id, { focus = false } = {}) {
  const section = document.getElementById(id);
  if (!section) return;
  setPlannerView("plan");
  section.classList.remove("is-collapsed");
  const disclosure = document.querySelector(`[aria-controls="${id}"]`);
  disclosure?.setAttribute("aria-expanded", "true");
  section.scrollIntoView({ block: "nearest", behavior: "instant" });
  if (focus) {
    section.setAttribute("tabindex", "-1");
    section.focus({ preventScroll: true });
  }
}

function initViewport({ signal, onCleanup }) {
  const root = document.querySelector(".coverage-route-planner");
  if (!root) return;
  const bottomNav = document.getElementById("bottom-nav");
  let frame = null;
  const apply = () => {
    frame = null;
    const top = Math.max(0, root.getBoundingClientRect().top);
    const navVisible =
      bottomNav &&
      getComputedStyle(bottomNav).display !== "none" &&
      !bottomNav.classList.contains("hidden");
    const offset = navVisible ? bottomNav.getBoundingClientRect().height : 0;
    root.style.setProperty("--planner-top", `${Math.round(top)}px`);
    root.style.setProperty("--bottom-nav-offset", `${Math.round(offset)}px`);
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(apply);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(root);
  if (bottomNav) observer.observe(bottomNav);
  const navObserver = new MutationObserver(schedule);
  if (bottomNav)
    navObserver.observe(bottomNav, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  window.addEventListener("resize", schedule, { signal, passive: true });
  window.visualViewport?.addEventListener("resize", schedule, {
    signal,
    passive: true,
  });
  schedule();
  onCleanup(() => {
    observer.disconnect();
    navObserver.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  });
}

function initCollapsibles({ signal }) {
  document.querySelectorAll(".widget-header.collapsible").forEach((header) => {
    const id = header.dataset.toggle;
    const content = document.getElementById(id);
    const button = header.querySelector(".btn-collapse");
    if (!content || !button) return;
    const key = `coverage-route-planner-${id}`;
    let saved = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      /* Storage is optional. */
    }
    const collapsed = saved
      ? saved === "collapsed"
      : header.hasAttribute("data-default-collapsed");
    content.classList.toggle("is-collapsed", collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    header.addEventListener(
      "click",
      (event) => {
        if (event.target.closest(".form-check")) return;
        const next = !content.classList.contains("is-collapsed");
        content.classList.toggle("is-collapsed", next);
        button.setAttribute("aria-expanded", String(!next));
        try {
          localStorage.setItem(key, next ? "collapsed" : "expanded");
        } catch {
          /* Storage is optional. */
        }
      },
      { signal }
    );
  });
}

export default function initCoverageRoutePlannerUi(context = {}) {
  const { signal = null, onCleanup = () => {} } = context;
  initViewport({ signal, onCleanup });
  initCollapsibles({ signal });
  const root = document.querySelector(".coverage-route-planner");
  const toggle = document.getElementById("mobile-panel-toggle");
  const media = window.matchMedia(MOBILE_QUERY);
  setPlannerView("plan");
  media.addEventListener("change", () => setPlannerView(root?.dataset.view || "plan"), {
    signal,
  });
  toggle?.addEventListener(
    "click",
    () => setPlannerView(root?.dataset.view === "map" ? "plan" : "map"),
    { signal }
  );
  document.getElementById("choose-area-btn")?.addEventListener(
    "click",
    () => {
      setPlannerView("plan");
      document.querySelector(".area-selector-widget .es-select__button")?.focus();
    },
    { signal }
  );

  const layers = document.getElementById("map-layers-menu");
  document.addEventListener(
    "click",
    (event) => {
      if (layers?.open && !layers.contains(event.target)) layers.open = false;
    },
    { signal }
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (layers?.open) {
        layers.open = false;
        layers.querySelector("summary")?.focus();
        event.preventDefault();
      } else if (media.matches && root?.dataset.view === "map") {
        setPlannerView("plan");
        toggle?.focus();
      }
    },
    { signal }
  );

  document.querySelectorAll(".layer-item").forEach((item) => {
    const slider = item.querySelector('input[type="range"]');
    const value = item.querySelector(".opacity-value");
    slider?.addEventListener(
      "input",
      () => {
        if (value) value.textContent = `${slider.value}%`;
      },
      { signal }
    );
  });
  const info = document.getElementById("algo-explainer-toggle");
  info?.addEventListener(
    "click",
    () => {
      const content = document.getElementById("algo-explainer");
      if (!content) return;
      const expanded = info.getAttribute("aria-expanded") === "true";
      content.hidden = expanded;
      info.setAttribute("aria-expanded", String(!expanded));
    },
    { signal }
  );
  const status = document.getElementById("status-message");
  status?.setAttribute("aria-live", "polite");
}
