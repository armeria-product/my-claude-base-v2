#!/usr/bin/env node
// SessionStart hook: inject session-state / roadmap / todo / today's journal tail / lessons
// plus the scope-lock status line into Claude's context.
// Input: Claude Code hook event JSON on stdin (cwd field)
// Output: JSON {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
//
// dev-mode routing (tasks files only — journal and scope-lock are workspace-global):
//   cwd is under dev/{name}/ → read dev/{name}/tasks/
//   otherwise               → read the root tasks/
//
// Token budget:
//   Keep the five blocks combined within TOTAL_CAP (24KB ≈ 6000 tokens). On overflow,
//   trim in order of lowest priority first (lessons → journal → todo → roadmap → session-state).
//   Each file is guaranteed MIN_FLOOR (2KB). session-state/todo/roadmap are written head-first,
//   so trimming drops the tail. lessons (ascending append) and the journal (chronological)
//   have their most recent — most actionable — entries at the tail: those keep the tail instead.

const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, journalPath } = require('./lib/journal-util');

const TOTAL_CAP = 24 * 1024; // combined upper limit
const MIN_FLOOR = 2 * 1024; // minimum guaranteed per file
const JOURNAL_SLICE = 2 * 1024; // today's journal: tail slice read upfront

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(data);
  } catch {
    /* fall through with defaults */
  }

  const cwd = payload.cwd || process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;

  const devMatch = cwd.match(/[\\/]dev[\\/]([^\\/]+)/);
  const tasksDir = devMatch
    ? path.join(projectDir, 'dev', devMatch[1], 'tasks')
    : path.join(projectDir, 'tasks');

  // highest priority first (trimming runs in reverse = drop lessons first, then journal, ...)
  const journalRoot = projectRoot(payload);
  const files = [
    { label: 'SESSION STATE', file: path.join(tasksDir, 'session-state.md'), empty: '(no previous session state — first session or none saved)' },
    { label: 'ROADMAP', file: path.join(tasksDir, 'roadmap.md'), empty: '(no roadmap recorded yet)' },
    { label: 'TODO', file: path.join(tasksDir, 'todo.md'), empty: '(no todo recorded yet)' },
    { label: 'JOURNAL', file: journalPath(journalRoot, new Date()), relBase: journalRoot, empty: '(no journal entries today yet)' },
    { label: 'LESSONS', file: path.join(tasksDir, 'lessons.md'), empty: '(no lessons recorded yet)' },
  ];

  for (const f of files) {
    try {
      f.text = fs.readFileSync(f.file, 'utf8');
      if (f.label === 'JOURNAL') f.text = journalView(f.text);
      f.size = Buffer.byteLength(f.text, 'utf8');
      f.rel = path.relative(f.relBase || projectDir, f.file).split(path.sep).join('/');
    } catch {
      f.text = null;
      f.size = 0;
    }
  }

  allocateBudget(files, TOTAL_CAP, MIN_FLOOR);

  const blocks = [
    devMatch ? `=== CONTEXT: dev/${devMatch[1]} ===` : '=== CONTEXT: workspace root ===',
    lockStatus(projectDir),
  ];
  for (const f of files) {
    blocks.push(`\n=== ${f.label} ===\n` + (f.text == null ? f.empty : f.text));
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: blocks.join('\n'),
      },
    })
  );
  process.exit(0);
});

// The journal is the single home of 次にやること/保留 (the session report) — session-state.md
// only points at it. So the injected view must RELIABLY contain the LAST report section, not
// just a blind tail slice (machine lines appended after a report could otherwise push it out).
// View = last "## HH:MM …" report heading through EOF; middle is elided if oversized (keep the
// report head + the most recent machine lines). Fallback when no report exists yet: tail slice.
function journalView(text) {
  let last = -1;
  const re = /^## \d\d:\d\d .*$/gm;
  let m;
  while ((m = re.exec(text))) last = m.index;
  if (last < 0) {
    if (Buffer.byteLength(text, 'utf8') <= JOURNAL_SLICE) return text;
    const buf = Buffer.from(text, 'utf8');
    return '[tail]\n' + buf.subarray(buf.length - JOURNAL_SLICE).toString('utf8').replace(/^�+/, '');
  }
  let view = text.slice(last);
  const cap = JOURNAL_SLICE * 2;
  if (Buffer.byteLength(view, 'utf8') > cap) {
    const buf = Buffer.from(view, 'utf8');
    const head = buf.subarray(0, Math.floor(cap * 0.6)).toString('utf8').replace(/�+$/, '');
    const tail = buf.subarray(buf.length - Math.floor(cap * 0.35)).toString('utf8').replace(/^�+/, '');
    view = head + '\n[…中略…]\n' + tail;
  }
  return '[latest session report + after]\n' + view;
}

function lockStatus(projectDir) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'state', 'scope-lock.json'), 'utf8'));
    if (lock.status === 'locked')
      return `🔒 scope-lock: LOCKED — slug=${lock.slug} plan=${lock.plan}（範囲外への書き込みはフックが拒否。解除はユーザーの「解除」のみ）`;
    return `🔓 scope-lock: ${lock.status || 'none'}（ロックなし — 通常モード）`;
  } catch {
    return '🔓 scope-lock: none（ロックなし — 通常モード）';
  }
}

// Fit within the combined budget. Overflow is trimmed from the tail, starting with the
// lowest-priority files (end of the array). No file drops below MIN_FLOOR.
function allocateBudget(files, total, floor) {
  let sum = files.reduce((a, f) => a + f.size, 0);
  if (sum <= total) return;

  for (let i = files.length - 1; i >= 0 && sum > total; i--) {
    const f = files[i];
    if (f.text == null || f.size <= floor) continue;
    const need = sum - total; // bytes still to be trimmed
    const target = Math.max(floor, f.size - need); // shrink this file down to target
    // LESSONS (ascending append) and JOURNAL (chronological) keep their most actionable
    // content at the tail: drop the head instead. Everything else keeps the head.
    f.text = f.label === 'LESSONS' || f.label === 'JOURNAL'
      ? trimHead(f.text, target, f.rel, f.size)
      : trimTail(f.text, target, f.rel, f.size);
    const newSize = Buffer.byteLength(f.text, 'utf8');
    sum -= f.size - newSize;
    f.size = newSize;
  }
}

// Keep roughly keepBytes from the head, drop the tail, and append a note (without breaking UTF-8 boundaries)
function trimTail(text, keepBytes, rel, origBytes) {
  const note = `\n\n[budget-trimmed — tail omitted. Full text: ${rel} (${origBytes} bytes)]`;
  const noteBytes = Buffer.byteLength(note, 'utf8');
  const headBudget = Math.max(0, keepBytes - noteBytes);
  const buf = Buffer.from(text, 'utf8').subarray(0, headBudget);
  return buf.toString('utf8').replace(/�+$/, '') + note;
}

// Keep roughly keepBytes from the tail, drop the head, and prepend a note (without breaking UTF-8 boundaries)
function trimHead(text, keepBytes, rel, origBytes) {
  const note = `[budget-trimmed — head omitted. Full text: ${rel} (${origBytes} bytes)]\n\n`;
  const noteBytes = Buffer.byteLength(note, 'utf8');
  const tailBudget = Math.max(0, keepBytes - noteBytes);
  const buf = Buffer.from(text, 'utf8');
  const tail = buf.subarray(Math.max(0, buf.length - tailBudget));
  return note + tail.toString('utf8').replace(/^�+/, '');
}
