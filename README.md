# my-claude-base v2

Claude Code 向けの開発ハーネス（作業環境一式）です。壊れてはいけない操作はプロンプトではなく、フック（操作のたびに自動で走る検査スクリプト）と権限設定で機械的に止め、作業記録は指示しなくても仕組みが自動で残ります。

---

## はじめかた

```bash
git clone <this-repo> && cd my-claude-base-v2
claude   # 起動するだけ。フック・権限・記録は .claude/settings.json が自動で有効化する
```

- 外部モデル連携（clover）を使う場合: `node clover/bin/install.mjs`（詳細は `clover/README.md`）
- 動作確認: `node .claude/scripts/validate.mjs`（構成の整合性検査。`PASS` が正常）

---

## できること

### 承認した範囲だけで自走させられる

大きな計画を立てたあとは、確認プロンプトを増やさずにノンストップで自走させられます。それでいて、承認していない場所には書き込めません。

```
/plan で計画       → 計画書(PLAN.md) + 触ってよい範囲の宣言(scope.json) を出力
   ↓
「承認」と返信      → フックが範囲を .claude/state/scope-lock.json にロック
   ↓                （Claude はこのファイルに書き込めない — 権限設定で拒否）
自走               → 範囲内の書き込みは確認なしで進む
                     範囲外への書き込みは自動拒否され、あとで提案として記録される
   ↓
/save-session      → 範囲外でやりたかったことを提案として一括報告
                     （実装は再承認のあと）
「解除」           → ロックを外す
```

- 発動するのは計画を承認したときだけ。普段の小さな修正依頼はロックなしで自由に動きます。
- Bash/PowerShell 経由の書き込み（リダイレクトや `Set-Content` など）も検査対象です。書き込み先を機械的に判定できないコマンドは、ロック中は拒否されます。
- 文字列としての検査をすり抜けた変更も、審査役が行う「差分 × 承認範囲」の突き合わせ（Scope Conformance）で見つかります。
- ステータスバーに `🔒スラッグ名` が出るので、ロック中かどうかが常に見えます。
- ロックはフォルダ単位で共有され、同時に開いた別セッションにも同じロックが効きます。
- ハーネス自身（フックや権限設定）を対象にする計画は、施錠装置自体を施錠できないため、ロックなしで実施します。

### 作業記録が指示しなくても残り、途中からでも再開できる

何も指示しなくても操作のたびに機械的な記録が残るので、CLI が不調になったりセッションが途切れたりしても、続きから再開できます。

| 層 | 何が残るか | 誰が書くか | いつ |
|---|---|---|---|
| 機械ジャーナル `tasks/journal/YYYY-MM/DD.md` | 全ツール実行・委任・拒否の1行ログ | フック（自動） | 操作のたび |
| 人間向けレポート（同ファイル末尾） | 固定4節の平易な日本語まとめ | `/save-session` | 区切りごと |
| 再開メモ `tasks/session-state.md` | 次の一手への短いポインタ（詳細はジャーナルの最新レポートを参照） | `/save-session` | 区切りごと |

- ジャーナルは追記専用で、ローテーションによる削除はありません。再開メモの古い版も `tasks/history/` に全量残ります。
- セッションを開始すると、前回セッションの「レポートがまだ無い」状態を自動検知し、補完を促します（`/save-session 補完` で、ジャーナルから後追いで作成できます）。
- 会話そのものは Claude Code 本体が保存します（保存期間は 365 日）。コードを巻き戻したいときはネイティブの `/rewind`（Esc Esc）、会話の書き出しは `/export` を使います。

再開の手順はシンプルです。同じフォルダで `claude -r` を実行して一覧から選ぶか、新しいセッションを開始するだけで、session-state・当日ジャーナル・ロック状態が自動で読み込まれます。`/resume-session` を実行すると、記録と git の実際の状態（ブランチ・未コミットの変更）を突き合わせて、食い違いがあれば報告してから再開します。

### 仕事を専門のサブエージェントに分けて任せられる

メインセッション（指揮者）は自分でコードを書かず、役割ごとに専門化したサブエージェントへ調査・実装・レビュー・検証を委任します。委任先には難度に応じたモデル階層（tier）が割り当たり、モデルのバージョンが上がっても階層名を書き換える必要はありません。

