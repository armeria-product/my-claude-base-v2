// Shared journal helpers for journal.js / session-journal.js / scope guards.
// The journal is the crash-durable record layer: hooks (OS processes outside the model)
// append one line per event, so the trail survives any CLI crash up to the last tool call.
// Append-only by contract — nothing in this module ever deletes or rewrites.

const fs = require('node:fs');
const path = require('node:path');

const two = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function id8(payload) {
  return String(payload.session_id || '--------').slice(0, 8);
}

// Resolve the workspace root defensively: normalize each candidate (path.resolve absorbs
// drive-relative forms like "D:my-claude-base-v2" — a real v1 incident class), then walk up
// until a directory containing .claude/ is found. Prevents a malformed cwd from silently
// planting a journal/ tree in the wrong place.
function projectRoot(payload) {
  const candidates = [process.env.CLAUDE_PROJECT_DIR, payload.cwd, process.cwd()];
  for (let c of candidates) {
    if (!c) continue;
    let dir = path.resolve(c);
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, '.claude'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return path.resolve(payload.cwd || process.cwd());
}

// journal/YYYY-MM/DD.md for a given date (default today), creating dir + header on demand
function journalFile(root, d = new Date()) {
  const dir = path.join(root, 'journal', `${d.getFullYear()}-${two(d.getMonth() + 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${two(d.getDate())}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} 作業ジャーナル\n\n`
    );
  }
  return file;
}

// Path of the journal file for a date WITHOUT creating anything (for read-side scans)
function journalPath(root, d) {
  return path.join(
    root,
    'journal',
    `${d.getFullYear()}-${two(d.getMonth() + 1)}`,
    `${two(d.getDate())}.md`
  );
}

function appendLine(root, line) {
  fs.appendFileSync(journalFile(root), line + '\n');
}

function relToRoot(root, p) {
  if (!p) return '';
  let r = path.isAbsolute(p) ? path.relative(root, p) : p;
  r = r.split(path.sep).join('/');
  return r || String(p);
}

function clip(s, n) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

module.exports = { stamp, id8, projectRoot, journalFile, journalPath, appendLine, relToRoot, clip, two };
