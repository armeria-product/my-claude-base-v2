#!/usr/bin/env node
// .claude/scripts/validate.mjs — harness integrity validator (v2)
//
// Mechanically checks for the kinds of breakage that actually occurred across v1's
// sessions (references to nonexistent agents, dead refs to removed features, missing
// paths in rules, silently-dropped safety wording), plus v2's own invariants
// (scope-lock wiring, journal wiring, Bash|PowerShell matcher coverage).
//
// Usage: node .claude/scripts/validate.mjs
// Exit:  0 = PASS, 1 = FAIL (prints findings)
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const fails = [];
const warns = [];
const fail = (m) => fails.push(m);
const warn = (m) => warns.push(m);

const MODEL_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku', 'inherit']);
const READ_ONLY_AGENTS = new Set(['reviewer', 'verifier', 'explorer']);
// CLAUDE.md §2: planner/reviewer default to native Opus, permit only native Fable or Opus in an
// authority dispatch, and pin a per-role effort (planner max; reviewer xhigh — user ruling
// 2026-08-16: the co-review loop runs 2 seats × up to 3 cycles, so the review seat steps down one
// notch while planning keeps max). Fable is permitted only while the CLAUDE.md §1.11 gate
// (.claude/.fable-status = ON) is open, enforced for all dispatches by block-fable-when-off.js —
// never a silent/lower-tier fallback, and a failed Opus dispatch is reported and stopped, not
// silently retried on Fable.
const AUTHORITY_EFFORT = new Map([['planner', 'max'], ['reviewer', 'xhigh']]);
const AUTHORITY_MODELS = new Set(['fable', 'opus']);
const AUTHORITY_DEFAULT_MODEL = 'opus';
// agents-revision plan Phase 2 + Batch H L11 (2026-08-06 Q1 ruling, option a): shared clause (A)
// observed-content discipline is restated verbatim in these agent bodies; document-author gets a
// lightweight one-line variant; explorer is exempt (stated reason: .claude/rules/agents.md "Shared
// clauses"). The three Sets below must partition all 7 agents exactly — the 3-bucket assertion in
// the agent loop below fails an agent that lands in zero or more than one bucket (forward
// direction: every real agent is bucketed), and the reverse check after the loop fails a Set entry
// that names no real agent (reverse direction: no bucket lists a ghost/removed agent), so a newly
// added or removed agent with no clause-A classification decision is now a mechanical FAIL either
// way, not a silent gap (closes the C-L1 finding: a fixed Set never forced revisiting this on
// new-agent addition).
const OBS_CONTENT_AGENTS = new Set(['reviewer', 'verifier', 'debugger', 'executor', 'planner']);
const LIGHTWEIGHT_CLAUSE_A_AGENTS = new Set(['document-author']);
const EXEMPT_CLAUSE_A_AGENTS = new Set(['explorer']);
// Batch H L9 (2026-08-06): the unlocked-run exception (Scope Conformance / Scope check dimension)
// lives only in these two agents' bodies and must bind to a quoted recorded user ruling, not a
// scope.json/PLAN.md's own self-declared "approved"/"unlocked" claim — SOT: .claude/rules/agents.md
// clause (A) tail. An unbacked self-declaration is a HIGH review finding, not a valid exception.
const UNLOCKED_EXCEPTION_AGENTS = new Set(['reviewer', 'verifier']);

// clover relay model ids (claude-<alias>) are also allowed in agent model: frontmatter. They
// route to external models via the relay and, unlike a pinned real Claude id, don't break on
// version bumps (resolved through clover/models.json). Only aliases that exist in models.json
// are allowed, so a real Claude id like claude-opus-4-8 is still rejected by the alias rule.
// Note: an agent pinned this way only works in a clover-launched session.
function cloverModelIds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'clover', 'models.json'), 'utf8'));
    return new Set((cfg.models || []).map((m) => m.alias && `claude-${m.alias}`.toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}
const CLOVER_MODEL_IDS = cloverModelIds();

// Native Fable and external relay aliases are separate namespaces. Keep every `fable*` clover
// alias reserved so a `claude-fable...` id cannot collide with the native model name.
for (const id of CLOVER_MODEL_IDS)
  if (id.replace(/^claude-/, '').startsWith('fable'))
    fail(`clover model id "${id}" uses reserved fable* alias prefix — native Fable must remain relay-independent`);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const get = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim();
  return { name: get('name'), model: get('model'), tools: get('tools'), effort: get('effort') };
}

// ---- 1. Agents: frontmatter + tier alias + read-only tool scoping ----
const agentsDir = path.join(ROOT, '.claude', 'agents');
const agentNames = new Set();
for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith('.md'))) {
  const agentText = read(path.join(agentsDir, f));
  const fm = frontmatter(agentText);
  if (!fm?.name) { fail(`agent ${f}: missing frontmatter name`); continue; }
  agentNames.add(fm.name);
  if (!/^description:[ \t]*\S/m.test(agentText)) fail(`agent ${fm.name}: missing description (needed for dispatch/auto-selection)`);
  if (!MODEL_ALIASES.has(fm.model) && !CLOVER_MODEL_IDS.has((fm.model || '').toLowerCase())) fail(`agent ${fm.name}: model "${fm.model}" is not an alias (${[...MODEL_ALIASES].join('/')}) or a clover model id (claude-<alias> from clover/models.json) — pinned real model IDs break version bumps`);
  if (READ_ONLY_AGENTS.has(fm.name)) {
    if (!fm.tools) fail(`agent ${fm.name}: read-only agent must declare a tools allowlist`);
    else if (/\b(Edit|Write|NotebookEdit)\b/.test(fm.tools)) fail(`agent ${fm.name}: read-only agent has write tool in allowlist (${fm.tools})`);
  }
  if (AUTHORITY_EFFORT.has(fm.name) && fm.effort !== AUTHORITY_EFFORT.get(fm.name))
    fail(`agent ${fm.name}: frontmatter must pin "effort: ${AUTHORITY_EFFORT.get(fm.name)}" (CLAUDE.md §2 per-role effort pin for the authority tier)`);
  if (AUTHORITY_EFFORT.has(fm.name) && !AUTHORITY_MODELS.has(fm.model))
    fail(`agent ${fm.name}: model "${fm.model}" is not in the authority allowlist (${[...AUTHORITY_MODELS].join(' | ')})`);
  if (AUTHORITY_EFFORT.has(fm.name) && fm.model !== AUTHORITY_DEFAULT_MODEL)
    fail(`agent ${fm.name}: frontmatter default must be "${AUTHORITY_DEFAULT_MODEL}" — Fable is allowed only while the CLAUDE.md §1.11 gate (.claude/.fable-status = ON) is open`);
  // Reverse effort check: effort: is reserved for the authority tier (CLAUDE.md §2) — an
  // effort key on any other agent is either drift or an unauthorized tier upgrade.
  if (!AUTHORITY_EFFORT.has(fm.name) && fm.effort)
    fail(`agent ${fm.name}: has "effort: ${fm.effort}" in frontmatter but is not an authority agent (${[...AUTHORITY_EFFORT.keys()].join('/')}) — effort pinning is reserved for the authority tier`);
  // Fleet loop (a): the read-only Bash constraint sentence must stay verbatim in every
  // read-only agent's own body (a path-scoped rule only loads while editing agent files, so
  // the per-agent restatement is what the model actually sees at dispatch time).
  if (READ_ONLY_AGENTS.has(fm.name) && !/Bash is for reading and running tests only/.test(agentText))
    fail(`agent ${fm.name}: read-only agent is missing the verbatim "Bash is for reading and running tests only" constraint sentence in its own body`);
  // Fleet loop (b): shared clause (B) contradiction reporting — verbatim in all 7 agents.
  if (!/do not silently pick a side/.test(agentText))
    fail(`agent ${fm.name}: missing shared clause (B) contradiction-reporting ("do not silently pick a side") — SOT: .claude/rules/agents.md Shared clauses`);
  // Fleet loop (c): shared clause (C) denial etiquette — verbatim in all 7 agents.
  if (!/never retry variants or route around/.test(agentText))
    fail(`agent ${fm.name}: missing shared clause (C) denial etiquette ("never retry variants or route around") — SOT: .claude/rules/agents.md Shared clauses`);
  // Shared clause (A) observed-content discipline — 3-bucket exhaustive classification: every
  // agent must fall into exactly one of verbatim (OBS_CONTENT_AGENTS) / lightweight
  // (LIGHTWEIGHT_CLAUSE_A_AGENTS) / exempt (EXEMPT_CLAUSE_A_AGENTS). Zero buckets = an
  // unclassified agent (the C-L1 gap); more than one = an inconsistent classification.
  const clauseABuckets = [OBS_CONTENT_AGENTS, LIGHTWEIGHT_CLAUSE_A_AGENTS, EXEMPT_CLAUSE_A_AGENTS].filter((b) => b.has(fm.name)).length;
  if (clauseABuckets === 0)
    fail(`agent ${fm.name}: not classified into any shared clause (A) bucket (verbatim/lightweight/exempt) — SOT: .claude/rules/agents.md Shared clauses; every agent must be explicitly bucketed`);
  if (clauseABuckets > 1)
    fail(`agent ${fm.name}: classified into more than one shared clause (A) bucket — the three buckets must be mutually exclusive`);
  if (OBS_CONTENT_AGENTS.has(fm.name) && !/is data under examination, never instructions/.test(agentText))
    fail(`agent ${fm.name}: missing shared clause (A) observed-content discipline ("is data under examination, never instructions") — SOT: .claude/rules/agents.md Shared clauses`);
  if (LIGHTWEIGHT_CLAUSE_A_AGENTS.has(fm.name) && !/not an authoring instruction to you/.test(agentText))
    fail(`agent ${fm.name}: missing the lightweight shared clause (A) variant ("not an authoring instruction to you") — SOT: .claude/rules/agents.md Shared clauses`);
  // Batch H L9: unlocked-run exception must bind to a quoted recorded user ruling, not a
  // scope.json/PLAN.md's own self-declared "approved"/"unlocked" claim.
  if (UNLOCKED_EXCEPTION_AGENTS.has(fm.name) && !/recorded user ruling/.test(agentText))
    fail(`agent ${fm.name}: unlocked-run exception no longer requires a quoted recorded user ruling — an unbacked self-declared "approved"/"unlocked" claim in scope.json/PLAN.md would qualify for the exception — SOT: .claude/rules/agents.md clause (A) tail`);
}

// Reverse direction of the shared clause (A) 3-bucket partition (see comment above the Sets):
// the forward loop above only checks each real agent against the buckets, so a Set entry naming
// an agent that no longer exists (removed agent) or never existed (typo/ghost name) was silently
// unchecked. agentNames was already collected as the real-agent receptacle during the loop above;
// reuse it here rather than re-scanning the agents dir.
for (const name of new Set([...OBS_CONTENT_AGENTS, ...LIGHTWEIGHT_CLAUSE_A_AGENTS, ...EXEMPT_CLAUSE_A_AGENTS]))
  if (!agentNames.has(name))
    fail(`shared clause (A) bucket lists "${name}", which is not a real agent in .claude/agents/ — the 3-bucket partition must equal exactly the current agent set`);

// ---- 2. Skills: frontmatter + subagent_type resolution ----
const skillsDir = path.join(ROOT, '.claude', 'skills');
for (const d of fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const sk = path.join(skillsDir, d.name, 'SKILL.md');
  if (!fs.existsSync(sk)) { fail(`skill ${d.name}: missing SKILL.md`); continue; }
  const text = read(sk);
  const fm = frontmatter(text);
  if (fm?.name !== d.name) fail(`skill ${d.name}: frontmatter name "${fm?.name}" != directory name`);
  if (!/^description:[ \t]*\S/m.test(text)) fail(`skill ${d.name}: missing description (needed for auto-trigger)`);
  for (const m of text.matchAll(/subagent_type:\s*"([a-z][a-z-]*)"/g))
    if (!agentNames.has(m[1])) fail(`skill ${d.name}: references nonexistent agent "${m[1]}"`);
}

// ---- 3. Hooks: settings.json registration <-> files on disk ----
const settings = JSON.parse(read(path.join(ROOT, '.claude', 'settings.json')));
const registered = new Set();
for (const groups of Object.values(settings.hooks ?? {}))
  for (const g of groups)
    for (const h of g.hooks ?? []) {
      const m = h.command.match(/\.claude\/hooks\/([\w.-]+\.js)/);
      if (m) {
        registered.add(m[1]);
        if (!fs.existsSync(path.join(ROOT, '.claude', 'hooks', m[1]))) fail(`settings.json registers missing hook file: ${m[1]}`);
      }
    }
const readmeText = fs.existsSync(path.join(ROOT, 'README.md')) ? read(path.join(ROOT, 'README.md')) : '';
for (const f of fs.readdirSync(path.join(ROOT, '.claude', 'hooks')).filter((x) => x.endsWith('.js'))) {
  if (!registered.has(f)) {
    // block-*.js and the scope-lock guard chain are safety hooks — an unwired one silently
    // never fires, which is a real incident (not just drift). Everything else stays WARN.
    if (/^(block-|scope-guard|cmd-write-guard|approve-lock)/.test(f)) fail(`safety hook not registered in settings.json (never fires): ${f}`);
    else warn(`hook file not registered in settings.json: ${f}`);
  }
  if (readmeText && !readmeText.includes(f)) warn(`hook ${f} not documented in README (drift)`);
}
// every skill dir should be mentioned in README (doc completeness)
for (const d of fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()))
  if (readmeText && !readmeText.includes(d.name)) warn(`skill ${d.name} not mentioned in README (drift)`);

// commands are slash-invocable like skills → same doc-completeness guard
const commandsDir = path.join(ROOT, '.claude', 'commands');
if (fs.existsSync(commandsDir))
  for (const f of fs.readdirSync(commandsDir).filter((x) => x.endsWith('.md'))) {
    const cmd = f.replace(/\.md$/, '');
    if (readmeText && !readmeText.includes(cmd)) warn(`command ${cmd} not mentioned in README (drift)`);
  }

// every agent must have a documented tier in CLAUDE.md §2 (Model Tier Policy SOT)
const claudeMd = fs.existsSync(path.join(ROOT, 'CLAUDE.md')) ? read(path.join(ROOT, 'CLAUDE.md')) : '';
if (claudeMd)
  for (const name of agentNames)
    if (!claudeMd.includes(name)) fail(`agent ${name} has no tier in CLAUDE.md §2 (Model Tier Policy must own every agent's tier)`);

