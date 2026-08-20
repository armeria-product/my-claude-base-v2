#!/usr/bin/env node
// PreToolUse hook: block destructive git operations
// Input:  Claude Code hook event JSON on stdin
// Output: if the command matches, write a message to stderr + exit 2 (block); otherwise exit 0
//
// Blocked operations (matches the destructive-operation policy in CLAUDE.md §1.5):
//   - force push (--force / -f / -fu / any combined short flag containing f, OR +refspec).
//     --force-with-lease is allowed.
//   - git reset --hard (discards worktree). mixed/soft reset and unstage are allowed
//   - git checkout that discards the worktree (checkout . / checkout -- <path> / checkout -f)
//   - git restore that discards the worktree (--staged only is allowed = safe unstage)
//   - git clean force variants (anything with -f, e.g. -fd / -fdx / -xf)
//   - branch -D or -Dr / -Dv / any combined short flag containing D (force delete).
//     -d (lowercase) is allowed.
//   - ANY `git ...` segment (regardless of subcommand -- deliberately not another enumeration)
//     whose stdout/stderr is redirected with a TRUNCATING redirect onto a path that already
//     exists as a regular file (e.g. `git show HEAD:a.js > a.js`, `git cat-file -p HEAD:a.js >
//     a.js`) -- this achieves the same worktree-discard effect as `checkout --`/`restore` without
//     going through a subcommand this file's enumeration above ever sees. Covered spellings: the
//     plain full-token forms (`>`, `1>`, `2>`, `10>`, `&>`); the explicit-clobber form `>|`
//     (rewritten to `>`); a redirect glued to the PRECEDING word (`a.js>a.js`) or to the
//     FOLLOWING word (`>a.js`); a redirect placed BEFORE the git invocation
//     (`> a.js git show HEAD:a.js`); the same git invocation reached through `bash -c "..."` /
//     `sh -c "..."` / `eval "..."` shell indirection; and a subshell-entry paren, BOTH glued and
//     space-separated before `git` (`(git show HEAD:a.js > a.js)`, `( git show HEAD:a.js >
//     a.js )`) -- the glued spelling's closing `)` lands on the redirect target too (parse-cmd's
//     tokenizer has no concept of `)` as a shell metacharacter), so that spelling is additionally
//     tried with trailing `)` characters stripped from the target, gated on the invocation having
//     actually been paren-entered so an ordinary filename that genuinely ends in `)` is never
//     misread. See normalizeRedirects()/resolveGitInvocation() below for how. Backslash escaping
//     is tracked per REAL BASH's rules on the OPERATOR side (deliberately not tokenize()'s naive,
//     non-backslash-aware scan -- see normalizeRedirects()'s own comment for exactly where the two
//     diverge; that divergence is safe for quote tracking, but NOT on the redirect TARGET side, see
//     the two backslash-target entries under "Not covered"), so a backslash-escaped quote (`git show HEAD:a.js \"
//     > a.js`) no longer desyncs the quote tracker and silently disables the match for the rest of
//     the string, and the symmetric false positive (`git commit -m "a \" > a.js x"`, one harmless
//     quoted argument in real bash) is also fixed. `>|` is rewritten to `>` even when it is
//     reached through nested `bash -c`/`sh -c`/`eval` indirection (parse-cmd's own recursion would
//     otherwise split on the bare `|` inside a de-quoted inner layer before this file ever gets a
//     turn at that layer). A quoted `>` (`git grep -n ">" f`, `git commit -m ">f"`) is correctly
//     NOT treated as a redirect. Exempt when the resolved path, taken RELATIVE TO THE WORKSPACE
//     ROOT (not the absolute filesystem path -- see checkGitRedirectOverwrite()), has a
//     `tmp`/`temp` path segment (CLAUDE.md §0 scratch area; real precedent:
//     tasks/journal/2026-08/03.md lines 748 and 888, an executor running `git show <rev>:<path> >
//     tmp/<name>.js` to diff an old revision). A target outside the workspace root gets no
//     exemption, and reparse-point redirection (junctions/symlinks) is resolved before the segment
//     test. When paren-entered, a glued closing `)` landing on the LAST word of the subcommand's
//     OWN argument list (not just the redirect target) is also stripped before the enumerated
//     push/reset/checkout/restore/clean/branch rules below run (`(git reset --hard)`,
//     `(git checkout .)`).
//
// Not covered (known, deliberate):
//   - append redirects (`>>`, `&>>`) -- appending does not discard existing content, so they are
//     intentionally excluded from the redirect-overwrite check above.
//   - anything routed through a PIPE: segments() splits `|` into independent segments and
//     discards pipeline structure, so the git origin of a downstream write is invisible to this
//     hook -- e.g. `git show HEAD:a.js | tee a.js`, `git archive HEAD | tar -x`, and the
//     PowerShell spellings `git show HEAD:a.js | Out-File a.js` / `| Set-Content a.js` (this hook
//     is registered for `Bash|PowerShell`).
//   - write-to-new-then-move (`git show HEAD:a.js > new && mv new a.js`) -- the `mv` half is
//     block-destructive-fs.js territory, not this file's.
//   - UNC redirect targets (`\\server\share\...` / `//server/share/...`) are skipped on purpose
//     before any filesystem call: fs.statSync() on an unreachable UNC host measured 17.6s (35.2s
//     for two unreachable hosts) against 42ms for a local target, and this hook runs before every
//     single Bash/PowerShell command -- an overwrite through a UNC target is never caught.
//   - a redirect target split across adjacent quoted/unquoted pieces (`git show HEAD:a.js > a"."js`
//     -- bash concatenates this into one word, `a.js`) is not resolved: tokenize() only treats a
//     quote as opening at token START, not wherever bash would, so this pass's own bash-accurate
//     mid-token quote tracking and tokenize()'s naive one disagree here and the target token keeps
//     its literal quote characters -- see normalizeRedirects()'s comment for the full account of
//     this divergence.
//   - a BACKSLASH-ESCAPED redirect target is not resolved either, in both directions (measured
//     against real bash by executing the command from a script file, so no argv transport could
//     alter the bytes; identical verdicts under all three commits of this change, i.e. neither
//     direction is new):
//       * false ALLOW -- `git show HEAD:a.js > dir/vic\tim.md` and `... > dir/vic\ tim.md` really
//         truncate `dir/victim.md` / `dir/vic tim.md` in bash (the backslash escapes the next
//         character), but this hook resolves the literal token and finds no such file.
//       * false DENY -- `git show HEAD:a.js > dir\victim.md`, the natural Windows spelling, is a
//         backslash ESCAPE to bash: it writes a junk file `dirvictim.md` and leaves
//         `dir/victim.md` untouched, yet this hook resolves it as a Windows path, finds the
//         existing file, and denies with a message asserting an overwrite that would not happen.
//     Target-side backslashes are therefore NOT bash-accurate even though the operator-side quote
//     scan is -- do not read the "per real bash" claim above as covering the target token.
//   - cd forms still unfollowed: pushd/popd, subshell scoping (`( cd x && ... )`), and a
//     variable-expanded destination (`cd $DIR`) -- cwd tracking below covers plain `cd <path>` and
//     `cd -` only, same known limit as lib/cmd-targets.js's precise model. In the OPPOSITE
//     direction, a `cd` reached through `bash -c "..."`/`sh -c "..."` indirection is WRONGLY
//     followed: parse-cmd's recursion surfaces it as an ordinary top-level segment, indistinguishable
//     from one typed directly, but in real bash it only moves the CHILD process's cwd and has zero
//     effect on the invoking shell, so tracking it desyncs `cur` from reality and can make a real
//     overwrite fail open. `eval "cd x"` is the opposite case and is correctly followed: `eval`
//     genuinely runs its argument in the current shell.
//   - a clustered short-flag spelling of `-c` (`bash -lc "..."`) is not recognized: parse-cmd's
//     extractShellCArg() requires `-c` as its own token, so the whole indirection payload is
//     unfollowed and never even reaches this hook's matcher -- pre-existing in lib/parse-cmd.js,
//     not this file's.
//   - subshell `( ... )` GROUPING stays entirely unfollowed even though a subshell-entry paren no
//     longer hides the `git` invocation, a glued closing paren on the redirect target, or (as of
//     this round) one glued to the last word of the subcommand's own arguments (see "Covered
//     spellings" above) -- those fixes are narrowly COMMAND IDENTIFICATION and TARGET/ARGUMENT
//     SPELLING, not comprehension of the grouping: a `cd` inside the parens leaking (or not) out
//     of them is not modeled, nesting (`((git show ...`) beyond what the leading-paren-strip
//     happens to also catch is not specifically handled, `{ ...; }` grouping is untouched, and
//     everything else already known-open in lib/parse-cmd.js's grouping gap -- see tasks/todo.md.
//   - everything else already known-open in lib/parse-cmd.js (newline-separated commands) -- see
//     tasks/todo.md.
//
// Chained commands (&& || ; |) are inspected segment by segment.
// Shell indirection (bash -c "...", sh -c "...", eval "...") is parsed recursively via the shared
// tokenizer; each segment's own redirect operators are normalized individually (see checkCommand()
// below) so an operator inside an indirection payload is marked at the quoting level it actually
// sits at, however deep the nesting.

