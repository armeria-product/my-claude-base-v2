#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): command-pathway counterpart of scope-guard.js.
//
// Two duties:
//   1. UNCONDITIONAL (lock state irrelevant): deny any command that mentions .claude/state
//      together with a write indicator — the lock file must not be writable via the shell.
//   2. While locked: extract write targets from the command (bash tokens via lib/parse-cmd,
//      PowerShell cmdlets via exact-name regex) and run them through the shared decision
//      chain. A write whose target cannot be resolved (e.g. a $variable path, or inline
//      node/python code with a write API but no path literal) is denied fail-closed with
//      "use the Write tool or an explicit path".
//
// This parser is a tripwire, not a wall: script files on disk, package managers, and
// obfuscated commands can slip through. The after-the-fact backstop is the git-status
// conformance check (/save-session) and the reviewer's Scope Conformance lens.
// Read-only commands (no write indicator) are never touched.

const { segments } = require('./lib/parse-cmd');
const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');
const { readLock, decide, denyReason } = require('./lib/scope-decision');

const STATE_RE = /\.claude[\\/]+state/i;
const WRITE_INDICATOR_RE =
  /(?:^|[\s;|&(])(?:\d?>>?|&>>?)|\btee\b|\bsed\s+-i|\b(?:mv|cp|rm|dd|truncate|ln|shred)\b|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Export-Csv|Export-Clixml|Tee-Object|Start-Transcript|writeFileSync|writeFile\b|appendFile|createWriteStream|\bopen\s*\([^)]*['"](?:w|a)|git\s+(?:checkout|restore)\b/i;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    main();
  } catch (err) {
    process.stderr.write(`cmd-write-guard: skipped (${err.message})\n`);
  }
  process.exit(0);
});

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

function main() {
  const payload = JSON.parse(data || '{}');
  if (!['Bash', 'PowerShell'].includes(payload.tool_name)) return;
  const command = String(payload.tool_input?.command || '');
  if (!command) return;

  const root = projectRoot(payload);

  // --- Duty 1: .claude/state is shell-unwritable, always -------------------------------
  if (STATE_RE.test(command) && WRITE_INDICATOR_RE.test(command)) {
    appendLine(root, `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} (state-protect) "${command.replace(/\s+/g, ' ').slice(0, 100)}"`);
    deny(
      '[scope-lock] .claude/state/ はフック専用の状態置き場で、シェル経由の書き込み・移動・復元は常に禁止です（ロックの改ざん耐性の根幹）。' +
        '読み取り（cat 等）は自由です。このコマンドが state を書く意図でないなら、state に触れる部分と書き込み操作を別コマンドに分けて実行してください。'
    );
    return;
  }

  // --- Duty 2: scope enforcement while locked ------------------------------------------
  const lock = readLock(root);
  if (!lock || lock.status !== 'locked') return;
  if (!WRITE_INDICATOR_RE.test(command)) return; // read-only commands pass untouched

  const cwd = payload.cwd || root;
  const { targets, unresolved } =
    payload.tool_name === 'PowerShell' ? extractPs(command) : { targets: [], unresolved: false };
  const bash = extractBash(command);
  targets.push(...bash.targets);
  const anyUnresolved = unresolved || bash.unresolved;

  for (const t of targets) {
    const verdict = decide(cwd, lock, resolveAgainst(cwd, root, t));
    if (verdict) {
      appendLine(
        root,
        `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} ${verdict.rel} (scope: ${lock.slug}, ${verdict.why}) cmd="${command.replace(/\s+/g, ' ').slice(0, 80)}"`
      );
      deny(denyReason(verdict, lock));
      return;
    }
  }

  if (anyUnresolved) {
    appendLine(
      root,
      `- ${stamp()} [${id8(payload)}] DENY ${payload.tool_name.toLowerCase()} (unresolved-target) cmd="${command.replace(/\s+/g, ' ').slice(0, 80)}"`
    );
    deny(
      `[scope-lock] ロック中（slug: ${lock.slug}）は、書き込み先を機械判定できないコマンド（変数宛て・パス文字列の無いインラインコード等）は実行できません。` +
        'Edit/Write ツールを使うか、書き込み先パスをコマンド内に明示してください。'
    );
  }
}

// Targets are extracted as written (relative to the command's cwd); decide() resolves
// against root, so re-anchor relative targets on cwd first.
function resolveAgainst(cwd, root, t) {
  const path = require('node:path');
  return path.isAbsolute(t) ? t : path.resolve(cwd, t);
}

