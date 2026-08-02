# my-claude-base v2

Claude Code 用のハーネス（作業環境一式）。v2 の設計思想は1行で言えるほど単純です：

> **「絶対に起きてほしくないこと」は指示（プロンプト）ではなく、フックと権限設定で機械的に止める。記録は Claude に書かせるのではなく、仕組みが勝手に残す。**

v1 で実際に起きた2つの問題 — ①計画承認後の自走中に「承認していない実装」が混ざる、②CLI が不調になった時に作業記録が残っていない — への構造的な対策が v2 の中核です。

---

## v2 の中核1: スコープロック（承認した範囲だけで自走する）

「大計画を練りに練って、承認後はノンストップで自走する」という運用を、確認プロンプトを1つも増やさずに機械的に保証します。

```
/plan で計画       → 計画書(PLAN.md) + 触ってよい範囲の宣言(scope.json) を出力
   ↓
あなたが「承認」    → フックが範囲を .claude/state/scope-lock.json にロック
   ↓                （Claude はこのファイルに書けない — 権限設定で拒否）
自走               → 範囲内の書き込みは素通り（確認なし）
                     範囲外への書き込みは自動拒否 → 意図は deviations.md に記録
   ↓
/save-session      → 範囲外でやりたかったことを「提案」として一括報告
                     （実装はあなたの再承認後）
「解除」           → ロック解除
```

- 発動は**計画承認時だけ**。普段の小さな修正依頼は従来どおり自由に動きます。
- 「承認しない」「承認の前に質問」では作動しません（メッセージ全体が「承認」の時だけ）。複数計画がある時は「承認 {slug}」。
- Bash/PowerShell 経由の書き込み（`>` リダイレクトや `Set-Content` 等）も検査対象。書き込み先を機械判定できないコマンドはロック中は拒否されます。
- 文字列解析をすり抜けた変更も、/save-session と reviewer の「git 差分 × 承認範囲」照合（Scope Conformance）で検出されます。
- ステータスバーに 🔒slug が表示され、ロック中であることが常に見えます。

## v2 の中核2: 記録システム（クラッシュしても残る3層）

| 層 | 何が | 誰が書く | いつ |
|---|---|---|---|
| 機械ジャーナル `tasks/journal/YYYY-MM/DD.md` | 全ツール実行・委任・拒否の1行ログ | フック（自動） | 毎操作 |
| 人間向けレポート（同ファイル末尾） | 固定4節の平易な日本語まとめ | /save-session | 区切りごと |
| 再開メモ `tasks/session-state.md` | 30行以内の機械用スナップショット | /save-session | 区切りごと |

- ジャーナルは**追記専用・削除ローテーションなし**。session-state の旧版も `tasks/history/` に全量保持されます。
- セッション開始時、前回の「レポート未生成」（クラッシュや保存忘れ）を自動検知して補完を促します（「/save-session 補完」で journal から後追い作成可能）。
- 会話そのものは Claude Code 本体が常時保存しています（保存期間は settings で 365 日に延長済み）。

### 復旧ランブック（CLI が不調になったら）

1. **セッションを閉じて、同じフォルダで `claude -r`**（一覧から選んで再開）**か、新しいセッションを開始**する。`--continue` は使わない（不調が引き継がれることがある）。
2. 新しいセッションは自動で session-state.md・当日ジャーナル・ロック状態を読み込む。`/resume-session` を実行すると、記録と git の実状態（ブランチ・未コミット変更）を突き合わせて食い違いを報告してから再開する。
3. コードを巻き戻したい時はネイティブの `/rewind`（Esc Esc）。会話の書き出しは `/export`。

### 運用上の注意（3つ）

