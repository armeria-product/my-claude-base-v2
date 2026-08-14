#!/usr/bin/env node
// PostToolUse hook (matcher: ^(Task|Agent)$, anchored — U12): CLAUDE.md §1.12 Deliberation Gate — an opportunistic
// reminder for the conductor when a delegated worker's report reads error-ish. Nudge only, never
// enforcement (PostToolUse cannot deny a tool call); fires only for TOP-LEVEL foreground dispatches
// (agent_type absent) — nested delegation is covered by the rule layer (§1.12 itself), not this
// hook (ruling R-1, plans/conductor-deliberation/PLAN.md).
//
// Fail-open, unconditionally, ONCE THIS MODULE HAS LOADED: JSON.parse has its own catch
// (unparseable stdin -> exit 0); the rest of the logic runs inside a second try/catch (any
// failure after a successful parse -> exit 0, emit nothing). Scoped exception (disclosed, not
// fixed): a require() failure at module load time — this file failing to parse, or
// ./lib/journal-util throwing during its own top-level evaluation — happens BEFORE either
// try/catch exists and crashes the process with a non-zero exit instead of the usual fail-open
// exit 0. Neither validate.mjs check below covers this residual: the wiring check only verifies
// settings.json registration, not that require() of this file's dependencies actually succeeds.
//
// Threat model: the report text read here is untrusted subagent output. The only string this hook
// can ever emit into the CONDUCTOR'S CONTEXT is INJECTED_TEXT below — a module-level constant.
// No payload-derived value (report text, prompt, description, agent name) is EVER interpolated
// into that emission, so a worker's report cannot steer what lands in the conductor's context
// (Z5). Scoped exception: id8() DOES interpolate a CLI-generated slice of payload.session_id into
// the JOURNAL line only (never into the conductor's context) — a pre-existing repo-wide class
// (P7), not new here, and an unsanitized session_id could in principle forge an extra journal row.
//
// A8 disclosure (required verbatim on every face — CLAUDE.md §1.12, README.md, and here):
// ルールは委任した側すべてを縛る。フックが後押しするのは最上位の同期実行だけ（実測で全委任の約30%が同期、うち約75%が最上位、報告の16%が該当 → 全委任の
// およそ4%弱でしか出ない）。フックが出なかったことは「問題なし」の意味ではない。
//
// Accepted false NEGATIVES (recall gaps, disclosed alongside the false positives below — this
// list is not exhaustive; see PLAN.md Not covered): (a) fenced/quoted invisibility — P/S stems
// are stripped from fenced ```code``` blocks and 「…」/"…" quoted spans before matching, so
// distress text ONLY inside one of those is silent by design, INCLUDING a worker quoting its OWN
// workaround in 「…」 — the same text unquoted would fire. (b) a CONFORMING report whose required
// error shape (executor.md's 5-field block) is presented inside a ``` fence goes silent, while
// identical content unfenced fires — Phase 1's producer contract and Phase 2's hook are in
// tension here; this is disclosure-only, not a code fix (X1 resolution, PLAN.md Not covered) —
// conforming AND fenced is the least-detected shape a report can take. (c) all P/S stems were
// validated against this machine's real corpus, which is mostly Japanese; the English-language
// stems were added by inspection, not separately recall-measured — English-only recall is
// unverified, not assumed equal to the measured Japanese-corpus numbers below.
//
// Accepted false positives (F12 — kept, not "fixed": narrowing further would also cut recall on an
// already-low-recall nudge): (a) mutation narration ("commented out X -> RED"), 3 of 7 measured
// FPs; (b) this plan's own P/S vocabulary quoted outside quote marks, 3 of 7; (c) a lesson/finding
// table describing another system's behavior, 1 of 7.

const { stamp, id8, projectRoot, appendLine } = require('./lib/journal-util');

// P/S families copied byte-identical from plans/conductor-deliberation/PLAN.md's verbatim block
// (T2.1/V12) — plans/ is gitignored, so this file and the pasted block in the PR are the only
// durable copies. Each array is joined with "|" into one case-insensitive regex; entries with
// regex metacharacters (?, [], parentheses) are intentional, not literal punctuation.

