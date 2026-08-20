import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BRANDKIT_PANELS = [
  'logo-cover',
  'logo-construction',
  'digital-application',
  'brand-essence',
  'color-system',
  'typography',
  'physical-application',
  'image-direction',
  'system-detail',
];

const LAYOUTS = new Set(['3x3', '2x3', '2x2', '1x3', '4x2', 'custom']);
const IMAGE_EXTENSION = /\.(?:png|webp|jpe?g)$/i;

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

  const filename = normalized.split('/').at(-1) ?? '';
  if ((filename.match(/-/g) ?? []).length < 2) {
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

export function slugifyBrand(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'brand';
}

export function resolveBrandkitOutputPath(brand, artifact = 'overview') {
  return 'assets/brandkit-' + slugifyBrand(brand) + '-' + slugifyBrand(artifact) + '.png';
}

export function validateBrandkitPlan(plan) {
  const errors = [];
  if (plan?.kind !== 'brandkit') {
    errors.push('kind must be brandkit');
  }

  addRequiredTexts(
    plan?.strategy,
    ['category', 'audience', 'productFunction', 'emotionalPromise', 'metaphor'],
    'strategy',
    errors,
  );
  if (!Array.isArray(plan?.strategy?.avoid) || plan.strategy.avoid.length === 0) {
    errors.push('strategy.avoid must name at least one avoided direction');
  }

  if (!LAYOUTS.has(plan?.layout?.grid)) {
    errors.push('layout.grid must be a supported board layout');
  }
  if (!Array.isArray(plan?.layout?.panels) || plan.layout.panels.length === 0) {
    errors.push('layout.panels must document the board panel system');
  } else if (plan.layout.grid === '3x3' && plan.layout.panels.length !== 9) {
    errors.push('layout.panels must contain nine panels for a 3x3 overview');
  }
  if (!hasText(plan?.layout?.aspectRatio)) {
    errors.push('layout.aspectRatio must be declared');
  }

  addRequiredTexts(
    plan?.system,
    ['visualMode', 'logoConcept', 'typography', 'imageTreatment'],
    'system',
    errors,
  );
  if (!Array.isArray(plan?.system?.palette) || plan.system.palette.length < 3) {
    errors.push('system.palette must contain a controlled palette');
  }

  if (!Array.isArray(plan?.images) || plan.images.length === 0) {
    errors.push('images must contain at least one planned artifact');
  } else {
    const destinations = new Set();
    plan.images.forEach((image, index) => {
      const label = 'images[' + index + ']';
      if (!hasText(image?.id)) {
        errors.push(label + '.id must be declared');
      }
      if (!hasText(image?.prompt)) {
        errors.push(label + '.prompt must carry the art direction');
      }
      validateAssetPath(image?.outputPath, label, errors);
      validateSingleImageCall(image?.call, label, errors);
      if (hasText(image?.outputPath) && destinations.has(image.outputPath)) {
        errors.push(label + '.outputPath must be unique');
      }
      destinations.add(image?.outputPath);
    });
  }

  if (plan?.codeOutput !== false) {
    errors.push('codeOutput must be false for an image-only brandkit');
  }
  if (Array.isArray(plan?.codeFiles) && plan.codeFiles.length > 0) {
    errors.push('codeFiles must be empty for an image-only brandkit');
  }
  return errors;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node validate-brandkit-plan.mjs path/to/brandkit-plan.json');
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

  const errors = validateBrandkitPlan(plan);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('brandkit plan is valid: ' + path.resolve(inputPath) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
