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
//   - gh pr merge ...           any flag form (e.g. --admin, --squash) and any global-flag
//       placement (e.g. `gh --repo o/r pr merge 12`) — merging a PR is another way to advance main
//
// Allowed (NOT blocked): commits/pushes on any other branch (e.g. a work branch); `git merge main` onto a work branch;
//   `git push origin main:<work-branch>` (destination = non-main); fetch / switch / checkout / branch / status / log / diff;
//   `git merge/rebase --abort|--quit|--help` even while sitting on main/master (undo/inspect only,
//   never advances history); gh pr view/list/create/checkout/status/diff/comment/edit/ready/review,
//   gh repo *, gh issue * (inspection / non-merge PR workflow — never advances main).
//
// Known limitation: undo/inspect detection is flag-based (--abort/--quit/--help); a `-h` alias
// combined with other advancing flags in the same invocation is not specially disambiguated.
//
// Known limitation (gh, 2 items — deliberately left open, filed as tasks/todo.md Backlog items):
//   (i) `gh api --method PUT repos/.../pulls/N/merge` (direct REST call) is not detected — API-level
//       calls are out of scope for this guard by design.
//   (ii) `gh.exe pr merge` / `gh.cmd pr merge` ARE now detected: lib/parse-cmd.js strips a trailing
//       `.exe`/`.cmd` suffix from the resolved basename (ruling GP2), so both resolve to `cmd === "gh"`
//       here, same as the git-side checks in this file. Residual gaps parse-cmd.js does NOT fix (see
//       plan Table C): an unquoted path containing spaces (e.g. `C:/Program Files/gh/bin/gh.exe pr merge`
//       resolves to `cmd === "program"`, not `"gh"`); a backslash-separated path (only `/` is split, not
//       `\`); `eval.exe "gh pr merge 12"` (the basename strips to `eval`, but extractEvalArg() matches
//       raw text `/\beval\s/`, which does not match `eval.exe `, so the inner command is never parsed).
//       `.bat` is deliberately NOT stripped (ruling G1): `gh.bat pr merge` still resolves to
//       `cmd === "gh.bat"` and is not detected.
//
// Command parsing goes through the shared tokenizer (lib/parse-cmd: quote-aware segment split,
// then per-token unquoting) so a quoted commit message / heredoc that merely mentions "main"
// never false-triggers, while a quoted refspec (e.g. push origin "main") is still inspected (lessons 2026-06-28).
// Fail-open: any error (not a repo, detached HEAD, git unavailable) -> exit 0.

const { execSync } = require('node:child_process');
const { segments } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

const PROTECTED = new Set(['main', 'master']);

// gh global flags that consume the next token as a value (space-separated form), analogous to
// GIT_GLOBAL_VALUE_FLAGS in lib/git-parse.js but for gh's own argv shape.
// Correctness of the `gh pr merge` detection below depends on this set staying complete: a real gh
// global value-flag missing from it would shift the subcommand index and could let a `gh ... pr
// merge` slip through undetected. gh has no other such flag today (checked against gh's own
// --help); revisit this set if gh adds one.
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo']);

const GH_MERGE_MESSAGE =
  'BLOCKED: gh pr merge is not allowed here.\n' +
  'main は取り込み提案(PR)をユーザー自身がマージしたときだけ進みます。PR の URL を報告して、' +
  'マージはユーザーに任せてください（`gh pr view --web` で開けます）。';

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
      typeof verdict === 'string'
        ? `BLOCKED: ${verdict}.\n` +
            `このリポジトリは main に直接コミット／プッシュしません。作業用ブランチで作業し、` +
            `GitHub の取り込み提案(PR)経由で main に反映してください（例: git switch -c <topic>-$(date +%F) main）。`
        : verdict.message
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

// Return contract: null | string | { message: string }
//   string      … a plain reason (as before). The caller wraps it in the fixed git-path template
//                 (git 経路・文言不変).
//   { message } … a finished message, printed as-is (gh 経路).
function checkCommand(command) {
  for (const { cmd, args } of segments(command)) {
    if (cmd === 'gh') {
      const i = findSubcmdIndex(args, GH_GLOBAL_VALUE_FLAGS);
      if (i >= 0 && args[i] === 'pr') {
        const rest = args.slice(i + 1);
        const j = findSubcmdIndex(rest, GH_GLOBAL_VALUE_FLAGS);
        if (j >= 0 && rest[j] === 'merge') return { message: GH_MERGE_MESSAGE };
      }
      continue;
    }
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
