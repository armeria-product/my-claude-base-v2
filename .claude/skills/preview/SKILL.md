---
name: preview
description: >
  作ったものを起動して目で見る。「プレビューして」「起動して見せて」「画面確認して」
  「動かして」と頼まれた時、および UI 変更後の視覚検証が必要な時に発動する。
  dev server の起動 → スクリーンショット → コンソールエラー確認までを一巡し、
  「作る → 見る → 指差しで直す」ループの中心になる。
user-invocable: true
---

# Preview — Launch and See It With Your Own Eyes

The core of the build-then-see loop. Captures **visual evidence**, the counterpart to textual evidence (check).

## Procedure

### 1. Identify the target and launch method (evaluate top to bottom)
1. dev mode (working under `dev/{name}/`) → read the **Commands** section of `dev/{name}/CLAUDE.md`
2. Commands is TBD/empty → detect `scripts.dev` / `scripts.start` in `package.json`
   (`Cargo.toml` → `cargo run`; `index.html` only → static serve)
3. Once detected, **write the actual values back into the Commands section** (leave a trail for next time)
4. None found → ask the user a single question about what to launch

### 2. Launch (branch by available tools)
- **When the Claude Preview tools are available (preferred)**: launch with `preview_start`.
  If the tools are deferred, use ToolSearch (load them in bulk with `"preview"`) first, then use them
- **When unavailable**: launch the dev server with Bash `run_in_background`, then
  confirm the URL/port from the startup log (shift the port if the default collides)

### 3. See (capture visual evidence)
1. Take a **screenshot** (`preview_screenshot` / Chrome integration)
2. Check the **console errors** (`preview_console_logs`) — any errors are fix targets
3. If there are key interactions (buttons, forms), operate one and observe its response

### 4. Verdict and report
```markdown
## Preview Report: [target]
- URL: [http://localhost:PORT]
- Screenshot: [observations — layout breakage / divergence from expectations]
- Console: [clean | N errors (details)]
- Verdict: looks OK / needs fixes (→ list of fix items)
```
- Console error → go straight into fixing it (§6.2 Autonomous Bug Fixing)
- A judgment on visual quality is needed → the conductor evaluates the screenshot directly
  (prioritize and flag issues from the angles of breakage / visual flow / consistency / polish)

## Rules
- Retry a failed launch up to 3 times (port change, dependency install) → if it still fails, report the cause
- Stop any server you launched when the work is done (don't leave background processes running)
- Visual confirmation is not a substitute for "it worked" — the correctness of logic is check's job (division of roles)
