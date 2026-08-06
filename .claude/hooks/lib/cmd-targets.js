// Write-target extraction for cmd-write-guard.js (bash tokens via lib/parse-cmd, PowerShell
// cmdlets via exact-name regex). Shared so the extraction logic is independently unit-testable.
//
//   extractTargets(toolName, command, startCwd) -> { targets: string[](absolute paths), unresolved: boolean }
//
// cd tracking (bash path only): segments() is walked with a running cwd; `cd <path>` updates
// it for later segments in the same command, `cd` (bare, -> home) and `cd -` leave it
// unchanged. NOT tracked: subshells `( )`, a cd inside one stage of a pipeline (runs in a
// separate process — inheriting it anyway over-detects, which is safe), pushd/popd, and
// variable-expanded cd targets. The PowerShell path does no cd tracking — its targets resolve
// against startCwd only. This precise/limited model is intentional for extractTargets, which
// feeds Duty 2 (scope enforcement) — over-detecting there would falsely deny legitimate writes.
//
//   extractStateCandidates(toolName, command, startCwd) -> string[](absolute paths)
//
// A SEPARATE, deliberately over-detecting extractor used only by cmd-write-guard.js's
// unconditional .claude/state protection (Arm B). For that check the safe direction is the
// opposite of Duty 2's: a false DENY just makes the user split the command, but a false ALLOW
// is a tamper. So this path additionally treats `pushd <dest>` and a subshell-entry `cd <dest>`
// as cwd changes, in both tokenizations the parser produces — glued (`(cd .claude` -> cmd "(cd")
// and space-separated (`( cd .claude` -> cmd "(", args[0] "cd") — with NO subshell-exit scoping
// (a cd inside `( )` leaks forward to the rest of the command).
// The PowerShell mirror treats any `Set-Location`/`sl`/`pushd` call whose destination path is (or
// ends in) `.claude`, anywhere in the command, as grounds to re-scan all write cmdlets rooted at
// `.claude` instead of startCwd — also with no ordering/scoping precision. Both intentionally
// over-approximate (e.g. a cd-into-.claude that happens AFTER an unrelated state/-named write
// elsewhere in the same command can still flag) — accepted per the design principle above.

const path = require('node:path');
const { segments } = require('./parse-cmd');

const REDIR_FULL = /^(\d?>>?|&>>?|>\|)$/;
const REDIR_ATTACHED = /^(?:\d?>>?|&>>?)(.+)$/;

