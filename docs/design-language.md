# Blueprint & Brass design language

Blueprint & Brass is Every Street's fixed visual identity: a personal
cartographic ledger built from warm paper, charcoal ink, survey blue, drafting
ochre, hairlines, and measured figures. This document is the implementation
reference. The original audit and migration record lives in
[`atlas-design-system-plan.md`](atlas-design-system-plan.md).

## Governing rule: color is authored, not personalized

The product has one closed palette. There is no user-selectable global accent,
no runtime rewriting of design tokens, and no `--accent` compatibility alias.
The interface should feel like one designed instrument in every session.

- Cobalt is the survey ink. It marks driven streets, coverage progress, live
  data, confirmed states, links, focus, and enabled controls.
- Ink and bone are the action colors. Primary buttons and selected navigation
  use `--action`, `--action-hover`, and `--text-on-action` so blue remains
  meaningful rather than becoming generic chrome.
- Ochre is the drafting pencil. Planning, attention, and work in progress use
  `--warning`.
- Coral marks remaining or undriven streets through `--color-undriven`.
- Brick is reserved for destructive actions and errors through `--danger`.
- Steel carries secondary information and stopped-in-region data through
  `--info` and `--cat-steel`.
- Neutral, idle, disabled, and checking states use surface, border, and text
  tokens.

All application colors come from `static/css/core/variables.css`. Page styles
must not contain raw colors. New hues require a deliberate design-language
change, not a page-local exception.

## Visual grammar

Light mode is warm paper; dark mode is charcoal. Structure comes from 1px
hairlines and typography instead of shadows and floating panels. Use Chivo for
display text, IBM Plex Sans for prose, and JetBrains Mono with tabular numerals
for values the app measured. Cards are reserved for discrete objects such as a
vehicle, place, or coverage area.

## Component canon

| Part | Canonical API | Use |
|---|---|---|
| Masthead | `.page-masthead`, `.page-masthead-eyebrow`, `.page-masthead-title`, `.page-masthead-subtitle` | One editorial introduction per standard page. |
| Measured data | `.figure-band`, `.figure-label`, `.figure-value`, `.data-num` | Dense facts, totals, and measured values. |
| Object card | `.card.card--object` | A truly discrete object only; use hairline internals and no ornamental shadow. |
| Tabs | `.atlas-tabs`, `.atlas-tab` | Route or panel switching with an ink underline. |
| Segmented control | `.segmented-control` and its existing item classes | Compact view or mode switching. |
| Stepper | `.atlas-stepper`, `.atlas-step`, `.atlas-step-index`, `.atlas-step-label` | All multi-step workflows. Do not add connector elements. |
| Buttons | `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger` | Ink primary, hairline secondary, quiet ghost, destructive danger. |
| Forms | shared form/input/select classes | Surface fill, hairline border, cobalt focus ring; never page-local beige or dark variants. |
| Status | `.status-badge`, `.status-dot`, and semantic modifiers | Cobalt live/ok, ochre attention, brick error, neutral idle. |
| Empty state | shared empty-state classes | Dashed hairline, one line icon, one sentence, at most one quiet action. |
| Navigation controls | `.atlas-nav-controls` family | Consistent map and page navigation controls. |

Page CSS may compose these components and add layout, but it must not recreate
their appearance. A template without a masthead must be an intentional immersive
or hero exemption recorded in the design guardrail test.

## Map and chart colors

| Meaning | Token |
|---|---|
| Driven, covered, live, confirmed | `--color-driven`, `--live`, `--success` |
| Undriven, remaining | `--color-undriven` |
| Individual trip path | `--map-trip-path` |
| Planned route | `--warning` |
| Stopped-in region | `--cat-steel` |

Categorical charts use at most six colors in this fixed order: cobalt, ochre,
steel, coral, slate, purple. Heatmaps use a sequential cobalt ramp unless the
data already has a documented semantic scale. Coverage and progress rings are
cobalt on a border-color track; ochre is reserved for stalled or attention
states.

## Responsive and accessible behavior

- Build mobile-first with fluid layout; add complexity as space becomes
  available.
- Interactive controls have a minimum 44px touch target and visible token-based
  focus treatment.
- Never require hover to reveal essential information or actions.
- Preserve meaningful reading and keyboard order when layouts reflow.
- Test at 375, 768, 1024, and 1440 CSS pixels in both themes.
- Respect reduced motion and safe-area insets for fixed mobile controls.

## Change checklist

Before merging a UI change:

1. Reuse a canonical component and token; do not fork a page-local visual.
2. Keep the palette fixed and verify no personalized accent path or green-hued
   color literal has been introduced.
3. Put measured numbers in mono tabular figures.
4. Check light and dark themes plus the four reference widths.
5. Run `pytest tests/guardrails/test_design_tokens.py --no-cov` and the
   JavaScript tests.
