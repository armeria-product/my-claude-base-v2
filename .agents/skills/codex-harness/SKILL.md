---
name: codex-harness
description: Run this repository's standalone Codex planning, implementation, review, verification, commit, and PR workflows. Use for `$codex-harness` or when the user asks to orchestrate a multi-step engineering task in this workspace.
---

# Codex Harness

Use `$codex-harness <workflow> <outcome>` to route Codex work through the native workflow surface.
This skill is self-contained: it uses the repository's Codex instructions, native workflows, custom
agents, and native hooks. It does not depend on another provider's commands, agents, skills, rules,
or hooks.

## Start with the active Codex instructions

Read the workspace `AGENTS.md` and every nearer `AGENTS.md` that applies to the current working
directory before selecting a workflow. Those files define the current provider boundary, model
policy, permissions, scope handling, and product-specific instructions.

Then select the smallest native workflow below and read it completely before acting:

| Requested work | Native workflow |
|---|---|
| Plan or architecture decision | `.codex/workflows/plan.md` |
| Feature, bug fix, refactor, security review, or research orchestration | `.codex/workflows/harness.md` |
| Independent review or quality loop | `.codex/workflows/quality-loop.md` |
| Completion checks and evidence | `.codex/workflows/check.md` |
| Commit | `.codex/workflows/commit.md` |
| Pull request | `.codex/workflows/pr.md` |

For session work, invoke the standalone skills directly: `$save-session` or `$resume-session`.

## Native execution rules

- Follow the selected workflow's custom-agent and verification requirements. Do not substitute an
  unregistered role note for a native role contract.
- Apply the model and reasoning-effort policy from the active `AGENTS.md` as explicit dispatch
  settings. The coordinator owns useful parallelism and must not create duplicate work merely to
  fill slots.
- When PLAN/scope artifacts exist, pass their paths to delegated workers and require each worker
  to read them. Treat scope as a review boundary, not a write lock or approval token.
- Preserve unrelated worktree changes. Inspect `git status --short` before broad edits and keep
  findings traceable to the approved task.
- Use the trusted `.codex/hooks.json` layer only for the behavior it actually observes. It is not a
  complete security boundary: disabled or untrusted hooks, trust bypass, external terminals/editors,
  and unsupported tool paths remain outside it.
- A request for a new provider capability or an expansion beyond the approved scope requires a
  user decision before implementation.

## Handoff shape

Every delegated work unit returns:

1. **Outcome** — what is now true and why it matters.
2. **Evidence** — commands, tests, or inspected source supporting the claim.
3. **Changed files** — precise paths, or `none`.
4. **Open items** — blockers, uncertainty, or decisions required.
5. **Next action** — the most useful bounded follow-up.

For non-trivial code, keep writer, reviewer, and verifier independent. Do not report completion
until the selected workflow's evidence gate passes.

## Invocation examples

```text
$codex-harness plan Add native audit exports
$codex-harness feature Implement the approved export plan
$codex-harness check Verify the current harness change
```

The first token after `$codex-harness` is a workflow hint, not permission to skip the active
instructions or the workflow's own decision gates.
