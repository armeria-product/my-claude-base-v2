// Shared command tokenizer for destructive-operation guards.
// Normalizes a shell command string into an array of { cmd, args, raw } segments
// so callers can perform uniform guard checks regardless of:
//   - leading env-var assignments  (FOO=1 rm ...)
//   - sudo / command / env / backslash prefix  (\rm, command rm, env rm)
//   - absolute-path invocation  (/bin/rm → rm)
//   - shell indirection  (bash -c "...", sh -c '...', eval "...")
//
// Usage:
//   const { segments } = require('./lib/parse-cmd');
//   for (const { cmd, args } of segments(command)) { ... }
//
// Each returned object:
//   cmd   – normalized command name (basename, lower-case, wrapper stripped; trailing
//           .exe/.cmd/.com/.ps1 is stripped EXCEPT when the name (optionally preceded by
//           subshell-entry `(`s) is a CWD_BUILTIN — cd/pushd/popd stay suffixed, e.g. `cd.exe`
//           normalizes to `cd.exe`, not `cd`. A consumer that detects a cd via `cmd === 'cd'`
//           will therefore under-detect a suffixed form by design — see the CWD_BUILTINS
//           comment below.)
//   args  – token array after cmd (flags + targets, no env-vars; outer quotes stripped, content kept)
//   raw   – trimmed segment string after heredoc-strip (quotes kept as-is)

'use strict';

// Strip a trailing Windows executable suffix (.exe/.cmd/.com/.ps1 — .bat is deliberately left
// alone, ruling G1) from an already-lower-cased basename. Shared so every basename resolver in
// this module (and, via the export, in other guards) treats `git.exe`/`rm.exe`/`git.com`/
// `git.ps1`/etc. the same as the bare name. `.com`/`.ps1` added in plan Batch D (rank 4) — same
// single-strip behavior as the pre-existing `.exe`/`.cmd` pair, no repeated-stripping loop (see
// the known-residual-gaps note below for why a loop is deliberately not added).
function stripExeSuffix(basename) {
  return basename.replace(/\.(exe|cmd|com|ps1)$/, '');
}

// Strip a leading heredoc body so its contents don't trigger false positives.
// Example: cat >> file <<'EOF'\n... clean -f ...\nEOF  →  cat >> file <<HEREDOC
function stripHeredocs(s) {
  return s.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '<<HEREDOC');
}

// Replace quoted string contents with placeholders.
// Keeps commit messages, file contents etc. from matching keywords.
function stripQuotedContent(s) {
  return s.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

// Split on the outermost &&/||/;/| operators only, leaving operators that
// appear inside a quoted string untouched (e.g. "a; rm -rf src" is one segment).
function splitOnQuoteAwareOperators(s) {
  const parts = [];
  let cur = '';
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '&' && s[i + 1] === '&') { parts.push(cur); cur = ''; i += 2; continue; }
    if (ch === '|' && s[i + 1] === '|') { parts.push(cur); cur = ''; i += 2; continue; }
    if (ch === ';' || ch === '|') { parts.push(cur); cur = ''; i += 1; continue; }
    cur += ch;
    i++;
  }
  parts.push(cur);
  return parts;
}

/**
 * Split a compound command (&&, ||, ;, |) into individual segments,
 * apply heredoc stripping, then normalize each segment into
 * { cmd, args, raw }.
 *
 * @param {string} command  raw command string from hook event
 * @returns {{ cmd: string, args: string[], raw: string }[]}
 */
function segments(command) {
  const noHeredoc = stripHeredocs(command);
  const parts = splitOnQuoteAwareOperators(noHeredoc).map((s) => s.trim()).filter(Boolean);
  const result = [];
  for (const part of parts) {
    result.push(...normalizeSegment(part));
  }
  return result;
}

// Strip one layer of matching outer quotes from a token, preserving the content.
// rm "D:/tmp" -> rm D:/tmp ; git push origin "dev:main" -> git push origin dev:main
function unquoteToken(t) {
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return t.slice(1, -1);
    }
  }
  return t;
}

