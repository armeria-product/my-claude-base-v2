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
//   cmd   – normalized command name (basename, lower-case wrapper stripped)
//   args  – token array after cmd (flags + targets, no env-vars; outer quotes stripped, content kept)
//   raw   – trimmed segment string after heredoc-strip (quotes kept as-is)

'use strict';

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

  // 2. Strip wrapper prefixes: sudo, command, env, backslash
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === 'sudo' || t === 'command' || t === 'env') { idx++; continue; }
    if (t === '\\') { idx++; continue; }
    break;
  }

  if (idx >= tokens.length) return [];

  // 3. Resolve command to basename (handles /bin/rm, /usr/bin/env, etc.)
  const rawCmd = tokens[idx];
  const cmd = rawCmd.replace(/^\\/, '').split('/').pop().toLowerCase();
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

module.exports = { segments, stripHeredocs, stripQuotedContent };
