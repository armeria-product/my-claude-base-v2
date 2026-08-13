---
description: session-state / lessons / todo / roadmap / CODEMAP ファイルの配置先判定と bootstrap ルール（dev/ と tasks/ の振り分け）＋ 5ファイルの構造契約
paths:
  - tasks/session-state.md
  - tasks/lessons.md
  - tasks/todo.md
  - tasks/roadmap.md
  - tasks/CODEMAP.md
  - dev/*/tasks/session-state.md
  - dev/*/tasks/lessons.md
  - dev/*/tasks/todo.md
  - dev/*/tasks/roadmap.md
  - dev/*/tasks/CODEMAP.md
---

# Session Persistence Routing Rule

Centralizes location detection and bootstrap for `session-state.md` / `lessons.md` / `todo.md` / `roadmap.md` / `CODEMAP.md`.
This rule fires on any write attempt to the 10 paths above.

> **The journal is outside this rule's routing**: the work journal (`tasks/journal/YYYY-MM/DD.md`)
> lives under the workspace root's `tasks/` ONLY — it is ONE global timeline, written by hooks
> (journal.js / session-journal.js) and appended to by /save-session, **append-only, never
> rotated, and never routed to `dev/{name}/tasks/`** even in dev mode (the dev-mode tasks
> routing below applies to the 5 state files, not to the journal).

## 1. Product Context Detection

Evaluate in the following order and adopt the first match:

1. **User explicitly specifies the save location** → follow that instruction (skip the remaining checks)
2. **The result of `git diff --name-only HEAD`** includes files under `dev/{name}/` → that `{name}` is the product context
3. **Files Read/Edit/Written in the recent conversation** include paths under `dev/{name}/` → that `{name}` is the product context
4. None of the above match → no product context (root context)

When multiple products match: adopt the one with the most hits; on a tie, confirm with the user (do not auto-detect).

## 2. Routing Table

| Situation | session-state | lessons | todo | roadmap | CODEMAP |
|------|--------------|---------|------|---------|---------|
| Product context present | `dev/{name}/tasks/session-state.md` | `dev/{name}/tasks/lessons.md` | `dev/{name}/tasks/todo.md` | `dev/{name}/tasks/roadmap.md` | `dev/{name}/tasks/CODEMAP.md` |
| No product context | `tasks/session-state.md` | `tasks/lessons.md` | `tasks/todo.md` | `tasks/roadmap.md` | `tasks/CODEMAP.md` |

## 3. Bootstrap Rule (new-file creation)

When running `/save-session`, if **a product context is detected**, create the `dev/{name}/tasks/` directory as needed and bootstrap the 3 files below (only the ones not yet created). `roadmap.md` and `CODEMAP.md` are excluded — created on-demand (§6.4, §6.5).

```markdown
# TODO — {product-name}

## Now
## Backlog
## Recently Done
```

```markdown
# Session State — {product-name}
## START HERE — [YYYY-MM-DD HH:MM] — <現在地: ブランチ・最新SHA・一言>
```

```markdown
# Lessons — {product-name}

<!-- Append entries in CLAUDE.md §4 format (### [YYYY-MM-DD] Pattern name + Trigger/Mistake/Fix/Rule) at the end (ascending order). See §6.3. -->
```

**Important**: never overwrite existing files; with no product context, do not bootstrap (root `tasks/` files are assumed to exist).

## 4. Cross-Contamination Guard

When **a product context is present** and a write to root's `tasks/lessons.md` / `tasks/todo.md` / `tasks/roadmap.md` is attempted:
1. Stop the write → 2. Ask "product-specific or cross-cutting?" → 3. Product-specific → redirect to `dev/{name}/tasks/` → 4. Root only when explicitly cross-cutting.

When **there is no product context** and a write to `dev/{name}/tasks/` is attempted: warn and confirm which product context. This guard does not apply to `session-state.md` (routing is uniquely determined).

## 5. Scope of This Rule

Write-target detection for all 5 tasks files (CODEMAP.md included, §6.5), bootstrap for the 3 bootstrapped files, and the structure contract (§6). Actually writing is each actor's responsibility. Actors that follow this rule:
- `.claude/agents/planner.md` — todo.md (checklist only, §6.1); roadmap.md (large-scale step list, §6.4)
- `.claude/commands/save-session.md` — session-state.md (§6.2) + bootstrap + lessons/todo appends
- `.claude/commands/resume-session.md` — detecting the source to read from
- `.claude/hooks/session-start.js` — reads the tasks files + journal tail for context injection (structure-independent); for CODEMAP.md it injects only a pointer (path + headings), never the body

---

## 6. File Structure Contract (single source for the "form" of the 5 files)

**Scope-out**: design artifacts under `plans/{slug}/` (PLAN.md / research.md / scope.json / deviations.md) are not part of the tasks 5 files.

### 6.1 todo.md — a lightweight backlog of only not-started and in-progress items

```markdown
# TODO — {product}
> Do not write design document body text. Work that needs a full design goes to the plan skill (heavy path) plans/.
> Step-ordered implementation checklists go to roadmap.md (§6.4), not here.
> This file holds work items only (1 line each).

## Now (top priority)
- [ ] <1 line> (priority: high)   ← items needing design link to the final home of the heavy-path artifact (done/<slug>/)

## Backlog (priority order · 1 line each)
- [ ] <1 line> (priority: med)

## Recently Done (latest 10 only · move the overflow, verbatim, into todo-archive.md — see §6.6)
- [x] <1 line> (`<sha>`, YYYY-MM-DD)
```

**Hygiene rules**: (1) no inline design body text (link to the artifact instead); (2) `Recently Done` capped at 10 — move the overflow verbatim into `todo-archive.md` (§6.6), never delete it: `tasks/*.md` is gitignored (root `.gitignore:2`; product repos mirror it, e.g. `dev/reprodocs/.gitignore:14`), so these files are untracked and deletion is unrecoverable — git log holds no copy; (3) design links point to permanent paths (`done/<slug>/` or a commit), never the volatile `plans/<slug>/`; (4) `todo-archive.md` itself carries no item-count cap and no Archive Index section — it is a flat, append-only log.

### 6.2 session-state.md — a 2-line pointer, nothing else

Reader = the next Claude session. **This file duplicates nothing**: next actions / holds / user-facing notes live ONLY in the journal report (/save-session step 4 — SessionStart injects the latest report section reliably), and lock state lives ONLY in `.claude/state/scope-lock.json` (also injected). What remains here is the per-product resume anchor and the pointer to the report that is "current".

```markdown
# Session State — {product}
## START HERE — [YYYY-MM-DD HH:MM] — <branch・latest SHA> → tasks/journal/YYYY-MM/DD.md の HH:MM レポート
```

**Hygiene rules**: (1) `## START HERE` appears **exactly once** and the whole file stays ~2 lines; (2) no Next / Blockers / Lock sections — writing them here recreates the duplication this contract exists to prevent; (3) overwrite-save is simply overwrite-save — no hook archives the previous version anymore (the archive-session-state.js hook was retired 2026-08-13, once the file shrank to a 2-line pointer): this is safe because the whole content is reproducible from the journal report and git (branch/SHA), never unique data. `tasks/history/` still holds the frozen pre-2026-08-13 archive (7 files) — **never rotated or deleted**, but not added to going forward; (4) identify commits by SHA.

### 6.3 lessons.md — fully compatible with CLAUDE.md §4 · **ascending append**

```markdown
# Lessons — {product}

### [YYYY-MM-DD] Pattern name     ← same format as CLAUDE.md §4. Append new entries at the end (ascending order).
- **Trigger**: …
- **Mistake**: …
- **Fix**: …
- **Rule**: …
```

**Hygiene rules**: (1) keep the entry heading exactly `### [date] Pattern name`; (2) H1 is `# Lessons — {product}`; (3) ascending append (old→new); (4) once ~18KB, settled entries may be distilled into `lessons-archive.md` (verbatim move; archive excluded from session-start injection).

### 6.4 roadmap.md — an ordered, dependency-resolved step list for one large-scale change, live-updated

```markdown
# Roadmap — {product}

## <work name> — [YYYY-MM-DD]
- [x] <step 1, 1 line — done>
- [~] <step 2, 1 line — in progress>
- [ ] <step 3, 1 line>
```

**Hygiene rules**: (1) markers `- [ ]` 未実装 / `- [~]` 進行中 / `- [x]` 完了; (2) top-to-bottom = implementation order; (3) mark `[~]` on start and `[x]` only when implementation **and verification** are done; (4) one work unit = one H2 section; (5) one line per step, no design body (link to plans/); (6) created on-demand only for large-scale work; (7) on completion fold into one line under todo.md `Recently Done`, then move the finished section verbatim into `todo-archive.md` (§6.6) — **do not delete it**. `roadmap.md` is `tasks/*.md` and therefore gitignored/untracked exactly like todo.md (root `.gitignore:2`), so git log holds no copy and a deletion here is just as unrecoverable; this rule previously said "delete the section (git log is the canonical history)", which was false for the same reason §6.1's did (corrected 2026-08-13).

### 6.5 CODEMAP.md — a lookup map of where things are, created on demand

```markdown
# CODEMAP — {product}

## Top-level layout
- `<dir>` — <what it's for, 1 line>

## Main flow
- <step> — `<file>:<line>`

## Entry points
- <entry point> — `<file>:<line>`

## Tables / stores
- <table/store> — <what it holds, how it connects>

## Screens ↔ components
- <screen> — <component(s)>

## Commands
- <what it checks> — `<command>`

## Traps
- <trap, 1 line>

最終確認: YYYY-MM-DD
```

**Hygiene rules**: (1) only what gets looked up repeatedly — the top-level layout and what each folder is for, the main flow with file:line anchors, the entry points, the tables/stores and how they connect, screens ↔ components, the commands that run the checks, the traps that are easy to hit; (2) do not chase completeness — a map that grows past what is actually consulted stops being maintained and rots; (3) one line per fact, links out for detail; (4) carry a `最終確認: YYYY-MM-DD` line and update it whenever the map is re-checked and still accurate, even with no content changes; (5) created on demand only, like roadmap.md — not bootstrapped; (6) never rotated.

### 6.6 todo-archive.md — verbatim overflow from todo.md's `Recently Done`, created on demand

```markdown
# Todo Archive — {product}

- [x] <1 line, moved verbatim from Recently Done> (`<sha>`, YYYY-MM-DD)
```

**Hygiene rules**: (1) verbatim move only — entries are never rewritten or summarized, matching `lessons-archive.md` (§6.3); (2) append-only, never rotated; (3) excluded from SessionStart injection (`session-start.js` reads `todo.md` only); (4) routed the same way as the other tasks files (§2): `dev/{name}/tasks/todo-archive.md` with a product context, else `tasks/todo-archive.md`; (5) created on demand only, like roadmap.md and CODEMAP.md — not bootstrapped.

---

## 7. Records Are Not Bulk-Replaced

Records mix **text describing the current state** with **text recording what was true at the time**. A cross-cutting change such as a rename must classify before replacing: code may be replaced wholesale, records may not. Past PR URLs, then-current paths, then-current UI wording, and header names all become false when rewritten wholesale — add a note recording when the rename happened instead of overwriting the old text.

`tasks/journal/**` and `tasks/history/**` are append-only and are never rewritten retroactively.
