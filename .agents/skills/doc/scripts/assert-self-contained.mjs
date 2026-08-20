#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOTE_RE = /^(?:https?:)?\/\//i;
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['apos', "'"], ['colon', ':'], ['gt', '>'], ['lt', '<'],
  ['newline', '\n'], ['nbsp', ' '], ['num', '#'], ['period', '.'], ['quot', '"'],
  ['sol', '/'], ['tab', '\t'],
]);
const RESOURCE_ATTRS = new Map([
  ['script', new Set(['src'])],
  ['link', new Set(['href', 'imagesrcset'])],
  ['img', new Set(['src', 'srcset'])],
  ['source', new Set(['src', 'srcset'])],
  ['input', new Set(['src'])],
  ['video', new Set(['src', 'poster'])],
  ['audio', new Set(['src'])],
  ['track', new Set(['src'])],
  ['iframe', new Set(['src'])],
  ['frame', new Set(['src'])],
  ['embed', new Set(['src'])],
  ['object', new Set(['data'])],
  ['image', new Set(['href', 'xlink:href'])],
  ['use', new Set(['href', 'xlink:href'])],
  ['feimage', new Set(['href', 'xlink:href'])],
  ['body', new Set(['background'])],
  ['table', new Set(['background'])],
]);

function decodeCodePoint(value, radix, fallback) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try { return String.fromCodePoint(codePoint); }
  catch { return fallback; }
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][\w-]*);?/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) return decodeCodePoint(normalized.slice(2), 16, match);
    if (normalized.startsWith('#')) return decodeCodePoint(normalized.slice(1), 10, match);
    return NAMED_ENTITIES.get(normalized) ?? match;
  });
}

function decodeCssEscapes(value) {
  return String(value ?? '').replace(/\\([\da-f]{1,6}\s?|.)/gi, (match, escaped) => {
    const compact = escaped.trim();
    return /^[\da-f]{1,6}$/i.test(compact) ? decodeCodePoint(compact, 16, match) : escaped;
  });
}

function normalizedResource(value) {
  return decodeCssEscapes(decodeHtmlEntities(value)).trim().replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
}

function dataMediaType(normalized) {
  const payload = normalized.slice(5);
  const comma = payload.indexOf(',');
  return payload.slice(0, comma === -1 ? payload.length : comma).split(';', 1)[0].trim().toLowerCase();
}

function unsafeDataResource(normalized, allowData) {
  if (!/^data:/i.test(normalized)) return null;
  if (!allowData || /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(dataMediaType(normalized))) {
    return 'unsafe data';
  }
  return null;
}

