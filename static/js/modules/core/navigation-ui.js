import { detailParent, transitionKind } from "./navigation-policy.js";
import { pathnameFromSwupUrl } from "./navigation-events.js";

export function createNavigationUI(navigate) {
  let backgroundUrl = null;
  let returnFocus = null;
  let pendingClose = false;
  let activeVisit = null;
  const namedElements = new Set();
  const dialog = document.getElementById("detail-dialog");

  const clearNames = () => {
    for (const element of namedElements)
      element.style.removeProperty("view-transition-name");
    namedElements.clear();
  };
  const nameElement = (element, name) => {
    if (!element) return;
    element.style.viewTransitionName = name;
    namedElements.add(element);
  };
  const closeDetail = () => {
    if (pendingClose) return;
    pendingClose = true;
    if (backgroundUrl && window.history.state?.source === "swup") window.history.back();
    else navigate(backgroundUrl || detailParent(window.location.pathname) || "/");
  };
  dialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDetail();
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target.closest("[data-detail-close]")) {
      event.preventDefault();
      closeDetail();
    }
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        closeDetail();
    }
  });

  return {
    isDetailVisit: (visit) => Boolean(detailParent(pathnameFromSwupUrl(visit.to.url))),
    isClosing: (visit) =>
      Boolean(
        backgroundUrl &&
          new URL(visit.to.url, location.origin).href ===
            new URL(backgroundUrl, location.origin).href
      ),
    prepare(visit) {
      activeVisit = visit;
      pendingClose = false;
      const from = pathnameFromSwupUrl(visit.from.url);
      const to = pathnameFromSwupUrl(visit.to.url);
      const detail = Boolean(detailParent(to));
      const closing = this.isClosing(visit);
      visit.meta.detailVisit = Boolean(visit.fragmentVisit && (detail || closing));
      visit.meta.closeDetail = closing;
      visit.meta.backgroundPath = pathnameFromSwupUrl(
        backgroundUrl || (detail ? visit.from.url : null)
      );
      visit.meta.backgroundUrl = backgroundUrl || (detail ? visit.from.url : null);
      visit.meta.motion = transitionKind(from, to, {
        backwards: visit.history.direction === "backwards",
        detail,
        closing,
      });
      if (detail || closing) {
        visit.scroll.reset = false;
        visit.a11y = { ...visit.a11y, focus: false };
      }
      // Keep the currently visible page styled underneath a detail drawer.
      document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        if (detail && !backgroundUrl) link.dataset.esBackgroundStyle = "true";
        if (!detail && !closing) delete link.dataset.esBackgroundStyle;
      });
      document.documentElement.dataset.navigationMotion = visit.meta.motion;
      document.getElementById("route-content")?.setAttribute("aria-busy", "true");
      if (detail && !backgroundUrl) visit.meta.returnFocus = document.activeElement;
      clearNames();
      const trigger = visit.trigger.el || document.activeElement;
      if (detail && !closing)
        nameElement(
          trigger?.closest?.("[data-trip-id], [data-area-id], .area-card"),
          "selected-record"
        );
      else nameElement(document.querySelector("#route-content h1"), "page-heading");
    },
    replaced(visit) {
      clearNames();
      if (visit.meta.motion)
        document.documentElement.dataset.navigationMotion = visit.meta.motion;
      const path = pathnameFromSwupUrl(visit.to.url);
      const detail = Boolean(detailParent(path));
      if (detail) {
        if (
          !backgroundUrl &&
          visit.meta.detailVisit &&
          !detailParent(pathnameFromSwupUrl(visit.from.url))
        ) {
          backgroundUrl = visit.meta.backgroundUrl;
          returnFocus = visit.meta.returnFocus;
        }
        if (dialog && !dialog.matches(":modal")) {
          dialog.removeAttribute("open");
          dialog.showModal();
        }
        nameElement(
          document.getElementById("detail-content")?.firstElementChild,
          "selected-record"
        );
      } else {
        dialog?.close();
        backgroundUrl = null;
        nameElement(document.querySelector("#route-content h1"), "page-heading");
      }
      const backgroundPath = detail ? pathnameFromSwupUrl(backgroundUrl) : null;
      if (backgroundPath) document.body.dataset.backgroundRoute = backgroundPath;
      else delete document.body.dataset.backgroundRoute;
      document.getElementById("route-content")?.removeAttribute("aria-busy");
    },
    viewed(visit) {
      if (detailParent(pathnameFromSwupUrl(visit.to.url))) {
        const heading = document.querySelector("#detail-content h1");
        const focus = heading || dialog?.querySelector("[data-detail-close]");
        focus?.setAttribute("tabindex", "-1");
        focus?.focus({ preventScroll: true });
      } else if (visit.meta.closeDetail) {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
      }
    },
    finish(visit) {
      if (activeVisit !== visit) return;
      clearNames();
      delete document.documentElement.dataset.navigationMotion;
      document.getElementById("route-content")?.removeAttribute("aria-busy");
      pendingClose = false;
    },
    get backgroundUrl() {
      return backgroundUrl;
    },
  };
}
