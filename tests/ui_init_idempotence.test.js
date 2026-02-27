import assert from "node:assert/strict";
import test from "node:test";

import mobileNav from "../static/js/modules/ui/mobile-nav.js";

function createClassList() {
  const classes = new Set();
  return {
    add(...names) {
      names.forEach((name) => classes.add(name));
    },
    remove(...names) {
      names.forEach((name) => classes.delete(name));
    },
    toggle(name, force) {
      const next = force === undefined ? !classes.has(name) : Boolean(force);
      if (next) {
        classes.add(name);
      } else {
        classes.delete(name);
      }
      return next;
    },
    contains(name) {
      return classes.has(name);
    },
  };
}

test("mobile nav init is idempotent", () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  try {
    const navClassList = createClassList();
    const navItem = {
      tagName: "A",
      href: "https://example.test/map",
      classList: createClassList(),
    };
    const nav = {
      isConnected: true,
      classList: navClassList,
      querySelectorAll() {
        return [navItem];
      },
    };

    const menuToggle = {
      clicks: 0,
      click() {
        this.clicks += 1;
      },
    };

    const moreBtn = {
      listenerCount: 0,
      addEventListener(type, handler) {
        if (type === "click") {
          this.listenerCount += 1;
          this.handler = handler;
        }
      },
    };

    let scrollListenerCount = 0;

    global.window = {
      scrollY: 0,
      location: {
        pathname: "/map",
        origin: "https://example.test",
      },
      addEventListener(type, handler) {
        if (type === "scroll") {
          scrollListenerCount += 1;
          this.scrollHandler = handler;
        }
      },
    };

    global.document = {
      getElementById(id) {
        if (id === "bottom-nav") {
          return nav;
        }
        if (id === "bottom-nav-more") {
          return moreBtn;
        }
        if (id === "menu-toggle") {
          return menuToggle;
        }
        return null;
      },
    };

    mobileNav.initialized = false;
    mobileNav.nav = null;
    mobileNav.scrollHandler = null;
    mobileNav.moreBtnHandler = null;

    mobileNav.init();
    mobileNav.init();

    assert.equal(scrollListenerCount, 1);
    assert.equal(moreBtn.listenerCount, 1);

    global.window.scrollY = 180;
    global.window.scrollHandler?.();
    assert.equal(navClassList.contains("hidden"), true);
  } finally {
    mobileNav.initialized = false;
    mobileNav.nav = null;
    mobileNav.scrollHandler = null;
    mobileNav.moreBtnHandler = null;
    global.document = originalDocument;
    global.window = originalWindow;
  }
});


