# clover

メインの会話は Claude のまま、**配下の特定の worker（サブエージェント）だけ**を
外部モデル（GPT 系など）に振り分ける中継。

## 起動

```bash
bash clover/bin/clover
```

中継経由で Claude Code が立ち上がる。ウィンドウを閉じる／Ctrl-C で終了すると、
中継（router・shim）も一緒に止まる。

## claude と打つだけで使う（推奨）

毎回 `bash bin/clover` と打たなくても、いつもどおり `claude` と打つだけで
中継経由の Claude Code が起動するようにできる。シェルの `claude` コマンドを、
「中継を自動で立ち上げてから本物の claude を起動する」ラッパー関数に差し替える方式。

**仕組み:** Node のランチャー（`bin/clover-launch.mjs`）がやるのは中継（router/shim）を
立ち上げて、繋がった場合の接続先 URL を1行返すことだけ。**claude 本体はこの Node が起動する
のではなく、シェル関数自身がネイティブに起動する**（PowerShell の `&` 演算子／bash の
`command claude`）。そのため **claude 本体はあなたのシェルが起動するので、引数は普段どおり
（ラッパーによる分割・エスケープの差異なし）** — スペースや `&` を含む引数も、ラッパーを
経由しない時とまったく同じに扱われる。

**自動インストール:** このリポジトリで `claude` セッションを開くだけで、SessionStart フック
（`clover-auto-install.js`）が `install.mjs --auto` を裏で呼び、未インストールなら自動で
プロファイルへ入る（新しいシェルから有効）。既に入っている場合は何もしない。無効化したい場合は
`node clover/bin/install.mjs --uninstall` を実行すると、削除と同時に自動設置も止まる
（`.no-auto-install` 印が作られる）。手動で `install.mjs` を再実行すればまた自動設置が有効になる。

**設定手順（手動で入れたい場合・1回だけ）:**

- **Windows（PowerShell）**: `node clover/bin/install.mjs` を実行するだけでよい。
  自分のクローン先の絶対パスを自動検出し、PowerShell プロファイル（`$PROFILE`）に管理ブロックとして
  書き込み、書き込み後に構文チェックまで自動で行う（手で `<REPO>` を置換する手順は事故りやすい
  ため非推奨。バックスラッシュが1つ抜けるだけでパスが壊れる、といった事故が実際に起きている）。
  再実行しても安全（既存の管理ブロックを冪等に更新する）。外したい場合は
  `node clover/bin/install.mjs --uninstall`。
  クローン先のディレクトリを移動した場合も、再実行すれば新しいパスに更新される。
  - fallback（手動）: `bin/clover-claude.ps1.snippet` の中身を、自分の PowerShell
    プロファイル（`$PROFILE`）に追記する。`<REPO>` の部分は自分のクローン先の絶対パスに置き換える
    （このリポジトリなら `D:\my-claude-base`）。
- **Linux / mac（bash・zsh）**: `node clover/bin/install.mjs` を実行するだけでよい。
  自分のクローン先の絶対パスを自動検出し、使っているシェル（`$SHELL` から bash/zsh を判定）に合わせて
  `~/.bashrc` または `~/.zshrc` に管理ブロックとして書き込み、書き込み後に構文チェック（`bash -n`）まで
  自動で行う。再実行しても安全（既存の管理ブロックを冪等に更新する）。外したい場合は
  `node clover/bin/install.mjs --uninstall`。クローン先のディレクトリを移動した場合も、
  再実行すれば新しいパスに更新される。シェルを再起動するか `source ~/.bashrc`（zsh なら
  `source ~/.zshrc`）すれば反映される。
  - fallback（手動）: `bin/clover-claude.bash.snippet` の中身を、`~/.bashrc` または `~/.zshrc` に
    追記する。`<REPO>` は自分のクローン先の絶対パスに置き換える。

どちらもシェルを再起動（新しいウィンドウを開く）すれば反映される。以後 `claude` と打つと、
中継が自動起動し、`/model` に models.json の先頭モデルが「〈モデル名〉 (clover)」の形で1件出るようになる（カスタムモデル
としての表示。仕組みと、2件目以降のモデルの使い方は「`/model` からの直接利用」節を参照）。

**安全性:** 中継の起動に失敗しても（ポート競合など）、`claude` は普通の Claude としてそのまま
起動する（フォールバック）。GPT には切り替えられないが、動作が壊れることはない。

**本物の claude を直接使いたい時の逃げ道:**
bash/zsh は `command claude --version` でラッパー関数をバイパスできる。PowerShell は
実行ファイルが複数出る構成があるため 1 つに絞って呼ぶ（詳細は
`bin/clover-claude.ps1.snippet` 末尾のコメント参照）。

**中継を止めたい時:** `bash clover/bin/relay-serve stop`（router・shim を停止する）。

上記スニペット追記はこのリポジトリ内の `bin/clover`（bash・使い捨て向き、claude 終了と
同時に中継も終わる）とは別経路。用途に応じて使い分ける: 毎回立ち上げっぱなしにしたいなら
`claude` ラッパー、1セッションだけ試したいなら `bin/clover`。

## 使い方

- マーカーを付けなければ、そのまま Claude が応答する（ふだんの Claude Code と同じ）。
- worker を外部モデルで動かすときは、その worker を spawn する prompt の**先頭行**に
  マーカーを1本だけ置く:

  ```
  RELAY-MODEL: <alias>   # models.json のキー
  （2行目以降に、いつもどおり役割・依頼を書く）
  ```

呼び分けルールの詳しい仕様は [relay スキル](../skills/relay/SKILL.md) が正本。

