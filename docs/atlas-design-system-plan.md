# Every Street — "Field Atlas" Identity & Design-System Plan

**Status:** Historical implementation record. Superseded 2026-07-09 by the fixed Blueprint & Brass palette documented in [`design-language.md`](design-language.md); the configurable accent and the green-led palette described below have been retired.
**Goal:** One cohesive, professional identity across all ~20 pages; kill the "green everywhere" problem with an intentional color system; no generic AI-slop patterns.

---

## 1. Diagnosis (verified by live inspection, logged in, light + dark)

The July 2026 de-slop pass fixed the *token layer* — there is no literal neon hex left anywhere in CSS/JS. What remains broken:

### 1a. Green is doing every job at once
Five distinct greens coexist and are used interchangeably for chrome, not meaning:
- `--cat-sage #3b8a7f` (primary), `--accent #2f9e8f` (teal), `--cat-olive #4d9a6a` (success), `--cat-mint #4a9a8a`, `--cat-lime #7aaa58`.
- On any given screen, the eyebrow, the primary button, the segmented-control active state, the toggle, the status dot, the checkmark bubble, the active tab, and the link are ALL green. On near-black dark surfaces the saturated teal reads "neon"; in light mode it reads "golf club."
- Coverage page shows ten identical dark-green "Explore Map" filled buttons at once.
- `--accent` (teal) vs `--primary` (sage) split is arbitrary: memory-city.css uses `--accent` 33×, trips.css 26×.

### 1b. Component drift between pages (the "chaos")
- **3+ card languages:** hairline ledger/figure-band (trips, routes, insights masthead) vs boxy white cards (coverage mgmt, visits) vs beige-header cards (gas "New Fill-up", setup wizard "Bouncie Credentials").
- **2 tab systems on one page:** control-center top nav = icon+underline; its Logs section = slate-green pill tabs. Regional explorer adds a third (gray pills).
- **3 stepper styles:** map-matching (filled green circles 1-2-3), route planner (tiny numbered dots 1-4 + icon tabs Plan/Find/Status/Results), setup wizard (outlined green icon circles).
- **Input drift:** trips search = white pill; gas/setup inputs = beige fill (look disabled); export = dark fills.
- **Settings (control-center) is the worst page:** "Log Statistics" / "Filters & Actions" headers render white-on-beige (dark-mode styles leaking into light — illegible); stat values washed out; a pastel Bootstrap button row (pale green "Refresh Logs", pale blue "Copy All", pale red "Clear All") that matches nothing.
- **Route planner:** bespoke sidebar chrome, out-of-palette lavender/steel-blue disabled CTA ("Generate Optimal Route"), 118 hardcoded font-size literals (worst file), 77 KB CSS.
- **Regional explorer:** danger-red toggle for a neutral filter; all state percentages rendered in red (reads as errors); bespoke stat chips.
- **Vehicles:** "Active" badge nearly invisible (light-on-light); dark mono "mi" suffix box floats oddly.
- **Coverage mgmt:** donut rings colored by arbitrary tier (green/blue/ochre) → rainbow effect; orange glow + trophy on 100% card is its own one-off language.
- **Masthead adoption:** 10 templates use `.page-masthead`; 10 don't (404, coverage_route_planner, index/map, landing, live_navigation, map_matching, memory_city, regional_coverage_explorer, setup_wizard, base).
- **Hardcoded font sizes** in page CSS: route-planner 118, trips 81, regional-explorer 37, vehicles 11, search 10, …

### 1c. Theme correctness bugs (root cause of "different between pages")
- **FOUC / stuck-dark:** `templates/base.html:24` inline no-flash script adds `light-mode` to `<html>` only, but `static/css/core/variables.css:351` scopes ALL light tokens to `body.light-mode`. Body only gets the class later from `static/js/modules/core/navigation.js:91`. Result: every hard load paints dark first, then flips; if app.js is slow/fails, the page stays dark (observed live on /export — rendered fully dark once, light on next visit).
- **Stale meta theme-color:** navigation.js:96 writes `#fafafa`/`#0a0a0c`; base.html and the actual surfaces use `#f4f1e8`/`#050507`.
- Bootstrap `data-bs-theme` and `.light-mode` are two parallel theme systems that can disagree.

