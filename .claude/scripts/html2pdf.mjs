#!/usr/bin/env node
// .claude/scripts/html2pdf.mjs — convert a self-contained HTML file to PDF via WeasyPrint.
//
// Design: FAIL-OPEN. If WeasyPrint (or Python) is not installed, this does NOT error —
// it skips the PDF, leaves the HTML untouched, and points at the setup guide. A document
// deliverable must never be blocked on PDF tooling. Real PDF rendering needs WeasyPrint:
// see docs/weasyprint-setup.html (Windows: MSYS2 + Pango).
//
// Usage: node .claude/scripts/html2pdf.mjs <input.html> <output.pdf>
// Exit:  0 = PDF written OR skipped (fail-open) ; 2 = bad arguments / missing input
'use strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SETUP = 'docs/weasyprint-setup.html';
const [input, output] = process.argv.slice(2);

if (!input || !output) {
  console.error('Usage: node .claude/scripts/html2pdf.mjs <input.html> <output.pdf>');
  process.exit(2);
}
if (!fs.existsSync(input)) {
  console.error(`html2pdf: input not found: ${input}`);
  process.exit(2);
}
const sameFile = (a, b) => {
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
};
if (sameFile(input, output)) {
  console.error('html2pdf: input and output must be different paths');
  process.exit(2);
}

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// Find a Python interpreter that can actually import weasyprint (native Pango libs included).
// `import weasyprint` is the truest "is it usable here?" probe — a bare pip install without
// Pango fails this exact import on Windows, which is what we want to detect.
let py = null;
for (const cand of ['python', 'python3', 'py']) {
  const probe = run(cand, ['-c', 'import weasyprint']);
  if (probe && !probe.error && probe.status === 0) { py = cand; break; }
}

if (!py) {
  console.log(`html2pdf: WeasyPrint not available — skipping PDF. HTML is kept: ${input}`);
  console.log(`          Enable PDF export by following ${SETUP}`);
  process.exit(0); // fail-open
}

const outputExisted = fs.existsSync(output);
const res = run(py, ['-m', 'weasyprint', input, output]);
if (!res || res.error || res.status !== 0) {
  if (!outputExisted && fs.existsSync(output)) { try { fs.unlinkSync(output); } catch { /* leave it */ } }
  console.log(`html2pdf: WeasyPrint failed — skipping PDF. HTML is kept: ${input}`);
  if (res && res.stderr) console.log(res.stderr.toString().trim());
  console.log(`          Setup / troubleshooting: ${SETUP}`);
  process.exit(0); // fail-open — never block the workflow on PDF
}

console.log(`html2pdf: wrote ${output}`);
process.exit(0);
