---
name: save-session
description: Save the current Codex task with an evidence-backed Japanese handoff report, a two-line resume pointer, and an optional real journal SAVE marker. Use for `$save-session`, `$save-session 補完`, “save this session”, or an explicitly requested work-boundary handoff.
---

# Save a Codex Session

Use this standalone Codex workflow only through `$save-session` (current task) or
`$save-session 補完` (an evidenced prior task interval). It is an agent-run workflow, not an
automatic end-of-session action.

## Non-negotiable record rules

- The journal is always the workspace-root `tasks/journal/YYYY-MM/DD.md`; it never moves into
  `dev/{name}/tasks/`.
- Journal and history records are append-only. Never rewrite or delete past journal lines.
- `session-state.md` is exactly a two-line pointer. Next actions, holds, and user questions live
  only in the journal report.
- Use only observed native-hook records, Codex task history, Git, and existing task files. Missing
  evidence is `未検証`; never invent a session ID, hook activity, machine line, or test result.
- A trusted native-hook context can be useful evidence. Untrusted, disabled, bypassed, or absent
  hooks require the same workflow using task history, Git, and real files instead.

## Invocation and mode

- `$save-session` saves the current task.
- `$save-session 補完` may backfill a prior task only when its real journal interval and ID can be
  identified. Otherwise explain that completion cannot be produced safely.
- Suggest this skill at a logical boundary, before a requested compaction, or before ending work;
  do not run it merely because a turn happens to end.

## 1. Resolve the record location

Select the first applicable context:

1. An explicit user-selected save location.
2. One product with the strongest evidence in changed files and recent tool activity under
   `dev/{name}/`.
3. Workspace root when no product is identified.

If two products tie, ask one plain-language question before writing records. For a selected product,
write state files under `dev/{name}/tasks/`; otherwise use root `tasks/`. If a selected product has
no task directory, create only the missing directory and these missing files:

```markdown
# TODO — {product}

## Now
## Backlog
## Recently Done
```

```markdown
# Session State — {product}
## START HERE — [YYYY-MM-DD HH:MM] — <branch・latest SHA> → tasks/journal/YYYY-MM/DD.md の HH:MM レポート
```

```markdown
# Lessons — {product}
```

Do not bootstrap root task records, `roadmap.md`, or `codemap.md`.

## 2. Reconcile planned scope when one exists

When a current PLAN/scope artifact governs the work, run `git status --porcelain` in the repository
that owns the changed files and compare its paths with the declared allow/forbid patterns and task
list. List mismatches as proposed deviations in **確認してほしいこと**. Do not broaden scope or
implement the deviation while saving the session.

## 3. Gather evidence

Inspect, in this order where available:

1. The current task's observed native journal marker and machine lines.
2. Codex task history.
3. `git status --porcelain`, `git diff`, and `git log -1 --oneline` in the owning repository.
4. Existing task records, including the latest report and active todo/roadmap entries.

The journal is a global timeline even for product work. If a claim cannot be supported by those
sources, state `未検証` rather than inferring it.

## 4. Append the human report

Append one report to the current root journal. Write plain Japanese: the heading is a one-line
conclusion, each field stays concise, and detailed file lists remain in Git and machine lines.

```markdown
## HH:MM セッションレポート — <結論1行>

**やったこと**: <成果と検証結果。1〜3行>
**できなかったこと・保留**: <内容、または なし>
**確認してほしいこと**: <判断が必要なこと、または なし>
**次にやること**: <最初の一手から最大5行>
```

If an applicable plan has an existing deviations record, summarize only genuinely useful,
unapproved ideas as proposals in **確認してほしいこと**. Never treat a proposed deviation as work
already authorized.

## 5. Update the resume pointer

Overwrite the selected `session-state.md` with exactly two lines:

```markdown
# Session State — {context}
## START HERE — [YYYY-MM-DD HH:MM] — <branch・latest SHA> → tasks/journal/YYYY-MM/DD.md の HH:MM レポート
```

Do not put next steps, blockers, scope notes, or a duplicate report in this file.

## 6. Add a SAVE marker only when real

Append this one line only when the current native context supplied a real ID, or `$save-session 補完`
identified a real prior ID:

```markdown
- HH:MM:SS [xxxxxxxx] SAVE
```

Without that evidence, omit the marker. Never create a plausible-looking ID.

## 7. Keep task records tidy

Append a lesson only when a session produced a hard-won, repository-specific rule with Trigger,
Mistake, Fix, and Rule. Keep todo items one line each; keep unfinished work in `## Now` or
`## Backlog`, and cap `## Recently Done` at ten entries.

## Completion report

Tell the user what was saved, the evidence source used, whether a SAVE marker was written, and any
scope mismatch or decision still needed. Do not claim that native hooks ran unless their real output
or records were observed.
