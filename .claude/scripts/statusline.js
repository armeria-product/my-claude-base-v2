#!/usr/bin/env node
// NOTE: .claude/scripts/package.json declares "type":"module", so this file is ESM —
// use import, never require (a require here throws and dies silently in try/catch).
import fs from "node:fs";
import path from "node:path";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    data = {};
  }

  const BRAILLE = [" ", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
  const R = "\x1b[0m";
  const DIM = "\x1b[2m";

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  const gradient = (pct) => {
    if (pct < 50) {
      const r = Math.round(pct * 5.1);
      return `\x1b[38;2;${r};200;80m`;
    }
    const g = Math.max(Math.round(200 - (pct - 50) * 4), 0);
    return `\x1b[38;2;255;${g};60m`;
  };

  const brailleBar = (pct, width = 8) => {
    pct = clamp(pct, 0, 100);
    const level = pct / 100;
    let bar = "";
    for (let i = 0; i < width; i++) {
      const segStart = i / width;
      const segEnd = (i + 1) / width;
      if (level >= segEnd) {
        bar += BRAILLE[7];
      } else if (level <= segStart) {
        bar += BRAILLE[0];
      } else {
        const frac = (level - segStart) / (segEnd - segStart);
        bar += BRAILLE[Math.min(Math.floor(frac * 7), 7)];
      }
    }
    return bar;
  };

  const fmt = (label, pct) =>
    `${DIM}${label}${R} ${gradient(pct)}${brailleBar(pct)}${R} ${Math.round(pct)}%`;

  const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

  const model = data?.model?.display_name || "Claude";
  const parts = [model];

  // scope-lock indicator: 🔒slug while a plan lock is armed (reads hook-owned state)
  try {
    const proj = data?.workspace?.project_dir || data?.cwd || process.cwd();
    const lock = JSON.parse(
      fs.readFileSync(path.join(proj, ".claude", "state", "scope-lock.json"), "utf8")
    );
    if (lock.status === "locked") parts.push(`\x1b[33m🔒${lock.slug}${R}`);
  } catch {
    /* no lock file -> no segment */
  }

  // Fable ON/OFF switch indicator (CLAUDE.md §1.11): the switch is the user's file to edit, not
  // Claude's (2026-08-06 ruling) — surface it so a leftover ON from a previous session is visible.
  try {
    const proj = data?.workspace?.project_dir || data?.cwd || process.cwd();
    const fableStatus = fs
      .readFileSync(path.join(proj, ".claude", ".fable-status"), "utf8")
      .trim()
      .toUpperCase();
    if (fableStatus === "ON") parts.push(`\x1b[35mFable:ON${R}`);
  } catch {
    /* no switch file -> OFF -> no segment */
  }

  const ctx = num(data?.context_window?.used_percentage);
  if (ctx != null) parts.push(fmt("ctx", ctx));

  const five = num(data?.rate_limits?.five_hour?.used_percentage);
  if (five != null) parts.push(fmt("5h", five));

  const week = num(data?.rate_limits?.seven_day?.used_percentage);
  if (week != null) parts.push(fmt("7d", week));

  process.stdout.write(parts.join(` ${DIM}│${R} `));
});
