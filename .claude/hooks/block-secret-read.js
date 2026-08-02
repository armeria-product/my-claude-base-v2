#!/usr/bin/env node
// PreToolUse hook: blocks Bash commands that read secret files via cat/less/more/head/tail/xxd/od/strings
// Mirrors the Read() deny list in settings.json for the Bash tool pathway.
//
// Blocked file patterns (same as settings.json deny list):
//   .env, .env.*, **/.env, **/.env.*
//   **/*.pem, **/*.key
//   **/secrets/**
//   ~/.ssh/**, ~/.aws/**
//
// Note: .env.example is BLOCKED — the pattern matches .env.* which includes .env.example,
// mirroring the Read() deny list exactly. To allow .env.example, add an explicit exception below.
//
// Input: Claude Code hook event JSON on stdin
// Output: for a matching command, message on stderr + exit 2 (block); otherwise exit 0

const { segments } = require('./lib/parse-cmd');
const path = require('node:path');
const os = require('node:os');

// Commands that read file contents to stdout.
// PowerShell readers included (the PowerShell tool shares this hook via the Bash|PowerShell
// matcher): Get-Content + aliases gc/type; select-string as the grep-alike; cat is shared.
const READ_CMDS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'xxd', 'od', 'strings', 'bat', 'tac',
  'get-content', 'gc', 'type', 'select-string',
]);

// Patterns that flag a path as secret (tested against resolved path string)
const SECRET_PATH_PATTERNS = [
  // .env files (any directory)
  /(?:^|\/)\.env(?:\.[^/]*)?$/,
  // PEM / private key files
  /\.pem$/i,
  /\.key$/i,
  // secrets directories
  /(?:^|\/)secrets\//,
  // SSH / AWS config dirs — match the .ssh/.aws path component anywhere.
  // The home form differs across OSes (/home/x, /root, C:/Users/x, ~), so anchoring on
  // home/root missed Windows-expanded paths entirely; reading either dir is always sensitive.
  /(?:^|\/)\.ssh\//,
  /(?:^|\/)\.aws\//,
];

// Also match tilde-expanded home directory patterns
function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function isSecretPath(p) {
  // Normalize separators to '/': os.homedir()/path.join return backslashes on Windows,
  // which the forward-slash patterns above would never match (let secret reads slip through).
  const expanded = expandHome(p.replace(/^["']|["']$/g, '')).replace(/\\/g, '/');
  return SECRET_PATH_PATTERNS.some((re) => re.test(expanded));
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    const payload = JSON.parse(data);
    command = payload.tool_input?.command || '';
  } catch {
    process.exit(0);
  }

  for (const { cmd, args } of segments(command)) {
    if (!READ_CMDS.has(cmd)) continue;
    // args may contain flags (-n, --lines, etc.) and file paths
    const filePaths = args.filter((a) => !a.startsWith('-'));
    for (const p of filePaths) {
      if (isSecretPath(p)) {
        console.error(
          `BLOCKED: Reading secret file "${p}" via "${cmd}" is not allowed. ` +
          'Use the Read tool for files that need explicit permission checking.'
        );
        process.exit(2);
      }
    }
  }

  process.exit(0);
});
