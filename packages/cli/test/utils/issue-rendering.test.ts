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

import {
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/agent-schema';
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
  type SkillBuildRun,
} from '../../src/commands/skills/build.js';
import {
  buildPackageHeader,
  formatSkillValidationLines,
} from '../../src/commands/skills/package.js';
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
  issuesToRenderAtVerbosity,
  severityLabel,
  summarizeFindings,
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
  ignoredErrors: PackagingValidationResult['ignoredErrors'] = [],
): PackagingValidationResult {
  return {
    skillName,
    // The real two-valued gate verdict: `error` iff there is an active error.
    status: issues.some((i) => i.severity === 'error') ? 'error' : 'success',
    allErrors: issues,
    ignoredErrors,
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

/** One `validation.allow` suppression record. */
function allowRecord(code: string): PackagingValidationResult['ignoredErrors'][number] {
  return {
    code: code as ValidationIssue['code'],
    location: 'a/SKILL.md:3',
    reason: 'known and accepted',
  };
}

/**
 * Re-add a validate summary's header total from the ROWS it publishes, reading
 * whichever of the two published row shapes each row uses: the default per-asset
 * row (flat `warnings: 3`, zero buckets absent) or the verbose row (`issueCounts`).
 *
 * An absent bucket contributes zero, which is what makes this an identity check
 * rather than a restatement of the producer's arithmetic: a row the producer
 * dropped, or a bucket it forgot, is invisible here and the sum falls short of
 * the header by exactly that addend.
 */
function countsFromValidateRows(rows: readonly unknown[]): SeverityCounts {
  return sumSeverityCounts(
    rows.map((r) => {
      const row = r as {
        errors?: number;
        warnings?: number;
        info?: number;
        issueCounts?: SeverityCounts;
      };
      return (
        row.issueCounts ?? {
          errors: row.errors ?? 0,
          warnings: row.warnings ?? 0,
          info: row.info ?? 0,
        }
      );
    }),
  );
}

/**
 * One error plus the high-cardinality tail that made these reports unreadable,
 * plus an allow-suppressed finding that must never render at any verbosity.
 *
 * The repeated warnings carry DISTINCT locations because that is what makes them
 * three findings: `collectPostBuildIssues` de-duplicates on (code, severity,
 * location, line, field, message), so three byte-identical copies would merge
 * into one and the fixture could not tell a collapse from a de-duplication.
 */
function mixedIssues(): ValidationIssue[] {
  return [
    issue('error', 'SKILL_MISSING_DESCRIPTION', { fix: 'add a description' }),
    issue('warning', 'LINK_DROPPED_BY_DEPTH', { location: 'docs/a.md' }),
    issue('warning', 'LINK_DROPPED_BY_DEPTH', { location: 'docs/b.md' }),
    issue('warning', 'LINK_DROPPED_BY_DEPTH', { location: 'docs/c.md' }),
    issue('info', 'NON_PORTABLE_ASSET_REFERENCE'),
    issue('ignore', 'LINK_TO_NAVIGATION_FILE'),
  ];
}

/** The error fixture's fix hint — asserted wherever the error renders in full. */
const ERROR_FIX_LINE = 'Fix: add a description';

/** Rendered message bodies the collapse tests assert are ABSENT by default. */
const DROPPED_BODY = 'LINK_DROPPED_BY_DEPTH happened';
const NON_PORTABLE_BODY = 'NON_PORTABLE_ASSET_REFERENCE happened';

/** The heading's counts are the summary, so they must name the WHOLE set. */
const FULL_BREAKDOWN = '(1 error, 3 warnings, 1 info)';

/** `packageResult` with only the post-build channel populated. */
function packageResult2(postBuildIssues: ValidationIssue[]): PackageSkillResult {
  return packageResult(postBuildIssues, undefined);
}

/** The subject skill's name — synthetic, as every fixture name in this repo is. */
const SKILL = 'csv-summarizer';

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

describe('issuesToRenderAtVerbosity', () => {
  /**
   * One mixed set covering every severity, asserted over the WHOLE result rather
   * than a named subset — per this file's header, a test that checks one finding
   * cannot catch a filter that drops a severity class.
   */
  const mixed = [
    issue('error', 'FILENAME_COLLISION'),
    issue('warning', 'LINK_DROPPED_BY_DEPTH'),
    issue('info', 'CAPABILITY_LOCAL_SHELL'),
    issue('ignore', 'PACKAGED_UNREFERENCED_FILE'),
    issue('error', 'PACKAGED_TEST_INPUT'),
  ];

  it('renders ONLY errors when not verbose — the count line carries the rest', () => {
    expect(issuesToRenderAtVerbosity(mixed, false).map((i) => i.code)).toEqual([
      'FILENAME_COLLISION',
      'PACKAGED_TEST_INPUT',
    ]);
  });

  it('renders every non-ignored severity when verbose', () => {
    expect(issuesToRenderAtVerbosity(mixed, true).map((i) => i.code)).toEqual([
      'FILENAME_COLLISION',
      'LINK_DROPPED_BY_DEPTH',
      'CAPABILITY_LOCAL_SHELL',
      'PACKAGED_TEST_INPUT',
    ]);
  });

  it('never renders an `ignore` finding, at EITHER verbosity', () => {
    // The adopter's `validation.allow` silenced it deliberately. It stays
    // countable via summarizeFindings' `codes` tally; it is never a report line.
    for (const verbose of [false, true]) {
      expect(issuesToRenderAtVerbosity(mixed, verbose).some((i) => i.severity === 'ignore')).toBe(
        false,
      );
    }
  });

  it('keeps an error visible even when warnings outnumber it overwhelmingly', () => {
    // The regression this exists to prevent: on a real 90-skill adopter one skill
    // carried 348 warnings of a single code, and a renderer that collapsed by
    // COUNT rather than by SEVERITY buried the errors that failed the build.
    const noisy = [
      ...Array.from({ length: 348 }, () => issue('warning', 'LINK_DROPPED_BY_DEPTH')),
      issue('error', 'FILENAME_COLLISION'),
    ];
    expect(issuesToRenderAtVerbosity(noisy, false)).toEqual([issue('error', 'FILENAME_COLLISION')]);
  });

  it('is empty for an empty set at either verbosity', () => {
    expect(issuesToRenderAtVerbosity([], false)).toEqual([]);
    expect(issuesToRenderAtVerbosity([], true)).toEqual([]);
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

describe('summarizeFindings', () => {
  it('omits a zero severity bucket as an ABSENT key, not as an explicit 0', () => {
    // `toBeUndefined()` cannot make this assertion: it passes for an absent key
    // AND for a key explicitly set to `undefined`, and only the first of those
    // disappears from a YAML row. The zero buckets are what turn a summary meant
    // to read `warnings: 3` into three columns of noise per asset.
    const result = summarizeFindings([issue('warning', 'W1'), issue('warning', 'W2'), issue('warning', 'W3')]);
    expect(result.warnings).toBe(3);
    expect('errors' in result).toBe(false);
    expect('info' in result).toBe(false);
  });

  it('reports exactly the distribution countBySeverity reports, for a mixed set', () => {
    // The delegation IS the behaviour: a second hand-rolled severity collapse is
    // how `info` came to be counted as a warning in half the lanes.
    const issues = [
      issue('error', 'E1'),
      issue('warning', 'W1'),
      issue('warning', 'W2'),
      issue('info', 'I1'),
      issue('ignore', 'X1'),
    ];
    const result = summarizeFindings(issues);
    const expected = countBySeverity(issues);
    expect({ errors: result.errors, warnings: result.warnings, info: result.info }).toEqual(expected);
    expect(expected).toEqual({ errors: 1, warnings: 2, info: 1 });
  });

  it('orders codes by descending count, ties broken by code name ascending', () => {
    // Insertion order IS the YAML serialization order — the ordering is the
    // whole reason a caller can read the top row and know the dominant code.
    const result = summarizeFindings([
      issue('warning', 'B_TWICE'),
      issue('warning', 'A_ONCE'),
      issue('warning', 'B_TWICE'),
      issue('info', 'C_THRICE'),
      issue('info', 'C_THRICE'),
      issue('info', 'C_THRICE'),
      issue('info', 'A_TIED_WITH_B'),
      issue('info', 'A_TIED_WITH_B'),
    ]);
    expect(Object.keys(result.codes)).toEqual(['C_THRICE', 'A_TIED_WITH_B', 'B_TWICE', 'A_ONCE']);
    expect(result.codes).toEqual({ C_THRICE: 3, A_TIED_WITH_B: 2, B_TWICE: 2, A_ONCE: 1 });
  });

  it('publishes no severity key at all for an empty set', () => {
    const result = summarizeFindings([]);
    expect(result).toEqual({ codes: {} });
    expect(Object.keys(result)).toEqual(['codes']);
  });

  it('keeps an ignored finding in codes while counting it in no severity bucket', () => {
    // `countBySeverity` deliberately drops `ignore` from every bucket (the
    // adopter silenced it), but the finding WAS emitted — dropping it from the
    // code tally too would make an allow-listed code invisible everywhere.
    const result = summarizeFindings([issue('ignore', 'SUPPRESSED'), issue('ignore', 'SUPPRESSED')]);
    expect(result.codes).toEqual({ SUPPRESSED: 2 });
    expect('errors' in result).toBe(false);
    expect('warnings' in result).toBe(false);
    expect('info' in result).toBe(false);
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

  it('publishes a per-asset row of COUNTS only — no findings arrays, no metadata', () => {
    // The default row is what a reader scans at corpus scale: which asset has
    // problems, how many, and of what code. The arrays it used to carry are what
    // made the skills phase 17,363 of `vat verify`'s 22,156 stdout lines.
    const summary = buildValidateSummary(
      [
        packagingResult(
          'a',
          [issue('warning', 'W1'), issue('warning', 'W1'), issue('info', 'I1')],
          [{ path: 'x.md', reason: 'gitignored' }],
        ),
      ],
      1,
      false,
      [],
    );
    const [row] = summary.results;
    expect(row).toStrictEqual({
      skillName: 'a',
      status: 'success',
      warnings: 2,
      info: 1,
      codes: { W1: 2, I1: 1 },
    });
    // A zero bucket is an ABSENT key, never `0` — `errors: 0` beside a red exit
    // code reads as a contradiction rather than as "this asset is not the one".
    expect('errors' in (row as object)).toBe(false);
  });

  it('publishes an allowed COUNT, and keeps the row of a skill whose findings were all allowed', () => {
    // A skill with an empty `allErrors` and a non-empty `ignoredErrors` is the
    // only fixture that can tell "drop rows with no EMITTED findings" apart from
    // "drop rows with nothing to say": under the first rule this fact — the
    // adopter is suppressing something here — silently disappears.
    const [row] = buildValidateSummary(
      [packagingResult('a', [], [], [allowRecord('LINK_BROKEN'), allowRecord('LINK_BROKEN')])],
      1,
      false,
      [],
    ).results;
    expect(row).toStrictEqual({ skillName: 'a', status: 'success', allowed: 2, codes: {} });
  });

  it('omits a clean skill from the default rows while still counting it in skillsValidated', () => {
    // Two skills, exactly one of them clean: a fixture where every skill has a
    // finding cannot distinguish "clean rows omitted" from "all rows published",
    // and one where every skill is clean cannot tell an omission from an empty run.
    const summary = buildValidateSummary(
      [packagingResult('clean', []), packagingResult('noisy', [issue('warning', 'W1')])],
      1,
      false,
      [],
    );
    expect(summary.results.map((r) => (r as { skillName: string }).skillName)).toEqual(['noisy']);
    expect(summary.skillsValidated).toBe(2);
  });

  it('restores the full per-skill detail under verbose, clean skills included', () => {
    const summary = buildValidateSummary(
      [packagingResult('clean', []), packagingResult('noisy', [issue('warning', 'W1')])],
      1,
      true,
      [],
    );
    expect(summary.results.map((r) => (r as { skillName: string }).skillName)).toEqual([
      'clean',
      'noisy',
    ]);
    const noisy = summary.results[1] as { allErrors: unknown; issueCounts: unknown; metadata: unknown };
    expect(noisy.allErrors).toEqual([issue('warning', 'W1')]);
    expect(noisy.issueCounts).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(noisy.metadata).toBeDefined();
  });

  it('closes the accounting: the header equals the per-skill sum plus the run-level counts', () => {
    // The observed symptom on a large real repo: the header said 1814 warnings
    // while the per-skill counts summed to 1800. The 14 missing ones are
    // run-level ALLOW_UNUSED warnings — legitimately in the header (the exit
    // code is derived from them too), but published only as a bare LIST, with
    // no counts block, so no consumer could reconcile the two numbers without
    // hand-counting the list. The invariant below is what makes the header
    // accountable; dropping run issues from the header instead would have
    // divorced it from the exit code, which is the worse of the two failures.
    // The batch deliberately contains a CLEAN skill, which the default rows drop:
    // the identity is only worth asserting on the shape that actually omits rows.
    // A fixture where every skill has a finding cannot see a dropped addend.
    const results = [
      packagingResult('a', [issue('warning', 'W1'), issue('info', 'I1')], [], [
        allowRecord('LINK_BROKEN'),
      ]),
      packagingResult('clean', []),
      packagingResult('b', [issue('error', 'E1')]),
    ];
    const runIssues = [issue('warning', 'ALLOW_UNUSED'), issue('warning', 'ALLOW_UNUSED')];

    for (const verbose of [false, true]) {
      const summary = buildValidateSummary(results, 1, verbose, runIssues);
      const perSkill = countsFromValidateRows(summary.results);
      // Guards against a vacuous pass: all three buckets have to be non-trivial
      // and the run bucket has to be non-empty, or the identity proves nothing.
      expect(perSkill).toEqual({ errors: 1, warnings: 1, info: 1 });
      expect(summary.runIssueCounts).toEqual({ errors: 0, warnings: 2, info: 0 });

      expect(summary.issueCounts).toEqual(sumSeverityCounts([perSkill, summary.runIssueCounts]));
      // The header keeps its complete shape in BOTH modes — it is the
      // reconciliation identity, not a per-asset row, so its zeros stay.
      expect(Object.keys(summary.issueCounts)).toEqual(['errors', 'warnings', 'info']);
      expect(summary.runIssues).toHaveLength(2);
    }
  });

  it('counts an allow-suppressed issue in neither the per-skill nor the run total', () => {
    const summary = buildValidateSummary(
      [packagingResult('a', [issue('warning', 'W1')], [], [allowRecord('LINK_BROKEN')])],
      1,
      false,
      [],
    );
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(summary.runIssueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('carries excludedReferences under verbose, where the full metadata lives', () => {
    const results = [
      packagingResult('a', [issue('warning', 'W1')], [{ path: 'x.md', reason: 'gitignored' }]),
    ];
    const verbose = buildValidateSummary(results, 1, true, []).results[0] as {
      metadata: Record<string, unknown>;
    };
    expect(verbose.metadata).toHaveProperty('excludedReferences');
    expect(verbose.metadata['excludedReferenceCount']).toBe(1);
  });
});

describe('vat skills validate — formatValidationReportLines', () => {
  it('does not print the all-clear banner over active warnings', () => {
    const lines = formatValidationReportLines([
      packagingResult('a', [issue('warning', 'W1'), issue('warning', 'W2')]),
    ], [], true);
    // The literal defect: "✅ All validations passed" above N warnings.
    expect(lines.some((l) => l.includes('All validations passed'))).toBe(false);
    expect(lines[0]).toContain('2 warnings');
  });

  it('renders EVERY emitted severity in a mixed batch under verbose, not just the errors', () => {
    const lines = formatValidationReportLines([
      packagingResult('a', [issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')]),
    ], [], true);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('renders an info-only batch rather than reporting nothing at all', () => {
    const lines = formatValidationReportLines([packagingResult('a', [issue('info', 'I1')])], [], true);
    expect(renderedLabels(lines)).toEqual(['INFO']);
    expect(lines[0]).toContain('1 info');
  });

  it('keeps the plain all-clear banner for a genuinely clean batch', () => {
    for (const verbose of [false, true]) {
      expect(formatValidationReportLines([packagingResult('a', [])], [], verbose)).toEqual([
        '\n✅ All validations passed',
      ]);
    }
  });

  it('collapses each skill to ONE line by default, dominant code first, clean skills omitted', () => {
    // Three skills of three different shapes — noisy, clean, allow-only — so the
    // fixture can tell "one row per finding" apart from "one row per asset", and
    // "clean rows dropped" apart from "all rows printed". A single-skill fixture
    // can see neither.
    const lines = formatValidationReportLines(
      [
        packagingResult('noisy', [
          issue('warning', 'LINK_DROPPED_BY_DEPTH'),
          issue('warning', 'LINK_DROPPED_BY_DEPTH'),
          issue('info', 'NON_PORTABLE_ASSET_REFERENCE'),
        ]),
        packagingResult('clean', []),
        packagingResult('allowed-only', [], [], [allowRecord('LINK_BROKEN')]),
      ],
      [],
      false,
    );
    // No per-issue blocks at all: the 1,728 LINK_DROPPED_BY_DEPTH rows are what
    // this output exists to not print.
    expect(renderedLabels(lines)).toEqual([]);
    expect(lines.slice(1)).toEqual([
      '  noisy: 2 warnings, 1 info — LINK_DROPPED_BY_DEPTH: 2, NON_PORTABLE_ASSET_REFERENCE: 1',
      '  allowed-only: no findings (+1 allowed by config)',
    ]);
  });

  it('keeps run-level findings in full in BOTH modes', () => {
    // Run-level findings are ~14 and belong to the project config, not to any
    // asset — there is no per-asset row for them to collapse into.
    for (const verbose of [false, true]) {
      const lines = formatValidationReportLines(
        [packagingResult('a', [issue('warning', 'W1')])],
        [issue('warning', 'ALLOW_UNUSED', { fix: 'remove the entry' })],
        verbose,
      );
      expect(lines).toContain('Run-level (project config, not any one skill):');
      expect(renderedLabels(lines)).toContain('WARNING');
      expect(lines.some((l) => l.includes('Fix: remove the entry'))).toBe(true);
    }
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
      true,
    );
    expect(renderedLabels(lines)).toEqual(['INFO']);
  });

  it('does not label a mixed set "post-build error(s)" wholesale', () => {
    const lines = formatPostBuildIssueReport(
      packageResult([issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')], undefined),
      true,
    );
    expect(lines[0]).toBe('   3 post-build issues (1 error, 1 warning, 1 info):');
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('renders the issues when the build failed purely on postBuildValidation', () => {
    // The defect: this printed NOTHING — the user was told the build failed and
    // shown no reason at all.
    const lines = formatPostBuildIssueReport(
      packageResult(undefined, [issue('error', 'BUILT_ONLY')]),
      false,
    );
    expect(lines[0]).toBe('   1 post-build issue (1 error):');
    expect(renderedLabels(lines)).toEqual(['ERROR']);
  });

  it('renders nothing when there is nothing', () => {
    expect(formatPostBuildIssueReport(packageResult([], undefined), false)).toEqual([]);
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
      true,
    );
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'INFO']);
    expect(lines[0]).toContain('4 issues (1 error, 2 warnings, 1 info)');
  });
});

/**
 * Re-add a build summary's header total from the ROWS it publishes, exactly as a
 * consumer must: one bucket per row across ALL THREE row lists, plus the single
 * run-level bucket.
 *
 * A row that publishes no bucket contributes zero on purpose — that is what makes
 * this an identity check rather than a restatement of the producer's own
 * arithmetic. A header addend with no row of its own is invisible here, and the
 * sum falls short of the header by exactly that addend.
 */
function countsFromPublishedRows(summary: ReturnType<typeof buildYamlSummary>): SeverityCounts {
  const zero: SeverityCounts = { errors: 0, warnings: 0, info: 0 };
  const rows: ReadonlyArray<{ issueCounts?: SeverityCounts | undefined }> = [
    ...summary.skills,
    ...summary.failedSkills,
    ...summary.validationFailedSkills,
  ];
  return sumSeverityCounts([...rows.map((r) => r.issueCounts ?? zero), summary.runIssueCounts]);
}

/**
 * `buildYamlSummary` over ONE run, with every population empty unless named.
 *
 * The run carries four populations and a committed/not-committed fact now, and
 * most of these cases care about exactly one of them. Naming only what a case
 * exercises keeps the fixture from restating five empty lists per test — and
 * makes the two same-shaped failure lists impossible to transpose by accident.
 */
function summaryOf(run: Partial<SkillBuildRun>, duration: number): ReturnType<typeof buildYamlSummary> {
  return buildYamlSummary(
    {
      results: [],
      failures: [],
      runIssues: [],
      skillsWithErrors: [],
      validationFailures: [],
      outputCommitted: true,
      ...run,
    },
    duration,
  );
}

describe('vat skills build — buildYamlSummary', () => {
  it('does not publish `success` for a build that emitted post-build errors', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'a', result: packageResult(undefined, [issue('error', 'BUILT_ONLY')]) }],
        failures: [],
        runIssues: [],
        skillsWithErrors: [],
      },
      12,
    );
    // The defect: `status: success` was a literal, printed alongside exit code 1.
    expect(summary.status).toBe('error');
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
  });

  it('says `warning` when the build shipped warnings and no errors', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'a', result: packageResult([issue('warning', 'W1')], undefined) }],
        failures: [],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.status).toBe('warning');
  });

  it('says `success` for info-only findings, with the info count beside it', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'a', result: packageResult([issue('info', 'I1')], undefined) }],
        failures: [],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.status).toBe('success');
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 0, info: 1 });
  });

  it('publishes per-skill counts and sums them for the run', () => {
    const summary = summaryOf(
      {
        results: [
        { name: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
        { name: 'b', result: packageResult([issue('info', 'I1')], [issue('info', 'I2')]) },
      ],
        failures: [],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.skills.map((s) => s.issueCounts)).toEqual([
      { errors: 0, warnings: 1, info: 0 },
      { errors: 0, warnings: 0, info: 2 },
    ]);
    expect(summary.issueCounts).toEqual({ errors: 0, warnings: 1, info: 2 });
  });

  it('closes the accounting: the header equals the per-skill sum plus the run-level counts', () => {
    // Same identity `vat skills validate` publishes. ALLOW_UNUSED belongs to no
    // skill, so a header that omitted it would report fewer findings than the
    // human stream renders — and the run-level bucket is what lets a consumer
    // reconcile the two without hand-counting a list.
    const summary = summaryOf(
      {
        results: [
        { name: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
        { name: 'b', result: packageResult(undefined, [issue('info', 'I1')]) },
      ],
        failures: [],
        runIssues: [issue('warning', 'ALLOW_UNUSED'), issue('warning', 'ALLOW_UNUSED')],
        skillsWithErrors: [],
      },
      1,
    );

    const perSkill = sumSeverityCounts(summary.skills.map((s) => s.issueCounts));
    // Guards against a vacuous pass: both buckets must be non-empty.
    expect(perSkill).toEqual({ errors: 0, warnings: 1, info: 1 });
    expect(summary.runIssueCounts).toEqual({ errors: 0, warnings: 2, info: 0 });

    expect(summary.issueCounts).toEqual(sumSeverityCounts([perSkill, summary.runIssueCounts]));
    expect(summary.runIssues).toHaveLength(2);
  });

  it('lets a run-level error decide the status no skill could', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'a', result: packageResult(undefined, undefined) }],
        failures: [],
        runIssues: [issue('error', 'ALLOW_UNUSED')],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.status).toBe('error');
  });

  const THREW = 'Filename collision detected';

  it('publishes `error` and a non-zero error count for a skill whose packaging THREW', () => {
    // A skill that never built emits no issues at all, so a summary derived
    // only from issue channels called the run `success` while the command
    // exited 1 — the reassuring contradiction this summary exists to prevent.
    const summary = summaryOf(
      {
        results: [{ name: 'ok', result: packageResult(undefined, undefined) }],
        failures: [{ name: 'boom', message: THREW }],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.status).toBe('error');
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
  });

  it('counts a thrown skill as failed, not built, and names it', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'ok', result: packageResult(undefined, undefined) }],
        failures: [{ name: 'boom', message: THREW }],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.skillsBuilt).toBe(1);
    expect(summary.skillsFailed).toBe(1);
    expect(summary.failedSkills).toEqual([
      { name: 'boom', error: THREW, issueCounts: { errors: 1, warnings: 0, info: 0 } },
    ]);
    // The failed skill never produced an artifact, so it must not appear beside
    // the built ones with a fabricated file count.
    expect(summary.skills.map((s) => s.name)).toEqual(['ok']);
  });

  it('publishes a header total its own rows add up to, with a failure in the batch', () => {
    // The defect: the failure was counted ONCE in the header and represented
    // NOWHERE in the rows, so `issueCounts: {errors: 1}` sat above rows summing
    // to `{errors: 0}` — the same unreconcilable header (1814 vs 1800) that
    // `vat skills validate` was fixed for one command over.
    const summary = summaryOf(
      {
        results: [{ name: 'ok', result: packageResult([issue('warning', 'W1')], [issue('info', 'I1')]) }],
        failures: [{ name: 'boom', message: THREW }],
        runIssues: [issue('warning', 'ALLOW_UNUSED')],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.issueCounts).toEqual({ errors: 1, warnings: 2, info: 1 });
    expect(countsFromPublishedRows(summary)).toEqual(summary.issueCounts);
  });

  /** A skill that produced a bundle and then failed its own post-build validation. */
  const BUILT_BUT_INVALID = 'built-but-invalid';

  it('names the skills that BUILT and then emitted post-build errors', () => {
    // The defect, measured on a 90-skill adopter: the human stream said "Build
    // failed: 3 skill(s) emitted post-build validation errors" and the command
    // exited 1, while the document said `skillsFailed: 0` and `failedSkills: []`.
    // Two definitions of "failed" — could-not-package vs packaged-then-invalid —
    // and only the first had a machine field. A CI job reading either one saw a
    // clean build.
    const summary = summaryOf(
      {
        results: [{ name: BUILT_BUT_INVALID, result: packageResult(undefined, [issue('error', 'E1')]) }],
        failures: [],
        runIssues: [],
        skillsWithErrors: [BUILT_BUT_INVALID],
      },
      1,
    );

    // It IS built — it produced a bundle — so the pre-existing fields keep their
    // documented meaning rather than being redefined to paper over the gap.
    expect(summary.skillsBuilt).toBe(1);
    expect(summary.skillsFailed).toBe(0);
    expect(summary.failedSkills).toEqual([]);
    // ...and the category the exit code actually follows is now named.
    expect(summary.skillsWithErrors).toEqual([BUILT_BUT_INVALID]);
    expect(summary.status).toBe('error');
  });

  it('keeps the two failure categories separate rather than merging them', () => {
    // A guard against the tempting "fix": folding both into `skillsFailed` would
    // make `skillsBuilt + skillsFailed` exceed the number of skills, and would
    // put a row in `failedSkills` for a bundle that exists on disk.
    const summary = summaryOf(
      {
        results: [{ name: 'invalid', result: packageResult(undefined, [issue('error', 'E1')]) }],
        failures: [{ name: 'threw', message: 'Filename collision detected' }],
        runIssues: [],
        skillsWithErrors: ['invalid'],
      },
      1,
    );

    expect(summary.skillsFailed).toBe(1);
    expect(summary.failedSkills.map((s) => s.name)).toEqual(['threw']);
    expect(summary.skillsWithErrors).toEqual(['invalid']);
    // The header identity still closes with both categories present.
    expect(countsFromPublishedRows(summary)).toEqual(summary.issueCounts);
  });

  it('publishes an empty list, not a missing field, on a clean build', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'a', result: packageResult(undefined, undefined) }],
        failures: [],
        runIssues: [],
        skillsWithErrors: [],
      },
      1,
    );
    expect(summary.skillsWithErrors).toEqual([]);
    expect(summary.status).toBe('success');
  });

  it('gives a skill rejected before the build its own row, with its own counts', () => {
    // The THIRD failure mode: the pre-build source validation rejected it, so
    // packaging never ran. It is neither a `failedSkills` (packaging threw) nor
    // a `skills` (a bundle exists), and unlike a throw it has a real severity
    // distribution — a flat one-error stand-in would under-report the 5 warnings.
    const summary = summaryOf(
      { validationFailures: [{ name: 'rejected', issueCounts: { errors: 2, warnings: 5, info: 1 } }] },
      1,
    );

    expect(summary.skillsFailedValidation).toBe(1);
    expect(summary.validationFailedSkills).toEqual([
      { name: 'rejected', issueCounts: { errors: 2, warnings: 5, info: 1 } },
    ]);
    // Not folded into either neighbour.
    expect(summary.skillsFailed).toBe(0);
    expect(summary.failedSkills).toEqual([]);
    expect(summary.skills).toEqual([]);
    expect(summary.status).toBe('error');
  });

  it('closes the header identity with all four populations present at once', () => {
    const summary = summaryOf(
      {
        results: [{ name: 'invalid', result: packageResult([issue('warning', 'W1')], [issue('error', 'E1')]) }],
        failures: [{ name: 'threw', message: THREW }],
        validationFailures: [{ name: 'rejected', issueCounts: { errors: 2, warnings: 0, info: 3 } }],
        runIssues: [issue('warning', 'ALLOW_UNUSED')],
        skillsWithErrors: ['invalid'],
        outputCommitted: false,
      },
      1,
    );

    // Guards against a vacuous pass: every population contributes something.
    expect(summary.issueCounts).toEqual({ errors: 4, warnings: 2, info: 3 });
    expect(countsFromPublishedRows(summary)).toEqual(summary.issueCounts);
  });

  it('publishes whether dist/skills was actually replaced', () => {
    // Exit 1 with no way to tell "your previous output is intact" from "your
    // output tree is gone" is the ambiguity this field exists to remove.
    expect(summaryOf({ outputCommitted: false }, 1).outputCommitted).toBe(false);
    expect(summaryOf({}, 1).outputCommitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `vat skills package`
// ---------------------------------------------------------------------------

describe('vat skills package — buildPackageHeader', () => {
  it('publishes the verdict of the validation it ran, not a hardcoded success', () => {
    // The defect: `status: success` was written as a LITERAL beside counts drawn
    // from the validation whose verdict it contradicted, so a skill that
    // `vat skills build` reports as `warning` was reported here as `success`.
    // Two lanes, one skill, two answers.
    expect(buildPackageHeader(validationResult([issue('warning', 'W1')], 'warning'))).toEqual({
      status: 'warning',
      issueCounts: { errors: 0, warnings: 1, info: 0 },
    });
  });

  it('still says success for a genuinely clean run', () => {
    expect(buildPackageHeader(validationResult([], 'success'))).toEqual({
      status: 'success',
      issueCounts: { errors: 0, warnings: 0, info: 0 },
    });
  });

  it('publishes the info distribution behind a success verdict', () => {
    expect(buildPackageHeader(validationResult([issue('info', 'I1')], 'success'))).toEqual({
      status: 'success',
      issueCounts: { errors: 0, warnings: 0, info: 1 },
    });
  });
});

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
    ], true);
    expect(renderedLabels(lines)).toEqual(['INFO']);
  });

  it('renders every severity across every packaged skill', () => {
    const { lines, issueCounts } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
      {
        skillDirPath: 'b',
        result: packageResult([issue('info', 'I1')], [issue('error', 'E1')]),
      },
    ], true);
    expect(renderedLabels(lines)).toEqual(['WARNING', 'INFO', 'ERROR']);
    expect(issueCounts).toEqual({ errors: 1, warnings: 1, info: 1 });
  });

  it('shows the findings when a skill failed purely on postBuildValidation', () => {
    const { lines, withErrors } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult(undefined, [issue('error', 'BUILT_ONLY')]) },
    ], false);
    // The defect: the plugin build aborted naming the skill, with no issue text.
    expect(withErrors).toEqual(['a']);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
  });

  it('renders nothing and counts nothing for a clean set', () => {
    const { lines, withErrors, issueCounts } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([], undefined) },
    ], false);
    expect(lines).toEqual([]);
    expect(withErrors).toEqual([]);
    expect(issueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
  });
});

