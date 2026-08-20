import fs from 'node:fs';
import path from 'node:path';

const EXTRACTIONS = ['text', 'typography', 'spacing', 'colors', 'layout', 'components', 'hierarchy'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanBrowserEvidence(event) {
  return isText(event.url)
    && isText(event.screenshot)
    && event.consoleErrors === 0
    && Array.isArray(event.interactions)
    && event.interactions.length > 0
    && event.interactions.every(isText)
    && event.verdict === 'pass';
}

/**
 * Validates the event order and evidence needed for an image-first web delivery.
 */
export function validateImageToCodeTrace(trace) {
  const errors = [];
  if (!isObject(trace)) {
    return ['trace must be an object'];
  }

  if (!Array.isArray(trace.sections) || trace.sections.length === 0 || !trace.sections.every(isText)) {
    errors.push('sections must be a non-empty list of names');
    return errors;
  }
  const sections = new Set(trace.sections);
  if (sections.size !== trace.sections.length) {
    errors.push('sections must not contain duplicates');
  }
  if (!isText(trace.continuityKey)) {
    errors.push('continuityKey is required');
  }
  if (!Array.isArray(trace.events) || trace.events.length === 0) {
    errors.push('events are required');
    return errors;
  }

  const references = new Map([...sections].map((section) => [section, 0]));
  const analyzed = new Set();
  let implementationSeen = false;
  let comparisonSeen = false;

  trace.events.forEach((event, index) => {
    const label = 'events[' + index + ']';
    if (!isObject(event) || !isText(event.type)) {
      errors.push(label + ' must be an event object');
      return;
    }
    if (event.type === 'crop' || event.cropped === true) {
      errors.push(label + ' must not use a crop');
      return;
    }

    if (event.type === 'reference' || event.type === 'detail') {
      if (!sections.has(event.section)) {
        errors.push(label + ' references an unknown section');
      }
      if (event.source !== 'generated' || event.fresh !== true || !isText(event.path)) {
        errors.push(label + ' must be a fresh generated image with a path');
      }
      if (event.continuityKey !== trace.continuityKey) {
        errors.push(label + ' must use the trace continuityKey');
      }
      if (implementationSeen) {
        errors.push(label + ' appears after implementation');
      }
      if (event.type === 'reference' && sections.has(event.section)) {
        references.set(event.section, references.get(event.section) + 1);
      }
      return;
    }

    if (event.type === 'analysis') {
      if (!sections.has(event.section)) {
        errors.push(label + ' analyzes an unknown section');
      } else if ((references.get(event.section) ?? 0) === 0) {
        errors.push(label + ' requires a fresh reference before analysis');
      }
      if (implementationSeen) {
        errors.push(label + ' appears after implementation');
      }
      if (!isObject(event.extractions) || !EXTRACTIONS.every((field) => event.extractions[field] === true)) {
        errors.push(label + ' must record complete deep extraction');
      }
      if (sections.has(event.section)) {
        analyzed.add(event.section);
      }
      return;
    }

    if (event.type === 'implementation') {
      if (implementationSeen) {
        errors.push(label + ' duplicates implementation');
      }
      const pending = [...sections].filter((section) => !analyzed.has(section));
      if (pending.length > 0) {
        errors.push(label + ' occurs before analysis of: ' + pending.join(', '));
      }
      if (!Array.isArray(event.files) || event.files.length === 0 || !event.files.every(isText)) {
        errors.push(label + ' must name implemented files');
      }
      implementationSeen = true;
      return;
    }

    if (event.type === 'browser-compare') {
      if (!implementationSeen) {
        errors.push(label + ' occurs before implementation');
      }
      if (!cleanBrowserEvidence(event)) {
        errors.push(label + ' must contain URL, screenshot, clean console, interaction, and pass verdict');
      }
      comparisonSeen = true;
      return;
    }

    errors.push(label + ' has an unsupported type');
  });

  for (const section of sections) {
    if ((references.get(section) ?? 0) === 0) {
      errors.push('section ' + section + ' has no fresh primary reference');
    }
    if (!analyzed.has(section)) {
      errors.push('section ' + section + ' has no analysis');
    }
  }
  if (!implementationSeen) {
    errors.push('implementation is required after analysis');
  }
  if (!comparisonSeen) {
    errors.push('browser comparison is required after implementation');
  }

  return errors;
}

function usage() {
  return 'Usage: node validate-trace.mjs <trace.json>';
}

function main(argv) {
  const filename = argv[2];
  if (!filename || filename === '--help') {
    process.stdout.write(usage() + '\n');
    return filename === '--help' ? 0 : 1;
  }

  let trace;
  try {
    trace = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
  } catch (error) {
    process.stderr.write('Cannot read trace: ' + error.message + '\n');
    return 1;
  }

  const errors = validateImageToCodeTrace(trace);
  if (errors.length > 0) {
    process.stderr.write(errors.join('\n') + '\n');
    return 1;
  }

  process.stdout.write('image-to-code trace: valid\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main(process.argv);
}
