import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SCANNER = path.join(ROOT, ".codex", "scripts", "check-commit-safety.mjs");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function scanner(cwd, ...args) {
  return run(process.execPath, [SCANNER, ...args], cwd);
}

function withRepository(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-commit-safety-"));
  try {
    git(directory, "init", "--quiet");
    git(directory, "config", "user.email", "test@example.invalid");
    git(directory, "config", "user.name", "Codex Test");
    fs.writeFileSync(path.join(directory, "README.md"), "baseline\n");
    git(directory, "add", "README.md");
    git(directory, "commit", "--quiet", "-m", "baseline");
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function write(directory, relative, content) {
  const target = path.join(directory, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function stage(directory, relative) {
  git(directory, "add", "--", relative);
}

test("worktree mode is bounded to explicit safe approved paths and cached mode is exact", () => {
  withRepository((directory) => {
    write(directory, "src/clean.mjs", "export const clean = false;\n");
    stage(directory, "src/clean.mjs");
    git(directory, "commit", "--quiet", "-m", "add clean module");
    write(directory, "src/clean.mjs", "export const clean = true;\n");

    const worktree = scanner(directory, "--worktree", "--", "src/clean.mjs");
    assert.equal(worktree.status, 0, worktree.stderr);
    assert.equal(worktree.stdout, "");

    const unsafe = scanner(directory, "--worktree", "--", "../outside.mjs");
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /safe repository-relative pathspec/i);

    const fixtureValue = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";
    write(directory, "src/unstaged-secret.mjs", ["export const ", "to", "ken = ", JSON.stringify(fixtureValue), ";\n"].join(""));
    const cachedBeforeStage = scanner(directory, "--cached");
    assert.equal(cachedBeforeStage.status, 0, cachedBeforeStage.stderr);
    assert.equal(cachedBeforeStage.stdout, "");
  });
});

test("cached scanner reports a credential-shaped literal without exposing its value", () => {
  withRepository((directory) => {
    const fixtureValue = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";
    write(directory, "src/client.mjs", ["export const ", "to", "ken = ", JSON.stringify(fixtureValue), ";\n"].join(""));
    stage(directory, "src/client.mjs");

    const result = scanner(directory, "--cached");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^credential src\/client\.mjs:1$/m);
    assert.equal(result.stdout.includes(fixtureValue), false);
    assert.equal(result.stderr, "");
  });
});

test("cached scanner reports private-key headers, debug code, and generated or debug artifacts", () => {
  withRepository((directory) => {
    const privateKeyHeader = "-----BEGIN " + "PRIVATE KEY-----";
    write(directory, "config/identity.txt", privateKeyHeader + "\n");
    write(directory, "src/debug.mjs", "console" + ".log('temporary');\n");
    write(directory, "artifacts/session-debug.log", "diagnostic output\n");
    stage(directory, "config/identity.txt");
    stage(directory, "src/debug.mjs");
    stage(directory, "artifacts/session-debug.log");

    const result = scanner(directory, "--cached");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^private-key config\/identity\.txt:1$/m);
    assert.match(result.stdout, /^debug-code src\/debug\.mjs:1$/m);
    assert.match(result.stdout, /^generated-or-debug-artifact artifacts\/session-debug\.log:0$/m);
    assert.equal(result.stderr, "");
  });
});

test("clearly marked fixture placeholders are allowed without allowing ordinary credentials", () => {
  withRepository((directory) => {
    const placeholder = "sk-" + "TEST_ONLY_PLACEHOLDER_TOKEN_123456";
    write(
      directory,
      "test/fixtures/token.fixture.mjs",
      ["export const ", "to", "ken = ", JSON.stringify(placeholder), ";\n"].join(""),
    );
    stage(directory, "test/fixtures/token.fixture.mjs");

    const result = scanner(directory, "--cached");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
  });
});


test("cached scanner blocks secret paths and generic credential literals while permitting .env.example", () => {
  withRepository((directory) => {
    const apiValue = ["live", "api", "value", "123"].join("_");
    const passwordValue = ["live", "password", "value", "456"].join("_");
    const bearerValue = ["live", "bearer", "value", "789"].join("_");
    write(directory, ".env", "MODE=local\n");
    write(directory, ".env.example", "MODE=example\n");
    const authSource = [
      "export const api" + "_key = " + JSON.stringify(apiValue) + ";",
      "export const pass" + "word = " + JSON.stringify(passwordValue) + ";",
      "export const auth" + "orization = " + JSON.stringify("Bearer " + bearerValue) + ";",
    ].join("\n") + "\n";
    write(directory, "src/auth.mjs", authSource);
    stage(directory, ".env");
    stage(directory, ".env.example");
    stage(directory, "src/auth.mjs");

    const result = scanner(directory, "--cached");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^secret-path \.env:0$/m);
    assert.equal(result.stdout.includes(".env.example"), false);
    assert.match(result.stdout, /^credential src\/auth\.mjs:1$/m);
    assert.match(result.stdout, /^credential src\/auth\.mjs:2$/m);
    assert.match(result.stdout, /^credential src\/auth\.mjs:3$/m);
    assert.equal(result.stdout.includes(apiValue), false);
    assert.equal(result.stdout.includes(passwordValue), false);
    assert.equal(result.stdout.includes(bearerValue), false);
  });
});

test("scanner disables textconv and catches multiline credentials, optional-chain debug, and dist artifacts", () => {
  withRepository((directory) => {
    write(directory, ".gitattributes", "*.probe diff=probe\n");
    write(directory, "sample.probe", "baseline\n");
    stage(directory, ".gitattributes");
    stage(directory, "sample.probe");
    git(directory, "commit", "--quiet", "-m", "add textconv fixture");
    git(directory, "config", "diff.probe.textconv", "definitely-missing-codex-textconv");
    write(directory, "sample.probe", "changed\n");
    const worktree = scanner(directory, "--worktree", "--", "sample.probe");
    assert.equal(worktree.status, 0, worktree.stderr);

    write(directory, "src/config.mjs", "export const api_key =\n  \"live_multiline_value_123\";\n");
    write(directory, "src/debug.mjs", ["console?", ".log('temporary');\n"].join(""));
    write(directory, "dist/bundle.js", "export const built = true;\n");
    stage(directory, "src/config.mjs");
    stage(directory, "src/debug.mjs");
    stage(directory, "dist/bundle.js");

    const result = scanner(directory, "--cached");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^credential src\/config\.mjs:1$/m);
    assert.match(result.stdout, /^debug-code src\/debug\.mjs:1$/m);
    assert.match(result.stdout, /^generated-or-debug-artifact dist\/bundle\.js:0$/m);
  });
});
