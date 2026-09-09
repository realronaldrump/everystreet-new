# Navigation experience

Swup swaps the main page and uses its Fragment Plugin for trip and Coverage
Field Journal drawers. Opening a drawer keeps the background page mounted;
Back, Forward, Escape, and the Back link navigate real URLs. Direct detail URLs
work too. Trip tools and replay remain available from the detail view.

All page mounting and cleanup pass through `page-lifecycle.js`. Cleanup occurs
immediately before a successful content replacement, after the destination
module has loaded. An interrupted download therefore leaves the current page
usable. Async cleanup registered after departure is executed immediately and
once. Shared UI observes `navigation-events.js`, not the Swup instance.

Coverage and Planner lease one map canvas from `exploration-map.js`. A lease
owns its map listeners, sources, layers, images, and controls; releasing it
removes these while retaining the renderer and camera. Area and exact Generated
Route selection are shared for this browser document. Live Navigation remains
an independent driving view. No live or historical trip storage changes are
part of this feature.

The existing JSON filter/action flows update their result regions using
`updateRegion`. Search fields and other controls remain mounted. Navigation has
directional, drawer, exploration, and driving transitions, and named heading
and selected-record transitions. Reduced motion disables transition animation.

Swup and official plugin distributions are version- and SHA-256-pinned in
`config/swup-assets.json`. CI and the Docker build produce one first-party ESM
asset. No navigation package is installed or downloaded on the Mac. Browser
startup failure settles navigation readiness and allows ordinary navigation.
HTML caches are bounded, expire after 90 seconds, and are cleared after
successful API mutations or historical trip updates. Authentication and build
changes require a fresh document. Auth, API, download, and explicit bypass links
retain normal browser handling.

Focused lifecycle tests use synthetic in-memory state. The committed Chromium
suite runs a synthetic fixture server only in CI, exercising production Swup,
navigation, lifecycle, store, and map-lease code with stub feature data and map
rendering. It does not assert real mapping-service or trip-data correctness;
those flows need separate read-only verification on the deployed site.

References: [Swup Fragment Plugin](https://github.com/swup/fragment-plugin),
[lifecycle hooks](https://swup.js.org/hooks/),
[native animations](https://swup.js.org/getting-started/animations/).
