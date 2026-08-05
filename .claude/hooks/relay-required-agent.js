#!/usr/bin/env node
// PreToolUse hook (Task/Agent): blocks a subagent spawn that requires an external relay model
// when the relay is OFF (CLAUDE.md §1.8 ON/OFF gate). Two independent routes are checked (OR):
//   1. Legacy: the agent definition's frontmatter pins model: to a clover relay model id
//      (claude-<alias> from clover/models.json). Native aliases, including `fable`, do not match
//      this route and remain relay-independent.
//   2. Primary (relay skill convention): a `RELAY-MODEL:<alias>` marker on the prompt's true
//      first line, matching the router's own acceptance surface (clover/src/router.mjs):
//      noise blocks (e.g. <system-reminder>...</system-reminder>) are stripped first, then the
//      first line is trimmed before matching — so leading whitespace or a noise block don't let
//      a marker slip past undetected. A system/systemPrompt field on tool_input, if present, is
//      also searched anywhere (matches the router's system-field priority pass). A marker buried
//      elsewhere in the prompt body (not the true first line) is still ignored on purpose
//      (matches the relay skill's own safe-side fallback).
//
// Either route firing while relay is OFF -> block the spawn and tell the user to turn the
// relay on — instead of letting it fail later with an opaque "model may not exist" / 400.
//
// Fail-open: any error (unknown agent, unreadable files, bad JSON) -> exit 0 (allow).
// Known limitation: $(...) / `...` / heredoc-constructed prompts aren't parsed — same structural
// limit as the shared tokenizer used elsewhere in this hook suite.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function relayIsOn() {
  try {
    return fs.readFileSync(path.join(ROOT, '.claude', '.relay-status'), 'utf8').trim().toUpperCase() === 'ON';
  } catch {
    return false; // missing = OFF
  }
}

function cloverAliasSet() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'clover', 'models.json'), 'utf8'));
    return new Set((cfg.models || []).map((m) => m.alias && m.alias.toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Mirrors router.mjs's stripRelayNoiseText: drop noise blocks (system-reminders, injected
// identity blurb) before locating the "true" first line of the prompt.
function stripRelayNoiseText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/You are powered by the model named .+?\. The exact model ID is .+?\./g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MARKER_ANYWHERE_RE = /(?:^|\s)RELAY-MODEL:\s*(\S+)/m;
const MARKER_FIRSTLINE_RE = /^RELAY-MODEL:\s*([\w.-]+)/i;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let subagentType = '';
  let prompt = '';
  let systemText = '';
  try {
    const toolInput = JSON.parse(data).tool_input || {};
    subagentType = toolInput.subagent_type || '';
    prompt = toolInput.prompt || '';
    const sys = toolInput.system ?? toolInput.systemPrompt;
    if (typeof sys === 'string') systemText = sys;
  } catch {
    process.exit(0);
  }

  // --- Route 1: frontmatter-pinned clover model id (claude-<alias>) -----------------------
  let frontmatterModel = '';
  if (subagentType) {
    try {
      const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${subagentType}.md`), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) frontmatterModel = ((fm[1].match(/^model:\s*(.+)$/m) || [])[1] || '').trim().toLowerCase();
    } catch {
      /* no agent file -> route 1 doesn't apply */
    }
  }
  let frontmatterHit = false;
  if (frontmatterModel) {
    const cloverIds = new Set([...cloverAliasSet()].map((a) => `claude-${a}`));
    frontmatterHit = cloverIds.has(frontmatterModel);
  }

  // --- Route 2: RELAY-MODEL:<alias> marker, matching the router's acceptance surface ------
  // Priority 1 (matches router.mjs): a system/systemPrompt field, searched anywhere.
  let markerMatch = systemText ? systemText.match(MARKER_ANYWHERE_RE) : null;
  // Priority 2: the prompt's true first line, after stripping noise blocks (system-reminders
  // etc.) and trimming leading whitespace — so `   RELAY-MODEL:...` or a leading
  // <system-reminder> block wrapping the marker still resolve to the true first line.
  if (!markerMatch) {
    const cleaned = stripRelayNoiseText(prompt);
    const firstLine = (cleaned.split(/\r?\n/, 1)[0] || '').trim();
    markerMatch = firstLine.match(MARKER_FIRSTLINE_RE);
  }
  let markerHit = false;
  let markerAlias = '';
  if (markerMatch) {
    markerAlias = markerMatch[1].toLowerCase();
    markerHit = cloverAliasSet().has(markerAlias);
  }

  if (!frontmatterHit && !markerHit) process.exit(0); // no relay-model route triggered -> allow
  if (relayIsOn()) process.exit(0);

  const model = frontmatterHit ? frontmatterModel : markerAlias;
  console.error(
    `BLOCKED: サブエージェント "${subagentType || '(unnamed)'}" は外部モデル (${model}) を使う設定です。\n` +
      `いまは relay が OFF のため使えません（relay 経由で起動していないと "model may not exist" で失敗します）。\n` +
      `使う場合は relay を ON にしてください: /relay on\n` +
      `一時的に native モデルで動かすなら、役割の規約に合う model 指定へ変えてください（権威ロールは fable | opus のみ）。`
  );
  process.exit(2);
});
