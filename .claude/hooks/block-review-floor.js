#!/usr/bin/env node
// PreToolUse hook (Task/Agent): denies a reviewer/planner dispatch pinned below the CLAUDE.md
// §2 review floor ("Review must never fall below `opus`"). REVIEW_AUTHORITY names the two roles
// that footnote governs; BELOW_FLOOR names the resolved-model values that fail it.
//
// Model resolution order (Task 0 measurement, 2026-08-02): route 1 reads tool_input.model
// directly -- when the Agent tool call sets a model, it appears verbatim under that exact field
// name (same name as the tool's own parameter). When absent, route 2 falls back to
// .claude/agents/<subagent_type>.md's frontmatter `model:` field, mirroring
// relay-required-agent.js's Route 1 (lines 74-89). The Agent tool's own model parameter enum is
// sonnet|opus|haiku|fable, but fable is a dead dispatch target (CLAUDE.md never names it as a
// tier and validate.mjs's FORBIDDEN dead-ref scan forbids reintroducing it) -- so `inherit` is
// reachable ONLY via the frontmatter fallback (route 2), never via route 1.
//
// norm(): trims whitespace, lowercases, and strips a clover-alias `claude-` prefix (so
// `claude-haiku` normalizes to `haiku` and is still caught). This is a capability-floor check,
// not a relay ON/OFF check (that's relay-required-agent.js's independent job per CLAUDE.md
// §1.8/§1.9) -- an external RELAY-MODEL dispatch carries no tool_input.model and no
// review-floor-breaking frontmatter pin, so it is not double-judged here.
//
// Self-application: every legitimate reviewer/planner seat this harness's own quality-loop
// dispatches pins `model: opus` (validate.mjs enforces this for EFFORT_MAX_AGENTS) -- opus is
// not in BELOW_FLOOR, so this hook must never deny its own review gates (Phase 4.5/8).
//
// Fail-open: any error (broken JSON, unreadable agent file) -> exit 0 (allow).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const REVIEW_AUTHORITY = new Set(['reviewer', 'planner']);
const BELOW_FLOOR = new Set(['sonnet', 'haiku', 'inherit']);

const norm = (m) => String(m ?? '').trim().toLowerCase().replace(/^claude-/, '');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let subagentType = '';
  let model = '';
  try {
    const toolInput = JSON.parse(data).tool_input || {};
    subagentType = toolInput.subagent_type || '';
    model = toolInput.model || '';
  } catch {
    process.exit(0);
  }

  if (!REVIEW_AUTHORITY.has(subagentType)) process.exit(0);

  let effectiveModel = model;
  if (!effectiveModel) {
    try {
      const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${subagentType}.md`), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) effectiveModel = ((fm[1].match(/^model:\s*(.+)$/m) || [])[1] || '').trim();
    } catch {
      /* no agent file -> stays unresolved */
    }
  }

  if (!BELOW_FLOOR.has(norm(effectiveModel))) process.exit(0);

  console.error(
    `BLOCKED: サブエージェント "${subagentType}" はレビュー権威ロールですが、モデルが下限 (opus) 未満です` +
      ` (resolved: ${effectiveModel || '(unresolved)'})。\n` +
      `CLAUDE.md §2: レビューは opus を下回ってはいけません。dispatch の model を opus にするか、\n` +
      `.claude/agents/${subagentType}.md の frontmatter model: を opus に直してください。`
  );
  process.exit(2);
});
