/**
 * Unit tests for the shared severity/issue-set renderer AND every skills-lane
 * renderer built on it (`vat skills validate`, `vat skills build`,
 * `vat skills package`, `vat claude plugin build`).
 *
 * All four lanes are exercised in this one file on purpose: they share the
 * `ValidationIssue` / `PackagingValidationResult` / `PackageSkillResult` fixture
 * builders below, and splitting them across files would duplicate those builders
 * — which this repo's zero-tolerance duplication gate would (correctly) reject.
 *
 * Every assertion here is over the WHOLE rendered set, never a named subset: a
 * test that checks one finding cannot catch a renderer that drops a severity
 * class, and dropping a severity class is precisely the defect this module was
 * extracted to fix.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import type {
  PackageSkillResult,
  PackagingValidationResult,
  ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import { describe, expect, it } from 'vitest';

import { summarizePackagedSkillIssues } from '../../src/commands/claude/plugin/build.js';
import {
  buildYamlSummary,
  formatPostBuildIssueReport,
  formatPreBuildIssueReport,
} from '../../src/commands/skills/build.js';
import { formatSkillValidationLines } from '../../src/commands/skills/package.js';
import {
  buildValidateSummary,
  formatSkillProgressLine,
  formatValidationReportLines,
} from '../../src/commands/skills/validate.js';
import {
  collectPostBuildIssues,
  formatIssueLines,
  formatIssueSetHeading,
  formatSeverityBreakdown,
  severityLabel,
  sumSeverityCounts,
} from '../../src/utils/issue-rendering.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  extras: Partial<ValidationIssue> = {},
): ValidationIssue {
  return {
    code: code as ValidationIssue['code'],
    severity,
    message: `${code} happened`,
    ...extras,
  };
}

/** A PackagingValidationResult carrying `issues` as its emitted set. */
function packagingResult(
  skillName: string,
  issues: ValidationIssue[],
  excludedReferences: Array<{ path: string; reason: 'gitignored' }> = [],
): PackagingValidationResult {
  return {
    skillName,
    // The real two-valued gate verdict: `error` iff there is an active error.
    status: issues.some((i) => i.severity === 'error') ? 'error' : 'success',
    allErrors: issues,
    activeErrors: issues.filter((i) => i.severity === 'error'),
    activeWarnings: issues.filter((i) => i.severity === 'warning'),
    ignoredErrors: [],
    observations: [],
    evidence: [],
    metadata: {
      skillLines: 1,
      totalLines: 1,
      fileCount: 1,
      directFileCount: 0,
      maxLinkDepth: 0,
      excludedReferenceCount: excludedReferences.length,
      excludedReferences,
    },
  };
}

/** A PackageSkillResult carrying the two independent post-build channels. */
function packageResult(
  postBuildIssues: ValidationIssue[] | undefined,
  postBuildValidationIssues: ValidationIssue[] | undefined,
): PackageSkillResult {
  const result: PackageSkillResult = {
    outputPath: '/out/skill',
    skill: { name: 'probe' },
    files: { root: 'SKILL.md', dependencies: [] },
    // Mirrors the packager: the OR of both channels.
    hasErrors: [...(postBuildIssues ?? []), ...(postBuildValidationIssues ?? [])].some(
      (i) => i.severity === 'error',
    ),
  };
  if (postBuildIssues) result.postBuildIssues = postBuildIssues;
  if (postBuildValidationIssues) {
    result.postBuildValidation = packagingResult('probe', postBuildValidationIssues);
  }
  return result;
}

/** A skill-validator ValidationResult. */
function validationResult(issues: ValidationIssue[], status: ValidationResult['status']): ValidationResult {
  return {
    path: '/src/SKILL.md',
    type: 'agent-skill',
    status,
    summary: `${issues.length} finding(s)`,
    issues,
    issueCounts: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
  };
}

/** Every `[SEVERITY]`-prefixed label present in a rendered set, in order. */
function renderedLabels(lines: string[]): string[] {
  return lines.flatMap((line) => /^\s*\[([A-Z]+)]/.exec(line)?.slice(1, 2) ?? []);
}

// ---------------------------------------------------------------------------
// The shared renderer
// ---------------------------------------------------------------------------

describe('severityLabel', () => {
  it('renders every severity as itself, info included', () => {
    // The whole vocabulary, not the two the old ternary could express.
    expect(
      (['error', 'warning', 'info', 'ignore'] as const).map((s) => severityLabel(s)),
    ).toEqual(['ERROR', 'WARNING', 'INFO', 'IGNORED']);
  });
});

