#!/usr/bin/env node
// .claude/scripts/deckpack.test.mjs — node:test suite for deckpack.mjs, using the real
// doc.pptx.template.html bundle as fixture. Operates on in-memory strings via the exported
// pure functions; only the CLI smoke test touches disk (os.tmpdir()).
'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readTemplateSpan,
  extractInner,
  sliceSections,
  stripRemote,
  escapeForBundle,
  pack,
  extract,
} from './deckpack.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(SCRIPT_DIR, '..', 'skills', 'doc', 'template', 'doc.pptx.template.html');
const bundleText = fs.readFileSync(BUNDLE_PATH, 'utf8');

function sectionsOf(bundle) {
  const inner = extractInner(bundle);
  return sliceSections(inner).sections;
}

test('extract: contains exactly 9 sections, speaker notes, no preconnect/@font-face', () => {
  const result = extract(bundleText);
  const body = result.replace(/^<!-- deck slides:.*?-->\n/, '');
  const sectionCount = (body.match(/<section\s/g) || []).length;
  assert.equal(sectionCount, 9);
  assert.match(result, /data-speaker-notes/);
  assert.doesNotMatch(result, /preconnect/);
  assert.doesNotMatch(result, /@font-face/);
});

test('roundtrip: pack(bundle, sectionsOf(bundle)) preserves sections byte-identically', () => {
  const sections = sectionsOf(bundleText);
  const packed = pack(bundleText, sections);
  const repackedSections = sectionsOf(packed);
  assert.equal(repackedSections, sections);
});

test('escaping held: literal </script> count matches original, and template span still parses', () => {
  const sections = sectionsOf(bundleText);
  const packed = pack(bundleText, sections);

  const countScriptClose = (s) => (s.match(/<\/script>/g) || []).length;
  assert.equal(countScriptClose(packed), countScriptClose(bundleText));

  const { start, end } = readTemplateSpan(packed);
  assert.doesNotThrow(() => JSON.parse(packed.slice(start, end)));
});

test('preconnect gone: extractInner(packed) has no preconnect / fonts.googleapis.com', () => {
  const sections = sectionsOf(bundleText);
  const packed = pack(bundleText, sections);
  const inner = extractInner(packed);
  assert.doesNotMatch(inner, /preconnect/);
  assert.doesNotMatch(inner, /fonts\.googleapis\.com/);
});

test('idempotence: extract(pack(bundle, s)) === s (modulo comment header)', () => {
  const sections = sectionsOf(bundleText);
  const packed = pack(bundleText, sections);
  const extracted = extract(packed);
  const extractedWithoutHeader = extracted.replace(
    /^<!-- deck slides:.*?-->\n/, ''
  );
  assert.equal(extractedWithoutHeader, sections);
});

test('malformed input: string without template tag throws on parse', () => {
  const malformed = '<html><body>no bundler script here</body></html>';
  assert.throws(() => readTemplateSpan(malformed), /__bundler\/template script tag not found/);
  assert.throws(() => extractInner(malformed), /__bundler\/template script tag not found/);
  assert.throws(() => extract(malformed), /__bundler\/template script tag not found/);
});

test('malformed input: template tag present but JSON invalid throws', () => {
  const malformed = '<script type="__bundler/template">not valid json</script>';
  assert.throws(() => extractInner(malformed), /not valid JSON/);
});

test('malformed input: missing x-import marker throws', () => {
  const innerNoImport = '<html><body>no import tag</body></html>';
  assert.throws(() => sliceSections(innerNoImport), /<x-import> opening tag not found/);
});

test('malformed input: missing </x-import> closing tag throws', () => {
  const innerNoClose = '<html><body><x-import width="1920">stuff</body></html>';
  assert.throws(() => sliceSections(innerNoClose), /<\/x-import> closing tag not found/);
});

test('stripRemote: removes preconnect link regardless of attribute order', () => {
  const html = '<link href="https://fonts.googleapis.com" rel="preconnect"><p>keep</p>';
  const stripped = stripRemote(html);
  assert.doesNotMatch(stripped, /preconnect/);
  assert.match(stripped, /<p>keep<\/p>/);
});

test('escapeForBundle: escapes < and > so no literal </script> survives', () => {
  const withScriptClose = 'text with </script> inside';
  const escaped = escapeForBundle(withScriptClose);
  assert.doesNotMatch(escaped, /<\/script>/);
  assert.equal(JSON.parse(escaped), withScriptClose);
});

test('CLI smoke: --extract then --pack round-trips via real files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckpack-test-'));
  const slidesPath = path.join(tmpDir, 'out.slides.html');
  const deckPath = path.join(tmpDir, 'out.deck.html');
  const scriptPath = path.join(SCRIPT_DIR, 'deckpack.mjs');

  try {
    const extractRes = spawnSync(process.execPath, [scriptPath, '--extract', BUNDLE_PATH, slidesPath], { encoding: 'utf8' });
    assert.equal(extractRes.status, 0, extractRes.stderr);
    assert.ok(fs.existsSync(slidesPath));

    const packRes = spawnSync(process.execPath, [scriptPath, '--pack', slidesPath, deckPath, '--bundle', BUNDLE_PATH], { encoding: 'utf8' });
    assert.equal(packRes.status, 0, packRes.stderr);
    assert.ok(fs.existsSync(deckPath));

    const packedText = fs.readFileSync(deckPath, 'utf8');
    const { start, end } = readTemplateSpan(packedText);
    assert.doesNotThrow(() => JSON.parse(packedText.slice(start, end)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bad args: missing arguments exits with code 2', () => {
  const scriptPath = path.join(SCRIPT_DIR, 'deckpack.mjs');
  const res = spawnSync(process.execPath, [scriptPath, '--extract'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('bad args: same input/output path exits with code 2', () => {
  const scriptPath = path.join(SCRIPT_DIR, 'deckpack.mjs');
  const res = spawnSync(process.execPath, [scriptPath, '--extract', BUNDLE_PATH, BUNDLE_PATH], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});
