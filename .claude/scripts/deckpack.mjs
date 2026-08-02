#!/usr/bin/env node
// .claude/scripts/deckpack.mjs — extract/pack the 9 <section> slides inside the doc.pptx
// bundle template (a claude.ai artifact bundle: __bundler/manifest + __bundler/template
// script tags, the latter holding the deck's inner HTML as a JSON string).
//
// Why a JSON-string re-escape on pack: the inner HTML text inside __bundler/template is
// stored as JSON with `<`/`>` escaped to </>. A literal `</script>` in that span
// would terminate the surrounding <script> element early and corrupt the bundle — so pack()
// always re-escapes via JSON.stringify(...).replace(/</g,...).replace(/>/g,...), mirroring
// the original encoder.
//
// Usage:
//   node .claude/scripts/deckpack.mjs --extract <bundle.html> <out.slides.html>
//   node .claude/scripts/deckpack.mjs --pack <slides.html> <out.deck.html> [--bundle <bundle.html>]
// Exit: 0 = ok ; 1 = malformed input (missing template tag / x-import span / JSON parse
// failure) ; 2 = bad args or missing input file
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_OPEN_RE = /<script type="__bundler\/template"[^>]*>/;
const XIMPORT_OPEN_RE = /<x-import[^>]*>/g;
const XIMPORT_CLOSE = '</x-import>';
const PRECONNECT_RE = /<link\s+(?=[^>]*\brel="preconnect")[^>]*>/gi;
const EXTRACT_HEADER =
  '<!-- deck slides: edit sections here; repack with: node .claude/scripts/deckpack.mjs --pack <this-file> <out.deck.html> ; each <section> = one 1920x1080 slide -->\n';

const DEFAULT_BUNDLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'skills', 'doc', 'template', 'doc.pptx.template.html'
);

// { start, end }: JSON text span between the __bundler/template opening tag and its </script>.
export function readTemplateSpan(bundleText) {
  const openMatch = TEMPLATE_OPEN_RE.exec(bundleText);
  if (!openMatch) throw new Error('deckpack: __bundler/template script tag not found');
  const start = openMatch.index + openMatch[0].length;
  const end = bundleText.indexOf('</script>', start);
  if (end === -1) throw new Error('deckpack: __bundler/template script tag has no closing </script>');
  return { start, end };
}

// Inner HTML string of the bundle (the JSON-decoded contents of __bundler/template).
export function extractInner(bundleText) {
  const { start, end } = readTemplateSpan(bundleText);
  try {
    return JSON.parse(bundleText.slice(start, end));
  } catch (err) {
    throw new Error(`deckpack: __bundler/template contents are not valid JSON: ${err.message}`);
  }
}

// { before, sections, after }: split the inner HTML at the end of the <x-import ...> opening
// tag and at </x-import>. `sections` is everything between (the 9 <section> slides).
export function sliceSections(innerHtml) {
  const opens = [...innerHtml.matchAll(XIMPORT_OPEN_RE)];
  if (opens.length === 0) throw new Error('deckpack: <x-import> opening tag not found');
  if (opens.length > 1) throw new Error('deckpack: multiple <x-import> opening tags found');
  const openMatch = opens[0];
  const sectionsStart = openMatch.index + openMatch[0].length;

  const closeIdx = innerHtml.indexOf(XIMPORT_CLOSE);
  if (closeIdx === -1) throw new Error('deckpack: </x-import> closing tag not found');
  if (innerHtml.indexOf(XIMPORT_CLOSE, closeIdx + 1) !== -1) {
    throw new Error('deckpack: multiple </x-import> closing tags found');
  }

  return {
    before: innerHtml.slice(0, sectionsStart),
    sections: innerHtml.slice(sectionsStart, closeIdx),
    after: innerHtml.slice(closeIdx),
  };
}

// Remove <link rel="preconnect" ...> tags (attribute order-agnostic).
export function stripRemote(html) {
  return html.replace(PRECONNECT_RE, '');
}

// JSON-encode a string for splicing back into a __bundler/template script tag, escaping
// `<`/`>` so no literal </script> can appear inside the span (see file header).
export function escapeForBundle(jsonString) {
  return JSON.stringify(jsonString).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// Splice `sectionsHtml` into the bundle's __bundler/template span, stripping remote links
// from the resulting inner HTML, and return the new bundle text.
export function pack(bundleText, sectionsHtml) {
  const { start, end } = readTemplateSpan(bundleText);
  const inner = extractInner(bundleText);
  const { before, after } = sliceSections(inner);
  const newInner = stripRemote(before + sectionsHtml + after);
  const newSpan = escapeForBundle(newInner);
  return bundleText.slice(0, start) + newSpan + bundleText.slice(end);
}

// Sections HTML extracted from a bundle, prefixed with an editing-instructions comment.
export function extract(bundleText) {
  const inner = extractInner(bundleText);
  const { sections } = sliceSections(inner);
  return EXTRACT_HEADER + sections;
}

// Strip the extract() header comment if present (used before re-packing).
function stripExtractHeader(sectionsHtml) {
  return sectionsHtml.startsWith(EXTRACT_HEADER) ? sectionsHtml.slice(EXTRACT_HEADER.length) : sectionsHtml;
}

function sameFile(a, b) {
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

function usage() {
  console.error('Usage: node .claude/scripts/deckpack.mjs --extract <bundle.html> <out.slides.html>');
  console.error('       node .claude/scripts/deckpack.mjs --pack <slides.html> <out.deck.html> [--bundle <bundle.html>]');
}

function main(argv) {
  const mode = argv[0];
  if (mode !== '--extract' && mode !== '--pack') {
    usage();
    return 2;
  }

  if (mode === '--extract') {
    const [input, output] = argv.slice(1);
    if (!input || !output) { usage(); return 2; }
    if (!fs.existsSync(input)) {
      console.error(`deckpack: input not found: ${input}`);
      return 2;
    }
    if (sameFile(input, output)) {
      console.error('deckpack: input and output must be different paths');
      return 2;
    }
    let bundleText;
    try {
      bundleText = fs.readFileSync(input, 'utf8');
    } catch (err) {
      console.error(`deckpack: failed to read ${input}: ${err.message}`);
      return 2;
    }
    let result;
    try {
      result = extract(bundleText);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    fs.writeFileSync(output, result, 'utf8');
    console.log(`deckpack: wrote ${output}`);
    return 0;
  }

  // --pack
  const positional = [];
  let bundlePath = DEFAULT_BUNDLE;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--bundle') {
      bundlePath = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  const [input, output] = positional;
  if (!input || !output || !bundlePath) { usage(); return 2; }
  if (!fs.existsSync(input)) {
    console.error(`deckpack: input not found: ${input}`);
    return 2;
  }
  if (!fs.existsSync(bundlePath)) {
    console.error(`deckpack: bundle not found: ${bundlePath}`);
    return 2;
  }
  if (sameFile(input, output)) {
    console.error('deckpack: input and output must be different paths');
    return 2;
  }

  let slidesText, bundleText;
  try {
    slidesText = fs.readFileSync(input, 'utf8');
    bundleText = fs.readFileSync(bundlePath, 'utf8');
  } catch (err) {
    console.error(`deckpack: failed to read input: ${err.message}`);
    return 2;
  }

  let result;
  try {
    const sectionsHtml = stripExtractHeader(slidesText);
    result = pack(bundleText, sectionsHtml);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  fs.writeFileSync(output, result, 'utf8');
  console.log(`deckpack: wrote ${output}`);
  return 0;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
