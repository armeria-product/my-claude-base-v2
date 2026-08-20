#!/usr/bin/env node
// PostToolUse hook: append one machine line per tool call to tasks/journal/YYYY-MM/DD.md
//
// Registered matcher: Edit|Write|NotebookEdit|Bash|PowerShell|Task|Agent|ExitPlanMode
// The journal is written by this hook (an OS process outside the model), so the record
// survives CLI crashes up to the last tool call and costs zero tokens. Append-only.
//
// Notes:
//   - Denied tool calls never reach PostToolUse — scope-guard/cmd-write-guard write their
//     own DENY lines directly (see those hooks). This hook only sees calls that ran.
//   - Subagent calls fire project hooks too; agent_type is appended as "(via executor)".
//   - Fully fail-open: journaling must never break the actual work.
//
// Input: Claude Code hook event JSON on stdin

const { stamp, id8, projectRoot, appendLine, relToRoot, clip } = require('./lib/journal-util');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`journal: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function main() {
  const payload = JSON.parse(data || '{}');
  const root = projectRoot(payload);
  const line = formatLine(payload, root);
  if (line) appendLine(root, line);

  // Plan-handoff convergence (CLAUDE.md §7): after a native plan-mode approval, steer the
  // model onto the same scope.json -> 「承認」 flow the plan skill ends with. Mechanical, not
  // prose-only — losing this injection would silently reopen the "plan approved but nothing
  // is locked" gap that v2 exists to close.
  if (payload.tool_name === 'ExitPlanMode') {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            '[plan-handoff] プランモードの計画が承認されました。この計画を「承認後は自走・範囲は機械的に固定」で実行する場合: ' +
            'plans/{slug}/scope.json（{"slug","status":"proposed","proposedAt","plan","allow":[...glob],"forbid":[...],"tasks":[...]}）を書き出し、' +
            '範囲を平易な日本語で示した上で「scope.json を書き出しました。『承認』とだけ返信するとロックして自走を開始します（解除は『解除』）」とユーザーに伝えること。' +
            '1-2ファイルの小さな作業でロックが過剰なら、この案内は無視して直接実装してよい。',
        },
      })
    );
  }
}

function formatLine(payload, root) {
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const via = payload.agent_type ? ` (via ${payload.agent_type})` : '';
  const head = `- ${stamp()} [${id8(payload)}]`;
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const p = relToRoot(root, input.file_path || input.notebook_path);
      return `${head} ${tool.toLowerCase()} ${p}${via}`;
    }
    case 'Bash':
    case 'PowerShell':
      return `${head} ${tool.toLowerCase()} "${clip(input.command, 120)}"${via}`;
    case 'Task':
    case 'Agent':
      return `${head} task ${input.subagent_type || 'agent'} "${clip(input.description || input.prompt, 80)}"${via}`;
    case 'ExitPlanMode':
      return `${head} plan-exit（計画を提示）${via}`;
    default:
      return null;
  }
}
