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
  SKILL_PACKAGING_INPUT_INVALID_CODE,
  ZipSizeLimitError,
  type PackageSkillResult,
  type PackagingValidationResult,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import {
  buildReport,
  countBySeverity,
  exitCodeForReport,
  resultStatus,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import { safePath, VatError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { summarizePackagedSkillIssues } from '../../src/commands/claude/plugin/build.js';
import {
  formatPostBuildIssueReport,
  formatPreBuildIssueReport,
  skillsBuildWork,
  type SkillBuildRun,
} from '../../src/commands/skills/build.js';
import {
  buildSkillsPackageReport,
  formatSkillValidationLines,
  packagingRefusalCode,
} from '../../src/commands/skills/package.js';
import {
  buildSkillsValidateReport,
  formatSkillProgressLine,
  formatValidationReportLines,
} from '../../src/commands/skills/validate.js';
import {
  collectPostBuildIssues,
  countCollapsedFindings,
  formatCollapsedFindingsHint,
  formatIssueLines,
  formatIssueSetHeading,
  formatPackagedFileCount,
  formatSeverityBreakdown,
  issuesToRenderAtVerbosity,
  severityLabel,
  summarizeFindings,
  sumSeverityCounts,
} from '../../src/utils/issue-rendering.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A `vat skills validate` report over `results`, anchored at a fixed root. */
function validateReport(
  results: readonly PackagingValidationResult[],
  runIssues: readonly ValidationIssue[] = [],
): ReturnType<typeof buildSkillsValidateReport> {
  return buildSkillsValidateReport({ root: '/project', results, runIssues, durationMs: 1 });
}

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
    status: resultStatus(issues),
    summary: countBySeverity(issues),
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
    residue: [],
  };
  if (postBuildIssues) result.postBuildIssues = postBuildIssues;
  if (postBuildValidationIssues) {
    result.postBuildValidation = packagingResult('probe', postBuildValidationIssues);
  }
  return result;
}

