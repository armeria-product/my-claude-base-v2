---
name: code-cleaner
description: Remove unnecessary code through deletion-only, behavior-preserving passes. Use for dead-code or AI-slop cleanup; not for refactors, rewrites, or formatting changes.
---

# Code Cleaner

This is a conservative deletion workflow. It preserves behavior first and leaves uncertain code in place.

1. Establish a recorded baseline with the closest existing tests or a specific behavior snapshot. Classify candidates as `DEAD_CODE`, `DUPLICATE`, `OVER_ABSTRACTION`, `DEFENSIVE_EXCESS`, or `COMMENT_NOISE`.
2. Work one category per pass. Each pass removes code only, runs the relevant check immediately, and records its actual unified diff and result.
3. Never remove TODO, FIXME, HACK, pragma, lint/test directives, `@word` directives, or comments known to feed generated artifacts. If a comment might be machine-read, keep it.
4. If a pass fails, restore only that recorded pass before proceeding; do not use a broad reset, checkout, or revert. Keep rollback evidence and skip the unsafe candidate.
5. Before handoff, run the full relevant check, inspect the final diff for additions, and obtain an independent verifier result. Validate the trace with `.agents/skills/code-cleaner/scripts/validate-cleaner-trace.mjs`.

The validator accepts an evidence trace only when its baseline, category-isolated deletion diffs, rollback records, final check, and independent verification are complete. A green trace never authorizes deletion beyond the user's requested target.
