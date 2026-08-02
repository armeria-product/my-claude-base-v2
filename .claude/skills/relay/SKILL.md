---
name: relay
description: >
  外部モデル（GPT 系など）への振り分け規約の SOT（正本）。worker を `RELAY-MODEL:<alias>`
  マーカー付きで spawn する手順、alias の参照（辞書は models.json）、複数モデル指名時の合議(fan-out)の組み方を定義する。
  「外部モデルで」「RELAY-MODEL」「gpt で動かす」「別モデルで」「合議」「複数モデルで意見を聞いて」
  と頼まれた時、または harness/quality-loop が worker の backend を外部モデルに振る時に使う。
user-invocable: true
---

# Relay — External Model Routing (SOT)

Route **specific sub-agent workers** to external models (e.g. an external GPT model) while the main
conversation always stays on Claude. The path is the `clover` relay (router + shim).

## Gate (see CLAUDE.md §1.8)

External models may be used only when `.claude/.relay-status` reads `ON` (trimmed + uppercased).
If it is `OFF` or missing, the relay is not running — do not use markers or external-model councils; do everything
with standard Claude. This section only reads the ON/OFF state (the gate logic itself is owned by
CLAUDE.md §1.8). Toggling ON/OFF is done by invoking this same skill as `/relay on|off` (see the next
section); the routing rules further below are this skill's SOT role.

## `/relay on | off | status` — ON/OFF toggle

This skill is also the `/relay` toggle. When invoked as `/relay on|off|status` (an argument is given),
perform the matching action below and report in plain Japanese; with **no argument**, do the `status`
branch. `.claude/.relay-status` holds exactly one word, `ON` or `OFF` (trim + case-insensitive). **ON also
starts the clover relay server (router 8788 / shim 8791); OFF stops it.** Whether external models are
actually reachable still depends on whether *this* session was launched via `clover/bin/clover`
(the server merely being up does not route a plain `claude` session through it).

**on**
1. Write `ON` (that one word only, no extra newlines/text) into `.claude/.relay-status`.
2. Run `bash clover/bin/relay-serve start` to bring up the relay server (idempotent — reuses a running one).
3. Run `echo "$ANTHROPIC_BASE_URL"` to check whether this session is on the relay path.
   - `http://127.0.0.1:8788` → external-model selection is effective in this session too.
   - otherwise → report (plain JP): the relay server started, but this session itself is not routed through it (needs launch via `bin/clover`); external-model selection won't take effect here.
4. Report (plain JP) 「relay を ON にしました（中継サーバーも起動）」 with the `relay-serve` result (UP or failed).

**off**
1. Run `echo "$ANTHROPIC_BASE_URL"`. If it is `http://127.0.0.1:8788`, this session itself talks through the relay server — do **not** stop it silently; warn (plain JP) that stopping now would cut this conversation, note it stops automatically at session end, recommend leaving it or stopping from another session, and confirm before stopping.
2. Write `OFF` (that one word only) into `.claude/.relay-status`.
3. Only if not self-connected (or the user confirmed) run `bash clover/bin/relay-serve stop` to stop the server (8788/8791).
4. Report (plain JP) 「relay を OFF にしました（中継サーバーも停止）」.

**status** (also the no-argument case)
Read `.claude/.relay-status`, trim + uppercase to decide. Also run `bash clover/bin/relay-serve status` for the server state (8788/8791), and report both in plain JP (e.g. 「今は ON。中継サーバーも起動中（8788/8791 UP）」／「今は OFF（relay は動いていません）」). A missing file counts as OFF.

Toggle rules: write only `ON` / `OFF` (one word); create the file if missing; compare trimmed + case-insensitive.

## What it does

- The main conversation (conductor) always stays on Claude — unchanged.
- Only **specific sub-agent workers** are routed, through the `clover` relay, to an external
  model (e.g. an external GPT model).
- Standard tier names (`opus`/`sonnet`/`haiku`/`inherit`) are out of scope here — no marker, Claude
  passes through as-is.

