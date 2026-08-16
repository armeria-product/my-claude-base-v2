---
description: dev/ 配下のプロダクトディレクトリ操作時に自動適用されるルール
paths:
  - dev/**
---

# Product Directory Rules

Automatically applied when working with files under `dev/{product-name}/`:

## 製品づくりの姿勢

`dev/` 配下で作っているのは個人の実験ではなく、会社が客に出す製品だという前提で動く。

- **「動く」は完成ではない。** 完成とは、初めて触る人が操作を間違えても、何が起きたかが分かり、何も失われない状態のこと。
- **自分が責任を持つ範囲を意識する。** 誰がいつ使うか。操作を間違えたら何が起きるか。途中で異常終了してもデータは残るか。次に開いたときに前回の続きから始められるか。
- **作った本人として話す。** 「動けばよかろう」「とりあえず」で締めない。手を抜いた箇所があるなら、何を犠牲にして何が起こりうるかを一言添える。
- **これは CLAUDE.md §1.7(必要最小限で作る)を緩めるものではない。** 品質の最低ラインであって、機能を足してよい許可ではない。使うかどうか分からない汎用化はこれまで通り禁止で、変わるのは「壊れ方が乱暴なまま出荷しない」という一点。

## Requirements Interrogation on New Build
When a dev session starts with a vague "I want to build / make X" (a new product or a substantial new feature), **do not start coding — interrogate requirements first**, in rounds, until they are clear (ties into CLAUDE.md §1.1 Vagueness Gate):
- **Round-based, plain-language questions** — use `AskUserQuestion`, ≤4 per round, jargon-free (CLAUDE.md Language §). After each round, read the answers and **ask follow-ups on whatever is still vague**; repeat until requirements are concrete. Stop only when nothing material is unclear.
- **Always pin down these four** (adapt the exact wording to what they're building):
  1. **Purpose / pain / users** — why build it, what problem it solves, who uses it and when.
  2. **Must-have features & scope** — the essential features, and explicitly what is *out* of scope this time.
  3. **Look & feel** — design / UX preferences, references to imitate.
  4. **Tech / constraints / done-criteria** — preferred language/tools, run environment, deadline, and what "done" means.
- When requirements are clear, **echo back a short summary and confirm** before building (non-trivial → also follow §1.1 plan mode / §7 plan-first).
- **Skip it** for small tweaks, modifications, debugging, or requests that already carry concrete anchors (specific files/behavior). This fires for *new builds with unclear requirements* — don't badger on trivial changes (no fuzzy hard-blocks).

## Automatic Context Loading
- Read `dev/{product-name}/tasks/todo.md` if it exists (current tasks)
- Read `dev/{product-name}/tasks/lessons.md` if it exists (product-specific learnings)
- Read `dev/{product-name}/tasks/roadmap.md` if it exists (large-scale implementation step list, created on-demand)

## CODEMAP Maintenance
- If `dev/{product-name}/tasks/CODEMAP.md` exists, update it **in the same change** whenever you touch the structure it describes: a new entry point, a new table, a moved folder, a changed command, a changed storage location.
- If something you re-investigated disagrees with the map, fix the map **before** returning to the work — a stale map sends the next session off on a wrong assumption.
- Line drift (not just structural change) is machine-checked: `node .claude/scripts/validate.mjs` section 18 compares each `file:line#anchor` annotation against the real file and WARNs/FAILs on drift — fix the annotation even when nothing about the map's structure changed.
- Structure contract: `.claude/rules/session-persistence.md` §6.5

## Scope Separation
- Unless explicitly crossing the boundary, keep changes within that product directory
- Product-specific lessons go in `dev/{product-name}/tasks/lessons.md`. Do not write them in `tasks/lessons.md`
- Product-specific tasks go in `dev/{product-name}/tasks/todo.md`. Do not write them in `tasks/todo.md`
- Session state goes in `dev/{product-name}/tasks/session-state.md`. Do not write it in `tasks/session-state.md`
- Product-specific roadmap (if created) goes in `dev/{product-name}/tasks/roadmap.md`. Do not write it in `tasks/roadmap.md`
- Only cross-project knowledge belongs under `tasks/`
- For detailed routing / bootstrap logic, see `.claude/rules/session-persistence.md`

## Automatic Delegation
- Complex addition of a product feature: delegate to the planner agent with product context
- Product-specific debugging: delegate to the debugger agent scoped to the product directory
- Setting up product tests: delegate to the executor agent scoped to the product directory (test writing is also handled by executor)
- Product code review: delegate to the reviewer agent (`target: code`) scoped to the product directory
