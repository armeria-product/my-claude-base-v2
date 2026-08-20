import { spawn } from 'node:child_process';
import { createServer, get as httpGet } from 'node:http';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 3;
const SAFE_COMMAND = /^[^\r\n;&|<>`$]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

export const PREVIEW_EVIDENCE_SCHEMA = Object.freeze({
  required: ['url', 'buildPath', 'screenshot', 'console', 'interaction', 'mockComparison', 'verdict'],
  screenshotStatuses: ['captured', 'not-captured'],
  consoleStatuses: ['clean', 'errors', 'not-checked'],
  interactionStatuses: ['passed', 'failed', 'not-run'],
  mockStatuses: ['compared', 'not-applicable', 'not-compared'],
  verdicts: ['looks-ok', 'needs-fixes', 'unverified'],
});

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(String(host ?? '').toLowerCase())) {
    throw new Error('preview host must be a literal loopback host');
  }
  return String(host).toLowerCase();
}

function loopbackUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); }
  catch { throw new Error('preview URL must be an HTTP(S) loopback URL'); }
  if (!/^https?:$/.test(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase())) {
    throw new Error('preview URL must be an HTTP(S) loopback URL');
  }
  return parsed;
}

function previewUrl(host, port, pathName) {
  const safeHost = assertLoopbackHost(host);
  const displayedHost = safeHost.includes(':') ? '[' + safeHost + ']' : safeHost;
  return 'http://' + displayedHost + ':' + port + (pathName.startsWith('/') ? pathName : '/' + pathName);
}

function isRealpathWithin(root, candidate) {
  try {
    return isWithin(realpathSync(root), realpathSync(candidate));
  } catch {
    return false;
  }
}

function readUtf8(filename) {
  try {
    return readFileSync(filename, 'utf8');
  } catch {
    return null;
  }
}

function ancestorDirectories(targetDirectory, workspaceRoot) {
  const target = path.resolve(targetDirectory);
  const root = path.resolve(workspaceRoot);
  if (!isWithin(root, target)) throw new Error('targetDirectory must stay inside workspaceRoot');
  const directories = [];
  for (let current = target; ; current = path.dirname(current)) {
    directories.push(current);
    if (current === root || path.dirname(current) === current) break;
  }
  return directories;
}

function firstUsefulCommand(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^<!--/.test(trimmed) || /^(?:tbd|none|n\/a)$/i.test(trimmed)) continue;
    const inline = trimmed.match(/`([^`]+)`/);
    const candidate = inline?.[1] ?? trimmed.replace(/^[-*+]\s+/, '').replace(/^(?:run|start)\s*:\s*/i, '');
    if (hasText(candidate) && !/^#{1,6}\s/.test(candidate)) return candidate.trim();
  }
  return null;
}

/** Return the first executable-looking command from a Markdown Commands section. */
export function commandFromAgentsMarkdown(markdown) {
  if (!hasText(markdown)) return null;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+commands\s*$/i.test(line));
  if (headingIndex === -1) return null;
  const level = (lines[headingIndex].match(/^(#{1,6})/)?.[1] ?? '').length;
  const section = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const nextHeading = lines[index].match(/^(#{1,6})\s+/);
    if (nextHeading && nextHeading[1].length <= level) break;
    section.push(lines[index]);
  }
  const fenced = section.join('\n').match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/);
  return firstUsefulCommand((fenced?.[1] ?? section.join('\n')).split('\n'));
}

function commandParts(commandText) {
  if (!hasText(commandText) || !SAFE_COMMAND.test(commandText)) {
    return { ok: false, reason: 'command contains an unsupported shell control character' };
  }
  const parts = [];
  let token = '';
  let quote = null;
  for (const character of commandText.trim()) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
    } else if (/\s/.test(character) && !quote) {
      if (token) parts.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (quote || (!token && parts.length === 0)) return { ok: false, reason: 'command has incomplete quoting' };
  if (token) parts.push(token);
  return { ok: true, command: parts[0], args: parts.slice(1) };
}

function commandLaunch(commandText) {
  const parsed = commandParts(commandText);
  return parsed.ok
    ? { kind: 'command', supported: true, commandText, command: parsed.command, args: parsed.args }
    : { kind: 'command', supported: false, commandText, reason: parsed.reason };
}

function suggestedCommandsSnippet(commandText) {
  return hasText(commandText) ? `## Commands\n\n\`\`\`sh\n${commandText}\n\`\`\`` : null;
}

function nearestPackage(target, root) {
  for (const directory of ancestorDirectories(target, root)) {
    const filename = path.join(directory, 'package.json');
    const text = readUtf8(filename);
    if (!text) continue;
    try {
      return { path: filename, value: JSON.parse(text) };
    } catch {
      continue;
    }
  }
  return null;
}

function nearestFile(target, root, name) {
  return ancestorDirectories(target, root)
    .map((directory) => path.join(directory, name))
    .find((filename) => existsSync(filename)) ?? null;
}

/** Discover a route without writing instructions or launching a process. */
export function discoverPreviewCommand(targetDirectory, { workspaceRoot = targetDirectory } = {}) {
  const target = path.resolve(targetDirectory);
  const root = path.resolve(workspaceRoot);
  for (const directory of ancestorDirectories(target, root)) {
    const sourcePath = path.join(directory, 'AGENTS.md');
    const commandText = commandFromAgentsMarkdown(readUtf8(sourcePath));
    if (commandText) {
      const launch = commandLaunch(commandText);
      if (!launch.supported) continue;
      return {
        kind: 'agents-commands', sourcePath, commandText, launch,
        suggestedCommands: suggestedCommandsSnippet(commandText), persistence: 'suggest-only',
      };
    }
  }

  const packageFile = nearestPackage(target, root);
  for (const scriptName of ['dev', 'start']) {
    if (hasText(packageFile?.value?.scripts?.[scriptName])) {
      const commandText = `npm run ${scriptName}`;
      return {
        kind: `package-${scriptName}`, sourcePath: packageFile.path, commandText, launch: commandLaunch(commandText),
        suggestedCommands: suggestedCommandsSnippet(commandText), persistence: 'suggest-only',
      };
    }
  }

  const cargoPath = nearestFile(target, root, 'Cargo.toml');
  if (cargoPath) {
    const commandText = 'cargo run';
    return {
      kind: 'cargo', sourcePath: cargoPath, commandText, launch: commandLaunch(commandText),
      suggestedCommands: suggestedCommandsSnippet(commandText), persistence: 'suggest-only',
    };
  }

  const indexPath = nearestFile(target, root, 'index.html');
  if (indexPath) {
    const rootDirectory = path.dirname(indexPath);
    const commandText = `static server for ${rootDirectory}`;
    return {
      kind: 'static-index', sourcePath: indexPath, commandText,
      launch: { kind: 'static', supported: true, rootDirectory },
      suggestedCommands: suggestedCommandsSnippet(commandText), persistence: 'suggest-only',
    };
  }

  return { kind: 'none', sourcePath: null, commandText: null, launch: null, suggestedCommands: null, persistence: 'suggest-only' };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedAppend(existing, chunk) {
  return (existing + chunk.toString()).slice(-8_192);
}

function spawnCommand(launch, context) {
  const child = spawn(launch.command, launch.args ?? [], {
    cwd: context.cwd,
    env: context.environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = { kind: 'child', child, stderr: '', error: null };
  child.stderr?.on('data', (chunk) => { handle.stderr = boundedAppend(handle.stderr, chunk); });
  child.on('error', (error) => { handle.error = error; });
  return handle;
}

function staticContentType(filename) {
  if (/\.html?$/i.test(filename)) return 'text/html; charset=utf-8';
  if (/\.js$/i.test(filename)) return 'text/javascript; charset=utf-8';
  if (/\.css$/i.test(filename)) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function staticWorkspaceRoot(rootDirectory, workspaceRoot) {
  const root = realpathSync(path.resolve(rootDirectory));
  const workspace = realpathSync(path.resolve(workspaceRoot));
  if (!statSync(root).isDirectory()) throw new Error('static preview root must be a directory');
  if (!statSync(workspace).isDirectory()) throw new Error('preview workspace root must be a directory');
  if (!isWithin(workspace, root)) throw new Error('static preview root must stay inside workspace real path');
  return root;
}

async function startStaticServer(rootDirectory, port, host, workspaceRoot) {
  const root = staticWorkspaceRoot(rootDirectory, workspaceRoot);
  assertLoopbackHost(host);
  const server = createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://preview.local').pathname); }
    catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }
    const candidate = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    if (!isWithin(root, candidate) || !existsSync(candidate) || !isRealpathWithin(root, candidate) || !statSync(candidate).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const resolvedCandidate = realpathSync(candidate);
    response.writeHead(200, { 'content-type': staticContentType(resolvedCandidate) });
    createReadStream(resolvedCandidate).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { kind: 'static', server };
}

async function startLaunch(launch, context) {
  if (!isObject(launch) || launch.supported === false) throw new Error(launch?.reason ?? 'launch route is unsupported');
  if (launch.kind === 'static') return startStaticServer(launch.rootDirectory, context.port, context.host, context.workspaceRoot);
  if (launch.kind === 'command' && hasText(launch.command) && Array.isArray(launch.args)) return spawnCommand(launch, context);
  throw new Error('launch must be a supported command or static route');
}
/** Probe only the selected local URL; redirects or remote links are never followed. */
export function probeHttp(url, { timeoutMs = 500 } = {}) {
  const localUrl = loopbackUrl(url);
  return new Promise((resolve, reject) => {
    const request = httpGet(localUrl, (response) => {
      const statusCode = response.statusCode ?? 0;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const result = { statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (statusCode >= 200 && statusCode < 400) resolve(result);
        else reject(new Error(`HTTP probe returned ${statusCode}`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('HTTP probe timed out')));
    request.once('error', reject);
  });
}

async function waitForHttp(url, handle, { timeoutMs, intervalMs, isReady }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (handle.kind === 'child' && handle.error) throw handle.error;
    if (handle.kind === 'child' && (handle.child.exitCode !== null || handle.child.signalCode !== null)) {
      throw new Error(handle.stderr || `preview process exited before HTTP was ready (${handle.child.exitCode ?? handle.child.signalCode})`);
    }
    try {
      const response = await probeHttp(url, { timeoutMs: Math.min(500, intervalMs * 2) });
      if (typeof isReady === 'function' && isReady(response) !== true) throw new Error('HTTP response did not satisfy readiness predicate');
      return response;
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw lastError ?? new Error('preview server did not become ready');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

/** Stop only a server handle created by this module. Safe to call more than once. */
export async function stopPreviewHandle(handle, { timeoutMs = 1_500 } = {}) {
  if (!handle) return { stopped: true, forced: false };
  if (handle.kind === 'static') {
    await new Promise((resolve) => handle.server.close(() => resolve()));
    return { stopped: true, forced: false };
  }
  if (handle.kind !== 'child') return { stopped: false, forced: false };
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, forced: false };
  try {
    child.kill('SIGTERM');
  } catch {
    return { stopped: child.exitCode !== null || child.signalCode !== null, forced: false };
  }
  if (await waitForExit(child, timeoutMs)) return { stopped: true, forced: false };
  try {
    child.kill('SIGKILL');
  } catch {
    return { stopped: child.exitCode !== null || child.signalCode !== null, forced: true };
  }
  return { stopped: await waitForExit(child, timeoutMs), forced: true };
}

async function availablePort(host) {
  assertLoopbackHost(host);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!isObject(address) || !Number.isInteger(address.port)) throw new Error('could not allocate a local preview port');
  return address.port;
}

function defaultEvidence(url, buildPath) {
  return {
    url,
    buildPath,
    screenshot: { status: 'not-captured', reason: 'native browser observation was not supplied' },
    console: { status: 'not-checked', errors: [] },
    interaction: { status: 'not-run', summary: 'no representative interaction was supplied' },
    mockComparison: { status: 'not-compared', differences: [] },
    verdict: 'unverified',
  };
}

function mergedEvidence(base, observation) {
  if (!isObject(observation)) return base;
  return {
    ...base,
    ...observation,
    screenshot: { ...base.screenshot, ...(isObject(observation.screenshot) ? observation.screenshot : {}) },
    console: { ...base.console, ...(isObject(observation.console) ? observation.console : {}) },
    interaction: { ...base.interaction, ...(isObject(observation.interaction) ? observation.interaction : {}) },
    mockComparison: { ...base.mockComparison, ...(isObject(observation.mockComparison) ? observation.mockComparison : {}) },
  };
}

function hasRasterImageSignature(filename) {
  const bytes = readFileSync(filename);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a');
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpeg || gif || webp;
}

function isExistingScreenshotInScope(screenshotPath, workspaceRoot) {
  if (!hasText(screenshotPath)) return false;
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, screenshotPath);
  try {
    return existsSync(candidate) && statSync(candidate).isFile() && isRealpathWithin(root, candidate) && hasRasterImageSignature(candidate);
  } catch {
    return false;
  }
}

function canonicalLoopbackUrl(value) {
  return loopbackUrl(value).href;
}

/** Validate the browser evidence fields that a preview report must retain. */
export function validatePreviewEvidence(evidence, { workspaceRoot = process.cwd(), observedUrl, expectedUrl } = {}) {
  const errors = [];
  if (!isObject(evidence)) return ['preview evidence must be an object'];
  let reportUrl = null;
  if (!hasText(evidence.url)) errors.push('url must be an HTTP(S) loopback URL');
  else {
    try { reportUrl = canonicalLoopbackUrl(evidence.url); }
    catch { errors.push('url must be an HTTP(S) loopback URL'); }
  }
  if (hasText(observedUrl)) {
    let observed = null;
    try { observed = canonicalLoopbackUrl(observedUrl); }
    catch { errors.push('observed lifecycle URL must be an HTTP(S) loopback URL'); }
    if (reportUrl && observed && reportUrl !== observed) {
      let expected = null;
      if (hasText(expectedUrl)) {
        try { expected = canonicalLoopbackUrl(expectedUrl); }
        catch { errors.push('expectedUrl contract must be an HTTP(S) loopback URL'); }
      }
      if (!expected || reportUrl !== expected) errors.push('report URL must match the observed lifecycle URL or expectedUrl contract');
    }
  } else if (hasText(expectedUrl)) {
    try {
      if (!reportUrl || reportUrl !== canonicalLoopbackUrl(expectedUrl)) errors.push('report URL must match the expectedUrl contract');
    } catch {
      errors.push('expectedUrl contract must be an HTTP(S) loopback URL');
    }
  }
  if (!hasText(evidence.buildPath)) errors.push('buildPath is required');
  if (!PREVIEW_EVIDENCE_SCHEMA.screenshotStatuses.includes(evidence.screenshot?.status)) errors.push('screenshot.status is required');
  else if (evidence.screenshot.status === 'captured' && !isExistingScreenshotInScope(evidence.screenshot.path, workspaceRoot)) {
    errors.push('captured screenshot requires an existing in-scope screenshot image artifact');
  }
  if (!PREVIEW_EVIDENCE_SCHEMA.consoleStatuses.includes(evidence.console?.status) || !Array.isArray(evidence.console?.errors)) {
    errors.push('console requires a status and errors array');
  }
  if (!PREVIEW_EVIDENCE_SCHEMA.interactionStatuses.includes(evidence.interaction?.status)) errors.push('interaction.status is required');
  else if (evidence.interaction.status === 'passed' && !hasText(evidence.interaction.summary)) errors.push('passed interaction requires a summary');
  if (!PREVIEW_EVIDENCE_SCHEMA.mockStatuses.includes(evidence.mockComparison?.status) || !Array.isArray(evidence.mockComparison?.differences)) {
    errors.push('mockComparison requires a status and differences array');
  }
  if (!PREVIEW_EVIDENCE_SCHEMA.verdicts.includes(evidence.verdict)) errors.push('verdict is invalid');
  const incomplete = evidence.screenshot?.status !== 'captured' ||
    evidence.console?.status === 'not-checked' ||
    evidence.interaction?.status !== 'passed' ||
    !['compared', 'not-applicable'].includes(evidence.mockComparison?.status);
  if (incomplete && evidence.verdict !== 'unverified') {
    errors.push('incomplete preview evidence must use the unverified verdict');
  }
  if ((evidence.console?.status === 'errors' || evidence.interaction?.status === 'failed') && evidence.verdict === 'looks-ok') {
    errors.push('failed preview evidence cannot use the looks-ok verdict');
  }
  return errors;
}
/**
 * Launch a local preview, wait for HTTP, accept browser observations, and stop the launched handle
 * in a finally path. It retries only with the next local port and never installs dependencies.
 */
export async function runPreviewLifecycle({
  launch,
  cwd = process.cwd(),
  workspaceRoot = cwd,
  host = '127.0.0.1',
  basePort,
  maxAttempts = MAX_ATTEMPTS,
  pathName = '/',
  buildPath = 'dev server',
  readyTimeoutMs = 4_000,
  retryIntervalMs = 80,
  isReady,
  observe,
  onSpawn,
  expectedUrl,
} = {}) {
  const attempts = [];
  const cleanup = { attempted: false, stopped: false, forced: false };
  const limit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, MAX_ATTEMPTS) : MAX_ATTEMPTS;
  const localHost = assertLoopbackHost(host);
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspaceRoot);
  let handle = null;
  let lastError = null;
  let port = Number.isInteger(basePort) ? basePort : await availablePort(localHost);

  try {
    for (let number = 1; number <= limit; number += 1) {
      const url = previewUrl(localHost, port, pathName);
      try {
        handle = await startLaunch(launch, { cwd: resolvedCwd, workspaceRoot: resolvedWorkspace, host: localHost, port, environment: { ...process.env, PORT: String(port) } });
        if (typeof onSpawn === 'function') onSpawn(handle);
        const response = await waitForHttp(url, handle, { timeoutMs: readyTimeoutMs, intervalMs: retryIntervalMs, isReady });
        const observation = typeof observe === 'function' ? await observe({ url, port, response }) : null;
        const evidence = mergedEvidence(defaultEvidence(url, buildPath), observation);
        const evidenceErrors = validatePreviewEvidence(evidence, { workspaceRoot: resolvedWorkspace, observedUrl: url, expectedUrl });
        if (evidenceErrors.length > 0) throw new Error(evidenceErrors.join('; '));
        attempts.push({ number, port, url, status: 'ready' });
        return { url, port, response, attempts, evidence, processPid: handle.kind === 'child' ? handle.child.pid : null, cleanup };
      } catch (error) {
        lastError = error;
        attempts.push({ number, port, url, status: 'failed', reason: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 500) });
        if (handle) {
          cleanup.attempted = true;
          const stopped = await stopPreviewHandle(handle);
          cleanup.stopped = cleanup.stopped || stopped.stopped;
          cleanup.forced = cleanup.forced || stopped.forced;
          handle = null;
        }
        port += 1;
      }
    }
    throw new Error(`preview did not become ready after ${limit} attempt(s): ${lastError?.message ?? 'unknown error'}`);
  } finally {
    if (handle) {
      cleanup.attempted = true;
      const stopped = await stopPreviewHandle(handle);
      cleanup.stopped = cleanup.stopped || stopped.stopped;
      cleanup.forced = cleanup.forced || stopped.forced;
    }
  }
}

function main(argv) {
  if (argv[2] !== 'discover' || !argv[3]) {
    process.stderr.write('Usage: node preview-lifecycle.mjs discover <target-directory> [workspace-root]\n');
    return 2;
  }
  process.stdout.write(JSON.stringify(discoverPreviewCommand(argv[3], { workspaceRoot: argv[4] ?? argv[3] }), null, 2) + '\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
