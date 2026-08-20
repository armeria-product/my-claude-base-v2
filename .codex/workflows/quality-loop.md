# Native quality loop

Apply this workflow to every non-trivial deliverable. Classify the work before review.

## Standard non-trivial work

1. A writer produces the change or plan.
2. One fresh independent reviewer checks the agreed scope, behavior, evidence, and test power.
3. Fix every critical or high finding, then obtain the needed re-review. Cap the loop at three cycles and surface a blocker rather than repeating a stalled approach.
4. A fresh verifier supplies the final evidence gate.

## High-risk work

A change is high risk when it affects permissions, secrets, destructive operations, external input,
authentication, databases, payments, or hook policy.

1. A writer produces the change or plan.
2. Dispatch two fresh independent reviewer contexts in parallel:
   - a spec-conformance lens;
   - a red-team lens that attempts to falsify safety, scope, and test-power claims.
3. For authentication, permissions, secrets, external inputs, destructive operations, or hook policy,
   seat a separate security reviewer. This seat is mandatory when that concern applies; it is not
   conditional on a spare worker slot.
4. A fresh reviewer runs fusion on all independent findings. Retain source labels and disagreements.
5. Fix every critical or high finding, then obtain the needed re-review. Cap the loop at three cycles
   and surface a blocker rather than repeating a stalled approach.
6. A fresh verifier supplies the final evidence gate.

## Independence

No writer approves its own work. The writer, reviewer, fusion reviewer, security reviewer, and verifier
must be independent where their seats are required. Multiple lenses improve independence of attention but
are not a claim of model-diverse review. Record which high-risk lenses were seated and why.