## Marker syntax

```
RELAY-MODEL: <alias>
```

Resolution priority:
1. the request `system` field
2. the true first line (after noise-stripping) of the first user message ("form C")

**Put the marker as the single first line of the prompt used to spawn the worker.** In the prompt path
(priority 2) a marker on any non-first line is ignored on purpose — a safe-side fallback against
misfires. (The `system` field, priority 1, is matched anywhere in the system text, so do not leave
stray `RELAY-MODEL:` lines there.)

## How to run a worker (no dedicated worker file)

To run a role on an external model, spawn that role's existing agent (reviewer / planner / executor,
etc.) or a generic agent via the Task/Agent tool, with `RELAY-MODEL: <alias>` as the **first line** of
the prompt. Write the role and request from the second line onward.

```
RELAY-MODEL: <alias>   # a key in clover/models.json
[the usual request from here: role, task, expected output]
```

Because the marker does the routing, there is no need to create dedicated per-`role × backend × model`
worker files (CLAUDE.md §1.7 Simplicity First).

## Direct model-field routing (main session)

A second, independent path exists for routing the **main session itself** (not a spawned worker) to an
external model. `/model` only ever shows **one** custom entry, `models.json`'s first model as
`claude-<alias>` (`ANTHROPIC_CUSTOM_MODEL_OPTION`) — Claude Code's official multi-model auto-listing
(gateway discovery) requires API-key/`ANTHROPIC_AUTH_TOKEN` auth and does not fire under subscription
OAuth login, which is what clover's wrapper uses (verified empirically; do not assume it works). To use
any other `models.json` entry as the main session's model, set it explicitly: `/model claude-<alias>`,
`claude --model claude-<alias>`, or `ANTHROPIC_MODEL=claude-<alias>` — the router resolves this field
(prefix, bare alias, or model name, all case-insensitive) regardless of whether it's listed in `/model`,
with **lower priority than the marker** — a `RELAY-MODEL:`-tagged worker spawned from a GPT-selected
main session still routes to the marker's alias, not the session's. Full detail:
`clover/README.md` "`/model` からの直接利用".

## Aliases（辞書は models.json）

`clover/models.json` is the alias dictionary itself (SOT). Each entry sets `alias` / `via` /
`effort` / `verbosity` in one line — look there directly for the current alias list; this file does not
keep a second copy of it.

Rules (kept here so they don't go stale as aliases change):
- **alias = the dictionary key**, resolved by exact string match. A real model name in prose is not a
  resolution key — always look up through the alias. A misspelled/unknown alias resolves to nothing and
  the router 400s — it never falls through to plain Claude.
- The alias may contain hyphens or dots and need not match the resolved model name — always use the
  dictionary key's own punctuation; a mismatch resolves to nothing per the rule above.
- Never name an alias starting with `opus`/`sonnet`/`haiku`/`fable` — the resulting id `claude-<alias>`
  would collide with (hijack) a real Claude model name (e.g. alias `opus-4-8` → id `claude-opus-4-8`);
  `router.mjs`'s `loadModels` already skips any such alias at load time as a fail-safe, but don't rely
  on that — just don't name one that way.
- A requested model name with **no matching alias in `models.json`** → ask the user how to proceed
  (never silently fall back to a standard Claude tier). CLAUDE.md §1.9 mirrors this rule in its
  conductor summary.
- `models.json`'s **first entry is the default external alias** (the same one `/model` surfaces via
  `ANTHROPIC_CUSTOM_MODEL_OPTION`, see "Direct model-field routing" above). quality-loop's Authority
  Co-Review uses this default external alias for its co-reviewer.

gemini is out of scope for now (deferred until a subscription route exists).

## Multiple models = council (fan-out)

