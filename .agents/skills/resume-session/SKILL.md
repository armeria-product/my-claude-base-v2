---
name: resume-session
description: Reconcile a Codex task's records, Git state, and active plan before continuing. Use for `$resume-session`, “resume this session”, or an explicitly requested safe handoff recovery.
---

# Resume a Codex Session

Use this standalone Codex workflow through `$resume-session`. It reports the verified current state
first and then waits for the user's direction; do not begin implementation by itself.

## Non-negotiable record rules

- The work journal is the workspace-root `tasks/journal/YYYY-MM/DD.md`, including product work.
- `session-state.md` is a two-line pointer, not a second copy of next actions or blockers.
- A native SessionStart context is useful only when actually present. When it is absent, read real
  records, Codex task history, and Git directly.
- Never manufacture a machine line, session ID, save marker, or claim that hooks were active.
- Unexpected changes can belong to a parallel task. Do not modify them while reconciling.

## Invocation

- Use `$resume-session` for a current or newly opened Codex task.
- Do not present this as a slash command.
- Use the same root-versus-product context selection as the save workflow: explicit user location,
  strongest changed-path/recent-activity evidence under `dev/{name}/`, then root; a tie requires a
  plain-language question before selecting a product record set.

## 1. Read the record trail

Read the selected `session-state.md` first, then the journal report it points to. Read the prior
journal day when the latest report is incomplete or points there. Also inspect the active todo and,
when relevant, roadmap and codemap.

If native SessionStart context already supplied a latest report and a real journal ID, do not repeat
that read merely to duplicate context. Still verify Git and the plan. Without such context, use
Codex task history, existing records, and Git directly.

Scan real recent journal markers when useful:

- `SESSION START` without a corresponding `SESSION END` or `SAVE` is a possible interrupted or
  still-parallel task.
- `SESSION END` without `SAVE` is an ended task without a human report.

Treat both as observations, not proof of a crash. Offer `$save-session 補完` only if an actual marker
interval and ID exist.

## 2. Reconcile records with reality

Use the repository that owns the selected context and inspect:

| Check | Evidence | What to compare |
|---|---|---|
| Branch | `git branch --show-current` | The pointer's recorded branch |
| Uncommitted work | `git status --porcelain` | Unrecorded paths and possible parallel work |
| Latest commit | `git log -1 --oneline` | The pointer's SHA and report claims |
| Plan and scope | Active PLAN/scope artifacts, if any | Task list, allow/forbid paths, and unresolved deviations |

Do not silently repair a mismatch. Mark it clearly as a mismatch, preserve the evidence, and ask the
user what to do if the decision changes the work.

## 3. Report and stop

Report in plain Japanese, then wait. Include exactly these four concise items:

1. **現在地** — branch, latest SHA, and active plan name when one exists.
2. **前回の到達点** — the latest report heading and its next action.
3. **記録と現実** — each mismatch, or `一致`.
4. **推奨する次の一手** — one action; when supported by real markers, include the optional
   `$save-session 補完` choice.

After this report, do not edit files, update records, start agents, or continue implementation until
the user gives a new direction.

## Limits disclosure

Trusted native hooks can inject bounded records and journal supported local tool calls. They do not
prove complete history and do not cover disabled hooks, trust bypass, external terminals/editors, or
other task activity. Keep the report grounded in the observable records and Git state.
