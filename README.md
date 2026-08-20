# my-claude-base v2 (Claude Code / Codex)

Claude Code と OpenAI Codex/GPT の両方で使える開発ハーネス（作業環境一式）です。共通方針の正本は `CLAUDE.md`、Codex 向けの読み替えと入口は `AGENTS.md` です。Claude Code では hooks と権限設定も動き、Codex ではネイティブの sandbox・承認・skills を使います。

---

## はじめかた

```bash
git clone <this-repo> && cd my-claude-base-v2
claude   # Claude Code: .claude/settings.json の hooks・権限・記録が有効
codex    # Codex: AGENTS.md と .agents/skills/ が自動で読み込まれる
```

- 外部モデル連携（clover）を使う場合: `node clover/bin/install.mjs`（詳細は `clover/README.md`）
- 動作確認: `node .claude/scripts/validate.mjs`（構成の整合性検査。`PASS` が正常）
- `.claude/settings.json` の hooks は Claude Code 専用です。Codex では同じ hooks が実行されたとは見なさず、`AGENTS.md` の方針と Codex 自身の安全機構に従います。
- `dev/{name}/` は独立リポジトリなので、まずこのハブのルートから Codex を起動すると共通 `AGENTS.md` を確実に読み込めます。

---

## できること

### 計画した範囲をレビューしながら自走させられる

大きな作業では PLAN.md と scope.json に予定ファイル・禁止範囲・タスクを残し、実装後の差分をそこへ照合します。scope.json はレビュー用の境界であり、書き込みを拒否するロックではありません。

```
/plan で計画       → 計画書(PLAN.md) + 触る予定範囲(scope.json) を出力
   ↓
通常の言葉で開始を確認 → 実装を進める（特別な合言葉は不要）
   ↓
レビュー           → 変更ファイルを PLAN.md / scope.json のタスクへ照合
                     新しい案は deviations.md に提案として記録する
   ↓
/save-session      → 実施内容・保留・確認事項・次の一手を報告
```

- 1〜2ファイルの小さな修正は、重い計画成果物を作らずに進められます。
- 計画のない追加機能や依存関係は「動くおまけ」ではなく scope drift として報告します。
- hooks・設定・validator・provider adapter を変える場合は、ユーザーがハーネス自体を対象に含めたことを確認します。
- 永続 scope-lock、共有ロック状態、特別な「承認」「解除」コマンドはありません。

### Claude Codeでは作業記録が自動で残り、Codexでも途中から再開できる

Claude Code では、何も指示しなくても操作のたびに機械的な記録が残ります。Codex では Claude の journal hook は動かないため、Codex の task 履歴・git・実在する records を使い、save-session workflow で人間向けレポートと再開ポインタを残します。

| 層 | 何が残るか | 誰が書くか | いつ |
|---|---|---|---|
| 機械ジャーナル `tasks/journal/YYYY-MM/DD.md` | ツール実行・委任・安全イベントの1行ログ | Claude Code hooks（自動） | 操作のたび |
| 人間向けレポート（同ファイル末尾） | 固定4節の平易な日本語まとめ | save-session workflow | 区切りごと |
| 再開メモ `tasks/session-state.md` | 次の一手への短いポインタ（詳細はジャーナルの最新レポートを参照） | save-session workflow | 区切りごと |

- ジャーナルは追記専用で、ローテーションによる削除はありません。再開メモの2026-08-13より前の版は `tasks/history/` に凍結保存されたまま残ります（同日以降は session-state.md が2行のポインタになり退避が不要になったため、これ以上は増えません）。
- Claude Code ではセッション開始時に、前回セッションの「レポートがまだ無い」状態を自動検知し、補完を促します（`/save-session 補完` で、ジャーナルから後追いで作成できます）。Codex では自動検知を仮定せず、task 履歴と records を直接照合します。
- 会話そのものは利用中のクライアントが保存します。Claude Code では `/rewind`（Esc Esc）や `/export`、Codex では Codex の task 履歴を使います。

再開の手順はシンプルです。Claude Code は同じフォルダで `claude -r`、Codex は同じ task を開くか新しい task を開始します。Claude Code の SessionStart hook は session-state・当日ジャーナルを注入し、どちらの provider でも resume workflow は記録と git の実際の状態を突き合わせて現在地を確認します。

### 仕事を専門のサブエージェントに分けて任せられる

