import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateFrontendDesignEvidence } from './scripts/validate-evidence.mjs';

const directory = import.meta.dirname;
const skill = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const legacySurface = ['.', 'claude'].join('');

function validEvidence() {
  return {
    designRead: 'Marketing landing for technical buyers, calm and precise.',
    dials: { variance: 6, motion: 4, density: 3 },
    discovery: {
      applicableAgents: ['AGENTS.md'],
      packageManifest: 'package.json',
      commandsChecked: ['npm run build', 'npm run lint'],
    },
    systemMapping: {
      kind: 'aesthetic',
      name: 'Existing Tailwind implementation',
      decision: 'The product already uses this stack.',
      officialPackage: false,
    },
    dependencyEvidence: [{ name: 'tailwindcss', status: 'present' }],
    accessibility: { keyboard: true, contrast: true, reducedMotion: true },
    performance: { mediaSpaceReserved: true, noScrollStateLoop: true },
    build: { command: 'npm run build', result: 'pass' },
    browserComparison: {
      url: 'http://localhost:3000',
      screenshot: 'artifacts/landing.png',
      consoleErrors: 0,
      interactions: ['primary CTA focus and activation'],
      verdict: 'pass',
    },
    mode: 'greenfield',
  };
}

test('frontend-design is a native, discoverable frontend implementation skill', () => {
  assert.match(skill, /^---\nname: frontend-design\n/m);
  assert.match(skill, /Design Read/);
  assert.match(skill, /DESIGN_VARIANCE/);
  assert.match(skill, /MOTION_INTENSITY/);
  assert.match(skill, /VISUAL_DENSITY/);
  assert.match(skill, /AGENTS\.md/);
  assert.match(skill, /native browser surface/);
  assert.equal(skill.includes(legacySurface), false);
  assert.equal(skill.includes('codex exec'), false);
});

test('frontend-design evidence accepts a complete greenfield delivery', () => {
  assert.deepEqual(validateFrontendDesignEvidence(validEvidence()), []);
});

test('frontend-design evidence rejects missing dependency, accessibility, and browser evidence', () => {
  const evidence = validEvidence();
  delete evidence.dependencyEvidence;
  delete evidence.accessibility.reducedMotion;
  delete evidence.browserComparison;

  const errors = validateFrontendDesignEvidence(evidence).join('\n');
  assert.match(errors, /dependencyEvidence is required/);
  assert.match(errors, /accessibility\.reducedMotion must be true/);
  assert.match(errors, /browserComparison must contain/);
});

test('frontend-design mutation RED to GREEN proves reduced-motion evidence is consumed', () => {
  const evidence = validEvidence();
  evidence.accessibility.reducedMotion = false;
  assert.match(validateFrontendDesignEvidence(evidence).join('\n'), /accessibility\.reducedMotion must be true/);

  evidence.accessibility.reducedMotion = true;
  assert.deepEqual(validateFrontendDesignEvidence(evidence), []);
});

test('frontend-design requires an audit for a preservation redesign', () => {
  const evidence = validEvidence();
  evidence.mode = 'redesign-preserve';
  assert.match(validateFrontendDesignEvidence(evidence).join('\n'), /redesignAudit/);

  evidence.redesignAudit = {
    brandTokens: 'Existing blue accent and compact radius.',
    informationArchitecture: 'Keep the current conversion path and routes.',
    preservationDecision: 'Modernize spacing without changing navigation.',
  };
  assert.deepEqual(validateFrontendDesignEvidence(evidence), []);
});
