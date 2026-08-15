---
name: harness
description: >
  複数の専門エージェントを束ねてタスクを端から端まで遂行する並列ワークフローのルーター。 feature（新機能）/ bugfix（バグ修正）/ refactor（リファクタ）/ security（セキュリティ審査）/ research（事前調査）の5種から目的に合うワークフローを選び、planner・executor・reviewer・verifier 等を委任・調整する（指揮者はコードを直接触らず委任と判断に徹する）。 タスクを複数エージェントで分担・並列実行したい時、「harness で」「ワークフローを回して」「マルチエージェントで進めて」と頼まれた時に使う。
user-invocable: true
---

# Multi-Agent Orchestration

Coordinate multiple specialized agents to complete a task end-to-end.

## Usage
```
/harness [workflow-type] [task description]
```

## Workflow Types

> The model for each step is determined by **the tier of the agent being invoked** (the agent frontmatter alias is the SOT; tier definitions are in CLAUDE.md §2 Model Tier Policy). Tiers are noted here for reference, but once you specify the agent the model is chosen automatically.

### feature (default)
The full quality cycle for new feature implementation:
1. **planner** (heavy) → requirements organization and task breakdown
2. **planner** self-review mode (heavy) → independent review of the plan (when non-trivial)
3. **executor** (standard) → implementation + behavior-based test creation (parallelizable per task)
4. **reviewer** target: code (heavy) → code review (Writer/Reviewer separation)
5. **verifier** (standard) → test execution + evidence-based verification

For product-shaped requests, planner's gap proposals / objections must go through a single batched `AskUserQuestion` ruling with the user before executor is launched (CLAUDE.md §1.10) — `/harness` is not a substitute for that ruling gate.

### bugfix
Autonomous, convergent bug fixing that touches the user **at most once**. Reproduce first, loop internally, escalate cleanly.
1. **Reproduce-first gate** → establish a *failing* reproduction (test / command / log) before involving the user. **debugger** (standard) tries autonomously: re-run the cited command, write a minimal repro test, add targeted logging, grep the code. Do **not** ask the user while reproduction is still attainable on your own.
2. **Root-cause** → **debugger** (standard):
   - *Cause clear* (obvious from trace/diff) → serial path, go to step 3.
   - *Cause unclear* → **fan out hypotheses in parallel** (one debugger per hypothesis, cap 3 — a single multi-dispatch): each runs its single most *discriminating* probe and reports eliminate/survive with an evidence chain (debugger Active-Disconfirmation format). Collect → eliminate the falsified: **exactly one survives** → it proceeds to the fix; **≥2 survive** → one more discriminating round on the survivors; **0 survive** (the cause was outside the set) → regenerate hypotheses or hand to the debugger's heavy pass. (Tie/empty resolution is the debugger's Active-Disconfirmation loop — and this parallel entry means you don't burn 3 serial cycles first.)