A **default** council (N independent viewpoints on the standard Claude tier, context difference only) runs independently of the relay gate and operates regardless of external-model routing. The **external** council (multiple external models) is **opt-in**, used only when the user explicitly names the model(s) — for the empirical rationale, see Fusion Composition section of `.claude/skills/quality-loop/SKILL.md`. **Exception**: quality-loop's Authority Co-Review seats one external model (the default external alias, see Aliases above) by default alongside the frontier authority for plan/design/architecture reviews and normal code review (`reviewer target:code`), when the Authority Co-Review trigger condition is met (SOT: quality-loop) — see the Authority Co-Review section of `.claude/skills/quality-loop/SKILL.md` for the full trigger condition and flow.

When several models are named, **the relay itself never splits** (it is a plain "one order = one
model" routing layer). The **conductor** fans out — spawning one single-marker worker per model in
parallel (= Fusion Round 0 in the quality-loop skill). Do not mix multiple markers into one spawn.

Cross-checking / reconciling is capped at one revisit round by FUSION (no endless meetings). For the
full council flow (Round 0 → fuse → split decision → revisit ≤ 1 → compose) see the Fusion
Composition section of `.claude/skills/quality-loop/SKILL.md`.

## Start / stop

There are two independent ways the relay server (router 8788 / shim 8791) comes up, with different
lifetimes:

**(a) `bash clover/bin/clover`** — launches `claude` itself through the relay. Brings up
router + shim as part of starting the session, and closing that session (window close / Ctrl-C) tears
router/shim down too, via the launcher's trap — nothing lingers, but only for this path. **Only a
session launched this way** has its own API traffic (and its workers') actually passing through the
relay endpoint (verified live: `ANTHROPIC_BASE_URL` is set to the router).

**(b) `bash clover/bin/relay-serve start`** (what `/relay on` runs) — starts router/shim as a
standalone background process (nohup), independent of any particular session. It **persists across
sessions** and does **not** stop when a session closes; it only stops via `/relay off` (or
`relay-serve stop`). A plain `claude` session (not launched via `bin/clover`) can have relay-status=ON
and the server UP under this path, while its own traffic still goes straight to api.anthropic.com — the
server being up does not mean *this* session is routed through it. Before using a relay marker, confirm
the session itself is on the relay path (`echo "$ANTHROPIC_BASE_URL"` should read
`http://127.0.0.1:8788`), not just that the server is running.

**(c) shell function wrapper** (`clover-claude.ps1.snippet` / `clover-claude.bash.snippet`, the `claude`
command wrapper described in `clover/README.md`) — a registry-backed idle reaper. Each launched
session registers itself under `clover/run/sessions/`; on that session's shell exit, the wrapper
deregisters and asks the relay to shut down. The relay actually stops once the registry is empty (no
other tab still open), either immediately (via the `/__clover/shutdown` request) or, as a fallback, within
`RELAY_IDLE_MS` (default 10 minutes) via the self-timer sweep. This is distinguished from the (b)
`relay-serve` standalone by whether `RELAY_IDLE_MS` is set: the launcher path sets it, `relay-serve` does
not (defaults to 0 = disabled), so a relay started via `relay-serve` never self-terminates from idleness.

## Heavy generation (review/design-scale) operational notes

- For OpenAI format (format: openai) models, only text and tool calls are passed to the external model via relay. Image and document blocks are replaced with `[image omitted by relay]` / `[document omitted by relay]` (with the actual content removed).
- For heavy external generation (review/design-scale), default to mini-tier models / low effort first —
  a heavy model at high effort can fail to complete even in ~300s. Post-keepalive-fix measurement
  (2026-07-02, a 410s run completed) shows Authority Co-Review's co-review pass can use the full-size
  default external alias; the mini-tier-first recommendation targets long-running direct Bash generation.
- The Bash tool itself cuts off at 120s by default, so a long relay call must always go through
  `run_in_background` + polling an output file, never a foreground wait.
- Treat 504 (unresponsive/timeout) as a separate, non-blocking bucket from 429 (rate exhausted) — keep a
  fallback to standard Claude ready for it.

## Prohibitions

- Never write internal URLs (router/shim addresses) or real OAuth tokens into scripts, logs, or commit
  messages.
