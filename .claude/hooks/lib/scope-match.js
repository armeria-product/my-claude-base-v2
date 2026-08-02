// Minimal dependency-free glob matcher for the scope lock (shared by scope-guard.js and
// cmd-write-guard.js). Supported subset — documented in the plan skill's scope.json contract:
//   **   any characters incl. "/" (any depth)
//   **/  any number of directory segments (including zero)
//   *    any characters within one path segment (no "/")
//   everything else matches literally (case-insensitive — Windows filesystem)
// A trailing "/" on a pattern is normalized to "/**" (directory prefix form).
// Input paths are matched as project-relative, "/"-separated strings.

const path = require('node:path');

function compile(pattern) {
  let p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '/**');
  let src = '^';
  for (let i = 0; i < p.length; ) {
    if (p.startsWith('**/', i)) {
      src += '(?:[^/]+/)*';
      i += 3;
    } else if (p.startsWith('**', i)) {
      src += '.*';
      i += 2;
    } else if (p[i] === '*') {
      src += '[^/]*';
      i += 1;
    } else {
      src += p[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(src + '$', 'i');
}

function matches(relPath, patterns) {
  const r = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return (patterns || []).some((pt) => compile(pt).test(r));
}

// Normalize an absolute or relative path against root -> { rel, outside }
//   rel     : "/"-separated project-relative path (meaningless when outside=true)
//   outside : true when the path resolves outside the project root
function normalizeRel(root, p) {
  const abs = path.resolve(root, String(p));
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { rel: rel.split(path.sep).join('/'), outside, abs };
}

module.exports = { compile, matches, normalizeRel };
