import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE_EXTENSION = /\.(?:png|webp|jpe?g)$/i;
const CONTINUITY_KEYS = [
  'palette',
  'typography',
  'ctaFamily',
  'radiusLanguage',
  'imageTreatment',
  'tonalVoice',
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
  const filename = normalized.split('/').at(-1) ?? '';
  if (!filename.includes('-')) {
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

function requireDistinct(values, label, expectedCount, errors) {
  if (!Array.isArray(values) || values.length !== expectedCount) {
    errors.push(label + ' must contain exactly ' + expectedCount + ' entries');
    return;
  }
  if (values.some((value) => !hasText(value)) || new Set(values).size !== values.length) {
    errors.push(label + ' entries must be distinct non-empty strings');
  }
}

export function resolveWebSectionCount(request, requestedSections) {
  if (Number.isInteger(requestedSections) && requestedSections > 0) {
    return requestedSections;
  }

  const normalized = String(request ?? '').toLowerCase();
  if (/\bhero\b/.test(normalized)) {
    return 1;
  }
  if (/\b(?:landing(?: page)?|site template|product page|portfolio)\b/.test(normalized)) {
    return 6;
  }
  if (/\b(?:full(?:\s+marketing)?\s+(?:website|site)|marketing\s+(?:website|site)|website)\b/.test(normalized)) {
    return 8;
  }
  return null;
}

export function validateWebPlan(plan) {
  const errors = [];
  if (plan?.kind !== 'web-reference') {
    errors.push('kind must be web-reference');
  }

  addRequiredTexts(plan?.site, ['name', 'type', 'conversionGoal'], 'site', errors);
  addRequiredTexts(plan?.continuity, CONTINUITY_KEYS, 'continuity', errors);
  addRequiredTexts(
    plan?.global,
    ['heroScale', 'narrativeSpine', 'secondReadMoment'],
    'global',
    errors,
  );
  requireDistinct(plan?.global?.signatureComponents, 'global.signatureComponents', 4, errors);
  requireDistinct(plan?.global?.motionCues, 'global.motionCues', 2, errors);

  if (!Array.isArray(plan?.sections) || plan.sections.length === 0) {
    errors.push('sections must contain one image plan per site section');
  } else {
    const expectedSections = resolveWebSectionCount(plan?.site?.type, plan?.requestedSections);
    if (expectedSections !== null && plan.sections.length !== expectedSections) {
      errors.push(
        'site request requires exactly ' + expectedSections + ' sections',
      );
    }

    if (
      Number.isInteger(plan.requestedSections) &&
      plan.requestedSections !== plan.sections.length
    ) {
      errors.push('requestedSections must equal the number of sections');
    }

    const ids = new Set();
    const destinations = new Set();
    const anchors = new Set();
    const backgrounds = new Set();

    plan.sections.forEach((section, index) => {
      const label = 'sections[' + index + ']';
      addRequiredTexts(
        section,
        ['id', 'name', 'role', 'anchor', 'background', 'cta', 'prompt'],
        label,
        errors,
      );
      if (section?.format !== 'horizontal') {
        errors.push(label + '.format must be horizontal');
      }
      validateAssetPath(section?.outputPath, label, errors);
      validateSingleImageCall(section?.call, label, errors);

      if (hasText(section?.id) && ids.has(section.id)) {
        errors.push(label + '.id must be unique');
      }
      if (hasText(section?.outputPath) && destinations.has(section.outputPath)) {
        errors.push(label + '.outputPath must be unique');
      }
      ids.add(section?.id);
      destinations.add(section?.outputPath);
      if (hasText(section?.anchor)) anchors.add(section.anchor);
      if (hasText(section?.background)) backgrounds.add(section.background);
    });

    if (plan.sections.length >= 3 && anchors.size < 3) {
      errors.push('multi-section sites need at least three composition anchors');
    }
    if (plan.sections.length > 1 && backgrounds.size < 2) {
      errors.push('multi-section sites need varied background modes');
    }
    const hasAtmosphere = [...backgrounds].some((value) =>
      /(full-bleed|duotone|atmospheric)/i.test(value),
    );
    if (!plan?.site?.minimal && plan.sections.length > 1 && !hasAtmosphere) {
      errors.push('non-minimal multi-section sites need one atmospheric image background');
    }
  }

  if (plan?.codeOutput !== false) {
    errors.push('codeOutput must be false for image-only web references');
  }
  if (Array.isArray(plan?.codeFiles) && plan.codeFiles.length > 0) {
    errors.push('codeFiles must be empty for image-only web references');
  }
  return errors;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node validate-web-plan.mjs path/to/web-plan.json');
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

  const errors = validateWebPlan(plan);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write('web image plan is valid: ' + path.resolve(inputPath) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