3. **Fix → verify loop (internal, max 3 cycles)** → debugger/executor writes the minimal fix → **verifier** (standard) runs evidence-based PASS/FAIL. On FAIL, findings go **back to the debugger**, not the user; repeat. Follows the quality-loop Loop Contract + §1.5; the user is not consulted between cycles.
4. **Regression test** → **executor** (standard) adds a test that reproduces the **confirmed root cause** — written as soon as the cause is pinned, and moved with it if the cycle-3 angle change relocates the cause, so "green" is provable against the real cause (not a stale hypothesis). If the fix changes an externally-observable behavior, run it as an observation point too — M1/M2 per executor.md's Detection power duty (mutation-observation-points).
5. **reviewer** target: code (heavy) → code review of the fix + regression test before closing the flow (Writer/Reviewer separation — the fix→verify loop's verifier gate is empirical, not an independent authority judgment)
6. **Converge or escalate once** → never repeat a failing approach: **by the 3rd cycle switch angle** (re-fan hypotheses with what's ruled out, or the debugger's heavy pass — §1.5), so the 3-cycle budget is never spent hammering one stuck approach. If the 3rd cycle still fails, surface to the user **exactly once** via a single batched `AskUserQuestion` with a structured status: `Bug / Reproduction / Tried / Ruled-out / Blocker / Decision-needed` (plain language, Language §). Every batched `AskUserQuestion` states one line naming the premise all its options share — an option that only varies a detail inside an unstated premise cannot be challenged. (3-cycle cap = quality-loop Loop Contract + §1.5; the angle change is the §1.5 replan *at* the boundary, not a 4th attempt.)

### refactor
Safe code restructuring:
1. **reviewer** target: architecture (heavy) → design review and direction decision
2. **executor** (standard) → refactoring implementation
3. **verifier** (standard) → verify that behavior has not changed
4. **reviewer** target: code (heavy) → final review

### security
Security-focused review:
1. **reviewer** target: security (heavy) → OWASP Top 10 + agentic threat check
2. **reviewer** target: code (heavy) → general quality review (run in parallel)
3. **verifier** (standard) → verification of the findings

### research
Pre-implementation investigation:
1. **explorer** (light) → codebase investigation (parallelizable)
2. **reviewer** target: architecture (heavy) → analysis of findings and direction proposal

> When external documentation / API research is needed, the conductor supplements with the built-in WebSearch / WebFetch (or the general-purpose agent) — product-shaped work also covers domain/competitor baseline research this way (SOT: plan skill Phase 1 Domain research). There are no dedicated workflow types for UI design, performance optimization, or documentation maintenance (when needed, the conductor dispatches executor etc. directly).

## Multi-Model Council (fan-out)
When a task names ≥2 external models (a "council"/合議 request), use this structured template instead of free-form discussion (keeps the council convergent, not an endless back-and-forth):
1. **Extract the model list** from the request.
2. **Resolve each name via the relay convention** (`.claude/skills/relay/SKILL.md`) — alias lookup in `clover/models.json`, ON/OFF gate check (CLAUDE.md §1.8). A name not in the table → ask the user, don't guess.
3. **Spawn one single-marker worker per model, in parallel** (`RELAY-MODEL:<alias>` as the prompt's first line each — relay is one order = one model, it never splits).
4. **Fuse**: pass all outputs to `reviewer target:fusion` (quality-loop Fusion Composition).
5. **Revisit at most 1 round** on split/contradiction, then compose — never loop indefinitely (quality-loop caps).

See `.claude/skills/relay/SKILL.md` for the marker syntax and alias dictionary; see quality-loop's Fusion Composition for the fuse/revisit/compose mechanics.

## Conductor Role
- The conductor (main session) performs **only delegation, coordination, and judgment**
- Writing code, implementation, and debugging are **always done via subagents**
- The conductor is **forbidden** from operating on code directly with Edit / Write; Read is
  permitted for the conductor's own CLAUDE.md §1.6 critical-reception duty (verifying a
  critique's cited claim against the actual file) and for confirming a subordinate's claim
  before restating it — investigation/exploration still routes to subagents (CLAUDE.md §2)
- **Confirm before restating**: before putting a subordinate's achievement word (visible /
  記録済み / 対応済み / 両席一致) into your own text, a record, a commit body, or another dispatch,
  check the primary source — the file for a code claim, the file's contents for a record claim,
  **each seat's own text** for a multi-seat agreement claim. A point one seat didn't mention is
  not agreement.
- **Verified facts expire**: before asserting a fact you verified earlier, check whether you have
  since issued an instruction that changes the same object. Never write "change X" and "X is
  unchanged" in one dispatch — state the property you actually want, not a proxy for it; a proxy
  becomes a lie the moment it diverges from the property.
- **No new work while a ruling is outstanding**: while a ruling or question is outstanding with
  the user, start no work unit, including ones you judge unaffected — the ruling can reorder the plan.
- Conductor responsibilities: task breakdown, launching subagents, aggregating results, reporting to the user

## Handoff Protocol
Each handoff between agents must include:
- **Context**: what is being done
- **Findings**: what was discovered
- **Changed files**: list of files changed
- **Open items**: remaining questions
- **Notes to the next agent**: recommended next action
- **Scope handoff**: when a PLAN.md / scope.json exists for this work, the dispatch prompt passes their *paths* — the worker must read PLAN.md/scope.json itself; never paraphrase scope into a dispatch prompt (paraphrase loss is how unapproved implementation creeps in)

## Parallel Execution
Steps with no dependencies run in parallel:
- feature: after planner completes, launch multiple executors in parallel for independent tasks
- research: explorer (codebase) and the built-in web search (external) can proceed in parallel
- bugfix: when the root cause is unclear, fan out N debuggers in parallel (one per hypothesis, cap 3); pick the survivor by discriminating probe before fixing
- aggregate the results of parallel agents before moving to the next step

## Quality Gate
- Verify evidence at the completion of each step
- Review steps (reviewer / planner self-review) follow the **quality-loop skill's Loop Contract**:
  the authority allowlist is native `fable | opus` (CLAUDE.md §2 ¹; quality-loop is the operational SOT):
  Opus by default, or Fable only while the CLAUDE.md §1.11 gate is ON; lower tiers,
  unknown/external authority ids, mixed standing pairs, and silent fallback are forbidden; send-back →
  fix → re-review runs for up to 3 cycles
- plan/design/architecture authority reviews (planner self-review, and `reviewer target:architecture` —
  e.g. in the refactor/research paths) and normal code review (`reviewer target:code`) additionally
  follow quality-loop's Authority Co-Review: a same-tier red-team second seat always attends cycle 1,
  and when the trigger condition is met an external co-reviewer joins as a third seat; if unmet, the
  red-team second seat still attends — only the external third seat is skipped
- **bugfix** runs its fix→verify as the same Loop Contract: debugger/executor worker, verifier as the evidence gate, max 3 cycles, **internal** (no user between cycles); the regression-test step (4) additionally covers any observation point the fix touches (M1/M2, executor.md Detection power)
- Not APPROVE within 3 cycles → escalate to the user
