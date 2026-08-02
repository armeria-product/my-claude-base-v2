#!/usr/bin/env node
// UserPromptSubmit hook: repo-state（branch / dirty / last commit）を1行注入するだけ。
// 非ブロック・fail-open。
//
// Input: Claude Code hook event JSON on stdin (prompt field)
// Output: JSON with additionalContext ([repo-state] line) + exit 0

const { execSync } = require('node:child_process');

function repoState() {
  try {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 };
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opt).trim();
    const dirty = execSync('git status --porcelain', opt).split('\n').filter(Boolean).length;
    const last = execSync('git log -1 "--format=%h %s"', opt).trim().slice(0, 60);
    return `[repo-state] branch=${branch} dirty=${dirty} last="${last}"`;
  } catch {
    return null; // outside git / git absent → silently skip (fail-open)
  }
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let prompt = '';
  try {
    const payload = JSON.parse(data);
    prompt = payload.prompt || '';
  } catch {
    process.exit(0);
  }

  if (!prompt) process.exit(0);

  const parts = [];
  const state = repoState();
  if (state) parts.push(state);

  if (parts.length) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: parts.join('\n'),
        },
      })
    );
  }
  process.exit(0);
});
