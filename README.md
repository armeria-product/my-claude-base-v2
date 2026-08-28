# my-claude-base v2 (Claude Code / Codex)

Claude Code と OpenAI Codex/GPT の両方で使える開発ハーネス（作業環境一式）です。Claude Code は `CLAUDE.md` と `.claude/`、Codex は `AGENTS.md`・`.codex/`・`.agents/skills/` という、それぞれ独立した実行面を使います。Claude Code では hooks と権限設定が動き、Codex では Main Sol が調査・設計・計画・レビューを担い、Luna Max が実装し、sandbox・承認・最小限の skills と native hooks を使います。

---

## はじめかた

```bash
git clone <this-repo> && cd my-claude-base-v2
claude   # Claude Code: .claude/settings.json の hooks・権限・記録が有効
codex    # Codex: AGENTS.md、.codex/hooks.json、.agents/skills/ が読み込まれる
```

- 外部モデル連携（clover）を使う場合: `node clover/bin/install.mjs`（詳細は `clover/README.md`）
- Codexの動作確認: `node .codex/scripts/check-native.mjs`（ローカル検証）
- Claude Codeの構成検査: `node .claude/scripts/validate.mjs`（Claude側のみ。`PASS` が正常）
- `.claude/settings.json` の hooks は Claude Code 専用です。Codex は同じ hooks を実行せず、独立した `.codex/hooks.json` を使います。初回と変更後は Codex の `/hooks` で内容を確認・信頼し、新しい task を開始してから使います。
- Codex native hooks は、設定したツール経路でライフサイクルと対応する編集パスを機械イベントとして記録し、SessionStart に state・最新の人間向けレポート・TODO の Now・CODEMAP見出しを合計8 KiB以内で渡します。PostToolUse は自動整形・書き換え・任意のshellコマンド記録を行いません。PreToolUse は秘密情報、`--no-verify`、高確度の破壊的操作、保護ブランチへの直接書き込みを扱います。無効化・信頼確認の迂回・外部の端末やエディタは対象外なので、sandbox・承認・Git ホスティング側の保護も併用します。
- `dev/{name}/` は独立リポジトリです。そこで直接作業する場合は、その製品ルートで Codex を開始して製品側の `AGENTS.md` を読み込みます。共通 skills・hooks を含むハブ面が必要な作業はハブルートから開始し、作業前に対象製品の `AGENTS.md` も確認します。

---

## できること

### 必要な分だけ計画して自走させられる

Claude Code は既存の `/plan`、Codex は Main Sol の通常の会話内計画を使います。Codex に専用 orchestrator はなく、Main Sol が調査・設計・計画を行い、1つの Luna Max が実装し、Main Sol がreview・検証します。既存の `PLAN.md` を使う作業では、その計画へ差分を照合します。

```
依頼 → Main Sol が調査・設計・計画
     → 1つの Luna Max が実装
     → Main Sol が差分をreview・検証 → 必要なら同じ Luna Max が修正
     → 構造変更なら tasks/codemap.md を同じ変更で更新
     → 区切りで `/save-session`（Claude）または `$save-session`（Codex）
```

- 小さな修正も難しい修正も Luna Max に渡します。難しい判断・設計は Main Sol が先に決めます。
- 計画のない追加機能や依存関係は「動くおまけ」ではなく scope drift として報告します。
- hooks・設定・validator・provider adapter を変える場合は、ユーザーがハーネス自体を対象に含めたことを確認します。
- プロジェクト構造・entrypoint・所有/責務・重要な制御フローが変わるときは、同じ変更で現在の作業コンテキストにルーティングされた最寄りの `tasks/codemap.md` を更新します。内容だけの編集や、その関係を変えない振る舞いだけの変更では地図を無駄に更新せず、完了時に適用可否と見出し・パスの正確さを確認します。

### Claude Code と Codex で作業記録を自動化し、途中から再開できる

Claude Code と、信頼済みの native hooks を読み込んだ Codex では、それぞれの provider の記録契約に従って記録が残ります。どちらでも save-session workflow で人間向けレポートと再開ポインタを残し、task 履歴と Git で実態を照合します。