- **ロックはプロジェクト共有**: 同じフォルダで開いた全セッション（並走含む）に同じロックが効きます。解除は「解除」。
- **ハーネス自身の改修はロック無しで**: ロック中は施錠装置（settings/hooks/validate）自体が変更禁止のため、ハーネスを対象にする計画はロックを掛けずに実施します。
- **main 直コミット禁止の例外は初回のみ**: リポジトリ最初のコミット（土台一式）だけは、フック未読込の初回セッション中に main へ直接置きました。以後は必ず作業ブランチ→PR 経由です。

---

## Setup

```bash
git clone <this-repo> && cd my-claude-base-v2
claude   # 起動するだけ（フック・権限・記録は .claude/settings.json が自動で有効化）
```

- 外部モデル連携（clover）を使う場合: `node clover/bin/install.mjs`（詳細は `clover/README.md`）。
- 動作確認: `node .claude/scripts/validate.mjs`（整合性検査。PASS が正常）。

## Structure

```
CLAUDE.md            … 運用の憲法（§番号は各所から引用される安定API — 改番禁止・追記のみ）
.claude/
  agents/            … サブエージェント定義 7体
  skills/            … スキル 15種（下記）
  commands/          … /save-session・/resume-session
  hooks/             … フック 19本＋共有ライブラリ（下記）
  rules/             … パス連動ルール（agents / dev-projects / session-persistence）
  scripts/           … validate.mjs・statusline・doc変換（html2pdf / html2pptx / deckpack）・fusion-detect
  state/             … フック専用の状態置き場（スコープロック本体。Claude は書き込み不可・git 追跡外）
clover/              … 外部モデル中継（自己完結のサブプロジェクト・ルート直下）
tasks/               … todo / lessons / session-state（+ history/ 全量保持）+ journal/（機械ジャーナル＋レポート・追記専用）— いずれも git 追跡外。journal は dev モードでも分岐しないルート1本のタイムライン
plans/               … /plan の成果物（PLAN.md / scope.json / deviations.md・git 追跡外）
dev/                 … 製品プロジェクト置き場（各自が独立 git リポジトリ）
tmp/                 … 使い捨て作業ファイル
```

## Agents（7体 — モデルは tier 別名で解決、バージョン更新に自動追随）

| Agent | Tier | 役割 |
|---|---|---|
| planner | heavy (opus, effort max) | 計画立案・計画の自己レビュー |
| executor | standard (sonnet) | 実装（指示外の追加・無断リファクタ禁止。ロック拒否時は逸脱キューへ） |
| reviewer | heavy (opus, effort max) | code / security / architecture / fusion の統合レビュー。**Scope Conformance**（範囲外diff=HIGH）を常設 |
| verifier | standard (sonnet) | 証拠ベースの検証6フェーズ。メインツリーは読むだけ・想定外は触らず報告 |
| debugger | standard (sonnet) | 再現→仮説→反証のデバッグ（難件は heavy へ1回昇格） |
| explorer | light (haiku) | コードベース探索・事実収集 |
| document-author | standard (sonnet) | 自己完結HTML成果物・図解・スライド |

## Skills（15種）

- **plan** — 複雑度で軽量/重量を自動判定する計画スキル。重量パスは scope.json＋承認引き渡しで終わり、承認がロックを作動させる
- **harness** — feature / bugfix / refactor / security / research の複数エージェント一括遂行。委任時は計画書のパスを渡しワーカー自身に読ませる（伝言ゲーム禁止）
- **quality-loop** — 書き手と審査役を分離した自己改善ループ（権威=opus床値・赤チーム席常設・外部同席・**レンズカタログ**: シンプルさ/利用者視点/効率/互換/テスト検出力を条件・指名で1席、同時最大4席）。**セキュリティ席は自動判断**: 対象が API・DB・認証・決済・秘密情報等に触れると、自走中でも指揮役の判断で reviewer(target:security) が並列で1本立ち、全所見が1回の fusion に統合される（「セキュリティ観点でも厳しく検査」の明示指名や、計画の scope.json `securityReview: true` でも同席。同席可否は毎回レポートに記録）
- **check** — 完了報告前の自動検証（製品コード=build/lint/test、ハーネス=validate.mjs、HTML=自己完結lint）
- **commit** / **pr** — 規約コミットとブランチ+PR運用（main はあなたの Merge でのみ前進）
- **relay** — 外部モデルルーティング規約（clover/models.json が別名辞書のSOT）
- **code-cleaner** — 削除専用のスロップ掃除パス
- **doc** — 読み物成果物のHTML化入口（PDF/PPTX 派生）
- **preview** — dev サーバ起動→スクリーンショット→コンソール確認の目視ループ
- **frontend-design** / **brandkit** / **image-to-code** / **imagegen-frontend-web** / **imagegen-frontend-mobile** — デザイン・画像系

