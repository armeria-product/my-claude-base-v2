#!/usr/bin/env node
// SessionStart hook: inject session-state / roadmap / todo / today's journal tail / lessons
// into Claude's context.
// Input: Claude Code hook event JSON on stdin (cwd field)
// Output: JSON {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
//
// dev-mode routing (tasks files only — the journal is workspace-global):
//   cwd is under dev/{name}/ → read dev/{name}/tasks/
//   otherwise               → read the root tasks/
//
// Token budget:
//   Keep the five blocks combined within TOTAL_CAP (24KB ≈ 6000 tokens). On overflow,
//   trim in order of lowest priority first (lessons → journal → todo → roadmap → session-state).
//   Each file is guaranteed MIN_FLOOR (2KB). session-state/todo/roadmap are written head-first,
//   so trimming drops the tail. lessons (ascending append) and the journal (chronological)
//   have their most recent — most actionable — entries at the tail: those keep the tail instead.
//
// Batch A / A6 addition (2026-08-12): if <tasksDir>/codemap.md exists, also inject a short
// pointer block — the file's path plus its `##` headings plus one reminder line. This is
// deliberately NOT the file body (unlike the five blocks above): dev/reprodocs/tasks/lessons.md
// [2026-08-12] recorded four parallel investigations (26 agents) on 2026-08-12 alone re-deriving
// facts an earlier session had already mapped, so the goal here is "know the map exists and where
// it is" cheaply, every session, not "read the whole map" every session (that cost was flagged
// explicitly). Opt-in / fail-open: no codemap.md at tasksDir -> no block, no error. Does not
// participate in the TOTAL_CAP/allocateBudget accounting below — it has its own independent
// hard cap (CODEMAP_CAP) applied directly in codemapPointerBlock(), not the shared budget/trim
// machinery used by the five blocks above. Correction (2026-08-12, post-review): the `##`
// headings list was previously unbounded (no cap at all) despite this comment's earlier "fixed
// small summary" claim — a codemap.md with many/long headings could grow this block arbitrarily.

const fs = require('node:fs');
const path = require('node:path');
const { projectRoot, journalPath } = require('./lib/journal-util');

const TOTAL_CAP = 24 * 1024; // combined upper limit
const MIN_FLOOR = 2 * 1024; // minimum guaranteed per file
const JOURNAL_SLICE = 2 * 1024; // today's journal: tail slice read upfront
const CODEMAP_CAP = 2 * 1024; // CODEMAP pointer block's `##` headings list: independent hard byte cap (matches MIN_FLOOR/JOURNAL_SLICE scale)

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
  ];
  for (const f of files) {
    blocks.push(`\n=== ${f.label} ===\n` + (f.text == null ? f.empty : f.text));
  }
  const codemapBlock = codemapPointerBlock(tasksDir, projectDir);
  if (codemapBlock) blocks.push(codemapBlock);

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

// A6: short pointer block for tasks/codemap.md — path + `##` headings + one reminder line.
// Deliberately does not read/inject the file body (see header comment). Returns null when the
// file doesn't exist at this tasksDir (opt-in, fail-open: missing file -> null, no error).
function codemapPointerBlock(tasksDir, projectDir) {
  const codemapPath = path.join(tasksDir, 'codemap.md');
  let text;
  try {
    text = fs.readFileSync(codemapPath, 'utf8');
  } catch {
    return null;
  }
  const relPath = path.relative(projectDir, codemapPath).split(path.sep).join('/');
  const headings = text.split('\n').filter((line) => /^##\s+/.test(line));
  let headingsBlock = headings.length ? headings.join('\n') + '\n' : '';
  // Correction (2026-08-12, post-review): this block was previously unbounded — a codemap.md
  // with many/long headings could grow it arbitrarily. Hard-cap it, mirroring the trimTail/
  // trimHead UTF-8-boundary-safe truncation idiom used for the five budgeted blocks above.
  if (Buffer.byteLength(headingsBlock, 'utf8') > CODEMAP_CAP) {
    const buf = Buffer.from(headingsBlock, 'utf8').subarray(0, CODEMAP_CAP);
    headingsBlock =
      buf.toString('utf8').replace(/�+$/, '') +
      `\n[…見出し一覧を ${CODEMAP_CAP} バイトで打ち切り。全文は ${relPath}]\n`;
  }
  return (
    `\n=== CODEMAP ===\n${relPath}\n` +
    headingsBlock +
    `構造を grep で調べ直す前にこれを読む。`
  );
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