/** A skill-validator ValidationResult. */
function validationResult(issues: ValidationIssue[]): ValidationResult {
  return {
    path: '/src/SKILL.md',
    type: 'agent-skill',
    status: resultStatus(issues),
    description: `${issues.length} finding(s)`,
    issues,
    summary: countBySeverity(issues),
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
 * Re-add a report's per-skill `summary` rows. Every validated skill has a row,
 * so a row the producer dropped is invisible here and the sum falls short of
 * the envelope's `summary` by exactly that addend.
 */
function countsFromSkillRows(rows: readonly { summary: SeverityCounts }[]): SeverityCounts {
  return sumSeverityCounts(rows.map((row) => row.summary));
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

describe('vat skills validate — buildSkillsValidateReport', () => {
  it('is `findings` for a warning-only batch, never a clean status', () => {
    const report = validateReport([packagingResult('a', [issue('warning', 'W1'), issue('warning', 'W2')])]);

    // The defect: `results.some(r => r.status === 'error') ? 'error' : 'success'`
    // could never say anything but `success` over 33 active warnings.
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 0, warnings: 2, info: 0 });
  });

  it('is `findings` for an info-only batch, and publishes the info count', () => {
    const report = validateReport([packagingResult('a', [issue('info', 'I1')])]);
    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 1 });
  });

  it('aggregates the whole batch, not just the worst skill', () => {
    const report = validateReport([
      packagingResult('a', [issue('error', 'E1')]),
      packagingResult('b', [issue('warning', 'W1'), issue('info', 'I1')]),
    ]);
    expect(report.summary).toEqual({ errors: 1, warnings: 1, info: 1 });
    expect(report.findings.map((finding) => finding.code)).toEqual(['E1', 'W1', 'I1']);
  });

  it('publishes one row of COUNTS per skill — no findings arrays, no metadata', () => {
    // The row is what a reader scans at corpus scale: which skill has problems
    // and how many. The arrays it used to carry are what made the skills phase
    // 17,363 of `vat verify`'s 22,156 stdout lines; the findings themselves are
    // the envelope's, once.
    const report = validateReport([
      packagingResult('a', [issue('warning', 'W1'), issue('warning', 'W1'), issue('info', 'I1')], [{ path: 'x.md', reason: 'gitignored' }]),
    ]);
    expect(report.data.skills).toStrictEqual([
      { name: 'a', status: 'findings', summary: { errors: 0, warnings: 2, info: 1 }, allowed: 0 },
    ]);
  });

  it('publishes an allowed COUNT, and the row of a skill whose findings were all allowed', () => {
    // A skill with an empty `allErrors` and a non-empty `ignoredErrors`: the
    // adopter is suppressing something here, and that fact must not vanish.
    const report = validateReport([packagingResult('a', [], [], [allowRecord('LINK_BROKEN'), allowRecord('LINK_BROKEN')])]);
    expect(report.data.skills).toStrictEqual([{ name: 'a', status: 'ok', summary: { errors: 0, warnings: 0, info: 0 }, allowed: 2 }]);
    expect(report.findings).toEqual([]);
  });

  it('lists a clean skill beside a noisy one — examined and the rows agree', () => {
    // Two skills, exactly one clean: the old default rows dropped the clean one,
    // and a reader reconciling 92 validated against 62 rows could not tell
    // "validated and clean" from "never validated". Every validated skill is a row.
    const report = validateReport([packagingResult('clean', []), packagingResult('noisy', [issue('warning', 'W1')])]);
    expect(report.data.skills.map((row) => row.name)).toEqual(['clean', 'noisy']);
    expect(report.examined).toBe(2);
  });

  it('closes the accounting: the envelope summary is the per-skill sum plus the run-level findings', () => {
    // The observed symptom on a large real repo: the header said 1814 warnings
    // while the per-skill counts summed to 1800. The 14 missing ones were
    // run-level ALLOW_UNUSED warnings. The batch deliberately contains a CLEAN
    // skill and a non-empty run bucket, so a dropped addend shows.
    const results = [
      packagingResult('a', [issue('warning', 'W1'), issue('info', 'I1')], [], [allowRecord('LINK_BROKEN')]),
      packagingResult('clean', []),
      packagingResult('b', [issue('error', 'E1')]),
    ];
    const runIssues = [issue('warning', 'ALLOW_UNUSED'), issue('warning', 'ALLOW_UNUSED')];

    const report = validateReport(results, runIssues);
    const perSkill = countsFromSkillRows(report.data.skills);
    // Guards against a vacuous pass: every bucket non-trivial, the run bucket non-empty.
    expect(perSkill).toEqual({ errors: 1, warnings: 1, info: 1 });
    expect(report.summary).toEqual(sumSeverityCounts([perSkill, { errors: 0, warnings: 2, info: 0 }]));
    expect(report.findings.filter((finding) => finding.code === 'ALLOW_UNUSED')).toHaveLength(2);
  });

  it('counts an allow-suppressed issue nowhere but `allowed`', () => {
    const report = validateReport([packagingResult('a', [issue('warning', 'W1')], [], [allowRecord('LINK_BROKEN')])]);
    expect(report.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(report.data.skills[0]?.allowed).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual(['W1']);
  });

  it('publishes an issue the adopter resolved to `ignore` nowhere', () => {
    const report = validateReport([packagingResult('a', [issue('ignore', 'SILENCED'), issue('warning', 'W1')])]);
    expect(report.findings.map((finding) => finding.code)).toEqual(['W1']);
    expect(report.data.skills[0]?.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
  });
});

describe('vat skills validate — formatValidationReportLines', () => {
  it('names the excluded references under verbose, and only there', () => {
    // They left the published document with the verbose rows; stderr is where
    // `--verbose` still shows which reference paths a skill's bundle leaves out.
    const results = [packagingResult('a', [issue('warning', 'W1')], [{ path: 'x.md', reason: 'gitignored' }])];

    expect(formatValidationReportLines(results, [], true)).toEqual(
      expect.arrayContaining(['  Excluded references (1):', '    x.md (gitignored)']),
    );
    expect(formatValidationReportLines(results, [], false).join('\n')).not.toContain('Excluded references');
  });

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

  it('never claims "nothing to act on" over an info finding the build dies on', () => {
    // FILES_GLOB_MATCHED_NOTHING is `info` on purpose — a glob over an unbuilt
    // dist/ matching nothing is the expected pre-build state and must not fail
    // anyone's CI — and `vat skills build` exits 1 on exactly that input. The
    // banner printed "All validations passed … nothing to act on" directly above
    // the one line saying the build will fail. Asserted at the DEFAULT verbosity,
    // which is what an adopter sees.
    const lines = formatValidationReportLines(
      [packagingResult('demo', [issue('info', 'FILES_GLOB_MATCHED_NOTHING')])],
      [],
      false,
    );
    expect(lines[0]).not.toContain('nothing to act on');
    expect(lines[0]).not.toContain('All validations passed');
    expect(lines[0]).toContain('Validation passed with findings');
    expect(lines[0]).toContain('1 info');
    // The finding itself is still reported — the claim was wrong, not the listing.
    expect(lines.some((line) => line.includes('FILES_GLOB_MATCHED_NOTHING'))).toBe(true);
  });

  // The control on the fix above: dropping the clause unconditionally must NOT
  // cost a genuinely clean run its unqualified all-clear.
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

  it('rates an info-only skill ✅, as the orchestrator rates an info-only phase success', () => {
    // Info never rates a word: `statusFromEnvelope` reads an info-only phase as
    // `success`, so the glyph must not warn where the phase status does not.
    const [line] = formatSkillProgressLine('a', packagingResult('a', [issue('info', 'I1')]));
    expect(line).toBe('   ✅ a: 1 info');
  });
});

// ---------------------------------------------------------------------------
// `vat skills build`
// ---------------------------------------------------------------------------

describe('vat skills build — formatPostBuildIssueReport', () => {
  it('does not label an info finding [WARNING]', () => {
    const lines = formatPostBuildIssueReport(
      SKILL,
      packageResult([issue('info', 'LINK_DEFERRED_ARTIFACT')], undefined),
      true,
    );
    expect(renderedLabels(lines)).toEqual(['INFO']);
  });

  it('does not label a mixed set "post-build error(s)" wholesale', () => {
    const lines = formatPostBuildIssueReport(
      SKILL,
      packageResult([issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')], undefined),
      true,
    );
    expect(lines[0]).toBe(`   ${SKILL}: 3 post-build issues (1 error, 1 warning, 1 info):`);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('names the skill whose outcome it is reporting', () => {
    // The defect: the outcome pass printed 86 NAMELESS headings after the
    // validation pass had already printed 92 `Building skill: <name>` banners,
    // so a heading was read as belonging to whichever banner came last.
    const lines = formatPostBuildIssueReport(SKILL, packageResult2(mixedIssues()), false);
    expect(lines[0]?.startsWith(`   ${SKILL}: `)).toBe(true);
  });

  it('renders the issues when the build failed purely on postBuildValidation', () => {
    // The defect: this printed NOTHING — the user was told the build failed and
    // shown no reason at all.
    const lines = formatPostBuildIssueReport(
      SKILL,
      packageResult(undefined, [issue('error', 'BUILT_ONLY')]),
      false,
    );
    expect(lines[0]).toBe(`   ${SKILL}: 1 post-build issue (1 error):`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
  });

  it('renders nothing when there is nothing', () => {
    expect(formatPostBuildIssueReport(SKILL, packageResult([], undefined), false)).toEqual([]);
  });
});

describe('countCollapsedFindings / formatCollapsedFindingsHint', () => {
  it('counts what --verbose would add, and nothing the config silenced', () => {
    // 6 findings: 1 error (always rendered), 3 warnings + 1 info (collapsed),
    // 1 allow-suppressed (rendered at NO verbosity, so never "hidden by -v").
    expect(countCollapsedFindings(mixedIssues(), false)).toBe(4);
    expect(countCollapsedFindings(mixedIssues(), true)).toBe(0);
  });

  it('names both ways to read what it did not print', () => {
    expect(formatCollapsedFindingsHint(4, 'build')).toBe(
      '\n4 warning/info finding(s) not shown — re-run with --verbose, '
      + "or read this build's YAML report on stdout, which lists every finding.",
    );
  });

  it('says nothing when nothing was collapsed', () => {
    expect(formatCollapsedFindingsHint(0, 'build')).toBeUndefined();
  });
});

describe('formatPackagedFileCount', () => {
  it('does not say `1 files`', () => {
    expect(formatPackagedFileCount(packageResult([], undefined))).toBe('1 file');
  });

  it('counts the root SKILL.md alongside its dependencies', () => {
    const result = packageResult([], undefined);
    result.files.dependencies = ['a.md', 'b.md'];
    expect(formatPackagedFileCount(result)).toBe('3 files');
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

/** Sources for the report fixtures, under one project root. */
const PROJECT = safePath.resolve('/project');
const sourceOf = (name: string): string => safePath.join(PROJECT, 'skills', name, 'SKILL.md');

/**
 * `vat skills build`'s report over ONE run, with every population empty unless
 * named. The rows are the skills named in `run`, in the order given.
 */
function reportOf(run: Partial<SkillBuildRun>, names: readonly string[]) {
  const work = skillsBuildWork({
    cwd: PROJECT,
    skills: names.map((name) => ({ name, sourcePath: sourceOf(name) })),
    setAside: { inPlace: [], pluginOnly: [] },
    dryRun: false,
    run: {
      results: [],
      failures: [],
      runIssues: [],
      skillsWithErrors: [],
      validationFailures: [],
      outputCommitted: true,
      residue: [],
      ...run,
    },
    setAsideIssues: [],
  });
  return buildReport({ ...work, gate: { strict: false } });
}

const statusesOf = (report: ReturnType<typeof reportOf>): string[] => report.data.skills.map((row) => row.status);

describe('vat skills build — skillsBuildWork', () => {
  it('does not publish `ok` for a build that emitted post-build errors', () => {
    const report = reportOf({ results: [{ name: 'a', result: packageResult(undefined, [issue('error', 'BUILT_ONLY')]) }] }, ['a']);

    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(exitCodeForReport(report)).toBe(1);
    expect(statusesOf(report)).toEqual(['findings']);
  });

  it('publishes warnings and info as findings that do not fail the build', () => {
    const report = reportOf({
      results: [
        { name: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
        { name: 'b', result: packageResult([issue('info', 'I1')], [issue('info', 'I2')]) },
      ],
    }, ['a', 'b']);

    expect(report.summary).toEqual({ errors: 0, warnings: 1, info: 2 });
    expect(exitCodeForReport(report)).toBe(0);
    expect(statusesOf(report)).toEqual(['findings', 'findings']);
  });

  it('says `ok` for a clean build, every row `ok`', () => {
    const report = reportOf({ results: [{ name: 'a', result: packageResult(undefined, undefined) }] }, ['a']);

    expect(report.status).toBe('ok');
    expect(statusesOf(report)).toEqual(['ok']);
  });

  it('puts the run-level findings on the envelope, and lets a run-level error decide the exit', () => {
    // ALLOW_UNUSED belongs to no skill: it is on the envelope, and on no row.
    const report = reportOf({
      results: [{ name: 'a', result: packageResult(undefined, undefined) }],
      runIssues: [issue('error', 'ALLOW_UNUSED')],
    }, ['a']);

    expect(report.findings.map((finding) => finding.code)).toEqual(['ALLOW_UNUSED']);
    expect(exitCodeForReport(report)).toBe(1);
    expect(statusesOf(report)).toEqual(['ok']);
  });

  const THREW = 'files entry for skill \'boom\': source \'dist/x\' does not exist.';

  it('publishes a skill whose packaging THREW as a located SKILL_PACKAGING_FAILED error', () => {
    // A skill that never built emits no issues at all, so a report derived only
    // from issue channels called the run clean while the command exited 1.
    const report = reportOf({
      results: [{ name: 'ok', result: packageResult(undefined, undefined) }],
      failures: [{ name: 'boom', message: THREW }],
    }, ['ok', 'boom']);

    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'SKILL_PACKAGING_FAILED', severity: 'error', message: THREW, location: 'skills/boom/SKILL.md' }),
    ]);
    expect(report.data).toMatchObject({ skillsBuilt: 1, skillsFailed: 1 });
    expect(statusesOf(report)).toEqual(['ok', 'findings']);
  });

  it('keeps built-then-invalid apart from could-not-package: one is built, the other failed', () => {
    const report = reportOf({
      results: [{ name: 'invalid', result: packageResult(undefined, [issue('error', 'E1')]) }],
      failures: [{ name: 'threw', message: THREW }],
      skillsWithErrors: ['invalid'],
    }, ['invalid', 'threw']);

    expect(report.data).toMatchObject({ skillsBuilt: 1, skillsFailed: 1 });
    expect(report.findings.map((finding) => finding.code)).toEqual(['E1', 'SKILL_PACKAGING_FAILED']);
  });

  it('names the findings that rejected a skill before the build, not just their count', () => {
    const rejecting = [issue('error', 'LINK_MISSING_TARGET'), issue('warning', 'W1'), issue('info', 'I1')];
    const report = reportOf({ validationFailures: [{ name: 'rejected', issues: rejecting }] }, ['rejected']);

    expect(report.data).toMatchObject({ skillsFailedValidation: 1, skillsFailed: 0, skillsBuilt: 0 });
    expect(report.findings.map((finding) => finding.code)).toEqual(['LINK_MISSING_TARGET', 'W1', 'I1']);
    expect(statusesOf(report)).toEqual(['findings']);
  });

  it('sums the envelope from every population at once, and drops what the config ignored', () => {
    const report = reportOf({
      results: [{ name: 'invalid', result: packageResult([issue('warning', 'W1'), issue('ignore', 'SILENCED')], [issue('error', 'E1')]) }],
      failures: [{ name: 'threw', message: THREW }],
      validationFailures: [{ name: 'rejected', issues: [issue('error', 'E2'), issue('info', 'I1')] }],
      runIssues: [issue('warning', 'ALLOW_UNUSED')],
      skillsWithErrors: ['invalid'],
      outputCommitted: false,
    }, ['invalid', 'threw', 'rejected']);

    expect(report.summary).toEqual({ errors: 3, warnings: 2, info: 1 });
    expect(report.summary).toEqual(countBySeverity(report.findings));
    expect(report.findings.map((finding) => finding.code)).not.toContain('SILENCED');
  });

  it('publishes each finding whole — code, location and fix — at every verbosity', () => {
    const finding = issue('warning', 'LINK_DROPPED_BY_DEPTH', { location: 'dist/skills/a/docs/deep.md', fix: 'raise linkFollowDepth' });
    const report = reportOf({ results: [{ name: 'a', result: packageResult([finding], undefined) }] }, ['a']);

    expect(report.findings).toEqual([finding]);
  });

  it('publishes whether dist/skills was actually replaced', () => {
    // Exit 1 with no way to tell "your previous output is intact" from "your
    // output tree is gone" is the ambiguity this field exists to remove.
    expect(reportOf({ outputCommitted: false }, []).data.outputCommitted).toBe(false);
    expect(reportOf({}, []).data.outputCommitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `vat skills package`
// ---------------------------------------------------------------------------

describe('vat skills package — buildSkillsPackageReport', () => {
  const PACKAGED = { skill: 'a', version: '1.0.0', outputPath: '/out/a', dryRun: false } as const;

  it('publishes the validation it ran as findings, not a hardcoded success', () => {
    // The defect this lane shipped: `status: success` was a LITERAL beside counts
    // drawn from the validation whose verdict it contradicted.
    const report = buildSkillsPackageReport({ validation: validationResult([issue('warning', 'W1')]), data: PACKAGED, runFindings: [] });

    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(exitCodeForReport(report)).toBe(0);
  });

  it('publishes ok for a genuinely clean run over the one skill', () => {
    const report = buildSkillsPackageReport({ validation: validationResult([]), data: PACKAGED, runFindings: [] });

    expect(report).toMatchObject({ status: 'ok', examined: 1, data: PACKAGED });
  });

  it('publishes a ZIP over the claude.ai ceiling as SKILL_PACKAGE_TOO_LARGE at the skill, exit 1', () => {
    const report = buildSkillsPackageReport({
      validation: validationResult([]),
      data: { ...PACKAGED, version: null },
      refused: { code: 'SKILL_PACKAGE_TOO_LARGE', message: 'ZIP size 9.1MB exceeds 8MB limit for Claude.ai upload.', location: 'skills/a/SKILL.md', thrown: undefined },
      runFindings: [],
    });

    expect(report.findings).toEqual([expect.objectContaining({
      code: 'SKILL_PACKAGE_TOO_LARGE',
      severity: 'error',
      location: 'skills/a/SKILL.md',
      message: expect.stringContaining('9.1MB'),
    })]);
    expect(report.status).toBe('findings');
    expect(exitCodeForReport(report)).toBe(1);
  });

  it('publishes the packager refusing the skill\'s content as T19\'s SKILL_PACKAGING_FAILED, exit 1', () => {
    const report = buildSkillsPackageReport({
      validation: validationResult([]),
      data: { ...PACKAGED, outputPath: null },
      refused: { code: 'SKILL_PACKAGING_FAILED', message: 'SKILL.md found inside skill "a"', location: 'skills/a/SKILL.md', thrown: undefined },
      runFindings: [],
    });

    expect(report.findings).toEqual([expect.objectContaining({ code: 'SKILL_PACKAGING_FAILED', severity: 'error', location: 'skills/a/SKILL.md' })]);
    expect(exitCodeForReport(report)).toBe(1);
  });
});

describe('vat skills package — packagingRefusalCode', () => {
  it('reads the ZIP ceiling and a coded content refusal as findings, anything else as a defect', () => {
    expect(packagingRefusalCode(new ZipSizeLimitError(9 * 1024 * 1024, 8 * 1024 * 1024))).toBe('SKILL_PACKAGE_TOO_LARGE');
    expect(packagingRefusalCode(new VatError(SKILL_PACKAGING_INPUT_INVALID_CODE, 'files: source missing'))).toBe('SKILL_PACKAGING_FAILED');
    // An uncoded throw is VAT's: the command publishes INTERNAL_ERROR for it.
    expect(packagingRefusalCode(new Error('files: integrity check failed'))).toBeUndefined();
    expect(packagingRefusalCode(new VatError('SOMETHING_ELSE', 'x'))).toBeUndefined();
  });
});

describe('vat skills package — formatSkillValidationLines', () => {
  it('does not drop info findings from the report', () => {
    const lines = formatSkillValidationLines(
      validationResult([issue('error', 'E1'), issue('warning', 'W1'), issue('info', 'I1')]),
    );
    // The defect: the renderer filtered to error+warning, so info vanished.
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'INFO']);
  });

  it('reports a warning-only result instead of a bare success line', () => {
    const lines = formatSkillValidationLines(
      validationResult([issue('warning', 'W1')]),
    );
    // The defect: `status === 'error'` gated the whole report, so a `warning`
    // status printed only "✅ Validation passed".
    expect(lines.some((l) => l.includes('✅ Validation passed'))).toBe(false);
    expect(renderedLabels(lines)).toEqual(['WARNING']);
    expect(lines[0]).toContain('1 warning');
  });

  it('keeps a clean result a one-liner', () => {
    expect(formatSkillValidationLines(validationResult([]))).toEqual([
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
    const { lines, issues } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([issue('warning', 'W1')], undefined) },
      {
        skillDirPath: 'b',
        result: packageResult([issue('info', 'I1')], [issue('error', 'E1')]),
      },
    ], true);
    expect(renderedLabels(lines)).toEqual(['WARNING', 'INFO', 'ERROR']);
    expect(countBySeverity(issues)).toEqual({ errors: 1, warnings: 1, info: 1 });
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
    const { lines, withErrors, issues } = summarizePackagedSkillIssues([
      { skillDirPath: 'a', result: packageResult([], undefined) },
    ], false);
    expect(lines).toEqual([]);
    expect(withErrors).toEqual([]);
    expect(countBySeverity(issues)).toEqual({ errors: 0, warnings: 0, info: 0 });
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
    const lines = formatPostBuildIssueReport(SKILL, packageResult2(mixedIssues()), false);

    expect(lines[0]).toBe(`   ${SKILL}: 6 post-build issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    const rendered = lines.join('\n');
    expect(rendered).toContain('[ERROR] [SKILL_MISSING_DESCRIPTION] SKILL_MISSING_DESCRIPTION happened');
    expect(rendered).toContain(ERROR_FIX_LINE);
    expect(rendered).not.toContain(DROPPED_BODY);
    expect(rendered).not.toContain(NON_PORTABLE_BODY);
    expect(rendered).not.toContain('LINK_TO_NAVIGATION_FILE happened');
  });

  it('renders every emitted severity under --verbose, still never the ignored one', () => {
    const lines = formatPostBuildIssueReport(SKILL, packageResult2(mixedIssues()), true);

    expect(lines[0]).toBe(`   ${SKILL}: 6 post-build issues ${FULL_BREAKDOWN}:`);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
    expect(lines.join('\n')).not.toContain('LINK_TO_NAVIGATION_FILE happened');
  });

  it('keeps the heading for a warning-only set so the counts survive the collapse', () => {
    // The reassuring failure mode this guards: collapsing the bodies AND the
    // heading turns a warning-carrying build into silence.
    //
    // And NO trailing colon: nothing renders beneath it at this verbosity, and a
    // colon that introduces an empty list is the other half of the same defect.
    const lines = formatPostBuildIssueReport(
      SKILL,
      packageResult2([issue('warning', 'LINK_DROPPED_BY_DEPTH')]),
      false,
    );
    expect(lines).toEqual([`   ${SKILL}: 1 post-build issue (1 warning)`]);
  });

  it('renders nothing when there is nothing, at either verbosity', () => {
    expect(formatPostBuildIssueReport(SKILL, packageResult2([]), false)).toEqual([]);
    expect(formatPostBuildIssueReport(SKILL, packageResult2([]), true)).toEqual([]);
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
    const { lines, withErrors, issues } = summarizePackagedSkillIssues(
      [{ skillDirPath: 'csvsum', result: packageResult2(mixedIssues()) }],
      false,
    );

    expect(lines[0]).toBe(`         csvsum: 6 post-build issues ${FULL_BREAKDOWN}`);
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    expect(lines.join('\n')).not.toContain(DROPPED_BODY);
    // Verbosity is a RENDERING decision: the gate and the published counts are
    // computed from the whole set either way.
    expect(withErrors).toEqual(['csvsum']);
    expect(countBySeverity(issues)).toEqual({ errors: 1, warnings: 3, info: 1 });
  });

  it('renders every emitted severity under --verbose, with unchanged counts', () => {
    const { lines, issues } = summarizePackagedSkillIssues(
      [{ skillDirPath: 'csvsum', result: packageResult2(mixedIssues()) }],
      true,
    );

    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
    expect(countBySeverity(issues)).toEqual({ errors: 1, warnings: 3, info: 1 });
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
