import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REQUIRED_EVENTS = ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart'];
const REQUIRED_SKILLS = ['resume-session', 'save-session'];
const REQUIRED_AGENT_FILES = ['luna-max.toml'];
const OLD_MAIN_SENTENCE = 'Main Codex owns ordinary investigation, planning, implementation, tests, and diff review.';

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`PASS: ${message}\n`);
}

function normalize(text) {
  return text.replace(/\r\n?/g, '\n');
}

function readTomlValues(text, section = null) {
  const values = new Map();
  let activeSection = null;
  for (const rawLine of normalize(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (sectionMatch) {
      activeSection = sectionMatch[1];
      continue;
    }
    if (activeSection !== section) continue;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (keyMatch && !values.has(keyMatch[1])) values.set(keyMatch[1], keyMatch[2]);
  }
  return values;
}

function checkNativeConfig() {
  const configPath = path.join(ROOT, '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) {
    fail('.codex/config.toml is missing');
    return;
  }
  const text = fs.readFileSync(configPath, 'utf8');
  if (!/^\[agents\]$/m.test(normalize(text))) {
    fail('.codex/config.toml is missing the [agents] section');
    return;
  }
  const values = readTomlValues(text, 'agents');
  const expected = new Map([
    ['enabled', 'true'],
    ['default_subagent_model', '"gpt-5.6-luna"'],
    ['default_subagent_reasoning_effort', '"max"'],
  ]);
  let valid = true;
  for (const [key, wanted] of expected) {
    if (values.get(key) !== wanted) {
      fail(`.codex/config.toml [agents] ${key} must be ${wanted}`);
      valid = false;
    }
  }
  if (valid) pass('native agent defaults');
}

function checkAgentSurface() {
  const agentsRoot = path.join(ROOT, '.codex', 'agents');
  if (!fs.existsSync(agentsRoot)) {
    fail('.codex/agents is missing');
    return;
  }
  const present = fs.readdirSync(agentsRoot).sort();
  if (JSON.stringify(present) !== JSON.stringify(REQUIRED_AGENT_FILES)) {
    fail(`.codex/agents must contain exactly ${REQUIRED_AGENT_FILES.join(', ')}, found ${present.join(', ') || 'none'}`);
    return;
  }
  const agentPath = path.join(agentsRoot, 'luna-max.toml');
  const text = fs.readFileSync(agentPath, 'utf8');
  const values = readTomlValues(text);
  const expected = new Map([
    ['name', '"luna_max"'],
    ['model', '"gpt-5.6-luna"'],
    ['model_reasoning_effort', '"max"'],
    ['sandbox_mode', '"workspace-write"'],
  ]);
  let valid = true;
  for (const [key, wanted] of expected) {
    if (values.get(key) !== wanted) {
      fail(`luna-max.toml ${key} must be ${wanted}`);
      valid = false;
    }
  }
  const description = values.get('description');
  if (!description || !/^"(?:[^"\\]|\\.)*"$/.test(description)
      || !/implementation/i.test(description) || !/Main Sol/i.test(description)) {
    fail('luna-max.toml description must identify implementation after Main Sol decides');
    valid = false;
  }
  const instructions = normalize(text).match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""\s*$/m);
  if (!instructions || !instructions[1].trim()) {
    fail('luna-max.toml requires developer_instructions');
    valid = false;
  }
  const instructionMarkers = [
    ['bounded handoff', /bounded handoff/i],
    ['product-level decision prohibition', /Do not make or replace product-level/i],
    ['missing/contradictory-design reporting', /omits or contradicts[\s\S]*report the missing or contradictory design/i],
    ['no agent spawning', /Do not spawn agents/i],
    ['no final reviewer/approver role', /final reviewer or approver/i],
    ['changed-files/check-results/unresolved-items reporting', /Return the changed files[\s\S]*checks and results[\s\S]*unresolved items/i],
  ];
  if (instructions) {
    for (const [label, marker] of instructionMarkers) {
      if (!marker.test(instructions[1])) {
        fail(`luna-max.toml developer_instructions is missing the ${label} boundary`);
        valid = false;
      }
    }
  }
  if (valid) pass('single Luna Max custom agent');
}

function checkNoStandingChain() {
  let valid = true;
  for (const name of ['roles', 'workflows']) {
    if (fs.existsSync(path.join(ROOT, '.codex', name))) {
      fail(`.codex/${name} must be absent (no standing chain)`);
      valid = false;
    }
  }
  if (valid) pass('no Codex role/workflow chain');
}

function checkAgentsRoleContract() {
  const agentsPath = path.join(ROOT, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fail('AGENTS.md is missing');
    return;
  }
  const text = normalize(fs.readFileSync(agentsPath, 'utf8'));
  if (text.includes(OLD_MAIN_SENTENCE)) {
    fail('AGENTS.md still contains the old Main-implements sentence');
  }
  const markers = [
    ['Main Sol ownership', /Main Sol owns/],
    ['Luna Max ownership', /Luna Max owns actual artifact changes/],
    ['explicit luna_max dispatch', /luna_max/],
    ['Main no-direct-artifact-edit boundary', /must not directly edit[\s\S]*deliverable artifacts/],
    ['Product Design ownership mapping', /Product Design[\s\S]*do not change ownership/],
    ['bounded Luna handoff', /bounded handoff/],
    ['single Luna correction loop', /one implementation Luna at a time[\s\S]*same Luna thread/],
    ['no Main fallback', /no Main implementation\s+fallback occurred/],
    ['mandatory Main review', /Main Sol's mandatory review/],
  ];
  let valid = !text.includes(OLD_MAIN_SENTENCE);
  for (const [label, marker] of markers) {
    if (!marker.test(text)) {
      fail(`AGENTS.md is missing the ${label} contract marker`);
      valid = false;
    }
  }
  if (valid) pass('Sol-led/Luna-implemented AGENTS contract');
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

checkNativeConfig();
checkAgentSurface();
checkNoStandingChain();
checkAgentsRoleContract();
checkRegistration();
checkSkills();
run('hook syntax', ['--check', '.codex/hooks/hook.mjs']);
run('hook smoke tests', ['--test', '.codex/hooks/hook.test.mjs']);
if (!process.exitCode) pass('Codex native harness');
