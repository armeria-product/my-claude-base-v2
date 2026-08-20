import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { extractFilePaths, isSafeWorkspacePath, rootFor } from './runtime.mjs';

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'Move']);
const PROTECTED_BRANCH = /^(?:main|master|trunk)$/i;
const SECRET_PATH = /(?:^|[\s'"\\/])(?:\.env(?:\.[A-Za-z0-9_-]+)*|[^\\/\s'"]+\.(?:pem|key|p12|pfx)|credentials(?:\.[A-Za-z0-9_-]+)*|secrets?(?:[\\/]|(?:\.[A-Za-z0-9_-]+)*)|id_rsa(?:\.[A-Za-z0-9_-]+)*)(?=$|[\s'"\\/:;,?)}*])/i;
const ENV_EXAMPLE_PATH = /\.env\.example(?=$|[^A-Za-z0-9_.-])/ig;
const SECRET_READ_COMMANDS = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'select-string', 'rg', 'grep']);
const GIT_WRITE = new Set(['commit', 'push', 'merge', 'rebase', 'reset', 'restore', 'cherry-pick', 'revert', 'update-ref']);
const GIT_SECRET_READ = new Set(['show', 'diff', 'grep', 'cat-file', 'log', 'blame', 'ls-tree', 'archive']);
const KNOWN_GIT_SUBCOMMANDS = new Set(["add","am","annotate","apply","archive","bisect","blame","branch","bundle","cat-file","check-attr","check-ignore","check-mailmap","check-ref-format","checkout","checkout-index","cherry-pick","clean","clone","commit","config","describe","diff","diff-tree","fetch","for-each-ref","format-patch","fsck","gc","grep","hash-object","init","log","ls-files","ls-remote","ls-tree","merge","merge-base","mv","notes","pull","push","range-diff","read-tree","reflog","remote","reset","restore","rev-list","rev-parse","revert","rm","show","show-ref","sparse-checkout","stash","status","submodule","switch","symbolic-ref","tag","update-index","update-ref","verify-commit","verify-tag","worktree"]);
const ALT_REPOSITORY_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']);
const SECRET_PIPELINE_SOURCES = new Set(['get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi', 'resolve-path']);
const SECRET_PIPELINE_ITERATORS = new Set(['foreach-object', '%']);
const POWERSHELL_ENCODED_COMMAND = 'encodedcommand';
const BACKTICK = String.fromCharCode(96);

export function commandFrom(payload) {
  const input = payload.tool_input;
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

function hasConflictingCommandFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const values = ['command', 'cmd']
    .map((key) => input[key])
    .filter((value) => typeof value === 'string');
  return new Set(values).size > 1;
}

export function hasSecretPath(text) {
  return SECRET_PATH.test(String(text || '').replace(ENV_EXAMPLE_PATH, '.env-template'));
}

