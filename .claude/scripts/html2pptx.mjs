#!/usr/bin/env node
// .claude/scripts/html2pptx.mjs — convert a deck bundle/slides file (see deckpack.mjs) into
// an editable .pptx (native text boxes / shapes, not a picture-per-slide dump).
//
// Design: FAIL-LOUD. Unlike html2pdf.mjs (which skips PDF quietly when WeasyPrint is
// missing), this script must NOT silently degrade — the .pptx IS the requested deliverable.
// Missing npm deps or missing browser => print exact remediation and exit 1.
//
// Pipeline: loadDeck() parses the bundle/slides HTML + font manifest (reusing deckpack.mjs's
// parser so there is one source of truth for the bundle format) -> a single headless-browser
// page renders all sections stacked (no deck-stage viewer, so px == CSS px, no scale
// transform to undo) -> extractInPage() walks the live DOM in paint order and emits shape /
// text / image records with real layout (getBoundingClientRect / getComputedStyle) -> pptxgenjs
// turns those records into native PowerPoint shapes and text boxes.
//
// Usage: node .claude/scripts/html2pptx.mjs <in.html> <out.pptx> [--bundle <bundle.html>]
// Exit:  0 = pptx written ; 1 = LOUD failure (missing deps / missing browser / conversion
// error) ; 2 = bad args / missing input / same in-out path
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readTemplateSpan,
  extractInner,
  sliceSections,
} from './deckpack.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = path.join(SCRIPT_DIR, '..', 'skills', 'doc', 'template', 'doc.pptx.template.html');
const MANIFEST_OPEN_RE = /<script type="__bundler\/manifest"[^>]*>/;

const FONT_MAP = { 'Noto Sans JP': 'Yu Gothic', 'Noto Serif JP': 'Yu Mincho' };
const DEFAULT_FONT = 'Yu Gothic';

const PX_PER_INCH = 144;
const round4 = (n) => Math.round(n * 10000) / 10000;
const pxToIn = (px) => round4(px / PX_PER_INCH);
const pxToPt = (px) => round4(px / 2);

function usage() {
  console.error('Usage: node .claude/scripts/html2pptx.mjs <in.html> <out.pptx> [--bundle <bundle.html>]');
}

