---
name: frontend-design
description: Design and implement distinctive marketing websites, portfolios, and web-facing product surfaces. Use for greenfield work or evidence-driven redesigns, not documents, decks, native mobile apps, dense dashboards, data tables, or wizards.
---

# Frontend design

Use this skill to turn a visual web brief into a maintainable, working frontend. It is a design-and-implementation skill: produce a real interface, not a document, a slide deck, or a static mood board.

## Establish the design contract before coding

1. Read the applicable root and product `AGENTS.md` files, inspect the existing UI, assets, and package manifest, and discover the product's real build, lint, test, and preview commands.
2. State one **Design Read** before editing: “Reading this as: _page kind_ for _audience_, with a _vibe_ language, leaning toward _system or aesthetic family_.”
3. If two materially different readings remain plausible, ask exactly one concise question. Otherwise proceed.
4. Set and explain the three dials: `DESIGN_VARIANCE`, `MOTION_INTENSITY`, and `VISUAL_DENSITY`, each from 1 through 10. A marketing-page starting point is 8 / 6 / 4; the brief overrides it.
5. Choose one design-system or aesthetic foundation using [the design-system map](references/design-system-map.md). Verify every package in the manifest before importing it. When a dependency is absent, state the exact install command and obtain the normal dependency-install approval before using it.

Record this discovery and the final visual evidence in a JSON file, then run:

```powershell
node .agents/skills/frontend-design/scripts/validate-evidence.mjs <evidence.json>
```

The validator is an evidence gate, not a replacement for visual judgment.

## Build a coherent interface

- Use the existing product stack. For a new React or Next.js marketing surface, prefer server-rendered structure and isolate interactive motion in small client leaves. Keep state that changes every frame in motion values rather than React state.
- Use an official system when the product genuinely belongs to one; do not imitate an official system with hand-written lookalike CSS or mix competing systems. For an aesthetic direction, label the result honestly as an implementation, not an official system.
- Use native image generation for section-specific visual assets when it materially improves the page. Save approved outputs in the product's asset location, use real or generated imagery rather than div-built fake screenshots, and do not launch a nested Codex process.
- Make the page feel deliberately authored: one palette and radius logic, varied section compositions, restrained cards, a readable opening viewport, short focused copy, and real visual hierarchy. Avoid generic dark-purple gradients, centered-default heroes, repeated equal-card rows, decoration-only labels, nested-box layouts, fake precision, and filler brand copy.
- Keep a marketing page distinct from an admin surface. If the task is a dashboard, data table, wizard, editor, native mobile interface, or document, route to the appropriate system or skill instead of forcing this one.

Read [the preflight reference](references/preflight.md) when implementing or reviewing the page. It contains the non-obvious anti-slop, image, typography, and layout checks.

## Accessibility, motion, and performance

- Preserve semantic landmarks, keyboard operation, visible focus, and contrast. Do not use placeholder text as the only form label.
- Honor `prefers-reduced-motion` for motion above a subtle hover state. Animate `transform` and `opacity`; do not attach unbounded scroll listeners or drive scroll physics through React state.
- Reserve media space, load above-the-fold media deliberately, avoid layout shifts, and keep expensive animation and large libraries out of the critical path.
- Test the relevant light/dark or fixed-theme decision in the browser. Do not invert arbitrary sections mid-page without a documented composition reason.

## Redesigns require evidence first

Classify the work as greenfield, preservation redesign, or visual overhaul. For a redesign, capture the existing brand tokens, information architecture, conversion paths, accessibility wins, analytics-sensitive names, and SEO-sensitive routes before changing them. Do not silently change route slugs, primary navigation labels, form field names/order, the logo, or legal copy.

## Finish with runnable evidence

Run the discovered build/lint/test commands, then use the native browser surface to check the rendered page, console, at least one interaction, responsive layout, and the comparison against the Design Read. Include the URL, screenshot path, console result, interaction, and verdict in the evidence record. Follow the centralized CODEMAP maintenance contract in the applicable `AGENTS.md`; do not duplicate or weaken it here.

Use [the design-system map](references/design-system-map.md) for system selection and [the preflight reference](references/preflight.md) for the final review.
