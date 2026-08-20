import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSelfContainedHtml } from './assert-self-contained.mjs';
import { extract, extractInner, pack, sliceSections } from './deckpack.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const TEMPLATE = path.join(SKILL_DIR, 'assets', 'doc.pptx.template.html');
const PDF = path.join(SCRIPT_DIR, 'html2pdf.mjs');
const PPTX = path.join(SCRIPT_DIR, 'html2pptx.mjs');

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'codex-doc-'));
}

function cleanHtml() {
  return '<!doctype html><style>.icon{background:url(data:image/png;base64,AA)}</style>' +
    '<script>const example = "https://example.test/in-code";</script>' +
    '<pre>https://example.test/in-prose</pre><a href="https://example.test">reference</a>';
}

test('self-containment gate permits URL text and inline code but rejects real remote resources', () => {
  assert.deepEqual(validateSelfContainedHtml(cleanHtml()), []);
  const errors = validateSelfContainedHtml('<img src="https://cdn.example.test/a.png"><style>@import url(//cdn.example.test/x.css)</style>');
  assert.match(errors.join('\n'), /remote src/);
  assert.match(errors.join('\n'), /remote @import/);
});

test('self-containment mutation goes RED for a remote resource and GREEN when restored', () => {
  const valid = cleanHtml();
  assert.deepEqual(validateSelfContainedHtml(valid), []);
  const mutated = valid + '<script src="https://cdn.example.test/app.js"></script>';
  assert.match(validateSelfContainedHtml(mutated).join('\n'), /remote src/);
  assert.deepEqual(validateSelfContainedHtml(valid), []);
});

test('self-containment rejects obfuscated and non-embedded resource routes but leaves inert URL text alone', () => {
  const unsafe = [
    '<img src="h&#116;tps://cdn.example.test/a.png">',
    '<img src="&#x2f;&#x2f;cdn.example.test/a.png">',
    '<img src="file:///C:/private.png">',
    '<img src="assets/relative.png">',
    '<svg><feImage href="https://cdn.example.test/filter.png"></feImage></svg>',
    '<base href="https://cdn.example.test/">',
    '<style>@import "assets/theme.css"; .hero{background:url(h&#116;tps://cdn.example.test/a.png)}</style>',
    '<meta http-equiv="refresh" content="0; url=h&#116;tps://cdn.example.test/next">',
    '<img srcset="data:image/png;base64,AA 1x, h&#116;tps://cdn.example.test/a.png 2x">',
  ].join('');
  const errors = validateSelfContainedHtml(unsafe).join('\n');
  assert.match(errors, /remote|non-embedded|base href/i);

  const inert = '<p>https://example.test/in-prose</p>' +
    '<script type="application/json">{"manifest":"https://example.test/inert"}</script>' +
    '<script>const example = "https://example.test/in-code";</script>' +
    '<a href="https://example.test/reference">reference</a>';
  assert.deepEqual(validateSelfContainedHtml(inert), []);
});

test('self-containment recursively rejects active data and bundled resource routes while preserving inert JSON', () => {
  const bundled = JSON.stringify({ nested: [{ markup: '<img src="https://cdn.example.test/bundled.png">' }] });
  const unsafe = [
    '<script>fetch("https://cdn.example.test/active.json")</script>',
    '<script type="module">import("https://cdn.example.test/module.js")</script>',
    '<iframe srcdoc=\'<img src="https://cdn.example.test/frame.png">\'></iframe>',
    '<script src="data:text/javascript,alert(1)"></script>',
    '<object data="data:image/png;base64,AA"></object>',
    `<script type="__bundler/template">${bundled}</script>`,
  ].join('');
  assert.match(validateSelfContainedHtml(unsafe).join('\n'), /remote|unsafe data|non-embedded/i);

  const inert = [
    '<p>https://example.test/in-prose</p>',
    '<script type="application/json">{"endpoint":"https://example.test/inert"}</script>',
    `<script type="__bundler/template">${JSON.stringify('<p>https://example.test/template-prose</p>')}</script>`,
  ].join('');
  assert.deepEqual(validateSelfContainedHtml(inert), []);
});

test('canonical document assets pass the same self-containment gate', () => {
  const documentTemplate = path.join(SKILL_DIR, 'assets', 'doc.template.html');
  for (const asset of [documentTemplate, TEMPLATE]) {
    assert.deepEqual(validateSelfContainedHtml(readFileSync(asset, 'utf8')), [], asset);
  }
});

test('deck extract and pack round-trip the bundled template without remote preconnect links', () => {
  const bundle = readFileSync(TEMPLATE, 'utf8');
  const sourceSections = sliceSections(extractInner(bundle)).sections;
  const extracted = extract(bundle);
  const packed = pack(bundle, extracted);
  assert.equal(sliceSections(extractInner(packed)).sections, sourceSections);
  assert.doesNotMatch(packed, /rel="preconnect"/i);
});

test('PDF conversion is fail-open for an explicit missing local runtime', () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, 'document.html');
    const output = path.join(directory, 'document.pdf');
    writeFileSync(input, cleanHtml(), 'utf8');
    const result = spawnSync(process.execPath, [PDF, input, output], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_NODE_MODULES: path.join(directory, 'missing-runtime') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipped \(fail-open\)/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('editable PPTX conversion is fail-loud for an explicit missing local runtime', () => {
  const directory = tempDir();
  try {
    const output = path.join(directory, 'deck.pptx');
    const result = spawnSync(process.execPath, [PPTX, TEMPLATE, output], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_NODE_MODULES: path.join(directory, 'missing-runtime') },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /dependencies not installed/);
    assert.match(result.stderr, /CODEX_NODE_MODULES/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('PDF and PPTX reject unsafe input before runtime or browser discovery', () => {
  const directory = tempDir();
  try {
    const input = path.join(directory, 'unsafe.html');
    writeFileSync(input, '<section><img src="h&#116;tps://cdn.example.test/a.png"></section>', 'utf8');
    const environment = { ...process.env, CODEX_NODE_MODULES: path.join(directory, 'missing-runtime') };

    const pdf = spawnSync(process.execPath, [PDF, input, path.join(directory, 'unsafe.pdf')], {
      encoding: 'utf8', env: environment,
    });
    assert.equal(pdf.status, 1, pdf.stderr);
    assert.match(pdf.stderr, /remote|non-embedded/i);
    assert.doesNotMatch(pdf.stdout, /skipped \(fail-open\)/);

    const pptx = spawnSync(process.execPath, [PPTX, input, path.join(directory, 'unsafe.pptx')], {
      encoding: 'utf8', env: environment,
    });
    assert.equal(pptx.status, 1, pptx.stderr);
    assert.match(pptx.stderr, /remote|non-embedded/i);
    assert.doesNotMatch(pptx.stderr, /dependencies not installed/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