メインセッション（指揮者）は自分でコードを書かず、役割ごとに専門化したサブエージェントへ調査・実装・レビュー・検証を委任します。委任先には難度に応じたモデル階層（tier）が割り当たり、モデルのバージョンが上がっても階層名を書き換える必要はありません。

| Agent | Tier | 役割 |
|---|---|---|
| planner | heavy（Opus既定 / Fableは§1.11ゲートON時のみ, effort xhigh） | 計画立案・計画の自己レビュー |
| executor | standard（sonnet, effort xhigh） | 実装（指示されていない追加や無断リファクタはしない） |
| reviewer | heavy（Opus既定 / Fableは§1.11ゲートON時のみ, effort xhigh） | code / security / architecture の統合レビュー。権威席は native Fable または Opus のみ |
| verifier | standard（sonnet, effort xhigh） | 証拠（テスト結果・diff・ログ）に基づく検証 |
| debugger | standard（sonnet, effort xhigh） | 再現→仮説→反証の手順で行うデバッグ |
| explorer | light（haiku, effort指定なし） | コードベースの探索・事実収集 |
| document-author | standard（sonnet, effort xhigh） | 自己完結HTML成果物・図解・スライドの作成 |

### 実装した本人がそのまま合格を出さない品質ループ

実装者（書き手）と審査役を別インスタンス・独立コンテキストに分離します。権威モデルの許可集合は native `fable | opus` だけで変わりませんが、既定は Opus です。Fable を使うのは `.claude/.fable-status` が `ON` のとき（CLAUDE.md §1.11）だけで、OFF の間は起動先モデルが Fable と分かった時点でサブエージェントの起動を `block-fable-when-off.js` が拒否します（権威ロールに限らず全ロール共通）。判定は「ちょうど `ON` という一語かどうか」だけを見ます ―― 前後の空白や大文字小文字の違いは無視しますが、それ以外は `"ON"`（引用符付き）や `ONLINE` のような別の言葉も含めて全て OFF 扱いです。sonnet / haiku / inherit / unknown / 外部 clover id への降格や無言の切替は `block-review-floor.js` が拒否します。ただしこの仕組みが止められるのは「起動先モデルが分かるサブエージェントの起動」だけです。あなた自身のセッションが Fable で動いている場合（`/model` で選んだモデル）は対象外ですし、モデル名を指定せずに起動してセッションのモデルがそのまま引き継がれた場合は、この仕組みから見えないことがあります。

- **quality-loop**: 書き手と審査役を分けた自己改善ループ。サイクル1の仕様適合席と「赤チーム」席は通常 Opus×2、§1.11 ゲートが ON のときだけ Fable×2 で一緒に動き、混在させません。条件が揃えば別枠の外部モデル同席や、シンプルさ・利用者視点・効率・互換性・テスト検出力といった観点（レンズ）ごとの同席も加えられます（同時最大4席）。
- **セキュリティ観点は自動で同席**: 変更が API・DB・認証・決済・秘密情報などに触れると、指示しなくてもセキュリティ観点のレビューが自動で並走し、指摘は1回にまとめて統合されます。
- 承認（APPROVE）が出るまで往復し、そのあと `verifier` が証拠ベースで最終確認します。

### モデルを使い分けて外部へも振れる

native モデル名（fable / opus / sonnet / haiku / inherit）以外を指定すると、clover（外部モデル中継。リポジトリ直下 `clover/` の自己完結サブプロジェクト）経由で他社のモデルも呼び出せます。native Fable は relay に依存せず、外部 alias へ変換されません。別名の正本は `clover/models.json` で、native 名との衝突を防ぐため `fable` で始まる alias は引き続き禁止です。外部連携は `.claude/.relay-status` が `ON` のときだけ有効になり、既定は `OFF`（事故防止のため、意図せず外部へ出ないようにしています）。`OFF` のあいだは中継サーバーそのものが起動せず、接続先（`ANTHROPIC_BASE_URL`）も書き換わりません。中継が立っていると claude.ai 側のバックエンドと対で動く機能（リモコンとそのスラッシュコマンド）が使えなくなるため、切ってあるときは本当に何も立たないようにしてあります。

### スキルとコマンドが一通りそろっている

**スキル（15種）**

