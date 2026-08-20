import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateImageToCodeTrace } from './scripts/validate-trace.mjs';

const directory = import.meta.dirname;
const skill = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const legacySurface = ['.', 'claude'].join('');

function extraction() {
  return {
    text: true,
    typography: true,
    spacing: true,
    colors: true,
    layout: true,
    components: true,
    hierarchy: true,
  };
}

function validTrace() {
  return {
    sections: ['hero', 'proof'],
    continuityKey: 'northern-light-v1',
    events: [
      { type: 'reference', section: 'hero', source: 'generated', fresh: true, path: 'assets/references/hero.png', continuityKey: 'northern-light-v1' },
      { type: 'reference', section: 'proof', source: 'generated', fresh: true, path: 'assets/references/proof.png', continuityKey: 'northern-light-v1' },
      { type: 'analysis', section: 'hero', extractions: extraction() },
      { type: 'analysis', section: 'proof', extractions: extraction() },
      { type: 'implementation', files: ['src/app/page.tsx'] },
      {
        type: 'browser-compare',
        url: 'http://localhost:3000',
        screenshot: 'artifacts/compare.png',
        consoleErrors: 0,
        interactions: ['primary CTA focus and activation'],
        verdict: 'pass',
      },
    ],
  };
}

test('image-to-code is a native image-first skill with no legacy provider bridge', () => {
  assert.match(skill, /^---\nname: image-to-code\n/m);
  assert.match(skill, /fresh, large, analyzable reference/);
  assert.match(skill, /Never crop/);
  assert.match(skill, /native browser surface/);
  assert.match(skill, /\$frontend-design/);
  assert.equal(skill.includes(legacySurface), false);
  assert.equal(skill.includes('codex exec'), false);
});

test('image-to-code trace accepts fresh references, deep analysis, implementation, then comparison', () => {
  assert.deepEqual(validateImageToCodeTrace(validTrace()), []);
});

test('image-to-code trace rejects implementation before analysis', () => {
  const trace = validTrace();
  const implementation = trace.events.splice(4, 1)[0];
  trace.events.splice(2, 0, implementation);

  assert.match(validateImageToCodeTrace(trace).join('\n'), /occurs before analysis/);
});

test('image-to-code trace rejects crops and missing browser comparison', () => {
  const trace = validTrace();
  trace.events[0].cropped = true;
  trace.events.pop();

  const errors = validateImageToCodeTrace(trace).join('\n');
  assert.match(errors, /must not use a crop/);
  assert.match(errors, /browser comparison is required/);
});

test('image-to-code mutation RED to GREEN proves the analysis gate is consumed', () => {
  const trace = validTrace();
  trace.events[2].extractions.spacing = false;
  assert.match(validateImageToCodeTrace(trace).join('\n'), /complete deep extraction/);

  trace.events[2].extractions.spacing = true;
  assert.deepEqual(validateImageToCodeTrace(trace), []);
});
