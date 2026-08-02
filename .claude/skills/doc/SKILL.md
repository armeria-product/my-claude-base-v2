---
name: doc
description: >
  ユーザーが読む資料・ドキュメントを作る入口。レポート・調査/分析結果・ガイド・比較表・サマリを、
  CLAUDE.md §10 準拠の自己完結HTML（CSSインライン・外部依存ゼロ・オフラインで開ける単一ファイル）として
  document-author に作らせ、必要なら HTML→PDF まで変換する。スライド / プレゼン資料は deck フロー
  （自己完結スライドHTML、要求時に編集可能な PPTX へ変換）で作る。「資料を作って」「ドキュメント化して」
  「HTMLでまとめて」「PDFにして」「スライドにして」「pptxにして」で発動。
  内部作業ファイル（todo / plan / コミット等）は対象外（Markdown のまま）。
user-invocable: true
---

# Doc — 資料/ドキュメント作成ワークフロー

ユーザーが**読むための成果物**を、§10 準拠の自己完結HTMLとして作る。HTML が正本、PDF は派生。

## 対象の判定
- **対象**: ユーザーが開いて読む資料（レポート / 調査・分析結果 / ガイド / 解説 / 比較表 / サマリ）。
- **スライド / プレゼン / デッキ資料** → 下の **deck フロー**（起点テンプレは `template/doc.pptx.template.html`）。
- **対象外（Markdown のまま）**: `tasks/`・`plans/`・`.claude/` 配下・コミットメッセージ等の内部作業ファイル（§10 Scope）。これらは doc を使わない。

## 手順
1. **委任** — `document-author`（standard）に dispatch し、自己完結HTMLの**生成・自己検証・ブラウザ表示**まで行わせる（producer が所有：構造・print CSS・日本語フォント・表/コールアウト・アクセシビリティ）。起点テンプレは **`template/doc.template.html`**（このスキルと同じ場所・部品一式＋インラインSVG図つき）。保存先は作業に即した場所（dev mode → `dev/{name}/` 配下、§0）。
2. **自己完結ゲート** — `check` skill が HTML 成果物の自己完結を**独立に検証**（producer の自己チェックとは別の関門、§1.3）。判定は「ネット取得ゼロ」の許可リスト方式＝**インラインの `<script>` は可**・remote 参照（http(s)/`//host`）が1つでもあれば FAIL。引っかかれば document-author に差し戻し。
3. **PDF（要求時のみ）** — ユーザーが PDF を求めたら `node .claude/scripts/html2pdf.mjs <in.html> <out.pdf>`（出力は **入力と同じディレクトリ・同じ basename の `.pdf`**）。WeasyPrint 未導入なら**スキップして導入手順を案内**（HTML は残る）。導入手順は [docs/weasyprint-setup.html](../../../docs/weasyprint-setup.html)。

## 手順（deck フロー — スライド / プレゼン資料）

デッキも HTML が正本。成果物は自己完結の `<name>.deck.html`（ダブルクリックでオフライン再生できるスライドビューア）、編集用ソースは `<name>.slides.html`（`<section>` 1個 = スライド1枚、1920×1080）。

1. **委任** — `document-author`（deck mode）に dispatch する。種の取り出し（`deckpack --extract`）・sections の編集・バンドル化（`deckpack --pack`）は agent が deck mode の手順として自分で実行する（agent 定義の deck mode 節が SOT）。conductor 側はこの3つのコマンドを自分では叩かない。
2. **自己完結ゲート** — packed `.deck.html` に既存の自己完結 lint をそのまま適用（pack がテンプレ由来の preconnect を除去済みなので、hit したら本物の混入）。
3. **PPTX（要求時のみ）** — ユーザーが pptx を求めたら `node .claude/scripts/html2pptx.mjs <name>.deck.html <name>.pptx`。文字・図形は PowerPoint のネイティブ部品として出る（編集可）。HTML プレビューも PPTX も同じ游書体系（游ゴシック / 游明朝）で表示されるため見た目はほぼ一致する。**fail-LOUD**（PDF と逆）: 依存未導入・ブラウザ未検出なら止まって案内を出す — セットアップは `cd .claude/scripts && npm install`（＋ Edge か Chrome が必要）。

## 原則
- HTML が正本。PDF / PPTX を直接手書きしない。
- 既定は **HTML のみ**。PDF / PPTX は明示要求時に生成（毎回は作らない）。
- 中身は conclusion-first・簡潔（§6.3）。形式は §10。チャット返信自体はターミナル Markdown のまま（§10 はファイルの形式の話）。