// A child process — which is all `cd.exe`/`pushd.exe`/`popd.exe` could ever be, even if such a
// file existed — can never change its parent shell's cwd; cd/pushd/popd only work at all because
// the shell runs them as builtins in its own process. So suffix-stripping these names would be
// wrong even if a real `cd.exe` shim showed up on PATH tomorrow: invoking it as a subprocess is a
// cwd no-op for the parent shell regardless. (Today there is a second, weaker reason too — no
// such executable exists, so a real shell asked to run `cd.exe` fails with "command not found",
// also a no-op, but for a PATH-dependent reason a future environment could remove. The
// child-process reason above is the one this exception actually rests on.) Suffix-stripping would
// make lib/cmd-targets.js's exact-match cwd tracking (`case 'cd':`) and its liberal cd/pushd
// tracking used by protected-control checks believe a no-op invocation moved the cwd — see the
// comment at the strip site below for the bypasses this produced, both in the plain form and, in
// a later review round, in the parenthesized/subshell-entry form.
//
// Scope of this exception — exactly: a CWD_BUILTINS name, optionally preceded by one or more
// literal `(` (subshell entry, e.g. `(cd.exe`, `((pushd.exe`), with a trailing
// `.exe`/`.cmd`/`.com`/`.ps1` suffix. It is NOT a general fix for the cwd-desync class and must
// not be read as closing it:
// bare `env cd ..`/`sudo cd ..`/`command cd ..` were always tracked correctly (the wrapper-prefix
// peel in step 2 below has always recognized the bare wrapper spellings, leaving `cd` as the
// next token, unaffected by anything in this comment). The gap this exception does NOT close is
// the wrapper-suffixed form — `sudo.exe cd ..`/`env.exe cd ..`/`command.exe cd ..` — which
// previously fell through the peel in step 2 as an unrecognized-wrapper opaque command entirely
// (the L20 sudo.exe/env.exe bug — see plan Batch C), not as a no-op-treated-as-a-move case; step
// 2's suffix-aware compare (added in Batch C) now peels these too, so once peeled the `cd` token
// reaches this exception exactly like the bare form. `popd` is included even though no consumer
// currently tracks it, as the same child-process reasoning applies.
const CWD_BUILTINS = new Set(['cd', 'pushd', 'popd']);

/**
 * Normalize one segment into one-or-more { cmd, args, raw } objects.
 * For bash/sh/eval indirection the inner command string is parsed recursively.
 */
