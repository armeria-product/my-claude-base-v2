# Save Session - セッション状態の保存とレポート生成

セッションの区切り（作業ブロック終了・/compact 前・終業時）に実行し、人間向けレポートと再開用メモを生成する。Claude Code ではフックが自動追記した機械ジャーナルを素材にできる。Codex では Claude フックが動いたと仮定せず、Codex のタスク履歴・git・既存の記録を素材にする。「/save-session 補完」と呼ばれた場合は、指定された過去セッションの journal 区間が存在するときだけ、それを素材に同じレポートを後追い作成する。

## Usage
```
/save-session          # 現在のセッションを保存
/save-session 補完      # クラッシュ等でレポート未生成の過去セッションを journal から補完
```

## Process（順に実行）

### 1. 保存先の決定
ルーティングは `.claude/rules/session-persistence.md` に従う（dev/{name} 作業中 → `dev/{name}/tasks/`、それ以外 → ルート `tasks/`）。未作成ならブートストラップ（同ルール §3）。

### 2. スコープ照合（計画がある場合）
PLAN.md または scope.json がこの作業を規定している場合、`git status --porcelain`（scope が dev/{name} を指す場合はその製品リポジトリで実行）の変更ファイル一覧を `allow`/`forbid` とタスク一覧へ照合し、範囲外の変更ファイルがあれば **逸脱として** レポートの「確認してほしいこと」に列挙する。計画のない小さな作業ではこのステップはスキップ。

### 3. 実績の根拠を集める
- **Claude Code**: 当日の `tasks/journal/YYYY-MM/DD.md` に機械行と journal ID（`[xxxxxxxx]`）があれば、その区間を素材にする。
- **Codex**: Codex のタスク履歴と `git status --porcelain` / `git diff` / `git log`、既存の tasks 記録を素材にする。Claude フック由来の機械行や journal ID を捏造しない。

journal は dev モードでも分岐しない**ルート1本のタイムライン**（session-persistence.md 冒頭注記）。どちらの provider でも、確認できない実績は「未検証」と書く。

### 4. 人間向けレポートを当日ジャーナル末尾に追記
文体契約（厳守）: 見出しは**結論を1行で**。平易な日本語（直訳ジャーゴン禁止 — CLAUDE.md §Language）。各項目1行。ファイル一覧や技術詳細は書かない（機械行が既にある）。

```markdown
## HH:MM セッションレポート — <結論1行: 何がどうなったか>

**やったこと**: <1-3行。成果と検証結果（PASS/FAIL/未検証）>
**できなかったこと・保留**: <未完・見送り。無ければ「なし」>
**確認してほしいこと**: <ユーザーの判断・確認が要る事項。スコープ逸脱の提案もここ。無ければ「なし」>
**次にやること**: <次セッションの最初の一手から順に、最大5行>
```

### 5. deviations の提案化（計画がある場合）
`plans/{slug}/deviations.md` と、利用できる記録に範囲外変更の拒否・保留があれば、「範囲外だが価値がありそうな変更」として上記「確認してほしいこと」に**提案として**まとめる。**実装はしない**（ユーザーが範囲拡大を認めた後の仕事）。

### 6. session-state.md の更新（ポインタ2行 — レポートと重複させない）
`{tasks-dir}/session-state.md` を以下の契約で**上書き**する（この2行はジャーナルレポートと git から再現できる内容なので、上書き前の退避はもう行わない。`tasks/history/` は2026-08-13以前の退避分を凍結保存したまま — 削除はしないが、これ以上は増えない）。

```markdown
# Session State — {context}
## START HERE — [YYYY-MM-DD HH:MM] — <ブランチ・最新SHA> → tasks/journal/YYYY-MM/DD.md の HH:MM レポート
```

**次にやること・保留・確認事項をここに書かない** — それらの唯一の家はステップ4のジャーナルレポート。Claude Code では SessionStart フックが最新レポート節を注入し、Codex では journal レポートまたはタスク履歴を直接読む。このファイルの役割は「製品ごとの再開アンカー＋どのレポートが現在地かのポインタ」だけ。

### 7. SAVE マーカーを追記（journal ID がある場合のみ）
Claude Code の journal ID、または補完対象の過去セッション ID が確認できる場合だけ、当日ジャーナル末尾に1行追記する:
```
- HH:MM:SS [xxxxxxxx] SAVE
```
Codex など journal ID が提供されない環境では、この行を省略する。架空の ID は作らない。

### 8. lessons / todo の反映（従来どおり）
セッション中に得た教訓があれば `lessons.md` に CLAUDE.md §4 形式で**末尾追記**。未完タスクは `todo.md` の `## Now`/`## Backlog` に1行追加、完了項目は `## Recently Done`（上限10）へ。設計本文のインライン書き込みは禁止（session-persistence §6.1）。

## Rules
- レポートの4見出し（やったこと / できなかったこと・保留 / 確認してほしいこと / 次にやること）は固定 — validate が見張っている
- 「できなかったこと・保留」は空でも「なし」と明記（次セッションの無駄足防止）
- session-state.md の `## START HERE` 見出しは**ちょうど1つ**・全体2行。コミットは SHA で特定
- **同じ内容を2箇所に書かない**: 次にやること・保留・スコープ逸脱＝レポート、履歴＝git と journal。session-state はポインタのみ
- ジャーナルは追記のみ — 既存行の書き換え・削除は一切しない
- Codex では Claude の自動 journal / SessionStart 注入が動いたと主張しない。タスク履歴・git・実在する記録だけを根拠にする
