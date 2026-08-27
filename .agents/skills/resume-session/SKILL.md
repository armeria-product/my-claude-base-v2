---
name: resume-session
description: Reconcile a Codex task's saved records with Git and report the safe restart point. Use for `$resume-session`, “resume this session”, or an explicitly requested handoff recovery.
---

# Resume Session

This is a read-only reconciliation workflow. Do not start agents or implementation after the report;
wait for the user’s direction.

1. Select the record context using an explicit user choice, then the one `dev/{name}` with the
   strongest changed-path evidence, then workspace root. Ask if two products tie.
2. Read the selected `tasks/session-state.md`, the canonical human journal report it points to,
   active TODO/PLAN/scope records, and relevant recent `.machine` markers. Historical
   `tasks/journal/YYYY/MM/DD.md` pointers remain readable but are never normalized in place.
3. Inspect the owning repository with `git branch --show-current`, `git status --short`,
   `git log -1 --oneline`, and a diff when needed. Unexpected changes may belong to another task;
   do not touch them.
4. Treat `SESSION START` without `SESSION END` or `SAVE` only as a possible interrupted or parallel
   task. Offer `$save-session 補完` only when a real interval and ID exist.
5. Report these four concise items and stop:

   1. **現在地** — branch, latest SHA, and active plan if any.
   2. **前回の到達点** — latest report heading and its next action.
   3. **記録と現実** — mismatches, or `一致`.
   4. **推奨する次の一手** — one action.

Hooks are supporting evidence, not a complete audit trail: disabled or untrusted hooks, trust bypass,
hosted tools, external terminals/editors, and unsupported tool paths remain outside their coverage.
