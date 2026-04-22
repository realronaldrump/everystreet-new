/**
 * Scroll-Reveal & Parallax
 *
 * Observes elements with [data-reveal] and fades them in as they enter the
 * viewport, applying a stagger index per grouping. Also drives simple
 * per-element parallax via [data-parallax].
 */

import { swupReady } from "../core/navigation.js";

const REVEAL_SELECTOR = "[data-reveal]";
const PARALLAX_SELECTOR = "[data-parallax]";
const GROUP_ATTR = "data-reveal-group";

let observer = null;
let parallaxElements = [];
let parallaxTicking = false;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function assignStagger(root) {
  const groups = new Map();
  root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
    if (el.dataset.revealReady === "1") {
      return;
    }
    const groupKey = el.closest(`[${GROUP_ATTR}]`)?.getAttribute(GROUP_ATTR) || "default";
    const idx = groups.get(groupKey) ?? 0;
    el.style.setProperty("--reveal-i", String(idx));
    groups.set(groupKey, idx + 1);
    el.dataset.revealReady = "1";
  });
}

function ensureObserver() {
  if (observer || typeof IntersectionObserver === "undefined") {
    return observer;
  }
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  return observer;
}

function observeAll(root = document) {
  if (prefersReducedMotion()) {
    root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
      el.classList.add("is-visible");
    });
    return;
  }
  const obs = ensureObserver();
  if (!obs) {
    root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
      el.classList.add("is-visible");
    });
    return;
  }
  assignStagger(root);
  root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
    if (el.classList.contains("is-visible")) {
      return;
    }
    obs.observe(el);
  });
}

function collectParallax(root = document) {
  parallaxElements = Array.from(root.querySelectorAll(PARALLAX_SELECTOR));
}

function applyParallax() {
  parallaxTicking = false;
  if (!parallaxElements.length) {
    return;
  }
  const scrollY = window.scrollY;
  parallaxElements.forEach((el) => {
    const speed = Number(el.dataset.parallax) || 0.1;
    const offset = scrollY * speed;
    el.style.setProperty("--parallax-y", `${offset.toFixed(2)}px`);
  });
}

function onScroll() {
  if (parallaxTicking || prefersReducedMotion()) {
    return;
  }
  parallaxTicking = true;
  requestAnimationFrame(applyParallax);
}

function refresh() {
  observeAll(document);
  collectParallax(document);
  applyParallax();
}

function init() {
  if (typeof window === "undefined") {
    return;
  }
  refresh();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  swupReady
    .then((swup) => {
      swup.hooks.on("page:view", () => {
        window.setTimeout(refresh, 16);
      });
    })
    .catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export default { refresh };
export { refresh };
