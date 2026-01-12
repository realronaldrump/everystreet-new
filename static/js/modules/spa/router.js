import store from "./store.js";

const loadedScripts = new Set();

const prefersReducedMotion = () =>
  typeof window !== "undefined"
  && window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  init() {
    if (this.initialized) {
      return;
    }

    this.main = document.getElementById("route-content")
      || document.getElementById("main-content");
    this.shell = document.getElementById("persistent-shell");
    this.scriptHost = document.getElementById("spa-scripts");
    this.announcer = document.getElementById("spa-announcer");

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

    this.initialized = true;
  },

  async navigate(url, { push = true, fromPopstate = false } = {}) {
    if (!this.main) {
      window.location.href = url;
      return;
    }

    const nextUrl = new URL(url, window.location.origin);
    if (nextUrl.href === window.location.href && !fromPopstate) {
      return;
    }

    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }

    const controller = new AbortController();
    this.inFlight = controller;

    window.loadingManager?.show("Loading...", { blocking: false });
    document.dispatchEvent(
      new CustomEvent("es:page-unload", {
        detail: { url: window.location.href, nextUrl: nextUrl.href },
      })
    );

    try {
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

      const html = await response.text();
      const fragment = this.parseFragment(html);
      if (!fragment) {
        throw new Error("Missing SPA fragment");
      }

      const apply = () => this.applyFragment(fragment, { push });

      if ("startViewTransition" in document && !prefersReducedMotion()) {
        await document.startViewTransition(apply).finished;
      } else {
        this.main.classList.add("is-transitioning");
        await apply();
        requestAnimationFrame(() => this.main.classList.remove("is-transitioning"));
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
      window.loadingManager?.hide();
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

    Array.from(this.scriptHost.querySelectorAll("[data-es-dynamic='script']")).forEach(
      (node) => node.remove()
    );

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
          script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
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
    let focusTarget
      = this.main.querySelector("[data-es-focus]")
      || this.main.querySelector("h1, h2, [role='heading']");

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
      const isNaturallyFocusable
        = focusTarget.matches?.(
          "a[href], button, input, select, textarea, details, summary, [tabindex]"
        )
        || false;
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
      })
    );
  },
};

export default router;
