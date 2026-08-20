import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_BRANDKIT_PANELS,
  resolveBrandkitOutputPath,
  validateBrandkitPlan,
} from "../brandkit/scripts/validate-brandkit-plan.mjs";
import { resolveWebSectionCount, validateWebPlan } from "../imagegen-frontend-web/scripts/validate-web-plan.mjs";
import { validateMobilePlan } from "../imagegen-frontend-mobile/scripts/validate-mobile-plan.mjs";
import { validateFrontendDesignEvidence } from "../frontend-design/scripts/validate-evidence.mjs";
import { validateImageToCodeTrace } from "../image-to-code/scripts/validate-trace.mjs";
import { validateSelfContainedHtml } from "../doc/scripts/assert-self-contained.mjs";
import { validatePreviewEvidence } from "../preview/scripts/preview-lifecycle.mjs";
import { validateCleanerTrace } from "../code-cleaner/scripts/validate-cleaner-trace.mjs";
import { scanCommitSafety } from "../../../.codex/scripts/check-commit-safety.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const NEW_SKILLS = [
  "brandkit",
  "frontend-design",
  "imagegen-frontend-web",
  "imagegen-frontend-mobile",
  "image-to-code",
  "doc",
  "preview",
  "code-cleaner",
];
const WORKFLOWS = ["plan", "harness", "quality-loop", "check", "commit", "pr"];
const PARITY = [
  ...NEW_SKILLS.map((source) => ({ source, target: ".agents/skills/" + source })),
  { source: "plan", target: ".codex/workflows/plan.md" },
  { source: "harness", target: ".agents/skills/codex-harness/SKILL.md" },
  { source: "quality-loop", target: ".codex/workflows/quality-loop.md" },
  { source: "check", target: ".codex/workflows/check.md" },
  { source: "commit", target: ".codex/workflows/commit.md" },
  { source: "pr", target: ".codex/workflows/pr.md" },
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

function brandPlan() {
  return {
    kind: "brandkit",
    strategy: {
      category: "developer tool", audience: "platform engineers",
      productFunction: "coordinates build work", emotionalPromise: "calm precision",
      metaphor: "scaffold becoming signal", avoid: ["generic lightning bolts"],
    },
    layout: { grid: "3x3", aspectRatio: "4:3", panels: [...DEFAULT_BRANDKIT_PANELS] },
    system: {
      visualMode: "dark builder", palette: ["charcoal", "cyan", "coral"],
      logoConcept: "negative-space frame", typography: "grotesk with mono accents",
      imageTreatment: "restrained cinematic detail",
    },
    images: [{
      id: "overview", outputPath: resolveBrandkitOutputPath("Orbit Forge", "overview"),
      call: { tool: "imagegen", outputs: 1 }, prompt: "One premium brandkit overview.",
    }],
    codeOutput: false,
  };
}

function webPlan() {
  const specs = [
    ["hero", "Hook", "center", "full-bleed image"],
    ["trust", "Proof", "top-left", "technical grid"],
    ["features", "Educate", "off-grid", "editorial image"],
    ["showcase", "Demonstrate", "bottom-left", "duotone photo"],
    ["testimonials", "Reassure", "stacked center", "solid surface"],
    ["cta", "Convert", "bottom-right", "color block"],
  ];
  return {
    kind: "web-reference", requestedSections: 6,
    site: { name: "Orbit", type: "landing page", conversionGoal: "start", minimal: false },
    continuity: {
      palette: "ink fog cyan", typography: "grotesk mono", ctaFamily: "square actions",
      radiusLanguage: "small radius", imageTreatment: "editorial crops",
      tonalVoice: "calm confidence",
    },
    global: {
      heroScale: "editorial", narrativeSpine: "precision instrument", secondReadMoment: "note rail",
      signatureComponents: ["ui stack", "editorial layout", "metric strip", "crop frame"],
      motionCues: ["image drift", "fade through"],
    },
    sections: specs.map(([id, role, anchor, background], index) => ({
      id, name: id, role, anchor, background, cta: "action",
      prompt: "One horizontal section in the locked system.", format: "horizontal",
      outputPath: "assets/orbit/sections/" + String(index + 1).padStart(2, "0") + "-" + id + ".png",
      call: { tool: "imagegen", outputs: 1 },
    })),
    codeOutput: false,
  };
}

function mobilePlan() {
  const continuityKey = "lumen-ios-v1";
  const specs = [["welcome", "Welcome"], ["sign-in", "Sign in"], ["home", "Home"]];
  return {
    kind: "mobile-reference", platform: "ios-native",
    designBible: {
      deviceFrame: "iPhone", deviceScale: "medium", palette: "ink mist lime",
      typography: "system sans", spacing: "8 point", radius: "medium", iconography: "rounded",
      imagery: "wellness", texture: "grain", navigation: "tabs and stack",
      components: "cards and cells", buttons: "primary action", shadows: "soft",
    },
    continuityKey,
    presentation: { showDeviceFrame: true, frameStyle: "iPhone", contentPrimary: true },
    screens: specs.map(([id, name], index) => ({
      id, name, purpose: "complete " + id + " state", prompt: "One complete portrait screen.",
      continuityKey, format: "portrait", complete: true, croppedFrom: null,
      safeAreas: { top: true, bottom: true }, navigation: "continue through flow",
      outputPath: "assets/lumen/screens/" + String(index + 1).padStart(2, "0") + "-" + id + ".png",
      call: { tool: "imagegen", outputs: 1 },
    })),
    flow: { screenIds: specs.map(([id]) => id), rationale: "welcome to auth to home" },
    codeOutput: false,
  };
}

function frontendEvidence() {
  return {
    designRead: "Marketing landing for technical buyers.",
    dials: { variance: 6, motion: 4, density: 3 },
    discovery: {
      applicableAgents: ["AGENTS.md"], packageManifest: "package.json",
      commandsChecked: ["npm run build"],
    },
    systemMapping: {
      kind: "aesthetic", name: "Existing Tailwind", decision: "Product already uses it.",
      officialPackage: false,
    },
    dependencyEvidence: [{ name: "tailwindcss", status: "present" }],
    accessibility: { keyboard: true, contrast: true, reducedMotion: true },
    performance: { mediaSpaceReserved: true, noScrollStateLoop: true },
    build: { command: "npm run build", result: "pass" },
    browserComparison: {
      url: "http://localhost:3000", screenshot: "artifacts/landing.png",
      consoleErrors: 0, interactions: ["CTA"], verdict: "pass",
    },
    mode: "greenfield",
  };
}

function extraction() {
  return {
    text: true, typography: true, spacing: true, colors: true,
    layout: true, components: true, hierarchy: true,
  };
}

function imageTrace() {
  return {
    sections: ["hero", "proof"], continuityKey: "north-v1",
    events: [
      { type: "reference", section: "hero", source: "generated", fresh: true, path: "assets/hero.png", continuityKey: "north-v1" },
      { type: "reference", section: "proof", source: "generated", fresh: true, path: "assets/proof.png", continuityKey: "north-v1" },
      { type: "analysis", section: "hero", extractions: extraction() },
      { type: "analysis", section: "proof", extractions: extraction() },
      { type: "implementation", files: ["src/page.tsx"] },
      {
        type: "browser-compare", url: "http://localhost:3000",
        screenshot: "artifacts/compare.png", consoleErrors: 0,
        interactions: ["CTA"], verdict: "pass",
      },
    ],
  };
}

const REMOVAL = [
  "diff --git a/src/app.js b/src/app.js", "--- a/src/app.js", "+++ b/src/app.js",
  "@@ -1,2 +1 @@", "-const unusedFlag = true;",
].join("\n");

function cleanerTrace() {
  return {
    author: "cleaner-author",
    baseline: { status: "pass", command: "node --test", evidence: "baseline passed" },
    passes: [{
      id: "dead-code-1", category: "DEAD_CODE", diff: { unified: REMOVAL }, outcome: "passed",
      verification: { status: "pass", command: "node --test", evidence: "focused passed" },
    }],
    final: { status: "pass", command: "node --test", evidence: "full passed", diff: { unified: REMOVAL } },
    independentVerification: {
      status: "pass", command: "node --test", evidence: "verifier passed",
      role: "verifier", actor: "fresh-verifier",
    },
  };
}

function contractErrors(text, clauses) {
  return clauses.filter((clause) => !clause.test(text)).map((clause) => clause.source);
}

function assertClauseMutations(text, clauses, label) {
  assert.deepEqual(contractErrors(text, clauses), [], label + " baseline");
  for (const clause of clauses) {
    const flags = clause.flags.includes("g") ? clause.flags : clause.flags + "g";
    const mutated = text.replace(new RegExp(clause.source, flags), "");
    assert.ok(contractErrors(mutated, clauses).length > 0, label + " mutation: " + clause.source);
  }
}

function previewCleanupErrors(text) {
  const errors = [];
  if (!/\bfinally\b/.test(text)) errors.push("finally cleanup is required");
  if ((text.match(/stopPreviewHandle\(handle\)/g) || []).length < 2) {
    errors.push("attempt and final cleanup must both stop the handle");
  }
  return errors;
}

test("all fourteen non-relay capabilities resolve and migrated resources are reachable", () => {
  assert.equal(PARITY.length, 14);
  assert.equal(new Set(PARITY.map((row) => row.source)).size, 14);
  for (const row of PARITY) {
    assert.equal(fs.existsSync(path.join(ROOT, row.target)), true, row.source + " -> " + row.target);
  }
  assert.equal(fs.existsSync(path.join(ROOT, ".agents/skills/relay")), false);

  for (const name of NEW_SKILLS) {
    const directory = path.join(ROOT, ".agents/skills", name);
    const skill = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    assert.match(skill, new RegExp("^---\\nname: " + name + "\\n"), name);
    for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
      const resource = match[1].split("#")[0];
      if (!resource || /^[a-z]+:/i.test(resource)) continue;
      assert.equal(fs.existsSync(path.resolve(directory, resource)), true, name + " resource " + resource);
    }
    for (const match of skill.matchAll(/node\s+(\.agents\/skills\/[^\s"'<>]+\.mjs)/g)) {
      assert.equal(fs.existsSync(path.join(ROOT, match[1])), true, name + " command " + match[1]);
    }
  }

  const readme = read("README.md");
  const agents = read("AGENTS.md");
  assert.match(readme, /skills.11/);
  assert.match(readme, /relay.*Codex.*\u79fb\u884c\u3057\u306a\u3044/u);
  assert.match(agents, /## CODEMAP maintenance/);
  assert.match(agents, /nearest routed `tasks\/codemap\.md`/);
  const codemapPath = path.join(ROOT, "tasks/codemap.md");
  if (fs.existsSync(codemapPath)) {
    const codemap = read("tasks/codemap.md");
    assert.match(codemap, /## 8\. Codex-native surface/);
    assert.match(codemap, /### 8\.2 Skills \(11\)/);
    assert.doesNotMatch(codemap, /\.agents\/skills\/claude-harness\/SKILL\.md/);
  }
});

test("migrated runtime instructions do not depend on the Claude provider bridge", () => {
  const prohibited = [".claude/", "CLAUDE.md", "codex exec", "--yolo", "/status"];
  for (const name of NEW_SKILLS) {
    const directory = path.join(ROOT, ".agents/skills", name);
    const files = walk(directory).filter((file) =>
      file.endsWith(".md") || (file.endsWith(".mjs") && !file.endsWith(".test.mjs")),
    );
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const token of prohibited) {
        assert.equal(content.includes(token), false, path.relative(ROOT, file) + " contains " + token);
      }
    }
  }
});

test("eight capability validators consume positive and critical negative evidence", (t) => {
  const brand = brandPlan();
  assert.deepEqual(validateBrandkitPlan(brand), []);
  brand.images[0].call.outputs = 2;
  assert.match(validateBrandkitPlan(brand).join("\n"), /exactly one imagegen output/);

  assert.equal(resolveWebSectionCount("landing page"), 6);
  assert.equal(resolveWebSectionCount("full website"), 8);
  const web = webPlan();
  assert.deepEqual(validateWebPlan(web), []);
  const omittedWebCount = structuredClone(web);
  delete omittedWebCount.requestedSections;
  omittedWebCount.sections.pop();
  assert.match(validateWebPlan(omittedWebCount).join("\n"), /requires exactly 6 sections/);
  assert.deepEqual(validateWebPlan({ ...web, requestedSections: 6 }), []);
  web.sections[0].call.outputs = 2;
  assert.match(validateWebPlan(web).join("\n"), /exactly one imagegen output/);

  const mobile = mobilePlan();
  assert.deepEqual(validateMobilePlan(mobile), []);
  mobile.screens[0].croppedFrom = "assets/board.png";
  assert.match(validateMobilePlan(mobile).join("\n"), /not a crop/);

  const frontend = frontendEvidence();
  assert.deepEqual(validateFrontendDesignEvidence(frontend), []);
  frontend.accessibility.reducedMotion = false;
  assert.match(validateFrontendDesignEvidence(frontend).join("\n"), /reducedMotion/);

  const trace = imageTrace();
  assert.deepEqual(validateImageToCodeTrace(trace), []);
  const implementation = trace.events.splice(4, 1)[0];
  trace.events.splice(2, 0, implementation);
  assert.match(validateImageToCodeTrace(trace).join("\n"), /occurs before analysis/);

  const cleanHtml = "<!doctype html><style>.x{background:url(data:image/png;base64,AA)}</style><p>https://example.test</p>";
  assert.deepEqual(validateSelfContainedHtml(cleanHtml), []);
  assert.match(
    validateSelfContainedHtml(cleanHtml + '<img src="https://cdn.example.test/a.png">').join("\n"),
    /remote src/,
  );
  for (const unsafeResource of [
    '<img src="https&#58;//cdn.example.test/a.png">',
    '<img src="file:///C:/secret.png">',
    '<feImage href="https://cdn.example.test/a.png">',
    '<base href="https://cdn.example.test/"><img src="relative.png">',
  ]) {
    assert.notDeepEqual(validateSelfContainedHtml(unsafeResource), []);
  }

  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-preview-evidence-"));
  t.after(() => fs.rmSync(previewRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(previewRoot, "capture.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const preview = {
    url: "http://127.0.0.1:3000", buildPath: "dev server",
    screenshot: { status: "captured", path: "capture.png" },
    console: { status: "clean", errors: [] },
    interaction: { status: "passed", summary: "CTA responded" },
    mockComparison: { status: "not-applicable", differences: [] },
    verdict: "looks-ok",
  };
  assert.deepEqual(validatePreviewEvidence(preview, { workspaceRoot: previewRoot }), []);
  preview.url = "https://example.test";
  assert.match(validatePreviewEvidence(preview, { workspaceRoot: previewRoot }).join("\n"), /loopback/);
  preview.url = "http://127.0.0.1:3000";
  delete preview.screenshot.path;
  assert.match(validatePreviewEvidence(preview, { workspaceRoot: previewRoot }).join("\n"), /existing in-scope/);

  const cleaner = cleanerTrace();
  assert.deepEqual(validateCleanerTrace(cleaner), []);
  cleaner.final.diff.unified += "\n+const accidentalAddition = true;";
  assert.match(validateCleanerTrace(cleaner).join("\n"), /final adds lines/);

  const stagedDiff = [
    "diff --git a/src/config.js b/src/config.js", "--- a/src/config.js", "+++ b/src/config.js",
    "@@ -0,0 +1 @@", '+const api_key = "not-a-placeholder-value";',
  ].join("\n");
  assert.deepEqual(
    scanCommitSafety(stagedDiff, ["src/config.js"]).map((finding) => finding.category),
    ["credential"],
  );
});

test("required mutation observation points fail when their consumer is removed", () => {
  const previewSource = read(".agents/skills/preview/scripts/preview-lifecycle.mjs");
  assert.deepEqual(previewCleanupErrors(previewSource), []);
  assert.match(
    previewCleanupErrors(previewSource.replace(/\bfinally\b/g, "cleanup_removed")).join("\n"),
    /finally cleanup/,
  );

  const web = webPlan();
  web.sections[1].call.outputs = 2;
  assert.notDeepEqual(validateWebPlan(web), []);

  const trace = imageTrace();
  const implementation = trace.events.splice(4, 1)[0];
  trace.events.splice(2, 0, implementation);
  assert.notDeepEqual(validateImageToCodeTrace(trace), []);

  assert.notDeepEqual(validateSelfContainedHtml('<script src="https://cdn.example.test/app.js"></script>'), []);

  const cleaner = cleanerTrace();
  cleaner.passes[0].diff.unified += "\n+const replacement = false;";
  assert.notDeepEqual(validateCleanerTrace(cleaner), []);
});

test("six workflow rows retain operative boundaries and mutations go red", () => {
  const contracts = [
    {
      name: "plan", text: read(".codex/workflows/plan.md"),
      clauses: [
        /Any heavy signal selects the heavy path\./, /All-light signals select the light path\./,
        /gets exactly one question/, /Declare the selected path and concrete reason/,
      ],
    },
    {
      name: "harness", text: read(".codex/workflows/harness.md"),
      clauses: [
        /Feature \| planner -> independent executor tasks -> reviewer -> verifier/,
        /Bug \| debugger reproduction\/probes/, /Pass role-card and plan\/scope paths to each worker/,
        /Security \| fresh independent security reviewer \+ fresh independent code\/spec reviewer in parallel/,
      ],
    },
    {
      name: "quality-loop", text: read(".codex/workflows/quality-loop.md"),
      clauses: [
        /two fresh independent reviewer contexts/, /seat a separate security reviewer/,
        /fresh reviewer runs fusion/, /fresh verifier supplies the final evidence gate/,
      ],
    },
    {
      name: "check", text: read(".codex/workflows/check.md"),
      clauses: [
        /node \.codex\/scripts\/check-native\.mjs/, /remote resource-bearing attributes/,
        /use the `preview`/, /tasks\/codemap\.md/,
      ],
    },
    {
      name: "commit", text: read(".codex/workflows/commit.md"),
      clauses: [
        /user current authorization/, /credential-shaped/, /private-key headers/,
        /console\.log/, /Stage only files belonging to the approved work/,
        /check-commit-safety\.mjs --worktree/, /check-commit-safety\.mjs --cached/,
      ],
    },
    {
      name: "pr", text: read(".codex/workflows/pr.md"),
      clauses: [
        /user current authorization/, /remote target/, /exact commits and diff/,
        /branch is not protected/, /Push only the approved branch/,
      ],
    },
  ];

  assert.deepEqual(WORKFLOWS, contracts.map((item) => item.name));
  for (const contract of contracts) assertClauseMutations(contract.text, contract.clauses, contract.name);
});
