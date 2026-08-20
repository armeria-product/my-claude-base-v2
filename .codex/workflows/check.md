# Native completion checks

Before reporting completion:

1. Read the diff and current status; separate user changes from this work.
2. Run the nearest build, type, lint, test, and behavior checks that exist for changed product code.
3. For native agents, skills, workflows, hooks, or registration, run `node .codex/scripts/check-native.mjs`.
   This is the single shared local and CI entry point.
4. When journal or session records are involved, run `node .codex/scripts/records-doctor.mjs` for a
   read-only layout diagnosis when it helps explain the observed state.
5. After changing native hook configuration or registration, review and trust the hooks, start or reload
   the task, then run `codex --strict-config doctor --summary` when the host supports it. This diagnostic
   does not execute the registered hook fixtures and never replaces `check-native`.
6. When a change alters project structure, entrypoints, ownership or responsibilities, or important
   control flow, update the nearest routed `tasks/codemap.md` in the same change. For content-only or
   other behavior-only changes that do not alter those relationships, state that the rule is not applicable
   rather than churning the map. For an update, verify its relevant headings and path references against
   the current tree.
7. For a document, check self-containment and render or open it when possible. Treat actual
   remote resource-bearing attributes, CSS imports, and CSS `url(...)` references as failures;
   do not reject URL text in prose, code examples, or inert manifests. For a UI, use the `preview`
   skill to record the build path, screenshot, console state, interaction result, and mock comparison
   when those checks apply.
8. Run `git diff --check` and state commands, observed results, branch/operating-system scope, and every
   skipped or unverified check.

Use the verifier role for non-trivial completion claims. A failing required gate is not complete.
