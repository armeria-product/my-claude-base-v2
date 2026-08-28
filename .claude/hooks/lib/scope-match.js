// Path-normalization helper shared by block-destructive-fs.js and cmd-write-guard.js (rm/shred
// workspace-root containment, and the .claude/.fable-status shell-write guard).
// Input paths are matched as project-relative, "/"-separated strings.

const path = require('node:path');

// Normalize an absolute or relative path against root -> { rel, outside }
//   rel     : "/"-separated project-relative path (meaningless when outside=true)
//   outside : true when the path resolves outside the project root
function normalizeRel(root, p) {
  const abs = path.resolve(root, String(p));
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { rel: rel.split(path.sep).join('/'), outside, abs };
}

module.exports = { normalizeRel };