describe('formatSeverityBreakdown', () => {
  it('names only the non-zero buckets', () => {
    expect(formatSeverityBreakdown({ errors: 1, warnings: 2, info: 3 })).toBe(
      '1 error, 2 warnings, 3 info',
    );
    expect(formatSeverityBreakdown({ errors: 0, warnings: 0, info: 4 })).toBe('4 info');
    expect(formatSeverityBreakdown({ errors: 2, warnings: 0, info: 0 })).toBe('2 errors');
  });

  it('says so out loud when there is nothing, rather than returning an empty string', () => {
    expect(formatSeverityBreakdown({ errors: 0, warnings: 0, info: 0 })).toBe('no findings');
  });
});

describe('formatIssueSetHeading', () => {
  it('does not call a mixed set by its worst severity', () => {
    const issues = [issue('error', 'A'), issue('warning', 'B'), issue('info', 'C')];
    // The defect: the whole set was labelled "post-build error(s)".
    expect(formatIssueSetHeading(issues, 'post-build')).toBe(
      '3 post-build issues (1 error, 1 warning, 1 info)',
    );
  });

  it('does not call an info-only set warnings', () => {
    expect(formatIssueSetHeading([issue('info', 'C')], 'post-build')).toBe(
      '1 post-build issue (1 info)',
    );
  });

  it('omits the qualifier when none is given', () => {
    expect(formatIssueSetHeading([issue('warning', 'B')])).toBe('1 issue (1 warning)');
  });
});

describe('formatIssueLines', () => {
  it('prefixes each issue with its OWN severity', () => {
    const issues = [issue('error', 'A'), issue('warning', 'B'), issue('info', 'C')];
    expect(issues.map((i) => formatIssueLines(i)[0])).toEqual([
      '[ERROR] [A] A happened',
      '[WARNING] [B] B happened',
      '[INFO] [C] C happened',
    ]);
  });

  it('renders anchor and fix under the indent', () => {
    expect(
      formatIssueLines(
        issue('info', 'C', { location: 'skills/SKILL.md', line: 9, fix: 'do the thing' }),
        '  ',
      ),
    ).toEqual([
      '  [INFO] [C] C happened',
      '    Location: skills/SKILL.md:9',
      '    Fix: do the thing',
    ]);
  });

  it('omits the anchor line entirely when the issue has no anchor', () => {
    expect(formatIssueLines(issue('warning', 'B'))).toEqual(['[WARNING] [B] B happened']);
  });
});

describe('collectPostBuildIssues', () => {
  it('reads BOTH channels, so a postBuildValidation-only failure is not silent', () => {
    // The defect: hasErrors is the OR of both channels, but only
    // `postBuildIssues` was ever rendered — a build failing purely on
    // postBuildValidation printed no issue text at all.
    const result = packageResult(undefined, [issue('error', 'BUILT_ONLY')]);
    expect(result.hasErrors).toBe(true);
    expect(collectPostBuildIssues(result).map((i) => i.code)).toEqual(['BUILT_ONLY']);
  });

  it('keeps every issue from both channels, info included', () => {
    const result = packageResult(
      [issue('info', 'FRAMEWORK_INFO'), issue('warning', 'FRAMEWORK_WARN')],
      [issue('error', 'BUILT_ERROR'), issue('info', 'BUILT_INFO')],
    );
    expect(collectPostBuildIssues(result).map((i) => i.code)).toEqual([
      'FRAMEWORK_INFO',
      'FRAMEWORK_WARN',
      'BUILT_ERROR',
      'BUILT_INFO',
    ]);
  });

  it('de-duplicates an issue reported by both channels', () => {
    const dup = issue('error', 'SAME', { location: 'SKILL.md', line: 3 });
    const result = packageResult([dup], [{ ...dup }]);
    expect(collectPostBuildIssues(result)).toHaveLength(1);
  });

  it('returns an empty set when neither channel carries anything', () => {
    expect(collectPostBuildIssues(packageResult(undefined, undefined))).toEqual([]);
  });
});

describe('sumSeverityCounts', () => {
  it('adds every bucket across lanes', () => {
    expect(
      sumSeverityCounts([
        { errors: 1, warnings: 2, info: 3 },
        { errors: 0, warnings: 1, info: 1 },
      ]),
    ).toEqual({ errors: 1, warnings: 3, info: 4 });
  });

  it('is zero for no lanes', () => {
    expect(sumSeverityCounts([])).toEqual({ errors: 0, warnings: 0, info: 0 });
  });
});

// ---------------------------------------------------------------------------
// `vat skills validate`
// ---------------------------------------------------------------------------

