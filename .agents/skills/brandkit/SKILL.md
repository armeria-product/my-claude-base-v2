---
name: brandkit
description: Create image-only premium brand-kit boards, logo-system concepts, and identity-direction assets. Use for visual brand direction, not implementation or production code.
---

# Brandkit

Create a coherent, presentation-ready brand world as images only. Do not write
HTML, CSS, application code, or implementation instructions.

## Plan before rendering

Infer or state a compact strategy: category, audience, product function,
emotional promise, cultural position, trust level, visual world, core metaphor,
and what the brand must avoid. The visual system must make that strategy
legible; never choose a logo symbol merely because it is decorative.

Unless the brief specifies another format, plan one 3 by 3 overview in 4:3 or
16:10. It should cover logo, construction, digital application, essence,
palette, type, physical application, image direction, and system detail. Use a
smaller 2 by 3 or 2 by 2 board only when it better fits the request.

Read [art direction](references/art-direction.md) when choosing the logo method,
visual mode, panel sequence, palette, or reference treatment.

## Native image route and asset manifest

Use native imagegen directly. Never run a nested agent command, external relay,
or provider quota check.

Before every generation, add exactly one manifest entry with:

- a descriptive, relative destination under an assets directory;
- one imagegen call with exactly one output;
- a prompt that includes the locked strategy, layout, visual mode, palette, and
  artifact purpose.

Default paths use assets/brandkit-{brand}-{artifact}.png. Generate a board,
logo study, or mockup in separate calls; one call never produces a batch or
collage. After a platform-supported file handoff, verify that the selected
destination exists and is non-empty. If native imagegen returns only a
conversation image and no local artifact path, say that it was not copied
instead of claiming a file exists; ask for a destination/copy instruction.

Validate saved manifests before rendering:

    node .agents/skills/brandkit/scripts/validate-brandkit-plan.mjs path/to/brandkit-plan.json

The validator protects image-only operation, panel evidence, one-call-per-image,
and safe descriptive asset paths. It does not generate images.

## Quality bar

Use calm presentation grids, strong gutters, sparse readable type, a repeated
logo system, and one disciplined palette. Every panel should be connected but
not equally loud. Prefer an ownable reduced mark, a believable identity
application, and an image direction tied to the brand metaphor.

Do not copy a supplied logo, slogan, composition, or distinctive asset. Extract
quality, rhythm, density, and color logic instead. Regenerate weak output rather
than accepting generic marks, stock-like scenes, rainbow palettes, tiny fake
copy, or busy dashboard mockups.