---

## 2. The identity: **Field Atlas**

Extend (never replace) the existing Atlas voice: a personal cartographic ledger — paper, ink, hairlines, mono figures — specific and human-made, not a SaaS dashboard.

### The one governing color rule: **"Green is earned."**
Green is the product's payoff — a street turns green when you've driven it. So green is reserved exclusively for *accomplishment and live data*: driven streets, coverage progress, live tracking, success confirmations. **UI chrome never uses green decoratively.** Buttons, tabs, eyebrows, toggles-at-rest, active states, focus — all become ink and paper. When the user sees green, it always means "you drove this." That single rule simultaneously fixes "excessive green" and gives the app a memorable, ownable identity.

Supporting principles:
1. **Paper & ink first.** Light = warm paper `#f4f1e8` family; dark = charcoal `#0c0c0f` family. Structure comes from hairlines and type, not boxes and shadows.
2. **Hairlines over boxes.** Prefer the ledger/figure-band language (1px rules, dotted leaders) to floating white cards. Cards only when content is truly a discrete object (a vehicle, a place, an area).
3. **Mono means data.** Every number the app measured (miles, %, coordinates, dates, revs) is JetBrains Mono with `tabular-nums`. Prose is IBM Plex Sans, display is Chivo. This is already half-true; make it law.
4. **Ochre is the pencil.** `#d4a24a` remains the single warm accent for planning/attention (route planner rail, warnings, stalled states) — the cartographer's pencil against sage's "driven" ink.
5. **One voice per page, one system across pages.** Per-page eyebrows keep their editorial voice ("The ledger", "The mission"…) but every page is built from the same canon of parts.

---

## 3. Foundation changes (`static/css/core/variables.css`)

### 3a. Color tokens
```css
/* CONSOLIDATE GREENS — one green, one meaning */
--accent: var(--primary);                 /* teal #2f9e8f is retired */
--accent-rgb: var(--primary-rgb);
--accent-light: var(--primary-light);
--accent-dark: var(--primary-dark);
--cat-mint: var(--cat-sage);              /* retire as distinct hue */
--cat-lime: var(--cat-olive);             /* retire as distinct hue */

/* NEW — ink action tokens (primary buttons become ink, not green) */
--action: #26241f;                        /* dark mode: #edeae0 (bone) */
--action-hover: #3a372f;                  /*            #f8f6ef        */
--text-on-action: #f4f1e8;                /*            #16150f        */
--action-rgb: 38 36 31;                   /*            237 234 224    */

/* SEMANTIC — green's only jobs */
--color-driven: var(--primary);           /* unify: driven = sage, not olive */
--live: var(--primary);                   /* live-tracking pulse */
/* --success stays #4d9a6a but ONLY for success feedback (toasts, valid states) */
```
- `--primary` keeps sage (`#3b8a7f` dark / `#2f7268` light) but its *permitted uses* shrink to: text links, focus rings, toggle-on, live/driven data, progress fills. Never large filled surfaces.
- Categorical/chart palette becomes an ordered, documented ramp of max 6: sage, ochre, steel, coral, slate, purple. (mint/lime aliased away; fewer greens in charts.)
- Donut/progress rings: single-hue — track = `--border-color`, fill = sage always; ochre only for "stalled/error" areas. Kill the blue/tier rainbow.
- Regional explorer percentages: ink mono, never red. Red (`--danger #c45454`) = destructive/error only, everywhere.
- Route planner CTA: replace the lavender/steel disabled blob with the standard disabled treatment (`opacity: .5` on the canonical primary button).

### 3b. Theme correctness (do this first — it's the biggest "chaos" fix)
1. In variables.css change the light-mode scope so first paint is correct:
   `body.light-mode { … }` → `html.light-mode, html.light-mode body { … }` (or simply `.light-mode`). The base.html inline script already sets the class on `<html>` pre-paint; CSS must honor it.