describe('vat skills validate — buildValidateSummary', () => {
  it('says `warning` for a warning-only batch instead of `success`', () => {
    const results = [packagingResult('a', [issue('warning', 'W1'), issue('warning', 'W2')])];
    const summary = buildValidateSummary(results, 25, false, []);

    // The defect: `results.some(r => r.status === 'error') ? 'error' : 'success'`
    // could never say `warning`, so 33 active warnings reported as `success`.
    expect(summary.status).toBe('warning');
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 2, info: 0 });
  });

  it('says `success` for an info-only batch but still publishes the info count', () => {
    const summary = buildValidateSummary([packagingResult('a', [issue('info', 'I1')])], 1, false, []);
    expect(summary.status).toBe('success');
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 0, info: 1 });
  });

  it('aggregates the whole batch, not just the worst skill', () => {
    const summary = buildValidateSummary(
      [
        packagingResult('a', [issue('error', 'E1')]),
        packagingResult('b', [issue('warning', 'W1'), issue('info', 'I1')]),
      ],
      1,
      false,
      [],
    );
    expect(summary.status).toBe('error');
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 1, info: 1 });
  });

  it('publishes per-skill counts beside each two-valued per-skill status', () => {
    const summary = buildValidateSummary(
      [packagingResult('a', [issue('warning', 'W1'), issue('info', 'I1')])],
      1,
      false,
      [],
    );
    const first = summary.results[0] as { status: string; issueCounts: unknown };
    expect(first.status).toBe('success');
    expect(first.issueCounts).toEqual({ errors: 0, warnings: 1, info: 1 });
  });

  it('strips excludedReferences unless verbose', () => {
    const results = [packagingResult('a', [], [{ path: 'x.md', reason: 'gitignored' }])];
    const terse = buildValidateSummary(results, 1, false, []).results[0] as {
      metadata: Record<string, unknown>;
    };
    const verbose = buildValidateSummary(results, 1, true, []).results[0] as {
      metadata: Record<string, unknown>;
    };
    expect(terse.metadata).not.toHaveProperty('excludedReferences');
    expect(terse.metadata['excludedReferenceCount']).toBe(1);
    expect(verbose.metadata).toHaveProperty('excludedReferences');
  });
});

