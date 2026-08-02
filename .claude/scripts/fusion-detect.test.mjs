import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FUSION_MAX_REVISIT_ROUNDS,
  FUSION_MAX_UNRESOLVED_PER_SESSION,
  FUSION_MAX_UNRESOLVED_CUMULATIVE,
  detectSplit,
  detectCollapse,
  shouldRevisit,
  unresolvedSessionCapped,
  cumulativeCapExceeded,
  worstCaseInferences,
  rateLimitStop,
} from "./fusion-detect.mjs";

test("detectSplit: contradictions >= 1 -> split=true", () => {
  const result = detectSplit({
    contradictions: [{ point: "x", A: "a", B: "b" }],
    consensus: ["c"],
    unique: [],
    recommendation: "",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("contradictions>=1"));
});

test("detectSplit: consensus.length == 0 -> split=true", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: [],
    unique: ["u1"],
    recommendation: "",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("consensus==0"));
});

test("detectSplit: all consensus no contradictions -> split=false", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["a", "b", "c"],
    unique: ["x"],
    recommendation: "",
  });
  assert.equal(result.split, false);
});

test("detectSplit: unique >= 2*consensus -> split=true", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["c1"],
    unique: ["u1", "u2"],
    recommendation: "",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("unique>=2*(consensus+partial)"));
});

test("detectSplit: recommendation contains indecisive pattern -> split=true", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["c1", "c2"],
    unique: [],
    recommendation: "これはトレードオフが伴う",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("recommendation-indecisive"));
});

test("detectSplit: recommendation contains 'いずれとも言えない' -> split=true", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["c1", "c2"],
    unique: [],
    recommendation: "いずれとも言えない状況です",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("recommendation-indecisive"));
});

test("detectSplit: null input -> split=false, no throw", () => {
  assert.doesNotThrow(() => {
    const result = detectSplit(null);
    assert.equal(result.split, false);
  });
});

test("detectSplit: array input -> split=false, no throw", () => {
  assert.doesNotThrow(() => {
    const result = detectSplit([]);
    assert.equal(result.split, false);
  });
});

test("detectSplit: {error:'x'} -> split=false, no throw", () => {
  assert.doesNotThrow(() => {
    const result = detectSplit({ error: "x" });
    assert.equal(result.split, false);
    assert.ok(result.reasons.includes("judge-error"));
  });
});

test("detectSplit: unique=2 consensus=1 partial=0 -> split=true (boundary)", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["c1"],
    unique: ["u1", "u2"],
    partial_coverage: [],
    recommendation: "",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("unique>=2*(consensus+partial)"));
});

test("detectSplit: unique=2 consensus=1 partial=1 -> split=false (boundary)", () => {
  const result = detectSplit({
    contradictions: [],
    consensus: ["c1"],
    unique: ["u1", "u2"],
    partial_coverage: [{ sources: ["A", "B"], point: "p1" }],
    recommendation: "",
  });
  assert.equal(result.split, false);
});

test("detectCollapse: consensus>=1 unique=0 partial>=1 -> weak=false", () => {
  const result = detectCollapse({
    consensus: ["a"],
    unique: [],
    partial_coverage: [{ sources: ["A", "B"], point: "p1" }],
  });
  assert.equal(result.weak, false);
});

test("detectCollapse: consensus>=1 unique=0 partial=0 -> weak=true (unchanged)", () => {
  const result = detectCollapse({
    consensus: ["a"],
    unique: [],
    partial_coverage: [],
  });
  assert.equal(result.weak, true);
});

test("detectSplit/detectCollapse: partial_coverage missing -> same verdict as before", () => {
  const input = {
    contradictions: [],
    consensus: ["c1"],
    unique: ["u1", "u2"],
    recommendation: "",
  };
  const split = detectSplit(input);
  assert.equal(split.split, true);
  assert.ok(split.reasons.includes("unique>=2*(consensus+partial)"));

  const collapse = detectCollapse({ consensus: ["a"], unique: [] });
  assert.equal(collapse.weak, true);
});

test("detectCollapse: consensus present unique empty -> weak=true", () => {
  const result = detectCollapse({
    consensus: ["a", "b", "c"],
    unique: [],
  });
  assert.equal(result.weak, true);
});

test("detectCollapse: consensus and unique both present -> weak=false", () => {
  const result = detectCollapse({
    consensus: ["a", "b"],
    unique: ["u1"],
  });
  assert.equal(result.weak, false);
});

test("detectCollapse: null input -> no throw", () => {
  assert.doesNotThrow(() => {
    const result = detectCollapse(null);
    assert.equal(result.weak, false);
  });
});

test("shouldRevisit: split=true revisitCount=0 cumulative=0 rateLimited=false -> true", () => {
  const result = shouldRevisit({
    split: true,
    revisitCount: 0,
    unresolvedCumulative: 0,
    rateLimited: false,
  });
  assert.equal(result, true);
});

test("shouldRevisit: revisitCount at limit -> false", () => {
  const result = shouldRevisit({
    split: true,
    revisitCount: FUSION_MAX_REVISIT_ROUNDS,
    unresolvedCumulative: 0,
    rateLimited: false,
  });
  assert.equal(result, false);
});

test("shouldRevisit: rateLimited=true -> false", () => {
  const result = shouldRevisit({
    split: true,
    revisitCount: 0,
    unresolvedCumulative: 0,
    rateLimited: true,
  });
  assert.equal(result, false);
});

test("shouldRevisit: unresolvedCumulative at limit -> false", () => {
  const result = shouldRevisit({
    split: true,
    revisitCount: 0,
    unresolvedCumulative: FUSION_MAX_UNRESOLVED_CUMULATIVE,
    rateLimited: false,
  });
  assert.equal(result, false);
});

test("cumulativeCapExceeded: count >= FUSION_MAX_UNRESOLVED_CUMULATIVE -> true", () => {
  assert.equal(cumulativeCapExceeded(FUSION_MAX_UNRESOLVED_CUMULATIVE), true);
});

test("cumulativeCapExceeded: count < FUSION_MAX_UNRESOLVED_CUMULATIVE -> false", () => {
  assert.equal(cumulativeCapExceeded(FUSION_MAX_UNRESOLVED_CUMULATIVE - 1), false);
});

test("unresolvedSessionCapped: count >= FUSION_MAX_UNRESOLVED_PER_SESSION -> true", () => {
  assert.equal(unresolvedSessionCapped(FUSION_MAX_UNRESOLVED_PER_SESSION), true);
});

test("unresolvedSessionCapped: count < FUSION_MAX_UNRESOLVED_PER_SESSION -> false", () => {
  assert.equal(unresolvedSessionCapped(FUSION_MAX_UNRESOLVED_PER_SESSION - 1), false);
});

test("rateLimitStop: 429 -> true", () => {
  assert.equal(rateLimitStop(429), true);
});

test("rateLimitStop: 200 -> false", () => {
  assert.equal(rateLimitStop(200), false);
});

test("worstCaseInferences: n=3 revisit=1 -> 8", () => {
  assert.equal(worstCaseInferences(3, 1), 8);
});

test("worstCaseInferences: n=2 revisit=1 -> 6", () => {
  assert.equal(worstCaseInferences(2, 1), 6);
});

test("detectSplit: consensus==0 despite partial_coverage -> split=true (boundary)", () => {
  const result = detectSplit({
    consensus: [],
    unique: ["a", "b"],
    partial_coverage: ["p"],
    contradictions: [],
    recommendation: "採用",
  });
  assert.equal(result.split, true);
  assert.ok(result.reasons.includes("consensus==0"));
});
