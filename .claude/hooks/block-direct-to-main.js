#!/usr/bin/env node
// PreToolUse hook: enforce the branch-based workflow — keep changes off main/master.
// Input:  Claude Code hook event JSON on stdin
// Output: if the command would land on main/master directly, write a message to stderr + exit 2 (block);
//         otherwise exit 0.
//
// This repository never commits to main directly. Each work unit lives on its own `<topic>-<YYYY-MM-DD>`
// branch, and main advances ONLY when the user merges the Pull Request (CLAUDE.md §3 Git Workflow).
//
// Blocked:
//   - git commit ...            while the current branch is main/master (any flags, incl. --amend)
//   - git push ... <dst=main>   a push whose DESTINATION ref is main/master:
//       explicit refspec : push origin main | dev:main | HEAD:main | +main   (destination = main)
//       bare push        : push  /  push <remote>     while the current branch is main/master
//   - git merge / pull / rebase / reset --hard   while the current branch is main/master (these
//       advance/rewrite main locally even though they issue no `commit`)
//   - the same commit check also applies to a `-C <path>` / `--git-dir=` / `--work-tree=` target
//       repo: the branch is resolved IN that repo, not the hook process's cwd
//
// Allowed (NOT blocked): commits/pushes on any other branch (e.g. a work branch); `git merge main` onto a work branch;
//   `git push origin main:<work-branch>` (destination = non-main); fetch / switch / checkout / branch / status / log / diff;
//   `git merge/rebase --abort|--quit|--help` even while sitting on main/master (undo/inspect only,
//   never advances history).
//
// Known limitation: undo/inspect detection is flag-based (--abort/--quit/--help); a `-h` alias
// combined with other advancing flags in the same invocation is not specially disambiguated.
//
// Command parsing goes through the shared tokenizer (lib/parse-cmd: quote-aware segment split,
// then per-token unquoting) so a quoted commit message / heredoc that merely mentions "main"
// never false-triggers, while a quoted refspec (e.g. push origin "main") is still inspected (lessons 2026-06-28).
// Fail-open: any error (not a repo, detached HEAD, git unavailable) -> exit 0.

const { execSync } = require('node:child_process');
const { segments } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

const PROTECTED = new Set(['main', 'master']);

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(data).tool_input?.command || '';
  } catch {
    process.exit(0);
  }
  const verdict = checkCommand(command);
  if (verdict) {
    console.error(
      `BLOCKED: ${verdict}.\n` +
        `このリポジトリは main に直接コミット／プッシュしません。作業用ブランチで作業し、` +
        `GitHub の取り込み提案(PR)経由で main に反映してください（例: git switch -c <topic>-$(date +%F) main）。`
    );
    process.exit(2);
  }
  process.exit(0);
});

const branchCache = new Map();
// cwd === undefined -> resolve in the hook process's own working directory (cached under key '').
function currentBranch(cwd) {
  const key = cwd || '';
  if (branchCache.has(key)) return branchCache.get(key);
  let result;
  try {
    result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    result = null; // not a repo / git unavailable -> unknown -> fail-open
  }
  branchCache.set(key, result);
  return result;
}

// Extract -C <path> / --git-dir=<path> / --work-tree=<path> (or the space-separated forms) from
// the args preceding the subcommand, so the branch check runs against the TARGET repo, not the
// hook process's cwd.  Returns null if none of these were given (-> use the process cwd).
function targetRepoPath(args, subIdx) {
  let dir = null;
  for (let i = 0; i < subIdx; i++) {
    const a = args[i];
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      dir = args[i + 1] || dir;
    } else if (a.startsWith('--git-dir=')) {
      dir = a.slice('--git-dir='.length);
    } else if (a.startsWith('--work-tree=')) {
      dir = a.slice('--work-tree='.length);
    }
  }
  return dir;
}

// Destination branch name of a push refspec: the part after ':' (or the whole token), minus a leading
// '+' (force) and a 'refs/heads/' prefix.  main -> main ; dev:main -> main ; main:dev -> dev ; +main -> main.
function pushDestName(refspec) {
  const noForce = refspec.replace(/^\+/, '');
  const dst = noForce.includes(':') ? noForce.slice(noForce.indexOf(':') + 1) : noForce;
  return dst.replace(/^refs\/heads\//, '');
}

// Subcommands that advance/rewrite the current branch's history (as opposed to just inspecting it).
// When the current branch is main/master, these move main locally even though none of them is a
// `commit` invocation.
const MAIN_ADVANCING_SUBCMDS = new Set(['merge', 'pull', 'rebase']);

// Flags that make merge/rebase an undo or inspect operation instead of one that advances history
// (abort/quit an in-progress merge or rebase, or just print help) — harmless even on a protected branch.
const NON_ADVANCING_FLAGS = new Set(['--abort', '--quit', '--help', '-h']);

function checkCommand(command) {
  for (const { cmd, args } of segments(command)) {
    if (cmd !== 'git') continue;
    const subIdx = findSubcmdIndex(args);
    if (subIdx === -1) continue;
    const sub = args[subIdx];
    const rest = args.slice(subIdx + 1);
    const repoPath = targetRepoPath(args, subIdx);

    // 1. commit on a protected branch (the message is irrelevant — we check the branch, not the args)
    //    resolved against the -C/--git-dir/--work-tree target repo when given, not the hook's own cwd.
    if (sub === 'commit') {
      const b = currentBranch(repoPath);
      if (b && PROTECTED.has(b)) return `git commit on protected branch "${b}"`;
    }

    // 2. push whose destination is a protected branch
    if (sub === 'push') {
      // positionals after 'push', ignoring flags
      const positionals = rest.filter((a) => !a.startsWith('-') && a !== '');
      const refspecs = positionals.length >= 2 ? positionals.slice(1) : [];
      if (refspecs.length > 0) {
        for (const r of refspecs) {
          let dst = pushDestName(r);
          // HEAD/@ resolve to the current branch on push
          if (dst === 'HEAD' || dst === '@') {
            const b = currentBranch(repoPath);
            if (b) dst = b;
          }
          if (PROTECTED.has(dst)) return 'git push to protected branch (main/master)';
        }
      } else {
        // bare push / remote-only push -> pushes the current branch
        const b = currentBranch(repoPath);
        if (b && PROTECTED.has(b)) return `git push from protected branch "${b}"`;
      }
    }

    // 3. merge / pull / rebase while sitting on a protected branch: these advance/rewrite main
    //    locally without ever calling `commit`. Exception: --abort/--quit/--help are undo/inspect
    //    operations that never advance history, so they're harmless even on main/master.
    if (MAIN_ADVANCING_SUBCMDS.has(sub) && !rest.some((a) => NON_ADVANCING_FLAGS.has(a))) {
      const b = currentBranch(repoPath);
      if (b && PROTECTED.has(b)) return `git ${sub} on protected branch "${b}"`;
    }

    // 4. `git reset --hard origin/main` (or any ref) while sitting on a protected branch moves
    //    main's history locally to match an arbitrary ref.
    if (sub === 'reset' && rest.includes('--hard')) {
      const b = currentBranch(repoPath);
      if (b && PROTECTED.has(b)) return `git reset --hard on protected branch "${b}"`;
    }
  }
  return null;
}
