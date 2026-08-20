import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATEGORIES = new Set([
  'DEAD_CODE',
  'DUPLICATE',
  'OVER_ABSTRACTION',
  'DEFENSIVE_EXCESS',
  'COMMENT_NOISE',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isComment(text) {
  return /(?:^|\s)(?:\/\/|\/\*|\*|#|<!--)/.test(text);
}

/** Comment forms that must be retained because a person or machine may rely on them. */
export function isProtectedComment(text) {
  if (!hasText(text) || !isComment(text)) return false;
  return /\b(?:TODO|FIXME|HACK)\b|@[\w-]+|\beslint-(?:disable|enable)\b|\b(?:pragma|openapi|swagger|docgen|codegen|generated|istanbul\s+ignore|c8\s+ignore)\b/i.test(text);
}

/** Parse actual unified-diff lines instead of trusting precomputed addition/removal counts. */
export function analyzeUnifiedDiff(unified) {
  const additions = [];
  const removals = [];
  const normalized = typeof unified === 'string' ? unified.replace(/\r\n/g, '\n') : '';
  for (const line of normalized.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) additions.push(line.slice(1));
    if (line.startsWith('-')) removals.push(line.slice(1));
  }
  return {
    additions,
    removals,
    protectedRemovals: removals.filter(isProtectedComment),
    hasHunk: /^@@ /m.test(normalized),
  };
}

function validateRun(record, label, expectedStatus, errors) {
  if (!isObject(record)) {
    errors.push(label + ' is required');
    return;
  }
  if (record.status !== expectedStatus) errors.push(label + '.status must be ' + expectedStatus);
  if (!hasText(record.command)) errors.push(label + '.command is required');
  if (!hasText(record.evidence)) errors.push(label + '.evidence is required');
}

function validateDeletionDiff(diff, label, errors, { requireRemoval } = { requireRemoval: true }) {
  if (!isObject(diff) || typeof diff.unified !== 'string') {
    errors.push(label + '.diff.unified is required');
    return;
  }
  const analysis = analyzeUnifiedDiff(diff.unified);
  if (requireRemoval && !analysis.hasHunk) errors.push(label + '.diff.unified must contain a unified-diff hunk');
  if (analysis.additions.length > 0) errors.push(label + ' adds lines; cleaner passes must be deletion-only');
  if (requireRemoval && analysis.removals.length === 0) errors.push(label + ' must remove at least one line');
  if (analysis.protectedRemovals.length > 0) {
    errors.push(label + ' removes protected comment(s): ' + analysis.protectedRemovals.join(' | '));
  }
  if (Array.isArray(diff.machineReadRemovals) && diff.machineReadRemovals.length > 0) {
    errors.push(label + ' removes comments marked machine-read');
  }
}

/**
 * Validate the evidence for one-category, deletion-only cleanup passes. A trace is only evidence:
 * it does not authorize changes outside the target the user selected.
 */
export function validateCleanerTrace(trace) {
  const errors = [];
  if (!isObject(trace)) return ['trace must be an object'];
  if (!hasText(trace.author)) errors.push('author is required');
  validateRun(trace.baseline, 'baseline', 'pass', errors);

  if (!Array.isArray(trace.passes) || trace.passes.length === 0) {
    errors.push('passes must contain at least one category-isolated pass');
  } else {
    const passIds = new Set();
    trace.passes.forEach((pass, index) => {
      const label = 'passes[' + index + ']';
      if (!isObject(pass)) {
        errors.push(label + ' must be an object');
        return;
      }
      if (!hasText(pass.id) || passIds.has(pass.id)) errors.push(label + '.id must be unique');
      passIds.add(pass.id);
      if (!CATEGORIES.has(pass.category)) errors.push(label + '.category must name exactly one supported category');
      validateDeletionDiff(pass.diff, label, errors, { requireRemoval: true });

      if (pass.outcome === 'passed') {
        validateRun(pass.verification, label + '.verification', 'pass', errors);
      } else if (pass.outcome === 'failed') {
        validateRun(pass.verification, label + '.verification', 'fail', errors);
        if (!isObject(pass.rollback)) {
          errors.push(label + ' failed without rollback evidence');
        } else {
          if (pass.rollback.passId !== pass.id) errors.push(label + '.rollback must restore only its own pass');
          if (pass.rollback.scope !== 'own-pass') errors.push(label + '.rollback.scope must be own-pass');
          if (pass.rollback.status !== 'restored') errors.push(label + '.rollback.status must be restored');
          if (!hasText(pass.rollback.evidence)) errors.push(label + '.rollback.evidence is required');
        }
      } else {
        errors.push(label + '.outcome must be passed or failed');
      }
    });
  }

  validateRun(trace.final, 'final', 'pass', errors);
  validateDeletionDiff(trace.final?.diff, 'final', errors, { requireRemoval: false });

  if (!isObject(trace.independentVerification)) {
    errors.push('independentVerification is required');
  } else {
    validateRun(trace.independentVerification, 'independentVerification', 'pass', errors);
    if (trace.independentVerification.role !== 'verifier') errors.push('independentVerification.role must be verifier');
    if (!hasText(trace.independentVerification.actor) || trace.independentVerification.actor === trace.author) {
      errors.push('independentVerification.actor must differ from author');
    }
  }
  return errors;
}

function main(argv) {
  const input = argv[2];
  if (!input || input === '--help') {
    process.stdout.write('Usage: node validate-cleaner-trace.mjs path/to/cleaner-trace.json\n');
    return input === '--help' ? 0 : 2;
  }
  let trace;
  try {
    trace = JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    process.stderr.write('Cannot read trace: ' + error.message + '\n');
    return 2;
  }
  const errors = validateCleanerTrace(trace);
  if (errors.length > 0) {
    process.stderr.write(errors.join('\n') + '\n');
    return 1;
  }
  process.stdout.write('code-cleaner trace: valid\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
