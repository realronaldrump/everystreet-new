# Route Planner overhaul plan

Audit completed 2026-07-12. This is the implementation plan for fixing the
`/coverage-route-planner` page (UI/UX) and improving the optimal-route
algorithm. All findings below were verified against source.

## Part 0 — Audit findings

### UX/structural problems

1. **Four competing progress/navigation structures**: sidebar tabs
   (Plan/Find/Status/Results), a 4-step workflow stepper, a 3-step cluster
   progress stepper (`#route-progress-container`, used by
   `driving-navigation/ui.js`), and a 6-stage "Route Solver Live" pipeline —
   plus the map HUD (`#route-solver-hud`) duplicating the pipeline, plus a
   scanner overlay, plus toasts.
2. **Auto tab-switching** (`initAutoTabSwitch` in
   `static/js/modules/features/coverage-route-planner/ui-scaffold.js`) yanks
   users to Status on generate and Results on completion; active tab persists
   in localStorage so returning users land on empty tabs.
3. **Results split across tabs**: stats/CTAs on Results, regenerate on Plan,
   layer controls buried in Results.
4. The "Find" tab ships a helper card explaining its own confusion
   ("Planning vs. Navigating").

### Dead/broken UI (verified: no JS references anywhere)

- 4-step workflow stepper (`#workflow-stepper`) — never advances; always
  shows step 1.
- Sidebar coverage ring (`#sidebar-coverage-ring`, `#sidebar-ring-fill`,
  `#sidebar-ring-pct`) and `#sidebar-subtitle` — never updated.
- Area panel: `#donut-driven-arc` (donut never fills), `.acstat-driven-val`,
  `.acstat-total-val` (show "--" forever), `#area-coverage-bar` (never fills),
  `#area-empty-hint` (never hides after selection). Only `#area-coverage` and
  `#area-remaining` are wired (`optimal-route/ui.js updateAreaStats`).
- Results: `#eff-ring-fill` never fills, `#eff-grade` never shows,
  `#stat-covered-distance` ("Coverage" card) never populated.
- Generate button `data-state` stays `"idle"` forever → subtitle reads
  "Select an area first" even when an area is selected.
- `manager.js` binds `.layer-up`/`.layer-down` buttons that don't exist in the
  template.

### Dangerous UX

- Results "Clear" button silently **deletes the saved route server-side**
  (`DELETE /api/coverage/areas/{id}/optimal-route`) with no confirmation.

### Algorithm findings (`routing/`)

The solver is greedy nearest-neighbor (component-aware, with teleports across
disconnected islands) + 2-opt local search (`routing/local_search.py`), then
Valhalla gap-filling. Real issues:

1. **2-opt never runs on any route containing a teleport.**
   `_DistanceCache.get()` returns `None` for unreachable pairs;
   `_sequence_total_cost_fast` then returns `None` and `improve_route_2opt`
   bails ("Cannot compute initial cost"). Zone-decomposed areas
   (>2000 reqs) are split per component, so multi-component areas — the
   common real-world case — get **zero local search**.
2. **Service-edge direction is frozen.** `make_req_id` gives each requirement
   forward+reverse options, but greedy commits to one direction and 2-opt
   never tries flipping. Flipping a two-way street's traversal direction is a
   classic cheap move that cuts connection deadhead on both sides.
3. 2-opt reversal is weak for asymmetric (directed) problems; **Or-opt
   (segment relocation, no reversal)** is the standard complement and is
   missing.
4. `_build_stats` (post-2-opt) hardcodes `teleports: 0.0`, so
   `validate_route`'s `connectivity_signals` can wrongly hard-error instead
   of warn after an accepted 2-opt improvement.

## Part 1 — UI/UX overhaul

**Direction: kill the tabs; one linear flow in the sidebar.** The map HUD
remains the detailed live-progress surface. Progress/results render inline in
the flow, where the user already is.

### New sidebar structure (`templates/coverage_route_planner.html` rewrite)

1. **Masthead** (keep `page-masthead` — guardrail test requires it). Drop the
   dead coverage ring. Keep eyebrow "The field plan", title, and a subtitle
   wired to state (idle → "Select an area…"; selected → area name + remaining
   mi).
2. **Section 01 · Coverage Area** — `#area-select` + `#area-stats` panel with
   ALL values wired (donut arc, coverage %, remaining, driven, total
   streets, bar). Data is available: `/api/coverage/areas` returns
   `coverage_percentage`, `total_length_miles`, `driven_length_miles`,
   `total_segments`, `driven_segments` (see `AreaResponse` in
   `street_coverage/api/areas.py:117`). Hide `#area-empty-hint` on selection.
   Use `<span class="atlas-step-index">1</span>` in the widget header for the
   canonical mono "01" numbering (`components/stepper.css`).
