#!/usr/bin/env node
// PostToolUse hook (matcher: Task|Agent): CLAUDE.md §1.12 Deliberation Gate — an opportunistic
// reminder for the conductor when a delegated worker's report reads error-ish. Nudge only, never
// enforcement (PostToolUse cannot deny a tool call); fires only for TOP-LEVEL foreground dispatches
// (agent_type absent) — nested delegation is covered by the rule layer (§1.12 itself), not this
// hook (ruling R-1, plans/conductor-deliberation/PLAN.md).
//
// Fail-open, unconditionally: JSON.parse has its own catch (unparseable stdin -> exit 0); the rest
// of the logic runs inside a second try/catch (any failure after a successful parse -> exit 0,
// emit nothing).
//
// Threat model: the report text read here is untrusted subagent output. The only string this hook
// can ever emit is INJECTED_TEXT below — a module-level constant. No payload-derived value
// (report text, prompt, description, agent name) is EVER interpolated, so a worker's report
// cannot steer what lands in the conductor's context (Z5).
//
// A8 disclosure (required verbatim on every face — CLAUDE.md §1.12, README.md, and here):
// ルールは委任した側すべてを縛る。フックが後押しするのは最上位の同期実行だけ（実測で全委任の約30%が同期、うち約75%が最上位、報告の16%が該当 → 全委任の
// およそ4%弱でしか出ない）。フックが出なかったことは「問題なし」の意味ではない。
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
// interpolated here; see the threat-model comment above.
const INJECTED_TEXT =
  '[熟考] 返ってきた報告に「うまくいかなかった / 回避した」気配があります。提案は診断ではなく仮説として扱ってください。\n' +
  '選べる対応: ①根本原因の証拠（ログ・再現手順・差分）が示されていれば受け入れる ②示されていなければ原因究明をやり直させる ③debugger に投げ直す ④前提そのものが崩れているなら計画に戻す。\n' +
  '症状だけを消す修正（削除・抑制・条件のゆるめ・握りつぶし）を受け入れてよいのは、却下した代替案とその理由が書かれている場合だけです。\n' +
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
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
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
  // Guard 1 (B8): the unanchored PostToolUse matcher also matches TaskCreate/TaskGet/TaskList/
  // TaskStop/TaskUpdate — only the exact dispatch tools are in scope.
  if (payload.tool_name !== 'Task' && payload.tool_name !== 'Agent') return;
  // Guard 2 (R-1/F5): agent_type present means a worker dispatched this — top-level only.
  if (payload.agent_type) return;
  // Guard 3: no extractable content is also the F2 background-stub launch-stub path. Readability
  // short-circuit only — empty/whitespace-only text falls through to the regex test below and
  // simply never matches, so this guard has no mutation pair of its own (Not covered, PLAN.md).
  const text = extractText(payload);
  if (!text) return;

  const sliced = text.slice(0, 64 * 1024);
  const stripped = stripQuoted(sliced);

  let family = null;
  if (P_RE.test(stripped)) family = 'P';
  else if (S_RE.test(stripped)) family = 'S';
  if (!family) return;

  const root = projectRoot(payload);
  appendLine(root, `- ${stamp()} [${id8(payload)}] [deliberation] fired family=${family}`);

  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: INJECTED_TEXT } }));
}

module.exports = { INJECTED_TEXT };