function sameFile(a, b) {
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

// ---------------------------------------------------------------------------
// loadDeck: parse the manifest (font uuid -> {buffer, mime}), the inner HTML's @font-face
// CSS block, and the list of top-level <section> slides, from either a full bundle
// (has __bundler/template) or a sections-only slides file (deckpack --extract output; in
// that case fonts/CSS are pulled from the canonical bundle).
// ---------------------------------------------------------------------------
function readManifest(bundleText) {
  const openMatch = MANIFEST_OPEN_RE.exec(bundleText);
  if (!openMatch) throw new Error('html2pptx: __bundler/manifest script tag not found in bundle');
  const start = openMatch.index + openMatch[0].length;
  const end = bundleText.indexOf('</script>', start);
  if (end === -1) throw new Error('html2pptx: __bundler/manifest script tag has no closing </script>');
  let manifest;
  try {
    manifest = JSON.parse(bundleText.slice(start, end));
  } catch (err) {
    throw new Error(`html2pptx: __bundler/manifest contents are not valid JSON: ${err.message}`);
  }
  const fonts = new Map();
  for (const [uuid, entry] of Object.entries(manifest)) {
    if (entry.compressed) continue; // JS runtime blobs, not fonts
    fonts.set(uuid, { buffer: Buffer.from(entry.data, 'base64'), mime: entry.mime });
  }
  return fonts;
}

function extractFontFaceCss(innerHtml) {
  const helmetStart = innerHtml.indexOf('<helmet>');
  const helmetEnd = innerHtml.indexOf('</helmet>');
  if (helmetStart === -1 || helmetEnd === -1) throw new Error('html2pptx: <helmet> block not found in bundle inner HTML');
  const helmet = innerHtml.slice(helmetStart, helmetEnd);
  const styleStart = helmet.indexOf('<style>');
  const styleEnd = helmet.indexOf('</style>');
  if (styleStart === -1 || styleEnd === -1) throw new Error('html2pptx: <style> block not found in <helmet>');
  return helmet.slice(styleStart + '<style>'.length, styleEnd);
}

// Split a sections HTML blob into individual top-level <section ...>...</section> chunks.
// HTML comments (e.g. deckpack's extract-header, or "=== 01 title ===" author markers) are
// blanked out for the purposes of *finding* tag boundaries, since they may contain literal
// "<section>" text that is not a real tag — but slicing still happens on the original string,
// so comments inside real sections are preserved verbatim in the output.
function splitSections(sectionsHtml) {
  const scanText = sectionsHtml.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

  const sections = [];
  const openRe = /<section\b[^>]*>/g;
  let match;
  while ((match = openRe.exec(scanText))) {
    const openTag = match[0];
    const contentStart = match.index + openTag.length;
    let depth = 1;
    const tagRe = /<section\b[^>]*>|<\/section>/g;
    tagRe.lastIndex = contentStart;
    let closeIdx = -1;
    let m2;
    while ((m2 = tagRe.exec(scanText))) {
      if (m2[0] === '</section>') {
        depth--;
        if (depth === 0) { closeIdx = m2.index; break; }
      } else {
        depth++;
      }
    }
    if (closeIdx === -1) throw new Error('html2pptx: unterminated <section> in slides input');
    const fullTag = sectionsHtml.slice(match.index, closeIdx + '</section>'.length);
    sections.push(fullTag);
    openRe.lastIndex = closeIdx + '</section>'.length;
  }
  if (sections.length === 0) throw new Error('html2pptx: no <section> slides found in input');
  return sections;
}

function loadDeck(inPath, bundlePath) {
  const inputText = fs.readFileSync(inPath, 'utf8');
  const isBundle = inputText.includes('type="__bundler/template"');

  let bundleTextForManifest, innerHtmlForFonts, sectionsHtml;
  if (isBundle) {
    bundleTextForManifest = inputText;
    const inner = extractInner(inputText);
    innerHtmlForFonts = inner;
    sectionsHtml = sliceSections(inner).sections;
  } else {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(`html2pptx: bundle not found: ${bundlePath}`);
    }
    bundleTextForManifest = fs.readFileSync(bundlePath, 'utf8');
    innerHtmlForFonts = extractInner(bundleTextForManifest);
    sectionsHtml = inputText;
  }

  const fonts = readManifest(bundleTextForManifest);
  const fontFaceCss = extractFontFaceCss(innerHtmlForFonts);
  const sections = splitSections(sectionsHtml);
  return { fonts, fontFaceCss, sections };
}