describe('vat skills validate — formatValidationReportLines at default verbosity', () => {
  it('renders an error in full, with its skill row and the high-cardinality noise still collapsed', () => {
    const lines = formatValidationReportLines(
      [
        packagingResult(SKILL, [
          issue('error', 'SKILL_MISSING_DESCRIPTION', { fix: 'add a description' }),
          issue('warning', 'LINK_DROPPED_BY_DEPTH'),
          issue('warning', 'LINK_DROPPED_BY_DEPTH'),
          issue('info', 'NON_PORTABLE_ASSET_REFERENCE'),
        ]),
      ],
      [],
      false,
    );
    const rendered = lines.join('\n');

    // Exactly one full block, and it is the error's — not one per finding.
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    expect(rendered).toContain(
      '[ERROR] [SKILL_MISSING_DESCRIPTION] SKILL_MISSING_DESCRIPTION happened',
    );
    expect(rendered).toContain(ERROR_FIX_LINE);

    // The warnings and info stay collapsed: their CODES are named in the row's
    // tally, their per-occurrence blocks are not printed.
    expect(rendered).not.toContain(DROPPED_BODY);
    expect(rendered).not.toContain(NON_PORTABLE_BODY);
    expect(lines).toContain(
      `  ${SKILL}: 1 error, 2 warnings, 1 info — LINK_DROPPED_BY_DEPTH: 2, ` +
        'NON_PORTABLE_ASSET_REFERENCE: 1, SKILL_MISSING_DESCRIPTION: 1',
    );
  });

  it('renders every error across the batch, and nothing for the skills that only warn', () => {
    const lines = formatValidationReportLines(
      [
        packagingResult('csvsum', [issue('error', 'SKILL_MISSING_FRONTMATTER')]),
        packagingResult('example-skill', [issue('warning', 'LINK_DROPPED_BY_DEPTH')]),
        packagingResult(SKILL, [issue('error', 'LINK_BROKEN')]),
      ],
      [],
      false,
    );

    expect(renderedLabels(lines)).toEqual(['ERROR', 'ERROR']);
    expect(lines.join('\n')).not.toContain(DROPPED_BODY);
  });

  it('never renders an allow-suppressed finding, even at error severity', () => {
    // `ignore` is what the adopter's `validation.allow` config silenced; it stays
    // visible only as a count/tally, never as a block.
    const lines = formatValidationReportLines(
      [packagingResult(SKILL, [issue('ignore', 'LINK_BROKEN')])],
      [],
      false,
    );

    expect(renderedLabels(lines)).toEqual([]);
    expect(lines.join('\n')).not.toContain('LINK_BROKEN happened');
  });
});

