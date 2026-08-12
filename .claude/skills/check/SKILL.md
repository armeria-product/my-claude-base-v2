---
name: check
description: >
  変更を完了してユーザーに「終わりました」と報告する前に自動発動する単一の検証入口。
  対象を自動判別して使い分ける: 製品コード（dev/ 等）→ build/type/lint/test の6フェーズ検証
  （UI 変更は視覚確認を追加）/ ハーネス本体（.claude/・CLAUDE.md・README.md）→ validate.mjs で整合性スキャン。
  実装直後・バグ修正直後・リファクタ直後・ハーネス設定変更直後に使う。
  1-2行の自明な修正・ハーネスに影響しない純粋な docs のみはスキップ可。
  「check して」「検証して」「整合性チェックして」でも発動。
user-invocable: true
---

# Check — Unified Verification Trigger

A single entry point that combines product-code verification (formerly verify) and harness integrity checking (formerly validate).
It auto-triggers **before** a completion report and runs the appropriate check based on what changed.

## Automatic Target Detection

Look at the dirty files (`git status --porcelain`) and run **all** of the checks that apply:

| Change target | Check to run |
|---|---|
| Harness itself (under `.claude/`, `CLAUDE.md`, `README.md`) | `node .claude/scripts/validate.mjs` (integrity scan) |
| Product code (`dev/**` and other code files) | The verifier agent's 6 phases (build / type / lint / test / debug-scan / diff) |
| UI files among the above (components / CSS / screen-related) | The above plus the main session running `/preview` (launch → screenshot → console check) |
| HTML reading-material deliverables (`*.html` made for the user via `doc` / §10) | **Self-containment lint** — single definition and procedure in Execution below |

## Execution

- **Harness check**: Run `node .claude/scripts/validate.mjs`, and include `VERDICT: PASS/FAIL` and the findings count in the report. node must be on PATH (Windows: `/c/Program Files/nodejs`). Read pass/fail from the **exit code as an integer**, captured with a redirect (`node .claude/scripts/validate.mjs > log 2>&1; echo "EXIT=$?"`) — never through a pipe, never by scanning the log for failure words — and compare the findings count against the prior run when one is available: a check that only looks for "something bad present" stays silent when the subject itself disappears
- **Product-code check**: Invoke the verifier agent and follow its protocol (`.claude/agents/verifier.md`). Tool detection, phase definitions, and output format are owned (SOT) by the verifier
- **Visual phase (UI only)**: Since the verifier is Bash-only and cannot preview, `/preview` is the main session's responsibility (text verification = verifier / visual verification = /preview, split between them)
- **HTML self-containment (doc deliverables)** — allowlist check: a self-contained file fetches **nothing and references nothing outside itself**. Ignoring text inside `<code>`/`<pre>` (citations don't count), scan **case-insensitively** for any resource reference — `href` / `src` / `srcset` / `@import` / CSS `url(...)` / `<script src>` / `<link>` / `<iframe>`. For ordinary reading-material HTML (§10's single-file guarantee), only these targets are allowed: inline content, `data:` URIs, and same-document fragments (`href="#toc"` etc.); **any relative path (`href="style.css"`, `src="figure.png"`, etc.) or remote target (`http:`, `https:`, protocol-relative `//host`) is a FAIL** — a relative reference breaks the moment the file is copied/attached alone, which is exactly what §10 guarantees against. (`xmlns=` namespace URIs on inline SVG are not resource loads — ignore.) Any hit ⇒ FAIL, send back to `document-author`. **Exception — packed slide decks** (`*.deck.html`, built by `deckpack.mjs --pack`): these intentionally contain relative-looking `<script src="<uuid>">` / `url("<uuid>")` references that resolve to resources bundled inside the same file, not external paths, so for `.deck.html` only relative references are allowed and only remote (`http:`/`https:`/`//host`) targets are a FAIL — base64 payloads can't contain `https://` and pack strips the template's preconnect link, so any remote hit there is real breakage

## Conditions Where Skipping Is Allowed

If any of the following hold, running is unnecessary. Add a one-liner to your response: "check skipped: [reason]":

- 1-2 line obvious fixes (typos, renames, etc.)
- Pure docs / comment-only changes with no harness impact — **removing** comments from code does not qualify: machine-read annotations (`@ts-expect-error`, `eslint-disable`, pragma comments, etc.) hide among human ones, so a comment-removal pass still runs the gate
- Pure questions / consultation (no changes)

## On FAIL

- Harness check FAIL → fix it, then rerun. Do not report "done" while it is still FAIL
- Product-code check FAIL → fix it and rerun. "Probably works" is not acceptable (CLAUDE.md §1.2)