// P — unresolved problem / self-authorized change of approach
const P_STEMS = [
  'できなかった', 'できませんでした', 'できません', '解決できず', '解決できませんでした',
  '修正できず', '直せず', '特定できず', '判明せず', '分かりませんでした', '原因は?不明', '原因が分から',
  '回避策', '回避しました', '迂回', '暫定', '一時的に', '方針を変', '別のアプローチ', '別の方法',
  '断念', '諦め', '見送',
  'as a workaround', 'worked around', 'work around it', 'gave up',
  "could ?n[o']t (resolve|fix|figure|reproduce|determine)", // bare "find" deliberately excluded — see F12
  'unable to (resolve|fix|determine|reproduce)', 'root cause (is )?unknown', 'had to change approach',
];

// S — symptom-fix markers named by [R1]: delete / suppress / loosen / catch-and-ignore
const S_STEMS = [
  'コメントアウト', 'スキップし', '除外し', '外しました', '外して通', '緩め', '無効化', '一時的に無効',
  '握りつぶ', 'any にし',
  'commented out', 'temporarily disabled',
  'skipp?ed .{0,14}(test|check|assert)', 'disabl(ed|ing) .{0,14}(test|check|assert)',
  'relaxed .{0,14}(check|condition|assert)', 'swallow(ed|ing) the (error|exception)',
  'ignor(ed|ing) the (error|exception)', 'try/?catch.{0,24}ignor',
  'added a retry', 'リトライを(追加|入れ)',
];

const P_RE = new RegExp(P_STEMS.join('|'), 'i');
const S_RE = new RegExp(S_STEMS.join('|'), 'i');

// Injected checklist — module-level fixed constant (T2.1). No payload-derived value is ever
// interpolated here; see the threat-model comment above. Wording note (P6): line 3 deliberately
// says "もみ消し", not "握りつぶし" — 握りつぶ is itself an S_STEMS entry, so the original wording
// let a report that quoted this checklist back (e.g. explaining what the gate told it) re-fire
// the gate on its own text, a self-sustaining loop that contaminated the R-2 fire-rate journal.
// もみ消し carries the same meaning and matches no P_STEMS/S_STEMS entry.
const INJECTED_TEXT =
  '[熟考] 返ってきた報告に「うまくいかなかった / 回避した」気配があります。提案は診断ではなく仮説として扱ってください。\n' +
  '選べる対応: ①根本原因の証拠（ログ・再現手順・差分）が示されていれば受け入れる ②示されていなければ原因究明をやり直させる ③debugger に投げ直す ④前提そのものが崩れているなら計画に戻す。\n' +
  '症状だけを消す修正（削除・抑制・条件のゆるめ・もみ消し）を受け入れてよいのは、却下した代替案とその理由が書かれている場合だけです。\n' +
  'エラー・方針変更の報告であれば、その役割に定められた報告の形になっているか確認し、なっていなければ中身を検討する前に構造として差し戻してください。';

// tool_response.content[] only (F6/R-4) — never prompt/description/agent_type/a JSON.stringify of
// the payload. Skips malformed array elements instead of throwing (Z2); the bare-string
// tool_response shape is deliberately NOT supported (R-4/B5).
function extractText(payload) {
  const tr = payload.tool_response;
  if (!tr) return '';
  const content = tr.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content) if (item && typeof item.text === 'string') out += item.text;
  return out;
}

// Fenced blocks, then inline `code`, then 「…」 / "…" spans (F12 quoted-context exclusion) — this
// order matters: stripping fences first keeps a fenced code sample from also being read as an
// inline-code/quote span.
function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/「[^」]*」/g, '')
    .replace(/"[^"]*"/g, '');
}