// ---------------------------------------------------------------------------
// findBrowser: PPTX_BROWSER env override, then existsSync probes for Edge/Chrome.
// puppeteer's `channel` option is not used (does not support Edge).
// ---------------------------------------------------------------------------
const BROWSER_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  if (process.env.PPTX_BROWSER) {
    if (fs.existsSync(process.env.PPTX_BROWSER)) return process.env.PPTX_BROWSER;
    return null;
  }
  for (const candidate of BROWSER_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function printBrowserNotFound() {
  console.error('html2pptx: no browser found. Probed:');
  const probed = process.env.PPTX_BROWSER ? [process.env.PPTX_BROWSER] : BROWSER_PATHS;
  for (const p of probed) console.error(`  ${p}`);
  console.error('Set PPTX_BROWSER=<path to Edge or Chrome executable> to override.');
}

// ---------------------------------------------------------------------------
// Harness page: one page, all sections stacked vertically at native 1920x1080 each. No
// deck-stage / x-dc / x-import viewer wrapper — that would apply a CSS scale transform we'd
// have to undo; skipping it means DOM px == CSS px == our coordinate system directly.
// ---------------------------------------------------------------------------
function buildHarnessHtml(sections, fontFaceCss) {
  return `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;padding:0}
body>section{display:block;width:1920px;height:1080px}
${fontFaceCss}
</style>
<body>
${sections.join('\n')}
</body>`;
}

// ---------------------------------------------------------------------------
// extractInPage: runs inside the browser page via page.evaluate. Pre-order DFS over each
// section's DOM = paint order. Returns per-slide records (shape / text / image) with rects
// relative to the section's own top-left (sections are stacked, so subtract section origin).
// ---------------------------------------------------------------------------
function inPageExtract() {
  const warnings = [];
  const sectionEls = Array.from(document.querySelectorAll('body > section'));

  function parseColor(cssColor) {
    // "rgba(r, g, b, a)" or "rgb(r, g, b)" -> {hex, alpha}
    if (!cssColor || cssColor === 'transparent') return null;
    const m = cssColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if (a === 0) return null;
    const hex = [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, alpha: a };
  }

  function borderInfo(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const info = {};
    for (const side of sides) {
      const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
      const color = width > 0 && style !== 'none' ? parseColor(cs.getPropertyValue(`border-${side.toLowerCase()}-color`)) : null;
      // a border whose color fails to parse (e.g. "transparent") is invisible -> no border
      info[side] = color ? { width, color } : null;
    }
    return info;
  }

  function uniformRadius(cs) {
    const tl = cs.getPropertyValue('border-top-left-radius');
    const tr = cs.getPropertyValue('border-top-right-radius');
    const br = cs.getPropertyValue('border-bottom-right-radius');
    const bl = cs.getPropertyValue('border-bottom-left-radius');
    if (tl === tr && tr === br && br === bl) {
      const v = parseFloat(tl);
      return v > 0 ? v : null;
    }
    return null; // non-uniform (e.g. chart bars' "6px 6px 0 0") -> caller approximates
  }

  function isImageLike(el, cs) {
    const tag = el.tagName.toUpperCase(); // SVG-namespace elements report lowercase tagName
    if (['IMG', 'SVG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(tag)) return true;
    if (cs.getPropertyValue('background-image') !== 'none') return true;
    if (cs.getPropertyValue('transform') !== 'none') return true;
    if (cs.getPropertyValue('box-shadow') !== 'none') return true;
    if (cs.getPropertyValue('clip-path') !== 'none') return true;
    return false;
  }

  function relRect(rect, originX, originY) {
    return { x: rect.left - originX, y: rect.top - originY, w: rect.width, h: rect.height };
  }

  function collapseWhitespace(s) {
    return s.replace(/\s+/g, ' ');
  }

  function runStyle(el) {
    const cs = getComputedStyle(el);
    const family = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    return {
      fontFamily: family,
      fontSizePx: parseFloat(cs.fontSize),
      weight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle === 'italic',
      color: (parseColor(cs.color) || { hex: '000000' }).hex,
      letterSpacingPx: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0,
    };
  }

  function isInlineOnly(el) {
    return Array.from(el.children).every((c) => getComputedStyle(c).display === 'inline');
  }

  function hasDirectTextNode(el) {
    return Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  }

  function collectRuns(el, runs) {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        const text = collapseWhitespace(node.textContent);
        if (text.trim() === '' && runs.length === 0) continue;
        if (text === '') continue;
        runs.push({ text, ...runStyle(el) });
      } else if (node.nodeType === 1) {
        if (node.tagName === 'BR') {
          if (runs.length > 0) runs[runs.length - 1].breakLine = true;
          else runs.push({ text: '', ...runStyle(el), breakLine: true });
        } else {
          collectRuns(node, runs);
        }
      }
    }
  }

  // Mirror of CSS line-box whitespace trimming: source HTML indentation/newlines around a
  // paragraph collapse to a single space (collectRuns/collapseWhitespace), but a browser's
  // line box trims that space at true edges (start of paragraph, end of paragraph, either
  // side of a line break). Only edges are trimmed here — a legitimate word-separator space
  // that happens to be the first character of an *interior* run (e.g. the text run right
  // after a `<b>` tag) is untouched, since it is not the first/last run overall.
  function trimRunEdges(runs) {
    if (runs.length === 0) return runs;
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].breakLine) {
        runs[i].text = runs[i].text.replace(/\s+$/, '');
        if (runs[i + 1]) runs[i + 1].text = runs[i + 1].text.replace(/^\s+/, '');
      }
    }
    return runs;
  }

  function textAlign(el, contentRect) {
    const cs = getComputedStyle(el);
    const ta = cs.textAlign;
    if (ta === 'center' || ta === 'right' || ta === 'justify') return ta;
    // Multi-line heuristic: compare line rects' edges against content box (2px tolerance)
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    if (rects.length <= 1) return 'left';
    const tol = 2;
    const allCentered = rects.every((r) => {
      const gapL = r.left - contentRect.left;
      const gapR = (contentRect.left + contentRect.width) - r.right;
      return Math.abs(gapL - gapR) <= tol && gapL > tol;
    });
    if (allCentered) return 'center';
    const allRight = rects.every((r) => Math.abs((contentRect.left + contentRect.width) - r.right) <= tol);
    if (allRight) return 'right';
    return 'left';
  }

  function lineHeightRatio(cs) {
    const lh = cs.lineHeight;
    if (lh === 'normal') return null;
    const px = parseFloat(lh);
    const fs = parseFloat(cs.fontSize);
    if (!px || !fs) return null;
    return round(px / fs, 4);
  }
  function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

  const slides = sectionEls.map((section, sectionIdx) => {
    const secRect = section.getBoundingClientRect();
    const secCs = getComputedStyle(section);
    const records = [];
    let imgCounter = 0;

    function walk(el, parentOpacity) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const opacity = parentOpacity * (parseFloat(cs.opacity) || 0);
      if (opacity === 0) return;
      if (cs.zIndex !== 'auto') warnings.push(`slide ${sectionIdx + 1}: z-index=${cs.zIndex} on <${el.tagName.toLowerCase()}> (paint-order approximation may be off)`);

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        // zero-area = "don't draw me", not "don't draw my descendants" (e.g. a height:0
        // wrapper with an absolutely-positioned child) -> still walk children, emit nothing
        for (const child of Array.from(el.children)) walk(child, opacity);
        return;
      }

      if (isImageLike(el, cs)) {
        imgCounter++;
        el.dataset.pptxImg = String(imgCounter);
        records.push({ type: 'image', id: imgCounter, rect: relRect(rect, secRect.left, secRect.top) });
        return; // subtree-terminal
      }

      // shape: background-color or visible border
      const bg = parseColor(cs.backgroundColor);
      const borders = borderInfo(cs);
      const sideVals = Object.values(borders).filter(Boolean);
      const hasBorder = sideVals.length > 0;
      const allSame = hasBorder && ['Top', 'Right', 'Bottom', 'Left'].every((s) =>
        (!!borders[s]) === (!!borders.Top) &&
        (!borders[s] || (borders[s].width === borders.Top.width && borders[s].color?.hex === borders.Top.color?.hex))
      );

      if (bg || hasBorder) {
        const boxRect = relRect(rect, secRect.left, secRect.top);
        const radius = uniformRadius(cs);
        if (hasBorder && !allSame) {
          if (bg) records.push({ type: 'shape', rect: boxRect, fill: { color: bg.hex, alpha: bg.alpha * opacity }, line: null, radiusPx: null });
          const bw = { Top: borders.Top?.width || 0, Right: borders.Right?.width || 0, Bottom: borders.Bottom?.width || 0, Left: borders.Left?.width || 0 };
          if (borders.Bottom) records.push({ type: 'shape', rect: { x: boxRect.x, y: boxRect.y + boxRect.h - bw.Bottom, w: boxRect.w, h: bw.Bottom }, fill: { color: borders.Bottom.color.hex, alpha: opacity }, line: null, radiusPx: null });
          if (borders.Top) records.push({ type: 'shape', rect: { x: boxRect.x, y: boxRect.y, w: boxRect.w, h: bw.Top }, fill: { color: borders.Top.color.hex, alpha: opacity }, line: null, radiusPx: null });
          if (borders.Left) records.push({ type: 'shape', rect: { x: boxRect.x, y: boxRect.y, w: bw.Left, h: boxRect.h }, fill: { color: borders.Left.color.hex, alpha: opacity }, line: null, radiusPx: null });
          if (borders.Right) records.push({ type: 'shape', rect: { x: boxRect.x + boxRect.w - bw.Right, y: boxRect.y, w: bw.Right, h: boxRect.h }, fill: { color: borders.Right.color.hex, alpha: opacity }, line: null, radiusPx: null });
        } else {
          records.push({
            type: 'shape',
            rect: boxRect,
            fill: bg ? { color: bg.hex, alpha: bg.alpha * opacity } : null,
            line: allSame ? { color: borders.Top.color.hex, widthPx: borders.Top.width } : null,
            radiusPx: radius,
          });
        }
      }

      const directText = hasDirectTextNode(el);
      const inlineOnly = isInlineOnly(el);
      const hasBlockChildren = Array.from(el.children).some((c) => getComputedStyle(c).display !== 'inline');

      if (directText && hasBlockChildren) {
        warnings.push(`slide ${sectionIdx + 1}: mixed block+text children on <${el.tagName.toLowerCase()}> — using per-text-node fallback`);
        // fallback: emit each direct text node as its own box via Range rects
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === 3 && node.textContent.trim() !== '') {
            const r = document.createRange();
            r.selectNodeContents(node);
            const rects = Array.from(r.getClientRects());
            for (const rr of rects) {
              records.push({
                type: 'text',
                rect: relRect(rr, secRect.left, secRect.top),
                runs: trimRunEdges([{ text: collapseWhitespace(node.textContent), ...runStyle(el) }]),
                align: 'left',
                lineHeightRatio: lineHeightRatio(cs),
              });
            }
          }
        }
        for (const child of Array.from(el.children)) walk(child, opacity);
        return;
      }

      if (directText || (el.children.length > 0 && inlineOnly)) {
        const cbLeft = rect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const cbTop = rect.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
        const cbWidth = rect.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        const cbHeight = rect.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.paddingTop) - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
        const contentRect = { left: cbLeft, top: cbTop, width: cbWidth, height: cbHeight };
        const runs = [];
        collectRuns(el, runs);
        trimRunEdges(runs);
        if (runs.length > 0) {
          records.push({
            type: 'text',
            rect: relRect({ left: cbLeft, top: cbTop, width: cbWidth, height: cbHeight }, secRect.left, secRect.top),
            runs,
            align: textAlign(el, contentRect),
            lineHeightRatio: lineHeightRatio(cs),
          });
        }
        return; // inline subtree fully consumed as one text block
      }

      for (const child of Array.from(el.children)) walk(child, opacity);
    }

    for (const child of Array.from(section.children)) walk(child, 1);

    const bg = parseColor(secCs.backgroundColor);
    if (secCs.getPropertyValue('background-image') !== 'none') {
      warnings.push(`slide ${sectionIdx + 1}: section has a background-image/gradient — not extracted, slide falls back to solid background`);
    }
    return {
      records,
      background: bg ? bg.hex : null,
      label: section.getAttribute('data-label') || null,
      notes: section.getAttribute('data-speaker-notes') || null,
    };
  });

  return { slides, warnings };
}

