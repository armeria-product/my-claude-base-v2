# <product-name> product guidance

This is an independent product repository. Treat its worktree and task
records as local to the product; do not assume a parent repository's Git state
or instructions are automatically in scope.

The shared Codex custom agents, skills, and hooks live in the hub project. Start
a Codex task from that hub when those shared capabilities are required; this
product-local file intentionally provides only path-specific product guidance.

## Product work

- Prefer clear failure modes and recoverable behavior over speculative scope
  expansion.
- For a vague new product or substantial feature request, first establish the
  user outcome, constraints, and acceptance criteria. Skip that discovery for
  a concrete, bounded fix.
- Keep cross-boundary work limited to explicitly authorized interfaces. Report
  contradictions or missing authority instead of silently expanding scope.
- Before substantial work, read the product's active TODO, lessons, and
  roadmap records. The local record rules live in `tasks/AGENTS.md`.
- Trace planned changes to their plan and scope artifact. Put genuinely new
  ideas in a deviations record and request direction before implementing them.
- Keep the codemap accurate when product structure or important control flow
  changes. Use `path:line#anchor` references.

## Verification

Run the product's relevant build, typecheck, lint, and test commands for
product changes. Preserve unrelated worktree changes, report what you did
not verify, and do not claim a passing result without command evidence.