## Commands

- **/save-session** — スコープ照合→ジャーナルへ人間向けレポート追記（固定4節）→ session-state.md 更新→ SAVE マーカー。「/save-session 補完」で過去セッション分を後追い作成
- **/resume-session** — 記録と git 実状態の突き合わせ→現在地報告→指示待ち

## Hooks（19本）

**スコープロック系**: approve-lock.js（「承認」/「解除」の検知＝ロックの唯一の入口）/ scope-guard.js（Edit/Write の範囲外拒否）/ cmd-write-guard.js（Bash/PowerShell 書き込みの範囲外拒否＋ .claude/state の常時保護）

**記録系**: journal.js（全ツール実行の1行記録＋プランモード承認後の scope.json 案内注入）/ session-journal.js（セッション境界マーカー＋レポート未生成検知）/ session-start.js（session-state・ロック状態・ジャーナル末尾・todo・lessons の注入）/ archive-session-state.js（上書き前の全量退避 — 削除なし）

**安全系（v1から移植・Bash|PowerShell 両対応）**: block-destructive-git.js / block-destructive-fs.js / block-secret-read.js / block-no-verify.js / block-direct-to-main.js / check-commit-safety.js

**運用系**: check-prompt.js（repo-state の1行注入）/ format-on-write.js（dev/ 配下の自動整形）/ workflow-budget-guard.js（Workflow のトークン予算宣言の強制）/ relay-required-agent.js（relay OFF 時の外部モデル起動ブロック）/ block-review-floor.js（レビュー権威の opus 下限を機械強制）/ clover-auto-install.js（clover ラッパーの自動設置）

**共有ライブラリ**: lib/parse-cmd.js（引用符・heredoc対応のコマンド解析）/ lib/scope-match.js（glob照合・テスト付き）/ lib/scope-decision.js（許可判定チェーン）/ lib/journal-util.js（ジャーナル追記）

## Path-Scoped Rules

- **dev-projects.md** — dev/ 配下の製品コンテキスト分離
- **agents.md** — エージェント定義編集時の整合ルール
- **session-persistence.md** — tasks 4ファイルの配置と構造契約

## 検証

- `node .claude/scripts/validate.mjs` — 構造検査＋不変条件 canary（スコープロック配線・記録配線・規範文言の消失検知など約30項目）。フックの構文（`node --check`）と相対 require の解決先も検査する
- `node --test .claude/hooks/lib/scope-match.test.js` — glob 照合の単体テスト
- `RELAY_ROUTER_NO_LISTEN=1 RELAY_SHIM_NO_LISTEN=1 node --test clover/test/*.test.mjs` — clover 全テスト

## v1 からの主な変更

- 新設: スコープロック一式 / 機械ジャーナル / レポート未生成検知 / レンズカタログ / reviewer の Scope Conformance
- 変更: clover を `.claude/clover` → ルート `clover/` へ / save-session・resume-session をジャーナル統合の強化版へ / 履歴のローテーション削除を全廃（全量保持）/ CLAUDE.md を約1/3に圧縮（強制はフックへ移管）/ コマンド検査フックを PowerShell 経由にも対応
- 廃止: /improve（無人自己改善 — 改善は通常依頼で）/ /checkpoint（ネイティブ /rewind が代替）
