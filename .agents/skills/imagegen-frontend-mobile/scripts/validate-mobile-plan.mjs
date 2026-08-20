import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = new Set(['ios-native', 'android-native', 'cross-platform']);
const IMAGE_EXTENSION = /\.(?:png|webp|jpe?g)$/i;
const BIBLE_FIELDS = [
  'deviceFrame',
  'deviceScale',
  'palette',
  'typography',
  'spacing',
  'radius',
  'iconography',
  'imagery',
  'texture',
  'navigation',
  'components',
  'buttons',
  'shadows',
];

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addRequiredTexts(object, keys, prefix, errors) {
  for (const key of keys) {
    if (!hasText(object?.[key])) {
      errors.push(prefix + '.' + key + ' must be a non-empty string');
    }
  }
}

function validateAssetPath(value, label, errors) {
  if (!hasText(value)) {
    errors.push(label + '.outputPath must be a non-empty relative asset path');
    return;
  }

  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('~/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    errors.push(label + '.outputPath must stay inside the workspace assets directory');
  }
  if (!normalized.split('/').includes('assets')) {
    errors.push(label + '.outputPath must be under an assets directory');
  }
  if (!IMAGE_EXTENSION.test(normalized)) {
    errors.push(label + '.outputPath must name an image file');
  }
  if (!(normalized.split('/').at(-1) ?? '').includes('-')) {
    errors.push(label + '.outputPath filename must be descriptive');
  }
}

function validateSingleImageCall(call, label, errors) {
  if (call?.tool !== 'imagegen') {
    errors.push(label + '.call.tool must be imagegen');
    return;
  }
  if (
    call.outputs !== 1 ||
    call.batch === true ||
    (Array.isArray(call.images) && call.images.length !== 1)
  ) {
    errors.push(label + '.call must describe exactly one imagegen output');
  }
}

function validatePresentation(presentation, errors) {
  if (typeof presentation?.showDeviceFrame !== 'boolean') {
    errors.push('presentation.showDeviceFrame must be declared');
    return;
  }
  if (presentation.showDeviceFrame) {
    addRequiredTexts(presentation, ['frameStyle'], 'presentation', errors);
    if (presentation.contentPrimary !== true) {
      errors.push('presentation.contentPrimary must be true when a frame is shown');
    }
  } else if (!hasText(presentation.borderlessReason)) {
    errors.push('presentation.borderlessReason is required without a device frame');
  }
}

export function validateMobilePlan(plan) {
  const errors = [];
  if (plan?.kind !== 'mobile-reference') {
    errors.push('kind must be mobile-reference');
  }
  if (!PLATFORMS.has(plan?.platform)) {
    errors.push('platform must be ios-native, android-native, or cross-platform');
  }

  addRequiredTexts(plan?.designBible, BIBLE_FIELDS, 'designBible', errors);
  if (!hasText(plan?.continuityKey)) {
    errors.push('continuityKey must lock the shared mobile design system');
  }
  validatePresentation(plan?.presentation, errors);

  if (!Array.isArray(plan?.screens) || plan.screens.length === 0) {
    errors.push('screens must contain one complete image plan per screen');
  } else {
    const ids = new Set();
    const destinations = new Set();

    plan.screens.forEach((screen, index) => {
      const label = 'screens[' + index + ']';
      addRequiredTexts(screen, ['id', 'name', 'purpose', 'prompt', 'continuityKey'], label, errors);
      if (screen?.format !== 'portrait') {
        errors.push(label + '.format must be portrait');
      }
      if (screen?.complete !== true) {
        errors.push(label + '.complete must be true for a standalone screen');
      }
      if (hasText(screen?.croppedFrom) || screen?.source === 'crop') {
        errors.push(label + ' must be a fresh screen image, not a crop');
      }
      if (screen?.safeAreas?.top !== true || screen?.safeAreas?.bottom !== true) {
        errors.push(label + '.safeAreas must reserve top and bottom system regions');
      }
      if (!hasText(screen?.navigation)) {
        errors.push(label + '.navigation must state a believable mobile path');
      }
      if (hasText(plan?.continuityKey) && screen?.continuityKey !== plan.continuityKey) {
        errors.push(label + '.continuityKey must match the locked design bible');
      }
      validateAssetPath(screen?.outputPath, label, errors);
      validateSingleImageCall(screen?.call, label, errors);

      if (hasText(screen?.id) && ids.has(screen.id)) {
        errors.push(label + '.id must be unique');
      }
      if (hasText(screen?.outputPath) && destinations.has(screen.outputPath)) {
        errors.push(label + '.outputPath must be unique');
      }
      ids.add(screen?.id);
      destinations.add(screen?.outputPath);
    });
  }

  if (!Array.isArray(plan?.flow?.screenIds) || plan.flow.screenIds.length !== plan?.screens?.length) {
    errors.push('flow.screenIds must describe every planned screen in order');
  } else {
    const actualIds = plan.screens.map((screen) => screen?.id);
    if (plan.flow.screenIds.some((id, index) => id !== actualIds[index])) {
      errors.push('flow.screenIds must preserve the declared screen order');
    }
  }
  if (!hasText(plan?.flow?.rationale)) {
    errors.push('flow.rationale must explain the user journey');
  }

  if (plan?.codeOutput !== false) {
    errors.push('codeOutput must be false for image-only mobile references');
  }
  if (Array.isArray(plan?.codeFiles) && plan.codeFiles.length > 0) {
    errors.push('codeFiles must be empty for image-only mobile references');
  }
  return errors;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node validate-mobile-plan.mjs path/to/mobile-plan.json');
    process.exitCode = 2;
    return;
  }

  let plan;
  try {
    plan = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    console.error('Cannot read plan: ' + error.message);
    process.exitCode = 2;
    return;
  }

  const errors = validateMobilePlan(plan);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('mobile image plan is valid: ' + path.resolve(inputPath) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
