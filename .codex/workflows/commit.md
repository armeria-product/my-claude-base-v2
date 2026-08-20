# Native commit workflow

Commit only with the user current authorization.

1. Confirm a non-protected feature branch, intended status, and diff. Never clean, stage, or overwrite unrelated user changes.
2. Confirm applicable verification evidence and any review result.
3. Before staging, name the approved files and run the bounded, read-only worktree scan:

   ```text
   node .codex/scripts/check-commit-safety.mjs --worktree -- <approved-path>...
   ```

   Pass only literal safe repository-relative paths belonging to the approved work. Treat every
   finding as a stop: the scanner checks credential-shaped literals, private-key headers,
   `console.log` / `debugger`, and project-specific generated or debug artifacts, and reports
   category, path, and line only — never a credential value. Its only exception is a clearly marked
   placeholder token in a test fixture; do not create a manual allowlist.
4. Stage only files belonging to the approved work.
5. Immediately scan the exact full staged diff, including anything that was already staged:

   ```text
   node .codex/scripts/check-commit-safety.mjs --cached
   ```

   Do not commit while this scan reports a finding or fails to inspect the diff.
6. Write a concise conventional commit subject and a plain-Japanese body. For material changes, record constraints, rejected alternatives, confidence, and untested limits.
7. Report the commit identifier, changed surface, and verification evidence.

The user, not an agent, merges protected branches.
