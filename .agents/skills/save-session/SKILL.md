---
name: save-session
description: Save the current Codex task as a concise Japanese handoff report and two-line resume pointer. Use for `$save-session`, `$save-session 補完`, “save this session”, or an explicitly requested work boundary.
---

# Save Session

Run only when explicitly requested or at a user-approved work boundary. This skill does not start
agents, review loops, commits, pushes, or new implementation.

1. Select the record context: an explicit user choice first; otherwise the one `dev/{name}` owning
   the current changes; otherwise workspace root. When two products tie, ask before writing.
2. Read observable evidence: current task history, today’s
   `tasks/journal/.machine/YYYY-MM/DD.log`, `git status --short`, `git diff`, `git log -1 --oneline`,
   and any active PLAN/scope records. Never invent a test result, event, or session ID.
3. Append one human report to the workspace-root canonical
   `tasks/journal/YYYY-MM/DD.md`. Historical `tasks/journal/YYYY/MM/DD.md` files are read-only.

```markdown
## HH:MM セッションレポート — <結論1行>

**やったこと**: <成果と検証結果。1〜3行>
**できなかったこと・保留**: <内容、または なし>
**確認してほしいこと**: <判断が必要なこと、または なし>
**次にやること**: <最初の一手から最大5行>
```

4. Replace the selected root or product `tasks/session-state.md` with exactly two lines. Put next
   actions only in the report, never duplicate them here.

```markdown
# Session State — <context>
## START HERE — [YYYY-MM-DD HH:MM] — <branch・latest SHA> → tasks/journal/YYYY-MM/DD.md の HH:MM レポート
```

5. Append `- HH:MM:SS [xxxxxxxx] SAVE` to today’s `.machine` log only when the current hook context
   supplied a real ID, or 補完 mode identifies a real prior interval and ID. Otherwise omit it.
6. Preserve all journal/history entries. Report what was saved, the evidence used, whether a SAVE
   marker was written, and any unverified item or scope mismatch.
