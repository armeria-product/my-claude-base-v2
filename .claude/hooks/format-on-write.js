#!/usr/bin/env node
// PostToolUse hook (Edit|Write): auto-format the edited file per the project's conventions
//
// Design (user-approved 2026-06-12):
//   - Scope is limited to dev/{name}/ only (never touches harness config or the repo root)
//   - Only fires when that product has a formatter config present
//   - Formats just the single edited file (never the whole project)
//   - Fully fail-open: always exits 0 even if the formatter is missing, fails, or times out
//
// Supported: prettier (js/ts/css/json/md etc., npx --no-install so local bin only) /
//            ruff format / black (py) / rustfmt (rs) / gofmt (go)

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PRETTIER_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|css|scss|less|json|md|html|vue|ya?ml)$/i;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch {
    /* fail-open */
  }
  process.exit(0);
});

function main() {
  const payload = JSON.parse(data || '{}');
  const filePath = payload.tool_input?.file_path;
  if (!filePath || !fs.existsSync(filePath)) return;

  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const relRaw = path.relative(root, path.resolve(filePath));
  const rel = relRaw.split(path.sep).join('/');
  // dev/{name}/ only. Anything outside (.claude/ or repo root) is out of scope
  const m = rel.match(/^dev\/([^/]+)\//);
  if (!m) return;
  const productRoot = path.join(root, 'dev', m[1]);

  const has = (...names) => names.some((n) => fs.existsSync(path.join(productRoot, n)));
  const pyproject = () => {
    try {
      return fs.readFileSync(path.join(productRoot, 'pyproject.toml'), 'utf8');
    } catch {
      return '';
    }
  };
  const pkgHasPrettier = () => {
    try {
      return 'prettier' in JSON.parse(fs.readFileSync(path.join(productRoot, 'package.json'), 'utf8'));
    } catch {
      return false;
    }
  };

  const run = (cmd) =>
    execSync(cmd, { cwd: productRoot, stdio: 'ignore', timeout: 15000 });

  const ext = path.extname(filePath).toLowerCase();
  const q = `"${path.resolve(filePath)}"`;

  if (
    PRETTIER_EXT.test(filePath) &&
    (has('.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js', 'prettier.config.cjs') ||
      pkgHasPrettier())
  ) {
    run(`npx --no-install prettier --write ${q}`); // local install only. throws if not installed -> fail-open
  } else if (ext === '.py') {
    const py = pyproject();
    if (has('ruff.toml', '.ruff.toml') || py.includes('[tool.ruff]')) run(`ruff format ${q}`);
    else if (py.includes('[tool.black]')) run(`black -q ${q}`);
  } else if (ext === '.rs' && has('rustfmt.toml', '.rustfmt.toml')) {
    run(`rustfmt ${q}`);
  } else if (ext === '.go' && has('go.mod')) {
    run(`gofmt -w ${q}`);
  }
}