3. **Section 02 · Optimal Route** — generate button (wire `data-state`:
   `idle` no area / `ready` area selected / `done` route exists), algo
   explainer (keep), plus:
   - `#route-progress-inline` (new, hidden): compact stage label + progress
     bar + message + elapsed + Cancel. Replaces the Status tab; reuse
     existing `OptimalRouteUI.updateProgress` targets by moving the element
     IDs (`#progress-bar`, `#progress-message-primary/secondary`,
     `#elapsed-value`, `#cancel-task-btn`) into this block.
   - `#error-section` (keep id, now inline here): message + Retry.
4. **Section 03 · Route Summary** (`#results-section`, hidden until a route
   exists) — efficiency ring **wired** (`#eff-ring-fill` dashoffset =
   188.5 × (1 − eff/100), plus `#eff-grade`), stat cards Total / Required /
   Deadhead (**delete** the never-populated "Coverage" card), primary CTA
   Start Live Navigation, secondary Export GPX / Replay / **Delete Route**
   (renamed from "Clear", with confirm dialog before the server-side DELETE).
5. **Section · On the Road** (the old Find tab, one widget): auto-follow
   switch in header, find tiles, `#status-message`, `#target-info`,
   `#route-progress-container` (cluster 3-step progress lives here, still
   driven by `driving-navigation/ui.js`), `#route-info` (guidance +
   Google/Apple buttons), `#route-details`/`#route-stats` (cluster details).
   Delete the "Planning vs. Navigating" helper card.
6. **Section · Simulate Drive** — keep content as-is; default collapsed.
7. **Section · Saved Routes** — keep as-is.
8. **Section · Map Layers** — move out of Results into its own bottom
   section; default collapsed.
9. **Map container** — unchanged (map, scanner overlay, HUD, legend).

### JS changes

- `features/coverage-route-planner/ui-scaffold.js`: delete `switchTab`,
  `initTabNavigation`, `initAutoTabSwitch`, `updateModeIndicator`,
  `TAB_STORAGE_KEY`, and `[data-action="go-to-plan-tab"]` handling. Keep
  bottom-nav insets, collapsibles (add support for `data-default-collapsed`
  so Simulate/Layers start collapsed unless user expanded them), mobile
  panel toggle, keyboard shortcuts, layer sliders, algo explainer. Add:
  when generation starts, scroll the sidebar to the progress block.
- `optimal-route/ui.js`:
  - `updateAreaStats(area)` — accept the full area object (from
    `manager.coverageAreas`) instead of reading option datasets; populate
    donut arc (`stroke-dashoffset = 201.06 × (1 − pct/100)`), coverage %,
    remaining, driven, total streets, bar width; toggle `#area-empty-hint`;
    update masthead subtitle.
  - `showResults(data)` — additionally set `#eff-ring-fill` dashoffset and
    `#eff-grade` text (e.g. ≥90 "Excellent", ≥75 "Good", ≥60 "Fair", else
    "Heavy deadhead"); set generate button `data-state="done"`.
  - `showProgressSection`/`hideProgressSection` — target the new inline
    block; set button state.
  - New `setGenerateState(state)` helper for `data-state`.
