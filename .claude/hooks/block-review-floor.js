#!/usr/bin/env node
// PreToolUse hook (Task/Agent): enforces the CLAUDE.md §2 authority-model allowlist for
// reviewer/planner dispatches. Authority is a capability role, not an ordinal model floor:
// only native `fable` or `opus` may hold it. Lower tiers, inherit, unknown model names, external
// clover ids, and unresolved models are denied.
//
// Model resolution order: tool_input.model is authoritative when present. Otherwise the hook
// falls back to .claude/agents/<subagent_type>.md frontmatter `model:`. This preserves the Agent
// contract that an explicit dispatch model overrides the agent default, including an explicitly
// reported retry with `model: opus` after a Fable availability or usage-limit failure.
//
// norm(): trims whitespace, lowercases, and strips one `claude-` compatibility prefix. The prefix
// keeps the existing `claude-opus` compatibility sample valid. Clover aliases beginning with
// `fable` remain forbidden by the router, so native Fable does not collide with an external id.
//
// This is independent of relay ON/OFF. Native Fable is relay-independent. An external
// RELAY-MODEL seat has no explicit model override and therefore resolves through the role's native
// frontmatter here; relay-required-agent.js independently enforces whether that external seat may
// launch.
//
// subagent_type is normalized before matching and frontmatter lookup so case/whitespace variants
// cannot bypass the authority policy on case-insensitive filesystems.
//
// Broken input JSON remains fail-open because no role can be resolved. Once reviewer/planner is
// resolved, an unreadable/missing model is an unresolved authority dispatch and fails closed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const REVIEW_AUTHORITY = new Set(['reviewer', 'planner']);
const ALLOWED_AUTHORITY_MODELS = new Set(['fable', 'opus']);
const DENIED_AUTHORITY_MODELS = new Set(['sonnet', 'haiku', 'inherit']);

const norm = (model) => String(model ?? '').trim().toLowerCase().replace(/^claude-/, '');

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
    process.exit(0);
  }

  const normSubagentType = String(subagentType).trim().toLowerCase();
  if (!REVIEW_AUTHORITY.has(normSubagentType)) process.exit(0);

  let effectiveModel = model;
  if (!effectiveModel) {
    try {
      const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${normSubagentType}.md`), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) effectiveModel = ((fm[1].match(/^model:\s*(.+)$/m) || [])[1] || '').trim();
    } catch {
      /* missing/unreadable agent file -> unresolved authority model -> deny below */
    }
  }

  const normalizedModel = norm(effectiveModel);
  if (ALLOWED_AUTHORITY_MODELS.has(normalizedModel)) process.exit(0);

  const classification = DENIED_AUTHORITY_MODELS.has(normalizedModel)
    ? 'lower-tier authority model'
    : 'unknown, external, or unresolved authority model';
  console.error(
    `BLOCKED: サブエージェント "${subagentType}" はレビュー権威ロールですが、` +
      `モデルが許可集合 fable | opus にありません` +
      ` (resolved: ${effectiveModel || '(unresolved)'}; ${classification})。\n` +
      `CLAUDE.md §2: 権威モデルは native fable または opus だけです。通常は frontmatter の fable を使い、\n` +
      `Fable の利用上限・提供停止・起動失敗を記録した場合だけ dispatch に model: opus を明示してください。\n` +
      `sonnet / haiku / inherit / unknown / external clover id への降格や無言の fallback は禁止です。`
  );
  process.exit(2);
});
