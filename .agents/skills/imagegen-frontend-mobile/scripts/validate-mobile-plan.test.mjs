import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMobilePlan } from './validate-mobile-plan.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validPlan() {
  const continuityKey = 'lumen-ios-v1';
  const screenSpecs = [
    ['welcome', 'Welcome', 'introduce the value', 'continue to sign-in'],
    ['sign-in', 'Sign in', 'authenticate the user', 'submit credentials to home'],
    ['home', 'Home', 'show the personalized start state', 'tab navigation'],
  ];

  return {
    kind: 'mobile-reference',
    platform: 'ios-native',
    designBible: {
      deviceFrame: 'subtle iPhone frame',
      deviceScale: 'consistent medium',
      palette: 'ink, mist, lime accent',
      typography: 'refined system sans',
      spacing: 'generous 8-point rhythm',
      radius: 'medium controlled radius',
      iconography: 'custom rounded glyphs',
      imagery: 'cinematic wellness photography',
      texture: 'soft film grain',
      navigation: 'tab bar plus stack',
      components: 'media cards and settings cells',
      buttons: 'high-contrast primary action',
      shadows: 'soft controlled elevation',
    },
    continuityKey,
    presentation: {
      showDeviceFrame: true,
      frameStyle: 'iPhone',
      contentPrimary: true,
    },
    screens: screenSpecs.map(([id, name, purpose, navigation], index) => ({
      id,
      name,
      purpose,
      prompt: 'Complete portrait ' + id + ' screen for the locked Lumen app.',
      continuityKey,
      format: 'portrait',
      complete: true,
      croppedFrom: null,
      safeAreas: { top: true, bottom: true },
      navigation,
      outputPath: 'assets/lumen/screens/' + String(index + 1).padStart(2, '0') + '-' + id + '.png',
      call: { tool: 'imagegen', outputs: 1 },
    })),
    flow: {
      screenIds: ['welcome', 'sign-in', 'home'],
      rationale: 'A new user learns the product, signs in, then reaches home.',
    },
    codeOutput: false,
  };
}

test('accepts platform-aware complete screens with a coherent flow', () => {
  assert.deepEqual(validateMobilePlan(validPlan()), []);
});

test('rejects a missing platform, incomplete screen, and crop route', () => {
  const plan = validPlan();
  delete plan.platform;
  plan.screens[1].complete = false;
  plan.screens[1].croppedFrom = 'assets/lumen/overview.png';

  const errors = validateMobilePlan(plan).join('\n');
  assert.match(errors, /platform must be/);
  assert.match(errors, /complete must be true/);
  assert.match(errors, /fresh screen image, not a crop/);
});

test('rejects unsafe areas, missing navigation, flow gaps, and broken continuity', () => {
  const plan = clone(validPlan());
  plan.screens[0].safeAreas.bottom = false;
  plan.screens[1].navigation = '';
  plan.screens[2].continuityKey = 'drifted-system';
  plan.flow.screenIds = ['welcome', 'sign-in'];

  const errors = validateMobilePlan(plan).join('\n');
  assert.match(errors, /safeAreas/);
  assert.match(errors, /navigation/);
  assert.match(errors, /continuityKey must match/);
  assert.match(errors, /flow.screenIds/);
});

test('rejects a batched or repeated screen output and code side effects', () => {
  const plan = clone(validPlan());
  plan.screens[1].call.outputs = 2;
  plan.screens[2].outputPath = plan.screens[0].outputPath;
  plan.codeOutput = true;
  plan.codeFiles = ['mobile/App.tsx'];

  const errors = validateMobilePlan(plan).join('\n');
  assert.match(errors, /exactly one imagegen output/);
  assert.match(errors, /outputPath must be unique/);
  assert.match(errors, /codeOutput/);
  assert.match(errors, /codeFiles/);
});
