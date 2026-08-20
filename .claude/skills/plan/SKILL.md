---
name: plan
description: >
  実装の前にタスクの複雑度をまず判定し、規模に応じて深さを自動調整する単一の計画スキル。
  小さく明確な作業は軽量パス（曖昧度スコアリング + 構造化インタビュー → 要件仕様）、
  大きく複雑・高リスクな作業は重量パス（リサーチ → GO/NO-GO ゲート → 計画 → サブエージェントと
  フェーズ毎ゲートで実装）に分岐する。要件が曖昧で詰める必要がある時、または実装前に
  計画を立てるべき時に使う。「計画して」「プランして」「要件を整理して」「/plan」でも発動。
user-invocable: true
---

# Plan — Adaptive Planning

A single planning entry point that first assesses task complexity and automatically adjusts depth based on scale.
It unifies the former `plan-lite` (lightweight requirements organization) and `plan-full` (Research→Plan→Implement).

## Usage
```
/plan [task or feature description]
```

## Step 0 — Complexity Gate (always evaluate first)

Determine **light / heavy** using the signals below. The determination is automatic. When it's a borderline case, confirm with the user with **just one question**.

| Signal | Leans light | Leans heavy |
|---|---|---|
| Number of affected files | 1–2 | 3+ or cross-module |
| Nature | Local fix / small feature | New feature / architecture decision |
| Risk | Low | Auth / payments / data migration / external-facing |
| Clarity of requirements | Settled | Can't be decided without research |

Rules (evaluate top-down, adopt the first match):
1. Even one heavy signal applies → **heavy path**
2. All signals are light → **light path**
3. The determination is split → confirm with the user in one question: "A: quick requirements organization only / B: research, then plan through implementation"

Declare before proceeding (e.g. "Proceeding with the heavy path. Reason: 3 affected files + auth change").

---

## Light Path — Requirements Clarification (equivalent to the former plan-lite)

Convert a vague request into an implementable spec. Don't implement (until the spec is produced).

### Ambiguity Scoring
Assess clarity from 0–100% across 4 dimensions:

| Dimension | Weight | Question |
|------|------|------|
| Goal | 40% | Is what you want to achieve clear? |
| Constraints | 20% | Are the technical / time / scope constraints clear? |
| Success Criteria | 25% | Is it clear how "done" is judged? |
| Context | 15% | Are the existing system / users / background clear? |

For an existing project, raise the Context weight to 25%.

### Interview Rules
1. **One question per round** — ask about the lowest-scoring dimension
2. **Ask specifically** — not "Is there anything else?" but "What should the UI do on error?"
3. **Present options** — "Option A: ~, Option B: ~, which is closer?"
4. **Maximum 5 rounds** — more than that is excessive. Proceed with what you know

### Challenge Modes (from round 3 onward)
- **Round 3 - Contrarian**: "Is that really necessary? Is there a simpler way?"
- **Round 4 - Simplifier**: "If you trimmed to the bare minimum as an MVP, what would you keep?"
- **Round 5 - Edge Case**: "What happens in the case of ~?"
- **Any round — Objection duty**: if a stated premise is factually wrong or the chosen approach is a known bad path, object immediately with evidence (fact / measurement / comparison) and a concrete alternative — don't wait for a challenge round (CLAUDE.md §1.10).

### Exit Criteria
At an overall ambiguity score of **20% or below**, or upon reaching **5 rounds**, summarize within what is known.

### Light Path Output
```markdown
## Requirements Summary

### Goal
[clear goal in 1-2 sentences]

### Scope
- IN: [what's included]
- OUT: [what's not included]

### Success Criteria
- [ ] [verifiable criterion 1]
- [ ] [verifiable criterion 2]

### Constraints
- [technical constraint / time constraint]

### Assumptions (premises that couldn't be confirmed)
- [assumption 1]

### Objections & Rulings (only if objections were raised)
- [objection + evidence] → ruling: adopted / withdrawn / overruled (user's call — recorded, then followed)

### Next Step
→ If you can proceed straight to implementation, use `/harness [type]`; if it turns out to be large in scale,
  escalate from here directly to the **heavy path** (below)
```

