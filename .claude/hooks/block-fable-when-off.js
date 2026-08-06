#!/usr/bin/env node
// PreToolUse hook (Task/Agent): CLAUDE.md §1.11 Fable ON/OFF gate. Fable usage spiked cost in a
// single day, so the frontmatter default is now Opus (CLAUDE.md §2) and Fable is permitted only
// while a machine-local switch file reads ON. Unlike block-review-floor.js (which only judges the
// authority roles reviewer/planner), this hook applies to every subagent dispatch — Ruling B.
//
// Check order matters and is part of the contract: the model is resolved BEFORE the switch file
// is read, so a dispatch that does not resolve to fable never touches the switch at all.
//
// Model resolution mirrors block-review-floor.js exactly (verbatim norm(), verbatim frontmatter
// regexes, verbatim subagent_type normalization) so the two hooks can never silently diverge on
// what "the effective model" means for the same dispatch — a divergence here would be a silent
// bypass, not a style difference.
//
// The COMPARISON against that resolved value is deliberately NOT mirrored, because the two hooks
// match in opposite directions on the same normalized value. block-review-floor.js is an allowlist
// (ALLOWED_AUTHORITY_MODELS): an unmatched model falls through to ITS OWN deny, fail-closed, so
// under-inclusive matching there only widens what gets rejected — never a bypass. This hook is a
// denylist (GATED_MODEL): an unmatched model falls through to allow, fail-open, so the same
// under-inclusive bare-word match ('fable' only) would let real-id spellings such as the
// forbidden-shaped `claude-fable-5` (cited here only as an example of the shape, not a pin — see
// validate.mjs's own real-id dead-ref check) or bare fable-5 / fable-5-20260101 bypass the gate
// entirely. That is why the comparison below widens to any real-id spelling of fable (the bare
// word, or fable followed by '-' or a digit) while norm() itself stays byte-identical to
// block-review-floor.js:36.
//
// Fail-open (dispatch is allowed even though its model is unknown/non-fable):
//   - Unparseable input JSON: no model can be resolved at all. Matches both existing hooks in
//     this PreToolUse group (block-review-floor.js, relay-required-agent.js) — a hook that failed
//     closed here would block every dispatch the moment the payload shape changed upstream, a
//     self-inflicted outage for a gate whose downside is money, not safety.
//   - subagent_type is not a plain agent-name token (see the guard below the frontmatter read):
//     the lookup is skipped rather than fed a path-shaped value, leaving the model unresolved —
//     which falls into the same fail-open branch as any other unresolved model, never a deny.
//   - Model resolves to anything other than fable in any spelling, INCLUDING an unresolved model
//     (no explicit model and no agent file / no model: key). This is mandatory, not merely safe: 6
//     of the 7 built-in agent types (general-purpose, Explore, Plan, claude, statusline-setup,
//     claude-code-guide) have no file under .claude/agents/, so failing closed on "unresolved"
//     would deny every one of them whenever the switch is OFF — i.e. in the normal state. The
//     authority-role hole this leaves is already closed independently by block-review-floor.js's
//     own fail-closed branch on an unresolved authority model.
//
// Fail-closed (dispatch is denied):
//   - The resolved model IS fable, in any spelling, and the switch file is missing/unreadable/not
//     exactly the word "ON" (case-insensitive, trimmed — anything else, including a quoted "ON", a
//     different word like ONLINE, or extra trailing content, counts as OFF). Here the model is
//     known, so the safe default is deny — the cost of being wrong is one retry after the user
//     writes the switch file. Mirrors relay-required-agent.js's own missing-file -> OFF fallback.
//
// Two-hole disclosure (see the deny message below and CLAUDE.md §1.11): this hook can only see
// subagent dispatches whose model name is observable to it. It cannot gate (a) the user's own
// session model (/model is outside any hook's reach), and (b) a dispatch that inherits the
// session's model instead of naming one explicitly may be invisible to this hook (unverified
// assumption A-1, plans/2026-08-06-fable-gate/PLAN.md). No third hole: the gate above covers every
// dispatch whose model name is observable, in any Fable spelling — never state or imply it covers
// every route to Fable.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const GATED_MODEL = 'fable';

