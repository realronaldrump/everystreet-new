// Prefetch linked pages and show loading overlay on navigation
(() => {
  const CACHE_NAME = 'everystreet-pages-v1';

  function prefetch(url) {
    if (!('caches' in window)) return;
    caches.open(CACHE_NAME).then(cache => {
      cache.match(url).then(match => {
        if (!match) {
          fetch(url, { credentials: 'same-origin' })
            .then(resp => resp.ok && cache.put(url, resp.clone()))
            .catch(() => {});
        }
      });
    });
  }

  function attachPrefetch(link) {
    const url = link.href;
    if (!url.startsWith(window.location.origin)) return;
    const handle = () => prefetch(url);
    link.addEventListener('mouseenter', handle, { passive: true });
    link.addEventListener('focus', handle, { passive: true });
    link.addEventListener('touchstart', handle, { passive: true, once: true });
    link.addEventListener('click', () => {
      window.loadingManager?.show('Loading...');
    });
  }

  function init() {
    const links = document.querySelectorAll('a');
    links.forEach(attachPrefetch);
    window.addEventListener('pageshow', () => {
      window.loadingManager?.hide();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
