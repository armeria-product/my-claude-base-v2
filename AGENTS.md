# Codex Harness

This file is the self-contained operating policy for Codex in this repository. It does not import
Claude Code instructions. Codex reads this file once when a task starts; start a new task after
changing it.

## Native Codex surface

| Need | Native location |
|---|---|
| Named delegated roles | `.codex/agents/*.toml` with supporting `.codex/roles/*.md` |
| Planning, implementation, review, and completion contracts | `.codex/workflows/*.md` |
| Reusable workflows | `.agents/skills/*/SKILL.md` |
| Path-specific guidance | This file plus nested `AGENTS.md` files |
| Journal, session context, formatting, and safety gates | `.codex/hooks.json` and `.codex/hooks/**` |

The Claude Code configuration remains provider-specific. Do not assume that a Claude hook,
command, rule, agent, model switch, or relay configuration applies to a Codex task.

## Provider and safety boundary

- Review and trust changed project hooks through `/hooks`, then start or reload a Codex task
  before relying on them.
- Native hooks are not a host security boundary. Disabled or untrusted hooks,
  `--dangerously-bypass-hook-trust`, external terminals/editors, and actions outside the configured
  tool paths are not covered. Keep using Codex sandboxing, approval prompts, repository protection,
  and normal user confirmation.
- There is no scope-lock mechanism, persistent lock state, or magic approval command.
  `plans/{slug}/scope.json` is an advisory review artifact, not a write lock.
- Do not recursively launch `codex exec` from inside a Codex task. Use the current task and its
  native collaboration tools.

## Delegation policy

Use the custom agent that matches the bounded task. Its `.codex/agents/*.toml` configuration is the sole native source of the
model, reasoning effort, and intended sandbox mode; explicit spawn settings must agree with it. Documentation and tests may validate
its shape and roles but must not duplicate its exact model or effort values.
Read the role contract named by the custom agent before working.

| Role | Use |
|---|---|
| `planner` | plans, architecture, risks, scope, and independent plan review |
| `reviewer` | code, security, architecture, red-team, and fusion review |
| `executor` | implementation and focused refactors |
| `debugger` | reproduction, root-cause analysis, and minimal repairs |
| `verifier` | evidence-based final checks |
| `document-author` | user-facing HTML, documents, and decks |
| `explorer` | read-only discovery and file mapping |

- When delegation is permitted, split independent work into useful bounded scopes and use every available worker slot while reserving the coordinator. Never create duplicate or empty work just to fill capacity.
- The coordinator owns global fan-out. A worker must not create nested agents unless its dispatch
  explicitly grants part of the available worker allocation.
- Non-trivial changes use tiered independent review: the author never approves its own change.
  Standard work uses one independent reviewer and a fresh verifier. High-risk work involving
  permissions, secrets, destructive operations, external input, or hook-policy changes uses two
  independent lenses, a separate security review where applicable, a fresh fusion review, and a
  fresh verifier. Details are in `.codex/workflows/quality-loop.md`.

## Skills and session commands

- Use `$codex-harness` for planning, implementation, review, or completion workflows.
- Use `$save-session` to append a human session report and update the two-line state pointer.
- Use `$resume-session` to reconcile records with Git and task history, report the state, and
  wait for direction.
- These are Codex skills, not slash commands. They may also activate from a matching natural
  language request.
- Existing and later-migrated native skills inherit the common CODEMAP maintenance contract below;
  they must not duplicate or weaken it.
- Use Codex-native skills/tools for image, document, browser, and other task-specific work. Do not
  run a nested Codex process to obtain them.

## Native record contract

- The canonical append-only human journal is `tasks/journal/YYYY-MM/DD.md`. Existing
  `tasks/journal/YYYY/MM/DD.md` files are read-compatible historical records and are never moved, merged, or rewritten.
- Native lifecycle and supported edit-path events go only to `tasks/journal/.machine/YYYY-MM/DD.log`.
- SessionStart supplies bounded state, the latest human report, a compact TODO view, and CODEMAP
  headings (at most 10 KiB); it does not inject bulk lessons.
- PostToolUse records supported edit paths only. It never runs a formatter, rewrites files, or logs arbitrary shell command text.

## CODEMAP maintenance

- When a change alters project structure, entrypoints, ownership or responsibilities, or important
  control flow, update the nearest routed `tasks/codemap.md` in the same change.
- Content-only edits and behavior-only changes that do not alter those documented relationships do
  not require CODEMAP churn.
- At completion, state whether this rule applied and, when it did, verify the relevant CODEMAP
  headings and path references against the current tree.

## Path-specific instructions

Codex loads nested `AGENTS.md` files only from the project root to the directory where the task
starts; it does not dynamically reload them for a later file edit.

- Every `dev/{name}` may be its own Git repository. Before changing one, read its own
  `AGENTS.md`; launch or restart Codex from that product root when its local instructions must
  load automatically. The shared custom agents, skills, and hooks belong to this hub project, so
  start from the hub root when that complete surface is required. Use the template in
  `.codex/templates/` when bootstrapping a new product.
- Preserve user changes in a dirty worktree. Inspect the relevant repository's `git status --short`
  before broad edits.

## Working rules

- Treat a user request to answer, explain, review, diagnose, or plan as read-only unless it also
  asks for a change. For requested local changes, make in-scope edits and run non-destructive
  validation. Ask before destructive actions, external writes, purchases, or material scope
  expansion.
- For planned work, trace each changed file to `PLAN.md` and `scope.json`. Record new ideas in
  `deviations.md` and ask before expanding the intended scope.
- Lead with evidence. A claim needs a test result, command output, diff, or file reference; call
  unproven claims unverified.
- Prefer the smallest defensible implementation. Preserve records, do not invent session IDs or
  evidence, and never silently weaken a quality or safety requirement.

## Verification

- Native Codex agents, skills, workflows, or hooks:
  `node .codex/scripts/check-native.mjs`
- After a native hook registration or configuration change, additionally run
  `codex --strict-config doctor --summary` after reviewing/trusting the hooks and starting or reloading the task.
  This host-level diagnostic supplements, but does not replace, the native check command.
- Claude-only configuration changes:
  `node .claude/scripts/validate.mjs`
- Existing Claude harness regression suite:
  `node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"`
- Product changes: run the product's build, typecheck, lint, and test commands.
