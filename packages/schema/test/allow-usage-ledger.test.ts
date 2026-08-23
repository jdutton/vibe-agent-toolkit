import { describe, expect, it } from 'vitest';

import type { ValidationConfig } from '../src/validation-config.js';
import {
  allowUnusedIssues,
  createAllowUsageLedger,
  runSingleUnitValidation,
  runValidationFramework,
  type FrameworkResult,
} from '../src/validation-framework.js';
import type { ValidationIssue } from '../src/validation-issue.js';

const CODE = 'LINK_OUTSIDE_PROJECT';
const MATCHED_BY_ONE_UNIT = 'skills/alpha/**';
const MATCHED_BY_NO_UNIT = 'skills/ghost/**';
const ALPHA_SKILL = 'skills/alpha/SKILL.md';
const BETA_SKILL = 'skills/beta/SKILL.md';

/**
 * One config, package-scoped, exactly as an adopter declares it: `validation.allow`
 * is read once for the whole package, while validation runs once per skill.
 */
const config: ValidationConfig = {
  allow: {
    [CODE]: [
      { paths: [MATCHED_BY_ONE_UNIT], reason: 'alpha deliberately links out of the package' },
      { paths: [MATCHED_BY_NO_UNIT], reason: 'stale entry, nothing in the run matches it' },
    ],
  },
};

const issue = (location: string): ValidationIssue => ({
  severity: 'error',
  code: CODE,
  message: `${CODE} at ${location}`,
  location,
});

/**
 * A run over TWO skills where only the first matches the first allow entry.
 *
 * Two is the minimum that can tell the fix from the bug: with a single skill the
 * run-level and per-skill answers coincide, so a one-skill fixture would pass
 * either way.
 */
function twoSkillRun(cfg: ValidationConfig = config): {
  unitResults: FrameworkResult[];
  runIssues: ValidationIssue[];
  /** Everything the run reports — what a `vat skills validate` user actually sees. */
  reported: ValidationIssue[];
} {
  const ledger = createAllowUsageLedger();
  const unitResults = [
    runValidationFramework([issue(ALPHA_SKILL)], cfg, ledger),
    runValidationFramework([issue(BETA_SKILL)], cfg, ledger),
  ];
  const runIssues = allowUnusedIssues(ledger);
  return {
    unitResults,
    runIssues,
    reported: [...unitResults.flatMap(r => r.emitted), ...runIssues],
  };
}

const unusedFor = (issues: readonly ValidationIssue[], paths: string): ValidationIssue[] =>
  issues.filter(i => i.code === 'ALLOW_UNUSED' && i.message.includes(paths));

describe('ALLOW_UNUSED is a run-level verdict, not a per-unit one', () => {
  // Asserted over everything the run reports, not just the run-level slot: the
  // defect was per-skill EMISSION, so a gate that only reads the drained set
  // would stay green while every non-matching skill still printed the warning.
  it('does not report an entry one skill matched as unused', () => {
    const { reported } = twoSkillRun();
    expect(unusedFor(reported, MATCHED_BY_ONE_UNIT)).toHaveLength(0);
  });

  // The other direction, deliberately: a fix that simply stopped emitting the
  // code would satisfy the assertion above while destroying the warning's value.
  it('still reports an entry NO skill matched, exactly once for the run', () => {
    const { reported } = twoSkillRun();
    expect(unusedFor(reported, MATCHED_BY_NO_UNIT)).toHaveLength(1);
  });

  it('never emits ALLOW_UNUSED from a single unit of work', () => {
    const { unitResults } = twoSkillRun();
    for (const result of unitResults) {
      expect(result.emitted.filter(i => i.code === 'ALLOW_UNUSED')).toHaveLength(0);
    }
  });

  it('is order-independent — the matching skill validated last still counts', () => {
    const ledger = createAllowUsageLedger();
    runValidationFramework([issue(BETA_SKILL)], config, ledger);
    runValidationFramework([issue(ALPHA_SKILL)], config, ledger);
    expect(unusedFor(allowUnusedIssues(ledger), MATCHED_BY_ONE_UNIT)).toHaveLength(0);
  });

  it('resolves the run-level issue at the configured severity', () => {
    const { runIssues } = twoSkillRun({ ...config, severity: { ALLOW_UNUSED: 'error' } });
    const [dead] = unusedFor(runIssues, MATCHED_BY_NO_UNIT);
    expect(dead?.severity).toBe('error');
  });

  it('drops the run-level issue entirely when ALLOW_UNUSED is ignored', () => {
    const { runIssues } = twoSkillRun({ ...config, severity: { ALLOW_UNUSED: 'ignore' } });
    expect(runIssues).toHaveLength(0);
  });
});

describe('runSingleUnitValidation', () => {
  it('folds the run-level ALLOW_UNUSED into its own emitted set', () => {
    const result = runSingleUnitValidation([issue(ALPHA_SKILL)], config);
    expect(unusedFor(result.emitted, MATCHED_BY_NO_UNIT)).toHaveLength(1);
    expect(unusedFor(result.emitted, MATCHED_BY_ONE_UNIT)).toHaveLength(0);
  });

  it('reports hasErrors when a run-level ALLOW_UNUSED is promoted to error', () => {
    const result = runSingleUnitValidation([], {
      allow: { [CODE]: [{ paths: [MATCHED_BY_NO_UNIT], reason: 'stale' }] },
      severity: { ALLOW_UNUSED: 'error' },
    });
    expect(result.hasErrors).toBe(true);
  });
});
