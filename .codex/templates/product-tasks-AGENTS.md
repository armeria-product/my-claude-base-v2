# <product-name> task-record guidance

These are product-local records for an independent product repository. Keep
product state here; do not write product-specific state into a parent
repository's task directory.

## Record contracts

- Session-state records are exactly a two-line continuation pointer.
- Keep TODOs in actionable sections. Retain at most ten recently completed
  entries in the active record; archive older entries verbatim.
- Add lessons chronologically with the date, context, evidence, and resulting
  guidance.
- Keep roadmap status markers explicit, and cite codemap locations as
  `path:line#anchor`.
- Do not bulk-rewrite or delete historical task evidence.

## Session continuity

Reconcile the product Git status, these records, and current task history
before claiming progress. Do not invent completion evidence. The global
hub-level journal, when needed for cross-cutting work, remains at
`tasks/journal/YYYY-MM/DD.md` in the hub repository; do not create a product
journal as a substitute.
