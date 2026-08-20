# Native completion checks

Before reporting completion:

1. Read the diff and current status; separate user changes from this work.
2. Run the nearest build, type, lint, test, and behavior checks that exist for changed product code.
3. For native configuration, run native static tests and codex --strict-config doctor.
4. For a document, check self-containment and render or open it when possible.
5. State commands, observed results, branch/operating-system scope, and every skipped or unverified check.

Use the verifier role for non-trivial completion claims. A failing gate is not complete.
