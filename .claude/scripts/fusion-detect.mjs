import { readFileSync } from "node:fs";

const env = process.env;

function parseEnvInt(key, fallback) {
  const v = parseInt(env[key], 10);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

export const FUSION_MAX_REVISIT_ROUNDS = parseEnvInt("FUSION_MAX_REVISIT_ROUNDS", 1);
export const FUSION_MAX_UNRESOLVED_PER_SESSION = parseEnvInt("FUSION_MAX_UNRESOLVED_PER_SESSION", 3);
export const FUSION_MAX_UNRESOLVED_CUMULATIVE = parseEnvInt("FUSION_MAX_UNRESOLVED_CUMULATIVE", 2);

const INDECISIVE_PATTERNS = [
  "いずれとも言えない",
  "trade-off",
  "トレードオフ",
  "条件次第",
  "場合による",
  "どちらとも",
];

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

export function detectSplit(judgeJson) {
  if (!judgeJson || typeof judgeJson !== "object" || Array.isArray(judgeJson)) {
    return { split: false, reasons: ["invalid-input"] };
  }
  if (typeof judgeJson.error === "string") {
    return { split: false, reasons: ["judge-error"] };
  }

  const contradictions = safeArray(judgeJson.contradictions);
  const consensus = safeArray(judgeJson.consensus);
  const unique = safeArray(judgeJson.unique);
  const partial = safeArray(judgeJson.partial_coverage);
  const recommendation = typeof judgeJson.recommendation === "string" ? judgeJson.recommendation : "";

  const reasons = [];

  if (contradictions.length >= 1) {
    reasons.push("contradictions>=1");
  }

  if (consensus.length === 0) {
    reasons.push("consensus==0");
  } else if (unique.length >= 2 * (consensus.length + partial.length)) {
    reasons.push("unique>=2*(consensus+partial)");
  }

  if (INDECISIVE_PATTERNS.some((p) => recommendation.includes(p))) {
    reasons.push("recommendation-indecisive");
  }

  return { split: reasons.length > 0, reasons };
}

export function detectCollapse(judgeJson) {
  if (!judgeJson || typeof judgeJson !== "object" || Array.isArray(judgeJson)) {
    return { weak: false, reason: null };
  }

  const consensus = safeArray(judgeJson.consensus);
  const unique = safeArray(judgeJson.unique);
  const partial = safeArray(judgeJson.partial_coverage);

  if (unique.length === 0 && partial.length === 0 && consensus.length >= 1) {
    return { weak: true, reason: "unique==0 && partial==0 with consensus present" };
  }
  return { weak: false, reason: null };
}

export function shouldRevisit({ split, revisitCount, unresolvedCumulative, rateLimited }) {
  return (
    split === true &&
    revisitCount < FUSION_MAX_REVISIT_ROUNDS &&
    unresolvedCumulative < FUSION_MAX_UNRESOLVED_CUMULATIVE &&
    !rateLimited
  );
}

export function unresolvedSessionCapped(count) {
  return count >= FUSION_MAX_UNRESOLVED_PER_SESSION;
}

export function cumulativeCapExceeded(count) {
  return count >= FUSION_MAX_UNRESOLVED_CUMULATIVE;
}

export function worstCaseInferences(n, revisit = FUSION_MAX_REVISIT_ROUNDS) {
  return (n + 1) * (1 + revisit);
}

export function rateLimitStop(httpStatus) {
  return httpStatus === 429;
}

if (process.argv[1] && process.argv[1].endsWith("fusion-detect.mjs")) {
  let raw;
  try {
    if (process.argv[2]) {
      raw = readFileSync(process.argv[2], "utf8");
    } else {
      raw = readFileSync(0, "utf8");
    }
    const judgeJson = JSON.parse(raw);
    const { split, reasons } = detectSplit(judgeJson);
    const { weak } = detectCollapse(judgeJson);
    process.stdout.write(JSON.stringify({ split, splitReasons: reasons, collapse: weak }) + "\n");
  } catch (e) {
    process.stderr.write("parse error: " + e.message + "\n");
    process.exit(1);
  }
}