| Agent | Tier | 役割 |
|---|---|---|
| planner | heavy（opus, effort max） | 計画立案・計画の自己レビュー |
| executor | standard（sonnet） | 実装（指示されていない追加や無断リファクタはしない） |
| reviewer | heavy（opus, effort max） | code / security / architecture の統合レビュー。審査時は常に opus 以上（frontier 下限）で動く |
| verifier | standard（sonnet） | 証拠（テスト結果・diff・ログ）に基づく検証 |
| debugger | standard（sonnet） | 再現→仮説→反証の手順で行うデバッグ |
| explorer | light（haiku） | コードベースの探索・事実収集 |
| document-author | standard（sonnet） | 自己完結HTML成果物・図解・スライドの作成 |

### 実装した本人がそのまま合格を出さない品質ループ

実装者（書き手）と審査役を分離し、審査役は必ず opus 以上のモデルで動きます（`block-review-floor.js` が機械的に強制するので、下げようとしても弾かれます）。

- **quality-loop**: 書き手と審査役を分けた自己改善ループ。あえて反対の立場で粗を探す「赤チーム」席が常設され、条件が揃えば外部モデルの同席や、シンプルさ・利用者視点・効率・互換性・テスト検出力といった観点（レンズ）ごとの同席も加えられます（同時最大4席）。
- **セキュリティ観点は自動で同席**: 変更が API・DB・認証・決済・秘密情報などに触れると、指示しなくてもセキュリティ観点のレビューが自動で並走し、指摘は1回にまとめて統合されます。
- 承認（APPROVE）が出るまで往復し、そのあと `verifier` が証拠ベースで最終確認します。

### モデルを使い分けて外部へも振れる

Claude 標準の階層名（opus / sonnet / haiku / inherit）以外のモデル名を指定すると、clover（外部モデル中継。リポジトリ直下 `clover/` の自己完結サブプロジェクト）経由で他社のモデルも呼び出せます。別名の正本は `clover/models.json` です。関連の切り替えは `.claude/.relay-status` が `ON` のときだけ有効になり、既定は `OFF`（事故防止のため、意図せず外部へ出ないようにしています）。

### スキルとコマンドが一通りそろっている

**スキル（15種）**

- **plan** — 計画を作るスキル。複雑さに応じて、確認だけで進む軽い経路と、計画書＋触ってよい範囲の宣言を書き出して承認後に自走を始める重い経路を自動的に選ぶ
- **harness** — 探索・実装・レビュー・検証などの担当を差配して、機能追加・不具合修正・リファクタ・セキュリティ対応・調査を一括で任せられるスキル。担当者には計画書のパスだけを渡し、内容は担当者自身に読ませる（言い換えて写さない）
- **quality-loop** — 上記「品質ループ」の中身（レンズカタログ・赤チーム席・セキュリティ席の運用規約）
- **check** — 「完了」と報告する前に必ず走らせる自動検証。製品コードはビルド・型検査・lint・テスト、ハーネス自身は `validate.mjs`、読み物成果物のHTMLは自己完結チェック
- **commit** — 規約に沿ったコミットメッセージを作る
- **pr** — 作業ブランチを切って PR を作るところまでを一括で行う。main ブランチへの直接コミットは仕組みで拒否される
- **relay** — 外部モデルへつなぐときの命名規約。`clover/models.json` を別名の正本として参照する
- **code-cleaner** — 使われなくなったコードを削る専門のスキル
- **doc** — 報告書・分析・比較などユーザーが読む成果物を、1ファイルで完結するHTMLにまとめるスキル。PDFやスライド（PPTX）への変換はここから派生する
- **preview** — 開発サーバーを起動してスクリーンショットを撮り、コンソールのエラーも合わせて確認する目視チェックのループ
- **frontend-design / brandkit / image-to-code / imagegen-frontend-web / imagegen-frontend-mobile** — 画面デザイン・ブランド・画像からコードへの変換など、見た目まわりを担当するスキル群

**コマンド（2種）**

- **/save-session** — 作業範囲の整合を確認したうえで、ジャーナルへ人間向けの報告を追記し、再開メモ（session-state.md）を更新する。「/save-session 補完」で、報告を作りそびれた過去のセッション分もあとから作成できる
- **/resume-session** — 記録と git の実際の状態を突き合わせて、現在地を報告してから指示を待つ