const REDIR_FULL = /^(\d?>>?|&>>?|>\|)$/;
const REDIR_ATTACHED = /^(?:\d?>>?|&>>?)(.+)$/;

function extractBash(command) {
  const targets = [];
  let unresolved = false;
  for (const { cmd, args } of segments(command)) {
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      let m;
      if (REDIR_FULL.test(t)) {
        const nxt = args[i + 1];
        if (nxt && !/^&\d$/.test(nxt) && !/^\/dev\/null$|^NUL$/i.test(nxt)) targets.push(nxt);
        i++;
      } else if ((m = t.match(REDIR_ATTACHED))) {
        if (!/^&\d$/.test(m[1]) && !/^\/dev\/null$|^NUL$/i.test(m[1])) targets.push(m[1]);
      }
    }
    const plain = args.filter((a) => !a.startsWith('-') && !REDIR_FULL.test(a) && !REDIR_ATTACHED.test(a));
    switch (cmd) {
      case 'tee':
        targets.push(...plain);
        break;
      case 'sed':
        if (args.some((a) => /^-i/.test(a))) targets.push(...plain.slice(1)); // plain[0] = script expr
        break;
      case 'mv':
      case 'cp': {
        const ti = args.indexOf('-t');
        if (ti >= 0 && args[ti + 1]) targets.push(args[ti + 1]);
        else if (plain.length >= 2) targets.push(plain[plain.length - 1]);
        break;
      }
      case 'rm':
      case 'mkdir':
      case 'touch':
      case 'truncate':
      case 'ln':
      case 'shred':
        targets.push(...plain);
        break;
      case 'dd': {
        const of = args.find((a) => a.startsWith('of='));
        if (of) targets.push(of.slice(3));
        break;
      }
      case 'git': {
        const sub = args.find((a) => !a.startsWith('-'));
        if (sub === 'checkout' || sub === 'restore') {
          const dd = args.indexOf('--');
          const paths =
            dd >= 0
              ? args.slice(dd + 1)
              : sub === 'restore'
                ? args.slice(args.indexOf(sub) + 1).filter((a) => !a.startsWith('-'))
                : []; // bare "git checkout <branch>" is branch switching, not a file write
          targets.push(...paths.filter((a) => !a.startsWith('-')));
        }
        break;
      }
      case 'node':
      case 'python':
      case 'python3':
      case 'py': {
        const ei = args.findIndex((a) => a === '-e' || a === '--eval' || a === '-c');
        if (ei >= 0) {
          const code = args[ei + 1] || '';
          if (/writeFileSync|writeFile\b|appendFile|createWriteStream|open\s*\([^)]*['"](?:w|a)/.test(code)) {
            const lits = [...code.matchAll(/['"]([^'"]{1,200})['"]/g)]
              .map((x) => x[1])
              .filter((s) => /[\\/.]/.test(s) && !/^(w|a|r|[wa]\+|utf-?8)$/i.test(s));
            if (lits.length) targets.push(...lits);
            else unresolved = true;
          }
        }
        break;
      }
    }
  }
  return { targets, unresolved };
}

const PS_CMDLET_RE =
  /\b(Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Export-Csv|Export-Clixml|Tee-Object|Start-Transcript)\b([^|;]*)/gi;
const PS_IO_RE = /\[(?:System\.)?IO\.File\]::(?:Write|Append)[A-Za-z]*\(\s*(?:"([^"]+)"|'([^']+)'|(\$\w+))/gi;

function extractPs(command) {
  const targets = [];
  let unresolved = false;
  let m;
  PS_CMDLET_RE.lastIndex = 0;
  while ((m = PS_CMDLET_RE.exec(command))) {
    const rest = m[2] || '';
    const named = rest.match(
      /-(?:Path|LiteralPath|FilePath|Destination|NewName|OutFile)\s+(?:"([^"]+)"|'([^']+)'|([^\s,;|]+))/i
    );
    let t = named ? named[1] || named[2] || named[3] : null;
    if (!t) {
      const pos = rest.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|-][^\s;|]*))/);
      t = pos ? pos[1] || pos[2] || pos[3] : null;
    }
    if (!t) continue; // e.g. "| Remove-Item" over pipeline objects — leave to the backstop
    if (/^\$/.test(t)) {
      unresolved = true;
      continue;
    }
    targets.push(t);
  }
  PS_IO_RE.lastIndex = 0;
  while ((m = PS_IO_RE.exec(command))) {
    if (m[3]) unresolved = true;
    else targets.push(m[1] || m[2]);
  }
  return { targets, unresolved };
}