// ---- 3.5 v2 wiring invariants: state-dir deny + Bash matchers cover PowerShell ----
{
  // (b) The scope-lock state dir must be Claude-unwritable. permissions.deny is the only layer
  // that holds even under bypassPermissions — losing this entry disarms the whole lock.
  // CLI fact (observed 2026-08-02 warning): file-permission rules match Edit(path) ONLY, and
  // an Edit rule covers ALL file-editing tools (Write/NotebookEdit included); Write(path)/
  // NotebookEdit(path) deny entries are inert noise, so exactly the Edit form must be present.
  const denyList = settings.permissions?.deny ?? [];
  if (!denyList.includes('Edit(./.claude/state/**)'))
    fail('settings.json permissions.deny is missing "Edit(./.claude/state/**)" — .claude/state/ (scope-lock home) becomes Claude-writable and the lock is no longer tamper-proof (the Edit rule is the one that covers Write/NotebookEdit too)');
  // CLAUDE.md §1.11 switch file: user-edited only (ruling 2026-08-06) — Claude must not be able to
  // Edit it either, same tamper-proofing rationale/mechanism as the .claude/state entry above.
  if (!denyList.includes('Edit(./.claude/.fable-status)'))
    fail('settings.json permissions.deny is missing "Edit(./.claude/.fable-status)" — the CLAUDE.md §1.11 switch file becomes Claude-writable via the Edit tool, contradicting the 2026-08-06 ruling that only the user edits it');
  // (h) This Windows host exposes a PowerShell tool alongside Bash. A matcher that names Bash
  // without PowerShell leaves a full command bypass open (v1's gap).
  for (const [event, groups] of Object.entries(settings.hooks ?? {}))
    for (const g of groups) {
      const m = g.matcher ?? '';
      if (/\bBash\b/.test(m) && !/\bPowerShell\b/.test(m))
        fail(`settings.json ${event} matcher "${m}" covers Bash but not PowerShell — commands via the PowerShell tool bypass every hook in this group`);
    }

  // Record-layer wiring: the machine journal + session boundary markers must stay armed.
  const eventsOf = (needle) => {
    const evs = [];
    for (const [event, groups] of Object.entries(settings.hooks ?? {}))
      for (const g of groups)
        for (const h of g.hooks ?? [])
          if (h.command.includes(needle)) evs.push({ event, matcher: g.matcher ?? '' });
    return evs;
  };
  {
    const j = eventsOf('/journal.js').filter((e) => e.event === 'PostToolUse');
    if (!j.length) fail('journal.js is not registered under PostToolUse — the machine journal never records');
    else
      for (const need of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Task', 'ExitPlanMode'])
        if (!j.some((e) => e.matcher.includes(need)))
          fail(`journal.js PostToolUse matcher does not cover ${need} — those events vanish from the journal`);
    const sj = eventsOf('session-journal.js');
    for (const ev of ['SessionStart', 'SessionEnd'])
      if (!sj.some((e) => e.event === ev))
        fail(`session-journal.js is not registered under ${ev} — session boundary markers (crash detection) break`);
  }

  // Scope-lock chain wiring: all three hooks must stay armed on the right events/matchers.
  {
    const al = eventsOf('approve-lock.js');
    if (!al.some((e) => e.event === 'UserPromptSubmit'))
      fail('approve-lock.js is not registered under UserPromptSubmit — 「承認」/「解除」 can no longer arm/disarm the lock');
    const sg = eventsOf('scope-guard.js');
    if (!sg.some((e) => e.event === 'PreToolUse' && ['Edit', 'Write', 'NotebookEdit'].every((t) => e.matcher.includes(t))))
      fail('scope-guard.js is not registered under PreToolUse Edit|Write|NotebookEdit — locked-scope writes are no longer gated');
    const cw = eventsOf('cmd-write-guard.js');
    if (!cw.some((e) => e.event === 'PreToolUse' && e.matcher.includes('Bash') && e.matcher.includes('PowerShell')))
      fail('cmd-write-guard.js is not registered under PreToolUse Bash|PowerShell — the shell write pathway is unguarded');
  }
  // Guard-of-the-guard: cmd-write-guard must keep its unconditional .claude/state shell protection,
  // and the statusline must keep surfacing the lock (silent locks breed confusion). The same two
  // checks are mirrored for .claude/.fable-status (CLAUDE.md §1.11 switch, user-edited only per the
  // 2026-08-06 ruling): the shell-write protection must stay armed, and the statusline must keep
  // surfacing ON/OFF so a leftover ON from a previous session stays visible.
  {
    const cwPath = path.join(ROOT, '.claude', 'hooks', 'cmd-write-guard.js');
    if (fs.existsSync(cwPath) && !/\\?\.claude\[\\\\\/\]\+state|\.claude[\\/]+state/.test(read(cwPath)))
      fail('cmd-write-guard.js no longer references .claude/state — the unconditional lock-file shell protection is gone');
    if (fs.existsSync(cwPath) && !read(cwPath).includes('.fable-status'))
      fail('cmd-write-guard.js no longer references .claude/.fable-status — the unconditional switch-file shell protection is gone');
    const slPath = path.join(ROOT, '.claude', 'scripts', 'statusline.js');
    if (fs.existsSync(slPath) && !/scope-lock/.test(read(slPath)))
      fail('statusline.js no longer reads scope-lock — the 🔒 indicator is gone (locks become invisible)');
    if (fs.existsSync(slPath) && !read(slPath).includes('.fable-status'))
      fail('statusline.js no longer reads .claude/.fable-status — a leftover ON switch from a previous session becomes invisible');
  }
  // Authority-allowlist wiring (CLAUDE.md §2 ¹): block-review-floor.js must stay armed on
  // Task|Agent. The hook's executable Set literals must allow exactly fable/opus and must continue
  // naming all lower tiers as denied. Checking the literal bodies gives the requested mutation
  // power: deleting either allowed authority model or adding sonnet to the allowlist turns validate
  // RED even if the name remains elsewhere in comments/messages.
  {
    const rf = eventsOf('block-review-floor.js');
    if (!rf.some((e) => e.event === 'PreToolUse' && e.matcher.includes('Task') && e.matcher.includes('Agent')))
      fail('block-review-floor.js is not registered under PreToolUse Task|Agent — the review-authority fable|opus allowlist is no longer mechanically enforced');
    const rfPath = path.join(ROOT, '.claude', 'hooks', 'block-review-floor.js');
    if (fs.existsSync(rfPath)) {
      const rfText = read(rfPath);
      const allowedMatch = rfText.match(/ALLOWED_AUTHORITY_MODELS\s*=\s*new Set\(\[([^\]]*)\]\)/);
      if (!allowedMatch) {
        fail('block-review-floor.js: could not locate ALLOWED_AUTHORITY_MODELS = new Set([...]) — cannot verify the authority allowlist');
      } else {
        const allowed = [...allowedMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
        for (const name of ['fable', 'opus'])
          if (!allowed.includes(name))
            fail(`block-review-floor.js authority allowlist is missing "${name}" — that native authority model silently stops being accepted`);
        for (const name of allowed)
          if (!AUTHORITY_MODELS.has(name))
            fail(`block-review-floor.js authority allowlist contains forbidden model "${name}" — only fable | opus may hold authority`);
      }

      const deniedMatch = rfText.match(/DENIED_AUTHORITY_MODELS\s*=\s*new Set\(\[([^\]]*)\]\)/);
      if (!deniedMatch) {
        fail('block-review-floor.js: could not locate DENIED_AUTHORITY_MODELS = new Set([...]) — cannot verify named lower-tier denials');
      } else {
        for (const name of ['sonnet', 'haiku', 'inherit'])
          if (!new RegExp(`['"]${name}['"]`).test(deniedMatch[1]))
            fail(`block-review-floor.js no longer names "${name}" in DENIED_AUTHORITY_MODELS — the policy drift becomes invisible`);
      }
    }
  }
  // Fable ON/OFF gate wiring (CLAUDE.md §1.11): block-fable-when-off.js must stay armed on
  // Task|Agent so every subagent dispatch (not just authority roles — Ruling B) is checked.
  // Checking the literal body gives the requested mutation power: deleting the switch read,
  // widening the gated model beyond fable, or loosening the ON comparison to a substring test
  // each turn validate RED.
  {
    const bf = eventsOf('block-fable-when-off.js');
    if (!bf.some((e) => e.event === 'PreToolUse' && e.matcher.includes('Task') && e.matcher.includes('Agent')))
      fail('block-fable-when-off.js is not registered under PreToolUse Task|Agent — Fable dispatches are no longer gated');
    const bfPath = path.join(ROOT, '.claude', 'hooks', 'block-fable-when-off.js');
    if (fs.existsSync(bfPath)) {
      const bfText = read(bfPath);
      if (!bfText.includes('.fable-status'))
        fail('block-fable-when-off.js no longer reads .claude/.fable-status — the gate has no switch');
      const gatedMatch = bfText.match(/GATED_MODEL\s*=\s*['"]([^'"]+)['"]/);
      if (!gatedMatch || gatedMatch[1] !== 'fable')
        fail('block-fable-when-off.js GATED_MODEL no longer resolves to exactly "fable" — the gate no longer targets the model it exists to limit');
      if (!bfText.includes("=== 'ON'"))
        fail("block-fable-when-off.js no longer does an exact === 'ON' switch comparison — a substring/any-content test would let arbitrary content enable Fable");
    }
  }

  // Deliberation gate wiring (CLAUDE.md §1.12 / T2.4a): deliberation-gate.js must stay armed on
  // PostToolUse Task|Agent so a top-level dispatch's report can be screened. This hook is
  // fail-open and non-blocking (a nudge, not enforcement) — it is deliberately NOT added to the
  // ^(block-|scope-guard|...) safety-hook regex above (:175): naming it a safety hook there would
  // misdescribe a hook that can never deny a tool call. This explicit check is what FAILs if it is
  // unwired or deleted, instead of silently falling back to a WARN.
  {
    const dg = eventsOf('deliberation-gate.js');
    if (!dg.some((e) => e.event === 'PostToolUse' && e.matcher.includes('Task') && e.matcher.includes('Agent')))
      fail('deliberation-gate.js is not registered under PostToolUse Task|Agent — the CLAUDE.md §1.12 hook nudge never fires');
  }

  // ---- 3.6 CLI version floor: Edit(path)-covers-Write/NotebookEdit precondition ----
  // The state-dir/switch-file tamper-proofing above (this section, (b)) rests entirely on a CLI
  // fact recorded at settings.json permissions.deny check time: a permissions.deny Edit(path)
  // rule is the ONLY form file-permission checks consult, and it covers Write/NotebookEdit too —
  // confirmed for Claude Code >=2.1.210 (this repo's dev install: 2.1.222). Below that floor the
  // fact is unverified; the Edit(...) deny rule could silently stop covering Write/NotebookEdit,
  // and nothing else in this validator would notice, because it only inspects settings.json text,
  // never the running CLI's actual behavior. WARN only (an environmental precondition, not a repo
  // defect) and fails open: if `claude --version` cannot be run or its output cannot be parsed,
  // that is not evidence of a stale version, so no warning is emitted.
  {
    const VERSION_FLOOR = [2, 1, 210];
    try {
      // `claude` resolves to a platform-specific shim (a POSIX shell script on this host, a
      // .cmd/.ps1 pair on Windows generally) that plain execFileSync(file, args) cannot exec
      // directly on Windows (observed: .cmd → EINVAL, .ps1 → EFTYPE, no-extension → ENOENT).
      // shell:true resolves it correctly; passing the whole command as the `file` string with an
      // empty args array (rather than a separate args array) avoids Node's DEP0190 shell-arg
      // deprecation warning, which would otherwise print to stderr and pollute this report.
      // timeout:5000 backs the "failed/timed out" fail-open below with real enforcement — Node
      // does not kill a hung child process on its own (observed: an unbounded child ran well past
      // 3s uncaught). env adds NoDefaultCurrentDirectoryInExePath=1 because shell:true on Windows
      // runs via cmd.exe, which resolves the command against the current directory before PATH —
      // without this, a claude.cmd dropped in the repo root would run instead of the real CLI
      // (observed: resolution changes with this var; it is not set system-wide on this host).
      const out = execFileSync('claude --version', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, timeout: 5000, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } });
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) {
        const cur = m.slice(1, 4).map(Number);
        const below =
          cur[0] < VERSION_FLOOR[0] ||
          (cur[0] === VERSION_FLOOR[0] && cur[1] < VERSION_FLOOR[1]) ||
          (cur[0] === VERSION_FLOOR[0] && cur[1] === VERSION_FLOOR[1] && cur[2] < VERSION_FLOOR[2]);
        if (below)
          warn(`claude --version reports ${cur.join('.')}, below the ${VERSION_FLOOR.join('.')} floor — the Edit(path)-covers-Write/NotebookEdit CLI behavior that settings.json's "Edit(./.claude/state/**)" / "Edit(./.claude/.fable-status)" deny rules rely on is unverified on this CLI version`);
      }
    } catch {
      // claude CLI not on PATH, or --version failed/timed out — cannot check, fail open (no warn).
    }
  }
}