describe('vat skills build — formatPostBuildIssueReport verbosity', () => {
  it('renders the error in full and collapses the rest, heading counts intact', () => {
    const lines = formatPostBuildIssueReport(packageResult2(mixedIssues()), false);

    expect(lines[0]).toBe(`   6 post-build issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    const rendered = lines.join('\n');
    expect(rendered).toContain('[ERROR] [SKILL_MISSING_DESCRIPTION] SKILL_MISSING_DESCRIPTION happened');
    expect(rendered).toContain(ERROR_FIX_LINE);
    expect(rendered).not.toContain(DROPPED_BODY);
    expect(rendered).not.toContain(NON_PORTABLE_BODY);
    expect(rendered).not.toContain('LINK_TO_NAVIGATION_FILE happened');
  });

  it('renders every emitted severity under --verbose, still never the ignored one', () => {
    const lines = formatPostBuildIssueReport(packageResult2(mixedIssues()), true);

    expect(lines[0]).toBe(`   6 post-build issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
    expect(lines.join('\n')).not.toContain('LINK_TO_NAVIGATION_FILE happened');
  });

  it('keeps the heading for a warning-only set so the counts survive the collapse', () => {
    // The reassuring failure mode this guards: collapsing the bodies AND the
    // heading turns a warning-carrying build into silence.
    const lines = formatPostBuildIssueReport(
      packageResult2([issue('warning', 'LINK_DROPPED_BY_DEPTH')]),
      false,
    );
    expect(lines).toEqual(['   1 post-build issue (1 warning):']);
  });

  it('renders nothing when there is nothing, at either verbosity', () => {
    expect(formatPostBuildIssueReport(packageResult2([]), false)).toEqual([]);
    expect(formatPostBuildIssueReport(packageResult2([]), true)).toEqual([]);
  });
});

describe('vat skills build — formatPreBuildIssueReport verbosity', () => {
  it('renders the aborting errors in full and collapses the rest', () => {
    const lines = formatPreBuildIssueReport(packagingResult(SKILL, mixedIssues()), false);

    expect(lines[0]).toBe(`\n   6 issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    expect(lines.join('\n')).toContain(ERROR_FIX_LINE);
  });

  it('renders every emitted severity under --verbose', () => {
    const lines = formatPreBuildIssueReport(packagingResult(SKILL, mixedIssues()), true);

    expect(lines[0]).toBe(`\n   6 issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
  });
});

// ---------------------------------------------------------------------------
// `vat claude plugin build`
// ---------------------------------------------------------------------------

describe('vat claude plugin build — summarizePackagedSkillIssues verbosity', () => {
  it('collapses the non-errors while the per-skill heading keeps the full counts', () => {
    const { lines, withErrors, issueCounts } = summarizePackagedSkillIssues(
      [{ skillDirPath: 'csvsum', result: packageResult2(mixedIssues()) }],
      false,
    );

    expect(lines[0]).toBe(`         csvsum: 6 post-build issues ${FULL_BREAKDOWN}`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    expect(lines.join('\n')).not.toContain(DROPPED_BODY);
    // Verbosity is a RENDERING decision: the gate and the published counts are
    // computed from the whole set either way.
    expect(withErrors).toEqual(['csvsum']);
    expect(issueCounts).toEqual({ errors: 1, warnings: 3, info: 1 });
  });

  it('renders every emitted severity under --verbose, with unchanged counts', () => {
    const { lines, issueCounts } = summarizePackagedSkillIssues(
      [{ skillDirPath: 'csvsum', result: packageResult2(mixedIssues()) }],
      true,
    );

    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
    expect(issueCounts).toEqual({ errors: 1, warnings: 3, info: 1 });
  });

  it('keeps a warning-only skill visible as its heading', () => {
    const { lines, withErrors } = summarizePackagedSkillIssues(
      [{ skillDirPath: 'csvsum', result: packageResult2([issue('warning', 'LINK_DROPPED_BY_DEPTH')]) }],
      false,
    );
    expect(lines).toEqual(['         csvsum: 1 post-build issue (1 warning)']);
    expect(withErrors).toEqual([]);
  });
});
