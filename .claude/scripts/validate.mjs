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
// CLAUDE.md §2: planner/reviewer default to native Fable, permit only native Fable or Opus in an
// authority dispatch, and pin effort:max. Opus is an explicit retry after a recorded Fable failure,
// not a frontmatter default and never a silent/lower-tier fallback.
const EFFORT_MAX_AGENTS = new Set(['planner', 'reviewer']);
const AUTHORITY_MODELS = new Set(['fable', 'opus']);
const AUTHORITY_DEFAULT_MODEL = 'fable';

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
  if (EFFORT_MAX_AGENTS.has(fm.name) && fm.effort !== 'max')
    fail(`agent ${fm.name}: missing "effort: max" in frontmatter (CLAUDE.md §2 requires this pin to guarantee max-depth reasoning for the final quality gate)`);
  if (EFFORT_MAX_AGENTS.has(fm.name) && !AUTHORITY_MODELS.has(fm.model))
    fail(`agent ${fm.name}: model "${fm.model}" is not in the authority allowlist (${[...AUTHORITY_MODELS].join(' | ')})`);
  if (EFFORT_MAX_AGENTS.has(fm.name) && fm.model !== AUTHORITY_DEFAULT_MODEL)
    fail(`agent ${fm.name}: frontmatter default must be "${AUTHORITY_DEFAULT_MODEL}" — Opus is allowed only as an explicit retry after a recorded Fable availability/usage-limit/startup failure`);
}

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
    const ar = eventsOf('archive-session-state.js');
    if (!ar.some((e) => e.event === 'PreToolUse' && /\bWrite\b/.test(e.matcher)))
      fail('archive-session-state.js is not registered under PreToolUse Write — session-state history stops being archived');
  }
  // History retention: the archive hook must never regrow a rotation/deletion code path
  // (user ruling 2026-08-02: session-state history is kept in full).
  {
    const p = path.join(ROOT, '.claude', 'hooks', 'archive-session-state.js');
    if (fs.existsSync(p) && /unlinkSync|rmSync|\brotate\s*\(/.test(read(p)))
      fail('archive-session-state.js contains a deletion/rotation code path — v2 keeps session-state history in full');
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
  // and the statusline must keep surfacing the lock (silent locks breed confusion).
  {
    const cwPath = path.join(ROOT, '.claude', 'hooks', 'cmd-write-guard.js');
    if (fs.existsSync(cwPath) && !/\\?\.claude\[\\\\\/\]\+state|\.claude[\\/]+state/.test(read(cwPath)))
      fail('cmd-write-guard.js no longer references .claude/state — the unconditional lock-file shell protection is gone');
    const slPath = path.join(ROOT, '.claude', 'scripts', 'statusline.js');
    if (fs.existsSync(slPath) && !/scope-lock/.test(read(slPath)))
      fail('statusline.js no longer reads scope-lock — the 🔒 indicator is gone (locks become invisible)');
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
}

// ---- 4. Dead references in core docs/config ----
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
  [/(?:^|[^\w/])\/wrap\b/, 'there is no /wrap skill — the enhanced /save-session owns the report/save flow'],
  [/frontier dispatch override/i, 'renamed to "frontier authority convention" — the override no longer exists (CLAUDE.md §2 ¹)'],
  [/\borchestrate\b/, 'skill "orchestrate" was renamed to "harness"'],
  [/\bslop-clean\b/, 'skill "slop-clean" was renamed to "code-cleaner"'],
];
const ALLOW_LINE = /旧|former|formerly|renamed|previously|removed|削除|廃止|merged|統合|does not exist|dead|must not be referenced/; // allow history/explanatory text (JA/EN) and this validator's own wording
const scan = [path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'README.md')];
// Vendored code sub-projects are code, not harness docs/config — exclude them from the harness
// dead-ref scan (clover legitimately references e.g. ~/.codex/ for codex OAuth).
const SUBPROJECTS = new Set([path.join(ROOT, 'clover')]);
const walkMd = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SUBPROJECTS.has(p) && e.name !== 'node_modules') walkMd(p); }
    else if (/\.(md|js|json)$/.test(e.name)) scan.push(p);
  }
};
walkMd(path.join(ROOT, '.claude'));
for (const p of scan) {
  if (!fs.existsSync(p)) continue;
  if (p.includes('scripts')) continue; // validator self-reference
  const lines = read(p).split('\n');
  lines.forEach((line, i) => {
    if (ALLOW_LINE.test(line)) return;
    for (const [re, why] of FORBIDDEN)
      if (re.test(line)) fail(`dead ref ${rel(p)}:${i + 1} — ${why}\n      ${line.trim().slice(0, 100)}`);
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
  ['.claude/rules/session-persistence.md', /never rotated or deleted/i, 'session-persistence §6.2 must keep the full-retention sentence for session-state history'],
  // --- carried from v1 (subject files exist as of Phase 4) ---
  ['.claude/skills/quality-loop/SKILL.md', /Fable×2[\s\S]*Opus×2/, 'quality-loop must keep the standing same-model authority pair: Fable×2 normally or Opus×2 after recorded fallback'],
  ['.claude/skills/quality-loop/SKILL.md', /never a mixed pair/i, 'quality-loop must explicitly forbid mixed Fable/Opus standing pairs'],
  ['.claude/skills/quality-loop/SKILL.md', /Never switch silently/i, 'quality-loop must forbid silent Fable-to-Opus fallback'],
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
  ['.claude/skills/quality-loop/SKILL.md', /Lens Catalog[\s\S]*4 seats total/, 'quality-loop must keep the Lens Catalog section with the 4-seat hard cap'],
  ['.claude/skills/quality-loop/SKILL.md', /Security Track \(on request or auto-seated\)/, 'quality-loop must keep the Security Track auto-seat section — the conductor seats security on API/DB/auth/payment signals without being asked (user ruling 2026-08-02)'],
  ['.claude/skills/quality-loop/SKILL.md', /not seated \(no risk signals\)/, 'quality-loop must keep the mandatory security-attendance recording line — a silent skip of the risk check must stay visible'],
  ['.claude/skills/plan/SKILL.md', /securityReview/, 'plan SKILL.md must keep the scope.json securityReview flag — the plan-time path that auto-seats security for the whole locked run'],
];
for (const [relPath, must, why] of INVARIANTS) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) { fail(`invariant: ${relPath} missing — cannot verify "${why}"`); continue; }
  if (!must.test(read(p))) fail(`invariant lost in ${relPath} — ${why} (expected /${must.source}/${must.flags})`);
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

// ---- Report ----
console.log('Harness Validation (v2)');
console.log(`  agents: ${agentNames.size} | skills: ${fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length} | hooks registered: ${registered.size}`);
for (const w of warns) console.log('  WARN  ' + w);
for (const f of fails) console.log('  FAIL  ' + f);
console.log(fails.length ? `\nVERDICT: FAIL (${fails.length} findings, ${warns.length} warnings)` : `\nVERDICT: PASS (${warns.length} warnings)`);
process.exit(fails.length ? 1 : 0);
