import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BRANDKIT_PANELS,
  resolveBrandkitOutputPath,
  validateBrandkitPlan,
} from './validate-brandkit-plan.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validPlan() {
  return {
    kind: 'brandkit',
    strategy: {
      category: 'developer tool',
      audience: 'platform engineers',
      productFunction: 'coordinates build work',
      emotionalPromise: 'calm precision',
      metaphor: 'a scaffold becoming a signal',
      avoid: ['generic lightning bolts'],
    },
    layout: {
      grid: '3x3',
      aspectRatio: '4:3',
      panels: [...DEFAULT_BRANDKIT_PANELS],
    },
    system: {
      visualMode: 'dark builder',
      palette: ['charcoal', 'cyan', 'coral', 'fog'],
      logoConcept: 'negative-space frame and path',
      typography: 'refined grotesk with mono accents',
      imageTreatment: 'cinematic product detail with restrained grain',
    },
    images: [
      {
        id: 'overview',
        outputPath: resolveBrandkitOutputPath('Orbit Forge', 'overview'),
        call: { tool: 'imagegen', outputs: 1 },
        prompt: 'Premium 3 by 3 brandkit overview for Orbit Forge.',
      },
    ],
    codeOutput: false,
  };
}

test('accepts a strategy-first image-only 3x3 brandkit plan', () => {
  const plan = validPlan();
  assert.equal(plan.images[0].outputPath, 'assets/brandkit-orbit-forge-overview.png');
  assert.deepEqual(validateBrandkitPlan(plan), []);
});

test('rejects missing strategy and panel-system evidence', () => {
  const plan = validPlan();
  plan.strategy.metaphor = '';
  plan.strategy.avoid = [];
  plan.layout.panels = [];

  const errors = validateBrandkitPlan(plan).join('\n');
  assert.match(errors, /strategy.metaphor/);
  assert.match(errors, /strategy.avoid/);
  assert.match(errors, /layout.panels/);
});

test('rejects unsafe paths, batched calls, and code side effects', () => {
  const plan = clone(validPlan());
  plan.images[0].outputPath = '../brandkit.png';
  plan.images[0].call.outputs = 2;
  plan.codeOutput = true;
  plan.codeFiles = ['src/brand.ts'];

  const errors = validateBrandkitPlan(plan).join('\n');
  assert.match(errors, /workspace assets directory/);
  assert.match(errors, /exactly one imagegen output/);
  assert.match(errors, /codeOutput/);
  assert.match(errors, /codeFiles/);
});
