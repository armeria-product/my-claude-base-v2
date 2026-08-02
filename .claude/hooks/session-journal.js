#!/usr/bin/env node
// SessionStart + SessionEnd hook: journal session boundary markers + unreported-session scan
//
// SessionStart:
//   - appends "- HH:MM:SS [id8] SESSION START (source)"
//   - injects this session's journal id8 (so /save-session can write its SAVE marker)
//   - scans today's + yesterday's journal for sessions that never resolved:
//       * START with no SESSION END and no SAVE  -> crash suspicion (or a still-running
//         parallel session — the wording stays soft for that reason)
//       * START with SESSION END but no SAVE     -> ended cleanly but report never written
// SessionEnd:
//   - appends "- HH:MM:SS [id8] SESSION END (reason)" (well inside the SessionEnd budget)
//
// Marker contract (grep'd by the scan; /save-session writes the SAVE line):
//   SESSION START / SESSION END / SAVE — each as "- HH:MM:SS [id8] <MARKER> ..."
//
// Fully fail-open. Input: Claude Code hook event JSON on stdin.

const fs = require('node:fs');
const { stamp, id8, projectRoot, appendLine, journalPath } = require('./lib/journal-util');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`session-journal: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function main() {
  const payload = JSON.parse(data || '{}');
  const root = projectRoot(payload);
  const sid = id8(payload);
  const event = payload.hook_event_name;

  if (event === 'SessionEnd') {
    appendLine(root, `- ${stamp()} [${sid}] SESSION END (${payload.reason || 'other'})`);
    return;
  }

  // SessionStart (also the registered default)
  appendLine(root, `- ${stamp()} [${sid}] SESSION START (${payload.source || 'startup'})`);

  const parts = [
    `このセッションの journal ID: [${sid}]。/save-session はジャーナルの SAVE マーカー行にこの ID を使うこと。`,
  ];
  const scan = scanUnresolved(root, sid);
  if (scan.crashed.length)
    parts.push(
      `⚠ 前回までに SESSION END も SAVE も無いセッションがあります: [${scan.crashed.join('], [')}]（クラッシュの可能性。並走中のセッションの場合もあります）。journal の該当行を読み、必要なら「/save-session 補完」でレポートを作成できます。`
    );
  if (scan.unsaved.length)
    parts.push(
      `⚠ 正常終了したもののレポート未生成（SAVE 無し）のセッションがあります: [${scan.unsaved.join('], [')}]。「/save-session 補完」で journal から後追い作成できます。`
    );

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\n'),
      },
    })
  );
}

function scanUnresolved(root, currentSid) {
  const started = new Map(); // id8 -> true (insertion order preserved)
  const ended = new Set();
  const saved = new Set();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  for (const d of [yesterday, today]) {
    const p = journalPath(root, d);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^- \d\d:\d\d:\d\d \[([\w-]{1,8})\] (SESSION START|SESSION END|SAVE)\b/);
      if (!m) continue;
      if (m[2] === 'SESSION START') started.set(m[1], true);
      else if (m[2] === 'SESSION END') ended.add(m[1]);
      else saved.add(m[1]);
    }
  }
  const crashed = [];
  const unsaved = [];
  for (const sid of started.keys()) {
    if (sid === currentSid) continue;
    if (saved.has(sid)) continue;
    if (ended.has(sid)) unsaved.push(sid);
    else crashed.push(sid);
  }
  return { crashed, unsaved };
}
