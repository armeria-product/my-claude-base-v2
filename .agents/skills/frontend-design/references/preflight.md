# Frontend preflight

Use this reference after the Design Read and again before delivery.

## Visual and content checks

- The Design Read and three dials explain the composition; the page is not a default centered dark hero with a purple glow.
- Hero content fits a normal desktop viewport: a focused headline, concise supporting copy, visible primary action, and a real visual or an explicit approved placeholder.
- Use one palette, one radius rule, and one typography hierarchy. Do not switch theme families section by section without an intentional story.
- Vary layouts across sections. Do not repeat equal three-card rows or alternating image/text blocks as the default page rhythm.
- Avoid cards unless elevation or grouping communicates hierarchy. Do not build screenshots or product previews from decorative rectangles.
- Use real, generated, or clearly requested placeholder assets. Image labels, fake status stamps, artificial version strings, fabricated metrics, and decorative microcopy are not visual substance.
- Keep copy concrete and readable. Avoid invented precision, generic brand names, forced poetic labels, and stock transformation language.

## Engineering checks

- Inspect dependencies before imports; use one icon family and no hand-drawn icon paths unless the task explicitly needs a custom mark.
- Use `min-h-[100dvh]`-style viewport-safe sizing rather than fixed mobile viewport height assumptions.
- Isolate motion in client leaves, clean up effects, avoid `window` scroll handlers, and keep motion motivated by hierarchy, story, feedback, or state.
- Reduced-motion behavior, keyboard navigation, focus visibility, button/form contrast, image alt text, and mobile collapse are verified.
- Reserve image/font dimensions, avoid layout-shifting media, and verify the build plus the rendered browser view.

## Evidence record shape

The validator expects an object with this minimum shape:

```json
{
  "designRead": "Marketing landing for technical buyers, calm and precise.",
  "dials": { "variance": 6, "motion": 4, "density": 3 },
  "discovery": {
    "applicableAgents": ["AGENTS.md"],
    "packageManifest": "package.json",
    "commandsChecked": ["npm run build", "npm run lint"]
  },
  "systemMapping": {
    "kind": "aesthetic",
    "name": "Tailwind implementation",
    "decision": "Existing project stack",
    "officialPackage": false
  },
  "dependencyEvidence": [{ "name": "tailwindcss", "status": "present" }],
  "accessibility": { "keyboard": true, "contrast": true, "reducedMotion": true },
  "performance": { "mediaSpaceReserved": true, "noScrollStateLoop": true },
  "build": { "command": "npm run build", "result": "pass" },
  "browserComparison": {
    "url": "http://localhost:3000",
    "screenshot": "artifacts/landing.png",
    "consoleErrors": 0,
    "interactions": ["primary CTA focus and activation"],
    "verdict": "pass"
  },
  "mode": "greenfield"
}
```

For `redesign-preserve` or `redesign-overhaul`, also add `redesignAudit` with `brandTokens`, `informationArchitecture`, and `preservationDecision`.
