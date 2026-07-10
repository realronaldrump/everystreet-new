# Field Atlas design language

Field Atlas is Every Street's permanent visual identity: a personal
cartographic ledger built from paper, ink, hairlines, and measured figures.
This document is the implementation reference. The full audit and migration
record lives in [`atlas-design-system-plan.md`](atlas-design-system-plan.md).

## Governing rule: green is earned

Sage means the product's payoff: driven streets, coverage progress, live data,
and completed work. Success green is for successful feedback. Green is never a
decorative fill for buttons, tabs, navigation, or page chrome.

- UI actions and active chrome use `--action`, `--action-hover`, and
  `--text-on-action`.
- Planning and attention use ochre via `--warning`.
- Destructive and error states use `--danger`; never use red for ordinary data.
- Neutral, idle, disabled, and checking states use surface, border, and text
  tokens.
- Sage remains valid for text links, focus rings, enabled toggles, and measured
  live/driven/progress data.

All colors come from `static/css/core/variables.css`. `--accent` is a legacy
alias and must not appear in new CSS. Page styles must not contain raw colors.

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
| Ledger/data | `.ledger-list`, `.ledger-row`, `.figure-band`, `.figure-label`, `.figure-value`, `.data-num` | Dense facts, totals, and measured values. |
| Object card | `.card.card--object` | A truly discrete object only; use hairline internals and no ornamental shadow. |
| Tabs | `.atlas-tabs`, `.atlas-tab` | Route or panel switching with an ink underline. |
| Segmented control | `.segmented-control` and its existing item classes | Compact view or mode switching. |
| Stepper | `.atlas-stepper`, `.atlas-step`, `.atlas-step-index`, `.atlas-step-label` | All multi-step workflows. Do not add connector elements. |
| Buttons | `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger` | Ink primary, hairline secondary, quiet ghost, destructive danger. |
| Forms | shared form/input/select classes | Surface fill, hairline border, token focus ring; never page-local beige or dark variants. |
| Status | `.status-badge`, `.status-dot`, and semantic modifiers | Sage live/ok, ochre attention, brick error, neutral idle. |
| Empty state | shared empty-state classes | Dashed hairline, one line icon, one sentence, at most one quiet action. |
| Navigation controls | `.atlas-nav-controls` family | Consistent map and page navigation controls. |

Page CSS may compose these components and add layout, but it must not recreate
their appearance. A template without a masthead must be an intentional immersive
or hero exemption recorded in the design guardrail test.

## Map and chart colors

| Meaning | Token |
|---|---|
| Driven, covered, live | `--color-driven`, `--live` |
| Undriven, remaining | `--color-undriven` |
| Individual trip path | `--map-trip-path` |
| Planned route | `--warning` |
| Stopped-in region | `--cat-steel` |

Categorical charts use at most six colors in this fixed order: sage, ochre,
steel, coral, slate, purple. Heatmaps use a sequential sage ramp unless the data
already has a documented semantic scale. Coverage/progress rings are sage on a
border-color track; ochre is reserved for stalled or attention states.

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
2. Confirm every green use communicates driven/live/progress/success meaning.
3. Put measured numbers in mono tabular figures.
4. Check light and dark themes plus the four reference widths.
5. Run `pytest tests/guardrails/test_design_tokens.py --no-cov` and the
   JavaScript tests.
