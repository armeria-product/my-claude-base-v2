#!/usr/bin/env node
// PreToolUse hook (Task/Agent): enforces the CLAUDE.md §2 authority-model allowlist for
// reviewer/planner dispatches. Authority is a capability role, not an ordinal model floor:
// only native `fable` or `opus` may hold it. Lower tiers, inherit, unknown model names, external
// clover ids, and unresolved models are denied.
//
// Model resolution order: tool_input.model is authoritative when present. Otherwise the hook
// falls back to .claude/agents/<subagent_type>.md frontmatter `model:`. This preserves the Agent
// contract that an explicit dispatch model overrides the agent default. The frontmatter default is
// Opus (CLAUDE.md §2); Fable is permitted only while the CLAUDE.md §1.11 gate is ON, enforced
// separately by block-fable-when-off.js for every dispatch, not only authority roles.
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
//
// Batch A / A2 addition (2026-08-12): a SECOND, independent axis — the caller. Denies when
// payload.agent_type (the calling subagent's own role, set by journal.js/the harness on a nested
// Task|Agent dispatch — absent for a conductor-issued, i.e. top-level, dispatch) is one of
// executor/debugger/document-author/general-purpose AND tool_input.subagent_type resolves to
// reviewer or planner (CLAUDE.md §1.3: writer ≠ reviewer; those roles have unrestricted Task and
// executor.md never restates the prohibition). Explicitly OUT of scope, left to a future user
// ruling: planner→planner (planner's documented Self-Review Mode) and reviewer→* are NOT denied —
// both stay out of the denied-caller set on purpose below, so this needs no extra special-casing.
// This axis only looks at payload.agent_type and tool_input.subagent_type — it does not re-check
// the model axis above, and firing this check short-circuits before the model resolution/fs read
// below. Same fail-open convention: unparsable JSON exits 0 before either axis is evaluated.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const REVIEW_AUTHORITY = new Set(['reviewer', 'planner']);
const ALLOWED_AUTHORITY_MODELS = new Set(['fable', 'opus']);
const DENIED_AUTHORITY_MODELS = new Set(['sonnet', 'haiku', 'inherit']);
// A2 (2026-08-12): callers denied from seating an authority role — see the header paragraph for
// the explicit planner→planner / reviewer→* carveout (both stay OUT of this set on purpose).
const WORKER_CALLERS = new Set(['executor', 'debugger', 'document-author', 'general-purpose']);

const norm = (model) => String(model ?? '').trim().toLowerCase().replace(/^claude-/, '');

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  let subagentType = '';
  let model = '';
  let agentType = '';
  try {
    const payload = JSON.parse(data);
    const toolInput = payload.tool_input || {};
    subagentType = toolInput.subagent_type || '';
    model = toolInput.model || '';
    agentType = payload.agent_type || '';
  } catch {
    process.exit(0);
  }

  const normSubagentType = String(subagentType).trim().toLowerCase();
  if (!REVIEW_AUTHORITY.has(normSubagentType)) process.exit(0);

  const normAgentType = String(agentType).trim().toLowerCase();
  if (WORKER_CALLERS.has(normAgentType)) {
    console.error(
      `BLOCKED: "${agentType}" からのサブエージェント起動で、レビュー権威ロール "${subagentType}" を直接起動しようとしています。\n` +
        `CLAUDE.md §1.3: レビューは書いた本人以外が行います。executor / debugger / document-author / general-purpose から\n` +
        `reviewer・planner を直接起動することはできません。レビューが必要なら、コンダクター（親セッション）に\n` +
        `差し戻して、コンダクターから reviewer/planner を起動してください。\n` +
        `（判定できるのは dispatch に記録された agent_type だけです。planner が自分自身をレビューする場合と、\n` +
        `reviewer が別のサブエージェントを呼ぶ場合はこの対象外です。）`
    );
    process.exit(2);
  }

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
      `CLAUDE.md §2: 権威モデルは native fable または opus だけです。通常は frontmatter の opus を使い、\n` +
      `Fable は CLAUDE.md §1.11 のスイッチ（.claude/.fable-status）が ON のときだけ dispatch に model: fable を明示して使ってください。\n` +
      `sonnet / haiku / inherit / unknown / external clover id への降格や無言の fallback は禁止です。`
  );
  process.exit(2);
});