function normalizeSegment(seg) {
  const tokens = tokenize(seg).map(unquoteToken);
  if (tokens.length === 0) return [];

  let idx = 0;

  // 1. Skip leading env-var assignments  (KEY=value KEY2=value2 ...)
  while (idx < tokens.length && /^\w+=/.test(tokens[idx])) idx++;

  // 2. Strip wrapper prefixes: sudo, command, env, backslash. Compared after suffix-stripping
  //    (reusing the same stripExeSuffix() used for the final cmd basename below) so
  //    `sudo.exe`/`env.exe`/`command.exe` peel exactly like their bare forms — previously only
  //    the bare spellings were recognized here, so a suffixed wrapper token fell through to step
  //    3 unstripped-as-a-wrapper and became the opaque `cmd` itself (e.g. `sudo.exe git push
  //    --force origin main` parsed as cmd:'sudo', args:['git','push',...] — invisible to every
  //    guard that dispatches on `cmd === 'git'`/`cmd === 'gh'`/etc., and to cmd-targets.js's
  //    Duty 2 write-target extraction). See plan Batch C.
  while (idx < tokens.length) {
    const t = tokens[idx];
    const stripped = stripExeSuffix(t);
    if (t === 'sudo' || t === 'command' || t === 'env' ||
        stripped === 'sudo' || stripped === 'command' || stripped === 'env') { idx++; continue; }
    if (t === '\\') { idx++; continue; }
    break;
  }

  if (idx >= tokens.length) return [];

  // 3. Resolve command to basename (handles /bin/rm, /usr/bin/env, etc.), then strip a
  //    trailing Windows executable suffix so `git.exe`/`gh.cmd`/`git.com`/`git.ps1`/etc. match
  //    the same guards as the bare command name. Only `.exe`, `.cmd`, `.com`, and `.ps1` are
  //    stripped — `.bat` is deliberately left alone (ruling G1) as a boundary marker for the
  //    unhandled case.
  //
  //    Exception: a name in CWD_BUILTINS (`cd`/`pushd`/`popd`) is NOT suffix-stripped, even if
  //    it resolves to e.g. `cd.exe` — see the CWD_BUILTINS comment above. The membership check
  //    itself is done against the suffix-stripped name with any leading subshell-entry `(`s also
  //    stripped (`cwdBuiltinCandidate` below), so the exception applies uniformly whether the
  //    builtin appears bare (`cd.exe`) or subshell-glued (`(cd.exe`, `((pushd.exe`) — this is a
  //    single general rule, not a list of paren-prefixed spellings, so it does not need a new
  //    entry for every possible amount of `(` nesting. A bare `(` with no attached builtin name
  //    (e.g. the space-separated `( cd.exe`, where `(` and `cd.exe` tokenize as two separate
  //    words) is unaffected by this exception — it is a different, already-opaque command name
  //    and is handled (or not) by whatever downstream logic sees an unrecognized `cmd === '('`.
  //
  //    Concretely, without this exception `cd.exe sub; cp a.txt other/b.txt` made
  //    cmd-targets.js's cwd tracker believe cwd moved to `sub/` when a real shell never left the
  //    top level, and `cd .claude; cd.exe ..; echo x > .fable-status` made it believe cwd left
  //    `.claude` when a real shell never did. Both were found in review. A later review round
  //    found the same two bypasses again in the parenthesized/subshell-entry form specifically —
  //    the paren-stripped-but-not-suffix-stripped membership check above closes those too (pinned
  //    alongside the same two samples). Backlog note: today, the plain (non-parenthesized) form's
  //    protected-control checks also compare both precise and liberal target lists; this
  //    exception is what carries the parenthesized form too.
  //
  //    This strip is NOT an exhaustive fix for suffixed commands — only the plain
  //    `<basename>.exe`/`<basename>.cmd`/`<basename>.com`/`<basename>.ps1` case (optionally
  //    subshell-`(`-prefixed; `.com`/`.ps1` added in plan Batch D, rank 4 — same L22 bypass class
  //    as the `.exe`/`.cmd` pair, e.g. `git.com push --force origin main` previously reached
  //    every guard unstripped). Known residual gaps (see plan Table C), plus further out-of-scope
  //    gap classes surfaced in review, that this does NOT fix:
  //      - an unquoted path containing spaces (e.g. `C:/Program Files/Git/bin/git.exe push`
  //        resolves to `cmd === 'program'`, not `git`)
  //      - a backslash-separated path (this function only splits on `/`, not `\`)
  //      - `eval.exe "<inner>"` (the basename strips to `eval`, but extractEvalArg() below
  //        matches the raw text `/\beval\s/`, which does not match `eval.exe `, so the inner
  //        command is never parsed and the whole call is treated as an opaque command)
  //      - `.bat` is deliberately left untouched (ruling G1) — not stripped, not treated as an
  //        error, simply out of scope
  //      - a double suffix (e.g. `git.exe.cmd`, `git.exe.ps1`) strips only the outermost suffix,
  //        leaving `git.exe` — deliberately NOT a repeated-stripping loop: the CWD_BUILTINS
  //        membership check above (`cwdBuiltinCandidate`) only ever single-strips before testing
  //        membership, so a loop would let a doubly-suffixed cwd builtin (e.g. `cd.exe.cmd`)
  //        strip all the way down to the bare `cd` and be treated as a real cwd move — reopening
  //        the fake-cwd-move class that `lock-cd-exe-fake-cwd-move-escape` /
  //        `state-cd-exe-fake-cwd-move-defeat` exist to pin. Deferred per CLAUDE.md §1.7.
  //    None of these are fixed here; they are pre-existing and out of this change's scope —
  //    named only so this comment does not read as an exhaustive account of what is closed.
  const rawCmd = tokens[idx];
  const basename = rawCmd.replace(/^\\/, '').split('/').pop().toLowerCase();
  const strippedBasename = stripExeSuffix(basename);
  const cwdBuiltinCandidate = strippedBasename.replace(/^\(+/, '');
  const cmd = CWD_BUILTINS.has(cwdBuiltinCandidate) ? basename : strippedBasename;
  idx++;

  const args = tokens.slice(idx);
  const entry = { cmd, args, raw: seg.trim() };

  // 4. Shell indirection: recursive parsing of inner command strings.
  //    bash -c "..."  /  sh -c "..."  → extract arg after -c from original seg
  //    eval "..."                     → extract first quoted arg directly (no -c)
  if (cmd === 'eval') {
    const inner = extractEvalArg(seg);
    if (inner) {
      return [entry, ...segments(inner)];
    }
  } else if ((cmd === 'bash' || cmd === 'sh') && args.includes('-c')) {
    const inner = extractShellCArg(seg);
    if (inner) {
      // Return both the outer wrapper entry AND the inner parsed segments.
      return [entry, ...segments(inner)];
    }
  }

  return [entry];
}

/**
 * Simple whitespace tokenizer that preserves quoted strings as single tokens.
 */
function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    // skip whitespace
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j++;
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
    } else if (s[i] === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
    }
  }
  return tokens.filter(Boolean);
}