---

## 何がどこにあるか

```
CLAUDE.md            … 運用ルールの本体（§番号は各所から引用される安定APIとして扱う — 改番せず追記のみ）
.claude/
  agents/            … サブエージェント定義 7体
  skills/            … スキル 15種（上記）
  commands/          … /save-session・/resume-session
  hooks/             … フック 19本＋共有ライブラリ（下記「安全装置」）
  rules/             … パスに連動して自動適用されるルール（agents / dev-projects / session-persistence）
  scripts/           … validate.mjs・statusline（ステータスバー表示）・doc変換（html2pdf / html2pptx / deckpack）・fusion-detect
  state/             … フック専用の状態置き場（スコープロック本体。Claude は書き込み不可・git 追跡外）
clover/              … 外部モデル中継（自己完結のサブプロジェクト・ルート直下）
docs/                … PDF変換のセットアップ手順などのガイド
tasks/               … todo / lessons / session-state（+ history/ に全量保持）+ journal/（機械ジャーナル＋レポート・追記専用）— いずれも git 追跡外。journal はどのプロジェクトを触っていても分岐しないルート1本のタイムライン
plans/               … /plan の成果物（PLAN.md / scope.json / deviations.md・git 追跡外）
dev/                 … 製品プロジェクトの置き場（各自が独立したgitリポジトリを持てる）
tmp/                 … 使い捨ての作業ファイル
```

---

## 安全装置の一覧（フック19本）

すべて Bash と PowerShell の両方の経路を検査します。

- **スコープロック系**: `approve-lock.js`（「承認」/「解除」の検知＝ロックの唯一の入口） / `scope-guard.js`（Edit/Write の範囲外書き込みを拒否） / `cmd-write-guard.js`（Bash/PowerShell 経由の範囲外書き込みを拒否し、`.claude/state` を常時保護する）
- **記録系**: `journal.js`（全ツール実行を1行記録し、計画承認後は scope.json の案内を出す） / `session-journal.js`（セッションの境界マーカーを打ち、レポート未生成を検知する） / `session-start.js`（session-state・ロック状態・ジャーナル末尾・todo・lessons を起動時に読み込む） / `archive-session-state.js`（上書きの前に全量を退避する — 削除しない）
- **危険操作を止める系**: `block-destructive-git.js`（`push --force` 等の破壊的git操作） / `block-destructive-fs.js`（`rm -rf` 等の破壊的ファイル操作） / `block-secret-read.js`（`.env` など秘密情報の読み取り） / `block-no-verify.js`（`--no-verify` でのコミットフック回避） / `block-direct-to-main.js`（main への直接コミット・直接マージ） / `check-commit-safety.js`（コミット前の安全確認）
- **運用系**: `check-prompt.js`（リポジトリ状態をプロンプトへ1行注入） / `format-on-write.js`（`dev/` 配下の自動整形） / `workflow-budget-guard.js`（複数エージェント編成のトークン予算宣言を強制） / `relay-required-agent.js`（外部モデル連携がOFFのときに起動をブロック） / `block-review-floor.js`（審査役の opus 下限を機械的に強制） / `clover-auto-install.js`（clover ラッパーの自動設置）
- **共有ライブラリ**: `lib/parse-cmd.js`（引用符・heredoc に対応したコマンド解析） / `lib/scope-match.js`（glob照合） / `lib/scope-decision.js`（許可判定チェーン） / `lib/journal-util.js`（ジャーナルへの追記）

---

## 動かして確かめる

- **構成の整合性検査**: `node .claude/scripts/validate.mjs` — フック配線・記録配線・規範文言の消失検知など約30項目のチェックと、フックの構文検査（`node --check`）・相対 `require()` の解決確認を行う。`VERDICT: PASS` が正常
- **フックの全テストを1コマンドで実行**（手動実行。上記の整合性検査には配線されていない）:
  ```bash
  node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"
  ```
  現時点で241件のテストが pass します。
- **clover の全テスト**（clover は自己完結のサブプロジェクトなので別コマンド）:
  ```bash
  RELAY_ROUTER_NO_LISTEN=1 RELAY_SHIM_NO_LISTEN=1 node --test clover/test/*.test.mjs
  ```