- **plan** — 計画を作るスキル。複雑さに応じて、確認だけで進む軽い経路と、計画書＋レビュー用の作業範囲を書き出して明示確認後に進む重い経路を自動的に選ぶ
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
CLAUDE.md            … 共通運用ルールの正本（§番号は各所から引用される安定APIとして扱う — 改番せず追記のみ）
AGENTS.md            … Codex/GPT 用 adapter（Claude 固有概念の読み替え・provider 境界）
.agents/skills/      … Codex が自動検出するハーネス入口
.claude/
  agents/            … サブエージェント定義 7体
  skills/            … スキル 15種（上記）
  commands/          … /save-session・/resume-session
  hooks/             … Claude Code hooks 18本＋共有ライブラリ（下記「安全装置」）
  rules/             … パスに連動して自動適用されるルール（agents / dev-projects / session-persistence）
  scripts/           … validate.mjs・statusline（ステータスバー表示）・doc変換（html2pdf / html2pptx / deckpack）・fusion-detect
clover/              … 外部モデル中継（自己完結のサブプロジェクト・ルート直下）
docs/                … PDF変換のセットアップ手順などのガイド
tasks/               … todo / lessons / session-state（+ history/ に2026-08-13以前の版を凍結保存・それ以降は増えない）+ journal/（機械ジャーナル＋レポート・追記専用）— いずれも git 追跡外。journal はどのプロジェクトを触っていても分岐しないルート1本のタイムライン
plans/               … /plan の成果物（PLAN.md / scope.json / deviations.md・git 追跡外・/plan が初回に生成するため、フレッシュな clone 直後には存在しない）
dev/                 … 製品プロジェクトの置き場（各自が独立したgitリポジトリを持てる・git 追跡外なので、最初の製品を置くまでフレッシュな clone 直後には存在しない）
tmp/                 … 使い捨ての作業ファイル（git 追跡外・使う側が必要時に作るため、フレッシュな clone 直後には存在しない）
```

---

## 安全装置の一覧（Claude Code hooks 18本）

全18本のうち、Bash と PowerShell の両方の経路を実際に検査するのは9本です — `settings.json` で `Bash|PowerShell` にマッチャー登録された8本（`block-fable-status-write.js` / `block-destructive-git.js` / `block-direct-to-main.js` / `block-pr-without-todo.js` / `block-destructive-fs.js` / `block-no-verify.js` / `check-commit-safety.js` / `block-secret-read.js`）と、両方を含むより広いマッチャーで動く `journal.js`。残り9本は Edit/Write・Task/Agent・SessionStart・UserPromptSubmit など別イベントに登録されており、コマンド文字列そのものは検査しません。

- **記録系**: `journal.js`（全ツール実行を1行記録） / `session-journal.js`（セッションの境界マーカーを打ち、レポート未生成を検知する） / `session-start.js`（session-state・ジャーナル末尾・todo・lessons を起動時に読み込む）
- **危険操作を止める系**: `block-destructive-git.js`（`push --force` 等の破壊的git操作） / `block-destructive-fs.js`（`rm -rf` 等の破壊的ファイル操作） / `block-secret-read.js`（`.env` など秘密情報の読み取り） / `block-no-verify.js`（`--no-verify` でのコミットフック回避） / `block-direct-to-main.js`（main への直接コミット・直接マージ） / `block-pr-without-todo.js`（このブランチの `tasks/todo.md` を更新しないまま `gh pr create` するのを拒否。ただし見ているのは更新時刻だけで、内容の正しさもどのブランチ向けの編集かも検査しない） / `check-commit-safety.js`（コミット前の安全確認）
- **運用系**: `check-prompt.js`（リポジトリ状態をプロンプトへ1行注入） / `format-on-write.js`（`dev/` 配下の自動整形） / `block-fable-status-write.js`（ユーザー専用の Fable スイッチを shell 書き込みから保護） / `relay-required-agent.js`（外部モデル連携がOFFのときに起動をブロック。native Fable は対象外） / `block-review-floor.js`（planner/reviewer の権威モデルを native fable | opus に限定） / `block-fable-when-off.js`（CLAUDE.md §1.11: `.claude/.fable-status` が ON でない限り、role を問わず model: fable での起動を拒否） / `clover-auto-install.js`（clover ラッパーの自動設置）
- **気づきを促す系**: `deliberation-gate.js`（CLAUDE.md §1.12: 委任先の報告が「うまくいかなかった／回避した」気配のとき、最上位の同期実行の報告に限って一言添えるだけの仕組みで、ブロックはしない。ルールは委任した側すべてを縛る。フックが後押しするのは最上位の同期実行だけ（実測で全委任の約30%が同期、うち約75%が最上位、報告の16%が該当 → 全委任の**およそ4%弱**でしか出ない）。フックが出なかったことは「問題なし」の意味ではない）
- **共有ライブラリ**: `lib/parse-cmd.js`（引用符・heredoc に対応したコマンド解析） / `lib/cmd-targets.js`（書き込み先抽出） / `lib/path-util.js`（ワークスペース相対パス判定） / `lib/journal-util.js`（ジャーナルへの追記）

### 熟考ゲート（`deliberation-gate.js`）の発火率を測り直すには

発火するたびに `tasks/journal/` へ `[deliberation] fired family=P|S|PS` の1行だけが追記される（マッチした語句そのものは書かない）。上の一覧にある「報告の16%が該当」を将来もう一度測るときは、次の順で確認する。

1. **まず確認すること**: 委任先の報告が実行担当エージェント（executor.md）指定の5項目の様式（`Symptom:` / `Evidence:` / …）をそのまま守りつつ、その中身がコードブロック（```` ``` ```` で囲む「フェンス」）の内側にある場合、このフックは沈黙する（フェンスの中身は丸ごと除外してから判定するため）。同じ内容がフェンスの外にあれば発火する。つまり「様式を守った報告ほど検知されにくい」という逆向きの効き方が構造として入っている。発火率を数える前に、対象期間の中でこの形（様式を守っている＋フェンスの中）の報告がどれだけあるかを見ないと、数値は過小に出る。
2. **集計コマンド（行の先頭からアンカーすること）**: 単なる `[deliberation]` の部分一致だと、他のセッションが実行したコマンド文字列（本文検索用の grep コマンド自体など）がジャーナルにそのまま記録され、それを誤ヒットする（実測で2件確認済み）。
   ```bash
   grep -cE '^- [0-9]{2}:[0-9]{2}:[0-9]{2} \[.{8}\] \[deliberation\] fired family=' tasks/journal/2026-08/*.md
   ```