function hasSecretSelector(value) {
  const text = String(value || '');
  return hasSecretPath(text) || /[*?\[]/.test(text);
}

function branchFor(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function repositoryFor(cwd) {
  try {
    return path.resolve(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return null;
  }
}

export function normalizeContinuations(command) {
  return String(command || '')
    .replace(/\\\r?\n/g, '')
    .replace(new RegExp(BACKTICK + '\\r?\\n', 'g'), '')
    .replace(/\^\r?\n/g, '');
}

function maskPowerShellLiteralHereStrings(command) {
  return String(command || '').replace(
    /@'[^\S\r\n]*\r?\n[\s\S]*?^[^\S\r\n]*'@/gm,
    "''",
  );
}

function hasExecutableBacktick(command) {
  const source = String(command || '');
  let singleQuoted = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "'") {
      if (singleQuoted && source[index + 1] === "'") index += 1;
      else singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && source[index] === BACKTICK) return true;
  }
  return false;
}

function shellSegmentsWithOperators(command, dialect = 'mixed') {
  const segments = [];
  let current = '';
  let quote = '';
  let operatorBefore = null;
  const source = normalizeContinuations(command);
  const flush = () => {
    if (current.trim()) {
      segments.push({ source: current.trim(), operatorBefore });
      operatorBefore = null;
    }
    current = '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      current += char;
      if (quote === "'") {
        if (char === "'") quote = '';
        continue;
      }
      if ((char === '\\' || char === BACKTICK) && index + 1 < source.length) {
        current += source[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ((char === '\\' || char === BACKTICK || char === '^') && index + 1 < source.length) {
      current += char + source[index + 1];
      index += 1;
      continue;
    }
    const separator = char === '\n'
      || char === '|'
      || char === '&'
      || (dialect !== 'cmd' && char === ';');
    if (separator) {
      flush();
      operatorBefore = char;
      if ((char === '|' || char === '&') && source[index + 1] === char) {
        operatorBefore += char;
        index += 1;
      }
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

export function splitShellSegments(command, dialect = 'mixed') {
  return shellSegmentsWithOperators(command, dialect).map((segment) => segment.source);
}

function shellWords(segment) {
  const words = [];
  let current = '';
  let quote = '';
  let started = false;
  const source = String(segment || '');
  const push = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === "'") {
        if (char === "'") quote = '';
        else current += char;
        continue;
      }
      if (
        char === BACKTICK
        || (char === '\\' && /["\\$]/.test(source[index + 1]))
      ) {
        current += source[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') quote = '';
      else current += char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if ((char === '\\' || char === BACKTICK || char === '^') && index + 1 < source.length) {
      const next = source[index + 1];
      if (/\s/.test(next) || /["';&|()$]/.test(next)) {
        current += next;
        started = true;
        index += 1;
        continue;
      }
    }
    current += char;
    started = true;
  }
  push();
  return words;
}

function normalName(value) {
  return String(value || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}

function environmentAssignment(word) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(String(word || ''));
  return match ? { name: match[1].toUpperCase(), value: match[2] } : null;
}

function unwrapPrefixes(words) {
  const environment = {};
  let cursor = 0;
  let uninspectable = false;
  while (cursor < words.length) {
    let assignment = environmentAssignment(words[cursor]);
    while (assignment) {
      environment[assignment.name] = assignment.value;
      cursor += 1;
      assignment = environmentAssignment(words[cursor]);
    }
    const executable = normalName(words[cursor]);
    if (executable === 'env') {
      cursor += 1;
      while (cursor < words.length) {
        const option = String(words[cursor]);
        const lower = option.toLowerCase();
        if (option === '--') {
          cursor += 1;
          break;
        }
        const nested = environmentAssignment(option);
        if (nested) {
          environment[nested.name] = nested.value;
          cursor += 1;
          continue;
        }
        if (!option.startsWith('-')) break;
        if (lower === '-c' || lower === '--chdir' || lower.startsWith('--chdir=')) {
          uninspectable = true;
          cursor += lower === '-c' || lower === '--chdir' ? 2 : 1;
          continue;
        }
        cursor += lower === '-u' || lower === '--unset' ? 2 : 1;
      }
      continue;
    }
    if (executable === 'command') {
      cursor += 1;
      let lookupOnly = false;
      while (cursor < words.length && String(words[cursor]).startsWith('-')) {
        const option = String(words[cursor]).toLowerCase();
        if (option === '--') {
          cursor += 1;
          break;
        }
        if (option === '-v') lookupOnly = true;
        cursor += 1;
      }
      if (lookupOnly) return { environment, uninspectable, words: [] };
      continue;
    }
    break;
  }
  return { environment, uninspectable, words: words.slice(cursor) };
}

function usesAlternateRepositoryEnvironment(environment) {
  return Object.keys(environment).some((name) => ALT_REPOSITORY_ENV.has(name));
}

function changesRepositoryConfig(value) {
  return /^(?:alias\.[^=\s]+|core\.(?:worktree|bare|hookspath)|extensions\.worktreeconfig)(?:\s*=|=|$)/i.test(String(value || ''));
}

function gitInvocation(words, environment = {}) {
  if (!Array.isArray(words)) {
    words = shellWords(String(words).replace(/^[\s(&]+/, ''));
  }
  if (normalName(words[0]) !== 'git') return null;
  let cursor = 1;
  const cwdArgs = [];
  const allArgs = words.slice(1);
  let uninspectable = usesAlternateRepositoryEnvironment(environment);
  while (cursor < words.length) {
    const option = String(words[cursor]);
    const lower = option.toLowerCase();
    if (option === '--') {
      cursor += 1;
      break;
    }
    if (!option.startsWith('-')) break;
    if (option === '-C') {
      if (!words[cursor + 1]) {
        uninspectable = true;
        cursor += 1;
      } else {
        const target = String(words[cursor + 1]);
        if (!isInspectableCwd(target)) uninspectable = true;
        cwdArgs.push(target);
        cursor += 2;
      }
      continue;
    }
    if (option.startsWith('-C') && option.length > 2) {
      const target = option.slice(2).replace(/^=/, '');
      if (target && isInspectableCwd(target)) cwdArgs.push(target);
      else uninspectable = true;
      cursor += 1;
      continue;
    }
    if (option === '-c') {
      uninspectable = true;
      const setting = words[cursor + 1];
      if (!setting) {
        uninspectable = true;
        cursor += 1;
      } else {
        if (changesRepositoryConfig(setting)) uninspectable = true;
        cursor += 2;
      }
      continue;
    }
    if (option.startsWith('-c') && option.length > 2) {
      uninspectable = true;
      if (changesRepositoryConfig(option.slice(2))) uninspectable = true;
      cursor += 1;
      continue;
    }
    if (lower === '--config-env') {
      uninspectable = true;
      const setting = words[cursor + 1];
      if (!setting || changesRepositoryConfig(setting)) uninspectable = true;
      cursor += setting ? 2 : 1;
      continue;
    }
    if (lower.startsWith('--config-env=')) {
      uninspectable = true;
      if (changesRepositoryConfig(option.slice(option.indexOf('=') + 1))) uninspectable = true;
      cursor += 1;
      continue;
    }
    if (lower === '--git-dir' || lower === '--work-tree' || lower === '--namespace' || lower === '--super-prefix') {
      uninspectable = true;
      cursor += 2;
      continue;
    }
    if (
      lower.startsWith('--git-dir=')
      || lower.startsWith('--exec-path=')
      || lower.startsWith('--work-tree=')
      || lower.startsWith('--namespace=')
      || lower.startsWith('--super-prefix=')
      || lower === '--bare'
    ) {
      uninspectable = true;
      cursor += 1;
      continue;
    }
    cursor += 1;
  }
  const subcommand = String(words[cursor] || '').toLowerCase();
  if (subcommand && !KNOWN_GIT_SUBCOMMANDS.has(subcommand)) uninspectable = true;
  return {
    allArgs,
    args: words.slice(cursor + 1),
    cwdArgs,
    subcommand,
    uninspectable,
  };
}

function isInspectableCwd(value) {
  const source = String(value || '');
  if (!source || /[\0$%*?]/.test(source) || source.startsWith('~')) return false;
  return !(process.platform === 'win32' && /^\/[A-Za-z](?:\/|$)/.test(source));
}

function resolveInvocationCwd(invocation, cwd) {
  let target = cwd;
  for (const relative of invocation.cwdArgs) {
    if (!isInspectableCwd(relative)) return null;
    target = path.resolve(target, relative);
  }
  return target;
}

function optionIs(args, name) {
  const lower = name.toLowerCase();
  return args.some((value) => {
    const option = String(value).toLowerCase();
    return option === lower || option.startsWith(lower + '=');
  });
}

function hasShortFlag(args, flag) {
  return args.some((value) => {
    const option = String(value);
    return /^-[^-]+$/.test(option) && option.slice(1).includes(flag);
  });
}

function destructiveGit(invocation) {
  const { args, subcommand } = invocation;
  if (subcommand === 'reset' && optionIs(args, '--hard')) return true;
  if (subcommand === 'restore') return true;
  if (subcommand === 'clean' && (optionIs(args, '--force') || hasShortFlag(args, 'f'))) return true;
  if (
    subcommand === 'checkout'
    && (args.includes('--') || optionIs(args, '--force') || hasShortFlag(args, 'f') || hasShortFlag(args, 'B'))
  ) return true;
  if (
    subcommand === 'switch'
    && (optionIs(args, '--force') || optionIs(args, '--discard-changes') || hasShortFlag(args, 'f') || hasShortFlag(args, 'C'))
  ) return true;
  if (
    subcommand === 'branch'
    && (optionIs(args, '--force') || optionIs(args, '--delete') || hasShortFlag(args, 'f') || hasShortFlag(args, 'd') || hasShortFlag(args, 'D'))
  ) return true;
  if (subcommand === 'worktree' && normalName(args[0]) === 'remove') return true;
  if (subcommand === 'symbolic-ref' && (optionIs(args, '--delete') || hasShortFlag(args, 'd'))) return true;
  if (subcommand === 'update-ref' && (optionIs(args, '--delete') || optionIs(args, '--stdin') || hasShortFlag(args, 'd'))) return true;
  if (['rm', 'checkout-index', 'read-tree'].includes(subcommand)) return true;
  if (subcommand === 'tag' && (optionIs(args, '--delete') || hasShortFlag(args, 'd'))) return true;
  if (subcommand === 'remote' && ['remove', 'rename', 'set-url'].includes(normalName(args[0]))) return true;
  if (subcommand === 'stash' && ['clear', 'drop'].includes(normalName(args[0]))) return true;
  if (subcommand === 'reflog' && ['delete', 'expire'].includes(normalName(args[0]))) return true;
  return subcommand === 'push' && (hasShortFlag(args, 'f') || args.some((arg) => {
    const option = String(arg).toLowerCase();
    return option.startsWith('--force');
  }));
}

function unsafePull(invocation) {
  if (invocation.subcommand !== 'pull') return false;
  return !invocation.args.includes('--ff-only') || invocation.args.some((arg) => {
    const option = String(arg);
    return option === '--rebase' || option.startsWith('--rebase=');
  });
}

function positionalArguments(args, valueOptions = new Set()) {
  const values = [];
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    const lower = argument.toLowerCase();
    if (options && argument === '--') {
      options = false;
      continue;
    }
    if (options && argument.startsWith('-')) {
      if (valueOptions.has(lower) && !argument.includes('=')) index += 1;
      continue;
    }
    values.push(argument);
  }
  return values;
}

function protectedRef(value) {
  let ref = String(value || '').trim().replace(/^\+/, '');
  if (ref.startsWith(':')) ref = ref.slice(1);
  ref = ref.replace(/^refs\/heads\//i, '');
  ref = ref.replace(/^refs\/remotes\/[^/]+\//i, '');
  return PROTECTED_BRANCH.test(ref);
}

function pushWritesProtectedRef(args) {
  const values = [];
  let deleteMode = false;
  let broadWrite = false;
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    const lower = argument.toLowerCase();
    if (argument === '--') {
      values.push(...args.slice(index + 1).map(String));
      break;
    }
    if (lower === '--delete' || lower === '-d') {
      deleteMode = true;
      continue;
    }
    if (lower === '--all' || lower === '--mirror') {
      broadWrite = true;
      continue;
    }
    if (argument.startsWith('-')) {
      if (valueOptions.has(lower) && !argument.includes('=')) index += 1;
      continue;
    }
    values.push(argument);
  }
  if (broadWrite || values.length < 2) return broadWrite;
  for (const refspec of values.slice(1)) {
    const spec = String(refspec).replace(/^\+/, '');
    const separator = spec.indexOf(':');
    let target = deleteMode || separator < 0 ? spec : spec.slice(separator + 1);
    if (!target && separator >= 0) target = spec.slice(0, separator);
    if (protectedRef(target)) return true;
  }
  return false;
}

function branchOperationWritesProtectedRef(invocation) {
  const { args, subcommand } = invocation;
  if (subcommand === 'update-ref') {
    if (optionIs(args, '--stdin')) return true;
    return protectedRef(positionalArguments(args)[0]);
  }
  if (subcommand === 'symbolic-ref') return symbolicRefWritesProtectedRef(invocation);
  if (subcommand === 'push') return pushWritesProtectedRef(args);
  if (subcommand === 'branch') {
    const readOnly = args.some((argument) => [
      '--list',
      '-l',
      '--show-current',
      '--contains',
      '--no-contains',
      '--merged',
      '--no-merged',
      '--points-at',
    ].includes(String(argument).toLowerCase()));
    if (readOnly) return false;
    return positionalArguments(args, new Set(['--set-upstream-to'])).some(protectedRef);
  }
  if (subcommand === 'switch' || subcommand === 'checkout') {
    const create = subcommand === 'switch'
      ? args.findIndex((argument) => /^-c$/i.test(String(argument)) || /^--create$/i.test(String(argument)))
      : args.findIndex((argument) => /^-b$/i.test(String(argument)) || /^--branch$/i.test(String(argument)));
    return create >= 0 && protectedRef(args[create + 1]);
  }
  return false;
}

function switchTarget(invocation) {
  if (!['switch', 'checkout'].includes(invocation.subcommand)) return null;
  if (
    invocation.subcommand === 'switch'
    && invocation.args.some((argument) => /^-(?:c|C)$/i.test(String(argument)) || /^--create$/i.test(String(argument)))
  ) return null;
  if (
    invocation.subcommand === 'checkout'
    && invocation.args.some((argument) => /^-(?:b|B)$/i.test(String(argument)) || /^--branch$/i.test(String(argument)))
  ) return null;
  if (invocation.args.includes('--')) return null;
  return positionalArguments(invocation.args)[0] || null;
}

function isGitWrite(invocation) {
  return GIT_WRITE.has(invocation.subcommand) || invocation.subcommand === 'pull';
}

function destructiveFilesystem(words) {
  const executable = normalName(words[0]);
  const args = words.slice(1).map((arg) => String(arg).toLowerCase());
  if (['rd', 'rmdir', 'erase', 'del', 'shred'].includes(executable)) return true;
  if (executable === 'format-volume') return true;
  if (executable === 'format') return args.some((arg) => /^[a-z]:$/i.test(arg));
  if (['rm', 'unlink'].includes(executable)) return !args.some((arg) => arg === '--version' || arg === '--help');
  if (['remove-item', 'ri'].includes(executable)) return !args.some((arg) => arg === '-whatif');
  return false;
}

function gitObjectHasSecretPath(value) {
  const source = String(value || '');
  if (hasSecretPath(source)) return true;
  const match = /^(?:[A-Za-z0-9_./~^@{}-]+):(.+)$/.exec(source);
  return Boolean(match && hasSecretPath(match[1]));
}

function gitSecretRead(invocation) {
  return GIT_SECRET_READ.has(invocation.subcommand)
    && invocation.args.some(gitObjectHasSecretPath);
}

function commitSkipsVerification(invocation) {
  return invocation.subcommand === 'commit'
    && (optionIs(invocation.args, '--no-verify') || hasShortFlag(invocation.args, 'n'));
}

function symbolicRefWritesProtectedRef(invocation) {
  if (invocation.subcommand !== 'symbolic-ref') return false;
  const values = positionalArguments(invocation.args, new Set(['-m', '--message']));
  return values.length >= 2 && protectedRef(values[1]);
}

function externalGitWriteTarget(invocation, cwd) {
  if (!isGitWrite(invocation) || invocation.subcommand === 'pull' || !invocation.cwdArgs.length) return false;
  const target = resolveInvocationCwd(invocation, cwd);
  const currentRepository = repositoryFor(cwd);
  const targetRepository = target ? repositoryFor(target) : null;
  if (!currentRepository || !targetRepository) return true;
  const left = process.platform === 'win32' ? currentRepository.toLowerCase() : currentRepository;
  const right = process.platform === 'win32' ? targetRepository.toLowerCase() : targetRepository;
  return left !== right;
}

function deletesSecretPath(words) {
  const executable = normalName(words[0]);
  if (!['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir', 'shred'].includes(executable)) return false;
  return words.slice(1).filter((word) => !String(word).startsWith('-')).some(hasSecretPath);
}

function gitConfigWritesSensitiveSetting(invocation) {
  if (invocation.subcommand !== 'config') return false;
  const values = positionalArguments(invocation.args, new Set(['--file', '-f', '--blob', '--type', '--fixed-value']));
  const writes = invocation.args.some((argument) => /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section)$/i.test(String(argument)))
    || (!invocation.args.some((argument) => /^(?:--get|--get-all|--get-regexp|--list)$/i.test(String(argument))) && values.length >= 2);
  return writes && changesRepositoryConfig(values[0]);
}

function secretRead(words) {
  const executable = normalName(words[0]);
  if (!SECRET_READ_COMMANDS.has(executable)) return false;
  const args = words.slice(1).filter((arg) => !String(arg).startsWith('-'));
  if (executable === 'rg' || executable === 'grep') return args.slice(1).some(hasSecretSelector);
  return args.some(hasSecretSelector);
}

function secretVariableName(value) {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)?$/.exec(String(value || ''));
  return match ? match[1].toLowerCase() : null;
}

function captureSecretAssignment(words, variables) {
  const first = String(words[0] || '');
  const compact = /^\$([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(first);
  const spaced = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(first)
    && String(words[1] || '') === '='
    ? { name: first.slice(1), value: String(words[2] || '') }
    : null;
  const executable = normalName(first);
  const nameIndex = words.findIndex((word) => /^-name$/i.test(String(word)));
  const valueIndex = words.findIndex((word) => /^-value$/i.test(String(word)));
  const named = executable === 'set-variable' && nameIndex >= 0 && valueIndex >= 0
    ? { name: String(words[nameIndex + 1] || ''), value: String(words[valueIndex + 1] || '') }
    : null;
  const assignment = compact ? { name: compact[1], value: compact[2] } : (spaced || named);
  if (!assignment || !assignment.name) return;
  const name = assignment.name.toLowerCase();
  if (hasSecretSelector(assignment.value)) variables.add(name);
  else variables.delete(name);
}

function readsSecretVariable(words, variables) {
  return words.slice(1).some((word) => {
    const name = secretVariableName(word);
    return name && variables.has(name);
  });
}

function iteratorReadsPipelineValue(words) {
  for (let index = 0; index < words.length; index += 1) {
    if (!SECRET_READ_COMMANDS.has(normalName(words[index]))) continue;
    if (words.slice(index + 1).some((word) => /^\$_(?:\.FullName)?$/i.test(String(word)))) return true;
  }
  return false;
}

function inspectSecretDataFlow(command, state, dialect) {
  if (dialect === 'cmd' || dialect === 'sh') return;
  const variables = new Set();
  let pipelineOutputIsSecret = false;
  for (const segment of shellSegmentsWithOperators(command, dialect)) {
    const words = shellWords(stripOuterGroup(segment.source));
    if (!words.length) continue;
    const prefix = unwrapPrefixes(words);
    for (const [name, value] of Object.entries(prefix.environment)) {
      if (hasSecretSelector(value)) variables.add(name.toLowerCase());
      else variables.delete(name.toLowerCase());
    }
    let flowWords = prefix.words;
    if (normalName(flowWords[0]) === 'for') {
      const inIndex = flowWords.findIndex((word) => String(word).toLowerCase() === 'in');
      if (inIndex > 1 && flowWords.slice(inIndex + 1).some(hasSecretSelector)) {
        variables.add(String(flowWords[1]).replace(/^\$/, '').toLowerCase());
      }
    }
    if (normalName(flowWords[0]) === 'do') flowWords = flowWords.slice(1);
    if (!flowWords.length) continue;
    captureSecretAssignment(flowWords, variables);
    const executable = normalName(flowWords[0]);
    const pipedSecret = segment.operatorBefore === '|' && pipelineOutputIsSecret;
    if (
      SECRET_READ_COMMANDS.has(executable)
      && (readsSecretVariable(flowWords, variables) || pipedSecret)
    ) state.secretRead = true;
    if (
      pipedSecret
      && SECRET_PIPELINE_ITERATORS.has(executable)
      && iteratorReadsPipelineValue(flowWords)
    ) state.secretRead = true;
    pipelineOutputIsSecret = SECRET_PIPELINE_SOURCES.has(executable)
      && flowWords.slice(1).some(hasSecretSelector);
  }
}

function matchingIndex(source, start, open, close) {
  let depth = 0;
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === "'") {
        if (char === "'") quote = '';
        continue;
      }
      if ((char === '\\' || char === BACKTICK) && index + 1 < source.length) {
        index += 1;
        continue;
      }
      if (char === '"') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if ((char === '\\' || char === BACKTICK || char === '^') && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripOuterGroup(segment) {
  const source = String(segment || '').trim();
  if (!source.startsWith('(')) return source;
  const end = matchingIndex(source, 0, '(', ')');
  return end === source.length - 1 ? source.slice(1, -1).trim() : source;
}

function commandSubstitutions(command, dialect) {
  if (dialect === 'cmd') return { values: [], uninspectable: false };
  const values = [];
  const source = normalizeContinuations(command);
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if ((char === '\\' || char === BACKTICK) && index + 1 < source.length) {
        index += 1;
        continue;
      }
      if (char === '"') {
        quote = '';
        continue;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      continue;
    } else if ((char === '\\' || char === BACKTICK || char === '^') && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (char !== '$' || source[index + 1] !== '(') continue;
    const end = matchingIndex(source, index + 1, '(', ')');
    if (end < 0) return { values, uninspectable: true };
    values.push(source.slice(index + 2, end));
    index = end;
  }
  return { values, uninspectable: false };
}

function powerShellScriptBlocks(command, dialect) {
  if (dialect === 'cmd' || dialect === 'sh') return { values: [], uninspectable: false };
  const values = [];
  const source = normalizeContinuations(command);
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === "'") {
        if (char === "'") quote = '';
        continue;
      }
      if ((char === '\\' || char === BACKTICK) && index + 1 < source.length) {
        index += 1;
        continue;
      }
      if (char === '"') quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ((char === '\\' || char === BACKTICK || char === '^') && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (char !== '{') continue;
    const end = matchingIndex(source, index, '{', '}');
    if (end < 0) return { values, uninspectable: true };
    values.push(source.slice(index + 1, end));
    index = end;
  }
  return { values, uninspectable: false };
}

function scriptBlockSource(value) {
  const source = String(value || '').trim();
  if (!source.startsWith('{')) return source;
  const end = matchingIndex(source, 0, '{', '}');
  return end === source.length - 1 ? source.slice(1, -1) : null;
}

function hasDynamicShellSource(value) {
  const source = String(value || '');
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === "'") {
        if (char === "'") quote = '';
        continue;
      }
      if (char === '\\' && index + 1 < source.length) {
        index += 1;
        continue;
      }
      if (char === '"') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (char === BACKTICK || char === '$') return true;
  }
  return false;
}

function isPowerShellEncodedCommandOption(option) {
  const match = /^[-/]([a-z]+)(?::|=|$)/i.exec(String(option || ''));
  return Boolean(match && (match[1].toLowerCase() === 'ec' || POWERSHELL_ENCODED_COMMAND.startsWith(match[1].toLowerCase())));
}

function hasDynamicPowerShellSource(value) {
  const source = String(value || '');
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === "'") {
        if (char === "'") quote = '';
        continue;
      }
      if (char === BACKTICK && index + 1 < source.length) return true;
      if (char === '"') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === BACKTICK || char === '$') return true;
  }
  return false;
}

function wrapperSource(words) {
  const executable = normalName(words[0]);
  const args = words.slice(1).map(String);
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
    const index = args.findIndex((arg) => {
      const lower = arg.toLowerCase();
      return lower === '-c'
        || lower === '--command'
        || lower.startsWith('--command=')
        || (/^-[a-z]+$/i.test(arg) && arg.slice(1).toLowerCase().includes('c'));
    });
    if (index < 0) return args.some((arg) => !arg.startsWith('-')) ? { uninspectable: true } : null;
    const option = args[index].toLowerCase();
    const source = option.startsWith('--command=')
      ? args[index].slice(args[index].indexOf('=') + 1)
      : args[index + 1];
    if (!source || hasDynamicShellSource(source)) return { uninspectable: true };
    return { source, dialect: 'sh' };
  }
  if (['powershell', 'pwsh'].includes(executable)) {
    for (let index = 0; index < args.length; index += 1) {
      const option = args[index];
      const lower = option.toLowerCase();
      if (isPowerShellEncodedCommandOption(option)) return { uninspectable: true };
      if (lower === '-file' || lower === '-f') return { uninspectable: true };
      if (lower === '-command' || lower === '-c') {
        const source = scriptBlockSource(args.slice(index + 1).join(' '));
        return source ? { source, dialect: 'powershell' } : { uninspectable: true };
      }
      if (lower.startsWith('-command:') || lower.startsWith('-command=')) {
        const delimiter = lower.includes(':') ? ':' : '=';
        const source = scriptBlockSource(option.slice(option.indexOf(delimiter) + 1));
        return source ? { source, dialect: 'powershell' } : { uninspectable: true };
      }
    }
    return args.length ? { uninspectable: true } : null;
  }
  if (['invoke-expression', 'iex'].includes(executable)) {
    const source = scriptBlockSource(args.join(' '));
    if (!source || hasDynamicPowerShellSource(source)) return { uninspectable: true };
    return { source, dialect: 'powershell' };
  }
  if (executable === 'eval') {
    const source = args.join(' ');
    if (!source || hasDynamicShellSource(source)) return { uninspectable: true };
    return { source, dialect: 'sh' };
  }
  if (executable === '.' || executable === 'source') return { uninspectable: true };
  if (executable === 'cmd') {
    const index = args.findIndex((arg) => /^\/(?:c|k)$/i.test(arg));
    if (index < 0) return null;
    const source = args.slice(index + 1).join(' ');
    return source ? { source, dialect: 'cmd' } : { uninspectable: true };
  }
  if (executable === 'invoke-command') {
    const index = args.findIndex((arg) => /^-scriptblock$/i.test(arg));
    if (index < 0) return null;
    const source = scriptBlockSource(args.slice(index + 1).join(' '));
    return source ? { source, dialect: 'powershell' } : { uninspectable: true };
  }
  return null;
}

function opaqueInterpreterExecution(words) {
  const executable = normalName(words[0]);
  const args = words.slice(1).map(String);
  const index = args.findIndex((arg) => arg === '-e' || arg === '--eval' || arg === '-c');
  const source = index >= 0 ? String(args[index + 1] || '') : '';
  if (executable === 'node') return /(?:node:)?child_process|(?:exec(?:File)?Sync|spawn(?:Sync)?|fork)\s*\(/i.test(source);
  if (['python', 'python3', 'py'].includes(executable)) return /\b(?:os\.system|subprocess\.|exec\s*\(|eval\s*\()/i.test(source);
  return false;
}

function powerShellAlternateRepositoryAssignment(words) {
  const first = String(words[0] || '');
  return /^\$env:(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)(?:=|$)/i.test(first)
    && (first.includes('=') || String(words[1] || '') === '=');
}

function cmdAlternateRepositoryAssignment(executable, words) {
  return executable === 'set' && words.slice(1).some((arg) => (
    /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=/i.test(String(arg))
  ));
}

function exportAlternateRepositoryAssignment(executable, words) {
  return executable === 'export' && words.slice(1).some((word) => {
    const assignment = environmentAssignment(word);
    return assignment && ALT_REPOSITORY_ENV.has(assignment.name);
  });
}

function inspectCommand(command, state, depth = 0, dialect = 'mixed') {
  if (depth > 12) {
    state.uninspectable = true;
    return;
  }
  const source = maskPowerShellLiteralHereStrings(normalizeContinuations(command));
  if (dialect !== 'powershell' && (hasExecutableBacktick(source)
    || /[<>]\(/.test(source) || /(?:^|[;|&\s])&\s*(?:\$|\()/.test(source))) state.uninspectable = true;
  const substitutions = commandSubstitutions(source, dialect);
  if (substitutions.uninspectable) state.uninspectable = true;
  for (const nested of substitutions.values) inspectCommand(nested, state, depth + 1, dialect);
  const blocks = powerShellScriptBlocks(source, dialect);
  if (blocks.uninspectable) state.uninspectable = true;
  for (const nested of blocks.values) inspectCommand(nested, state, depth + 1, 'powershell');
  inspectSecretDataFlow(source, state, dialect);

  for (const segment of shellSegmentsWithOperators(source, dialect)) {
    const words = shellWords(stripOuterGroup(segment.source));
    if (!words.length) continue;
    const prefix = unwrapPrefixes(words);
    if (prefix.uninspectable) state.uninspectable = true;
    if (!prefix.words.length) continue;
    const executable = normalName(prefix.words[0]);
    if (
      powerShellAlternateRepositoryAssignment(prefix.words)
      || cmdAlternateRepositoryAssignment(executable, prefix.words)
      || exportAlternateRepositoryAssignment(executable, prefix.words)
    ) state.uninspectable = true;
    if (['cd', 'chdir', 'set-location', 'pushd'].includes(executable)) state.changesCwd = true;
    if (destructiveFilesystem(prefix.words) || deletesSecretPath(prefix.words)) state.destructiveFilesystem = true;
    if (secretRead(prefix.words)) state.secretRead = true;
    if (opaqueInterpreterExecution(prefix.words)) state.uninspectable = true;
    const wrapper = wrapperSource(prefix.words);
    if (wrapper) {
      if (wrapper.uninspectable) state.uninspectable = true;
      else inspectCommand(wrapper.source, state, depth + 1, wrapper.dialect);
      continue;
    }
    if (executable === 'git') state.invocations.push(gitInvocation(prefix.words, prefix.environment));
  }
}

export function checkPolicy(payload) {
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input;
  if (!input || (typeof input !== 'object' && typeof input !== 'string'))
    return '安全ポリシーの入力を解釈できないため実行を止めました。';

  const nativePaths = extractFilePaths(payload);
  if (EDIT_TOOLS.has(tool)) {
    if (!nativePaths.length) return '編集対象のパスを解釈できないため実行を止めました。';
    const workspaceRoot = rootFor(payload.cwd || process.cwd());
    if (nativePaths.some((file) => !isSafeWorkspacePath(workspaceRoot, file)))
      return 'ワークスペース外またはシンボリックリンク経由の編集は止めました。';
    if (nativePaths.some((file) => hasSecretPath(file)))
      return '秘密情報の可能性があるファイルには Codex フックからアクセスできません。';
    return null;
  }

  if (hasConflictingCommandFields(input))
    return '安全ポリシーのコマンド指定が競合しているため実行を止めました。';
  const command = commandFrom(payload);
  if (!command) return '安全ポリシーのコマンドを解釈できないため実行を止めました。';
  const state = {
    changesCwd: false,
    destructiveFilesystem: false,
    invocations: [],
    secretRead: false,
    uninspectable: false,
  };
  inspectCommand(command, state);
  const invocations = state.invocations.filter(Boolean);

  if (state.uninspectable || invocations.some((item) => item.uninspectable))
    return '安全に検査できないコマンドまたは別リポジトリ指定を止めました。';
  if (state.secretRead || invocations.some(gitSecretRead))
    return '秘密情報の可能性があるファイルの読み取りを止めました。';
  if (state.destructiveFilesystem)
    return '破壊的なファイル操作を止めました。対象を確認し、ユーザーの承認を得てください。';
  if (invocations.some(commitSkipsVerification))
    return '--no-verify はこのワークスペースでは使えません。';
  if (invocations.some(gitConfigWritesSensitiveSetting))
    return 'Git の安全境界を変える設定変更を止めました。';
  if (invocations.some(destructiveGit))
    return '破壊的な Git 操作を止めました。必要なら対象と復旧方法を明示してユーザーの承認を得てください。';
  if (invocations.some(unsafePull))
    return 'git pull は --ff-only を明示した同期だけ許可されています。';
  if (invocations.some(branchOperationWritesProtectedRef))
    return '保護ブランチまたは保護参照への直接書き込みを止めました。作業ブランチと PR を使ってください。';

  if (state.changesCwd && invocations.some((item) => isGitWrite(item) && !item.cwdArgs.length))
    return '作業ディレクトリを途中で切り替える Git 書き込みは安全に検証できないため止めました。git -C <path> を使ってください。';

  if (
    invocations.some((item) => item.subcommand === 'pull')
    && invocations.some((item) => isGitWrite(item) && item.subcommand !== 'pull')
  )
    return 'git pull と後続の Git 書き込みを同じコマンド列で行う操作を止めました。';

  if (
    invocations.some((item) => {
      const target = switchTarget(item);
      return target && PROTECTED_BRANCH.test(target);
    })
    && invocations.some(isGitWrite)
  ) return '同じコマンド列で保護ブランチへ切り替えて書き込む Git 操作を止めました。';

  const cwd = payload.cwd || process.cwd();
  for (const invocation of invocations) {
    if (!isGitWrite(invocation) || invocation.subcommand === 'pull') continue;
    const targetCwd = resolveInvocationCwd(invocation, cwd);
    if (!targetCwd)
      return '安全に検査できないコマンドまたは別リポジトリ指定を止めました。';
    if (externalGitWriteTarget(invocation, cwd))
      return '別リポジトリを対象にする Git 書き込みは止めました。';
    if (PROTECTED_BRANCH.test(branchFor(targetCwd)))
      return '保護ブランチへ直接書き込む Git 操作を止めました。作業ブランチと PR を使ってください。';
  }
  return null;
}

export function denial(reason) {
  return JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}
