# Native execution workflow

Choose roles by work shape and reserve the coordinator slot. Use every other available slot only for independent, non-empty work.

| Work | Flow |
|---|---|
| Feature | planner -> independent executor tasks -> reviewer -> verifier |
| Bug | debugger reproduction/probes -> debugger or executor fix -> verifier -> reviewer |
| Refactor | reviewer architecture -> executor -> verifier -> reviewer |
| Research | explorer plus any external research -> reviewer architecture |
| Document | document-author -> verifier or targeted reviewer |

Pass role-card and plan/scope paths to each worker. Do not paraphrase scope in place of the records. Aggregate parallel results before the next dependent phase.

For bugs, reproduce before asking the user; test discriminating hypotheses in parallel when useful. Change approach after repeated failure and stop after the third unsuccessful cycle.
