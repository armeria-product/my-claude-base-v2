#!/usr/bin/env node
// PreToolUse hook (Write): archive session-state.md before it gets overwritten
//
// Design:
//   - Scope: Write tool overwriting tasks/session-state.md or dev/*/tasks/session-state.md
//     (path separators normalized to "/" first -> Windows-safe)
//   - Before the write lands, copy the existing file into the sibling history/ dir as
//     history/session-state-YYYYMMDD-HHMM.md (creating history/ if needed)
//   - If no existing file is present, there is nothing to archive -> no-op
//   - v2: NO rotation. History is kept in full — past states are never deleted
//     (user ruling 2026-08-02: 過去履歴は全量保持). Disk is cheap; lost context is not.
//   - Fully fail-open: always exits 0. Archive failures never block the real Write
//
// Input: Claude Code hook event JSON on stdin (same shape as the block-*.js hooks)

const fs = require('node:fs');
const path = require('node:path');

const SESSION_STATE_RE = /(^|\/)(dev\/[^/]+\/)?tasks\/session-state\.md$/;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`archive-session-state: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function main() {
  const payload = JSON.parse(data || '{}');
  if (payload.tool_name !== 'Write') return;

  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;

  const rel = filePath.split(path.sep).join('/');
  if (!SESSION_STATE_RE.test(rel)) return;

  if (!fs.existsSync(filePath)) return; // nothing to archive yet

  const dir = path.dirname(filePath);
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  const stamp = formatStamp(new Date());
  const dest = path.join(historyDir, `session-state-${stamp}.md`);
  fs.copyFileSync(filePath, dest);
}

function formatStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}
