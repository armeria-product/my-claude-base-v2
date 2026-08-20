---
name: preview
description: Launch a local product preview and collect browser-based visual evidence. Use for "preview", "start and inspect", or UI visual verification; not for ordinary builds or test-only checks.
---

# Preview

Use this skill to close the build-then-see loop with evidence, not merely to start a server.

1. Read the applicable `AGENTS.md`, then use `.agents/skills/preview/scripts/preview-lifecycle.mjs` to discover a launch route. It selects the nearest usable `AGENTS.md` **Commands** entry, then the closest `package.json` `dev` script, its `start` script, `Cargo.toml`, or a static `index.html`. If nothing applies, ask one concise launch question.
2. A discovered route is a suggestion only. Show its suggested **Commands** snippet, but do not write it to `AGENTS.md` or another product file without separate authorization.
3. Start only the selected local target. Use the lifecycle helper's bounded three-attempt launch path and its `finally` cleanup; do not install dependencies as a retry. Record the build path that actually served the result.
4. Use the native browser surface to capture a screenshot, inspect console errors, and exercise a representative interaction. If a mock exists, compare it side by side and classify each difference as approved, data-driven, or unfinished. Use the same build path as the acceptance judgment when one exists.
5. Report the helper's evidence schema: URL, build path, screenshot, console result, interaction, mock comparison, retry/cleanup result, and verdict. Fix console errors before calling the preview clean; visual evidence does not replace product tests.

Use `discoverPreviewCommand()` and `runPreviewLifecycle()` from `.agents/skills/preview/scripts/preview-lifecycle.mjs` for a disposable launch/probe/cleanup cycle. The helper accepts browser observations but does not replace browser inspection.
