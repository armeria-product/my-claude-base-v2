---
description: エージェント定義ファイルを変更する際のルール
paths:
  - .claude/agents/*
---

# Agent Definition Rules

When changing agent definitions under `.claude/agents/`, observe the following:

- Keep the frontmatter format (model, description, tools, etc.) consistent
- `model:` must be either a tier alias (opus / sonnet / haiku / inherit) **or** a clover relay model id (`claude-<alias>` where `<alias>` exists in `clover/models.json`). Pinning a **real** Claude model id (e.g. `claude-opus-4-8`) is forbidden — it breaks on version updates.
  - A clover model id pins the agent to an external model (via the relay) and, unlike a real Claude id, does not break on version bumps (it resolves through `models.json`). **Caveat**: such an agent only works in a session launched through clover (the custom model option must be registered); in a plain session — or when the relay fell back — it fails with "model may not exist". For a portable "route this agent to GPT only when relay is on" behaviour, prefer the `RELAY-MODEL:` marker (relay skill) instead, which the conductor adds per spawn and which degrades gracefully.
- **Never** grant write-capable tools (Edit / Write / write-capable Bash) to review-only agents
- For read-only agents (reviewer / verifier / explorer),
  Bash is **limited to read and test-execution purposes only**. Do not use it for redirection, file generation, or git writes
  (state this constraint in the system prompt as well). Sole exception: the reviewer's adversarial mutation probes inside a disposable worktree explicitly granted in the dispatch prompt (SOT: reviewer.md "Rules (all targets)") — the main tree stays untouchable.
- Changes to agent definitions affect all projects — confirm the scope with the user
- After changing, verify it works on a simple task to confirm nothing is broken
