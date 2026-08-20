# Native quality loop

Apply this workflow to non-trivial deliverables.

1. A writer produces the change or plan.
2. On the first authority review, dispatch two fresh independent reviewer contexts in parallel:
   - spec-conformance lens;
   - red-team lens that attempts to falsify safety, scope, and test-power claims.
3. For authentication, permissions, secrets, external inputs, databases, payments, or dangerous operations, add a third target: security reviewer if a worker slot is available.
4. A fresh reviewer runs target: fusion once on all independent findings. Retain source labels and disagreements.
5. Fix every critical or high finding, then re-review. Cap the loop at three cycles and surface a blocker rather than repeating a stalled approach.
6. A fresh verifier supplies the final evidence gate.

No writer approves its own work. The two review contexts improve independence of attention but are not a claim of model-diverse review. Record whether the security track was seated and why.