describe('vat skills validate — formatValidationReportLines', () => {
  it('does not print the all-clear banner over active warnings', () => {
    const lines = formatValidationReportLines([
      packagingResult('a', [issue('warning', 'W1'), issue('warning', 'W2')]),
    ], []);
    // The literal defect: "✅ All validations passed" above N warnings.
    expect(lines.some((l) => l.includes('All validations passed'))).toBe(false);
    expect(lines[0]).toContain('2 warnings');
  });

  it('renders EVERY emitted severity in a mixed batch, not just the errors', () => {
    const lines = formatValidationReportLines([
      packagingResult('a', [issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')]),
    ], []);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('renders an info-only batch rather than reporting nothing at all', () => {
    const lines = formatValidationReportLines([packagingResult('a', [issue('info', 'I1')])], []);
    expect(renderedLabels(lines)).toEqual(['INFO']);
    expect(lines[0]).toContain('1 info');
  });

  it('keeps the plain all-clear banner for a genuinely clean batch', () => {
    expect(formatValidationReportLines([packagingResult('a', [])], [])).toEqual([
      '\n✅ All validations passed',
    ]);
  });
});

describe('vat skills validate — formatSkillProgressLine', () => {
  it('does not mark a warning-carrying skill with a bare success glyph', () => {
    const [line] = formatSkillProgressLine('a', packagingResult('a', [issue('warning', 'W1')]));
    expect(line).not.toBe('   ✅ a');
    expect(line).toContain('⚠️');
    expect(line).toContain('1 warning');
  });

  it('still marks a clean skill clean, with no breakdown noise', () => {
    expect(formatSkillProgressLine('a', packagingResult('a', []))).toEqual(['   ✅ a']);
  });
});

// ---------------------------------------------------------------------------
// `vat skills build`
// ---------------------------------------------------------------------------

describe('vat skills build — formatPostBuildIssueReport', () => {
  it('does not label an info finding [WARNING]', () => {
    const lines = formatPostBuildIssueReport(
      packageResult([issue('info', 'LINK_DEFERRED_ARTIFACT')], undefined),
    );
    expect(renderedLabels(lines)).toEqual(['INFO']);
  });

  it('does not label a mixed set "post-build error(s)" wholesale', () => {
    const lines = formatPostBuildIssueReport(
      packageResult([issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')], undefined),
    );
    expect(lines[0]).toBe('   3 post-build issues (1 error, 1 warning, 1 info):');
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('renders the issues when the build failed purely on postBuildValidation', () => {
    // The defect: this printed NOTHING — the user was told the build failed and
    // shown no reason at all.
    const lines = formatPostBuildIssueReport(
      packageResult(undefined, [issue('error', 'BUILT_ONLY')]),
    );
    expect(lines[0]).toBe('   1 post-build issue (1 error):');
    expect(renderedLabels(lines)).toEqual(['ERROR']);
  });

  it('renders nothing when there is nothing', () => {
    expect(formatPostBuildIssueReport(packageResult([], undefined))).toEqual([]);
  });
});

describe('vat skills build — formatPreBuildIssueReport', () => {
  it('renders every emitted severity, not activeErrors plus ALLOW_EXPIRED only', () => {
    const lines = formatPreBuildIssueReport(
      packagingResult('a', [
        issue('error', 'E1'),
        issue('warning', 'ALLOW_EXPIRED'),
        issue('warning', 'W1'),
        issue('info', 'I1'),
      ]),
    );
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'INFO']);
    expect(lines[0]).toContain('4 issues (1 error, 2 warnings, 1 info)');
  });
});

describe('vat skills build — buildYamlSummary', () => {
  it('does not publish `success` for a build that emitted post-build errors', () => {
    const summary = buildYamlSummary(
      [{ name: 'a', result: packageResult(undefined, [issue('error', 'BUILT_ONLY')]) }],
      12,
    );
    // The defect: `status: success` was a literal, printed alongside exit code 1.
    expect(summary.status).toBe('error');
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
  });

  it('says `warning` when the build shipped warnings and no errors', () => {
    const summary = buildYamlSummary(
      [{ name: 'a', result: packageResult([issue('warning', 'W1')], undefined) }],
      1,
    );
    expect(summary.status).toBe('warning');
  });

  it('says `success` for info-only findings, with the info count beside it', () => {
    const summary = buildYamlSummary(
      [{ name: 'a', result: packageResult([issue('info', 'I1')], undefined) }],
      1,
    );
    expect(summary.status).toBe('success');
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 0, info: 1 });
  });

  it('publishes per-skill counts and sums them for the run', () => {
    const summary = buildYamlSummary(
      [
        { name: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
        { name: 'b', result: packageResult([issue('info', 'I1')], [issue('info', 'I2')]) },
      ],
      1,
    );
    expect(summary.skills.map((s) => s.issueCounts)).toEqual([
      { errors: 0, warnings: 1, info: 0 },
      { errors: 0, warnings: 0, info: 2 },
    ]);
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 1, info: 2 });
  });
});

// ---------------------------------------------------------------------------
// `vat skills package`
// ---------------------------------------------------------------------------

describe('vat skills package — formatSkillValidationLines', () => {
  it('does not drop info findings from the report', () => {
    const lines = formatSkillValidationLines(
      validationResult([issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')], 'error'),
    );
    // The defect: the renderer filtered to error+warning, so info vanished.
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('reports a warning-only result instead of a bare success line', () => {
    const lines = formatSkillValidationLines(
      validationResult([issue('warning', 'W1')], 'warning'),
    );
    // The defect: `status === 'error'` gated the whole report, so a `warning`
    // status printed only "✅ Validation passed".
    expect(lines.some((l) => l.includes('✅ Validation passed'))).toBe(false);
    expect(renderedLabels(lines)).toEqual(['WARNING']);
    expect(lines[0]).toContain('1 warning');
  });

  it('keeps a clean result a one-liner', () => {
    expect(formatSkillValidationLines(validationResult([], 'success'))).toEqual([
      '✅ Validation passed — no findings',
    ]);
  });
});

// ---------------------------------------------------------------------------
// `vat claude plugin build`
// ---------------------------------------------------------------------------

describe('vat claude plugin build — summarizePackagedSkillIssues', () => {
  it('does not label an info finding [WARNING]', () => {
    const { lines } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([issue('info', 'I1')], undefined) },
    ]);
    expect(renderedLabels(lines)).toEqual(['INFO']);
  });

  it('renders every severity across every packaged skill', () => {
    const { lines, issueCounts } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
      {
        skillDirPath: 'b',
        result: packageResult([issue('info', 'I1')], [issue('error', 'E1')]),
      },
    ]);
    expect(renderedLabels(lines)).toEqual(['WARNING', 'INFO', 'ERROR']);
    expect(issueCounts).toEqual({ errors: 1, warnings: 1, info: 1 });
  });

  it('shows the findings when a skill failed purely on postBuildValidation', () => {
    const { lines, withErrors } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult(undefined, [issue('error', 'BUILT_ONLY')]) },
    ]);
    // The defect: the plugin build aborted naming the skill, with no issue text.
    expect(withErrors).toEqual(['a']);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
  });

  it('renders nothing and counts nothing for a clean set', () => {
    const { lines, withErrors, issueCounts } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([], undefined) },
    ]);
    expect(lines).toEqual([]);
    expect(withErrors).toEqual([]);
    expect(issueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
  });
});
