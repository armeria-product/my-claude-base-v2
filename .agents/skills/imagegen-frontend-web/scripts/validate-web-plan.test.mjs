import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveWebSectionCount,
  validateWebPlan,
} from './validate-web-plan.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validPlan() {
  const sections = [
    ['hero', 'Hook', 'centered statement', 'full-bleed image'],
    ['trust', 'Proof', 'top-left lead', 'technical grid'],
    ['features', 'Educate', 'off-grid editorial offset', 'editorial side image'],
    ['showcase', 'Demonstrate', 'bottom-left over image', 'duotone photo'],
    ['testimonials', 'Reassure', 'stacked center', 'solid surface'],
    ['cta', 'Convert', 'bottom-right CTA cluster', 'color block'],
  ].map(([id, role, anchor, background], index) => ({
    id,
    name: id,
    role,
    anchor,
    background,
    cta: index === 5 ? 'primary banner' : 'outline link',
    format: 'horizontal',
    outputPath: 'assets/orbit-site/sections/' + String(index + 1).padStart(2, '0') + '-' + id + '.png',
    call: { tool: 'imagegen', outputs: 1 },
    prompt: 'Horizontal ' + id + ' section for one locked Orbit brand system.',
  }));

  return {
    kind: 'web-reference',
    requestedSections: 6,
    site: {
      name: 'Orbit',
      type: 'developer-tool landing page',
      conversionGoal: 'start a workspace',
      minimal: false,
    },
    continuity: {
      palette: 'ink, fog, cyan',
      typography: 'refined grotesk and mono accents',
      ctaFamily: 'square-edged action controls',
      radiusLanguage: 'small consistent radius',
      imageTreatment: 'desaturated editorial product crops',
      tonalVoice: 'calm technical confidence',
    },
    global: {
      heroScale: 'mid editorial',
      narrativeSpine: 'precision instrument',
      secondReadMoment: 'narrow vertical note rail',
      signatureComponents: [
        'product UI panel stack',
        'off-grid editorial layout',
        'oversized metrics strip',
        'layered image crop frames',
      ],
      motionCues: ['parallax image drift energy', 'cinematic fade-through energy'],
    },
    sections,
    codeOutput: false,
  };
}

test('resolves landing and full-site defaults and accepts six separate calls', () => {
  assert.equal(resolveWebSectionCount('landing page'), 6);
  assert.equal(resolveWebSectionCount('full website template'), 8);
  assert.equal(resolveWebSectionCount('hero'), 1);
  assert.deepEqual(validateWebPlan(validPlan()), []);
});

test('enforces inferred section counts while preserving an explicit count override', () => {
  for (const [type, expected] of [
    ['landing page', 6],
    ['product page', 6],
    ['portfolio', 6],
    ['full website', 8],
    ['marketing site', 8],
    ['full marketing website', 8],
    ['landing', 6],
    ['website', 8],
    ['hero', 1],
  ]) {
    const plan = validPlan();
    delete plan.requestedSections;
    plan.site.type = type;
    plan.sections = plan.sections.slice(0, expected === 1 ? 2 : expected - 1);
    assert.match(
      validateWebPlan(plan).join('\n'),
      new RegExp('site request requires exactly ' + expected + ' sections'),
      type,
    );
  }

  const explicitOverride = validPlan();
  explicitOverride.site.type = 'full marketing website';
  explicitOverride.requestedSections = 2;
  explicitOverride.sections = explicitOverride.sections.slice(0, 2);
  assert.deepEqual(validateWebPlan(explicitOverride), []);
});

test('rejects a batched section output', () => {
  const plan = validPlan();
  plan.sections[2].call.outputs = 2;

  assert.match(
    validateWebPlan(plan).join('\n'),
    /sections\[2\]\.call must describe exactly one imagegen output/,
  );
});

test('rejects a plan without continuity evidence', () => {
  const plan = clone(validPlan());
  plan.continuity.palette = '';

  assert.match(validateWebPlan(plan).join('\n'), /continuity.palette/);
});

test('rejects a code side effect and repeated destination', () => {
  const plan = clone(validPlan());
  plan.codeOutput = true;
  plan.codeFiles = ['app/page.tsx'];
  plan.sections[5].outputPath = plan.sections[0].outputPath;

  const errors = validateWebPlan(plan).join('\n');
  assert.match(errors, /codeOutput/);
  assert.match(errors, /codeFiles/);
  assert.match(errors, /outputPath must be unique/);
});
