#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractInner, sliceSections } from './deckpack.mjs';
import { validateSelfContainedHtml } from './assert-self-contained.mjs';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = path.join(SCRIPT_DIR, '..', 'assets', 'doc.pptx.template.html');
const PX_PER_INCH = 144;

function sameFile(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function roots() {
  return process.env.CODEX_NODE_MODULES ? process.env.CODEX_NODE_MODULES.split(path.delimiter).filter(Boolean) : null;
}

export function resolveRuntimeModule(names) {
  const configured = roots();
  for (const name of names) {
    try {
      if (configured) {
        for (const root of configured) {
          for (const candidate of [path.join(root, name), path.join(root, 'node_modules', name)]) {
            try { return require.resolve(candidate); } catch { /* next local candidate */ }
          }
        }
      } else {
        return require.resolve(name, { paths: [process.cwd(), SCRIPT_DIR] });
      }
    } catch { /* next package */ }
  }
  return null;
}

async function loadModule(names) {
  const resolved = resolveRuntimeModule(names);
  if (!resolved) return null;
  const loaded = await import(pathToFileURL(resolved).href);
  return loaded.default ?? loaded;
}

function splitSections(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, (match) => ' '.repeat(match.length));
  const sections = [];
  const open = /<section\b[^>]*>/gi;
  let match;
  while ((match = open.exec(source))) {
    const contentStart = match.index + match[0].length;
    const tags = /<section\b[^>]*>|<\/section>/gi;
    tags.lastIndex = contentStart;
    let depth = 1;
    let close = -1;
    let nested;
    while ((nested = tags.exec(source))) {
      if (nested[0].toLowerCase() === '</section>') {
        depth--;
        if (depth === 0) { close = nested.index; break; }
      } else depth++;
    }
    if (close === -1) throw new Error('html2pptx: unterminated <section>');
    sections.push(html.slice(match.index, close + '</section>'.length));
    open.lastIndex = close + '</section>'.length;
  }
  if (!sections.length) throw new Error('html2pptx: no <section> slides found');
  return sections;
}

export function loadDeckSections(inputPath, bundlePath = DEFAULT_BUNDLE) {
  const input = readFileSync(inputPath, 'utf8');
  const lintErrors = validateSelfContainedHtml(input);
  if (lintErrors.length) throw new Error('html2pptx: input is not self-contained: ' + lintErrors.join('; '));
  if (input.includes('type="__bundler/template"')) return splitSections(sliceSections(extractInner(input)).sections);
  if (!existsSync(bundlePath)) throw new Error('html2pptx: canonical deck bundle not found: ' + bundlePath);
  return splitSections(input);
}

function rgbToHex(value) {
  const parts = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return parts ? parts.slice(1).map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

async function extractSlides(playwright, sections, browserPath) {
  const browser = await playwright.chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const blocked = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/^(?:https?:)?\/\//i.test(url)) { blocked.push(url); return route.abort(); }
      return route.continue();
    });
    await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}body>section{display:block;width:1920px;min-height:1080px;box-sizing:border-box;overflow:hidden}</style>' + sections.join('\n'), { waitUntil: 'load' });
    if (blocked.length) throw new Error('html2pptx: blocked remote request(s): ' + [...new Set(blocked)].join(', '));
    const slides = await page.locator('body > section').evaluateAll((elements) => elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        index,
        text: (element.innerText || element.textContent || '').replace(/\s+\n/g, '\n').trim(),
        background: style.backgroundColor,
        color: style.color,
        fontFamily: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        fontSize: Number.parseFloat(style.fontSize) || 24,
        rect: { width: rect.width || 1920, height: rect.height || 1080 },
      };
    }));
    return slides;
  } finally {
    await browser.close();
  }
}

async function emitPptx(PptxGenJS, slides, output) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'CODEX_DECK', width: 13.333, height: 7.5 });
  pptx.layout = 'CODEX_DECK';
  for (const item of slides) {
    const slide = pptx.addSlide();
    const background = rgbToHex(item.background);
    if (background) slide.background = { color: background };
    const color = rgbToHex(item.color) ?? '111111';
    const fontSize = Math.max(10, Math.min(28, item.fontSize / 2));
    slide.addText(item.text || ' ', {
      x: 0.36,
      y: 0.30,
      w: 12.60,
      h: 6.90,
      fontFace: item.fontFamily || 'Yu Gothic',
      fontSize,
      color,
      margin: 0,
      breakLine: false,
      valign: 'top',
      fit: 'shrink',
    });
  }
  await pptx.writeFile({ fileName: output });
}

function setupMessage() {
  return 'Set CODEX_NODE_MODULES to a local directory containing playwright (or playwright-core) and pptxgenjs; set PPTX_BROWSER to an Edge or Chrome executable when no bundled browser is available.';
}

export async function convertDeckToPptx(input, output, bundle = DEFAULT_BUNDLE) {
  const sections = loadDeckSections(input, bundle);
  const playwright = await loadModule(['playwright', 'playwright-core']);
  const PptxGenJS = await loadModule(['pptxgenjs']);
  if (!playwright?.chromium || !PptxGenJS) throw new Error('html2pptx: dependencies not installed. ' + setupMessage());
  const browserPath = process.env.PPTX_BROWSER;
  if (browserPath && !existsSync(browserPath)) throw new Error('html2pptx: PPTX_BROWSER does not exist: ' + browserPath);
  const slides = await extractSlides(playwright, sections, browserPath);
  await emitPptx(PptxGenJS, slides, output);
  return { slides: slides.length, output };
}

async function main(argv) {
  const positional = [];
  let bundle = DEFAULT_BUNDLE;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--bundle') bundle = argv[++index];
    else positional.push(argv[index]);
  }
  const [input, output] = positional;
  if (!input || !output) { console.error('Usage: node .agents/skills/doc/scripts/html2pptx.mjs <input.html> <output.pptx> [--bundle <bundle.html>]'); return 2; }
  if (!existsSync(input)) { console.error('html2pptx: input not found: ' + input); return 2; }
  if (sameFile(input, output)) { console.error('html2pptx: input and output must differ'); return 2; }
  try {
    const result = await convertDeckToPptx(input, output, bundle);
    process.stdout.write('html2pptx: wrote ' + result.output + ' (' + result.slides + ' editable text slide(s))\n');
    return 0;
  } catch (error) {
    console.error(error.message);
    console.error(setupMessage());
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
