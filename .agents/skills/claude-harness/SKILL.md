---
name: claude-harness
description: Use this repository's planning, implementation, review, verification, session, documentation, frontend, commit, and PR workflows from Codex or GPT.
---

# Claude Harness Adapter for Codex

Read `AGENTS.md` and `CLAUDE.md` first. Then select the smallest matching canonical workflow
below and read that file completely before acting:

- planning → `.claude/skills/plan/SKILL.md`
- feature/bugfix/refactor/research orchestration → `.claude/skills/harness/SKILL.md`
- independent review loop → `.claude/skills/quality-loop/SKILL.md`
- completion checks → `.claude/skills/check/SKILL.md`
- commit or PR → `.claude/skills/commit/SKILL.md` or `.claude/skills/pr/SKILL.md`
- session save/resume → `.claude/commands/save-session.md` or
  `.claude/commands/resume-session.md`
- document/frontend/image workflows → the matching directory under `.claude/skills/`

Apply the provider translations in `AGENTS.md` while following the selected workflow:

- Claude hooks and permissions are not active in Codex.
- Use Codex-native tools and skills for equivalent capabilities.
- Treat the Codex model and concurrency policy in `AGENTS.md` as the single source of truth:
  apply its role mapping with explicit per-dispatch overrides and use maximum useful concurrency
  when delegation is permitted.
- Treat scope.json as a review artifact, never as a lock or approval token.
- Never require a magic approval phrase; ordinary explicit user authorization is sufficient.

After harness/config work, run the verification commands from `AGENTS.md`.