// ---------------------------------------------------------------------------
// emitPptx: pptxgenjs specifics. 1920x1080px deck -> 13.333x7.5in custom layout (the
// built-in LAYOUT_16x9 is 10in wide, not 13.333in, so it is not used).
// ---------------------------------------------------------------------------
async function emitPptx(PptxGenJS, deckData, outPath) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DECK', width: 13.333, height: 7.5 });
  pptx.layout = 'DECK';

  const counts = { shape: 0, text: 0, image: 0 };

  for (const slideData of deckData.slides) {
    const label = slideData.label || undefined;
    if (label) pptx.addSection({ title: label });
    const slide = label ? pptx.addSlide({ sectionTitle: label }) : pptx.addSlide();

    if (slideData.background) slide.background = { color: slideData.background };
    if (slideData.notes) slide.addNotes(slideData.notes);

    for (const rec of slideData.records) {
      if (rec.type === 'shape') {
        counts.shape++;
        const opts = {
          x: pxToIn(rec.rect.x), y: pxToIn(rec.rect.y), w: pxToIn(rec.rect.w), h: pxToIn(rec.rect.h),
        };
        if (rec.fill) opts.fill = { color: rec.fill.color, transparency: round4((1 - rec.fill.alpha) * 100) };
        else opts.fill = { type: 'none' };
        if (rec.line) opts.line = { color: rec.line.color, width: pxToPt(rec.line.widthPx) };
        const shapeType = rec.radiusPx ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
        if (rec.radiusPx) opts.rectRadius = pxToIn(rec.radiusPx);
        slide.addShape(shapeType, opts);
      } else if (rec.type === 'text') {
        counts.text++;
        const runs = rec.runs.map((r) => ({
          text: r.text,
          options: {
            fontFace: FONT_MAP[r.fontFamily] || DEFAULT_FONT,
            fontSize: pxToPt(r.fontSizePx),
            color: r.color,
            bold: r.weight >= 600,
            italic: r.italic,
            charSpacing: r.letterSpacingPx ? round4(r.letterSpacingPx / 2) : undefined,
            breakLine: !!r.breakLine,
          },
        }));
        const opts = {
          x: pxToIn(rec.rect.x), y: pxToIn(rec.rect.y), w: pxToIn(rec.rect.w), h: pxToIn(rec.rect.h),
          align: rec.align, valign: 'top', margin: 0, wrap: true,
        };
        if (rec.lineHeightRatio) opts.lineSpacingMultiple = rec.lineHeightRatio;
        slide.addText(runs, opts);
      } else if (rec.type === 'image') {
        counts.image++;
        slide.addImage({
          data: `image/png;base64,${rec.data}`,
          x: pxToIn(rec.rect.x), y: pxToIn(rec.rect.y), w: pxToIn(rec.rect.w), h: pxToIn(rec.rect.h),
        });
      }
    }
  }

  await pptx.writeFile({ fileName: outPath });
  return counts;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(argv) {
  const positional = [];
  let bundlePath = DEFAULT_BUNDLE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') { bundlePath = argv[i + 1]; i++; }
    else positional.push(argv[i]);
  }
  const [inPath, outPath] = positional;
  if (!inPath || !outPath) { usage(); return 2; }
  if (!fs.existsSync(inPath)) {
    console.error(`html2pptx: input not found: ${inPath}`);
    return 2;
  }
  if (sameFile(inPath, outPath)) {
    console.error('html2pptx: input and output must be different paths');
    return 2;
  }

  let deck;
  try {
    deck = loadDeck(inPath, bundlePath);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    printBrowserNotFound();
    return 1;
  }

  let PptxGenJS, puppeteer;
  try {
    ({ default: PptxGenJS } = await import('pptxgenjs'));
    ({ default: puppeteer } = await import('puppeteer-core'));
  } catch (err) {
    console.error('html2pptx: dependencies not installed.');
    console.error('cd .claude/scripts && npm install');
    console.error(err.message);
    return 1;
  }

  const abortedUrls = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--force-color-profile=srgb'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);

    const harnessHtml = buildHarnessHtml(deck.sections, deck.fontFaceCss);

    page.on('request', (request) => {
      const url = request.url();
      if (url === 'http://deck.local/') {
        request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: harnessHtml });
        return;
      }
      const uuid = url.startsWith('http://deck.local/') ? url.slice('http://deck.local/'.length) : null;
      if (uuid && deck.fonts.has(uuid)) {
        const font = deck.fonts.get(uuid);
        request.respond({ status: 200, contentType: 'font/woff2', body: font.buffer });
        return;
      }
      if (url !== 'http://deck.local/favicon.ico') abortedUrls.push(url); // browser-generated, not a real leak
      request.abort();
    });

    await page.goto('http://deck.local/', { waitUntil: 'networkidle0' });

    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.fonts.status === 'loading') await document.fonts.ready;
    });

    const { slides, warnings } = await page.evaluate(inPageExtract);
    if (slides.length !== deck.sections.length) {
      throw new Error(`html2pptx: extracted ${slides.length} slide(s) but input had ${deck.sections.length} <section> — extraction mismatch`);
    }

    // capture image-fallback screenshots (elementHandle.screenshot, outside page.evaluate)
    for (let i = 0; i < slides.length; i++) {
      for (const rec of slides[i].records) {
        if (rec.type !== 'image') continue;
        const handle = await page.$(`section:nth-of-type(${i + 1}) [data-pptx-img="${rec.id}"]`);
        if (!handle) throw new Error(`html2pptx: image element not found for slide ${i + 1} record ${rec.id} (data-pptx-img lookup failed)`);
        const buf = await handle.screenshot({ type: 'png' });
        rec.data = buf.toString('base64');
      }
    }

    await browser.close();
    browser = null;

    const counts = await emitPptx(PptxGenJS, { slides }, outPath);

    console.log(`html2pptx: wrote ${outPath}`);
    console.log(`html2pptx: ${slides.length} slides — shapes:${counts.shape} text:${counts.text} images:${counts.image}`);
    if (warnings.length) {
      console.log(`html2pptx: ${warnings.length} extraction warning(s):`);
      for (const w of warnings) console.log(`  ${w}`);
    }
    if (abortedUrls.length) {
      console.log(`html2pptx: ${abortedUrls.length} request(s) aborted (self-containment guard):`);
      for (const u of [...new Set(abortedUrls)]) console.log(`  ${u}`);
    }
    return 0;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`html2pptx: conversion failed: ${err.message}`);
    console.error(err.stack);
    return 1;
  }
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
