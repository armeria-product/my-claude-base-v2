import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const AGENTS_DIR = path.join(ROOT, ".codex", "agents");
const ROLES_DIR = path.join(ROOT, ".codex", "roles");
const WORKFLOWS_DIR = path.join(ROOT, ".codex", "workflows");
const forbiddenPath = "." + "claude/";
const expectedNames = [
  "debugger",
  "document-author",
  "executor",
  "explorer",
  "planner",
  "reviewer",
  "verifier",
];
const requiredKeys = ["name", "description", "developer_instructions", "model", "model_reasoning_effort", "sandbox_mode"];
const allowedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);
const allowedSandboxes = new Set(["read-only", "workspace-write"]);

function parseAgentToml(file) {
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const parsed = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const multiline = line.match(/^([a-z_]+)\s*=\s*"""\s*$/);
    if (multiline) {
      const values = [];
      while (++index < lines.length && lines[index].trim() !== '"""') values.push(lines[index]);
      assert.ok(index < lines.length, file + ": unterminated multiline TOML value");
      parsed[multiline[1]] = values.join("\n").trim();
      continue;
    }
    const scalar = line.match(/^([a-z_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
    assert.ok(scalar, file + ": unsupported TOML assignment: " + line);
    parsed[scalar[1]] = JSON.parse('"' + scalar[2] + '"');
  }
  return parsed;
}

test("all seven native agent TOML files satisfy the role contract without duplicating model choices", () => {
  const names = readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name.slice(0, -".toml".length))
    .sort();
  assert.deepEqual(names, expectedNames);

  for (const name of names) {
    const file = path.join(AGENTS_DIR, name + ".toml");
    const parsed = parseAgentToml(file);
    for (const key of requiredKeys) assert.equal(typeof parsed[key], "string", name + "." + key);
    assert.equal(parsed.name, name);
    assert.ok(parsed.description.length > 20, name + ".description");
    assert.match(parsed.model, /^\S+$/, name + ".model");
    assert.ok(allowedEfforts.has(parsed.model_reasoning_effort), name + ".model_reasoning_effort");
    assert.ok(allowedSandboxes.has(parsed.sandbox_mode), name + ".sandbox_mode");
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
  for (const name of expectedNames) {
    const role = readFileSync(path.join(ROLES_DIR, name + ".md"), "utf8");
    assert.ok(role.startsWith("# Role: " + name));
  }
  for (const workflow of ["plan", "harness", "quality-loop", "check", "commit", "pr"]) {
    assert.ok(readdirSync(WORKFLOWS_DIR).includes(workflow + ".md"));
  }
});