function resourceViolation(value, { allowData = true, allowFragment = true, bundledResourceIds = null } = {}) {
  const normalized = normalizedResource(value);
  if (!normalized) return 'non-embedded';
  if (allowFragment && normalized.startsWith('#')) return null;
  const dataViolation = unsafeDataResource(normalized, allowData);
  if (dataViolation) return dataViolation;
  if (/^data:/i.test(normalized)) return null;
  if (bundledResourceIds?.has(normalized) && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(normalized)) return null;
  return REMOTE_RE.test(normalized) ? 'remote' : 'non-embedded';
}
function addResourceError(tag, attribute, value, errors, options) {
  if (value === undefined) return;
  const violation = resourceViolation(value, options);
  if (violation) errors.push('<' + tag + '> has ' + violation + ' ' + attribute + ': ' + value);
}
function cssResourceReferences(css, label, errors) {
  const clean = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const importRe = /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^\s;)]+))/gi;
  for (const match of clean.matchAll(importRe)) {
    const value = match[2] ?? match[3] ?? '';
    const violation = resourceViolation(value, { allowFragment: false });
    if (violation) errors.push(label + ' has ' + violation + ' @import: ' + value);
  }
  const urlRe = /url\(\s*(?:(["'])(.*?)\1|([^\s)]*))\s*\)/gi;
  for (const match of clean.matchAll(urlRe)) {
    const value = (match[2] ?? match[3] ?? '').trim();
    const violation = resourceViolation(value);
    if (violation) errors.push(label + ' has ' + violation + ' CSS url: ' + value);
  }
}

function attributesOf(openTag) {
  const attrs = new Map();
  const text = openTag.replace(/^<[^\s/>]+/, '').replace(/>$/, '');
  const attrRe = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(attrRe)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function srcsetCandidates(value) {
  const source = decodeHtmlEntities(value);
  const candidates = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) index += 1;
    if (index >= source.length) break;
    const start = index;
    const dataUrl = source.slice(index).toLowerCase().startsWith('data:');
    while (index < source.length && !/\s/.test(source[index])) {
      if (source[index] === ',' && !dataUrl) break;
      index += 1;
    }
    const candidate = source.slice(start, index).replace(dataUrl ? /\s+$/ : /,+$/, '');
    if (candidate) candidates.push(candidate);
    while (index < source.length && source[index] !== ',') index += 1;
    if (source[index] === ',') index += 1;
  }
  return candidates;
}

function scriptType(attrs) {
  return decodeHtmlEntities(attrs.get('type') ?? '').trim().toLowerCase();
}

function isActiveScript(attrs) {
  const type = scriptType(attrs);
  return !type || type === 'module' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script(?:\s*;|$)/i.test(type);
}

function inlineResourceViolation(value) {
  const normalized = normalizedResource(value);
  if (!normalized) return null;
  const dataViolation = unsafeDataResource(normalized, true);
  if (dataViolation) return dataViolation;
  return REMOTE_RE.test(normalized) ? 'remote' : null;
}

function withoutJavaScriptComments(source) {
  let result = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
      result += ' ';
      continue;
    }
    result += current;
  }
  return result;
}

