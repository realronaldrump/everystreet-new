import store from "./store.js";

const loadedScripts = new Set();

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const shouldHandleClick = (event, link) => {
  if (!link || event.defaultPrevented) {
    return false;
  }
  const href = link.getAttribute("href") || "";
  if (!href || href.startsWith("#")) {
    return false;
  }
  if (href.startsWith("mailto:") || href.startsWith("tel:")) {
    return false;
  }
  if (link.getAttribute("data-bs-toggle")) {
    return false;
  }
  if (link.hasAttribute("data-es-no-spa") || link.hasAttribute("data-no-spa")) {
    return false;
  }
  if (link.target && link.target !== "_self") {
    return false;
  }
  if (link.hasAttribute("download")) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const url = new URL(link.href, window.location.origin);
  if (url.origin !== window.location.origin) {
    return false;
  }
  return true;
};

const router = {
  initialized: false,
  inFlight: null,
  prefetchCache: new Map(),
  prefetchControllers: new Map(),
  prefetchDelay: 140,
  prefetchTTL: 60000,
  historyKey: "es:route-history",
  routeHistory: [],
  swipeState: {
    startX: 0,
    startY: 0,
    active: false,
  },

  init() {
    if (this.initialized) {
      return;
    }

    this.main =
      document.getElementById("route-content") ||
      document.getElementById("main-content");
    this.shell = document.getElementById("persistent-shell");
    this.scriptHost = document.getElementById("spa-scripts");
    this.announcer = document.getElementById("spa-announcer");
    this.routeHistory = this.loadHistory();
    this.updateHistory(window.location.pathname, document.title);
    this.prepareSharedElements();

    document.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!shouldHandleClick(event, link)) {
        return;
      }
      event.preventDefault();
      this.navigate(link.href, { push: true });
    });

    window.addEventListener("popstate", () => {
      this.navigate(window.location.href, { push: false, fromPopstate: true });
    });

    this.bindPrefetch();
    this.bindSwipeBack();
    this.updateBreadcrumb();
    this.initialized = true;
  },

  async navigate(
    url,
    { push = true, fromPopstate = false, force = false } = {},
  ) {
    if (!this.main) {
      window.location.href = url;
      return;
    }

    const nextUrl = new URL(url, window.location.origin);
    if (nextUrl.href === window.location.href && !fromPopstate && !force) {
      return;
    }

    this.setTransitionDirection(nextUrl, { fromPopstate });

    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }

    const controller = new AbortController();
    this.inFlight = controller;

    window.loadingManager?.showBar?.("Loading page...");
    document.dispatchEvent(
      new CustomEvent("es:page-unload", {
        detail: { url: window.location.href, nextUrl: nextUrl.href },
      }),
    );

    try {
      let html = this.getPrefetched(nextUrl.href);
      if (!html) {
        const response = await fetch(nextUrl.href, {
          headers: {
            "X-ES-Partial": "1",
            "X-Requested-With": "spa",
          },
          credentials: "same-origin",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        html = await response.text();
      }
      const fragment = this.parseFragment(html);
      if (!fragment) {
        throw new Error("Missing SPA fragment");
      }

      this.prepareSharedElements();
      const apply = () => {
        this.applyFragment(fragment, { push });
        this.prepareSharedElements();
      };

      if ("startViewTransition" in document && !prefersReducedMotion()) {
        await document.startViewTransition(apply).finished;
      } else {
        this.main.classList.add("is-transitioning");
        await apply();
        requestAnimationFrame(() =>
          this.main.classList.remove("is-transitioning"),
        );
      }

      if (push && window.history.pushState) {
        window.history.pushState({ es: true }, "", nextUrl.href);
      }

      if (fromPopstate) {
        store.applyUrlParams(nextUrl.href, { emit: true, source: "popstate" });
      } else {
        store.applyUrlParams(nextUrl.href, { emit: true, source: "navigate" });
      }

      this.dispatchPageLoad(fragment);
      this.updateHistory(fragment.path || nextUrl.pathname, fragment.title);
      this.updateBreadcrumb(fragment);
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      console.warn("SPA navigation failed, falling back to full load:", error);
      window.location.href = url;
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = null;
      }
      window.loadingManager?.hideBar?.();
    }
  },

  parseFragment(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const root = doc.querySelector("#es-spa-fragment");
    if (!root) {
      return null;
    }

    return {
      title: root.dataset.esTitle || "",
      path: root.dataset.esPath || "",
      url: root.dataset.esUrl || "",
      head: root.querySelector("template[data-es-head]")?.innerHTML || "",
      content: root.querySelector("template[data-es-content]")?.innerHTML || "",
      scripts: root.querySelector("template[data-es-scripts]")?.innerHTML || "",
      shell: root.querySelector("template[data-es-shell]")?.innerHTML || "",
    };
  },

  async applyFragment(fragment, { push } = {}) {
    this.updateHead(fragment.head);
    this.updateShell(fragment.shell, fragment.path);
    this.updateContent(fragment.content);
    await this.updateScripts(fragment.scripts);
    this.updateTitle(fragment.title);
    this.updateRoute(fragment.path);
    this.updateNav(fragment.path);
    this.restoreFocus(fragment);
    if (push) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  },

  updateHead(headHtml) {
    document.querySelectorAll("[data-es-dynamic='head']").forEach((node) => {
      node.remove();
    });

    if (!headHtml) {
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = headHtml;
    Array.from(template.content.children).forEach((node) => {
      node.setAttribute("data-es-dynamic", "head");
      document.head.appendChild(node);
    });
  },

  updateContent(contentHtml) {
    this.main.innerHTML = contentHtml || "";
  },

  updateShell(shellHtml, path) {
    if (!this.shell) {
      return;
    }

    const trimmed = (shellHtml || "").trim();
    if (trimmed) {
      const template = document.createElement("template");
      template.innerHTML = trimmed;
      const incomingRoot = template.content.firstElementChild;
      const incomingId = incomingRoot?.dataset?.esShellId;
      const existingId = this.shell.firstElementChild?.dataset?.esShellId;
      if (!incomingId || incomingId !== existingId) {
        this.shell.innerHTML = "";
        this.shell.appendChild(template.content);
      }
    }

    this.shell.setAttribute("data-shell-active", trimmed ? "true" : "false");
    if (path) {
      this.shell.setAttribute("data-shell-route", path);
    }
  },

  async updateScripts(scriptsHtml) {
    if (!this.scriptHost) {
      return;
    }

    Array.from(
      this.scriptHost.querySelectorAll("[data-es-dynamic='script']"),
    ).forEach((node) => node.remove());

    if (!scriptsHtml) {
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = scriptsHtml;
    const nodes = Array.from(template.content.querySelectorAll("script"));
    for (const node of nodes) {
      const script = document.createElement("script");
      Array.from(node.attributes).forEach((attr) => {
        script.setAttribute(attr.name, attr.value);
      });
      script.setAttribute("data-es-dynamic", "script");

      if (node.src) {
        const src = node.src;
        if (loadedScripts.has(src)) {
          continue;
        }
        loadedScripts.add(src);
        script.src = src;
        const loadPromise = new Promise((resolve, reject) => {
          script.addEventListener("load", resolve, { once: true });
          script.addEventListener("error", () =>
            reject(new Error(`Failed to load ${src}`)),
          );
        });
        this.scriptHost.appendChild(script);
        await Promise.allSettled([loadPromise]);
        continue;
      }

      script.textContent = node.textContent;
      this.scriptHost.appendChild(script);
    }
  },

  updateTitle(title) {
    if (title) {
      document.title = title;
    }
  },

  updateRoute(path) {
    if (!path) {
      return;
    }
    document.body.dataset.route = path;
    document.body.classList.toggle("map-page", path === "/map");
    if (this.shell) {
      const isMap = path === "/map";
      this.shell.setAttribute("aria-hidden", isMap ? "false" : "true");
    }
    if (this.announcer) {
      this.announcer.textContent = `Navigated to ${document.title}`;
    }
  },

  updateNav(path) {
    if (!path) {
      return;
    }
    const isRealLink = (anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#")) {
        return false;
      }
      if (href.startsWith("mailto:") || href.startsWith("tel:")) {
        return false;
      }
      if (anchor.getAttribute("data-bs-toggle")) {
        return false;
      }
      return true;
    };
    const anchors = document.querySelectorAll("nav a[href]");
    anchors.forEach((anchor) => {
      if (!isRealLink(anchor)) {
        return;
      }
      const url = new URL(anchor.href, window.location.origin);
      const isActive = url.pathname === path;
      anchor.classList.toggle("active", isActive);
      if (isActive) {
        anchor.setAttribute("aria-current", "page");
      } else {
        anchor.removeAttribute("aria-current");
      }
    });
    document.querySelectorAll(".nav-item").forEach((item) => {
      const link = item.querySelector("a[href]");
      if (!link || !isRealLink(link)) {
        return;
      }
      const url = new URL(link.href, window.location.origin);
      item.classList.toggle("active", url.pathname === path);
    });
  },

  restoreFocus() {
    let focusTarget =
      this.main.querySelector("[data-es-focus]") ||
      this.main.querySelector("h1, h2, [role='heading']");

    if (!focusTarget) {
      const globalFocus = document.querySelector("[data-es-focus]");
      if (globalFocus && !globalFocus.closest("[aria-hidden='true']")) {
        focusTarget = globalFocus;
      }
    }

    if (!focusTarget) {
      focusTarget = document.getElementById("main-content");
    }

    if (focusTarget && typeof focusTarget.focus === "function") {
      const isNaturallyFocusable =
        focusTarget.matches?.(
          "a[href], button, input, select, textarea, details, summary, [tabindex]",
        ) || false;
      if (!isNaturallyFocusable) {
        focusTarget.setAttribute("tabindex", "-1");
      }
      focusTarget.focus({ preventScroll: true });
    }
  },

  dispatchPageLoad(fragment) {
    document.dispatchEvent(
      new CustomEvent("es:page-load", {
        detail: {
          path: fragment.path,
          url: fragment.url,
        },
      }),
    );
  },

  setTransitionDirection(nextUrl, { fromPopstate = false } = {}) {
    let direction = "forward";
    if (fromPopstate) {
      direction = "back";
    } else if (this.routeHistory.length > 1) {
      const previous = this.routeHistory[this.routeHistory.length - 2];
      if (previous?.path === nextUrl.pathname) {
        direction = "back";
      }
    }

    document.documentElement.dataset.navDirection = direction;
    const enterX = direction === "back" ? "-20px" : "20px";
    const exitX = direction === "back" ? "20px" : "-20px";
    document.documentElement.style.setProperty("--nav-enter-x", enterX);
    document.documentElement.style.setProperty("--nav-exit-x", exitX);
  },

  prepareSharedElements() {
    let index = 0;
    document.querySelectorAll("[data-shared-transition]").forEach((element) => {
      const name =
        element.dataset.sharedTransition || element.id || `shared-${index}`;
      element.style.viewTransitionName = name;
      index += 1;
    });
  },

  bindPrefetch() {
    let hoverTimer = null;
    const schedule = (link) => {
      if (!this.shouldPrefetch(link)) {
        return;
      }
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      hoverTimer = setTimeout(
        () => this.prefetch(link.href),
        this.prefetchDelay,
      );
    };

    document.addEventListener("pointerover", (event) => {
      const link = event.target.closest("a");
      if (!link) {
        return;
      }
      schedule(link);
    });

    document.addEventListener("focusin", (event) => {
      const link = event.target.closest("a");
      if (!link) {
        return;
      }
      schedule(link);
    });
  },

  shouldPrefetch(link) {
    if (!link) {
      return false;
    }
    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#")) {
      return false;
    }
    if (href.startsWith("mailto:") || href.startsWith("tel:")) {
      return false;
    }
    if (link.getAttribute("data-bs-toggle")) {
      return false;
    }
    if (
      link.hasAttribute("data-es-no-spa") ||
      link.hasAttribute("data-no-spa")
    ) {
      return false;
    }
    if (link.hasAttribute("data-no-prefetch")) {
      return false;
    }
    const url = new URL(link.href, window.location.origin);
    return url.origin === window.location.origin;
  },

  getPrefetched(url) {
    const cached = this.prefetchCache.get(url);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp > this.prefetchTTL) {
      this.prefetchCache.delete(url);
      return null;
    }
    this.prefetchCache.delete(url);
    return cached.html;
  },

  async prefetch(url) {
    if (!url || this.prefetchControllers.has(url)) {
      return;
    }
    const cached = this.prefetchCache.get(url);
    if (cached && Date.now() - cached.timestamp < this.prefetchTTL) {
      return;
    }

    const controller = new AbortController();
    this.prefetchControllers.set(url, controller);
    try {
      const response = await fetch(url, {
        headers: {
          "X-ES-Partial": "1",
          "X-Requested-With": "spa",
        },
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        return;
      }
      const html = await response.text();
      this.prefetchCache.set(url, { html, timestamp: Date.now() });
    } catch {
      // Prefetch is opportunistic.
    } finally {
      this.prefetchControllers.delete(url);
    }
  },

  loadHistory() {
    try {
      const raw = sessionStorage.getItem(this.historyKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(-8);
      }
    } catch {
      // Ignore parse errors.
    }
    return [
      {
        path: window.location.pathname,
        title: document.title,
        timestamp: Date.now(),
      },
    ];
  },

  saveHistory() {
    try {
      sessionStorage.setItem(
        this.historyKey,
        JSON.stringify(this.routeHistory.slice(-8)),
      );
    } catch {
      // Ignore storage failures.
    }
  },

  updateHistory(path, title) {
    if (!path) {
      return;
    }
    const label = title || document.title || path;
    const now = Date.now();
    const last = this.routeHistory[this.routeHistory.length - 1];
    if (last && last.path === path) {
      last.title = label;
      last.timestamp = now;
    } else {
      this.routeHistory.push({ path, title: label, timestamp: now });
    }
    if (this.routeHistory.length > 8) {
      this.routeHistory = this.routeHistory.slice(-8);
    }
    this.saveHistory();
    this.updateUsage(path);
  },

  updateUsage(path) {
    try {
      const raw = localStorage.getItem("es:route-counts");
      const counts = raw ? JSON.parse(raw) : {};
      counts[path] = (counts[path] || 0) + 1;
      localStorage.setItem("es:route-counts", JSON.stringify(counts));
    } catch {
      // Ignore storage failures.
    }
  },

  updateBreadcrumb(fragment) {
    const trail = document.getElementById("nav-trail");
    const container = document.getElementById("nav-breadcrumb");
    if (!trail || !container) {
      return;
    }

    const items = this.routeHistory.slice(-3);
    trail.innerHTML = "";

    items.forEach((item, index) => {
      if (index > 0) {
        const divider = document.createElement("span");
        divider.className = "nav-trail-sep";
        divider.textContent = "›";
        trail.appendChild(divider);
      }
      const link = document.createElement("a");
      link.href = item.path;
      link.className = "nav-trail-item";
      link.textContent = item.title || item.path;
      if (index === items.length - 1) {
        link.setAttribute("aria-current", "page");
        link.classList.add("current");
      }
      trail.appendChild(link);
    });

    container.classList.toggle("is-empty", items.length === 0);
  },

  bindSwipeBack() {
    document.addEventListener(
      "touchstart",
      (event) => {
        if (!event.touches || event.touches.length !== 1) {
          return;
        }
        if (
          event.target.closest(
            "[data-gesture-ignore], .mapboxgl-canvas-container",
          )
        ) {
          return;
        }
        const touch = event.touches[0];
        if (touch.clientX > 28) {
          return;
        }
        this.swipeState.active = true;
        this.swipeState.startX = touch.clientX;
        this.swipeState.startY = touch.clientY;
      },
      { passive: true },
    );

    document.addEventListener(
      "touchend",
      (event) => {
        if (!this.swipeState.active) {
          return;
        }
        const touch = event.changedTouches?.[0];
        if (!touch) {
          this.swipeState.active = false;
          return;
        }
        const deltaX = touch.clientX - this.swipeState.startX;
        const deltaY = Math.abs(touch.clientY - this.swipeState.startY);
        this.swipeState.active = false;

        if (deltaX > 90 && deltaY < 60 && window.history.length > 1) {
          window.history.back();
        }
      },
      { passive: true },
    );
  },
};

export default router;