// Guarded by require.main so the test file can require() this module for INJECTED_TEXT alone
// (strict-equality no-echo assertions) without also attaching a live stdin listener in the test
// process — only a direct `node deliberation-gate.js` invocation (the real hook wiring) runs it.
if (require.main === module) {
  // Buffer.concat, not per-chunk string coercion (U15): `data += c` on a Buffer chunk coerces
  // that chunk to a string independently, which can split a multibyte UTF-8 character straddling
  // a chunk boundary and corrupt it (U+FFFD) before JSON.parse ever sees it. Collecting raw
  // Buffer chunks and decoding once, after concatenation, avoids that split.
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const data = Buffer.concat(chunks).toString('utf8');
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      process.exit(0); // fail-open: unparseable stdin
    }
    try {
      main(payload);
    } catch {
      // fail-open: any failure once payload has parsed emits nothing (Z2)
    }
    process.exit(0);
  });
}

function main(payload) {
  // Guard 1 (B8/U12): settings.json's PostToolUse matcher is anchored (^(Task|Agent)$) so
  // TaskCreate/TaskGet/TaskList/TaskStop/TaskUpdate no longer even spawn this process — this
  // check is now a belt-and-suspenders backstop, not the only line of defense, in case matcher
  // semantics ever change.
  if (payload.tool_name !== 'Task' && payload.tool_name !== 'Agent') return;
  // Guard 2 (R-1/F5/P3): presence, not truthiness, of agent_type means a worker dispatched this —
  // top-level only. Before this fix the check was `if (payload.agent_type) return;`, a truthiness
  // test: agent_type "" / null / 0 are present-but-falsy and slipped THROUGH that check, so a
  // nested dispatch carrying one of those values would wrongly FIRE conductor-menu text into a
  // worker context — the exact outcome R-1/B11/Z8 forbid. Two-direction disclosure: (a) if a
  // payload from a genuine top-level dispatch were ever observed carrying an agent_type key at
  // all (even falsy), this guard would now wrongly stay SILENT there instead — the fail-open
  // direction, consistent with the rest of the hook, but unverified beyond F5's one-day journal
  // sample; (b) the only dispatcher types actually observed on nested payloads are
  // {executor, planner} (F5) — an unobserved nested shape that omits the key entirely would still
  // wrongly fire. Neither direction has been exhaustively probed.
  if ('agent_type' in payload) return;
  // Guard 3: no extractable content is also the F2 background-stub launch-stub path. Readability
  // short-circuit only — empty/whitespace-only text falls through to the regex test below and
  // simply never matches, so this guard has no mutation pair of its own (Not covered, PLAN.md).
  const text = extractText(payload);
  if (!text) return;

  // Sliced to the first 65,536 UTF-16 code units — JS string .slice() counts code units, not
  // bytes, so this is NOT exactly "64 KB" of UTF-8 (an all-Japanese run this long is closer to
  // ~196 KB of UTF-8; U10/A.m6/B.L1).
  const sliced = text.slice(0, 64 * 1024);
  const stripped = stripQuoted(sliced);

  // R4i: test BOTH families independently, not P-then-else-if-S. The old else-if let a P match
  // short-circuit the S test, so a report matching both stems was always journaled as family=P,
  // silently discarding whether it also matched S and undercounting family=S in the R-2 data —
  // this superseded U13's weaker fix (just reordering P/S) because reordering alone would still
  // destroy whichever family loses the race.
  let family = '';
  if (P_RE.test(stripped)) family += 'P';
  if (S_RE.test(stripped)) family += 'S';
  if (!family) return;

  // N1: emit the nudge BEFORE the journal append, not after. appendLine() below can throw (e.g.
  // tasks/ pre-existing as a plain file instead of a directory — observed during manual smoke
  // testing of this hook against a non-sandboxed root). Before this fix, that throw propagated up
  // through the outer try/catch with nothing ever printed — a journal-write failure silently
  // swallowed the nudge itself, even though the report clearly read as distress. The outer
  // try/catch (around main(), in the stdin handler above) still guarantees fail-open either way;
  // this ordering only changes WHICH side effect survives when one of the two fails.
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: INJECTED_TEXT } }));

  const root = projectRoot(payload);
  appendLine(root, `- ${stamp()} [${id8(payload)}] [deliberation] fired family=${family}`);
}

module.exports = { INJECTED_TEXT };