Save location: if there's a product context (you're working on `dev/{name}/**`) → `dev/{name}/requirements-{slug}.md`.
If continuing on into the heavy path → `plans/{slug}/requirements.md`. If neither, return inline only.
For routing details, follow Product Context Detection in [.claude/rules/session-persistence.md](../../rules/session-persistence.md).

---

## Heavy Path — Research → Plan → Implement (equivalent to the former plan-full)

A structured flow with a GO/NO-GO gate between each phase. Each phase's deliverable becomes the next one's input.

**Prerequisite**: If requirements are vague, first run the Light Path above to produce `requirements.md`, and use that as the input to Phase 1.

### Determining the output location
- Product context present → `dev/{name}/plans/{slug}/`
- Absent → `plans/{slug}/`

### Phase 1 — Research
Launch research agents in parallel:

1. **Requirements analysis** (planner) — *skip if a Light Path requirements file exists*: break the feature down into concrete requirements, surface assumptions and ambiguities, enumerate acceptance criteria
2. **Codebase impact survey** (explorer): affected files / modules, existing patterns, related tests
3. **External research** (when needed): the conductor uses the built-in WebSearch/WebFetch (or general-purpose) to investigate API/library specs, known issues, and best practices
4. **Domain research** (conductor, product-shaped only): when the work is product-shaped (a new product, or a large user-facing feature end users would compare against existing products — internal refactor / infra / harness work does not qualify), research 3-5 comparable products' table-stakes features, common failure modes, and review complaints via WebSearch/WebFetch. If the product has a UI, view 2-3 representative screens via `curl` → `tmp/` → Read (fail-open). Keep it to a handful of searches — a baseline scan, not a market report. A full market-research report is only for explicit user request, via the deep-research flow (if available in the session). If the product-shaped call is borderline, confirm with one question. Record the product-shaped determination itself in research.md as yes/no plus a one-line reason (same declaration form as Step 0's complexity-gate declaration), even when the answer is no and no domain research follows.

Output `{base}/research.md`:
```markdown
## Research: {feature}
### Requirements
- [R1] ...
### Assumptions
- [A1] ... (to confirm: yes/no)
### Codebase Impact
- affected files / existing patterns / test coverage
### External Findings
- [finding]
### Domain Baseline (product-shaped only)
- [product]: [table-stakes features] / [notable complaints] — source: [source]
### Gap Proposals (awaiting user ruling — per §1.7, never added to scope without one)
- [G1] [missing table-stakes item] — evidence: [source / comparison]
### Objections (evidence-backed)
- [O1] [what we disagree with] — evidence: [...] — alternative: [...]
### Risks
- [Risk]: likelihood (H/M/L), impact (H/M/L)
```

### GO/NO-GO Gate
| Judgment item | State |
|---------|------|
| Are the requirements clear? | YES / NO |
| Are all assumptions verified? | YES / NO |
| Is the impact on the codebase understood? | YES / NO |
| Are there no risks blocking progress? | YES / NO |
| Is the estimated complexity within acceptable bounds? | YES / NO |
| Have Gap Proposals / Objections been presented to the user and ruled on? | YES / NO / N/A (not product-shaped) / N/A (researched — none arose) |

Gap Proposals and objections are presented in a single batched `AskUserQuestion` (plain language), with the ruling on each item recorded. Every batched `AskUserQuestion` states one line naming the premise all its options share — an option that only varies a detail inside an unstated premise cannot be challenged. The challenge happens at this gate — not during implementation. Even an overruled objection gets recorded before being followed. Each ruling is appended to research.md's corresponding item (the specific Gap Proposals / Objections line) at the moment of the gate, so the record survives a NO-GO or an abort; after GO it is additionally transcribed into PLAN.md's ledger of adopted / rejected / overruled items.

**Decision**: GO (to Phase 2) / NO-GO (report blockers and stop) / NEEDS-CLARIFICATION (enumerate questions and await answers)