function extractBash(command, startCwd, opts = {}) {
  const liberalCd = !!opts.liberalCd;
  const targets = [];
  let unresolved = false;
  let cur = startCwd;
  for (const { cmd, args } of segments(command)) {
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      let m;
      if (REDIR_FULL.test(t)) {
        const nxt = args[i + 1];
        if (nxt && !/^&\d$/.test(nxt) && !/^\/dev\/null$|^NUL$/i.test(nxt)) targets.push(path.resolve(cur, nxt));
        i++;
      } else if ((m = t.match(REDIR_ATTACHED))) {
        if (!/^&\d$/.test(m[1]) && !/^\/dev\/null$|^NUL$/i.test(m[1])) targets.push(path.resolve(cur, m[1]));
      }
    }
    const plain = args.filter((a) => !a.startsWith('-') && !REDIR_FULL.test(a) && !REDIR_ATTACHED.test(a));
    // Both the liberal-mode block below and the `case 'cd':` in the switch further down compare
    // `cmd`/`bare` against the literal strings 'cd' and 'pushd'. That literal comparison only
    // matches the unsuffixed spelling by construction of lib/parse-cmd.js's CWD_BUILTINS
    // exception: cd/pushd/popd are deliberately NOT suffix-stripped there (`cd.exe` normalizes to
    // `cd.exe`, not `cd`), specifically so a real `cd.exe` invocation — which as a child process
    // can never move the parent shell's cwd anyway — is never mistaken here for a real cwd move.
    // So `cd.exe`/`pushd.exe` correctly fall through both cd-tracking blocks in this file as a
    // no-op, but that correctness is inherited from parse-cmd.js and invisible from this file
    // alone — see the CWD_BUILTINS comment in lib/parse-cmd.js for the full rationale.
    // Liberal-only: `pushd <dest>` and a subshell-entry `cd <dest>` also move `cur`, with no
    // subshell-exit scoping. Bare `cd` (no parens at all) is handled below, unconditionally, for
    // both modes — this block only covers the additional liberal forms: the tokenizer glues a
    // paren directly onto the command when there's no space (`(cd` -> cmd "(cd"), but leaves it as
    // its own token when there is one (`( cd` -> cmd "(", args[0] "cd") — both are covered.
    if (liberalCd) {
      const bare = cmd.replace(/^\(+/, '');
      let dest = null;
      if ((bare === 'cd' && cmd !== bare) || bare === 'pushd') {
        dest = plain[0];
      } else if (cmd !== '' && /^\(+$/.test(cmd) && (args[0] === 'cd' || args[0] === 'pushd')) {
        dest = plain[1];
      }
      if (dest) cur = path.resolve(cur, dest);
    }
    switch (cmd) {
      case 'cd': {
        const dest = plain[0];
        if (dest) cur = path.resolve(cur, dest);
        break;
      }
      case 'tee':
        targets.push(...plain.map((p) => path.resolve(cur, p)));
        break;
      case 'sed':
        if (args.some((a) => /^-i/.test(a))) targets.push(...plain.slice(1).map((p) => path.resolve(cur, p))); // plain[0] = script expr
        break;
      case 'mv':
      case 'cp': {
        const ti = args.indexOf('-t');
        if (ti >= 0 && args[ti + 1]) targets.push(path.resolve(cur, args[ti + 1]));
        else if (plain.length >= 2) targets.push(path.resolve(cur, plain[plain.length - 1]));
        break;
      }
      case 'rm':
      case 'mkdir':
      case 'touch':
      case 'truncate':
      case 'ln':
      case 'shred':
        targets.push(...plain.map((p) => path.resolve(cur, p)));
        break;
      case 'dd': {
        const of = args.find((a) => a.startsWith('of='));
        if (of) targets.push(path.resolve(cur, of.slice(3)));
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
          targets.push(...paths.filter((a) => !a.startsWith('-')).map((p) => path.resolve(cur, p)));
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
            if (lits.length) targets.push(...lits.map((p) => path.resolve(cur, p)));
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

function extractPs(command, startCwd) {
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
    targets.push(path.win32.resolve(startCwd, t));
  }
  PS_IO_RE.lastIndex = 0;
  while ((m = PS_IO_RE.exec(command))) {
    if (m[3]) unresolved = true;
    else targets.push(path.win32.resolve(startCwd, m[1] || m[2]));
  }
  return { targets, unresolved };
}

function extractTargets(toolName, command, startCwd) {
  const cwd = startCwd || process.cwd();
  const targets = [];
  let unresolved = false;
  if (toolName === 'PowerShell') {
    const ps = extractPs(command, cwd);
    targets.push(...ps.targets);
    unresolved = unresolved || ps.unresolved;
  }
  const bash = extractBash(command, cwd);
  targets.push(...bash.targets);
  unresolved = unresolved || bash.unresolved;
  return { targets, unresolved };
}

// PowerShell cd-equivalents recognized only by the liberal state-candidate path below.
const PS_CD_RE = /\b(?:Set-Location|sl|pushd)\b\s+(?:-(?:Path|LiteralPath)\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;|]+))/gi;

// See header: deliberately over-detecting, used only for the .claude/state protection check.
function extractStateCandidates(toolName, command, startCwd) {
  const cwd = startCwd || process.cwd();
  const targets = [];
  targets.push(...extractBash(command, cwd, { liberalCd: true }).targets);
  if (toolName === 'PowerShell') {
    let sawClaudeCd = false;
    PS_CD_RE.lastIndex = 0;
    let m;
    while ((m = PS_CD_RE.exec(command))) {
      const dest = m[1] || m[2] || m[3];
      if (dest && /(^|[\\/])\.claude$/i.test(dest)) sawClaudeCd = true;
    }
    if (sawClaudeCd) {
      targets.push(...extractPs(command, path.resolve(cwd, '.claude')).targets);
    }
  }
  return targets;
}

module.exports = { extractTargets, extractStateCandidates };
