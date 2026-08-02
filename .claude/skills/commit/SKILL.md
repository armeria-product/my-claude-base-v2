---
name: commit
description: >
  CLAUDE.md §3 Commit Protocol に従った構造化コミットを作成する。
  「コミットして」「commit して」「変更を保存して」と頼まれた時、
  または一連の実装が完了してコミットが妥当な区切りに達した時に使う。
  重要な変更には Constraint / Rejected / Confidence / Not-tested トレーラーを付与する。
user-invocable: true
---

# Commit - Structured Commit Protocol

## Procedure

1. **Check state** (run in parallel)
   - `git status` — overview of untracked / staged
   - `git diff HEAD` — the changes
   - `git log --oneline -5` — follow the existing message style

2. **Staging**
   - `git add` only the files relevant to the current task (don't mix in unrelated changes)
   - If unrelated changes are mixed in, propose splitting into separate commits

3. **Write the message**
   - **Language: plain Japanese** for the description / body / trailer values (no jargon, readable by a non-expert); keep the conventional prefix, the trailer keys, and code identifiers as-is (CLAUDE.md §3)
   - Line 1: conventional commit format (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`)
   - Body: write the "why", not the "what"
   - **Important changes** (those involving architecture decisions, trade-offs, or unverified parts) get structured trailers:

   ```
   Constraint: <what limited the approach>
   Rejected: <alternatives considered and rejected>
   Confidence: high/medium/low
   Not-tested: <what wasn't tested and why>
   ```

   - Trivial changes (typos / minor doc tweaks) don't need trailers

4. **Pre-commit check** (hooks block automatically, but verify ahead of time)
   - No secrets or `.env` mixed into staged files
   - No leftover `console.log` / `debugger` (excluding hook files)
   - Never use `--no-verify`

5. **Execute and verify**
   - After running `git commit`, confirm the result with `git log -1 --stat` and report

## Rules

- **Never commit to `main` directly.** `main` advances only when the user merges the PR (CLAUDE.md §3 Git Workflow). If you're on `main`, create and switch to a work branch first: `git switch -c <topic>-$(date +%F) main` (`<topic>` = short English kebab-case for the work). If you're already on the right work branch, use it as-is. The `block-direct-to-main.js` hook enforces this.
- After committing to the work branch, push it and ensure the `<work-branch> → main` PR is created/updated (auto-PR default), then report the result in plain Japanese (CLAUDE.md §3).
- If the pre-commit hook fails, fix the cause (don't bypass it)