3. **これは「発火率」であって「精度」ではない**: 上のコマンドで数えられるのは「何回発火したか」だけで、「発火した報告が実際に本物の問題だったか」（精度）とは別の指標。発火率が動いても精度が同じ方向に動くとは限らない — 精度を測るには発火した報告の本文を実際に読んで手作業でラベル付けする必要がある（直近の計測: 精度46%、Tier A再現率50%・全体再現率29%、いずれも上限値。詳細は PR 本文を参照）。

**オン/オフの切り替えは意図的に用意していない**: §1.8（外部モデル連携）や §1.11（Fable）にあるような ON/OFF スイッチファイルを、このフックには置かないと判断した。理由: 常に fail-open（失敗しても処理を止めず黙って通す挙動）で、発火率も全委任のおよそ4%弱と低く、セッション単位で黙らせる必要性は今のところ薄いため。実運用でうるさく感じたら、まず `.claude/hooks/deliberation-gate.js` 冒頭の語彙リスト（`P_STEMS` / `S_STEMS`）を調整するのが先。それでも完全に外したい場合は、`settings.json` の `PostToolUse` 登録と `validate.mjs` の配線チェックを**同じコミットで一緒に**外すこと（配線だけ外して検査を残すと `validate` が FAIL する）。セッション単位で一時的に黙らせる経路は用意していない。

---

## 動かして確かめる

- **構成の整合性検査**: `node .claude/scripts/validate.mjs` — フック配線・記録配線・規範文言の消失検知・面横断の文言一致など多数のチェックと、フックの構文検査（`node --check`）・相対 `require()` の解決確認を行う。`VERDICT: PASS` が正常
- **フックの全テストを1コマンドで実行**（手動実行。上記の整合性検査には配線されていない）:
  ```bash
  node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"
  ```
  件数・set別件数・skip 条件は `hook-probes.test.js` が固定値として検査します。ブランチや OS で skip が変わるため、最新の pass/fail/skip はこのコマンドの出力を正として扱い、README に実測値を固定しません。
- **clover の全テスト**（clover は自己完結のサブプロジェクトなので別コマンド）:
  ```bash
  RELAY_ROUTER_NO_LISTEN=1 RELAY_SHIM_NO_LISTEN=1 node --test clover/test/*.test.mjs
  ```
