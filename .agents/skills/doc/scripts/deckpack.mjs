#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_OPEN_RE = /<script type="__bundler\/template"[^>]*>/;
const XIMPORT_OPEN_RE = /<x-import[^>]*>/g;
const XIMPORT_CLOSE = '</x-import>';
const PRECONNECT_RE = /<link\s+(?=[^>]*\brel="preconnect")[^>]*>/gi;
const EXTRACT_HEADER =
  '<!-- deck slides: edit sections here; repack with: node .agents/skills/doc/scripts/deckpack.mjs --pack <this-file> <out.deck.html> ; each <section> = one 1920x1080 slide -->\n';
const DEFAULT_BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'doc.pptx.template.html');

export function readTemplateSpan(bundleText) {
  const open = TEMPLATE_OPEN_RE.exec(bundleText);
  if (!open) throw new Error('deckpack: __bundler/template script tag not found');
  const start = open.index + open[0].length;
  const end = bundleText.indexOf('</script>', start);
  if (end === -1) throw new Error('deckpack: __bundler/template script tag has no closing </script>');
  return { start, end };
}

export function extractInner(bundleText) {
  const { start, end } = readTemplateSpan(bundleText);
  try { return JSON.parse(bundleText.slice(start, end)); }
  catch (error) { throw new Error('deckpack: __bundler/template contents are not valid JSON: ' + error.message); }
}

export function sliceSections(innerHtml) {
  const opens = [...innerHtml.matchAll(XIMPORT_OPEN_RE)];
  if (opens.length !== 1) throw new Error('deckpack: expected exactly one <x-import> opening tag');
  const open = opens[0];
  const start = open.index + open[0].length;
  const end = innerHtml.indexOf(XIMPORT_CLOSE, start);
  if (end === -1 || innerHtml.indexOf(XIMPORT_CLOSE, end + XIMPORT_CLOSE.length) !== -1) {
    throw new Error('deckpack: expected exactly one </x-import> closing tag');
  }
  return { before: innerHtml.slice(0, start), sections: innerHtml.slice(start, end), after: innerHtml.slice(end) };
}

export function stripRemote(html) {
  return html.replace(PRECONNECT_RE, '');
}

export function escapeForBundle(innerHtml) {
  return JSON.stringify(innerHtml).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function extract(bundleText) {
  return EXTRACT_HEADER + sliceSections(extractInner(bundleText)).sections;
}

export function pack(bundleText, sectionsHtml) {
  const { start, end } = readTemplateSpan(bundleText);
  const { before, after } = sliceSections(extractInner(bundleText));
  const cleanSections = sectionsHtml.startsWith(EXTRACT_HEADER) ? sectionsHtml.slice(EXTRACT_HEADER.length) : sectionsHtml;
  const encoded = escapeForBundle(stripRemote(before + cleanSections + after));
  return bundleText.slice(0, start) + encoded + bundleText.slice(end);
}

function sameFile(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function usage() {
  console.error('Usage: node .agents/skills/doc/scripts/deckpack.mjs --extract <bundle.html> <out.slides.html>');
  console.error('       node .agents/skills/doc/scripts/deckpack.mjs --pack <slides.html> <out.deck.html> [--bundle <bundle.html>]');
}

function read(pathname, label) {
  try { return fs.readFileSync(pathname, 'utf8'); }
  catch (error) { throw new Error('deckpack: failed to read ' + label + ': ' + error.message); }
}

export function main(argv) {
  const mode = argv[0];
  if (mode === '--extract') {
    const [input, output] = argv.slice(1);
    if (!input || !output || !fs.existsSync(input) || sameFile(input, output)) { usage(); return 2; }
    try {
      fs.writeFileSync(output, extract(read(input, 'input')), 'utf8');
      process.stdout.write('deckpack: wrote ' + output + '\n');
      return 0;
    } catch (error) { console.error(error.message); return 1; }
  }
  if (mode === '--pack') {
    const positional = [];
    let bundle = DEFAULT_BUNDLE;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--bundle') bundle = argv[++i];
      else positional.push(argv[i]);
    }
    const [input, output] = positional;
    if (!input || !output || !bundle || !fs.existsSync(input) || !fs.existsSync(bundle) || sameFile(input, output)) { usage(); return 2; }
    try {
      fs.writeFileSync(output, pack(read(bundle, 'bundle'), read(input, 'slides')), 'utf8');
      process.stdout.write('deckpack: wrote ' + output + '\n');
      return 0;
    } catch (error) { console.error(error.message); return 1; }
  }
  usage();
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
