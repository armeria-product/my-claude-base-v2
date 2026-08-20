# Codex Adapter

This workspace supports Claude Code and OpenAI Codex. `CLAUDE.md` is the canonical
cross-provider operating policy; read it before substantial work. This file only translates
Claude-specific mechanisms into Codex behavior. If the two disagree, follow the safer
interpretation and report the conflict.

## Provider boundary

- `.claude/settings.json` and `.claude/hooks/**` run only in Claude Code. Never claim that a
  Claude hook protected, formatted, journaled, or approved a Codex action.
- In Codex, use the native sandbox, approval prompts, task history, tools, and installed skills.
- There is no scope-lock mechanism, persistent lock state, or magic 「承認」「解除」 command.
  `plans/{slug}/scope.json` is an advisory review artifact only.
- Claude model aliases, Fable switches, and clover routing apply only to Claude Code. Codex
  preserves the same role/tier classification, but uses the explicit dispatch policy below.

## Codex dispatch policy

- Opus / frontier / heavy work uses `gpt-5.6-terra` with reasoning effort `xhigh`.
- Sonnet / standard work uses `gpt-5.6-luna` at its highest supported reasoning effort. Request
  `ultra` when Luna supports it; otherwise use `max` (the highest level accepted by the current
  runtime). Never silently lower it further.
- Haiku / light file exploration uses `gpt-5.6-luna` with reasoning effort `medium`.
- Apply these as explicit per-dispatch overrides. Use `fork_turns: "none"` or a bounded recent-turn
  fork when an override is required, because a full-history fork inherits the caller's model and
  effort.
- When delegation is permitted, split the task into independently useful scopes and use every
  currently available worker slot while reserving the coordinator slot. Respect dependency order
  and workflow-specific caps; never create duplicate or empty work merely to fill capacity.
- The active coordinator owns this global fan-out decision. A delegated worker must not start
  nested agents unless its dispatch explicitly grants part of the available worker allocation.
- This policy changes Codex dispatch only. It does not modify Claude frontmatter, Fable gating, or
  clover routing.

## Claude-to-Codex translation

| Canonical wording | Codex behavior |
|---|---|
| `Task` / `Agent` dispatch | Use Codex subagents only when the current session permits delegation. Apply the Codex dispatch policy above and use maximum useful concurrency; otherwise perform the role locally. |
| `AskUserQuestion` | Ask one concise plain-language question when input is genuinely required. |
| Claude slash command | Use the matching workflow through `.agents/skills/claude-harness/SKILL.md` or execute its documented steps directly. |
| Claude hook denial | Apply the underlying safety policy through Codex permissions; do not emulate a hook result. |
| Claude image workflow that launches `codex exec` | Use Codex's native image-generation skill/tool directly. Never launch a recursive `codex exec` process. |
| `/save-session` / `/resume-session` | Update or read the repository records and reconcile them with Git; Codex task history remains the conversation record. |

## Working rules

- Preserve user changes in a dirty worktree and inspect `git status --short` before broad edits.
- For planned work, trace every changed file to PLAN.md/scope.json. Put new ideas in
  `deviations.md` and ask before expanding scope.
- Changes to settings, hooks, validators, or provider adapters require the user to name or approve
  the harness itself as a target.
- Do not recursively launch `codex exec` from inside a Codex task. Use the current task and its
  native collaboration tools.
- When working under `dev/{name}/`, remember that it may be an independent Git repository.
  Start Codex at this hub root when the shared adapter must apply.

## Verification

- Harness/config changes: `node .claude/scripts/validate.mjs`
- Hook/library changes: `node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"`
- Product changes: follow the product's own build, typecheck, lint, and test commands.
