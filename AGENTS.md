# Codex Repository Guidance

This repository has separate Claude Code and Codex surfaces. Codex follows this file and the
repository-local `.codex/` and `.agents/` files; it does not inherit `.claude/**` as an execution
contract.

## Sol-led / Luna-implemented operation

- Main Sol owns user interaction, requirements clarification, investigation and root-cause
  analysis, architecture and design, difficult reasoning, implementation strategy/planning/
  decomposition, risk/dependency/migration/compatibility/security/performance/debugging decisions,
  the Luna handoff, diff/code review, and final verification.
- Luna Max owns actual artifact changes: source, test, and configuration code; refactors;
  repetitive or mechanical edits; file creation, moves, and renames; test/lint/typecheck/build
  fixes; generated files; and implementation-adjacent documentation.
- Every artifact-changing request dispatches the project custom agent `luna_max`
  (`gpt-5.6-luna`, `max`) after Main Sol's bounded handoff. Main Sol must not directly edit
  source, tests, configuration, or deliverable artifacts; read-only diagnostics and verification
  remain allowed.
- Difficulty never changes ownership. For hard work, Sol decides the design, invariants,
  algorithm, and targets, Luna edits, and Sol reviews. Small edits also go to Luna. Read-only and
  diagnostic work remains Main Sol's responsibility: reads, searches, status, diffs, tests, builds,
  lint, logs, browser checks, and screenshots.
- Product Design, UI/UX, Skill, and Plugin work do not change ownership. Main Sol owns current-state
  and UX analysis, information architecture/design decisions, and the implementation plan. Luna Max
  owns React/CSS/component/layout/responsive/accessibility/test edits. Main Sol owns browser,
  screenshot, UX, diff, and final verification.
- Before dispatching Luna, Main Sol must provide a bounded handoff containing the purpose,
  cause/current evidence, targets, non-targets, implementation approach, invariants, edge cases,
  error handling, backward-compatibility requirements, required tests, and completion criteria.
  Luna must report missing or contradictory design needed for correctness instead of inventing
  product-level architecture.
- Use one implementation Luna at a time and reuse that same Luna thread for corrections. There is
  no standing Planner/Executor/Reviewer/Verifier chain. Extra agents are limited to independent
  parallel research, separate-context read-only review, adversarial security analysis, or truly
  independent units of work; they do not create duplicate writers.
- If Luna, the custom agent, its model/effort, or spawning fails, Main Sol stops and reports what
  failed, why, the intended model `gpt-5.6-luna` and effort `max`, and that no Main implementation
  fallback occurred. Main Sol must never silently take over artifact edits.
- Main Sol's mandatory review covers `git diff`, requirements/design match, unrelated changes,
  regressions, edge and error handling, security/performance, coverage, and build/lint/typecheck/
  test results. Problems mean Sol redesigns the correction, the same Luna edits it, and Sol
  re-reviews it.
- This repository does not force the user's global model or reasoning settings. The intended Main
  baseline remains GPT-5.6 Sol with xhigh reasoning and Fast mode enabled by the user; the project
  Luna implementation default is `gpt-5.6-luna` with `max` effort.
- `$save-session` and `$resume-session` remain their narrow save/resume workflows and do not start
  implementation. Do not recursively launch `codex exec` from a Codex task; use the current task
  and native tools.

## Safety boundary

- Preserve unrelated user changes. Inspect `git status --short` before broad edits, including in a
  nested `dev/{name}` repository.
- Treat answer, explanation, review, diagnosis, and planning requests as read-only unless the user
  also asks for a change.
- Ask before destructive operations, writes outside the selected workspace, external side effects,
  purchases, or material scope expansion.
- Never read or edit likely secrets such as `.env`, credentials, private keys, or secret stores.
- Repository hooks supplement Codex sandboxing, approvals, and repository protection; they are not
  a host security boundary. Disabled, untrusted, or bypassed hooks and external tools remain outside
  their coverage.
- Review changed project hooks with `/hooks`, trust the exact definitions, and start or reload the
  task before relying on them.

## Working and verification rules

- Prefer the smallest defensible implementation. Do not add compatibility layers or workflow files
  beyond the Sol-led/Luna-implemented contract already provided here.
- Lead with evidence. Support completion claims with relevant command output, tests, diffs, or file
  references; label anything else unverified.
- Run proportionate build, typecheck, lint, and test commands for product changes, then inspect the
  final diff. A failed check is not a passing result.
- For this Codex harness, run `node .codex/scripts/check-native.mjs`. After hook registration changes,
  also run `codex --strict-config doctor --summary`; report host-level failures separately from
  repository validation.

## Session records

- Human reports are append-only at `tasks/journal/YYYY-MM/DD.md`. Historical
  `tasks/journal/YYYY/MM/DD.md` files remain read-compatible and are never moved or rewritten.
- Native lifecycle and direct-edit events go only to
  `tasks/journal/.machine/YYYY-MM/DD.log`. Hooks do not record arbitrary shell text.
- Use `$save-session` only at an explicit or useful work boundary. Use `$resume-session` to reconcile
  the state pointer, journal, Git, and any active plan before continuing.
- `session-state.md` is a two-line pointer, not a duplicate report or task list. Never invent a
  session ID, marker, test result, or historical event.

## CODEMAP maintenance

- Update the nearest routed `tasks/codemap.md` when a change alters structure, entrypoints,
  ownership/responsibilities, or important control flow.
- Content-only and behavior-only edits that leave those relationships unchanged do not require
  CODEMAP churn.
- At completion, state whether this rule applied. When it did, verify the relevant headings and path
  references against the current tree.

## Path-specific instructions

- Codex loads nested `AGENTS.md` files only along the path where a task starts; editing a different
  directory later does not dynamically load its instructions.
- Each `dev/{name}` may be an independent Git repository. Read its own `AGENTS.md` before changing it,
  and start a task from that product root when its local instructions must apply automatically.
- Keep product-specific task state in that product's `tasks/` directory. The hub human journal stays
  at the workspace root.
