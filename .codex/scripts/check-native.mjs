import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REQUIRED_EVENTS = ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart'];
const REQUIRED_SKILLS = ['resume-session', 'save-session'];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`PASS: ${message}\n`);
}

function checkRegistration() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex', 'hooks.json'), 'utf8'));
  } catch (error) {
    fail(`hooks.json is not valid JSON: ${error.message}`);
    return;
  }
  const events = Object.keys(config.hooks || {}).sort();
  if (JSON.stringify(events) !== JSON.stringify(REQUIRED_EVENTS)) {
    fail(`hook events differ: ${events.join(', ')}`);
    return;
  }
  for (const event of events) {
    const groups = config.hooks[event];
    if (!Array.isArray(groups) || groups.length !== 1 || groups[0].hooks?.length !== 1) {
      fail(`${event} must have exactly one handler`);
      continue;
    }
    const handler = groups[0].hooks[0];
    if (handler.type !== 'command' || !handler.command?.includes('.codex') || !handler.command?.includes('hook.mjs'))
      fail(`${event} does not invoke the minimal hook handler`);
    if (handler.command.includes('import(pathToFileURL(h).href)') && !handler.command.includes('runHook'))
      fail(`${event} imports the handler without calling runHook`);
  }
  pass('hook registration shape');
}

function checkSkills() {
  const skillsRoot = path.join(ROOT, '.agents', 'skills');
  const present = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  if (JSON.stringify(present) !== JSON.stringify(REQUIRED_SKILLS)) {
    fail(`expected only ${REQUIRED_SKILLS.join(', ')}, found ${present.join(', ') || 'none'}`);
    return;
  }
  for (const name of present) {
    const text = fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8').replace(/\r\n?/g, '\n');
    if (!text.startsWith(`---\nname: ${name}\n`)) fail(`${name} frontmatter is invalid`);
    if (!text.includes(`$${name}`)) fail(`${name} does not document its trigger`);
  }
  pass('minimal skill surface');
}

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error || result.status !== 0) fail(`${label} failed${result.error ? `: ${result.error.message}` : ''}`);
  else pass(label);
}

checkRegistration();
checkSkills();
run('hook syntax', ['--check', '.codex/hooks/hook.mjs']);
run('hook smoke tests', ['--test', '.codex/hooks/hook.test.mjs']);
if (!process.exitCode) pass('Codex native harness');
