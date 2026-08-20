import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const CREDENTIAL_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/i,
  /\bghp_[A-Za-z0-9]{36}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/i,
];
const GENERIC_CREDENTIAL_PATTERNS = [
  /(?:["']?(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|client[_-]?secret|secret|password|token)["']?)\s*[:=]\s*["'`]([^"'`]{1,})["'`]/i,
  /\bauthorization\b\s*[:=]\s*["'`]Bearer\s+([^"'`\s]{1,})["'`]/i,
];
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const DEBUG_PATTERN = /\b(?:console\s*(?:\?\.|\.)\s*log\s*\(|debugger\s*;)/;
const SECRET_PATH_PATTERNS = [
  /(?:^|\/)(?:credentials?|secrets?)(?:\/|(?:\.[^/]+)?$)/i,
  /(?:^|\/)id_(?:rsa|ed25519)(?:\.[^/]+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);
const ARTIFACT_PATTERNS = [
  /^(?:dist|build)(?:\/|$)/i,
  /^(?:tmp|coverage|\.nyc_output)(?:\/|$)/i,
  /^tasks\/journal(?:\/|$)/i,
  /^clover\/(?:run(?:\/|$)|relay\.log$)/i,
  /^\.claude\/(?:\.relay-status|\.fable-status)$/i,
  /(?:^|\/)[^/]+\.(?:log|tmp|temp|bak|swp|stacktrace|trace)$/i,
  /(?:^|\/)(?:debug|trace|dump)[^/]*\.(?:json|txt|log)$/i,
];
const TEST_FIXTURE_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec|fixture)\.[^/]+$/i;
const SAFE_FIXTURE_MARKER = /(?:TEST_ONLY|SAFE_FIXTURE|EXAMPLE_(?:TOKEN|KEY|SECRET)|PLACEHOLDER|REDACTED)/i;

class UsageError extends Error {}

function displayPath(value) {
  return String(value)
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e]/g, "?");
}

function isSafePathspec(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-") || value.includes("\\")) {
    return false;
  }
  if (/[\u0000-\u001f\u007f:]/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === value;
}

export function parseScannerArguments(argv) {
  if (argv.length === 1 && argv[0] === "--cached") {
    return { mode: "cached", pathspecs: [] };
  }
  if (argv[0] === "--worktree" && argv[1] === "--" && argv.length > 2) {
    const pathspecs = argv.slice(2);
    if (pathspecs.every(isSafePathspec)) return { mode: "worktree", pathspecs };
    throw new UsageError("worktree scanning requires a safe repository-relative pathspec for each approved file");
  }
  throw new UsageError("usage: check-commit-safety.mjs --worktree -- <approved-path>... | --cached");
}

function gitDiff(cwd, mode, pathspecs, extraArgs = []) {
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--unified=0",
    "--diff-filter=ACMR",
    ...extraArgs,
  ];
  if (mode === "cached") args.push("--cached");
  args.push("--", ...pathspecs);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: DIFF_MAX_BUFFER,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Git diff could not be inspected safely.");
  }
  return result.stdout;
}

function gitChangedPaths(cwd, mode, pathspecs) {
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--name-only",
    "-z",
    "--diff-filter=ACMR",
  ];
  if (mode === "cached") args.push("--cached");
  args.push("--", ...pathspecs);
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    maxBuffer: DIFF_MAX_BUFFER,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Git diff paths could not be inspected safely.");
  }
  return result.stdout.toString("utf8").split("\u0000").filter(Boolean).map(displayPath);
}

function parseAddedLines(diff) {
  const added = [];
  let currentPath = null;
  let currentLine = 0;
  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      const candidate = rawLine.slice(4);
      currentPath = candidate === "/dev/null" ? null : displayPath(candidate.replace(/^b\//, ""));
      continue;
    }
    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (!currentPath || currentLine === 0) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      added.push({ path: currentPath, line: currentLine, text: rawLine.slice(1) });
      currentLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) currentLine += 1;
  }
  return added;
}

function codePath(relativePath) {
  return CODE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

function hasUnsafeCredential(line, relativePath) {
  for (const pattern of CREDENTIAL_PATTERNS) {
    const all = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
    for (const match of line.matchAll(all)) {
      const isFixture = TEST_FIXTURE_PATH.test(relativePath) && SAFE_FIXTURE_MARKER.test(match[0]);
      if (!isFixture) return true;
    }
  }
  return false;
}


function isClearlySafeFixture(relativePath, value) {
  return TEST_FIXTURE_PATH.test(relativePath) && SAFE_FIXTURE_MARKER.test(value);
}

function hasUnsafeCredentialOrGeneric(line, relativePath) {
  if (hasUnsafeCredential(line, relativePath)) return true;
  for (const pattern of GENERIC_CREDENTIAL_PATTERNS) {
    const all = new RegExp(pattern.source, "gi");
    for (const match of line.matchAll(all)) {
      if (!isClearlySafeFixture(relativePath, match[1] || match[0])) return true;
    }
  }
  return false;
}

function isSecretPath(relativePath) {
  const basename = relativePath.split("/").at(-1).toLowerCase();
  if (basename === ".env") return true;
  if (basename.startsWith(".env.") && basename !== ".env.example") return true;
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}
function addFinding(findings, category, relativePath, line) {
  findings.set(category + "\u0000" + relativePath + "\u0000" + line, { category, path: relativePath, line });
}

export function scanCommitSafety(diff, changedPaths) {
  const findings = new Map();
  const addedLines = parseAddedLines(diff);
  for (const relativePath of changedPaths) {
    if (ARTIFACT_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      addFinding(findings, "generated-or-debug-artifact", relativePath, 0);
    }
    if (isSecretPath(relativePath)) {
      addFinding(findings, "secret-path", relativePath, 0);
    }
  }
  for (const { path: relativePath, line, text } of addedLines) {
    if (PRIVATE_KEY_PATTERN.test(text)) {
      addFinding(findings, "private-key", relativePath, line);
    }
    if (hasUnsafeCredentialOrGeneric(text, relativePath)) {
      addFinding(findings, "credential", relativePath, line);
    }
    if (codePath(relativePath) && DEBUG_PATTERN.test(text)) {
      addFinding(findings, "debug-code", relativePath, line);
    }
  }
  for (let index = 0; index < addedLines.length; index += 1) {
    const first = addedLines[index];
    const window = [first.text];
    for (let offset = 1; offset < 4; offset += 1) {
      const next = addedLines[index + offset];
      if (!next || next.path !== first.path || next.line !== first.line + offset) break;
      window.push(next.text);
    }
    if (window.length > 1 && hasUnsafeCredentialOrGeneric(window.join("\n"), first.path)) {
      addFinding(findings, "credential", first.path, first.line);
    }
  }
  return [...findings.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.category.localeCompare(right.category),
  );
}

export function scanRepository(cwd, options) {
  const diff = gitDiff(cwd, options.mode, options.pathspecs);
  const changedPaths = gitChangedPaths(cwd, options.mode, options.pathspecs);
  return scanCommitSafety(diff, changedPaths);
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const options = parseScannerArguments(argv);
    const findings = scanRepository(cwd, options);
    for (const finding of findings) {
      process.stdout.write(finding.category + " " + finding.path + ":" + finding.line + "\n");
    }
    return findings.length === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "commit safety scan failed";
    process.stderr.write(message + "\n");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