relay 経路で外部モデルに渡るのはテキストと tool 呼び出しのみ。OpenAI 形式（format: openai）のモデルでは、画像・文書ブロックは
`[image omitted by relay]` / `[document omitted by relay]` に置換される。

## 使えるモデル

登録済みモデル（別名＝マーカーのキー）は `models.json` を直接参照。

codex 経由（`via: codex`）のモデルを使うには先に `codex login` が要る（未ログインでもマーカー無しの Claude 素通しは動く）。
モデルを増やすときは `models.json` に1行足す（書式は relay スキル参照）。
`models.json` はリクエストのたびに読み直すので、追記しても再起動は不要。
alias は `opus`/`sonnet`/`haiku`/`fable` で始めない。始めると `claude-<alias>` の id が本物の Claude
モデル（例: `claude-opus-4-8`）をハイジャックしてしまうため、`src/router.mjs` の `loadModels` が
読み込み時に該当エントリをスキップする（fail-safe。`models.json` に紛れ込んでも取り込まれない）。

## /model からの直接利用

worker への marker 経由の振り分けとは別に、**メインの会話ごと** GPT モデルへ切り替える経路もある。

`/model` ピッカーには **models.json の先頭モデル1件だけ**が「カスタムモデル」として出る
（`ANTHROPIC_CUSTOM_MODEL_OPTION`、`bin/clover-launch.mjs` が設定）。複数モデルを一覧に自動で
並べる公式機能（gateway discovery、`GET /v1/models` を叩いて全件表示する）は **API キー /
`ANTHROPIC_AUTH_TOKEN` 認証が前提**で、サブスク（Claude Max 等）の OAuth ログインでは discovery
自体が発火しない（実測済み）。clover のラッパーはサブスク認証をそのまま使う設計のため、この経路は
使えない — 起きない挙動を前提にしない。

2件目以降のモデルを使うには、`/model claude-<alias>`（`<alias>` は models.json の2件目以降のキー）や
`claude --model claude-<alias>` の起動オプション、`ANTHROPIC_MODEL=claude-<alias>` の環境変数で
明示的に指定する。router 側は alias の完全一致で解決するので、discovery や `/model` の一覧に
出ていなくても動く。

- ピッカーから選ぶ（または上記の直接指定）と、メインの会話と、モデル指定を継承する worker
  （frontmatter に `model:` を固定していない worker）がそのモデルへ切り替わる。`planner`/`reviewer`
  など frontmatter で tier を固定している agent は `claude-*` を送り続けるため、素通しのまま変わらない。
- id は必ず `claude-` + alias の形。Claude Code は `claude`/`anthropic` で
  始まらない id を無視する仕様のため、この接頭辞は必須。
  - この接頭辞のせいで、router の `GET /v1/models` 応答は id の形だけでは本物の Anthropic API
    （同じく `claude-*` を返す）と区別が付かない。そのため応答 JSON には識別用のトップレベル項目
    `x_clover_relay: true` を必ず含めている。これは `bin/clover-launch.mjs` の `pingRouter` が
    「本物の clover router か」を確認するためのマーカーで、これが無い（または `false` の）応答は
    本物の Anthropic とみなしてルーティングを諦める（フォールバック）。Claude Code 本体は
    `data[]`/`first_id`/`last_id` しか見ないため、この項目があっても discovery の動作には影響しない。
- この経路は worker 用のマーカー(`RELAY-MODEL:`)とは独立しており、優先順位は「マーカー > `/model`
  で選んだモデル欄 > 通常の Claude モデル（素通し）」。GPT をメインに選んでいても、`RELAY-MODEL:`
  マーカー付きで spawn した worker は従来どおりそのマーカーのモデルに飛ぶ。

## トークンの自動更新

codex 経由（GPT 系など）の認証は `~/.codex/auth.json` の OAuth トークンを使う。

- 初回は `codex login` でログインする。
- 以後、shim(8791)がリクエスト前にトークンの有効期限が近い（残り5分未満）場合や、上流から 401 が返ってきた場合に `refresh_token` を使って自動的に再取得し、`auth.json` に書き戻す。
- `auth.json` は codex CLI 本体と共有しているため、書き戻しは codex CLI 側の認証を壊さないよう同じファイルに対して行う（refresh_token がローテートされることがあるため）。
- 手動で `codex` を都度実行してログインし直す必要は基本的にない。`refresh_token` 自体が失効した場合のみ、再度 `codex login` が必要になる。

## 常駐経路

`bin/clover` の他に、`bash clover/bin/relay-serve start|stop`（`/relay on|off` が内部で呼ぶ）で
router・shim をセッションと独立したバックグラウンドとして常駐させる経路もある。
`src/` 配下のコードを変更した場合は、どちらの経路で立てていても再起動が要る。

## `claude` ラッパー経路の寿命管理

`claude` ラッパー（`clover-claude.*.snippet`）経由で起動したセッションは、`run/sessions/` 配下に
自分の登録ファイルを1つ作る（中身は起動元シェルの PID）。セッション終了時にラッパーがこの
登録ファイルを削除し、中継へ即時停止をリクエストする。他にも生きている登録（別タブなど）が
残っていれば中継は停止を拒否し、生き続ける。この即時通知に失敗しても保険として、中継自身の
アイドルタイマー（`RELAY_IDLE_MS`、既定10分）が定期的に登録を掃除し、空なら自動終了する。
`relay-serve`（常駐経路）は `RELAY_IDLE_MS` を設定しないため、このアイドル終了の対象にならない。

## ポート

| プロセス | ポート | 役割 |
|---|---|---|
| router | 8788 | 入口。マーカーで振り分け／無印は Claude へ素通し |
| shim | 8791 | codex 経由のモデルを使うときの変換層（codex の認証を付ける） |
