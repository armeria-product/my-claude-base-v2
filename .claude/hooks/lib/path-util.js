const path = require('node:path');

// Resolve a path against root and return a stable, slash-separated project-relative view.
function normalizeRel(root, value) {
  const abs = path.resolve(root, String(value));
  const relative = path.relative(root, abs);
  const outside = relative.startsWith('..') || path.isAbsolute(relative);
  return { rel: relative.split(path.sep).join('/'), outside, abs };
}

module.exports = { normalizeRel };
