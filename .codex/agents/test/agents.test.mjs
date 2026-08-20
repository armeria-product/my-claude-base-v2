import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const AGENTS_DIR = path.join(ROOT, ".codex", "agents");
const ROLES_DIR = path.join(ROOT, ".codex", "roles");
const WORKFLOWS_DIR = path.join(ROOT, ".codex", "workflows");
const forbiddenPath = "." + "claude/";

const expected = {
  planner: { model: "gpt-5.6-terra", effort: "xhigh", sandbox: "workspace-write" },
  reviewer: { model: "gpt-5.6-terra", effort: "xhigh", sandbox: "read-only" },
  executor: { model: "gpt-5.6-terra", effort: "ultra", sandbox: "workspace-write" },
  debugger: { model: "gpt-5.6-terra", effort: "ultra", sandbox: "workspace-write" },
  verifier: { model: "gpt-5.6-terra", effort: "ultra", sandbox: "read-only" },
  "document-author": { model: "gpt-5.6-terra", effort: "ultra", sandbox: "workspace-write" },
  explorer: { model: "gpt-5.6-luna", effort: "medium", sandbox: "read-only" },
};

function parseAgentToml(file) {
  const script = "import json,pathlib,sys,tomllib; print(json.dumps(tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))))";
  return JSON.parse(execFileSync("python", ["-c", script, file], { encoding: "utf8" }));
}

test("all seven native agent TOML files satisfy the role contract", () => {
  const names = readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name.slice(0, -".toml".length))
    .sort();
  assert.deepEqual(names, Object.keys(expected).sort());

  for (const name of names) {
    const file = path.join(AGENTS_DIR, name + ".toml");
    const parsed = parseAgentToml(file);
    assert.equal(parsed.name, name);
    assert.ok(parsed.description.length > 20);
    assert.equal(parsed.model, expected[name].model);
    assert.equal(parsed.model_reasoning_effort, expected[name].effort);
    assert.equal(parsed.sandbox_mode, expected[name].sandbox);
    assert.match(parsed.developer_instructions, new RegExp("\\.codex/roles/" + name + "\\.md"));
    assert.ok(!parsed.developer_instructions.toLowerCase().includes(forbiddenPath));
  }
});

test("native role and workflow documents do not bridge to another provider runtime", () => {
  for (const directory of [ROLES_DIR, WORKFLOWS_DIR]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".md"))) {
      const source = readFileSync(path.join(directory, file), "utf8").toLowerCase();
      assert.ok(!source.includes(forbiddenPath), path.join(directory, file) + " contains a provider bridge");
    }
  }
  for (const name of Object.keys(expected)) {
    const role = readFileSync(path.join(ROLES_DIR, name + ".md"), "utf8");
    assert.ok(role.startsWith("# Role: " + name));
  }
  for (const workflow of ["plan", "harness", "quality-loop", "check", "commit", "pr"]) {
    assert.ok(readdirSync(WORKFLOWS_DIR).includes(workflow + ".md"));
  }
});