| 層 | 何が残るか | 誰が書くか | いつ |
|---|---|---|---|
| Claude Code の機械ジャーナル `tasks/journal/YYYY-MM/DD.md` | ツール実行・安全イベントの1行ログ | Claude Code hooks（自動） | 操作のたび |
| Claude Code の人間向けレポート（同ファイル末尾） | 固定4節の平易な日本語まとめ | Claude Code の save-session workflow | 区切りごと |
| Codex の機械イベント `tasks/journal/.machine/YYYY-MM/DD.log` | ライフサイクルと対応する編集パスのみ | 信頼済み Codex native hooks（自動） | 対応イベント時 |
| Codex の人間向けレポート `tasks/journal/YYYY-MM/DD.md` | 固定4節の平易な日本語まとめ | `$save-session` | 区切りごと |
| 再開メモ `tasks/session-state.md` | 次の一手への短いポインタ（詳細はジャーナルの最新レポートを参照） | save-session workflow | 区切りごと |

- ジャーナルは追記専用で、ローテーションによる削除はありません。再開メモの2026-08-13より前の版は `tasks/history/` に凍結保存されたまま残ります（同日以降は session-state.md が2行のポインタになり退避が不要になったため、これ以上は増えません）。
- Claude Code は、セッション開始時に session-state・todo・最新 journal レポート・lessons を注入します。
- 信頼済み Codex native hooks は、SessionStart に state・最新の人間向けレポート・TODO の Now・CODEMAP見出しを合計8 KiB以内で渡し、lessons は注入しません。
- 注入が無い task では、task 履歴と records を直接照合します。
- 会話そのものは利用中のクライアントが保存します。Claude Code では `/rewind`（Esc Esc）や `/export`、Codex では Codex の task 履歴を使います。

再開の手順はシンプルです。Claude Code は同じフォルダで `claude -r`、Codex は同じ task を開くか新しい task を開始します。各 provider の専用 SessionStart hook が有効なら記録を注入し、いずれでも resume workflow は記録と git の実際の状態を突き合わせて現在地を確認します。

### Codex は Main Sol が決め、Luna Max が実装する

Codex の流れは、Main Sol が依頼を調査し、根本原因・要件・設計・実装方針を決めてから、1つの Luna Max が `gpt-5.6-luna` / `max` で bounded handoff の範囲を実装し、Main Sol が差分・要件適合・検証をreviewする形です。問題があれば同じ Luna Max thread に戻して修正し、Main Sol が再reviewします。小さな変更も難しい変更もこの所有分担を変えません。

Luna、custom agent、model/effort、spawn が失敗したら Main Sol は停止して失敗理由と no-fallback を報告し、Main が実装を引き取ることはありません。Codex に standing chain はなく、追加の委任は独立した読み取り調査・レビュー・セキュリティ分析などに限ります。

Claude Code 側の agents・quality loop・model gate は `.claude/` に残る provider 固有機能です。Codex はそれらを継承せず、実装writerは `.codex/agents/luna-max.toml` に固定します。

Product Design/UI/UX、Skill、Pluginの作業もこの分担を変えません。Main Solがcurrent-state/UX分析、information architecture/design判断、実装計画を担い、Luna MaxがReact/CSS/component/layout/responsive/accessibility/testを編集し、Main Solがbrowser/screenshot/UX/diff/final verificationを行います。

### Claude Code ではモデルを使い分けて外部へも振れる

native モデル名（fable / opus / sonnet / haiku / inherit）以外を指定すると、clover（外部モデル中継。リポジトリ直下 `clover/` の自己完結サブプロジェクト）経由で他社のモデルも呼び出せます。native Fable は relay に依存せず、外部 alias へ変換されません。別名の正本は `clover/models.json` で、native 名との衝突を防ぐため `fable` で始まる alias は引き続き禁止です。外部連携は `.claude/.relay-status` が `ON` のときだけ有効になり、既定は `OFF`（事故防止のため、意図せず外部へ出ないようにしています）。`OFF` のあいだは中継サーバーそのものが起動せず、接続先（`ANTHROPIC_BASE_URL`）も書き換わりません。中継が立っていると claude.ai 側のバックエンドと対で動く機能（リモコンとそのスラッシュコマンド）が使えなくなるため、切ってあるときは本当に何も立たないようにしてあります。

