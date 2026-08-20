import fs from 'node:fs';
import path from 'node:path';

const DIALS = ['variance', 'motion', 'density'];
const ACCESSIBILITY_FIELDS = ['keyboard', 'contrast', 'reducedMotion'];
const PERFORMANCE_FIELDS = ['mediaSpaceReserved', 'noScrollStateLoop'];
const REDESIGN_MODES = new Set(['redesign-preserve', 'redesign-overhaul']);
const DEPENDENCY_STATUSES = new Set(['present', 'install-command-proposed', 'not-required']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireTrue(container, field, errors, label) {
  if (!isObject(container) || container[field] !== true) {
    errors.push(label + ' must be true');
  }
}

/**
 * Validates the evidence that makes a frontend-design delivery reviewable.
 * The function is deliberately data-only so tests and callers can use temporary fixtures.
 */
export function validateFrontendDesignEvidence(evidence) {
  const errors = [];

  if (!isObject(evidence)) {
    return ['evidence must be an object'];
  }

  if (!isText(evidence.designRead)) {
    errors.push('designRead is required');
  }

  if (!isObject(evidence.dials)) {
    errors.push('dials are required');
  } else {
    for (const dial of DIALS) {
      const value = evidence.dials[dial];
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        errors.push('dials.' + dial + ' must be an integer from 1 through 10');
      }
    }
  }

  const discovery = evidence.discovery;
  if (!isObject(discovery)) {
    errors.push('discovery is required');
  } else {
    if (!Array.isArray(discovery.applicableAgents) || discovery.applicableAgents.length === 0 || !discovery.applicableAgents.every(isText)) {
      errors.push('discovery.applicableAgents must record applicable AGENTS files');
    }
    if (!isText(discovery.packageManifest)) {
      errors.push('discovery.packageManifest is required');
    }
    if (!Array.isArray(discovery.commandsChecked) || discovery.commandsChecked.length === 0 || !discovery.commandsChecked.every(isText)) {
      errors.push('discovery.commandsChecked is required');
    }
  }

  const systemMapping = evidence.systemMapping;
  if (!isObject(systemMapping) || !isText(systemMapping.name) || !isText(systemMapping.decision)) {
    errors.push('systemMapping name and decision are required');
  } else if (systemMapping.kind === 'official') {
    if (!isText(systemMapping.package) || systemMapping.packageVerified !== true) {
      errors.push('official systemMapping requires verified package evidence');
    }
  } else if (systemMapping.kind === 'aesthetic') {
    if (systemMapping.officialPackage !== false) {
      errors.push('aesthetic systemMapping must state officialPackage: false');
    }
  } else {
    errors.push('systemMapping.kind must be official or aesthetic');
  }

  if (!Array.isArray(evidence.dependencyEvidence) || evidence.dependencyEvidence.length === 0) {
    errors.push('dependencyEvidence is required');
  } else {
    evidence.dependencyEvidence.forEach((item, index) => {
      if (!isObject(item) || !isText(item.name) || !DEPENDENCY_STATUSES.has(item.status)) {
        errors.push('dependencyEvidence[' + index + '] needs a name and verified status');
      }
    });
  }

  for (const field of ACCESSIBILITY_FIELDS) {
    requireTrue(evidence.accessibility, field, errors, 'accessibility.' + field);
  }
  for (const field of PERFORMANCE_FIELDS) {
    requireTrue(evidence.performance, field, errors, 'performance.' + field);
  }

  if (!isObject(evidence.build) || !isText(evidence.build.command) || evidence.build.result !== 'pass') {
    errors.push('build must contain a passing command');
  }

  const browser = evidence.browserComparison;
  if (!isObject(browser) || !isText(browser.url) || !isText(browser.screenshot) || browser.consoleErrors !== 0
      || !Array.isArray(browser.interactions) || browser.interactions.length === 0 || !browser.interactions.every(isText)
      || browser.verdict !== 'pass') {
    errors.push('browserComparison must contain URL, screenshot, clean console, interaction, and pass verdict');
  }

  if (!isText(evidence.mode)) {
    errors.push('mode is required');
  } else if (REDESIGN_MODES.has(evidence.mode)) {
    const audit = evidence.redesignAudit;
    if (!isObject(audit) || !isText(audit.brandTokens) || !isText(audit.informationArchitecture) || !isText(audit.preservationDecision)) {
      errors.push('redesignAudit must record brand tokens, information architecture, and preservation decision');
    }
  } else if (evidence.mode !== 'greenfield') {
    errors.push('mode must be greenfield, redesign-preserve, or redesign-overhaul');
  }

  return errors;
}

function usage() {
  return 'Usage: node validate-evidence.mjs <evidence.json>';
}

function main(argv) {
  const filename = argv[2];
  if (!filename || filename === '--help') {
    process.stdout.write(usage() + '\n');
    return filename === '--help' ? 0 : 1;
  }

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
  } catch (error) {
    process.stderr.write('Cannot read evidence: ' + error.message + '\n');
    return 1;
  }

  const errors = validateFrontendDesignEvidence(evidence);
  if (errors.length > 0) {
    process.stderr.write(errors.join('\n') + '\n');
    return 1;
  }

  process.stdout.write('frontend-design evidence: valid\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main(process.argv);
}