/**
 * Extract a quoted argument from `seg` starting at `offset`.
 * Unlike a bare regex, this walk recognises backslash-escaped characters:
 *   a backslash before any character makes that character literal
 *   (so an escaped quote does NOT close the string).
 * Returns the unescaped content, or null if no opening quote is found.
 *
 * Known limits (documented): $(...) / `...` / heredoc inside -c arg,
 * and pathological nesting beyond backslash escapes, are not parsed.
 */
function extractQuotedArg(seg, offset) {
  // Find the opening quote
  let i = offset;
  while (i < seg.length && seg[i] !== '"' && seg[i] !== "'") i++;
  if (i >= seg.length) return null;

  const quote = seg[i];
  i++; // skip opening quote

  let content = '';
  while (i < seg.length) {
    const ch = seg[i];
    if (ch === '\\' && quote === '"') {
      // Inside double-quoted strings, backslash escapes the next char
      i++;
      if (i < seg.length) {
        content += seg[i];
        i++;
      }
    } else if (ch === quote) {
      // Unescaped matching quote: end of string
      return content;
    } else {
      content += ch;
      i++;
    }
  }
  // Unterminated quote — return whatever we gathered
  return content;
}

/**
 * Extract the argument string after "-c" in the original (non-stripped) segment.
 * Handles backslash-escaped inner quotes so that:
 *   bash -c "bash -c \"rm -rf /\""  →  bash -c "rm -rf /"  (recurse → BLOCK)
 *   bash -c 'rm -rf /'              →  rm -rf /
 */
function extractShellCArg(seg) {
  // Find " -c " then take the next quoted arg using escape-aware walk
  const cIdx = seg.search(/(?:^|\s)-c\s/);
  if (cIdx === -1) return null;
  // Advance past "-c" and whitespace to the start of the argument
  const afterFlag = seg.indexOf('-c', cIdx) + 2;
  // Skip whitespace
  let argStart = afterFlag;
  while (argStart < seg.length && /\s/.test(seg[argStart])) argStart++;
  if (argStart >= seg.length) return null;

  // If argument is quoted, use escape-aware extractor
  if (seg[argStart] === '"' || seg[argStart] === "'") {
    return extractQuotedArg(seg, argStart);
  }
  // Bare word: take until next whitespace
  const end = seg.indexOf(' ', argStart);
  return end === -1 ? seg.slice(argStart) : seg.slice(argStart, end);
}

/**
 * Extract the command string from eval "..." or eval '...'.
 * eval "rm -rf /"            →  rm -rf /
 * eval "rm -rf \"/tmp/foo\"" →  rm -rf "/tmp/foo"
 */
function extractEvalArg(seg) {
  const evalIdx = seg.search(/\beval\s/);
  if (evalIdx === -1) return null;
  const afterEval = seg.indexOf('eval', evalIdx) + 4;
  // Skip whitespace
  let argStart = afterEval;
  while (argStart < seg.length && /\s/.test(seg[argStart])) argStart++;
  if (argStart >= seg.length) return null;

  if (seg[argStart] === '"' || seg[argStart] === "'") {
    return extractQuotedArg(seg, argStart);
  }
  const end = seg.indexOf(' ', argStart);
  return end === -1 ? seg.slice(argStart) : seg.slice(argStart, end);
}

module.exports = { segments, stripHeredocs, stripQuotedContent, stripExeSuffix };
