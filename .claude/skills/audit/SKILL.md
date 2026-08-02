---
name: audit
description: >
  複数の専門エージェントを独立したコンテキストで走らせる多角的コード監査。
  planner で計画作成 → planner 自己レビュー（最大2サイクル）→ executor でフェーズ実装 →
  reviewer 2並列（コード品質 / セキュリティ）→ fusion judge がレビュー所見を JSON 統合（赤席常設で最小3入力・外部同席時は4入力、Phase 4b）→ verifier がフェーズ毎に証拠付き PASS/FAIL 判定。
  互いの結論を見せないことで盲点と確証バイアスを抑える。
  決済・認証・データ移行などの高リスク変更、複数システムにまたがる設計変更、
  単一レビューでは見落としが出やすい複雑な変更、確実性をもう一段上げたい時に使う。
  /harness feature より厳格（セキュリティレビュー常時並列・自己レビュー2サイクル・証拠添付必須）。
  「監査して」「audit して」「厳しくレビューして」でも発動。
user-invocable: true
---

# Multi-Agent Independent Audit Workflow

Run multiple specialized agents with distinct roles (planner self-review / executor / reviewer (code, security) / reviewer (fusion) / verifier) in independent contexts to scrutinize the plan and implementation from multiple angles. Because the agents do not see each other's conclusions, this is expected to fill in blind spots and curb confirmation bias.

> The dispatch of the review agents (planner self-review / reviewer) follows the **frontier authority convention** (CLAUDE.md §2 ¹); the floor is opus.
> When a review stage instead needs an external backend (a named outside model), resolve it via `.claude/skills/relay/SKILL.md` (gated by CLAUDE.md §1.8 ON/OFF).
> Plan/design/architecture reviews and normal code review (`reviewer target:code`) always seat quality-loop's standing red-team second seat (Authority Co-Review); when its trigger condition is met, an external co-reviewer additionally joins as a third seat (SOT: quality-loop). Security review (`reviewer target:security`) stays excluded.

## Workflow

### Phase 1: Plan Creation (planner / heavy)
1. Use the planner agent to create a phased implementation plan
2. Write the plan (the design body) to `PLAN.md` under the output location determined below (do not inline the design body into todo.md — session-persistence §6.1). Put only checklist items in todo.md

**Determining the output location** (same convention as the plan skill):
- Product context present → `dev/{name}/plans/{feature}/PLAN.md`
- Absent → `plans/{feature}/PLAN.md`
3. For each phase, specify the following:
   - Entry condition (the state that must hold before starting)
   - Exit condition (the state that must hold to proceed to the next phase)
   - Test gate (how to verify completion of this phase)

### Phase 2: Plan Review (planner self-review / heavy)
Launch the planner agent in an independent context in Self-Review Mode and rigorously scrutinize the soundness of the plan. Per quality-loop's Authority Co-Review, a same-tier red-team second seat always attends this review; when the trigger condition is met, an external co-reviewer additionally runs in parallel as a third seat and its output is fused into the review (SOT: `.claude/skills/quality-loop/SKILL.md`); when the condition is unmet, the red-team second seat still attends — only the external seat is skipped.

Review perspectives:
1. What is missing in the intermediate steps?
2. What dependencies have not been considered?
3. Are the test gates sufficient?
4. What failure scenarios are not covered?
5. Is the scope too large or too small?

Reflect the planner self-review findings into the plan (up to 2 revision cycles). On reaching the third, **stop and replan**.

### Phase 2.5: User Approval Gate (proposal ends here — v2)
`/audit` is proposal-first: Phases 1-2 produce the plan; **implementation never starts on the skill's own momentum**. Write `plans/{slug}/scope.json` (`status:"proposed"` — contract SOT: plan skill Phase 2) and close with the standard handoff: 「scope.json を書き出しました。『承認』と返信するとロックして自走を開始します（解除は『解除』）」. Phase 3 starts only after the approve-lock hook confirms the lock. If the user only wanted the audit's findings/plan, stop here — that is a complete, successful outcome.

