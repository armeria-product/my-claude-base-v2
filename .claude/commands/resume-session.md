# Resume Session - セッション状態の復元

新規セッション、Claude Code の `claude -r`、または Codex で開き直したタスクから前回の続きへ戻るための入口。**記録と現実（git・適用中の計画）を突き合わせ、食い違いを報告してから**再開する。

> Claude Code のクラッシュ復旧: 同じフォルダで `claude -r`（一覧から選ぶ）か新規セッション → `/resume-session`。`--continue` は使わない（この環境ではバグ状態を引き継ぐことがある）。Codex では既存のタスクを開き直すか、ハブのルートで新しいタスクを開始し、この手順で records と git を照合する。

## Usage
```
/resume-session
```

## Process

### 1. 記録を読む
- `{tasks-dir}/session-state.md` はポインタ（2行）— 指している journal レポート節が「前回の到達点と次にやること」の本体
- 必要なら前日の `tasks/journal/YYYY-MM/DD.md` も遡る（機械行＝実際に何をしたかの記録）
- Claude Code で SessionStart が最新レポート節を注入済みなら再読不要。注入に「レポート未生成セッション」の警告があれば、その ID の journal 区間も読む
- Codex では SessionStart 注入を前提にせず、Codex のタスク履歴・git・実在する records を直接読む。機械行や journal ID が無ければ、無いものとして扱う

### 2. 現実と突き合わせる（食い違いは黙って直さず、報告する）
| 確認 | コマンド / 参照 | 見るもの |
|---|---|---|
| ブランチ | `git branch --show-current` | session-state の記載と一致するか |
| 未コミット変更 | `git status --porcelain` | 記録に無い変更ファイルは無いか（並走セッションの痕跡の可能性 — 触らず報告） |
| 最新コミット | `git log -1 --oneline` | 記録の SHA と繋がっているか |
| 計画・スコープ | `plans/*/PLAN.md` / `scope.json`（この作業を規定するものがある場合） | 変更が task / `allow` / `forbid` と整合するか。これはレビュー資料でありロックではない |

### 3. 報告して待つ
以下を平易な日本語で報告し、**ユーザーの指示を待つ**（勝手に作業を始めない）:
1. 現在地（ブランチ・最新SHA・適用中の計画があればその名前）
2. 前回の到達点（journal レポートの見出し＋「次にやること」— session-state はそこへのポインタ）
3. 記録と現実の食い違い（あれば。無ければ「一致」）
4. 推奨する次の一手（1行）

レポート未生成の過去セッションが実在する journal ID とともに検知されている場合だけ、「/save-session 補完 を先に実行するか」も選択肢として提示する。
