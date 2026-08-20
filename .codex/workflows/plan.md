# Native planning workflow

Use the planner role for work with three or more ordered steps, an architecture decision, unclear requirements, or meaningful risk.

1. Let planner and explorer investigate independently when both have useful scopes.
2. The planner writes research, a plan, and a reviewable scope manifest for heavy work. It records assumptions, rejected alternatives, observation points, risks, verification, and objections.
3. A freshly dispatched planner critiques the plan; the plan author never approves it.
4. Present the reviewed plan and readable allow/forbid surface to the user for ordinary approval. The scope manifest is not a lock.
5. Dispatch implementation by plan phase. Each worker receives paths to the plan and scope records and reads them itself.

Light work uses an explicit checklist in todo.md; ordered work uses roadmap.md. New ideas go to deviations.md until approved.