### Phase 3: Implementation (executor / standard)
1. Implement phase by phase with the executor agent
2. Each phase must pass its test gate before moving on
3. If a test gate fails, debug before proceeding
4. Track progress in todo.md (contract todo form = single-line items under `## Now`/`## Backlog`; compliant with session-persistence §6.1)

### Phase 4: Implementation Review (reviewer / heavy, minimum 3 parallel instances)
Launch the reviewer agent in **parallel** as 2 instances, each independently scrutinizing the diff — the code leg additionally carries its standing red-team second seat (quality-loop's Authority Co-Review), so the phase runs a minimum of 3 instances (code frontier + code red-team + security):

- **reviewer (target: code)**: code quality, correctness, maintainability, edge cases
- **reviewer (target: security)**: OWASP Top 10, secret leakage, authentication/authorization, agentic threats

### Phase 4b: Fusion Judge (reviewer target: fusion)
Instead of integrating the reviews by hand, dispatch **an additional reviewer instance in Fusion Judge Mode**. The code leg's standing red-team second seat (quality-loop's Authority Co-Review) means at minimum 3 finding-sets go in (A = code frontier, B = code red-team, C = security); do **not** run a nested code-only fusion. When the code leg's external third seat also attends (Authority Co-Review trigger condition met), pass all 4 instead (A = code frontier, B = code red-team, C = code external, D = security) — still one non-nested fusion call. It runs at the reviewer's pinned max effort (no manual `/effort` needed) and emits **JSON only** (`consensus / contradictions / unique / partial_coverage / blind_spots / recommendation`) — it analyzes, it does not merge or fix. The conductor then acts on that JSON: fix all CRITICAL/HIGH, investigate every `blind_spot`, resolve each `contradiction` explicitly. MEDIUM/LOW remain a judgment call. This removes manual mental integration of long reports and surfaces gaps neither review named alone. (Cost note: this is **an additional reviewer pass at the reviewer's own tier (`opus`), with no model override**, on top of Phase 4's reviewers — deliberate for `/audit`'s high-risk scope.) Then proceed to Phase 5.

### Phase 5: Verification (verifier / standard)
Use the verifier agent to verify, on an evidence basis, whether the implementation meets the requirements:

1. Is it implemented as planned? (cross-check the diff against the PLAN)
2. Are there deviations from the plan? If so, are they justified?
3. What untested edge cases are there?
4. Are there regressions in the existing tests?

Output: PASS / FAIL per phase with concrete evidence (test logs, diffs, grep results).

## When to Use
- High-risk features (payments, authentication, data migration)
- Architecture changes that affect multiple systems
- Complex changes where a single-agent review is likely to leave blind spots
- When the user wants additional certainty

## Difference from `/harness feature` directly
`/harness feature` also runs planner→planner self-review→executor→reviewer→verifier, but `/audit` is stricter on the following points:
- Explicitly allows up to 2 revision cycles for planner self-review (`/harness` defers to the quality-loop Loop Contract, max 3)
- **Always** includes reviewer (target: security) in the implementation review, **in parallel**
- Adds a **Fusion Judge** (Phase 4b): a third reviewer fuses the review findings into structured JSON before the conductor acts
- Makes per-phase evidence attachment mandatory in the verifier output

Use `/harness feature` for lightweight feature additions, and `/audit` for high-risk changes.

## Output
After the workflow completes, report the following:
```
## Multi-Agent Independent Audit Result
- Plan: [file path]
- planner self-review findings: [count] / revision cycles: [count]
- Implementation: [completed phases / total phases]
- reviewer (target: code): [CRITICAL/HIGH/MEDIUM/LOW counts]
- co-review: external + red-team (fused, N=3) | red-team only (fused, N=2) | none (reason)
- reviewer (target: security): [CRITICAL/HIGH/MEDIUM/LOW counts]
- verifier: [PASS/FAIL per phase]
- Confidence: high / medium / low
```