function inlineScriptResourceReferences(script, label, errors) {
  const source = withoutJavaScriptComments(String(script));
  const patterns = [
    [/\b(?:fetch|import|importScripts|sendBeacon|open)\s*\(\s*(['"])(.*?)\1/gi, 2],
    [/\bnew\s+(?:Worker|SharedWorker|WebSocket|EventSource)\s*\(\s*(['"])(.*?)\1/gi, 2],
    [/\b(?:[\w$.]+\.)?open\s*\(\s*(['"])[^'"]*\1\s*,\s*(['"])(.*?)\2/gi, 3],
    [/\b(?:location|window\.location|document\.location)(?:\.(?:assign|replace))?\s*\(\s*(['"])(.*?)\1/gi, 2],
    [/\b(?:location|window\.location|document\.location)(?:\.href)?\s*=\s*(['"])(.*?)\1/gi, 2],
    [/\.\s*(?:src|href)\s*=\s*(['"])(.*?)\1/gi, 2],
    [/\bsetAttribute\s*\(\s*(['"])(?:src|href|data)\1\s*,\s*(['"])(.*?)\2/gi, 3],
    [/\bimport\s+[\s\S]{0,300}?\bfrom\s+(['"])(.*?)\1/gi, 2],
  ];
  for (const [pattern, valueIndex] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[valueIndex] ?? '';
      const violation = inlineResourceViolation(value);
      if (violation) errors.push(label + ' has ' + violation + ' active resource: ' + value);
    }
  }
}

function bundledResourceIds(html, errors) {
  const ids = new Set();
  const scriptRe = /(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptRe)) {
    if (scriptType(attributesOf(match[1])) !== '__bundler/manifest') continue;
    try {
      const manifest = JSON.parse(match[2]);
      if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('manifest must be an object');
      for (const id of Object.keys(manifest)) {
        if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) ids.add(id);
      }
    } catch (error) {
      errors.push('__bundler/manifest is not valid JSON: ' + error.message);
    }
  }
  return ids;
}

function scanBundlerValue(value, errors, depth, resourceIds) {
  if (typeof value === 'string') {
    scanDocument(value, errors, depth + 1, resourceIds);
  } else if (Array.isArray(value)) {
    for (const item of value) scanBundlerValue(item, errors, depth + 1, resourceIds);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) scanBundlerValue(item, errors, depth + 1, resourceIds);
  }
}

function scanScriptBodies(html, errors, depth, resourceIds) {
  const scriptRe = /(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi;
  for (const [index, match] of [...html.matchAll(scriptRe)].entries()) {
    const attrs = attributesOf(match[1]);
    const type = scriptType(attrs);
    if (type === '__bundler/template') {
      try { scanBundlerValue(JSON.parse(match[2]), errors, depth + 1, resourceIds); }
      catch (error) { errors.push('script[' + index + '] __bundler/template is not valid JSON: ' + error.message); }
    } else if (isActiveScript(attrs)) {
      inlineScriptResourceReferences(match[2], 'script[' + index + ']', errors);
    }
  }
}

function scanTags(html, errors, depth, resourceIds) {
  const commentsRemoved = html.replace(/<!--[\s\S]*?-->/g, '');
  scanScriptBodies(commentsRemoved, errors, depth, resourceIds);
  const scriptsRemoved = commentsRemoved.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  const styles = [...scriptsRemoved.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  for (const [index, match] of styles.entries()) cssResourceReferences(match[1], 'style[' + index + ']', errors);
  const withoutStyleBodies = scriptsRemoved.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>');
  const tagRe = /<(?!\/|!)([A-Za-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/g;
  for (const match of withoutStyleBodies.matchAll(tagRe)) {
    const tag = match[1].toLowerCase();
    const attrs = attributesOf(match[0]);
    const resourceOptions = ['script', 'object', 'embed', 'iframe', 'frame'].includes(tag) ? { allowData: false } : {};
    if (tag === 'script') resourceOptions.bundledResourceIds = resourceIds;
    for (const name of RESOURCE_ATTRS.get(tag) ?? []) {
      const value = attrs.get(name);
      if ((name === 'srcset' || name === 'imagesrcset') && value !== undefined) {
        for (const candidate of srcsetCandidates(value)) addResourceError(tag, name, candidate, errors, resourceOptions);
      } else {
        addResourceError(tag, name, value, errors, resourceOptions);
      }
    }
    if (attrs.has('style')) cssResourceReferences(attrs.get('style'), '<' + tag + '> style', errors);
    if ((tag === 'iframe' || tag === 'frame') && attrs.has('srcdoc')) {
      scanDocument(decodeHtmlEntities(attrs.get('srcdoc')), errors, depth + 1, resourceIds);
    }
    if (tag === 'base' && attrs.has('href')) {
      errors.push('<base> has disallowed href: ' + attrs.get('href'));
    }
    if (tag === 'meta' && decodeHtmlEntities(attrs.get('http-equiv')).trim().toLowerCase() === 'refresh') {
      const content = decodeHtmlEntities(attrs.get('content'));
      if (/(?:^|;)\s*url\s*=/i.test(content)) {
        const url = content.match(/(?:^|;)\s*url\s*=\s*(.*)$/i)?.[1]?.trim() ?? '';
        const violation = resourceViolation(url, { allowData: false });
        if (violation) errors.push('<meta http-equiv=refresh> has ' + violation + ' URL: ' + url);
      }
    }
  }
}

function scanDocument(html, errors, depth = 0, resourceIds = null) {
  if (depth > 8) {
    errors.push('embedded document exceeds maximum nesting depth');
    return;
  }
  scanTags(html, errors, depth, resourceIds ?? bundledResourceIds(html, errors));
}

export function validateSelfContainedHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return ['HTML must be a non-empty string'];
  const errors = [];
  scanDocument(html, errors);
  return errors;
}
function main(argv) {
  const input = argv[0];
  if (!input) {
    console.error('Usage: node assert-self-contained.mjs path/to/document.html');
    return 2;
  }
  let html;
  try { html = readFileSync(input, 'utf8'); }
  catch (error) { console.error('Cannot read HTML: ' + error.message); return 2; }
  const errors = validateSelfContainedHtml(html);
  if (errors.length) { console.error(errors.join('\n')); return 1; }
  process.stdout.write('self-contained HTML: ' + path.resolve(input) + '\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