// ---- 4. Dead references in core docs/config ----
// The real-model-id patterns and the /wrap skill-name pattern are named (not inline) so a single
// file can be exempted from exactly the entry below, without touching the array literal itself.
const REAL_ID_BARE = [/\bclaude-(?:fable|opus|sonnet|haiku)-[\d]/i, 'a pinned real Claude model id was found (fable/opus/sonnet/haiku directly followed by a digit) — model: must use a native alias or a clover claude-<alias> id from clover/models.json, never a real id (breaks on version bumps)'];
const REAL_ID_GEN = [/\bclaude-\d(?:-\d+)?-(?:fable|opus|sonnet|haiku)-(?:\d{8}|latest)\b/i, 'a pinned real Claude model id was found (generation-first spelling, e.g. claude-3-5-sonnet-20241022 or claude-3-opus-20240229) — model: must use a native alias or a clover claude-<alias> id from clover/models.json, never a real id (breaks on version bumps)'];
const REAL_ID_VERTEX = [/\bclaude-\d(?:-\d+)?-(?:fable|opus|sonnet|haiku)(?:-v\d+)?@\d{8}\b/i, 'a pinned real Claude model id was found (Vertex AI @-date spelling, e.g. claude-3-5-sonnet-v2@20241022 or claude-3-opus@20240229) — model: must use a native alias or a clover claude-<alias> id from clover/models.json, never a real id (breaks on version bumps)'];
const WRAP_SKILL_REF = [/(?:^|[^\w/])\/wrap\b/, 'there is no /wrap skill — the enhanced /save-session owns the report/save flow'];
const FORBIDDEN = [
  [/\bcode-reviewer\b/, 'agent "code-reviewer" does not exist (use reviewer target: code)'],
  [/\bplan-(lite|full)\b/, 'skill plan-lite/plan-full was merged into "plan"'],
  [/\.codex\//, 'Codex CLI config paths must not be referenced by harness docs'],
  [/\.claude\/clover/, 'clover lives at the repo root (clover/) in v2 — the .claude/clover path is dead'],
  [/\bCLAUDE_JP\b/, 'CLAUDE_JP.md was removed'],
  [/\baddons?\b/, 'addons subsystem was removed (intentional) — do not reference it'],
  [/(?:^|[^\w/])\/improve\b|skills\/improve\b/, 'the /improve unattended self-improvement loop was removed in v2 — improvements go through normal user requests'],
  [/(?:^|[^\w/])\/checkpoint\b|commands\/checkpoint\b/, 'the /checkpoint command was removed in v2 — native /rewind covers it'],
  [/skills\/audit\b|(?:^|[^\w/])\/audit\b/, 'the audit skill was folded into quality-loop (request the security track: 「quality-loop でセキュリティ観点でも厳しく検査」)'],
  WRAP_SKILL_REF,
  [/frontier dispatch override/i, 'renamed to "frontier authority convention" — the override no longer exists (CLAUDE.md §2 ¹)'],
  [/\borchestrate\b/, 'skill "orchestrate" was renamed to "harness"'],
  [/\bslop-clean\b/, 'skill "slop-clean" was renamed to "code-cleaner"'],
  [/\barchive-session-state\b/, 'the archive-session-state.js hook was removed 2026-08-13 (session-persistence.md §6.2) — session-state.md is now a 2-line pointer with nothing left to archive'],
  REAL_ID_BARE,
  REAL_ID_GEN,
  REAL_ID_VERTEX,
  // todo-gate-sweep M-2 (2026-08-07): a path-form reference to the pre-"-v2" repo name (this
  // repo is my-claude-base-v2) — scoped to the path shape specifically (immediately followed by
  // \ or /, not already followed by -v2) so it does not false-positive on the project's own
  // "my-claude-base v2" heading (space-separated) or the unrelated "added for my-claude-base."
  // attribution line repeated across the imagegen/frontend-design skill files.
  [/my-claude-base[\\/](?!v2\b)/, 'a dead reference to the pre-"-v2" repo path was found (my-claude-base\\ or my-claude-base/ not followed by -v2) — this repo is my-claude-base-v2, update the path'],
];
// Test fixture, not config/docs: hook-probes.samples.json rows intentionally carry the exact
// forbidden-shaped strings a hook must reject (e.g. "model":"claude-fable-5" pins the H-1
// real-id-spelling regression) — the opposite of silently hardcoding a real model id, it is the
// value under test. Backtick-citing per row (the CITATION_WORD exemption below) would corrupt the
// literal JSON payload the hook actually reads, so this file gets a narrow exemption instead: keyed
// on the specific FORBIDDEN entry (REAL_ID_BARE/REAL_ID_GEN/REAL_ID_VERTEX only, by reference — see
// the loop below), not on the file path alone. Every OTHER FORBIDDEN pattern (dead skill/agent refs,
// removed subsystems, etc.) still fully applies to this file, unlike a blanket per-file skip.
const REAL_ID_EXEMPT_ENTRIES = new Set([REAL_ID_BARE, REAL_ID_GEN, REAL_ID_VERTEX]);
const SAMPLES_FIXTURE_PATH = path.join(ROOT, '.claude', 'hooks', 'lib', 'hook-probes.samples.json');
// Auto-generated npm manifest, not hand-authored docs/config: package-lock.json's dependency tree
// legitimately contains an npm registry URL segment ".../-/wrap-ansi-9.0.2.tgz" whose "-/wrap"
// substring collides with the WRAP_SKILL_REF dead-ref pattern (confirmed by running the scan with
// no exemption: exactly one collision, this file, this pattern). Real deps churn over time, so this
// exemption is keyed the same way REAL_ID_EXEMPT_ENTRIES is — one specific FORBIDDEN entry, by
// reference, for one specific file — not a path-substring skip that would also exempt
// statusline.js/package.json (and everything else under .claude/scripts/) from all ~15 patterns.
const PACKAGE_LOCK_EXEMPT_ENTRIES = new Set([WRAP_SKILL_REF]);
const PACKAGE_LOCK_PATH = path.join(ROOT, '.claude', 'scripts', 'package-lock.json');
// Side effect: ALLOW_LINE is a line-level exemption, not a pattern-level one — a line matching
// any word here is skipped against every FORBIDDEN pattern above, not just the one that
// motivated the addition. Widening this regex silently widens the exemption for the whole list.
const ALLOW_LINE = /旧|former|formerly|renamed|previously|removed|削除|廃止|merged|統合|does not exist|dead|must not be referenced/; // allow history/explanatory text (JA/EN) and this validator's own wording
// Narrower citation exemption (kept separate from ALLOW_LINE on purpose): forbidden/禁止/collide
// mark a line that is *explaining* a real id (e.g. "`claude-opus-4-8` is forbidden") rather than
// pinning one, but a blanket line-level exemption on these three common words would let a real id
// planted anywhere on such a line slip past every FORBIDDEN pattern. So this only exempts a
// FORBIDDEN match whose own matched text sits inside `backticks` on a line that also carries one
// of these words — the citation must be visibly quoted, not just co-located with the word. This
// is deliberately narrower than ALLOW_LINE above and only ever suppresses the single matched
// substring, never the rest of the line's checks.
const CITATION_WORD = /forbidden|禁止|collide/;
const inBackticks = (line, index, len) => {
  const backticksBefore = (line.slice(0, index).match(/`/g) || []).length;
  return backticksBefore % 2 === 1 && line.slice(index + len).includes('`');
};
const scan = [path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'README.md')];
// Vendored code sub-projects are code, not harness docs/config — exclude them from the harness
// dead-ref scan (clover legitimately references e.g. ~/.codex/ for codex OAuth).
const SUBPROJECTS = new Set([path.join(ROOT, 'clover')]);
const walkMd = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SUBPROJECTS.has(p) && e.name !== 'node_modules') walkMd(p); }
    else if (/\.(md|js|json|html)$/.test(e.name)) scan.push(p);
  }
};
walkMd(path.join(ROOT, '.claude'));
// docs/claude-harness-guide/**: the user-facing harness guide, same dead-ref scan as .claude/.
// docs/ itself is NOT walked (walkMd is non-recursive-root, called per subdir): docs/settings-reference.html
// and docs/weasyprint-setup.html are reference material for external products (Claude Code's own
// settings spec; WeasyPrint) that this repo does not own, and settings-reference.html carries a real
// release-history section — scanning it would flag accurate historical text as a dead reference.
walkMd(path.join(ROOT, 'docs', 'claude-harness-guide'));
for (const p of scan) {
  if (!fs.existsSync(p)) continue;
  const lines = read(p).split('\n');
  lines.forEach((line, i) => {
    if (ALLOW_LINE.test(line)) return;
    for (const entry of FORBIDDEN) {
      // Narrow per-entry exemptions (see REAL_ID_EXEMPT_ENTRIES / PACKAGE_LOCK_EXEMPT_ENTRIES
      // above): only these specific (file, pattern) pairs are skipped — every other FORBIDDEN
      // entry still runs against these files. No file gets a blanket exemption from the whole list.
      if (p === SAMPLES_FIXTURE_PATH && REAL_ID_EXEMPT_ENTRIES.has(entry)) continue;
      if (p === PACKAGE_LOCK_PATH && PACKAGE_LOCK_EXEMPT_ENTRIES.has(entry)) continue;
      const [re, why] = entry;
      // Check every match of this pattern on the line, not just the first — a line can carry a
      // legitimately-cited backticked id AND a bare (non-exempt) one; stopping at the first match
      // would let the second slip through unexamined once the first is exempted.
      const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of line.matchAll(reG)) {
        if (CITATION_WORD.test(line) && inBackticks(line, m.index, m[0].length)) continue;
        fail(`dead ref ${rel(p)}:${i + 1} — ${why}\n      ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  });
}

// ---- 5. Rules: paths frontmatter present (else the rule never triggers) ----
const rulesDir = path.join(ROOT, '.claude', 'rules');
if (fs.existsSync(rulesDir))
  for (const f of fs.readdirSync(rulesDir).filter((x) => x.endsWith('.md'))) {
    const t = read(path.join(rulesDir, f));
    const fm = (t.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    if (!/^paths:\s*$/m.test(fm) || !/^\s*-\s+\S/m.test(fm))
      fail(`rule ${f}: missing a non-empty paths: frontmatter list (a path-scoped rule with no globs never fires)`);
    const name = f.replace(/\.md$/, '');
    if (claudeMd && !claudeMd.includes(name)) warn(`rule ${name} not listed in CLAUDE.md §8 (drift)`);
  }

// ---- 6. Invariant canaries: safety-critical phrases that must never silently vanish ----
// Inverse of #4 FORBIDDEN: some policy lives only as prose with no code to enforce it, so an
// edit that drops the wording removes the guarantee with nothing to catch it. Entries are added
// in the build phase that creates their subject file (a canary for a not-yet-created file would
// otherwise hard-fail every earlier phase).
const INVARIANTS = [
  ['CLAUDE.md', /authority allowlist is exactly native `fable \| opus`/i, 'CLAUDE.md must keep the exact native Fable-or-Opus authority allowlist'],
  ['CLAUDE.md', /Critical Partnership/, 'CLAUDE.md §1.10 "Critical Partnership" section heading must remain present'],
  ['CLAUDE.md', /Objections require evidence/, 'CLAUDE.md §1.10 must still state the evidence-backed objection sentence — dropping it silently reverts the harness to yes-manning or unsupported contrarianism'],
  ['CLAUDE.md', /hypotheses, not orders/, 'CLAUDE.md §1.10\'s framing of development requests as hypotheses, not orders must remain'],
  ['CLAUDE.md', /never (added|folds?|folded) .*into scope|never fold them into scope/i, 'CLAUDE.md §1.10 must still state that gap proposals are never folded into scope without a ruling'],
  ['CLAUDE.md', /worker reads (them|PLAN\.md.*itself)|reads them itself/i, 'CLAUDE.md §2 must still state the scope-handoff rule (workers read PLAN.md/scope.json themselves — no paraphrase)'],
  ['.claude/commands/save-session.md', /やったこと[\s\S]*できなかったこと・保留[\s\S]*確認してほしいこと[\s\S]*次にやること/, 'save-session must keep the fixed 4-section report headings (やったこと / できなかったこと・保留 / 確認してほしいこと / 次にやること)'],
  ['.claude/commands/save-session.md', /SAVE マーカー/, 'save-session must keep the SAVE-marker step — the crash/unreported-session scan keys on it'],
  ['.claude/rules/session-persistence.md', /never rotated or deleted/i, 'session-persistence §6.2 must keep stating that tasks/history/ (the frozen pre-2026-08-13 session-state.md archive) is never rotated or deleted — this only catches the phrase disappearing, not a reversal of the guarantee it names'],
  // --- carried from v1 (subject files exist as of Phase 4) ---
  ['.claude/skills/quality-loop/SKILL.md', /Opus×2/, 'quality-loop must keep Opus×2 as the standing same-model authority pair (the default while the CLAUDE.md §1.11 gate is OFF)'],
  ['.claude/skills/quality-loop/SKILL.md', /Fable×2/, 'quality-loop must keep Fable×2 as the gated same-model authority pair (permitted only while the CLAUDE.md §1.11 gate is ON)'],
  ['.claude/skills/quality-loop/SKILL.md', /never a mixed pair/i, 'quality-loop must explicitly forbid mixed Fable/Opus standing pairs'],
  ['.claude/skills/quality-loop/SKILL.md', /Never switch silently/i, 'quality-loop must forbid silently falling back from a failed Opus authority dispatch to Fable'],
  ['.claude/skills/quality-loop/SKILL.md', /sonnet[\s`/,-]+haiku[\s`/,-]+inherit[\s\S]{0,80}forbidden/i, 'quality-loop must keep lower-tier authority models forbidden'],
  ['.claude/agents/reviewer.md', /adversarial verification/i, 'reviewer.md must still carry the "Adversarial Verification" section heading'],
  ['.claude/agents/reviewer.md', /green-on-mutation/i, 'reviewer.md\'s mutation-check bullet ("Green-on-mutation = the test has no detection power") must remain present'],
  ['.claude/agents/reviewer.md', /defect-class checklist/i, 'reviewer.md\'s "Defect-Class Checklist" heading must remain present'],
  ['.claude/skills/quality-loop/SKILL.md', /red-team lens/i, 'quality-loop must still contain the phrase "red-team lens"'],
  ['.claude/skills/quality-loop/SKILL.md', /Red-Team Second Seat \(standing, relay-independent\)/, 'quality-loop\'s "Red-Team Second Seat (standing, relay-independent)" definition heading must remain present'],
  ['.claude/agents/planner.md', /Gap proposals await a ruling/, 'planner.md must still state that gap proposals await a ruling before being folded into the plan (CLAUDE.md §1.10 boundary)'],
  ['.claude/skills/plan/SKILL.md', /Objections & Rulings[\s\S]*Objections & Rulings/, 'plan SKILL.md must still carry both "Objections & Rulings" record sections (light-path and heavy-path templates)'],
  // --- v2 scope-lock chain (Phase 4 subjects) ---
  ['.claude/skills/plan/SKILL.md', /scope\.json/, 'plan SKILL.md must still require the scope.json artifact — without it approval has nothing to lock'],
  ['.claude/skills/plan/SKILL.md', /『承認』と返信するとロックして自走を開始します/, 'plan SKILL.md must keep the exact approval-handoff sentence the approve-lock hook flow depends on'],
  ['.claude/skills/harness/SKILL.md', /worker must read PLAN\.md\/scope\.json itself/, 'harness Handoff Protocol must keep the scope-handoff rule (workers read the plan themselves — no paraphrase)'],
  ['.claude/agents/reviewer.md', /Scope Conformance/, 'reviewer.md must keep the Scope Conformance dimension (out-of-scope diff = HIGH) — the review-side scope backstop'],
  ['.claude/agents/executor.md', /\[scope-lock\]/, 'executor.md must keep the scope-lock denial protocol (no workaround; deviations + report)'],
  ['.claude/agents/debugger.md', /\[scope-lock\]/, 'debugger.md must keep the scope-lock denial protocol (no workaround; deviations + report)'],
  ['.claude/agents/document-author.md', /\[scope-lock\]/, 'document-author.md must keep the scope-lock denial protocol (no workaround; deviations + report)'],
  ['.claude/agents/executor.md', /detection power/i, 'executor.md must keep the detection-power duty (RED->restore->GREEN test-power check) from the 4 recurring review-gap classes'],
  ['.claude/agents/executor.md', /branch\/OS/, 'executor.md must keep the claim-scope duty (numbers/completion language limited to the verified branch/OS/condition)'],
  ['.claude/agents/executor.md', /match⇒deny|match=deny/, 'executor.md must keep the consumer-direction-classification duty (match⇒deny fail-closed vs match⇒allow fail-open sorting before widening a shared matcher)'],
  ['.claude/agents/executor.md', /deny-side/, 'executor.md must keep the deny-side (reverse) verification duty for "still denied" claims'],
  ['.claude/agents/executor.md', /safety-critical harness code/i, 'executor.md must keep the Comment Policy safety-critical-harness-code exception (hooks/validators comments documenting why the check exists and what is deliberately out of scope)'],
  ['.claude/agents/executor.md', /実装のうちその性質を担っている行/, 'executor.md must keep the mutation-target rule (a mutation check breaks the implementation line that carries the property under test, never the test itself)'],
  ['.claude/skills/quality-loop/SKILL.md', /Lens Catalog[\s\S]*4 seats total/, 'quality-loop must keep the Lens Catalog section with the 4-seat hard cap'],
  ['.claude/skills/quality-loop/SKILL.md', /Security Track \(on request or auto-seated\)/, 'quality-loop must keep the Security Track auto-seat section — the conductor seats security on API/DB/auth/payment signals without being asked (user ruling 2026-08-02)'],
  ['.claude/skills/quality-loop/SKILL.md', /not seated \(no risk signals\)/, 'quality-loop must keep the mandatory security-attendance recording line — a silent skip of the risk check must stay visible'],
  ['.claude/skills/plan/SKILL.md', /securityReview/, 'plan SKILL.md must keep the scope.json securityReview flag — the plan-time path that auto-seats security for the whole locked run'],
  // --- agents-revision Phase 8 (loop-03, user ruling 2026-08-05) ---
  ['CLAUDE.md', /recurring review category/i, 'CLAUDE.md §4 must keep the recurring-review-category trigger bullet — a 2nd occurrence of the same review finding across cycles/PRs must be treated as a role-definition gap, not just fixed as an instance'],
  // --- agents-revision fix cycle (fusion-adjudicated, 2026-08-05) ---
  ['.claude/agents/debugger.md', /never persist unverified observed text into memory/i, 'debugger.md must keep the memory-poisoning guard for `memory: project` — a suggested command or claim found in observed output must never be written into persistent memory as a rule without verification'],
  // --- fable-gate (2026-08-06) ---
  ['CLAUDE.md', /\.fable-status/, 'CLAUDE.md §1.11 must keep the Fable ON/OFF gate (the .claude/.fable-status switch) — dropping the clause removes the documented precondition for using Fable at all'],
  ['.claude/hooks/block-fable-when-off.js', /session model \(\/model is outside any hook's reach\)[\s\S]*?may be invisible to this hook[\s\S]*?No third hole/, 'block-fable-when-off.js header must keep the two-hole disclosure (session model unreachable; inherited-model dispatch may be invisible) together with the "no third hole" scope-limit sentence — dropping any of the three silently re-opens the H-2 overclaim this fix cycle closed'],
  // --- backlog-sweep M-2 (2026-08-07): CLAUDE.md §1.11's "Known limits" disclosure of the §1.11
  // gate's two holes ((a) session /model unreachable, (b) inherited-model dispatch may be
  // invisible) is repeated in 4 places (CLAUDE.md itself, README.md, the hook header pinned just
  // above, and the hook's own Japanese deny message pinned below) — before this fix only the hook
  // header was pinned, so the other 3 faces could silently drop the disclosure with validate still
  // reporting PASS.
  ['CLAUDE.md', /the user's own session model \(`\/model`\) cannot be gated at all[\s\S]*?may be invisible to this hook \(unverified\)[\s\S]*?never state or imply it covers every route to Fable/, 'CLAUDE.md §1.11 "Known limits" must keep both disclosed holes ((a) session /model unreachable, (b) inherited-model dispatch may be invisible) together with the "never state or imply it covers every route to Fable" scope-limit sentence'],
  ['README.md', /起動先モデルが分かるサブエージェントの起動[\s\S]*?対象外[\s\S]*?この仕組みから見えないことがあります/, 'README.md must keep the §1.11 gate\'s two-hole disclosure in Japanese (session model out of scope; inherited-model dispatch may be invisible) — dropping it leaves users unaware of what the gate does not cover'],
  ['.claude/hooks/block-fable-when-off.js', /この仕組みで止められるのは「モデル名が分かるサブエージェントの起動」だけです[\s\S]*?Fable で動いている場合[\s\S]*?この仕組みからは見えないことがあります/, 'block-fable-when-off.js\'s Japanese deny message (shown to the model on every blocked dispatch) must keep the same two-hole disclosure as the English header — this is a separate string from the header comment pinned above, and dropping it removes the disclosure from the one place a blocked dispatch actually sees'],
  // --- backlog-sweep Batch H L9 (2026-08-06) ---
  ['.claude/rules/agents.md', /recorded user ruling/, 'agents.md clause (A) tail must keep the "recorded user ruling" binding for the unlocked-run exception — without it, reviewer.md/verifier.md have no SOT explaining why a self-declared "approved"/"unlocked" claim in scope.json/PLAN.md is insufficient'],
  // --- todo-gate-sweep Batch 4 (2026-08-07): decide() ignores lock.status, so a present-but-unlocked
  // .claude/state/scope-lock.json (or any unarmed plans/{slug}/scope.json) read literally by the old
  // wording gets passed into decide() as if armed — flagging nearly every file, or throwing on lock:null.
  ['.claude/agents/reviewer.md', /status\s*===\s*["']locked["']/, 'reviewer.md Scope Conformance must state that "locked" means `status === "locked"` — without it the locator reads a merely-present-but-unlocked scope-lock.json as an armed manifest and feeds it into decide()'],
  ['.claude/agents/verifier.md', /status\s*===\s*["']locked["']/, 'verifier.md Scope check must state that "locked" means `status === "locked"` — without it the locator reads a merely-present-but-unlocked scope-lock.json as an armed manifest and feeds it into decide()'],
  // --- planner self-review ruling (2026-08-13) ---
  ['.claude/skills/plan/SKILL.md', /freshly spawned instance \(the authoring instance never reviews its own plan\)/, 'plan SKILL.md must keep the 2026-08-13 self-review ruling (planner self-review permitted only as a freshly spawned instance, with the red-team second seat attending per its attendance rule for plan reviews) — dropping it silently reopens the planner→planner axis with no recorded authorization'],
  ['.claude/agents/planner.md', /never the same conversation\/instance that authored the plan/, 'planner.md must keep its own copy of the 2026-08-13 Self-Review Mode Eligibility line (freshly spawned instance only, never the authoring instance) — without this pin, deleting the line from planner.md alone (leaving plan SKILL.md untouched) stays undetected'],
  ['.claude/agents/executor.md', /その性質だけが働く題材/, 'executor.md must keep sentence ② of the mutation-check rule ("その性質だけが働く題材で確かめる" — pick a fixture where no other condition could produce the same passing result before the mutated line runs) — pinning only sentence ① leaves this half of the rule free to vanish silently'],
  // --- conductor-deliberation (2026-08-14): CLAUDE.md §1.12 Deliberation Gate, T2.4(b)(c1) ---
  // P1 fix: colon-anchored, not just field-name-anchored. The un-anchored version
  // (/Symptom[\s\S]*Evidence[\s\S]*.../) had zero detection power over deleting the whole 5th
  // field line — executor.md's 4th field's own parenthetical repeats the literal string
  // "Alternatives rejected" ("write N/A + pointer to Alternatives rejected if no fix exists"), so
  // the old pin's terminal token bound to that pointer instead of the field it was meant to
  // guard. Anchoring each name to its trailing colon forces a match on the FIELD LABEL, not any
  // incidental mention of the same words. Residual disclosed, not fixed: this still has zero
  // power over a report that fabricates all five colon-terminated labels as bare words with no
  // real content beneath them (e.g. a single line "Symptom: Evidence: Root-cause hypothesis: Why
  // this fix addresses the cause: Alternatives rejected:") — pinning report SUBSTANCE, not just
  // structure, is out of scope for a text-regex validator.
  ['.claude/agents/executor.md', /Symptom:[\s\S]*Evidence:[\s\S]*Root-cause hypothesis:[\s\S]*Why this fix addresses the cause:[\s\S]*Alternatives rejected:/, 'executor.md must keep the ordered 5-field error/change-of-approach report shape (Symptom: -> Evidence: -> Root-cause hypothesis: -> Why this fix addresses the cause: -> Alternatives rejected:) — CLAUDE.md §1.12\'s producer-side contract depends on this exact order'],
  // T2.4(c2): the hook header's own 3-part disclosure (fail-open guarantee, threat-model line, A8
  // sentence) — same structural-phrases-only rule as (c1) above.
  ['.claude/hooks/deliberation-gate.js', /Fail-open, unconditionally[\s\S]*No payload-derived value[\s\S]*is EVER interpolated[\s\S]*フックが出なかったことは「問題なし」の意味ではない/, 'deliberation-gate.js header must keep its 3-part disclosure (fail-open guarantee, threat-model no-interpolation line, A8 sentence) — losing any one silently drops that guarantee from the one place a reader of the hook itself would see it'],
];
for (const [relPath, must, why] of INVARIANTS) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) { fail(`invariant: ${relPath} missing — cannot verify "${why}"`); continue; }
  if (!must.test(read(p))) fail(`invariant lost in ${relPath} — ${why} (expected /${must.source}/${must.flags})`);
}

// ---- 6.1 CLAUDE.md §1.12 Deliberation Gate: per-item pins SCOPED to the section (U1) ----
// The old single chained-regex pin (c1) anchored on 3 phrases with [\s\S]* between them, spanning
// the WHOLE FILE — so a 2-line gutted §1.12 (heading + one menu line + the A8 sentence) still
// matched, and even a FULL deletion of §1.12 with the 3 phrases relocated into a stray comment
// elsewhere in the file still matched. Extract just the §1.12 block (heading to the next ###
// heading or the --- separator) and check each load-bearing item against THAT substring only, so
// gutting or relocating content outside the section is caught.
{
  const claudeMdPath = path.join(ROOT, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) fail('CLAUDE.md missing — cannot verify §1.12 Deliberation Gate section');
  else {
    const m = read(claudeMdPath).match(/### 1\.12 Deliberation Gate[\s\S]*?(?=\n### |\n---)/);
    if (!m) fail('CLAUDE.md §1.12 Deliberation Gate heading not found (or the section is not terminated before the next ### heading / --- separator) — U1');
    else {
      const section = m[0];
      const items = [
        [/hypothesis, not a diagnosis/i, 'the hypothesis-not-diagnosis framing'],
        [/Dispatcher-generic/, 'the dispatcher-generic binding statement'],
        [/①accept only with root-cause evidence[\s\S]*④escalate to replan/, 'the conductor 4-option menu'],
        [/Worker-adapted menu[\s\S]*Returning to the plan is the conductor's move only/, 'the worker-adapted 3-option menu'],
        [/Symptom-level fixes[\s\S]*need named rejected alternatives/, 'the symptom-fix rule'],
        [/sent back on structure alone, before its content is weighed/, 'the structural send-back rule'],
        [/フックが出なかったことは「問題なし」の意味ではない/, 'the A8 disclosure sentence'],
      ];
      for (const [re, label] of items)
        if (!re.test(section)) fail(`CLAUDE.md §1.12 is missing ${label} — U1 (the old c1 pin could not tell a live section from a gutted or relocated one)`);
    }
  }
}

// ---- 6.2 deliberation-gate.js INJECTED_TEXT: per-line pins + emission-line shape (P2) ----
// Two independent gaps closed here. B's probe: gutting INJECTED_TEXT's value to a one-line
// placeholder passed 21/21 GREEN + validate PASS, because c2 (T2.4(c2), above) pins only the
// HEADER COMMENT and V12 only diffs the P/S family arrays — nothing pinned this constant's own
// content. C's probe: a 5-line hollowed hook (the three c2-pinned header phrases plus a bare
// process.exit(0), nothing else) also passed all four validate checks, because nothing pinned the
// ACTUAL emission call site. Scoped to the constant's own declaration (not the whole file) so
// relocating the phrases into a stray comment elsewhere doesn't count.
{
  const hookPath = path.join(ROOT, '.claude', 'hooks', 'deliberation-gate.js');
  if (!fs.existsSync(hookPath)) fail('deliberation-gate.js missing — cannot verify INJECTED_TEXT invariants (P2)');
  else {
    const hookText = read(hookPath);
    const m = hookText.match(/const INJECTED_TEXT =[\s\S]*?;\n/);
    if (!m) fail('deliberation-gate.js: INJECTED_TEXT constant declaration not found (expected "const INJECTED_TEXT = ...;") — P2');
    else {
      const constText = m[0];
      const lines = [
        [/①根本原因の証拠（ログ・再現手順・差分）が示されていれば受け入れる/, 'menu item ①'],
        [/②示されていなければ原因究明をやり直させる/, 'menu item ②'],
        [/③debugger に投げ直す/, 'menu item ③'],
        [/④前提そのものが崩れているなら計画に戻す/, 'menu item ④'],
        [/症状だけを消す修正[\s\S]*却下した代替案とその理由が書かれている場合だけです/, 'the symptom-fix rule line'],
        [/エラー・方針変更の報告であれば[\s\S]*構造として差し戻してください/, 'the structural send-back line'],
      ];
      for (const [re, label] of lines)
        if (!re.test(constText)) fail(`deliberation-gate.js INJECTED_TEXT is missing ${label} — P2 (a gutted constant previously passed validate because nothing pinned this constant's own content)`);
    }
    if (!/additionalContext:\s*INJECTED_TEXT\s*\}/.test(hookText))
      fail('deliberation-gate.js: the additionalContext: INJECTED_TEXT emission call is missing or no longer a bare reference (template literal / concatenation / hollowed-out hook) — P2 (a hollowed hook with only header comments previously passed all four validate checks)');
  }
}

// ---- 6.3 A8 disclosure sentence: cross-face equality (U4) ----
// The sentence is required verbatim on CLAUDE.md §1.12, README.md, and the hook header (PLAN.md's
// A8 spec) — each face was individually pinned to CONTAIN it, but nothing checked that the three
// copies actually AGREE with each other, so they could drift silently on a future re-measurement
// (B1) if only one face were edited. Strip markdown **bold** (README wraps the tail in it) and the
// hook's "// " comment-continuation prefix (its copy wraps across two comment lines) before
// comparing, so those two cosmetic differences don't count as drift.
{
  const A8_RE = /ルールは委任した側すべてを縛る。[\s\S]*?フックが出なかったことは「問題なし」の意味ではない/;
  const norm = (s) => s.replace(/\*\*/g, '').replace(/\n\s*\/\/\s*/g, '').trim();
  const faces = [
    ['CLAUDE.md', path.join(ROOT, 'CLAUDE.md')],
    ['README.md', path.join(ROOT, 'README.md')],
    ['.claude/hooks/deliberation-gate.js', path.join(ROOT, '.claude', 'hooks', 'deliberation-gate.js')],
  ];
  const found = [];
  for (const [label, p] of faces) {
    if (!fs.existsSync(p)) { fail(`${label} missing — cannot verify the A8 disclosure sentence (U4)`); continue; }
    const m = read(p).match(A8_RE);
    if (!m) { fail(`${label} is missing the A8 disclosure sentence — U4 cross-face check`); continue; }
    found.push([label, norm(m[0])]);
  }
  for (let i = 1; i < found.length; i++)
    if (found[i][1] !== found[0][1])
      fail(`A8 disclosure sentence drifted between ${found[0][0]} and ${found[i][0]} — U4 requires the three faces stay byte-identical (modulo markdown **bold** and the hook's comment wrapping)`);
}

// ---- 7. Secret deny list: settings.json permissions.deny <-> block-secret-read.js patterns ----
// Both lists are hand-maintained mirrors of "which secret paths are blocked" — one for the Read
// tool, one for the Bash/PowerShell pathway. Exact-pattern equivalence isn't practical, so just
// check that representative secret file kinds appear on both sides.
{
  const denyList = settings.permissions?.deny ?? [];
  const secretReadHookPath = path.join(ROOT, '.claude', 'hooks', 'block-secret-read.js');
  const hookText = fs.existsSync(secretReadHookPath) ? read(secretReadHookPath) : '';
  const REPRESENTATIVE_SECRETS = [
    ['.env', /\.env\b/],
    ['*.pem', /\.pem\b/],
    ['*.key', /\.key\b/],
    ['secrets/', /secrets[/\\]/],
    ['~/.ssh', /\.ssh[/\\]/],
    ['~/.aws', /\.aws[/\\]/],
  ];
  if (!hookText) warn('block-secret-read.js missing — cannot cross-check against settings.json deny list');
  else
    for (const [label, re] of REPRESENTATIVE_SECRETS) {
      const inSettings = denyList.some((d) => re.test(d));
      const inHook = re.test(hookText);
      if (inSettings && !inHook) warn(`secret deny list drift: "${label}" is denied in settings.json but not covered in block-secret-read.js SECRET_PATH_PATTERNS`);
      else if (!inSettings && inHook) warn(`secret deny list drift: "${label}" is covered in block-secret-read.js but not denied in settings.json permissions.deny`);
    }
}

// ---- 8. Relay alias dictionary: models.json is the SOT; relay SKILL.md must point to it ----
// The router is fail-closed on unknown aliases, so doc drift can't cause silent misrouting;
// we only assert the SKILL still names models.json as the alias source.
{
  const relaySkillPath = path.join(ROOT, '.claude', 'skills', 'relay', 'SKILL.md');
  if (fs.existsSync(relaySkillPath)) {
    const relayText = read(relaySkillPath);
    if (!relayText.includes('models.json'))
      warn(`relay SKILL.md no longer points to clover/models.json as the alias dictionary (SOT) — restore the pointer`);
  }
}

// ---- 9. Windows path/encoding lint: recurrence guard for previously-hit patterns ----
// (v1 lessons 2026-06-28 / 06-30 / 07-03) POSIX-only hardcoded paths and unencoded PowerShell
// calls have broken this Windows-hosted harness before. WARN only — lint-style heuristics.
{
  // /tmp/ is anchored to a string/expression start so glob patterns like 'dev/*/tmp/**'
  // (mid-string /tmp/) don't false-positive — the target is absolute POSIX paths only.
  const POSIX_PATH_RE = /\/dev\/stdin|(?:^|['"`=(\s])\/tmp\//;
  const PS_CALL_RE = /\b(?:execFileSync|execSync|spawnSync)\(\s*[`'"]?.*powershell/i;
  const walkJs = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || SUBPROJECTS.has(p)) continue;
        walkJs(p, out);
      } else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  const jsFiles = [];
  walkJs(path.join(ROOT, '.claude'), jsFiles);
  const selfPath = path.join(ROOT, '.claude', 'scripts', 'validate.mjs');
  for (const p of jsFiles) {
    if (p === selfPath) continue;
    const text = read(p);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (/^(\/\/|\*)/.test(trimmed)) return; // skip comment lines (doc examples, not live code)
      if (POSIX_PATH_RE.test(line)) warn(`hardcoded POSIX path in ${rel(p)}:${i + 1} (breaks on Windows) — ${trimmed.slice(0, 100)}`);
    });
    if (PS_CALL_RE.test(text) && !/OutputEncoding/.test(text))
      warn(`${rel(p)}: calls powershell without any OutputEncoding/UTF-8 switch in the same file (mojibake risk on Windows)`);
  }
}

// ---- 9.5. Zero NUL bytes in harness/record files (Batch A / A4, 2026-08-12) ------------------
// dev/reprodocs/tasks/lessons.md [2026-07-31] + its Update [2026-08-01]: a written \uXXXX escape
// sequence was converted into the real NUL byte by tool input; git then treats the file as binary
// and ripgrep silently skips it, so the damage hides from both `git diff` and grep at once. It
// happened twice — once to a worker, once to the conductor.
// Reuses the same `scan` file list check #4 already built above (CLAUDE.md, README.md, every
// .md/.js/.json/.html under .claude/**, and every .md/.js/.json/.html under
// docs/claude-harness-guide/**) instead of walking the tree again.
// Floor (fixed 2026-08-12, HIGH-1): `scan.length === 0` can never fire — `scan` is seeded with 2
// literal paths (CLAUDE.md, README.md) at its declaration above, regardless of whether they exist
// on disk, so the list is never empty. Worse, the loop below skips a path that
// `fs.existsSync` says is missing, so "the candidate list is non-empty" is not the same claim as
// "at least one file was actually opened and scanned" — a run where every candidate path is
// missing (e.g. scan retargeted to a wiped directory) silently reports PASS with 0 bytes ever
// read. The real floor, mirroring check #13's count-actual-matches-not-list-length shape below,
// is a counter incremented only on an actual successful read, checked after the loop.
// Scope limit (corrected 2026-08-12, MEDIUM-2): this only covers the records/harness files
// `walkMd` collects into `scan` above — CLAUDE.md, README.md, and every .md/.js/.json/.html
// under .claude/** and docs/claude-harness-guide/**. walkMd's extension filter is
// /\.(md|js|json|html)$/ — .mjs is NOT in it, so every .mjs file under .claude/** (including this
// validator, validate.mjs itself, plus html2pdf.mjs/html2pptx.mjs/deckpack.mjs/fusion-detect.mjs)
// is invisible to this check: a NUL byte there is a silent PASS. Widening the filter to include
// .mjs was tried and reverted: `scan` is shared with check #4's dead-ref FORBIDDEN-pattern scan
// above, and validate.mjs is self-referential (it defines the FORBIDDEN patterns using the exact
// strings — real model ids, "/wrap", "audit" — that those patterns exist to catch), so widening
// turned validate.mjs's own source into 8 dead-ref FAILs against itself; fixing that cleanly needs
// a second, separately-exempted scan list, which is more machinery than a NUL-byte coverage gap
// warrants (CLAUDE.md §1.7). A NUL byte in product code (dev/**, outside its own tasks/ mirror) is
// the product's own gate's problem, not this one's — same as before.
{
  let filesActuallyRead = 0;
  for (const p of scan) {
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    filesActuallyRead++;
    const nulOffset = buf.indexOf(0);
    if (nulOffset !== -1)
      fail(`NUL byte in ${rel(p)} at byte offset ${nulOffset} — likely a mis-encoded \\uXXXX escape (see dev/reprodocs/tasks/lessons.md 2026-07-31)`);
  }
  if (filesActuallyRead === 0)
    fail(`NUL-byte scan: 0 files were actually read out of ${scan.length} candidate path(s) (all missing on disk) — the scan ran but checked nothing`);
}

// ---- 10. tasks/lessons.md size: WARN before session-start injection starts truncating ----
{
  const lessonsPath = path.join(ROOT, 'tasks', 'lessons.md');
  const LESSONS_WARN_BYTES = 18 * 1024;
  if (fs.existsSync(lessonsPath)) {
    const size = fs.statSync(lessonsPath).size;
    if (size > LESSONS_WARN_BYTES)
      warn(`tasks/lessons.md is ${(size / 1024).toFixed(1)}KB (>18KB) — session-start injection budget will start truncating older lessons; consider a distilled archive`);
  }
}

// ---- 11. Hook health: node --check syntax + literal relative-require() resolution ----
// Every safety hook require()s ./lib/* at the top of the file; one broken lib file makes every
// hook throw during require and fail open with no CLI error and no journal entry (lessons.md
// 2026-08-02 incident). This section only mechanically detects two specific classes of breakage:
// (a) a syntax error (via `node --check`), and (b) a require() whose specifier is a literal
// relative string (starts with ".") that doesn't resolve to any file. It does NOT catch a
// require() that resolves but throws at load time (e.g. a top-level bug in the required module),
// nor a non-literal specifier built via concatenation, a template string, or a variable — those
// pass silently. Deliberately no require()-executor was added here to close that gap: actually
// loading every hook module as part of validate would run its top-level code, which is a
// side-effect validate must not have (CLAUDE.md §1.7).
{
  const hooksDir = path.join(ROOT, '.claude', 'hooks');
  const hooksLibDir = path.join(hooksDir, 'lib');
  const hookFiles = fs.readdirSync(hooksDir).filter((x) => x.endsWith('.js')).map((f) => path.join(hooksDir, f));
  const hookLibFiles = fs.existsSync(hooksLibDir)
    ? fs.readdirSync(hooksLibDir).filter((x) => x.endsWith('.js')).map((f) => path.join(hooksLibDir, f))
    : [];
  const hookHealthFiles = [...hookFiles, ...hookLibFiles];

  for (const p of hookHealthFiles) {
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (e) {
      const stderrText = String(e.stderr || e.message || '');
      const errLine = stderrText.split('\n').find((l) => /Error/.test(l)) || stderrText.split('\n').find((l) => l.trim()) || 'unknown syntax error';
      fail(`${rel(p)}: syntax error (node --check) — ${errLine.trim().slice(0, 160)}`);
    }
  }

  // Relative require() target resolution, CJS-order (exact path, then +.js, +.json, +/index.js).
  // node:-prefixed and bare (package) specifiers are skipped by construction — the capture group
  // only matches specifiers starting with ".". Comment lines are excluded the same way section 9
  // does (line-start "//" or "*"): parse-cmd.js:10 has a doc-comment example require whose target
  // is not resolvable relative to the real file and would otherwise false-FAIL an unmodified tree.
  // Known limitation (not currently hit, flagged so a future block comment doesn't surprise
  // someone): this line-start exclusion does not cover a require() written inside a /* ... */
  // block comment on a line that itself doesn't start with "//" or "*".
  const resolveRequireTarget = (fromFile, spec) => {
    const base = path.resolve(path.dirname(fromFile), spec);
    return [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')].some((c) => fs.existsSync(c));
  };
  for (const p of hookHealthFiles) {
    const lines = read(p).split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (/^(\/\/|\*)/.test(trimmed)) return;
      const m = trimmed.match(/require\(\s*['"](\.[^'"]+)['"]\s*\)/);
      if (!m) return;
      if (!resolveRequireTarget(p, m[1]))
        fail(`${rel(p)}:${i + 1} — require("${m[1]}") does not resolve to any file (checked exact/.js/.json/index.js)`);
    });
  }
}

// ---- 12. Negative invariant: no hook may ever emit permissionDecision:"allow" on stdout -------
// Silence + exit 0 already means allow; an explicit "allow" could short-circuit a later hook in
// the same PreToolUse chain. cmd-write-guard.js/scope-guard.js legitimately write
// permissionDecision on this field, but always with "deny" — only a literal "allow" value fails.
// Provenance (2026-08-07): an earlier version of this scan was non-recursive (top level of
// .claude/hooks/ only) and missed everything under lib/; an even earlier version excluded
// cmd-write-guard.js/scope-guard.js by filename, leaving the two files most likely to ever carry a
// real "allow" completely unscanned. Recursive, with no per-file exclusion, on purpose.
// Known, disclosed evasion: a value built via a variable or concatenation (e.g.
// `permissionDecision: decision` or `'al' + 'low'`) does not match this literal-string regex and
// passes silently.
{
  const hooksDir = path.join(ROOT, '.claude', 'hooks');
  const hookCodeFiles = fs.readdirSync(hooksDir, { recursive: true })
    .filter((f) => /\.(js|mjs|cjs)$/.test(f))
    .map((f) => path.join(hooksDir, f));
  let filesActuallyRead = 0;
  let libReached = false;
  for (const f of hookCodeFiles) {
    const lines = read(f).split('\n');
    filesActuallyRead++;
    if (rel(f).includes('/lib/')) libReached = true;
    lines.forEach((line, i) => {
      if (/^(\/\/|\*)/.test(line.trim())) return;
      if (/permissionDecision['"]?\s*:\s*['"]allow['"]/.test(line))
        fail(`negative invariant violated in ${rel(f)}:${i + 1} — a hook must only ever signal "deny" explicitly (silence + exit 0 already means allow)`);
    });
  }
  if (filesActuallyRead === 0)
    fail('negative invariant #12 scan: 0 hook code files were actually read under .claude/hooks/ — the scan ran but checked nothing');
  if (!libReached)
    fail('negative invariant #12 scan: no scanned path is under .claude/hooks/lib/ — the scan no longer reaches .claude/hooks/lib/ (recursion was lost; this is the exact 2026-08-07 regression shape)');
}

// ---- 13. Guide roster cross-check: skill/agent/command names named in docs/claude-harness-guide/
// must actually exist. #4's FORBIDDEN list only catches names on an explicit deny-list (already-
// removed subsystems) — it cannot notice a name that was simply never added there (e.g. a stale or
// mistyped name, or a name for something that quietly stopped existing). Two capture shapes only,
// deliberately narrow to avoid flagging ordinary prose as a name:
//   (a) explicit path references of the exact form .claude/(skills|agents|commands)/<name> — the
//       name is bounded by the next non-[A-Za-z0-9_-] character, so a wildcard segment such as
//       .claude/agents/*.md or .claude/skills/*/SKILL.md never produces a spurious capture (the
//       character class does not match "*").
//   (b) the two roster <table>s in skills-agents.html that ARE the canonical name lists, identified
//       by their <caption> text (".claude/agents/*.md の要約" / ".claude/skills/*/SKILL.md の要約")
//       — only the first <td><code>...</code></td> cell of each row in exactly those two tables.
//       Deliberately NOT every table with a <code> first cell (e.g. the Model Tier Policy summary
//       table's first column is a tier badge, not a name) — only these two captioned tables are
//       treated as name rosters, so a name-shaped word in an unrelated table is never flagged.
//       The row regex tolerates one attribute on <tr>/<td>/<code> (e.g. class="mono") — a bare-tag
//       regex used to drop straight to 0 matches the moment any styling attribute was added to a
//       roster table, and 0 matches read identically to "nothing to check", so the whole cross-check
//       PASSed silently (2026-08-07 fix; the floor check below turns that silence into a FAIL).
// Name sourcing note: REAL_NAMES.agents is agentNames, collected earlier from each agent file's own
// frontmatter `name:` field (the file's declared identity, read from inside the file); REAL_NAMES.
// skills/commands instead come from a non-recursive directory listing (skill dir name / command
// file basename) — deliberately not generalized to a recursive listing, since no nested command
// exists today and adding one would be speculative (CLAUDE.md §1.7).
{
  // clip(): caption text is taken verbatim from the guide's own HTML and embedded into fail
  // messages below — bound both its length and its character shape (collapse whitespace/newlines
  // to a single space) so a stray/malformed caption can't inject multi-line or oversized text into
  // this validator's own output.
  const clip = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 100);
  const guideDir = path.join(ROOT, 'docs', 'claude-harness-guide');
  if (!fs.existsSync(guideDir))
    warn('docs/claude-harness-guide/ does not exist — the guide roster cross-check (#13) has nothing to check');
  const guideFiles = fs.existsSync(guideDir) ? fs.readdirSync(guideDir).filter((f) => f.endsWith('.html')) : [];
  if (fs.existsSync(guideDir) && guideFiles.length === 0)
    warn('docs/claude-harness-guide/ exists but contains no .html files — the guide roster cross-check (#13) has nothing to check');
  const REAL_NAMES = {
    skills: new Set(fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)),
    agents: agentNames,
    commands: new Set(
      fs.existsSync(commandsDir) ? fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : []
    ),
  };
  const SINGULAR = { skills: 'skill', agents: 'agent', commands: 'command' };
  const PATH_REF_RE = /\.claude\/(skills|agents|commands)\/([A-Za-z0-9_-]+)/g;
  const ROSTER_TABLES = [
    { kind: 'agents', captionMatch: /agents\/\*\.md.*要約/ },
    { kind: 'skills', captionMatch: /skills\/\*\/SKILL\.md.*要約/ },
  ];
  // Attribute-tolerant row shape: still requires <code> to open the first cell immediately
  // (deliberately narrow, see (b) above), but a class/id/etc. on <tr>/<td>/<code> no longer drops
  // the row out of the match.
  const ROSTER_ROW_RE = /<tr[^>]*>\s*<td[^>]*>\s*<code[^>]*>([A-Za-z0-9_-]+)<\/code>/g;

  // Floor check (one level up from the row-count floor below): count, per ROSTER_TABLES entry,
  // how many <caption> texts across all guide files matched its captionMatch regex. If ONE
  // heading's wording drifts (e.g. the agents roster's "の要約" -> "の概要") while the OTHER
  // roster's caption is untouched, a single global "matched >=1 caption somewhere" counter would
  // stay positive (the still-matching skills caption keeps it alive) and hide that the agents
  // roster specifically stopped being checked — so this counts each kind separately. Any kind
  // with 0 matches across every guide file must FAIL, not PASS-by-doing-nothing (2026-08-08 fix,
  // same rationale as the row-count floor this mirrors).
  const matchedRosterCaptionsByKind = Object.fromEntries(ROSTER_TABLES.map((r) => [r.kind, 0]));

  for (const f of guideFiles) {
    const p = path.join(guideDir, f);
    const text = read(p);

    for (const m of text.matchAll(PATH_REF_RE)) {
      const [, kind, name] = m;
      if (!REAL_NAMES[kind].has(name))
        fail(`docs/claude-harness-guide/${f}: references ".claude/${kind}/${name}" but no such ${SINGULAR[kind]} exists`);
    }

    for (const capMatch of text.matchAll(/<caption>([\s\S]*?)<\/caption>/g)) {
      const captionText = clip(capMatch[1]);
      const roster = ROSTER_TABLES.find((r) => r.captionMatch.test(captionText));
      if (!roster) continue;
      matchedRosterCaptionsByKind[roster.kind]++;
      const tableStart = text.lastIndexOf('<table', capMatch.index);
      const tableEnd = text.indexOf('</table>', capMatch.index);
      if (tableStart === -1 || tableEnd === -1) {
        fail(`docs/claude-harness-guide/${f}: roster table "${captionText}" caption matched but its <table>...</table> markers could not be located — cannot verify roster names`);
        continue;
      }
      const tableHtml = text.slice(tableStart, tableEnd);
      let rowCount = 0;
      for (const rowMatch of tableHtml.matchAll(ROSTER_ROW_RE)) {
        rowCount++;
        const name = rowMatch[1];
        if (!REAL_NAMES[roster.kind].has(name))
          fail(`docs/claude-harness-guide/${f}: roster table "${captionText}" lists "${name}" but no such ${SINGULAR[roster.kind]} exists`);
      }
      // Floor check: a matched roster caption with 0 extracted name rows means the cross-check
      // silently verified nothing (markup drift on <tr>/<td>/<code>, or a genuinely empty table) —
      // that must FAIL, not PASS-by-doing-nothing.
      if (rowCount === 0)
        fail(`docs/claude-harness-guide/${f}: roster table "${captionText}" matched 0 name rows — the cross-check checked nothing (markup drift on <tr>/<td>/<code>, or the table is genuinely empty)`);
    }
  }

  // See the counter's own comment above: a ROSTER_TABLES kind with 0 matched captions across
  // every guide file means its captionMatch regex matched no heading anywhere — that kind's
  // roster silently went unchecked, same failure shape the row-count floor above catches one
  // level down.
  if (guideFiles.length > 0) {
    for (const roster of ROSTER_TABLES) {
      if (matchedRosterCaptionsByKind[roster.kind] === 0)
        fail(
          `docs/claude-harness-guide/: no <caption> matched the expected ${roster.kind} roster heading ` +
          `(pattern ${roster.captionMatch}) in any .html file — that roster's cross-check checked nothing`
        );
    }
  }
}

// ---- 14. Observation Points roster wiring (mutation-observation-points plan, Phase 1) ----------
// The plan requires a "### Observation Points" roster in every heavy-path PLAN.md (plan/SKILL.md's
// template) and a standing check that a real plan actually carries it (planner.md's Self-Review
// Completeness dimension) — a template with the heading alone does nothing if nobody ever looks
// for the heading in a real plan, and vice versa. Both pins use the section-scoped extraction
// method introduced by 6.1 above (extract just the relevant section, not the whole file) so that
// gutting or relocating content elsewhere in either file is caught, not just the phrase's mere
// presence somewhere in a large file.
{
  const planSkillPath = path.join(ROOT, '.claude', 'skills', 'plan', 'SKILL.md');
  if (!fs.existsSync(planSkillPath)) fail('.claude/skills/plan/SKILL.md missing — cannot verify Observation Points wiring');
  else {
    // Anchored on the literal next real heading ("## Model / Agents"), not a generic "\n## "
    // lookahead — the Heavy Path section's own PLAN.md/research.md templates contain fenced
    // example text that itself starts with "## " (e.g. "## Plan: {feature}", "## Now"), so a
    // generic heading-level lookahead truncates the match at the first such line inside the code
    // fence, well before the real end of the section.
    const m = read(planSkillPath).match(/## Heavy Path — Research[\s\S]*?\n## Model \/ Agents/);
    if (!m) fail('.claude/skills/plan/SKILL.md: "## Heavy Path" section not found (or unterminated before the "## Model / Agents" heading) — cannot verify Observation Points wiring');
    else {
      const section = m[0];
      const items = [
        // Anchored to the template's own line sequence, not a bare /### Observation Points/ —
        // the explanatory paragraph below the template also quotes "### Observation Points" in
        // backticks, so a bare pattern is satisfied by that prose alone even with the template
        // heading itself deleted (confirmed by mutation probe: deleting the template heading left
        // this item GREEN because of the prose reference).
        [/### Rejected Alternatives\n- \[alternative\]: \[reason for rejection\]\n### Observation Points/, 'the "### Observation Points" heading in the PLAN.md template (right after Rejected Alternatives)'],
        // T4.4 fix (A6): reworded from "the 2026-08-15 `mutation-observation-points` plan" (ambiguous
        // against this plan's own 08-14-dated artifacts) to an approval-date framing.
        [/required for any plan approved on or after 2026-08-15/, 'the since-when-required sentence (CR-B, reworded T4.4/A6 to an approval-date framing)'],
        [/derive the roster at implementation time/, 'the CR-B derive-from-requirements fallback for plans predating the section'],
        // T4.4 fix (K4): the old pin only checked the phrase "no-plan casual work" was PRESENT
        // somewhere, which passed identically whether a dev/** pre-dated plan was correctly routed
        // to the derive-from-text rule or incorrectly routed to executor.md's no-plan rule (a real
        // plan is not "no plan"). Anchored on the corrected sentence itself so a regression back to
        // the old mis-routing text — which does not contain this phrase — goes RED.
        [/is \*\*not\*\* routed to executor\.md's "no-plan casual work" rule/, 'the K4 jurisdiction-alignment fix (a dev/** pre-dated plan still has a plan, so it uses the derive-from-text rule directly, not executor.md\'s no-plan casual-work rule) — mutation-observation-points T4.4 fix pass'],
        [/`### Observation Points` takes\s+precedence/, 'the priority rule (Observation Points outranks Verification Strategy on conflict)'],
        [/both the M1 and M2 results \(SOT: `executor\.md` Detection power\)/, 'the Phase 3 gate line requiring M1/M2 results per implemented observation point'],
        // T4.4 fix (K1 pin 5 / B seat "heading pinned, content not"): the heading item above only
        // proved "### Observation Points" appears after Rejected Alternatives — deleting the
        // template's own content line (what a plan author actually copies) left this undetected.
        [/- \[point\]: the behavior the plan requires, and the check that must go RED if it breaks/, 'the PLAN.md template\'s Observation Points content line (one point per line, with the check that must go RED) — mutation-observation-points T4.4 fix pass (K1)'],
        // T4.4 fix (B4): "`- none`" must not read as a terminal free pass.
        [/derive-anyway clause is the single authority/, 'the B4 fix stating executor.md\'s derive-anyway clause is the single authority on whether `- none` is a re-derivable claim, not a terminal one — mutation-observation-points T4.4 fix pass'],
      ];
      for (const [re, label] of items)
        if (!re.test(section)) fail(`.claude/skills/plan/SKILL.md "## Heavy Path" section is missing ${label} — mutation-observation-points Phase 1`);

      // T4.4 fix (C1 MUST-fix, #16-class hardening applied here too): a decoy heading duplicating
      // the section's own start anchor earlier in the file would hijack which span match() extracts.
      // Assert the anchor is unique in the whole file, not just present.
      const heavyPathStartCount = (read(planSkillPath).match(/## Heavy Path — Research/g) || []).length;
      if (heavyPathStartCount !== 1)
        fail(`.claude/skills/plan/SKILL.md: expected exactly 1 occurrence of the "## Heavy Path — Research" anchor, found ${heavyPathStartCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);
    }
  }

  const plannerPath = path.join(ROOT, '.claude', 'agents', 'planner.md');
  if (!fs.existsSync(plannerPath)) fail('.claude/agents/planner.md missing — cannot verify Observation Points wiring');
  else {
    const plannerText = read(plannerPath);
    // Same code-fence caveat as the plan/SKILL.md extraction above: the "### 5. Output Format"
    // section's own light-plan example (todo.md snippet) contains literal "## Now" / "## Backlog"
    // lines inside a fence, so a generic "\n## " lookahead truncates before reaching the §5B
    // template further down. Anchor on the literal next real heading ("## Rules") instead.
    const templateSection = plannerText.match(/### 5\. Output Format[\s\S]*?\n## Rules/);
    if (!templateSection) fail('.claude/agents/planner.md: "### 5. Output Format" section not found (or unterminated before the "## Rules" heading) — cannot verify the PLAN.md template list');
    else if (!/### Observation Points/.test(templateSection[0]))
      fail('.claude/agents/planner.md "### 5. Output Format" section is missing "### Observation Points" in the §5B PLAN.md template list — mutation-observation-points Phase 1');

    const completenessSection = plannerText.match(/#### 2\. Completeness[\s\S]*?(?=\n#### |$)/);
    if (!completenessSection) fail('.claude/agents/planner.md: "#### 2. Completeness" section not found (or unterminated before the next "#### " heading) — cannot verify the Self-Review Completeness check');
    else {
      if (!/Does the plan have a `### Observation Points` section/.test(completenessSection[0]))
        fail('.claude/agents/planner.md "#### 2. Completeness" section is missing the Observation Points check — mutation-observation-points Phase 1 (this is the only standing check that a real plan, not just the template, carries the roster)');
      // T4.4 fix (B4): planner must defer `- none` adjudication explicitly, not silently do a
      // presence-only check with no acknowledgment of the limit.
      if (!/planner does not adjudicate whether a `- none` claim is actually correct/.test(completenessSection[0]))
        fail('.claude/agents/planner.md "#### 2. Completeness" is missing the B4 defer-explicitly sentence (planner does not adjudicate whether `- none` is correct) — mutation-observation-points T4.4 fix pass');
    }
  }
}

// T4.4 tightening pass (A1): the negative-invariant neutering-marker check below (and its 6 other
// site copies in §16/§17) was case-sensitive, English-only — red-team probes proved plain
// lowercase "withdrawn", sentence-case "Repealed"/"Retired", and the repo's own house marker
// 撤回済み (used elsewhere in this codebase for the same "marked inert, kept for history" meaning,
// e.g. plan/SKILL.md's Objections & Rulings convention) all slipped past undetected. Shared as one
// constant so all 7 sites stay in sync. \b only wraps the ASCII alternatives — \b relies on \w
// (ASCII word) characters, so it does not reliably delimit 撤回済み in ordinary Japanese text
// (neither neighbor is a \w character); 撤回済み is therefore a bare alternative outside the \b
// group instead of forcing an ASCII-style boundary onto CJK text.
const NEUTER_MARKER_RE = /\b(?:withdrawn|repealed|retired|not-operative)\b|撤回済み/i;

// ---- 15. Observation Points production duty (mutation-observation-points plan, Phase 2) --------
// Phase 1 pinned the ROSTER (a plan carries "### Observation Points"). This phase pins the PRODUCTION
// duty that actually iterates that roster — executor.md's Detection power item 1(b) — closing the
// gap where a rewrite that quietly drops the load-bearing sub-rules (M2 must cover every consumption
// site, not one; green-on-M2 is a finding, not a pass; the report must name file:line + the deleted
// line + the check name) would otherwise still pass validate undetected. (T4.4 fix, B9: the previous
// wording of this sentence read as if it were describing the current, post-fix state — "still passes
// validate" with no "would" — the opposite of what this section does; corrected to state the gap this
// section closes, not one that remains open.) Section-scoped (6.1 method): extract item 1 only
// (between its own "1. **Detection power**:" heading and the next "2. **Claim scope**:" heading), not
// the whole file — item 1 is a large block and a generic whole-file pin would tolerate relocating
// these sub-rules elsewhere, or duplicating the heading while gutting the body underneath it.
{
  const executorPath = path.join(ROOT, '.claude', 'agents', 'executor.md');
  if (!fs.existsSync(executorPath)) fail('.claude/agents/executor.md missing — cannot verify Observation Points production duty (Phase 2)');
  else {
    const m = read(executorPath).match(/1\.\s+\*\*Detection power\*\*:[\s\S]*?(?=\n2\.\s+\*\*Claim scope\*\*:)/);
    if (!m) fail('.claude/agents/executor.md: item 1 "**Detection power**" section not found (or unterminated before "2. **Claim scope**:") — mutation-observation-points Phase 2');
    else {
      const section = m[0];
      const items = [
        [/every consumption site, not one/, 'the M2 all-consumption-sites rule (testing one call site and inferring the rest is not enough)'],
        [/GREEN on an M2 mutation is not a pass — it's a finding/, 'the green-on-M2-is-a-finding rule (an undefended consumption site is a finding, never reported as "all green")'],
        [/name the `file:line` and the literal text of the line you deleted, and the name of the check that went RED/, 'the M2 report-format rule (file:line + literal deleted line + the check name, per mutation)'],
        // T4.4 fix (K1 pin 4 / O6): the casual-work connector sentence — deleting it left executor's
        // no-plan-work duty undetectable while the three M2 items above stayed intact.
        [/casual work with no plan targets whatever observable behavior the change itself newly created or altered/, 'the O6 casual-work connector (the observation-point duty applies with no plan too) — mutation-observation-points T4.4 fix pass (K1)'],
        // T4.4 fix (B5): the >12-point class-representative escape must define "class", require every
        // class represented (a floor, not just "pick one"), and require recorded membership.
        [/with no class skipped/, 'the B5 class-floor rule (every class must have a representative, not just a chosen subset) — mutation-observation-points T4.4 fix pass'],
        // T4.4 fix (B6): a fold claim must be recorded, not just a smaller mutation count.
        [/record which sites were folded plus why they're equivalent/, 'the B6 fold-claim recording rule — mutation-observation-points T4.4 fix pass'],
        // T4.4 fix (B8): an exclusion claim is not self-certifying without a recorded reason.
        [/Record every exclusion with a one-line reason naming which of the two categories it falls under/, 'the B8 exclusion-recording rule — mutation-observation-points T4.4 fix pass'],
      ];
      for (const [re, label] of items)
        if (!re.test(section)) fail(`.claude/agents/executor.md item 1 "**Detection power**" is missing ${label} — mutation-observation-points Phase 2`);

      // T4.4 fix (C1 MUST-fix): "#15 first-match anchor must assert count===1" — a decoy
      // "1. **Detection power**:" occurrence inserted earlier in the file would hijack match()'s
      // extraction start point. Assert the anchor phrase is unique in the whole file.
      const detectionPowerAnchorCount = (read(executorPath).match(/1\.\s+\*\*Detection power\*\*:/g) || []).length;
      if (detectionPowerAnchorCount !== 1)
        fail(`.claude/agents/executor.md: expected exactly 1 occurrence of the "1. **Detection power**:" anchor, found ${detectionPowerAnchorCount} — a decoy/duplicate anchor could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);

      // T4.4 fix (C1 MUST-fix): ONE negative invariant against the cheapest quoted-repeal-class
      // attack — marking this duty span inert with a neutering marker while the pinned phrases
      // above stay byte-identical elsewhere. Scoped to THIS extracted span only (not the whole
      // file) — rules/agents.md's T4.4 threat-model disclosure legitimately uses these same words,
      // and scoping this check to the duty span itself (rather than a repo-wide scan) is the T2
      // exemption decision: keep the disclosure prose outside every scanned span instead of
      // building citation-exemption machinery for words this duty text has no legitimate reason to
      // use. Known, disclosed gap: a quoted-repeal or free-form rephrase that avoids these 4 literal
      // words entirely is not caught (see rules/agents.md's Pin threat model bullet).
      if (NEUTER_MARKER_RE.test(section))
        fail(`.claude/agents/executor.md item 1 "**Detection power**" contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A1; was C1 negative invariant)`);
    }
  }
}

// ---- 16. Observation Points review duty wiring (mutation-observation-points plan, Phase 3) ------
// Phase 1 pinned the roster (plan carries "### Observation Points"); Phase 2 pinned the production
// duty (executor.md's M1/M2). This phase pins the REVIEW-SIDE duty that catches a worker who skips
// or under-covers M2: reviewer.md must derive the roster itself (never trust the worker's report)
// and must carry the observation-wiring checklist line, and quality-loop's re-review mutation-
// evidence gate + red-team lens must both name the consumption side explicitly — a rewrite that
// silently drops any one of these four leaves the M2 duty produced in Phase 2 with nobody checking
// it landed. Section-scoped (6.1 method) to each item's own heading-to-next-heading span, so
// relocating or gutting content elsewhere in a large file is caught, not just phrase presence
// anywhere in the file.
{
  const reviewerPath = path.join(ROOT, '.claude', 'agents', 'reviewer.md');
  if (!fs.existsSync(reviewerPath)) fail('.claude/agents/reviewer.md missing — cannot verify Observation Points review duty (Phase 3)');
  else {
    const reviewerText = read(reviewerPath);

    const advSection = reviewerText.match(/### Adversarial Verification \(falsification duty\)[\s\S]*?(?=\n### Severity Levels)/);
    if (!advSection) fail('.claude/agents/reviewer.md: "### Adversarial Verification (falsification duty)" section not found (or unterminated before "### Severity Levels") — mutation-observation-points Phase 3');
    else {
      if (!/derive the observation-point roster[\s\S]*?never take the worker's\s+report roster at face value/.test(advSection[0]))
        fail('.claude/agents/reviewer.md "### Adversarial Verification" is missing the consumption-side mutation duty (roster derived from the plan itself, not the worker\'s report) — mutation-observation-points Phase 3');
      const advItems = [
        // T4.4 fix (K4): reviewer's roster-derivation duty must reach every path executor's does,
        // including no-plan casual work — previously it only covered "the plan" (present or
        // predating the section), leaving zero reviewer jurisdiction on a fully plan-less change.
        [/jurisdiction executor\.md's casual-work duty covers/, 'the K4 jurisdiction-alignment clause (reviewer\'s roster derivation also covers no-plan casual work, matching executor.md) — mutation-observation-points T4.4 fix pass'],
        // T4.4 fix (K1 pin 6 / O7): this sentence is the actual test-power filing rule for an
        // undefended consumption site — the section-presence check above does not reach it.
        [/finding, filed under the `test-power` category — never accept a bare "all green" claim/, 'the O7 test-power filing rule for an undefended consumption site — mutation-observation-points T4.4 fix pass (K1)'],
        // T4.4 fix (B6): reviewer must verify a claimed fold rather than accept a smaller mutation
        // count at face value.
        [/which you then verify yourself before accepting it/, 'the B6 fold cross-check rule — mutation-observation-points T4.4 fix pass'],
        // T4.4 fix (B8): a worker's exclusion claim is not self-certifying.
        [/self-certifying either/, 'the B8 exclusion counter-rule (a worker\'s exclusion claim is checked, not trusted) — mutation-observation-points T4.4 fix pass'],
      ];
      for (const [re, label] of advItems)
        if (!re.test(advSection[0])) fail(`.claude/agents/reviewer.md "### Adversarial Verification" is missing ${label}`);

      // T4.4 fix (C1 MUST-fix): count===1 anchor + negative invariant, same rationale as section 15.
      const advAnchorCount = (reviewerText.match(/### Adversarial Verification \(falsification duty\)/g) || []).length;
      if (advAnchorCount !== 1)
        fail(`.claude/agents/reviewer.md: expected exactly 1 occurrence of the "### Adversarial Verification (falsification duty)" anchor, found ${advAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);
      if (NEUTER_MARKER_RE.test(advSection[0]))
        fail('.claude/agents/reviewer.md "### Adversarial Verification" contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A1; was C1 negative invariant)');
    }

    const defectSection = reviewerText.match(/### Defect-Class Checklist[\s\S]*?(?=\n### Probe Log)/);
    if (!defectSection) fail('.claude/agents/reviewer.md: "### Defect-Class Checklist" section not found (or unterminated before "### Probe Log") — mutation-observation-points Phase 3');
    else {
      if (!/observation wiring:.*consumption side is deleted/.test(defectSection[0]))
        fail('.claude/agents/reviewer.md "### Defect-Class Checklist" is missing the "observation wiring" line — mutation-observation-points Phase 3');
      // T4.4 fix (B5): the checklist's landing slot for the class-representative escape.
      if (!/does the report list every class's membership with no class skipped/.test(defectSection[0]))
        fail('.claude/agents/reviewer.md "### Defect-Class Checklist" is missing the B5 class-floor check line — mutation-observation-points T4.4 fix pass');

      const defectAnchorCount = (reviewerText.match(/### Defect-Class Checklist/g) || []).length;
      if (defectAnchorCount !== 1)
        fail(`.claude/agents/reviewer.md: expected exactly 1 occurrence of the "### Defect-Class Checklist" anchor, found ${defectAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);
      if (NEUTER_MARKER_RE.test(defectSection[0]))
        fail('.claude/agents/reviewer.md "### Defect-Class Checklist" contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A1; was C1 negative invariant)');
    }

    // T4.4 fix (B2): the Finding line format sentence is the SOT copy of the closed 6-word category
    // set outside quality-loop/SKILL.md — previously unpinned entirely. Anchored on the trailing
    // backtick+period so appending a 7th slug inside the quotes, or replacing the framing sentence
    // while leaving the quoted list untouched, both go RED (a rephrase that avoids this literal
    // sentence and quotes the list elsewhere is a known, disclosed gap — same class as C1).
    if (!/category is one of 6 stable slugs: `test-power \/ overclaim \/ match-direction \/ unverified-claim \/ scope \/ other`\./.test(reviewerText))
      fail('.claude/agents/reviewer.md is missing the closed-set category-slug sentence ("category is one of 6 stable slugs: `test-power / overclaim / match-direction / unverified-claim / scope / other`.") anchored to its exact framing and trailing punctuation — mutation-observation-points T4.4 fix pass (B2)');

    // T4.4 tightening pass (A4): reviewer.md's `target: fusion` Rules carry a THIRD, previously
    // unpinned copy of the same closed 6-word slug set (different formatting from the other two
    // pinned copies — no spaces around the slashes, inside a plain parenthetical rather than
    // backticks) — a rewrite could gut this fusion-target copy while the two already-pinned copies
    // (this section's sentence above, and quality-loop's own copy below) stayed byte-identical.
    // Anchored on the trailing ")" so a 7th slug appended INSIDE this parenthetical goes RED.
    // Known, disclosed gap (same class as B2/C1, not something this pin is expected to close): a
    // 7th slug added in an ADJACENT sentence — anywhere outside this exact parenthetical — is not
    // caught by this anchor and stays a DISCLOSE-only accepted gap (see rules/agents.md Pin threat
    // model).
    if (!/category slug \(test-power\/overclaim\/match-direction\/unverified-claim\/scope\/other\)/.test(reviewerText))
      fail('.claude/agents/reviewer.md is missing the fusion-target third copy of the closed 6-word category-slug set at its "category slug (test-power/overclaim/...)" line (target: fusion Rules) — mutation-observation-points T4.4 tightening pass (A4)');
  }

  const qlPath = path.join(ROOT, '.claude', 'skills', 'quality-loop', 'SKILL.md');
  if (!fs.existsSync(qlPath)) fail('.claude/skills/quality-loop/SKILL.md missing — cannot verify Observation Points review duty (Phase 3)');
  else {
    const qlText = read(qlPath);

    const loopSection = qlText.match(/## Loop Contract \(max 3 cycles\)[\s\S]*?(?=\n## Stall handling)/);
    if (!loopSection) fail('.claude/skills/quality-loop/SKILL.md: "## Loop Contract" section not found (or unterminated before "## Stall handling") — mutation-observation-points Phase 3');
    else {
      if (!/compute\/decide side or any consumption site of an observation point[\s\S]*?must include \*\*M2\*\* \(every consumption site\), not\s*\n?\s*M1 alone/.test(loopSection[0]))
        fail('.claude/skills/quality-loop/SKILL.md "## Loop Contract" re-review mutation-evidence gate no longer names observation points (compute/decide side or consumption site) and requires M2 — mutation-observation-points Phase 3');
      // T4.4 fix (B7): M2 evidence must gate APPROVE at any cycle, not only step [4]'s re-review —
      // a cycle-1 APPROVE previously never reached the M2 gate at all.
      if (!/precondition of APPROVE at any cycle, not only on re-review/.test(loopSection[0]))
        fail('.claude/skills/quality-loop/SKILL.md "## Loop Contract" is missing the B7 any-cycle M2-precondition clause — mutation-observation-points T4.4 fix pass');

      const loopAnchorCount = (qlText.match(/## Loop Contract \(max 3 cycles\)/g) || []).length;
      if (loopAnchorCount !== 1)
        fail(`.claude/skills/quality-loop/SKILL.md: expected exactly 1 occurrence of the "## Loop Contract (max 3 cycles)" anchor, found ${loopAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);
      if (NEUTER_MARKER_RE.test(loopSection[0]))
        fail('.claude/skills/quality-loop/SKILL.md "## Loop Contract" contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A1; was C1 negative invariant)');
    }

    const redTeamSection = qlText.match(/### Red-Team Second Seat \(standing, relay-independent\)[\s\S]*?(?=\n### Lens Catalog)/);
    if (!redTeamSection) fail('.claude/skills/quality-loop/SKILL.md: "### Red-Team Second Seat" section not found (or unterminated before "### Lens Catalog") — mutation-observation-points Phase 3');
    else {
      if (!/deleting a consumption site \(a call, an envelope\/response assembly, or the branch that acts on it\) while every unit test stays green/.test(redTeamSection[0]))
        fail('.claude/skills/quality-loop/SKILL.md "### Red-Team Second Seat" lens text no longer names consumption-site deletion — mutation-observation-points Phase 3');

      const redTeamAnchorCount = (qlText.match(/### Red-Team Second Seat \(standing, relay-independent\)/g) || []).length;
      if (redTeamAnchorCount !== 1)
        fail(`.claude/skills/quality-loop/SKILL.md: expected exactly 1 occurrence of the "### Red-Team Second Seat (standing, relay-independent)" anchor, found ${redTeamAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 fix, C1)`);
      if (NEUTER_MARKER_RE.test(redTeamSection[0]))
        fail('.claude/skills/quality-loop/SKILL.md "### Red-Team Second Seat" contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A1; was C1 negative invariant)');
    }

    // Closed 6-word category set (:86-92 region) must stay byte-identical — Phase 3 explicitly
    // folds the new "observation wiring" finding into the existing `test-power` slug rather than
    // adding a new category word (plan Rejected Alternatives — a new word would split the
    // recurring-category tally into a separate slot).
    // T4.4 fix (B2): anchored the trailing backtick+")" so appending a 7th slug inside the quotes
    // no longer passes as a substring-prefix match (seat B's hostile mutation (i)).
    if (!/`test-power \/ overclaim \/ match-direction \/ unverified-claim \/ scope \/ other`\)/.test(qlText))
      fail('.claude/skills/quality-loop/SKILL.md no longer carries the closed 6-word category set verbatim, anchored to its exact quoting — mutation-observation-points Phase 3 requires this set stay untouched (observation wiring folds into `test-power`, not a new word); T4.4/B2 tightened the anchor to catch an appended 7th slug');

    // T4.4 fix (B10): the slug-merge disclosure must stay present so a future reader of the
    // recurring-category trigger knows `test-power` now covers two distinct defect classes.
    if (!/`test-power` now covers two\s*\ndistinct defect classes/.test(qlText))
      fail('.claude/skills/quality-loop/SKILL.md is missing the B10 slug-merge disclosure ("`test-power` now covers two distinct defect classes") — mutation-observation-points T4.4 fix pass');
  }
}

// ---- 17. Observation Points bugfix-path + standing-probe wiring (T4.4 fix pass, K1 pins 1-3) -----
// T4.4 code review (fusion K1, seat B's 6-site list) found 3 of the 6 undefended-consumption sites
// live outside the three files sections 14-16 already read: harness/SKILL.md's bugfix step 4 +
// Quality Gate line (O5 M1+M2), debugger.md's pointer line (O5), and rules/agents.md's executor
// standing-probe M2 expectation (O1②) — every one of these could be deleted with validate still
// reporting PASS. Section-scoped (6.1 method) where the file has a natural section boundary.
// T4.4 tightening pass (A3) correction: the debugger.md pointer is NOT "a single Fix-step bullet
// with no enclosing section" as this comment previously claimed — debugger.md has "### 5. Fix" /
// "### 6. Report" headings, and the pointer bullet sits inside that span. The pin below is now
// scoped to that span (red-team probe P8 had re-hosted the bullet into an unrelated appendix and
// stayed GREEN against the old whole-file-text check).
{
  const harnessSkillPath = path.join(ROOT, '.claude', 'skills', 'harness', 'SKILL.md');
  if (!fs.existsSync(harnessSkillPath)) fail('.claude/skills/harness/SKILL.md missing — cannot verify Observation Points bugfix-path wiring (K1 pin 1 / O5)');
  else {
    const harnessText = read(harnessSkillPath);

    const bugfixSection = harnessText.match(/### bugfix[\s\S]*?(?=\n### refactor)/);
    if (!bugfixSection) fail('.claude/skills/harness/SKILL.md: "### bugfix" section not found (or unterminated before "### refactor") — cannot verify the regression-test step\'s observation-point pointer (K1 pin 1 / O5)');
    else {
      if (!/run it as an observation point too — M1\/M2 per executor\.md's Detection power duty/.test(bugfixSection[0]))
        fail('.claude/skills/harness/SKILL.md "### bugfix" step 4 is missing the observation-point M1/M2 pointer — mutation-observation-points T4.4 fix pass (K1 pin 1 / O5)');

      // T4.4 tightening pass (A2): count===1 decoy-anchor hardening + the negative-invariant
      // neutering-marker guard, same rationale/mechanism as sections 14-16 (red-team P6 proved a
      // decoy re-host of the pinned sentence into an earlier "### bugfix"-headed span works here
      // exactly as it did in the sections already hardened for C1).
      const bugfixAnchorCount = (harnessText.match(/### bugfix/g) || []).length;
      if (bugfixAnchorCount !== 1)
        fail(`.claude/skills/harness/SKILL.md: expected exactly 1 occurrence of the "### bugfix" anchor, found ${bugfixAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 tightening pass, A2)`);
      if (NEUTER_MARKER_RE.test(bugfixSection[0]))
        fail('.claude/skills/harness/SKILL.md "### bugfix" section contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A2)');
    }

    // Closure pass (C2): previously matched heading-to-EOF unconditionally ([\s\S]*$). A red-team
    // probe showed that shape lets an attacker strip the operative-bullet clause and re-host it
    // verbatim under a NEW "## Appendix" heading appended at the end of the file: since that new
    // heading still sits after "## Quality Gate" and before EOF, the old unbounded extraction still
    // swept it in, so the content-presence check just below found the clause "present" even though
    // it no longer lived in the operative bullet — and the neuter guard didn't fire either, because
    // the re-hosted copy was labeled with words outside NEUTER_MARKER_RE's alternation (e.g. "旧規定"
    // rather than "撤回済み"). Bounding the span to stop at the next heading (of any level) instead
    // of running unconditionally to EOF excludes any such re-hosted appendix from the match, so the
    // content check now correctly goes RED when the clause is moved out of the operative bullet.
    // Behavior on the real, unmutated file is unchanged (there is currently no heading after
    // "## Quality Gate", so the match still runs to true EOF either way).
    const qualityGateSection = harnessText.match(/## Quality Gate[\s\S]*?(?=\n#{1,6} |$)/);
    if (!qualityGateSection) fail('.claude/skills/harness/SKILL.md: "## Quality Gate" section not found — cannot verify the bugfix regression-test observation-point line (K1 pin 1 / O5)');
    else {
      if (!/the regression-test step \(4\) additionally covers any observation point the fix touches \(M1\/M2, executor\.md Detection power\)/.test(qualityGateSection[0]))
        fail('.claude/skills/harness/SKILL.md "## Quality Gate" is missing the bugfix regression-test observation-point line — mutation-observation-points T4.4 fix pass (K1 pin 1 / O5)');

      // T4.4 tightening pass (A2): count===1 + negative-invariant hardening, same as bugfixSection
      // above. Correction (closure pass, C2): the comment that used to sit here reasoned that
      // because the count===1 check below counts ANCHOR TEXT occurrences across the WHOLE FILE
      // (independent of how the span itself is bounded), the old unconditional heading-to-EOF shape
      // needed no retargeting. That reasoning holds for the anchor count specifically (still true —
      // "## Quality Gate" occurs exactly once) but did NOT hold for the content-presence check or
      // the neuter guard just below, both of which scan qualityGateSection[0] itself: an unbounded
      // span let a re-hosted appendix (see the comment above the regex) satisfy both of those checks
      // without the clause being operative. The span is now bounded, closing that gap; this count
      // check is unaffected either way.
      const qualityGateAnchorCount = (harnessText.match(/## Quality Gate/g) || []).length;
      if (qualityGateAnchorCount !== 1)
        fail(`.claude/skills/harness/SKILL.md: expected exactly 1 occurrence of the "## Quality Gate" anchor, found ${qualityGateAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points T4.4 tightening pass, A2)`);
      if (NEUTER_MARKER_RE.test(qualityGateSection[0]))
        fail('.claude/skills/harness/SKILL.md "## Quality Gate" section contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the pinned duty span — mutation-observation-points T4.4 tightening pass (A2)');
    }
  }

  const debuggerPath = path.join(ROOT, '.claude', 'agents', 'debugger.md');
  if (!fs.existsSync(debuggerPath)) fail('.claude/agents/debugger.md missing — cannot verify Observation Points wiring (K1 pin 2 / O5)');
  else {
    const debuggerText = read(debuggerPath);
    // T4.4 tightening pass (A3): scoped to the "### 5. Fix" span (bounded by "### 6. Report")
    // instead of a whole-file-text test — see the header comment above this block.
    const fixSection = debuggerText.match(/### 5\. Fix[\s\S]*?(?=\n### 6\. Report)/);
    if (!fixSection) fail('.claude/agents/debugger.md: "### 5. Fix" section not found (or unterminated before "### 6. Report") — cannot verify the observation-point M1/M2 pointer (K1 pin 2 / O5)');
    else {
      if (!/run the same two mutations executor\.md's Detection power duty requires for an observation point \(M1: break the line that computes\/decides it; M2: break every place the product consumes it\) before reporting/.test(fixSection[0]))
        fail('.claude/agents/debugger.md "### 5. Fix" is missing the observation-point M1/M2 pointer — mutation-observation-points T4.4 fix pass (K1 pin 2 / O5)');

      // Closure pass (C1): this was the only one of the 9 section-scoped duty spans in this family
      // with no count===1 decoy-anchor guard at all — a red-team probe re-hosted this pointer
      // sentence under a decoy "### 5. Fix (...)" heading inserted ABOVE the real one and validate
      // stayed PASS, because match() above extracts from whichever "### 5. Fix" occurrence comes
      // first in the file (the decoy), not necessarily the real one. Same shape as the other 8
      // anchors in this family (sections 14-17).
      const fixAnchorCount = (debuggerText.match(/### 5\. Fix/g) || []).length;
      if (fixAnchorCount !== 1)
        fail(`.claude/agents/debugger.md: expected exactly 1 occurrence of the "### 5. Fix" anchor, found ${fixAnchorCount} — a decoy heading could hijack which span gets checked (mutation-observation-points closure pass, C1)`);
    }
  }

  const agentsRulePath = path.join(ROOT, '.claude', 'rules', 'agents.md');
  if (!fs.existsSync(agentsRulePath)) fail('.claude/rules/agents.md missing — cannot verify Observation Points wiring (K1 pin 3 / O1②)');
  else {
    const agentsRuleText = read(agentsRulePath);
    if (!/reports the consumption-side green as an M2 finding \(mutation-observation-points Phase 2\) — not a pass/.test(agentsRuleText))
      fail('.claude/rules/agents.md executor probe is missing the M2-finding PASS condition — mutation-observation-points T4.4 fix pass (K1 pin 3 / O1②)');
    // T4.4 fix (T3 durable home): the pin threat-model disclosure sentence itself must not silently
    // vanish either — it is the one place this repo states pins are tamper-evidence, not tamper-proof.
    if (!/tamper-EVIDENCE against accidental\/careless drift, not tamper-PROOF against an adversarial editor/.test(agentsRuleText))
      fail('.claude/rules/agents.md is missing the T4.4 pin threat-model disclosure ("tamper-EVIDENCE ... not tamper-PROOF") — mutation-observation-points T4.4 fix pass (C1/T3 durable home)');
  }
}

// ---- 18. CODEMAP file:line anchor drift ----
// codemap-anchor-validate plan (2026-08-16): CODEMAP.md's `file:line` annotations drift from the
// code they point at (the same breakage recurred 3 times — none of it caught until a human happened
// to read both files side by side). The fix is a machine cross-check: every annotation now carries
// an anchor (a literal substring of the line it names, joined after `#`), and this section verifies
// the anchor is still on the named line (PASS), has moved to another line in the same file (WARN,
// with the real line number), or is nowhere in the file / the file doesn't exist (FAIL). An anchor-
// less (pre-migration) annotation is a WARN-only grace period, never a FAIL, unless the file opts in
// via the アンカー移行済み marker (session-persistence.md §6.5 hygiene rules 7-8).
//
// Detection-power design (why 18a-18d exist as separate pins, not 1): a clean clone has ZERO
// tasks/CODEMAP.md content (both repos' CODEMAP files are gitignored) and may have zero dev/*
// products, so "the real files disagree with expectations" cannot be the floor — a degenerate
// scan (narrowed target list, disabled loop, broken extraction regex) would look identical to "there
// is legitimately nothing to check". The floor instead lives entirely in files that ARE committed:
// P1 (18a) pins the derived target-list against session-persistence.md's own frontmatter; P2 (18b)
// pins that the scan loop actually visited every glob P1 derived (recorded and compared OUTSIDE the
// loop body on purpose — deleting the loop leaves the visited-list empty, which still fails the
// comparison); P3 (18d) pins the glob->file expander (`expandTargets`/`listDir`) against a fixture
// product-root tree so the expander itself is exercised even when dev/ has zero real products; 18d
// also runs the whole classifier against a committed fixture map with a literal expected-value table
// (`CASES`), so gutting the classification logic itself goes RED independent of any real file.
//
// code-review-cycle1-fusion.md F1: the above pinned classification (v/code/found) but never pinned
// the layer AFTER it — message emission, the fail-vs-warn dispatch, and the running counters — so
// 18b's real-file path (the fixture structurally could never reach it) had zero coverage at 6 named
// consumption sites. Fixed by routing BOTH the fixture and real files through the same
// scanCodemapTarget()/applyCodemapResult() functions: 18d now asserts per-case that a warn/fail
// message was actually emitted (with the correct drift line numbers), that anchored/unanchored/
// fenced-token counts match a value derived from CASES itself, and — via a capture sink passed to
// the SAME applyCodemapResult() 18b calls — that the fail/warn dispatch and all 3 counter increments
// route correctly. See code-review-cycle1-fusion.md F1 for the mutation-by-mutation RED evidence.
//
// Disclosed gaps (named here so a future reader does not mistake "not covered" for "covered"):
//   - A mutation that special-cases the REAL product root only (e.g. `if (dir === path.join(ROOT,
//     'dev')) return []`) is NOT caught: P1/P2 only pin the glob STRINGS, and P3 exercises the
//     expander only against the fixture's own product root (`codemap-anchor.fixture-root/`), which
//     that kind of mutation does not touch. Accepted: a clean clone legitimately has zero dev/*
//     products, so real-file product COUNT cannot be used as a floor (would reject the legitimate
//     zero-product state). Same reasoning extends to the dev/{name} baseDir derivation below
//     (`path.dirname(path.dirname(...))`) — it is exercised only on real scan targets, and the
//     fixture has no equivalent to exercise it against. Measured GREEN (code-review-cycle1-fusion.md
//     F1/R1, and PLAN.md M1f): mutating the real-root special case leaves exit 0.
//   - Same category, found DURING this remediation pass (not by the original review): 18b's call
//     `applyCodemapResult(target, codemapTotals)` passes a specific object by reference; swapping the
//     2nd argument for any other object shaped like a sink (e.g. a throwaway `{ fail, warn, files: 0,
//     anchored: 0, unanchored: 0 }`) leaves `codemapTotals` at its initial zeros and the header prints
//     "0 files, 0 anchored, 0 unanchored" with exit 0 — the fixture's capture-sink calls in 18d use
//     their OWN local sink objects and cannot observe which object 18b's call site happens to pass.
//     Not fixable by a floor on the real count for the same reason as the bullet above (a clean clone
//     legitimately scans 0 real files). Measured GREEN: 2026-08-16, this remediation pass.
//   - The absolute-path rejection's char class (`^(?:[A-Za-z]:[\\/]|[\\/])`) needs BOTH backslash and
//     forward slash for the same OS-independence reason the `..`-segment check below does (C20 pins
//     that one) — but no fixture case isolates the backslash half of THIS regex (C18 is
//     `/tmp/absolute.txt`, caught by the slash-only second alternative regardless of the drive-letter
//     branch's own char class). Narrowing `[A-Za-z]:[\\/]` to `[A-Za-z]:[\/]` therefore stays GREEN.
//     Not fixed here (would need a 22nd fixture case and a re-derivation of every extraction-count-
//     dependent expected value) — recorded as an undefended consumption site, not hidden.
//   - realpath() is never called (symlinks/junctions are not resolved) — lexical containment only.
//     A junction inside the product root pointing outside it is not caught. Accepted, with a
//     narrower claim than earlier drafts made (code-review-cycle1-fusion.md F7): writing an
//     annotation only reveals a line NUMBER, never file content (the canary check in 18d enforces
//     this) — but "whoever can edit the CODEMAP can already read the real file" does NOT hold for a
//     file the Read tool's deny-list / block-secret-read.js refuse (`.env`, `*.pem`, `*.key`,
//     `**/secrets/**`): this check is a guessing oracle over those files that a direct read is not.
//     The same deny is already bypassable more directly via `grep`/`sed`/`awk`/`node -e` (one pass,
//     full content) — that is why this is accepted rather than fixed here, not because the original
//     "already readable" reasoning was correct.
//   - `.txt` (not `.md`) is the fixture extension by design, not by directory placement: walkMd
//     (#4/#9.5, `/\.(md|js|json|html)$/`) and walkJs (#9, `/\.(js|mjs)$/`) both skip `.txt`, which
//     matters because these fixtures deliberately contain "broken" examples (dead-ref-shaped paths,
//     absolute paths) that must never be scanned as if they were real harness content.
const CODEMAP_CANARY = 'ZZLEAKCANARYZZ';
const CODEMAP_EXPECTED_EXTRACTED = 21;
const CODEMAP_EXPECTED_EXTRACTED_MIGRATED = 1;
const CODEMAP_EXPECTED_CASES = 21;
const CODEMAP_LOW_DISTINCT_LINES = 10;
const CODEMAP_FOUND_DISPLAY_CAP = 20; // F11: drift WARNs cap the printed line-number list so one
// pathological match count cannot balloon a single message to megabytes and bury real FAILs below it
const CODEMAP_EXPECTED_FENCED_LIKE = 2; // F2/F3: N2 (full annotation) + N3 (bare annotation) inside the fixture's fenced block
const CODEMAP_EXPECTED_FIXTURE_PRODUCTS = ['products/alpha/tasks/map.txt', 'products/beta/tasks/map.txt'];
const CODEMAP_EXPECTED_TARGETS = ['tasks/CODEMAP.md', 'dev/*/tasks/CODEMAP.md'];
const CODEMAP_MIGRATION_MARKER_RE = /^アンカー移行済み:\s*\d{4}-\d{2}-\d{2}\s*$/m;
const CODEMAP_FULL_RE = /`([^`\n#]*?\.[A-Za-z][A-Za-z0-9]*):(\d[\d,\-]*)(?:#([^`\n]*))?`/g;
const CODEMAP_BARE_RE = /`:(\d[\d,\-]*)(?:#([^`\n]*))?`/g;
const CODEMAP_DECL_RE = /^>\s*file:\s*`([^`\n]+)`\s*$/;
const CODEMAP_HEADING_RE = /^#{1,6}\s/;
const CODEMAP_FENCE_RE = /^\s*(?:```|~~~)/;
const CODEMAP_REASON_TEXT = {
  'bare-no-decl': "a line-number-only annotation carries an anchor but has no governing `> file:` declaration",
  'no-decl': 'the annotation has no resolvable path',
  absolute: 'absolute path — annotations must be relative to the product root',
  dotdot: "path contains a `..` segment — annotations must stay inside the product root",
  escape: 'path resolves outside the product root',
  'empty-anchor': 'empty anchor — an empty anchor matches every line and would PASS forever',
  'no-file': 'referenced file does not exist — write the full path relative to the product root',
  'anchor-missing': 'anchor text is nowhere in the referenced file',
};
const CASES = [
  { id: 'C1', v: 'pass', code: 'ok', found: [1] },
  { id: 'C2', v: 'pass', code: 'low-distinct', found: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  { id: 'C3', v: 'warn', code: 'drift', found: [3] },
  { id: 'C4', v: 'fail', code: 'anchor-missing', found: [] },
  { id: 'C5', v: 'pass', code: 'ok', found: [2] },
  { id: 'C6', v: 'warn', code: 'drift', found: [3] },
  { id: 'C7', v: 'fail', code: 'no-file', found: [] },
  { id: 'C8', v: 'fail', code: 'empty-anchor', found: [] },
  { id: 'C9', v: 'pass', code: 'ok', found: [6] },
  { id: 'C10', v: 'fail', code: 'dotdot', found: [] },
  { id: 'C11', v: 'pass', code: 'ok', found: [7] },
  { id: 'C12', v: 'grace', code: 'unanchored', found: [] },
  { id: 'C13', v: 'pass', code: 'ok', found: [3] },
  { id: 'C14', v: 'fail', code: 'bare-no-decl', found: [] },
  { id: 'C15', v: 'grace', code: 'unanchored', found: [] },
  { id: 'C16', v: 'fail', code: 'no-file', found: [] },
  { id: 'C17', v: 'pass', code: 'ok', found: [1] },
  { id: 'C18', v: 'fail', code: 'absolute', found: [] },
  { id: 'C20', v: 'fail', code: 'dotdot', found: [] },
  { id: 'C21', v: 'pass', code: 'ok', found: [1] }, // F3: sits AFTER the fixture's fence closes — deleting the fence-close branch swallows this case too, giving the closing half of the fence toggle detection power
  { id: 'C22', v: 'fail', code: 'empty-anchor', found: [] }, // F5: whitespace-only anchor — must normalize before the empty-anchor guard, not just before matching
];
// Derived (not hardcoded) from CASES itself, which IS the committed, hand-authored source of truth
// pinned by CODEMAP_EXPECTED_CASES above — so a mutation to computeCodemapReport's anchored/
// unanchored counting is caught by comparing against these without duplicating a second hand-kept
// number that could itself drift from CASES.
const CODEMAP_EXPECTED_ANCHORED = CASES.filter((c) => c.v !== 'grace').length;
const CODEMAP_EXPECTED_UNANCHORED = CASES.filter((c) => c.v === 'grace').length;
const CODEMAP_EXPECTED_ANCHORED_MIGRATED = 0;
const CODEMAP_EXPECTED_UNANCHORED_MIGRATED = 1;

function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}
// expandTargets: a glob is "prefix segments + '*' + suffix segments" (exactly one wildcard depth —
// `dev/*/tasks/CODEMAP.md` and the fixture's `products/*/tasks/map.txt` are both this shape; `**`
// and multiple `*` are out of scope, CLAUDE.md §1.7). No '*' -> single-file existence check.
function expandTargets(rootDir, glob) {
  const starIdx = glob.indexOf('*');
  if (starIdx === -1) return fs.existsSync(path.join(rootDir, glob)) ? [glob] : [];
  const prefix = glob.slice(0, starIdx).replace(/\/$/, '');
  const suffix = glob.slice(starIdx + 1).replace(/^\//, '');
  const out = [];
  for (const name of listDir(path.join(rootDir, prefix)).sort()) {
    const candidate = `${prefix}/${name}/${suffix}`;
    if (fs.existsSync(path.join(rootDir, candidate))) out.push(candidate);
  }
  return out;
}
function hasMigrationMarker(text) {
  return CODEMAP_MIGRATION_MARKER_RE.test(text);
}
// countCodemapLikeTokens: counts annotation-shaped tokens on a line WITHOUT extracting them as real
// candidates — used only to measure what a fenced block skipped (F2), so adding a single ``` fence
// line to a CODEMAP is visible as a WARN instead of silently un-checking everything after it.
function countCodemapLikeTokens(lineText) {
  let n = 0;
  for (const _ of lineText.matchAll(CODEMAP_FULL_RE)) n++;
  for (const _ of lineText.matchAll(CODEMAP_BARE_RE)) n++;
  return n;
}
// codemapClassify: the decision order below IS the spec (session-persistence.md §6.5) — order
// matters because containment must be settled before existence is ever checked (a path that resolves
// outside the product root must never reach fs.existsSync on an attacker-chosen absolute target).
function codemapClassify(cand, baseDir) {
  if (cand.isBare && !cand.hasDecl) return { v: 'fail', code: 'bare-no-decl', found: [] };
  const p = cand.path;
  if (p == null) return { v: 'fail', code: 'no-decl', found: [] }; // defensive: unreachable unless the line above is mutated away
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(p) || path.isAbsolute(p)) return { v: 'fail', code: 'absolute', found: [] };
  if (p.split(/[\\/]/).includes('..')) return { v: 'fail', code: 'dotdot', found: [] };
  const baseAbs = path.resolve(baseDir);
  const abs = path.resolve(baseAbs, p);
  const contained = process.platform === 'win32'
    ? abs.toLowerCase() === baseAbs.toLowerCase() || abs.toLowerCase().startsWith(baseAbs.toLowerCase() + path.sep)
    : abs === baseAbs || abs.startsWith(baseAbs + path.sep);
  if (!contained) return { v: 'fail', code: 'escape', found: [] }; // POSIX: unreachable behind the 2 guards above; win32: reachable via a drive-relative path (e.g. `C:x.txt`) — still FAILs, containment holds either way
  if (cand.anchor === undefined) return { v: 'grace', code: 'unanchored', found: [] };
  const norm = (s) => s.trim().replace(/\s+/g, ' ');
  const normAnchor = norm(cand.anchor);
  // F5 (code-review-cycle1-fusion.md): the empty-anchor guard must look at the NORMALIZED anchor,
  // not the raw one — a whitespace-only anchor (' ', '\t') is non-empty raw but normalizes to '',
  // and an empty anchor matches every line (see the empty-anchor reason text), which would PASS
  // forever and — because a pass still counts toward anchoredCount — let a file game its way into
  // "fully anchored" migration-marker eligibility without any real anchor being written.
  if (normAnchor === '') return { v: 'fail', code: 'empty-anchor', found: [] };
  if (!fs.existsSync(abs)) return { v: 'fail', code: 'no-file', found: [] };
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return { v: 'warn', code: 'unreadable', found: [] };
  }
  const found = [];
  content.split('\n').forEach((lineText, i) => {
    if (norm(lineText).includes(normAnchor)) found.push(i + 1);
  });
  const firstLine = parseInt(String(cand.rawLines).split(/[,\-]/)[0], 10);
  if (found.includes(firstLine)) return { v: 'pass', code: found.length > CODEMAP_LOW_DISTINCT_LINES ? 'low-distinct' : 'ok', found };
  if (found.length > 0) return { v: 'warn', code: 'drift', found };
  return { v: 'fail', code: 'anchor-missing', found: [] };
}
// scanCodemap: extracts every candidate annotation from mapPath in document order, tracking the
// active `> file:` declaration scope and fence state line by line, then classifies each candidate
// against baseDir. Shared verbatim by 18b (real files) and 18d (the fixture) — the classifier and
// extractor are exercised identically by both, so a mutation that degrades either one shows up in
// whichever caller's expectations are pinned (real-file message shape, or the fixture's CASES table).
function scanCodemap(mapPath, baseDir) {
  const lines = read(mapPath).split('\n');
  let activeDecl = null;
  let inFence = false;
  let fencedLikeCount = 0; // F2: annotation-shaped tokens skipped because a fence was open
  const candidates = [];
  lines.forEach((lineText, idx) => {
    const mapLine = idx + 1;
    if (inFence) {
      if (CODEMAP_FENCE_RE.test(lineText)) {
        inFence = false; // F3: the CLOSE half of the toggle — C21 sits after this fence closes,
        // so deleting this branch (leaving inFence stuck true) makes C21 vanish from extraction too
        return;
      }
      fencedLikeCount += countCodemapLikeTokens(lineText);
      return;
    }
    if (CODEMAP_FENCE_RE.test(lineText)) {
      inFence = true;
      activeDecl = null; // fence start closes any open declaration scope
      return;
    }
    if (CODEMAP_HEADING_RE.test(lineText)) activeDecl = null; // any heading level closes the scope
    const declMatch = lineText.match(CODEMAP_DECL_RE);
    if (declMatch) {
      activeDecl = declMatch[1];
      return;
    }
    for (const m of lineText.matchAll(CODEMAP_FULL_RE))
      candidates.push({ mapLine, isBare: false, path: m[1], rawLines: m[2], anchor: m[3], hasDecl: true });
    for (const m of lineText.matchAll(CODEMAP_BARE_RE)) {
      const hasDecl = activeDecl !== null;
      const anchor = m[2];
      if (!hasDecl && anchor === undefined) continue; // no governing declaration + no anchor = invisible (indistinguishable from a port number), not a candidate
      candidates.push({ mapLine, isBare: true, path: activeDecl, rawLines: m[1], anchor, hasDecl });
    }
  });
  return { results: candidates.map((c) => ({ ...c, ...codemapClassify(c, baseDir) })), fencedLikeCount };
}
// F6: strip C0 control characters (ESC, CR, ...) from CODEMAP-sourced text before it is ever
// embedded in a printed WARN/FAIL line — display only, never used for matching (codemapClassify
// still searches against the raw anchor). Without this, an anchor containing ESC/CR sequences
// reaches console.log verbatim and can erase/overwrite a real FAIL line already on the terminal.
function codemapSanitizeForDisplay(s) {
  return s == null ? s : s.replace(/[\x00-\x1F\x7F]/g, '');
}
function describeCodemapAnnotation(r) {
  const anchor = codemapSanitizeForDisplay(r.anchor);
  const pathText = codemapSanitizeForDisplay(r.path);
  const anchorPart = anchor === undefined ? '' : `#${anchor}`;
  if (!r.isBare) return `\`${pathText}:${r.rawLines}${anchorPart}\``;
  const bare = `\`:${r.rawLines}${anchorPart}\``;
  return r.hasDecl ? `${bare} (> file: \`${pathText}\`)` : `${bare} (no governing \`> file:\` declaration)`;
}
// computeCodemapReport: turns classified candidates into the exact WARN/FAIL text (never pushing to
// the global warns/fails itself) — the caller decides whether to push (18b, real files) or compare
// against an expected shape (18d, the fixture's own self-check must not turn its OWN expected FAIL/
// WARN into a real one).
function computeCodemapReport(results, hasMarker, relLabel, fencedLikeCount = 0) {
  const messages = [];
  let anchoredCount = 0;
  let unanchoredCount = 0;
  let lowDistinctCount = 0;
  let enumCount = 0;
  for (const r of results) {
    if (r.v === 'grace') {
      unanchoredCount++;
      continue;
    }
    anchoredCount++;
    if (r.code === 'low-distinct') lowDistinctCount++;
    if (String(r.rawLines).includes(',')) enumCount++;
    if (r.v === 'warn' && r.code === 'drift') {
      const first = parseInt(String(r.rawLines).split(/[,\-]/)[0], 10);
      // F11: cap the printed line-number list so one high-match-count anchor cannot blow a single
      // message up to megabytes (which would bury real FAILs printed after it).
      const foundDisplay = r.found.length > CODEMAP_FOUND_DISPLAY_CAP
        ? `${r.found.slice(0, CODEMAP_FOUND_DISPLAY_CAP).join(', ')}, … (+${r.found.length - CODEMAP_FOUND_DISPLAY_CAP} more)`
        : r.found.join(', ');
      messages.push({ level: 'warn', text: `${relLabel}:${r.mapLine}: ${describeCodemapAnnotation(r)} — anchor is not on line ${first}; found on line(s) ${foundDisplay}` });
    } else if (r.v === 'warn' && r.code === 'unreadable') {
      messages.push({ level: 'warn', text: `${relLabel}:${r.mapLine}: ${describeCodemapAnnotation(r)} — could not read the referenced file (encoding or permissions)` });
    } else if (r.v === 'fail') {
      messages.push({ level: 'fail', text: `${relLabel}:${r.mapLine}: ${describeCodemapAnnotation(r)} — ${CODEMAP_REASON_TEXT[r.code]}` });
    }
  }
  if (unanchoredCount > 0) {
    if (hasMarker)
      messages.push({ level: 'fail', text: `${relLabel}: ${unanchoredCount} annotations are still un-anchored but the file carries the アンカー移行済み marker — anchor them; removing the marker rolls the migration back and must be recorded with a reason (PR body / journal), it is not a way to silence this check` });
    else
      messages.push({ level: 'warn', text: `${relLabel}: ${unanchoredCount} annotations are not yet anchored — drift is not checked for these (session-persistence.md §6.5)` });
  }
  if (lowDistinctCount > 0)
    messages.push({ level: 'warn', text: `${relLabel}: ${lowDistinctCount} anchors match more than 10 lines — pick a more distinctive substring` });
  if (enumCount > 0)
    messages.push({ level: 'warn', text: `${relLabel}: ${enumCount} enumeration annotations — only the first line number is checked` });
  if (fencedLikeCount > 0)
    messages.push({ level: 'warn', text: `${relLabel}: ${fencedLikeCount} annotation-like token(s) inside fenced block(s) were skipped — fences are not scanned (session-persistence.md §6.5)` });
  return { messages, anchoredCount, unanchoredCount };
}
// scanCodemapTarget + applyCodemapResult: the ONE shared path between real-file scanning (18b) and
// the fixture self-check (18d) for everything AFTER classification — marker detection, message
// dispatch (fail vs warn), and the running file/anchored/unanchored counters. Before this refactor
// (F1), 18d only ever compared codemapClassify()'s raw v/code/found against CASES and never touched
// these lines at all, so mutating the marker read, the dispatch ternary, or any of the 3 counter
// increments in 18b was invisible to the self-check even though it broke real-file behavior (the
// 18b real-file path the fixture structurally could not reach). Routing 18d's fixtures through the
// SAME functions with a capture sink instead of the real fail()/warn()/counters gives every one of
// those consumption sites a fixture-backed pin without ever letting fixture data touch the real
// VERDICT.
function scanCodemapTarget(mapPathAbs, baseDir, relLabel) {
  const { results, fencedLikeCount } = scanCodemap(mapPathAbs, baseDir);
  const marker = hasMigrationMarker(read(mapPathAbs));
  const report = computeCodemapReport(results, marker, relLabel, fencedLikeCount);
  return { results, marker, fencedLikeCount, ...report };
}
function applyCodemapResult(target, sink) {
  for (const msg of target.messages) (msg.level === 'fail' ? sink.fail : sink.warn)(msg.text);
  sink.files++;
  sink.anchored += target.anchoredCount;
  sink.unanchored += target.unanchoredCount;
}

// codemapTotals doubles as the real-file sink passed to applyCodemapResult() (F1 follow-up, found
// during this same remediation pass): an earlier draft copied a separate accumulator's fields into
// these 3 counters AFTER the loop, which was itself an unshared, unpinned consumption site (mutating
// the copy-out left the header silently at "0 files, 0 anchored, 0 unanchored" with exit 0). Using
// this object as the sink directly means there is no copy-out step left to mutate away.
const codemapTotals = { fail, warn, files: 0, anchored: 0, unanchored: 0 };

// -- 18a. target list derivation + pin P1 --
// Derived from session-persistence.md's OWN frontmatter (not a value hardcoded twice) — the paths:
// list already governs write-routing for CODEMAP.md, so this reads the same list rather than
// maintaining a second copy that could silently drift from it (F1: the target list must depend on a
// COMMITTED file, never on which real CODEMAP files happen to exist).
let derivedCodemapTargets = null;
{
  const sp = path.join(ROOT, '.claude', 'rules', 'session-persistence.md');
  if (!fs.existsSync(sp)) {
    fail('section 18 P1: .claude/rules/session-persistence.md missing — cannot derive the CODEMAP target list');
  } else {
    const spLines = read(sp).split('\n');
    const pathsIdx = spLines.findIndex((l) => /^paths:\s*$/.test(l));
    const all = [];
    if (pathsIdx !== -1) {
      for (let i = pathsIdx + 1; i < spLines.length; i++) {
        const m = spLines[i].match(/^\s*-\s+(\S+)\s*$/);
        if (!m) break;
        all.push(m[1]);
      }
    }
    derivedCodemapTargets = all.filter((g) => g.split('/').pop() === 'CODEMAP.md');
    if (JSON.stringify(derivedCodemapTargets) !== JSON.stringify(CODEMAP_EXPECTED_TARGETS)) {
      fail(`section 18 P1: derived CODEMAP target list from session-persistence.md frontmatter is [${derivedCodemapTargets.join(', ')}] but must be [${CODEMAP_EXPECTED_TARGETS.join(', ')}]`);
      // F14 (code-review-cycle1-fusion.md): fail() does not throw, so without this line 18b would
      // keep scanning a target list that P1 has just declared untrustworthy (e.g. a `../` segment
      // that slipped into the frontmatter) — nulling it here makes 18b's `|| []` fall back to zero
      // targets instead of following a P1-rejected list.
      derivedCodemapTargets = null;
    }
  }
}

// -- 18b. real-file scan + pin P2 --
{
  const visitedGlobs = [];
  for (const glob of derivedCodemapTargets || []) {
    visitedGlobs.push(glob);
    for (const relTarget of expandTargets(ROOT, glob)) {
      const mapPathAbs = path.join(ROOT, relTarget);
      const baseDir = path.dirname(path.dirname(mapPathAbs));
      let target;
      try {
        target = scanCodemapTarget(mapPathAbs, baseDir, rel(mapPathAbs));
      } catch {
        // F15: B16 already fail-opens on an unreadable REFERENCED file (warn, not a crash) — the
        // CODEMAP file itself had no equivalent guard and took the whole validator down instead.
        warn(`${rel(mapPathAbs)}: could not read the CODEMAP file itself (encoding or permissions) — skipping anchor checks for this file`);
        continue;
      }
      applyCodemapResult(target, codemapTotals);
    }
  }
  if (derivedCodemapTargets !== null && JSON.stringify(visitedGlobs) !== JSON.stringify(derivedCodemapTargets))
    fail(`section 18 P2: visited [${visitedGlobs.join(', ')}] but the derived target list is [${(derivedCodemapTargets || []).join(', ')}]`);
}

// -- 18c. session-persistence.md §6.5 template pin --
// Section-scoped (6.1 method): a generic whole-file phrase pin would tolerate the template lines
// being gutted while some other sentence elsewhere keeps a pinned phrase alive.
{
  const spPath = path.join(ROOT, '.claude', 'rules', 'session-persistence.md');
  if (!fs.existsSync(spPath)) {
    fail('.claude/rules/session-persistence.md missing — cannot verify the CODEMAP §6.5 anchor-format template');
  } else {
    const spText = read(spPath);
    const headingCount = (spText.match(/### 6\.5 CODEMAP\.md/g) || []).length;
    if (headingCount !== 1)
      fail(`.claude/rules/session-persistence.md: expected exactly 1 occurrence of the "### 6.5 CODEMAP.md" heading, found ${headingCount} — a decoy heading could hijack which span the anchor-format pin below checks`);
    const m = spText.match(/### 6\.5 CODEMAP\.md[\s\S]*?(?=\n### |\n---)/);
    if (!m) {
      fail('.claude/rules/session-persistence.md: "### 6.5 CODEMAP.md" section not found (or unterminated before the next "### " heading) — cannot verify the anchor-format template');
    } else {
      const section = m[0];
      const items = [
        [/- <step> — `<file>:<line>#<anchor>`/, 'the Main flow template line in the anchor-carrying form'],
        [/- <entry point> — `<file>:<line>#<anchor>`/, 'the Entry points template line in the anchor-carrying form'],
        [/the main flow with `<file>:<line>#<anchor>` annotations \(the anchor is a literal substring of that line; validate\.mjs section 18 machine-checks it\)/, 'hygiene rule (1) in its anchor-aware wording'],
      ];
      for (const [re, label] of items)
        if (!re.test(section)) fail(`.claude/rules/session-persistence.md §6.5 is missing ${label} — codemap-anchor-validate T1.1/T1.2`);
      const oldFormCount = section.split('`<file>:<line>`').length - 1;
      if (oldFormCount > 0)
        fail(`.claude/rules/session-persistence.md §6.5: found ${oldFormCount} occurrence(s) of the pre-anchor form (backtick <file>:<line> with no #<anchor>) — the anchor-format migration must not leave the old placeholder form behind`);
      if (NEUTER_MARKER_RE.test(section))
        fail('.claude/rules/session-persistence.md §6.5 contains a neutering marker (withdrawn/repealed/retired/not-operative/撤回済み, case-insensitive) inside the CODEMAP anchor-format section');
    }
  }
}

// -- 18d. fixture self-check + pin P3 --
{
  const fixtureDir = path.join(ROOT, '.claude', 'scripts');
  const fixtureMapPath = path.join(fixtureDir, 'codemap-anchor.fixture-map.txt');
  const fixtureMigratedPath = path.join(fixtureDir, 'codemap-anchor.fixture-map-migrated.txt');
  const fixtureRoot = path.join(fixtureDir, 'codemap-anchor.fixture-root');
  const fixtureRelLabel = 'codemap-anchor.fixture-map.txt';
  const migratedRelLabel = 'codemap-anchor.fixture-map-migrated.txt';
  let fixtureReportMessages = [];
  let target = null;
  let migTarget = null;

  if (!fs.existsSync(fixtureMapPath)) {
    fail('section 18 fixture: codemap-anchor.fixture-map.txt is missing — the self-check cannot run');
  } else {
    target = scanCodemapTarget(fixtureMapPath, fixtureDir, fixtureRelLabel);
    const results = target.results;
    if (results.length !== CODEMAP_EXPECTED_EXTRACTED)
      fail(`section 18 fixture: extracted ${results.length} candidate annotation(s) from codemap-anchor.fixture-map.txt, expected ${CODEMAP_EXPECTED_EXTRACTED}`);
    if (CASES.length !== CODEMAP_EXPECTED_CASES)
      fail(`section 18 fixture: CASES has ${CASES.length} entries, expected ${CODEMAP_EXPECTED_CASES}`);
    const fixtureLines = read(fixtureMapPath).split('\n');
    let compared = 0;
    for (const expected of CASES) {
      const r = results.find((res) => {
        const lm = (fixtureLines[res.mapLine - 1] || '').match(/\bC(\d+)\b/);
        return lm && `C${lm[1]}` === expected.id;
      });
      if (!r) {
        fail(`section 18 fixture: case ${expected.id} not found among extracted annotations`);
        continue;
      }
      compared++;
      if (r.v !== expected.v || r.code !== expected.code || JSON.stringify(r.found) !== JSON.stringify(expected.found))
        fail(`section 18 fixture: case ${expected.id} is ${r.v}/${r.code}/[${r.found.join(',')}] but expected ${expected.v}/${expected.code}/[${expected.found.join(',')}]`);
      // F1 (a)/(b)/(c): CASES above only pins codemapClassify()'s raw v/code/found — it never proved
      // computeCodemapReport() actually EMITS a message for a warn/fail case, or that a drift message
      // carries the right line number(s). Assert the emitted message text directly.
      if (expected.v === 'warn' || expected.v === 'fail') {
        const msg = target.messages.find((m) => m.text.startsWith(`${fixtureRelLabel}:${r.mapLine}:`) && m.level === expected.v);
        if (!msg)
          fail(`section 18 fixture: case ${expected.id} (${expected.v}/${expected.code}) produced no ${expected.v}-level message at ${fixtureRelLabel}:${r.mapLine}`);
        else if (expected.code === 'drift' && !msg.text.includes(`found on line(s) ${expected.found.join(', ')}`))
          fail(`section 18 fixture: case ${expected.id} drift message does not report line(s) ${expected.found.join(', ')}: "${msg.text}"`);
      }
    }
    if (compared !== CASES.length)
      fail(`section 18 fixture: ${compared} of ${CASES.length} cases were actually compared`);
    if (target.anchoredCount !== CODEMAP_EXPECTED_ANCHORED || target.unanchoredCount !== CODEMAP_EXPECTED_UNANCHORED)
      fail(`section 18 fixture: codemap-anchor.fixture-map.txt anchored/unanchored counts are ${target.anchoredCount}/${target.unanchoredCount}, expected ${CODEMAP_EXPECTED_ANCHORED}/${CODEMAP_EXPECTED_UNANCHORED}`);
    if (target.fencedLikeCount !== CODEMAP_EXPECTED_FENCED_LIKE)
      fail(`section 18 fixture: fenced-block annotation-like token count is ${target.fencedLikeCount}, expected ${CODEMAP_EXPECTED_FENCED_LIKE}`);
    fixtureReportMessages = target.messages;
  }

  if (!fs.existsSync(fixtureMigratedPath)) {
    fail('section 18 fixture: codemap-anchor.fixture-map-migrated.txt is missing — the self-check cannot run');
  } else {
    migTarget = scanCodemapTarget(fixtureMigratedPath, fixtureDir, migratedRelLabel);
    if (migTarget.results.length !== CODEMAP_EXPECTED_EXTRACTED_MIGRATED)
      fail(`section 18 fixture: extracted ${migTarget.results.length} candidate annotation(s) from codemap-anchor.fixture-map-migrated.txt, expected ${CODEMAP_EXPECTED_EXTRACTED_MIGRATED}`);
    if (migTarget.anchoredCount !== CODEMAP_EXPECTED_ANCHORED_MIGRATED || migTarget.unanchoredCount !== CODEMAP_EXPECTED_UNANCHORED_MIGRATED)
      fail(`section 18 fixture: codemap-anchor.fixture-map-migrated.txt anchored/unanchored counts are ${migTarget.anchoredCount}/${migTarget.unanchoredCount}, expected ${CODEMAP_EXPECTED_ANCHORED_MIGRATED}/${CODEMAP_EXPECTED_UNANCHORED_MIGRATED}`);
    const migFails = migTarget.messages.filter((m) => m.level === 'fail');
    if (migFails.length !== 1 || !/アンカー移行済み marker/.test(migFails[0].text))
      fail(`section 18 fixture: codemap-anchor.fixture-map-migrated.txt self-check expected exactly 1 FAIL message naming the アンカー移行済み marker, got ${JSON.stringify(migTarget.messages)}`);
    fixtureReportMessages = fixtureReportMessages.concat(migTarget.messages);
  }

  if (fixtureReportMessages.some((m) => m.text.includes(CODEMAP_CANARY)))
    fail('section 18 fixture: a WARN/FAIL message leaked file content (canary token found) — messages must report line numbers only, never file content');

  // F1 (d)/(e)/(f): route both fixtures through the SAME applyCodemapResult() 18b uses (marker read
  // is already inside scanCodemapTarget, shared above), but into a capture sink instead of the real
  // fail()/warn()/counters — this gives the dispatch ternary and all 3 counter increments a fixture-
  // backed pin instead of only ever running against real files nothing here compared against.
  if (target && migTarget) {
    const fxFails = [];
    const fxWarns = [];
    const fxSink = { fail: (t) => fxFails.push(t), warn: (t) => fxWarns.push(t), files: 0, anchored: 0, unanchored: 0 };
    applyCodemapResult(target, fxSink);
    applyCodemapResult(migTarget, fxSink);
    const expectedFxFails = target.messages.filter((m) => m.level === 'fail').length + migTarget.messages.filter((m) => m.level === 'fail').length;
    const expectedFxWarns = target.messages.filter((m) => m.level === 'warn').length + migTarget.messages.filter((m) => m.level === 'warn').length;
    if (fxFails.length !== expectedFxFails)
      fail(`section 18 fixture: applyCodemapResult routed ${fxFails.length} message(s) to the fail sink, expected ${expectedFxFails}`);
    if (fxWarns.length !== expectedFxWarns)
      fail(`section 18 fixture: applyCodemapResult routed ${fxWarns.length} message(s) to the warn sink, expected ${expectedFxWarns}`);
    if (fxSink.files !== 2)
      fail(`section 18 fixture: applyCodemapResult was invoked for ${fxSink.files} target(s), expected 2`);
    const expectedFxAnchored = CODEMAP_EXPECTED_ANCHORED + CODEMAP_EXPECTED_ANCHORED_MIGRATED;
    const expectedFxUnanchored = CODEMAP_EXPECTED_UNANCHORED + CODEMAP_EXPECTED_UNANCHORED_MIGRATED;
    if (fxSink.anchored !== expectedFxAnchored || fxSink.unanchored !== expectedFxUnanchored)
      fail(`section 18 fixture: applyCodemapResult accumulated ${fxSink.anchored}/${fxSink.unanchored} anchored/unanchored, expected ${expectedFxAnchored}/${expectedFxUnanchored}`);
  }

  // P3 is deliberately NOT gated on fixture-map.txt's presence (a retired/moved fixture map must not
  // also silence the expander check) — it runs unconditionally against the fixture product root.
  const expandedProducts = expandTargets(fixtureRoot, 'products/*/tasks/map.txt');
  if (JSON.stringify(expandedProducts) !== JSON.stringify(CODEMAP_EXPECTED_FIXTURE_PRODUCTS))
    fail(`section 18 fixture: product-glob expansion is [${expandedProducts.join(',')}] but must be [${CODEMAP_EXPECTED_FIXTURE_PRODUCTS.join(',')}]`);
  // Permanent pin for listDir's existsSync guard (review-cycle3.md non-blocking #7): a nonexistent
  // glob prefix must expand to [], not throw — V5b below only exercises this once, by hand, against
  // the real dev/ directory; this makes the same guarantee a standing per-run check.
  const nonexistentExpansion = expandTargets(fixtureRoot, 'no-such-prefix/*/tasks/map.txt');
  if (nonexistentExpansion.length !== 0)
    fail(`section 18 fixture: expandTargets() against a nonexistent glob prefix returned [${nonexistentExpansion.join(',')}] instead of [] — listDir's existsSync guard must return [] for a directory that does not exist`);
}

// ---- Report ----
console.log('Harness Validation (v2)');
console.log(`  agents: ${agentNames.size} | skills: ${fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length} | hooks registered: ${registered.size}`);
console.log(`  codemap: ${codemapTotals.files} files, ${codemapTotals.anchored} anchored, ${codemapTotals.unanchored} unanchored`);
for (const w of warns) console.log('  WARN  ' + w);
for (const f of fails) console.log('  FAIL  ' + f);
console.log(fails.length ? `\nVERDICT: FAIL (${fails.length} findings, ${warns.length} warnings)` : `\nVERDICT: PASS (${warns.length} warnings)`);
process.exit(fails.length ? 1 : 0);