ただしこの仕組みが止められるのは「起動先モデルが分かるサブエージェントの起動」だけです。あなた自身のセッションが Fable で動いている場合（`/model` で選んだモデル）は対象外ですし、モデル名を指定せずに起動してセッションのモデルがそのまま引き継がれた場合は、この仕組みから見えないことがあります。

### Claude Code と Codex のワークフローが独立している

**Codex native surface**

- **Sol-led / Luna-implemented** — Main Sol が調査・設計・計画・要件・リスク判断とreviewを担い、Luna Max が小さな変更も難しい変更も実装する。実装の既定は `gpt-5.6-luna` / `max`。
- **native implementation agent** — `.codex/config.toml` がsubagentの既定値を設定し、`.codex/agents/luna-max.toml` が唯一のCodex custom implementation agentを定義する。
- **single-writer correction loop** — Main Sol → 1つの Luna Max → Main Sol のreview・検証 → 必要なら同じ Luna Max、という単一writerの流れ。standing role chain、`.codex/roles/`、`.codex/workflows/` は置かない。Lunaの失敗時は停止し、Mainの実装fallbackはしない。
- **skills（2種）** — **$save-session** と **$resume-session** だけを `.agents/skills/` から検出する。これらは保存・再開の narrow workflow であり、実装を開始しない。
- **optional read-only delegation** — 独立コンテキストの調査・読み取りreview・security分析などに限る。実装writerを増やさず、固定 role chain や自動 quality loop は作らない。
- **native records** — 人間向けの追記専用記録は `tasks/journal/YYYY-MM/DD.md` が正本。旧 `tasks/journal/YYYY/MM/DD.md` は読むだけの互換経路で、ライフサイクルと編集パスの機械イベントは `.machine/YYYY-MM/DD.log` に分離する。
- **native hooks** — SessionStart は state・最新人間レポート・TODO の Now・CODEMAP見出しを8 KiB以内で渡す。PreToolUse は狭い安全境界を検査し、PostToolUse は編集パスだけを機械記録する。自動整形・書き換え・任意のshellコマンド記録はしない。
- **path guidance** — ルートと対象ディレクトリの `AGENTS.md` を使う。Codexは開始時のパスまでしか自動収集しないため、別の独立製品へ移るときは新しい task を開始する。独立製品のルートはローカル指針のみを受け取り、共通agents/skills/hooksはハブルートから開始したtaskで使う。

**Claude Code surface**

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

**Claude Code コマンド（2種）**

- **/save-session** — 作業範囲の整合を確認したうえで、ジャーナルへ人間向けの報告を追記し、再開メモ（session-state.md）を更新する。「/save-session 補完」で、報告を作りそびれた過去のセッション分もあとから作成できる
- **/resume-session** — 記録と git の実際の状態を突き合わせて、現在地を報告してから指示を待つ

---

## 何がどこにあるか

```
CLAUDE.md            … Claude Code 用の運用ルール
AGENTS.md            … Codex/GPT 用の独立した運用ルール・入口
.agents/skills/      … Codex の session 保存・再開 skills 2種
.codex/
  config.toml         … Luna Max（gpt-5.6-luna / max）の既定値
  agents/luna-max.toml … 唯一のCodex implementation agent
  hooks.json・hooks/  … Codex native hooks
  scripts/            … check-native.mjs（native surface validator）
.claude/
  agents/            … サブエージェント定義 7体
  skills/            … スキル 15種（上記）
  commands/          … Claude Code の /save-session・/resume-session
  hooks/             … Claude Code hooks 18本＋共有ライブラリ（下記「安全装置」）
  rules/             … パスに連動して自動適用されるルール（agents / dev-projects / session-persistence）
  scripts/           … validate.mjs・statusline（ステータスバー表示）・doc変換（html2pdf / html2pptx / deckpack）・fusion-detect
clover/              … 外部モデル中継（自己完結のサブプロジェクト・ルート直下）
docs/                … PDF変換のセットアップ手順などのガイド
tasks/               … todo / lessons / session-state（+ history/ に2026-08-13以前の版を凍結保存・それ以降は増えない）+ journal/（機械ジャーナル＋レポート・追記専用）— いずれも git 追跡外。journal はどのプロジェクトを触っていても分岐しないルート1本のタイムライン
plans/               … /plan の成果物（PLAN.md / deviations.md・git 追跡外・/plan が初回に生成するため、フレッシュな clone 直後には存在しない）
dev/                 … 製品プロジェクトの置き場（各自が独立したgitリポジトリを持てる・git 追跡外なので、最初の製品を置くまでフレッシュな clone 直後には存在しない）
tmp/                 … 使い捨ての作業ファイル（git 追跡外・使う側が必要時に作るため、フレッシュな clone 直後には存在しない）
```

