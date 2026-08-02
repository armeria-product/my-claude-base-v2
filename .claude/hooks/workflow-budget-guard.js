#!/usr/bin/env node
// PreToolUse hook (matcher: Workflow): require an explicit token-budget declaration
// before any multi-agent Workflow launch (CLAUDE.md §5.4).
// Input:  Claude Code hook event JSON on stdin
// Output: if tool_input.description lacks a "budget:+500k"-style declaration,
//         write the recovery procedure to stderr + exit 2 (block); otherwise exit 0.
//
// Why: the deep-research incident (lessons 2026-07-02) — a bundled workflow inherited the
// session's model/effort, spawned 104 agents and burned ~890k tokens into the monthly cap.
// The harness's own hard ceiling (budget.total) only arms when the USER's prompt contains
// a "+Nk" directive, so this gate forces the conductor to settle the budget question
// BEFORE launch instead of after the bill.
//
// The Workflow tool ignores its `description` parameter (meta.description is the real one),
// which makes it a safe carrier for the declaration on every invocation form —
// inline `script`, `scriptPath`, and `name`-based bundled workflows alike.
//
// Blocked:  Workflow calls whose description does not match  budget:+<N>k  (case-insensitive,
//           spaces and a full-width colon tolerated, the "+" optional). Resume calls
//           (resumeFromRunId) are gated too: resuming spend needs a re-confirmed budget.
// Allowed:  Workflow calls carrying the declaration, e.g. description: "budget:+500k".
// Fail-open: malformed/absent stdin JSON -> exit 0 (never brick the tool on a hook bug).

const BUDGET_DECL = /budget\s*[:：]\s*\+?\d+\s*k\b/i;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let description = '';
  try {
    description = String(JSON.parse(data).tool_input?.description ?? '');
  } catch {
    process.exit(0);
  }
  if (BUDGET_DECL.test(description)) process.exit(0);

  console.error(
    'BLOCKED: Workflow の起動にはトークン予算の宣言が必要です（CLAUDE.md §5.4 / lessons 2026-07-02 の89万トークン事故の再発防止）。\n' +
      '手順:\n' +
      ' 1. 今回のユーザー指示に「+500k」のような予算指定があるか確認。なければ上限をユーザーに1回確認する。\n' +
      ' 2. Workflow 呼び出しに description: "budget:+<N>k"（<N> は決めた上限の数値に置き換える。この例文のままでは通らない）の形で宣言を添えて再実行する。\n' +
      ' 3. 予算がユーザープロンプトの「+Nk」由来でない場合、ハーネスの上限(budget.total)は効かないため、' +
      'script 側にエージェント総数とループ回数の上限を必ず入れる。\n' +
      ' 4. 検索・取得・検証などの機械的な fan-out には opts.model("haiku"/"sonnet") と opts.effort("low") を指定する。'
  );
  process.exit(2);
});
