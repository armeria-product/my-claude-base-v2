#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSelfContainedHtml } from './assert-self-contained.mjs';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function sameFile(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function explicitModuleRoots() {
  const configured = process.env.CODEX_NODE_MODULES;
  if (!configured) return null;
  return configured.split(path.delimiter).filter(Boolean);
}

export function resolveRuntimeModule(names) {
  const roots = explicitModuleRoots();
  for (const name of names) {
    try {
      if (roots) {
        for (const root of roots) {
          for (const candidate of [path.join(root, name), path.join(root, 'node_modules', name)]) {
            try { return require.resolve(candidate); } catch { /* try another local root */ }
          }
        }
      } else {
        return require.resolve(name, { paths: [process.cwd(), SCRIPT_DIR] });
      }
    } catch { /* try next package */ }
  }
  return null;
}

async function loadPlaywright() {
  const resolved = resolveRuntimeModule(['playwright', 'playwright-core']);
  if (!resolved) return null;
  const loaded = await import(pathToFileURL(resolved).href);
  return loaded.default ?? loaded;
}

function setupMessage() {
  return 'Set CODEX_NODE_MODULES to a local directory containing playwright (or playwright-core); set PDF_BROWSER to an Edge or Chrome executable when no bundled browser is available.';
}

function temporaryOutput(output) {
  const parsed = path.parse(output);
  return path.join(parsed.dir || '.', '.' + parsed.name + '.codex-' + process.pid + '.tmp.pdf');
}

export async function convertHtmlToPdf(input, output) {
  const html = readFileSync(input, 'utf8');
  const lintErrors = validateSelfContainedHtml(html);
  if (lintErrors.length) return { status: 'invalid', errors: lintErrors };

  let playwright;
  try { playwright = await loadPlaywright(); }
  catch (error) { return { status: 'skipped', reason: 'cannot load Playwright: ' + error.message }; }
  if (!playwright?.chromium) return { status: 'skipped', reason: 'Playwright is not installed' };

  const browserPath = process.env.PDF_BROWSER;
  if (browserPath && !existsSync(browserPath)) return { status: 'skipped', reason: 'PDF_BROWSER does not exist: ' + browserPath };

  let browser;
  let temp;
  try {
    browser = await playwright.chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    const page = await browser.newPage();
    const blocked = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/^(?:https?:)?\/\//i.test(url)) { blocked.push(url); return route.abort(); }
      return route.continue();
    });
    await page.setContent(html, { waitUntil: 'load' });
    if (blocked.length) throw new Error('blocked remote request(s): ' + [...new Set(blocked)].join(', '));
    temp = temporaryOutput(output);
    await page.pdf({ path: temp, format: 'A4', printBackground: true });
    copyFileSync(temp, output);
    rmSync(temp, { force: true });
    return { status: 'written', output };
  } catch (error) {
    if (temp) rmSync(temp, { force: true });
    return { status: 'skipped', reason: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main(argv) {
  const [input, output] = argv;
  if (!input || !output) {
    console.error('Usage: node .agents/skills/doc/scripts/html2pdf.mjs <input.html> <output.pdf>');
    return 2;
  }
  if (!existsSync(input)) { console.error('html2pdf: input not found: ' + input); return 2; }
  if (sameFile(input, output)) { console.error('html2pdf: input and output must differ'); return 2; }
  let result;
  try { result = await convertHtmlToPdf(input, output); }
  catch (error) { console.error('html2pdf: cannot read input: ' + error.message); return 2; }
  if (result.status === 'written') { process.stdout.write('html2pdf: wrote ' + output + '\n'); return 0; }
  if (result.status === 'invalid') { console.error(result.errors.join('\n')); return 1; }
  process.stdout.write('html2pdf: skipped (fail-open): ' + result.reason + '\n');
  process.stdout.write('html2pdf: HTML is kept: ' + input + '\n');
  process.stdout.write('html2pdf: ' + setupMessage() + '\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