### Phase 2 — Plan
0. **Propose layer (optional, default OFF — only when the solution space is genuinely wide / an architecture-defining decision the planner can't settle in-context)**: dispatch 2–3 **executor** agents in parallel, each sketching an approach under a different framing (simplicity-first / extensibility-first / speed-first), then have the planner **synthesize** them (Mixture-of-Agents aggregator — combine, don't just pick; note conflicts). For most plans the planner already explores alternatives in-context (DISPATCH-EVALUATE-REFINE + Rejected Alternatives) — **skip this** then (Simplicity First §1.7).
1. **Plan formulation** (planner): design the approach, break tasks down by phase with dependencies, define a test gate per phase
2. **Plan review** (planner self-review mode): independent review, check for missing steps / risks / over-engineering, decision APPROVE / REVISE / REJECT. Per quality-loop's Authority Co-Review, a same-tier red-team second seat always attends this review; when the trigger condition is met, an external co-reviewer additionally attends as a third seat (SOT: `.claude/skills/quality-loop/SKILL.md`); when unmet, the red-team second seat still attends — only the external seat is skipped. Self-review by the same planner role is permitted only as a freshly spawned instance (the authoring instance never reviews its own plan), with the second seat attending per quality-loop's Authority Co-Review attendance rule (cycle 1; later cycles are the authority alone) — recorded as a 2026-08-13 user ruling.
3. REVISE → fix based on the self-review feedback (max 2 times)

Output `{base}/PLAN.md`:
```markdown
## Plan: {feature}
### Approach
[adopted approach]
### Assumptions (premises that couldn't be confirmed)
- [assumption 1]
### Rejected Alternatives
- [alternative]: [reason for rejection]
### Observation Points
- [point]: the behavior the plan requires, and the check that must go RED if it breaks (or a single line `- none — <reason>` when the plan genuinely has none)
### Phases
#### Phase 1: [name]
- tasks / test gate / dependencies
### Objections & Rulings
- [G1/O1]: adopted / rejected / overruled — [one-line reason]
### Verification Strategy
[how to prove the behavior of the feature as a whole]
```

