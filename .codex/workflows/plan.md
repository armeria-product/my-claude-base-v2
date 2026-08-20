# Native planning workflow

Use one adaptive planning entry point. Always classify the request before selecting depth.

## Complexity gate

Evaluate these signals top-down:

| Signal | Light | Heavy |
|---|---|---|
| Affected files | 1-2 local files | 3+ files or cross-module |
| Nature | Local fix or small feature | New feature or architecture decision |
| Risk | Low | Auth, payments, data migration, or external-facing behavior |
| Clarity | Settled without research | Research is required to decide |

- Any heavy signal selects the heavy path.
- All-light signals select the light path.
- Split or genuinely borderline evidence gets exactly one question: `A: quick requirements organization / B: research and a reviewed implementation plan`.
- Declare the selected path and concrete reason before continuing.

The light path scores ambiguity across goal, constraints, success criteria, and context. Ask one
specific question about the least-clear dimension per round, offer concrete options, and stop after
five rounds or once ambiguity is 20% or lower. Return goal, in/out scope, verifiable success
criteria, constraints, assumptions, objections/rulings, and the next step. Do not implement before
that requirements summary exists.

The heavy path applies to three or more ordered steps, an architecture decision, meaningful risk,
or a requirement that cannot be settled without research:

1. Let planner and explorer investigate independently when both have useful scopes.
2. The planner writes research, a plan, and a reviewable scope manifest for heavy work. It records assumptions, rejected alternatives, observation points, risks, verification, and objections.
3. A freshly dispatched planner critiques the plan; the plan author never approves it.
4. Present the reviewed plan and readable allow/forbid surface to the user for ordinary approval. The scope manifest is not a lock.
5. Dispatch implementation by plan phase. Each worker receives paths to the plan and scope records and reads them itself.

Light work may return the requirements summary inline; when records are useful, use an explicit
checklist in todo.md. Heavy work writes research, PLAN.md, scope.json, and deviations.md as needed.
Ordered work uses roadmap.md. New ideas go to deviations.md until approved.
