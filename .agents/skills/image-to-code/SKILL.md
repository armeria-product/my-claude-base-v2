---
name: image-to-code
description: Build a visually faithful website from fresh generated section references by generating, deeply analyzing, implementing, and browser-comparing in that order. Use for image-first marketing and redesign work, not ordinary bug fixes or document production.
---

# Image to code

Use this skill when visual fidelity is central and no sufficient design specification already exists. The generated reference images are the art-direction source; the code is their translation. For ordinary technical changes or a precise existing design system, use the direct implementation path instead.

## Non-negotiable sequence

For a visual web task, complete this sequence:

1. Infer the page and section count. State the intended visual direction, including four signature components and two motion cues only when they suit the brief.
2. Use the native image-generation surface to create one fresh, large, analyzable reference for each requested section. Store each output in the product's approved asset location and assign one shared continuity key.
3. Create a fresh detail or regeneration for an unclear section. Never crop, slice, or zoom a previous board to substitute for a section reference.
4. Inspect every reference before coding. Extract readable text, typography, spacing, colors, layout, media treatment, controls, component logic, hierarchy, and uncertainties. Generate another fresh reference if a needed detail is not readable.
5. Only after the analysis is complete, implement the frontend with $frontend-design and the applicable product `AGENTS.md` instructions.
6. Launch the product through its discovered command and use the native browser surface for a rendered comparison, console check, and interaction. Correct visible drift before delivery.

Never launch a nested Codex process or use a provider-specific handoff. Do not use this workflow for user-facing documents or slide decks.

## Reference quality

- One requested section normally means one primary image. Do not compress a multi-section design into an unreadable collage merely to reduce calls.
- Keep all section references in one design world: palette, type scale, CTA shape, radius system, image treatment, and component family must agree.
- Keep the opening screen readable on a small laptop. Favor a strong focal point, concise copy, visible action, clear hierarchy, and generous spacing.
- Generate implementation-friendly comps, not abstract art. Avoid fake technical markers, decoration-only pills, nested cards, generic repeated split sections, artificial dashboard chrome, and default gradient treatment.

Read [the extraction guide](references/extraction.md) before analyzing a reference or resolving a visual ambiguity.

## Evidence trace

Create a JSON trace of the image-to-code delivery and validate it before finalizing:

```powershell
node .agents/skills/image-to-code/scripts/validate-trace.mjs <trace.json>
```

The trace must show a fresh generated reference and complete analysis for every section before implementation, then a successful browser comparison after implementation. It is a deterministic guard against ordering mistakes and design drift; it does not replace visual review.

## Fidelity over generic reinterpretation

Translate the evidence, not a remembered template. Preserve the reference's composition, type relationships, spacing cadence, section ordering, color logic, and distinctive components. When details are ambiguous, first preserve the visible system; then generate a fresh detail reference. Do not silently replace a distinctive section with a generic card row or a denser layout for coding convenience.

Follow the centralized CODEMAP maintenance contract in the applicable `AGENTS.md`; do not duplicate or weaken it here.