The `### Verification Strategy` section must record a **baseline**: run every gate this work's
acceptance will use at branch creation, before any change — a green `verify` says nothing about
`e2e`, and without a baseline nobody can later decide whether a failure is new. When a later ruling
overturns a decision already written in PLAN.md's body, correct the **body paragraph** in the same
turn, not only the `### Objections & Rulings` ledger — demote the superseded text to a quote block
marked 撤回済み (don't delete it) and follow it with the current position and a pointer to the
record of record; deleting it loses why the option was rejected and the argument returns.

`### Observation Points` lists, one line per point, an externally-checkable behavior the plan
requires — required for any plan approved on or after 2026-08-15 (the `mutation-observation-points`
plan itself, Phase 1); a plan with genuinely none writes `- none — <reason>` rather than omitting
the section — but this is not a terminal claim: the same derive-anyway rule below applies to it too
(executor.md's derive-anyway clause is the single authority; `- none` is a starting claim, not a
free pass). When a plan predates this requirement and carries no such section, derive the roster at implementation time
from what the plan's own text requires and record it in the report — the
section's absence never waives the requirement (CR-B), and neither does a `- none` line. This also
covers a `dev/**` plan written before this date and never revised: it still has a plan, so the
derive-from-text rule above applies to it directly — it is **not** routed to executor.md's "no-plan casual work" rule
(that rule governs work with no plan at all, a narrower case). When
`### Observation Points` and `### Verification Strategy` disagree about what must be checked,
`### Observation Points` takes precedence — it is the roster of required behaviors, Verification
Strategy is how to prove them.

Additionally output `{base}/scope.json` — a machine-readable review aid for the intended touch surface (**required on the heavy path, but never used as a write lock**):

```json
{
  "slug": "{slug}",
  "status": "ready",
  "updatedAt": "<ISO 8601 now>",
  "plan": "{base}/PLAN.md",
  "allow": ["dev/app/src/feature-x/**", "dev/app/tests/feature-x/**"],
  "forbid": ["dev/app/src/payment/**"],
  "tasks": ["<1 line per planned task, in order>"],
  "securityReview": false
}
```

Set `"securityReview": true` when the planned work touches auth/permissions, payments, API endpoints / external input surfaces, DB/query/migration, secrets, or dangerous operations (shell/eval/external sends). Every code review governed by that plan auto-seats the security track (SOT: quality-loop Security Track). When in doubt, set it true.

Glob subset: `**` (any depth) / `*` (one segment) / exact path; a trailing `/` means the whole directory. Prefer folder-level allow globs so legitimate helpers and tests are visible in the proposed scope. Records (tasks/ — journal・history 含む — tmp/ and `{base}/` itself) need not be listed. Never propose `**`-class breadth because it provides no useful review boundary. A plan that changes the harness itself must name settings/hooks/validator/provider adapters explicitly and cite the user's authorization.

### User Handoff

After self-review APPROVE, present to the user in plain Japanese: the approach in 2-3 lines, the allow/forbid ranges in readable form, and the task list. Ask for ordinary explicit approval to start; there is no magic approval word or persistent scope state.

Phase 3 starts after the user clearly accepts the plan, or immediately when the user's original request already gives sufficiently specific authorization for the planned scope. If the user requests changes, revise PLAN.md and scope.json before implementation.

### Phase 3 — Implement
For implementation, **use the harness skill's pipeline as the execution engine** (the SOT for the pipeline definition is harness; plan focuses on "deciding" and does not restate the pipeline here). Choose the appropriate type per phase:
1. Feature implementation → `harness feature` / bug fix → `harness bugfix` / refactor → `harness refactor`. Since planner self-review is done in Phase 2, each phase uses **the executor onward** of the harness pipeline (implementation through verification) as the execution engine. Every dispatch prompt passes the **paths** of `{base}/PLAN.md` and `{base}/scope.json` — the worker reads them itself; never paraphrase the scope into the prompt (CLAUDE.md §2 Scope handoff — paraphrase is how unapproved implementation creeps in)
2. Each phase requires passing the test gate — which includes, for every observation point that phase implements, both the M1 and M2 results (SOT: `executor.md` Detection power). Failure → debug and retry (max 2 times) → if it still fails, stop and report
3. Before starting a phase designated as a deferral destination, inventory it: list what accumulated there and eject anything outside that phase's original one-line definition — a deferral record says only "→ phase X", so the drift stays invisible until the phase is opened
4. After all phases complete: **reviewer** (target: code, full-diff review) → address findings → **verifier** (final E2E verification)

Append to `{base}/PLAN.md`:
```markdown
### Results
- Phase 1: PASS/FAIL — [evidence]
- reviewer (target: code): APPROVE/REQUEST_CHANGES — [summary]
- Final Verification: PASS/FAIL — [evidence]
```

### Cleanup
On success, move `{base}/` to `{base}/../done/{slug}/` (delete it if unneeded).
Appends to `todo.md` / `lessons.md` follow [session-persistence.md §6 File Structure Contract](../../rules/session-persistence.md): to todo, only one-line items under `## Now`/`## Backlog`/`Recently Done` (**inline design body forbidden**); to lessons, **append at the tail** (ascending order) in the §4 format. The design body lives in `{base}/PLAN.md`, but since cleanup moves this dir to `done/{slug}/`, when linking from todo to the design, **point to the post-move `done/{slug}/`** (don't point directly at the volatile `plans/{slug}/`).

> `PLAN.md` / `research.md` / light-path `requirements-{slug}.md` are **plans/ deliverables, not the tasks 4 files** (outside the §6 contract; don't change this skill's templates).

---

## Model / Agents
Each agent's tier has its frontmatter alias as the SOT (CLAUDE.md §2 Model Tier Policy).
This skill does not specify model names directly.

## When to use
- **light**: solidifying requirements for vague small requests, turning into a spec before implementation
- **heavy**: new features spanning 3+ files, architecture decisions, high-risk changes, avoiding "writing before thinking"