- `optimal-route/manager.js`:
  - `onAreaSelect` — pass the resolved area object to `updateAreaStats`;
    set generate `data-state` to `ready`/`done` (based on
    `has_optimal_route`); on deselect reset to `idle`.
  - `clearRoute()` → rename UI affordance to Delete Route; require
    `confirm()` (or the app's notification confirm if one exists) before
    calling the DELETE endpoint; also refresh the Saved Routes list.
  - After successful generation, call `ui.updateSavedRoutes(...)` so the
    list reflects the new route.
  - Delete the dead `.layer-up`/`.layer-down` bindings and
    `updateLayerOrder` (orphaned by template rewrite).
- `driving-navigation/manager.js:626-630`: remove the
  `document.querySelector('[data-tab="status"]').click()` block (tabs no
  longer exist); scroll `#route-progress-container` into view instead.

### CSS changes (`static/css/coverage-route-planner.css`, 3501 lines)

Surgical, not a rewrite — the component styling is recent Blueprint & Brass
work; the sloppiness is structural. Using the section map (line numbers from
audit):

- **Delete sections**: Tab Navigation (332–438), Workflow Stepper (440–534),
  Tab Panels (536–617), Status Tab — Processing States (1895–2012) *except*
  the parts styling `#route-progress-container` internals (cluster progress —
  keep/move), Status Tab Empty State (2198–2258), the Results empty state
  art, `find-helper-card` styles, and `[data-mode=…]` mode-indicator rules
  (~600–616).
- **Keep**: Layout, mobile toggle/bottom-sheet, control panel, widget base,
  forms, area donut widget, generate button multi-state (now actually used!),
  algo explainer, simulation, saved routes, find tiles, status messages,
  route info, solver pipeline → **repurpose compact styles** for
  `#route-progress-inline`, error section, results hero + grid, layer
  controls, map/scanner/HUD/legend, responsive, a11y, print.
- **Add**: `#route-progress-inline` compact styles; section-numbering header
  alignment (`.widget-title .atlas-step-index`).
- Rule: tokens only, no raw colors (guardrail
  `tests/guardrails/test_design_tokens.py` enforces).

## Part 2 — Algorithm accuracy improvements

All in `routing/local_search.py` unless noted. Keep the greedy constructor
and the service.py orchestration unchanged.

1. **Teleport-tolerant local search** (biggest win):
   - Add fallback cost to `_DistanceCache`: when Dijkstra finds no path,
     return `haversine(from, to) × TELEPORT_PENALTY_FACTOR` (new constant,
     suggest `10.0`, in `routing/constants.py`) using `node_xy` coords
     (pass `node_xy` into the cache; haversine helper exists in
     `routing/graph.py:_haversine_distance_m`).
   - Penalized costs are used **only** for search accept/reject decisions
     (`_sequence_total_cost_fast`, `_swap_delta`). `_rebuild_route_coords`
     and `_build_stats` keep current behavior (skip unreachable; Valhalla
     gap-fill bridges later and `apply_gap_bridge_stats` folds distance in) —
     avoids double-counting.
   - Result: 2-opt now runs on multi-component routes and naturally shortens
     teleport jumps.
2. **Orientation (direction-flip) pass**: new `_orientation_pass(sequence,
   required_reqs, dist_cache, …)` — for each position whose `rid` has a
   reverse option in `required_reqs[rid]`, compare
   `d(prev_end, u)+len(u,v)+d(v, next_start)` vs the flipped variant; take
   improvements. O(n) per pass with cached distances. Alternate with 2-opt
   passes under the shared `LOCAL_SEARCH_TIME_BUDGET_S` deadline until no
   move improves.
3. **Or-opt (single-edge relocation)**: `_relocate_delta(sequence, i, j)` —
   remove service edge at `i`, insert after `j` (window-limited like 2-opt's
   `i+50`); 6 cached-distance lookups per candidate. Preserves direction, so
   it's effective where directed 2-opt reversal is weak.
4. **Stats fix**: `_build_stats` counts a teleport whenever a connection is
   unreachable instead of hardcoding `teleports: 0.0` (keeps
   `validate_route` connectivity signals honest).

### Tests (new `tests/test_routing_local_search.py`)

- 2-opt improves a deliberately bad ordering on a small grid graph
  (assert total_distance strictly decreases and all reqs still serviced).
- Route with two disconnected components: local search runs (doesn't bail),
  final stats `teleports ≥ 1`, all requirements serviced.
- Orientation: two-way street where flipping direction is strictly cheaper —
  assert the flip happens and stats improve.
- Relocation: straggler edge picked up out of order — assert or-opt moves it
  and cost decreases.
- Existing `tests/test_routing_solver.py` must keep passing.

## Part 3 — Verification checklist

1. `pytest tests/test_routing_solver.py tests/test_routing_local_search.py
   tests/test_routing_validation.py tests/test_routing_service_fallbacks.py
   tests/test_routing_service_gap_indices.py tests/test_routing_gaps.py
   tests/test_routing_graph_matching.py --no-cov`
2. `pytest tests/guardrails/test_design_tokens.py --no-cov` (masthead +
   token rules).
3. JS tests / lint per repo config (`npm test` / eslint if configured).
4. Manual: view https://everystreet.me/coverage-route-planner (never boot
   locally — dev-environment memory) at 375/768/1024/1440 px, light + dark:
   select area (all stats populate), generate (inline progress + HUD, no tab
   jumps), results (ring fills, grade shows), delete route (confirm dialog),
   cluster route from On the Road section shows its 3-step progress inline.

## Notes / constraints

- `.claude/CLAUDE.md` + `docs/design-language.md` govern: tokens only, reuse
  canon components (`.atlas-stepper` family for numbering), no green
  literals, masthead required, mono tabular figures for measured numbers.
- Untracked WIP exists in the repo (`static/js/modules/features/
  coverage-diorama/`, `templates/coverage_diorama.html`) — unrelated; don't
  touch.
- Browser preview via the in-app browser was timing out this session; use
  everystreet.me directly for verification.
