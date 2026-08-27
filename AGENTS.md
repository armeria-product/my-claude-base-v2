# Codex Repository Guidance

This repository has separate Claude Code and Codex surfaces. Codex follows this file and the
repository-local `.codex/` and `.agents/` files; it does not inherit `.claude/**` as an execution
contract.

## Main-first operation

- Main Codex owns ordinary investigation, planning, implementation, tests, and diff review.
- Finish normal work in the current task. Do not create a subagent merely because work is large,
  difficult, spans many files, or needs build, lint, or test commands.
- Use subagents only when independent context materially helps: parallel independent research,
  read-only review separate from Main's implementation, adversarial security analysis, or clearly
  separable large work. Do not create duplicate work or a standing Planner/Executor/Reviewer/
  Verifier chain.
- This repository does not force the user's global model or reasoning settings. The intended Main
  baseline is GPT-5.6 Sol with xhigh reasoning and Fast mode enabled by the user.
- Do not recursively launch `codex exec` from a Codex task. Use the current task and native tools.

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
  for behavior Main Codex already provides.
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