2. Keep navigation.js body-sync for legacy JS checks (`live-navigation-map.js:220` reads `document.body.classList`), but the *rendered theme* must never depend on app.js executing.
3. Fix meta theme-color in navigation.js:96 to `#f4f1e8` / `#050507` (match base.html:27/32). Single source: read from a `--surface-0` lookup or a shared constant.
4. Audit `control_center`/`server-logs.css` for selectors that assume dark (the white-on-beige headers). Rule: **no page CSS may set text/background colors except via tokens** — tokens flip cleanly, literals don't.

### 3c. Typography & spacing (already defined — now enforced)
- Scale, families, weights, `--space-*`, radii, shadows stay as-is (they're good).
- New rule: page-level CSS may not contain `font-size: <literal>` — only `var(--font-size-*)` (or `em` for icons). This deletes ~300 literals; see §7 guardrails.
- All numeric readouts get `font-family: var(--font-family-mono); font-variant-numeric: tabular-nums;` via a shared `.figure-value` / `.data-num` class instead of per-page re-declarations.

---

## 4. Component canon (`static/css/components/`)

One blessed implementation each; page CSS may *compose* them, never re-invent them.

| Part | Canonical spec | Replaces |
|---|---|---|
| **Masthead** | existing `.page-masthead` (eyebrow / Chivo title / factual sub) — but eyebrow color changes `var(--primary)` → `var(--text-tertiary)` (masthead.css:27). Green eyebrows were 40% of the "green everywhere" feel. | bespoke headers on 10 pages |
| **Figure band** | existing `.figure-band` hairline numerals | boxed stat chips (regional explorer, server-logs stat cards) |
| **Measured data** | existing `.figure-*` and `.data-num` vocabulary for hairline rows and tabular figures | ad-hoc statistic treatments |
| **Card** | `.card` stays; new modifier `.card--object` for true objects (vehicle, area, place). Beige header bands (`gas`, wizard) are retired — card titles sit on the card surface with a hairline below. | 3 divergent card styles |
| **Buttons** | `.btn-primary` re-skinned to **ink fill** (`--action` tokens above). Rules: ≤1 filled button per view; repeated per-card CTAs (coverage "Explore Map" ×10) become `.btn-outline`; pastel `btn-success/info/warning` rows in server-logs become `.btn-ghost` with leading icon. Danger keeps brick tint for destructive. | green fills everywhere; pastel Bootstrap rows |
| **Tabs** | one system: text + 2px underline, ink text, `aria-selected` underline in ink (map sidebar TRIPS/COVERAGE/PLACES/FLOW is the reference). Kill pill tabs (logs, regional explorer). | 3 tab systems |
| **Segmented control** | compact hairline-bordered group, active segment = ink fill + paper text (not green) — Cards/List, Paths/Heat, Trips/Matched-Trips | green-filled segments |
| **Stepper** | ONE component in `components/stepper.css`: mono step numerals (`01 → 02 → 03`), hairline connectors, current step ink-strong + underline, done steps get a small sage check (earned!). Route planner, map-matching, setup wizard all adopt it. | 3 stepper styles |
| **Collapsible section header** | hairline top rule + Chivo label + chevron ghost button, transparent bg | beige bars (route planner, gas) |
| **Toggle** | track-off = neutral (existing), track-on = sage (state = "on/tracking", semantically fine). NEVER danger-red for neutral filters (regional explorer). | red toggle |
| **Badge/chip** | one `.chip` (hairline, mono label) + semantic `.badge--{success,warning,danger}` tints. Fix vehicles "Active" contrast (use success tint w/ AA text, not white-on-light). | 4+ chip styles |
| **Inputs** | one treatment both modes: `--surface-1` fill (paper-white in light), hairline border, sage focus ring. Kill beige fills that read disabled. Suffix units ("mi", "$") = quiet mono inside the field, not dark boxes. | 3 input treatments |
| **Empty state** | one pattern: dashed hairline frame, single line-icon, one sentence, ≤1 quiet action. Already close — normalize sizes. | varied |
| **Tables/DataTables** | hairline rows, mono numerics right-aligned, header = uppercase xs tertiary (match figure-label) | per-page table CSS |
| **Progress/donut** | single-hue sage on `--border-color` track (see §3a) | rainbow donuts |
| **Toasts/status dots** | dot colors strictly semantic: sage = live/ok (earned), ochre = attention, brick = error, neutral = idle ("Checking sync status…" dot should be neutral, not green) | all-green dots |

**The 100% card (coverage):** keep a celebration — it IS the product's summit — but in-language: full-sage hairline frame, small "EVERY STREET DRIVEN" mono stamp (like a passport stamp), no orange glow gradient.

---

## 5. Page-by-page punch list

Order = user traffic × visible damage.

1. **control_center.html + settings.css (72KB) + server-logs.css** — worst offender.
   - Fix dark-leak headers (white-on-beige), washed stat values → figure-band.
   - One tab system (top underline nav only); Logs' pill tabs → underline.
   - Pastel action row → ghost buttons; "Clear All" = danger outline.
   - Adopt canon inputs/cards throughout all 9 sections. Expect to delete thousands of lines.
2. **coverage_management.html + coverage-management.css (42KB)**
   - Donuts single-hue; "Explore Map" ×N → outline; one filled "Add Area" stays ink.
   - Cards → `.card--object` with hairline internals, mono stats, ledger row option for dense mode. 100% card per §4.
3. **coverage_route_planner.html + CSS (77KB, 118 font literals)**
   - Adopt masthead-lite in sidebar header, canonical stepper, collapsible headers, tokens for all type; kill lavender CTA; ochre as the page's working accent (planning = pencil).
4. **trips.html + trips.css (57KB, 81 literals)** — closest to canon already; retire its 26 `--accent` teal uses → primary/ink per rules; segmented control re-skin; skeleton shimmer for figure values (the gray boxes) → standard shimmer.
5. **regional_coverage_explorer.html + CSS (37 literals)** — underline tabs; neutral toggle; ink mono percentages; figure-band stats; keep map fills (green driven / blue stopped-in is *data*, correct under "green is earned" — but swap blue → steel token).
6. **map_matching.html + map-matching.css (36KB)** — add masthead ("The alignment" voice suggestion); canonical stepper; banner card → standard success toast/inline note; beige tab bar → underline.
7. **gas_tracking.html / vehicles.html / visits.html / routes.html / export.html** — mostly re-skin: card headers, inputs, badges ("Active"), suffix boxes, segmented controls, per-page accent audit. Export also verifies the theme fix (§3b).
8. **insights.html + insights.css** — chart palette from the ordered ramp (§3a, max 6 hues, sage first); heatmap = sequential sage ramp; "Open underlying trips" links stay sage (link = permitted green); dashed empty states normalized.
9. **index.html (map)** — reference implementation; only: retire `--accent` teal remnants, confirm legend/dots comply, replace the long white loading veil with the standard route-tracer overlay quickly dismissed (perceived-perf polish).
10. **setup_wizard.html, login.html, 404.html, landing.html** — canonical stepper (wizard), ink CTAs, eyebrow color change lands automatically via masthead.css.
11. **live_navigation.html, memory_city.html** — memory-city.css has 33 `--accent` uses → primary; audit for teal glow remnants; otherwise re-skin via tokens.
12. **base.html chrome** — header active-nav underline ink (not green), notif badge stays brick, date-picker apply button ink, footer unchanged. Theme-toggle sun icon is mistakable for a gear at small size — swap to `fa-circle-half-stroke` single icon.

---

## 6. Map & chart data-color spec (the "intentional system")

| Meaning | Color | Token |
|---|---|---|
| Driven / covered / live | sage | `--color-driven`, `--live` |
| Undriven / remaining | coral | `--color-undriven` (#c47050, keep) |
| Individual trip paths | cool blue #3d9be9 (keep — cool routes vs warm heat) | `--map-trip-path` |
| Frequency heat | existing warm ramp | keep |
| Planned route | ochre | `--warning` family |
| Stopped-in regions | steel | `--cat-steel` |
| Chart categorical | sage → ochre → steel → coral → slate → purple, in that order | document in variables.css |

---

## 7. Guardrails (make drift impossible — they have `tests/guardrails/` already)

Add `tests/guardrails/test_design_tokens.py`:
1. **No raw hex** in `static/css/*.css` page files (allowlist: `core/variables.css`, map-style JSON/JS).
2. **No `font-size:` literals** (px/rem) in page CSS — tokens only.
3. **`--accent` is banned** outside variables.css (it's now an alias; new code writes `--primary`).
4. **No `color:`/`background:` literals** in page CSS — `var(...)` only.
5. Every page template either contains `page-masthead` or is in an explicit exemption list (map/landing/404 have bespoke heroes).
6. meta theme-color values in base.html and navigation.js must match `--surface-deep`/`--surface-0` (string test).
7. Grep-ban the retired patterns: pill tabs class, beige header class, old stepper classes — once removed, the guardrail keeps them dead.

Also: update `.claude/CLAUDE.md` (or a `docs/design-language.md` the templates reference) with the canon table in §4 + "green is earned" so future sessions extend, not fork. Update the `design-language-atlas` memory to point here.

---

## 8. Verification protocol (per phase, before commit)

1. Render check: Jinja mock-render templates or hit deployed pages; `agent-browser` screenshot each route **in light AND dark** (the chaos was invisible in dark-only checks): `/`, `/map`, `/trips`, `/insights`, `/visits`, `/gas-tracking`, `/vehicles`, `/routes`, `/export`, `/map-matching`, `/coverage-management`, `/coverage-route-planner`, `/regional-coverage-explorer`, `/live-navigation`, `/memory-city`, `/setup-wizard`, `/control-center` (all 9 section anchors), `/login`, `/404`.
2. Hard-reload FOUC test: with `theme=light` in localStorage, first paint must be paper (verifiable because tokens now hang off `html.light-mode`).
3. AA contrast spot-checks: eyebrow tertiary on paper, badge text, disabled states, mono figures.
4. Run guardrail tests + existing test suite (`tests/test_control_center_page_smoke.py` etc. will catch template breakage).
5. Count check: grep for `var(--primary)` fills in page CSS should approach zero outside permitted uses.

---

## 9. Sequencing (each phase = one reviewable commit)

| Phase | Scope | Size |
|---|---|---|
| **1. Theme correctness + tokens** | §3b FOUC/meta fixes; §3a consolidation (accent→primary aliases, action tokens, driven=sage) | small diff, app-wide effect |
| **2. Component canon** | §4: buttons ink re-skin, eyebrow de-green, tabs, segmented, stepper.css (new), toggle, chip, inputs, empty-state, donut | medium; mechanical fallout fixes |
| **3. Settings + Coverage mgmt + Route planner** | the three worst pages, full re-skin + dead CSS deletion | largest; expect net-negative lines |
| **4. Remaining interior pages** | §5 items 4–11 | medium, repetitive |
| **5. Chrome + charts + guardrails + docs** | base.html header, chart ramp, `tests/guardrails/test_design_tokens.py`, design-language doc, memory update | small |

Rough total: ~600 KB of page CSS audited; expect to **delete** more CSS than is added (the three big files alone are ~190 KB and mostly bespoke duplication of what the canon provides).

---

## 10. What NOT to do (anti-slop guardrails, restated from the Atlas memory)

- No purple-gradient/glassmorphism drift, no icon-box + chevron tile grids, no "Welcome back" greetings, no subtitles that restate titles, no uniform reveal animations on every section, no fa-wand-magic-sparkles.
- Don't invent new decorative accents; the palette is closed: paper, ink, sage (earned), ochre (pencil), brick (danger), steel (info), coral (remaining).
- Don't replace the per-page editorial eyebrows — they're the voice. Just un-green them.
- Motion stays restrained: the route-tracer loader is the one signature animation; everything else is ≤260 ms fades/lifts.