const fs = require('node:fs');
const path = require('node:path');
const { segments, stripExeSuffix } = require('./lib/parse-cmd');
const { findSubcmdIndex } = require('./lib/git-parse');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let command = '';
  let startCwd = process.cwd();
  try {
    const payload = JSON.parse(data);
    command = payload.tool_input?.command || '';
    startCwd = payload.cwd || process.cwd();
  } catch {
    process.exit(0);
  }

  const verdict = checkCommand(command, startCwd);
  if (verdict) {
    console.error(
      `BLOCKED: Destructive git operation detected (${verdict}). Confirm with user before proceeding.`
    );
    process.exit(2);
  }
  process.exit(0);
});

// Quote-aware pre-tokenization normalization pass. The safety property this pass rests on is
// agreement with REAL BASH's quoting/escaping rules -- NOT agreement with segments()/tokenize()'s
// own (deliberately naive) quote scan, which an earlier version of this comment claimed as the
// property instead. That was wrong: tokenize() finds the next literal quote character with no
// backslash-escape awareness at all, and only ever treats a quote as quote-OPENING when it is the
// very first character of a token -- bash does neither. Sticking to tokenize()'s naive rules would
// have kept this pass in lockstep with tokenize() but out of step with what bash actually does,
// which is what matters: the question this hook answers is "does a real shell interpret this as a
// truncating redirect", not "does tokenize() happen to isolate a bare `>` token". Known,
// deliberate divergences from tokenize(), and why each is safe:
//   - Backslash escaping: this pass now tracks it (see the backslash branch below); tokenize()
//     never does. When they disagree about whether a quote is open, this pass's answer is the
//     bash-correct one, and REDIR_TRUNC_TOKEN only ever matches an OP_MARK-wrapped token this pass
//     itself emitted -- tokenize()'s own, separately-wrong quote handling downstream can misplace
//     quote characters or mis-split tokens, but it can never CREATE a new OP_MARK, so it can never
//     turn quoted (inert) text into a false redirect match. The worst it can do is leave stray
//     quote characters inside argument/target text tokenize() failed to strip (see the next
//     point) -- a possible false ALLOW on a target-spelling mismatch. That is the direction for
//     the QUOTE divergence specifically; it is NOT a blanket "never a false DENY" guarantee for
//     target spellings in general, which the natural Windows spelling `> dir\victim.md` falsifies:
//     bash reads the backslash as an escape and writes `dirvictim.md`, while this hook resolves it
//     as a Windows path to the existing `dir/victim.md` and denies an overwrite that would not
//     happen. Both backslash-target directions are listed under "Not covered" in the header.
//   - Mid-token quote opening: bash (and this pass) treat a `"`/`'` as significant wherever it
//     appears; tokenize() only treats one as quote-opening at token START. A split-quoted target
//     like `CLAUDE"."md` (bash concatenates adjacent quoted/unquoted pieces with no separating
//     whitespace into ONE word, `CLAUDE.md`) is NOT unquoted by tokenize() -- the whole thing
//     survives as one opaque token, quote characters and all -- so resolveTargetOverwrite() looks
//     up a file literally named `CLAUDE"."md`, which does not exist, and fails open. Disclosed,
//     not fixed (see the header's "Not covered" list).
//
// Outside quotes, and inside double quotes: a backslash escapes the very next character -- both
// characters are copied through untouched, quote state is not changed, and the escaped character
// is never itself evaluated as a quote delimiter or a redirect operator. This is a deliberate
// simplification of bash's own double-quote rule (which only treats `\$`, `` \` ``, `\"`, `\\`,
// and `\<newline>` specially, leaving every other `\X` as two literal characters) -- but for this
// pass's only two jobs, deciding where a quote closes and whether a `>`-family character is live,
// the simplification is exact: a `>` is never one of bash's five specially-escaped characters, so
// whether THIS pass treats `\>` inside double quotes as "escaped, skip both" or "process
// normally" makes no difference (content inside quotes is already excluded from operator-matching
// either way); the only place the distinction could matter is a backslash immediately before a
// quote character, and there this pass's simplified rule and bash's real rule agree (`\"` is
// escaped in both). Inside single quotes a backslash is a literal character, per bash -- nothing
// is escapable there, not even another single quote -- so this branch is gated on `quote !== "'"`.
// Regression this closes (verified against 29f4be8, all three previously exit=2, now exit=0
// without this branch): an odd backslash-quote anywhere in the command (`\"`, `\'`, or one glued
// to other text, e.g. `x\"y`) used to enter quote mode on the bare `"`/`'` with no backslash
// awareness at all, silently swallowing every later `>` as "inside quotes" for the rest of the
// string. Same root cause, opposite direction: `git commit -m "a \" > CLAUDE.md x"` was a false
// positive (denied) before this branch -- bash keeps the whole thing one quoted argument (the `\"`
// is an escaped literal quote, not a close), so the `>` inside is never live; this pass now agrees
// and never marks it.
//
// `>|` (bash's explicit-clobber operator) is rewritten to `>` UNCONDITIONALLY -- including inside
// a quoted region, which every other rewrite in this pass deliberately does NOT touch. This is the
// one exception, and it exists for a structural reason none of the others share: lib/parse-cmd.js
// splits on a bare `|` not only at this pass's own top level but again, silently, INSIDE its own
// recursion into `bash -c`/`sh -c`/`eval` payloads -- each recursion step de-quotes one more layer
// before this pass ever gets a per-segment turn at that layer (see checkCommand()'s level-2 pass),
// so a `>|` that looks safely quoted from this pass's own vantage point can still end up bare, and
// still get split on, one or more recursion steps later, entirely inside lib/parse-cmd.js where
// this file has no hook to intervene. The only way to guarantee the dangerous `|` byte is gone
// before ANY of that recursion runs, at any nesting depth, is to remove it from the raw text once,
// here, before segments() is ever called. This is safe to do even inside a quoted region: the
// OP_MARK wrapper (and the operator's redirect meaning) is still only ever added when OUTSIDE a
// quote, so a quoted `>|` becomes a quoted, UNMARKED `>` -- still inert, still not a redirect
// (verified: `git commit -m "note >| x"` stays allow) -- and the normalized string is never
// executed, only ever inspected by this hook's own analysis, so a plain textual substitution
// inside otherwise-inert quoted data (even single-quoted data, where bash would treat `>|` as 100%
// literal) is harmless for that same reason.
//
// Every operator this pass emits outside a quote -- the plain full-token forms (`>`, `1>`, `2>`,
// `10>`, `&>`), `>>`/`&>>`, and the now-unconditionally-rewritten `>|` -- is wrapped in OP_MARK (an
// ASCII 0x01 control byte). checkCommand() strips any OP_MARK byte already present in the
// INCOMING command once, at entry, before this pass ever runs (see its own comment) specifically
// so that invariant -- OP_MARK only ever appears here because THIS pass put it there -- actually
// holds, rather than being an assumption this file asserts but never enforces.
//
// IDEMPOTENT by construction: an already-OP_MARK-wrapped span is copied through untouched (same
// pass-through treatment as a quoted region), never re-scanned for operators. This matters because
// checkCommand() below calls this function TWICE at two different levels on overlapping text (once
// over the whole outer command, once again over each segment's own `raw`) -- without idempotency,
// a second pass would see the bare `>` sitting between two OP_MARK bytes from the first pass and
// wrap it AGAIN, corrupting the token into multiple pieces.
const OP_MARK = '\x01';