---

## 安全装置の一覧（Claude Code hooks 18本）

全18本のうち、Bash と PowerShell の両方の経路を実際に検査するのは9本です — `settings.json` で `Bash|PowerShell` にマッチャー登録された8本（`cmd-write-guard.js` / `block-destructive-git.js` / `block-direct-to-main.js` / `block-pr-without-todo.js` / `block-destructive-fs.js` / `block-no-verify.js` / `check-commit-safety.js` / `block-secret-read.js`）と、両方を含むより広いマッチャーで動く `journal.js`。残り9本は Edit/Write・Task/Agent・SessionStart・UserPromptSubmit など別イベントに登録されており、コマンド文字列そのものは検査しません。

- **記録系**: `journal.js`（全ツール実行を1行記録） / `session-journal.js`（セッションの境界マーカーを打ち、レポート未生成を検知する） / `session-start.js`（session-state・ジャーナル末尾・todo・lessons を起動時に読み込む）
- **危険操作を止める系**: `block-destructive-git.js`（`push --force` 等の破壊的git操作） / `block-destructive-fs.js`（`rm -rf` 等の破壊的ファイル操作） / `block-secret-read.js`（`.env` など秘密情報の読み取り） / `block-no-verify.js`（`--no-verify` でのコミットフック回避） / `block-direct-to-main.js`（main への直接コミット・直接マージ） / `block-pr-without-todo.js`（このブランチの `tasks/todo.md` を更新しないまま `gh pr create` するのを拒否。ただし見ているのは更新時刻だけで、内容の正しさもどのブランチ向けの編集かも検査しない） / `check-commit-safety.js`（コミット前の安全確認）
- **運用系**: `check-prompt.js`（リポジトリ状態をプロンプトへ1行注入） / `format-on-write.js`（`dev/` 配下の自動整形） / `cmd-write-guard.js`（ユーザー専用の Fable スイッチを shell 書き込みから保護） / `relay-required-agent.js`（外部モデル連携がOFFのときに起動をブロック。native Fable は対象外） / `block-review-floor.js`（planner/reviewer の権威モデルを native fable | opus に限定） / `block-fable-when-off.js`（CLAUDE.md §1.11: `.claude/.fable-status` が ON でない限り、role を問わず model: fable での起動を拒否） / `clover-auto-install.js`（clover ラッパーの自動設置）
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

- **Codex native surface**（ローカル検証）:
  ```bash
  node .codex/scripts/check-native.mjs
  ```
- **Codex native hookの確認**: hook設定を変えたときは `/hooks` で確認・信頼してtaskを再開始またはreloadし、`codex --strict-config doctor --summary` も実行する。これはnative checkの代わりにはならない。
- **Claude Codeの構成整合性検査**: `node .claude/scripts/validate.mjs` — Claude hooks・記録配線・規範文言の消失検知などを検査する。`VERDICT: PASS` が正常
- **フックの全テストを1コマンドで実行**（手動実行。上記の整合性検査には配線されていない）:
  ```bash
  node --test ".claude/hooks/lib/*.test.js" ".claude/scripts/*.test.mjs"
  ```
  件数・set別件数・skip 条件は `hook-probes.test.js` が固定値として検査します。ブランチや OS で skip が変わるため、最新の pass/fail/skip はこのコマンドの出力を正として扱い、README に実測値を固定しません。
- **clover の全テスト**（clover は自己完結のサブプロジェクトなので別コマンド）:
  ```bash
  RELAY_ROUTER_NO_LISTEN=1 RELAY_SHIM_NO_LISTEN=1 node --test clover/test/*.test.mjs
  ```