// Verbatim from block-review-floor.js:36 — a divergence here is a silent bypass, not a style
// difference. The H-1 widening lives in the comparison below, not here.
const norm = (model) => String(model ?? '').trim().toLowerCase().replace(/^claude-/, '');

// Built from GATED_MODEL (not a separate literal) so the two can never drift apart silently.
// Matches the bare word and any real-id spelling (fable, fable-5, fable5, fable-5-20260101) but
// not an unrelated word that merely starts with the same letters (e.g. "fabled").
const GATED_MODEL_RE = new RegExp(`^${GATED_MODEL}(?:$|[-\\d])`);

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  let subagentType = '';
  let model = '';
  try {
    const toolInput = JSON.parse(data).tool_input || {};
    subagentType = toolInput.subagent_type || '';
    model = toolInput.model || '';
  } catch {
    process.exit(0); // fail-open: no model can be resolved from unparseable input
  }

  // Verbatim from block-review-floor.js:51.
  const normSubagentType = String(subagentType).trim().toLowerCase();

  // Cheap shape guard (L-3): block-review-floor.js only ever reaches its frontmatter read for the
  // two literal strings "reviewer"/"planner" (its REVIEW_AUTHORITY.has() check filters by role
  // first). This hook has no such role filter — it applies to every subagent_type — so without
  // this guard a path-shaped value (e.g. "../../.claude/agents/reviewer") would reach path.join
  // and get read. Read-only, so not a bypass by itself, but there is no reason to feed a
  // filesystem path anything but a plain agent-name token. Fails in ONE direction only: a rejected
  // token just skips the read, leaving effectiveModel unresolved, which falls into the SAME
  // fail-open branch as any other unresolved model below — a rejected subagent_type can never turn
  // into a deny by itself.
  const isPlainAgentName = /^[a-z0-9_-]+$/.test(normSubagentType);

  let effectiveModel = model;
  if (!effectiveModel && isPlainAgentName) {
    try {
      // Verbatim regexes from block-review-floor.js:57-59.
      const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${normSubagentType}.md`), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) effectiveModel = ((fm[1].match(/^model:\s*(.+)$/m) || [])[1] || '').trim();
    } catch {
      /* missing/unreadable agent file -> unresolved model -> fail-open below (see header) */
    }
  }

  const normalizedModel = norm(effectiveModel);
  if (!GATED_MODEL_RE.test(normalizedModel)) process.exit(0); // not fable in any spelling (or unresolved) -> allow

  let switchIsOn = false;
  try {
    switchIsOn = fs.readFileSync(path.join(ROOT, '.claude', '.fable-status'), 'utf8').trim().toUpperCase() === 'ON';
  } catch {
    switchIsOn = false; // missing/unreadable -> OFF
  }
  if (switchIsOn) process.exit(0);

  console.error(
    `BLOCKED: サブエージェント "${subagentType || '(unnamed)'}" を Fable で起動しようとしましたが、いま Fable は使わない設定です。\n` +
      `（このサブエージェントが実際に起動しようとしていたモデル名: ${effectiveModel || '(不明)'}）\n` +
      `Fable を使うには、ユーザーに .claude/.fable-status へ ON と書き込むよう依頼してください（このファイルは Claude が書き込めません。ユーザー本人が編集するものです。OFF と書く／ファイルを削除すると元に戻ります）。\n` +
      `CLAUDE.md §1.11: 使用量を抑えるため、既定は Opus です。Fable はこのスイッチが ON のときだけ使えます。\n` +
      `注意: この仕組みで止められるのは「モデル名が分かるサブエージェントの起動」だけです。あなた自身のセッションが\n` +
      `Fable で動いている場合（/model で選んだモデル）は止められません。モデル名を指定せずに起動して\n` +
      `セッションのモデルがそのまま引き継がれた場合も、この仕組みからは見えないことがあります。`
  );
  process.exit(2);
});
