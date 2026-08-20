---
name: imagegen-frontend-web
description: Create image-only, section-by-section horizontal website design references. Use for visual web comps, not frontend implementation.
---

# Website reference images

Create premium, implementation-readable website reference images only. Do not write
frontend code, edit a product, or collapse a site request into one tall mockup.
Route implementation work to frontend-design or image-to-code instead.

## Decide the site system

Infer the site type and conversion goal, then state the count before rendering.
Respect an explicit count. Otherwise use one image for a hero, six for a landing
page, product page, portfolio, or unspecified site template, and eight for a
full website or marketing site.

Lock one site system: palette, typography, CTA family, radius language, image
treatment, tonal voice, hero scale, concept spine, and one second-read motif.
Choose exactly four signature components and two motion-implied cues. For every
section choose a job, composition anchor, background mode, and CTA treatment.
The hero must not default to text-left/image-right merely from habit.

Read [art direction](references/art-direction.md) when setting the visual dials,
section pack, composition variation, or anti-generic checks.

## Native image route and asset manifest

Use native imagegen directly. Never run nested agent commands, external relays,
provider quota checks, or code-generation tools.

Make exactly one horizontal imagegen call for each section. A landing plan with
six sections has six separate calls; a full-site plan with eight sections has
eight. Every manifest entry needs one output, a unique descriptive relative
asset path, and a prompt carrying its section role and the locked continuity
system. A useful default is:

    assets/{site}/sections/{number}-{section}.png

Never batch sections, use a tall page slice, reuse a crop as a section, or stop
before all promised sections are generated. Label returned images as Section X
of N and name their purpose.

After a platform-supported file handoff, verify each destination exists and is
non-empty. If native imagegen returns only a conversation image, state that it
was not copied rather than inventing a saved path.

Validate a saved manifest before rendering:

    node .agents/skills/imagegen-frontend-web/scripts/validate-web-plan.mjs path/to/web-plan.json

## Deliverable quality

Each image must explain hierarchy, spacing, type scale, CTA priority, component
shape, image treatment, and section rhythm well enough to implement. The set
must read as one brand while varying composition, density, background, and
visual tempo. Use imagery as structural material where the brief permits it.

Avoid cloned card rows, dashboard spam, default purple-blue glow, pointless
blobs, unreadable fake logos, tiny copy, generic slogans, and decorative
complexity that obscures the funnel. If a non-minimal set becomes repetitive or
loses continuity, regenerate the affected sections rather than mixing systems.