function normalizeRedirects(command) {
  let out = '';
  let quote = null;
  let inMark = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (inMark) {
      out += ch;
      if (ch === OP_MARK) inMark = false;
      i++;
      continue;
    }
    if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
      out += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === '>' && command[i + 1] === '|') {
      out += quote ? '>' : ` ${OP_MARK}>${OP_MARK} `;
      i += 2;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === OP_MARK) {
      inMark = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '&' && command[i + 1] === '>') {
      const doubled = command[i + 2] === '>';
      out += doubled ? ` ${OP_MARK}&>>${OP_MARK} ` : ` ${OP_MARK}&>${OP_MARK} `;
      i += doubled ? 3 : 2;
      continue;
    }
    if (ch === '>' || (ch >= '0' && ch <= '9')) {
      let j = i;
      while (j < command.length && command[j] >= '0' && command[j] <= '9') j++;
      if (command[j] === '>') {
        const doubled = command[j + 1] === '>';
        const end = doubled ? j + 2 : j + 1;
        out += ` ${OP_MARK}${command.slice(i, end)}${OP_MARK} `;
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// Full-token redirect operators, matched only in their OP_MARK-wrapped form (see
// normalizeRedirects()). Reachable only as standalone tokens: normalizeRedirects() guarantees
// every operator it emits is space-separated, so an attached-form regex (`>path` glued to its
// target) is unreachable and deliberately not kept as dead code.
const REDIR_TRUNC_TOKEN = new RegExp(`^${OP_MARK}(?:\\d*>|&>)${OP_MARK}$`);
const REDIR_APPEND_TOKEN = new RegExp(`^${OP_MARK}(?:\\d*>>|&>>)${OP_MARK}$`);

function isRedirectOperatorToken(t) {
  return REDIR_TRUNC_TOKEN.test(t) || REDIR_APPEND_TOKEN.test(t);
}

// Remove every redirect-operator+target pair from a word list (used to find the real command word
// and the real `cd` destination without a stray redirect token being mistaken for either).
function stripRedirectPairs(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (isRedirectOperatorToken(words[i])) {
      i += 2; // operator + its target token (if any)
      continue;
    }
    out.push(words[i]);
    i++;
  }
  return out;
}

const CMD_WRAPPERS = new Set(['sudo', 'command', 'env']);

function basenameOf(token) {
  return token.replace(/^\\/, '').split('/').pop().toLowerCase();
}

// A `git` invocation is normally cmd === 'git' directly -- parse-cmd.js's own segment
// normalization already resolves wrapper prefixes / basename / suffix for the FIRST token of a
// segment. But when the segment's first token is itself a leading redirect (`> f git show ...`),
// parse-cmd never gets the chance to apply that resolution to the real command word, since it
// sits somewhere inside `args` instead of in `cmd`. Re-derive it here: strip every redirect pair
// from [cmd, ...args], then apply the same basename/suffix/wrapper resolution parse-cmd.js's own
// segment normalizer applies to `cmd`, to the first surviving word. Returns { gitArgs: null } when
// the segment is not a git invocation, otherwise { gitArgs: <argv after git>, parenEntered }.
//
// Subshell-entry parens are also stripped from a candidate word before it is compared -- same
// precedent as lib/parse-cmd.js's CWD_BUILTINS candidate check (`cwdBuiltinCandidate =
// strippedBasename.replace(/^\(+/, '')`), applied here to the command word itself. parse-cmd
// glues a leading `(` onto the next token when there is no space (`(git` -> cmd:'(git') and
// leaves it as its own separate token when there is one (`( git` -> cmd:'(', args[0]:'git'), so a
// word that is nothing but `(` characters is skipped outright (it is not a command, wrapper, or
// git) and a word with a `(` glued to real content has the paren peeled before comparison. This
// only fixes COMMAND IDENTIFICATION through a subshell entry -- it does not make `( ... )`
// grouping understood; subshell scoping stays exactly as unfollowed as before (see header).
//
// `parenEntered` (true iff ANY word inspected on the way to `git` -- a bare `(` token, a wrapper,
// or `git` itself -- started with `(`) is threaded out to the caller rather than acted on here:
// checkGitRedirectOverwrite() uses it to ALSO try the redirect target with trailing `)` chars
// stripped (a real bash subshell's closing paren can land glued onto the target when there is no
// space, e.g. `(git show HEAD:a.js > a.js)` -- parse-cmd's tokenizer has no concept of `)` as a
// shell metacharacter, so it stays part of the target token). Gating that on parenEntered, rather
// than unconditionally stripping a trailing `)` from every target, keeps a genuine filename that
// ends in `)` (no subshell involved) from being misread.
function resolveGitInvocation(cmd, args) {
  const words = stripRedirectPairs([cmd, ...args]);
  let idx = 0;
  let parenEntered = false;
  while (idx < words.length) {
    if (words[idx].startsWith('(')) parenEntered = true;
    if (/^\(+$/.test(words[idx])) { idx++; continue; } // bare subshell-entry '(' token(s)
    const candidate = stripExeSuffix(basenameOf(words[idx])).replace(/^\(+/, '');
    if (!CMD_WRAPPERS.has(candidate)) break;
    idx++;
  }
  if (idx >= words.length) return { gitArgs: null, parenEntered: false };
  const candidate = stripExeSuffix(basenameOf(words[idx])).replace(/^\(+/, '');
  if (candidate !== 'git') return { gitArgs: null, parenEntered: false };
  return { gitArgs: words.slice(idx + 1), parenEntered };
}

// \\server\share\... or //server/share/... -- checked on the raw target token, before any
// filesystem call (see the UNC comment at the call site for why).
function looksLikeUncPath(t) {
  return /^(\\\\|\/\/)[^\\/]+[\\/]/.test(t);
}

// Single-candidate worktree-overwrite check, factored out of checkGitRedirectOverwrite() so the
// UNC skip / realpath / workspace-relative tmp-exemption logic exists in exactly one place --
// checkGitRedirectOverwrite() calls this once for the literal target and, when parenEntered,
// again for the trailing-`)`-stripped candidate, rather than duplicating any of this. Returns a
// deny message when `target` already exists as a regular file outside the tmp/temp exemption,
// else null (including on any fs error -- fail-open, consistent with the other hooks here).
function resolveTargetOverwrite(target, cur, root) {
  // UNC targets are skipped before any filesystem call: fs.statSync() on an unreachable UNC
  // host measured 17.6s (35.2s for two), and this hook runs before every single Bash/
  // PowerShell command -- a real UNC overwrite is a known, disclosed gap (see header).
  if (looksLikeUncPath(target)) return null;

  const resolved = path.resolve(cur, target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // Resolve directory junctions/symlinks before the tmp/temp segment test: a junction placed
  // under tmp/ (no admin rights needed on NTFS) can re-export an arbitrary file into the exempt
  // namespace while the real write lands wherever the junction actually points. realpathSync()
  // requires an existing path; `resolved` is known to exist (statSync above confirmed it), but
  // `root` is not guaranteed to under every caller, so its call is independently guarded.
  let realResolved = resolved;
  try { realResolved = fs.realpathSync(resolved); } catch { /* fall back to unresolved */ }
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* fall back to unresolved */ }

  const rel = path.relative(realRoot, realResolved);
  const insideRoot = rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  if (insideRoot) {
    const segs = rel.split(path.sep).map((s) => s.toLowerCase());
    if (segs.includes('tmp') || segs.includes('temp')) return null;
  }

  return `redirect overwrites existing file: ${resolved} (dump to a tmp/ path instead)`;
}

// Deny when a `git ...` segment's redirect target already exists as a regular file (worktree
// overwrite). `words` is the segment's full [cmd, ...args] (a leading redirect can place the
// target before `git` ever appears -- see resolveGitInvocation()). `cur` is the running cwd
// tracked by the caller, used to resolve a relative target. `root` is the fixed workspace root
// (CLAUDE_PROJECT_DIR, falling back to the payload's own starting cwd), used only for
// resolveTargetOverwrite()'s tmp/temp exemption, never for resolving the target itself.
// `parenEntered` (from resolveGitInvocation()) additionally tries the target with trailing `)`
// characters stripped: a real bash subshell's closing paren can land glued onto the target when
// there is no space (`(git show HEAD:a.js > a.js)`), and parse-cmd's tokenizer has no concept of
// `)` as a shell metacharacter, so it stays part of the target token otherwise -- gated on
// parenEntered so an ordinary (non-subshell) filename that genuinely ends in `)` is never
// misread. Deny if EITHER spelling resolves to an existing regular file.
function checkGitRedirectOverwrite(words, cur, root, parenEntered) {
  for (let i = 0; i < words.length; i++) {
    if (!REDIR_TRUNC_TOKEN.test(words[i])) continue;
    const target = words[i + 1];
    i++;
    if (!target) continue;

    const verdict = resolveTargetOverwrite(target, cur, root);
    if (verdict) return verdict;

    if (parenEntered && target.endsWith(')')) {
      const stripped = target.replace(/\)+$/, '');
      if (stripped) {
        const parenVerdict = resolveTargetOverwrite(stripped, cur, root);
        if (parenVerdict) return parenVerdict;
      }
    }
  }
  return null;
}

function checkCommand(rawCommand, startCwd) {
  let cur = startCwd;
  let prevCur = startCwd;
  const root = process.env.CLAUDE_PROJECT_DIR || startCwd;

  // Strip every literal OP_MARK (0x01) byte out of the INCOMING command once, here, before either
  // normalization pass ever runs. normalizeRedirects()'s own idempotency, and every REDIR_*_TOKEN
  // match downstream, both rest on OP_MARK meaning "this pass put it here" -- an invariant this
  // file used to assert in a comment but never actually enforce. A command that happens to contain
  // a raw 0x01 byte could plant a stray, unbalanced mark that flips normalizeRedirects()'s inMark
  // state on and never back off, silently disabling every operator match for the rest of the
  // string (regression, verified against 29f4be8: a literal 0x01 byte placed before a later real
  // `>` made that `>` unmarked and the command allow when it must deny). Stripped from the RAW
  // command exactly once, at entry: every OP_MARK byte either normalization pass ever sees from
  // this point on is guaranteed to be one THIS hook emitted. Do not strip again at level 2
  // (segments(normalizeRedirects(seg.raw)) below) -- that text legitimately carries the marks
  // level 1 already emitted, and stripping there would undo the marking this hook depends on.
  const command = rawCommand.split(OP_MARK).join('');

  // Normalized at TWO levels, and both levels are necessary:
  //
  // 1. The outer segments(normalizeRedirects(command)) call. Splitting on the UNNORMALIZED
  //    command first is unsafe: `>|` (finding 1's explicit-clobber operator) contains a bare `|`
  //    character, and splitOnQuoteAwareOperators() (lib/parse-cmd.js) splits on any unquoted bare
  //    `|` BEFORE this file's matcher ever runs -- `git show HEAD:a.js >|a.js` would silently
  //    split into two segments (`git show HEAD:a.js >` and `a.js`) and the redirect would vanish
  //    entirely. Normalizing first rewrites `>|` to `>` (removing the `|`) before that split ever
  //    happens, so the outer split only ever sees a real, intentional `&&`/`||`/`;`/`|`.
  //
  // 2. The PER-SEGMENT segments(normalizeRedirects(seg.raw))[0] re-normalization inside the loop.
  //    segments() (lib/parse-cmd.js) recurses into `bash -c "..."` / `sh -c "..."` / `eval "..."`
  //    payloads on its own, and each recursion step de-quotes one layer of the inner text. Level 1
  //    above normalizes the OUTER command once, so an inner payload's `>` -- still sitting inside
  //    outer quotes at that point -- is correctly left untouched by normalizeRedirects()'s quote
  //    handling. But that inner text never gets a pass of its own after parse-cmd unwraps it via
  //    recursion, so its `>` would reach REDIR_TRUNC_TOKEN unmarked and could never match (the
  //    regression this two-level design exists to fix: `bash -c "git show HEAD:a.js > a.js"`
  //    silently stopped being caught when only level 1 existed). Re-normalizing each segment's own
  //    `raw` field applies OP_MARK at whatever quoting level that segment actually sits at,
  //    however deep the indirection nests: a recursively produced inner segment's `raw` is already
  //    the de-quoted inner text at ITS level, so its own operators are bare and get marked here;
  //    an outer wrapper segment's `raw` still has its payload quoted, so normalizeRedirects()
  //    correctly leaves it untouched (that layer was already handled by level 1, and the
  //    recursively produced segment is visited on its own turn through this same loop). Only [0]
  //    of the re-parse is taken: any further entries are that segment's own indirection, which the
  //    outer segments() call above already yields as separate top-level iterations -- consuming
  //    them here too would double-apply cd tracking and re-check the same inner git invocation
  //    twice.
  //
  // Both levels can run over already-marked text (e.g. level 2 re-normalizing a segment whose
  // operators level 1 already marked) without corrupting anything, because normalizeRedirects() is
  // idempotent by construction (see its own comment) -- an already-OP_MARK-wrapped span is passed
  // through untouched rather than re-wrapped. normalizeRedirects() also cannot itself introduce a
  // NEW &&/||/;/bare-| split (beyond the `|` it deliberately removes via the `>|` rewrite): every
  // other branch only inserts whitespace/OP_MARK around existing `>`/digit/`&` characters, so
  // segments(normalizeRedirects(seg.raw)) can never yield more than one top-level part for an
  // already-single segment's raw text.
  for (const seg of segments(normalizeRedirects(command))) {
    const { cmd, args } = segments(normalizeRedirects(seg.raw))[0] || seg;

    // cd tracking: the destination is taken from the segment's own redirect-stripped word list
    // (so a redirect glued right after `cd`, e.g. `cd >/dev/null .`, can never be mistaken for
    // the destination) and is only followed when it resolves to an existing directory, mirroring
    // a real shell: a `cd` that fails to change directory leaves the shell exactly where it was,
    // it does not silently "move" to a bogus location. `cd -` returns to the previously tracked
    // cwd. A bare `cd` (no destination) is left alone.
    if (cmd === 'cd') {
      const words = stripRedirectPairs(args);
      const dest = words.find((a) => a === '-' || !a.startsWith('-'));
      if (dest === '-') {
        const next = prevCur;
        prevCur = cur;
        cur = next;
      } else if (dest) {
        const resolved = path.resolve(cur, dest);
        let isDir = false;
        try {
          isDir = fs.statSync(resolved).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          prevCur = cur;
          cur = resolved;
        }
      }
    }

    const { gitArgs: rawGitArgs, parenEntered } = resolveGitInvocation(cmd, args);
    if (rawGitArgs === null) continue;

    const redirectVerdict = checkGitRedirectOverwrite([cmd, ...args], cur, root, parenEntered);
    if (redirectVerdict) return redirectVerdict;

    // When paren-entered, a glued closing `)` can also land on the LAST word of the subcommand's
    // own argv -- `(git reset --hard)` -> gitArgs ends in `'--hard)'`, `(git checkout .)` -> ends
    // in `'.)'` -- corrupting the exact-match comparisons the enumerated rules below rely on
    // (`flags.includes('--hard')`, `rest.includes('.')`), so those two stayed allowed even though
    // resolveGitInvocation() already correctly identifies `git` here. Mirrors the identical,
    // narrower fix already applied to the redirect target in checkGitRedirectOverwrite() -- gated
    // strictly on parenEntered so an ordinary trailing argument that genuinely ends in `)` (not
    // through a subshell) is never touched, and only the LAST word is ever touched (the one
    // position a glued closing paren can land on). When the paren-strip would produce an empty
    // string (the spaced form `( git reset --hard )` tokenizes `)` as its own separate LAST word,
    // stripping trailing `)` from it yields `''`), the original word is left alone -- that
    // spelling's `--hard`/`.` are already clean one position earlier and need no fix.
    let gitArgs = rawGitArgs;
    if (parenEntered && gitArgs.length > 0) {
      const lastWord = gitArgs[gitArgs.length - 1];
      const strippedLastWord = lastWord.replace(/\)+$/, '');
      if (strippedLastWord && strippedLastWord !== lastWord) {
        gitArgs = gitArgs.slice(0, -1).concat(strippedLastWord);
      }
    }

    // Determine the git subcommand, skipping global value-consuming flags
    const subIdx = findSubcmdIndex(gitArgs);
    if (subIdx === -1) continue;
    const sub = gitArgs[subIdx];
    const rest = gitArgs.slice(subIdx + 1);
    // Flags that appear anywhere in the argument list
    const flags = gitArgs.filter((a) => a.startsWith('-'));

    // Helper: does any short-flag bundle contain character c (case-sensitive)?
    // Matches -f, -rf, -fu, -Drf etc.  Ignores long flags (--foo).
    const hasShortFlag = (c) => flags.some((f) => /^-[a-zA-Z]/.test(f) && !f.startsWith('--') && f.includes(c));

    // --- push ---------------------------------------------------------------
    if (sub === 'push') {
      // --force-with-lease alone is allowed, but an explicit --force / -f / +refspec is a real
      // force push and must be blocked even when --force-with-lease is also present: git honors
      // whichever comes last, so `push --force-with-lease --force` is a full force push. These
      // checks don't false-match --force-with-lease itself (includes('--force') is an exact match;
      // hasShortFlag skips long -- flags).
      const longForce = flags.includes('--force');
      // short flag -f (alone or combined: -fu, -rf, etc.)
      const shortForce = hasShortFlag('f');
      // +refspec:  git push origin +main  or  git push origin +refs/heads/main:refs/heads/main
      const refspecForce = rest.some((a) => a.startsWith('+'));
      if (longForce || shortForce || refspecForce) return 'force push';
    }

    // --- reset --------------------------------------------------------------
    if (sub === 'reset' && flags.includes('--hard')) return 'reset --hard';

    // --- checkout -----------------------------------------------------------
    if (sub === 'checkout') {
      if (
        rest.includes('.') ||
        rest.includes('--') ||
        hasShortFlag('f')
      ) return 'checkout discards worktree';
    }

    // --- restore ------------------------------------------------------------
    if (sub === 'restore') {
      const hasStaged = flags.includes('--staged');
      if (flags.includes('--worktree') || !hasStaged) return 'restore discards worktree';
    }

    // --- clean --------------------------------------------------------------
    if (sub === 'clean') {
      if (hasShortFlag('f') || flags.includes('--force')) return 'clean -f';
    }

    // --- branch -------------------------------------------------------------
    if (sub === 'branch') {
      // -D (uppercase) = force delete. -d (lowercase) is safe.
      if (hasShortFlag('D')) return 'branch -D';
    }
  }
  return null;
}
