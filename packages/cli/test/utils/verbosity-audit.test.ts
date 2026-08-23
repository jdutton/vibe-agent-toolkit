/**
 * Unit tests for `vat audit`'s HUMAN findings report — the stderr stream, not
 * the YAML document on stdout.
 *
 * Audit's two output channels answer different questions and must not be
 * conflated. The YAML is parsed by CI and tooling and carries every finding at
 * every verbosity; the stderr report is read by a person, and on a 90-skill
 * corpus it printed 26,480 lines, 3,480 of them occurrences of one
 * high-cardinality warning code. These tests pin the split: the human report
 * collapses, the array the YAML is serialized from does not.
 *
 * Every assertion is over the WHOLE rendered set, never a named subset — a test
 * that checks one finding cannot catch a renderer that drops a severity class,
 * and dropping a severity class silently is the failure direction the shared
 * `issuesToRenderAtVerbosity` policy exists to prevent.
 */

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { formatAuditFindingsLines } from '../../src/commands/audit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = '/repo';

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { severity, code, message: `${code} fired`, ...extra };
}

function statusFor(counts: { errors: number; warnings: number }): ValidationResult['status'] {
  if (counts.errors > 0) return 'error';
  return counts.warnings > 0 ? 'warning' : 'success';
}

function skillResult(name: string, issues: ValidationIssue[]): ValidationResult {
  const counts = countBySeverity(issues);
  const status = statusFor(counts);
  return {
    path: `${ROOT}/skills/${name}/SKILL.md`,
    type: 'agent-skill',
    status,
    summary: `${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`,
    issues,
    issueCounts: counts,
    metadata: { name },
  };
}

/** Every severity label the report rendered, in order — the shape of the set. */
function renderedLabels(lines: string[]): string[] {
  return lines.flatMap((line) => /^\s*\[(ERROR|WARNING|INFO|IGNORED)]/.exec(line)?.slice(1, 2) ?? []);
}

/**
 * The subject of every findings heading — the text left of the ` — ` separator.
 *
 * Asserted over the WHOLE set rather than one heading, because the bug this
 * guards is a heading whose subject rendered as the empty string: the operator
 * was told a nameless something had two warnings and then shown neither.
 */
function headingSubjects(lines: string[]): string[] {
  return lines.flatMap((line) => {
    // Headings are `\n<subject> — <severity breakdown>`, with a trailing colon
    // ONLY when findings render beneath. The severity breakdown is what
    // separates a heading from the collapsed-count footer, which also carries a
    // ` — ` but ends in prose.
    const heading = /^\n(.*?) — .*(?:error|warning|info)s?:?$/.exec(line);
    return heading?.[1] === undefined ? [] : [heading[1]];
  });
}

/** A whole-directory result, i.e. one whose `path` IS the scan root. */
function rootResult(
  metadata: ValidationResult['metadata'],
  issues: ValidationIssue[],
): ValidationResult {
  const counts = countBySeverity(issues);
  return {
    path: ROOT,
    type: 'claude-plugin',
    status: statusFor(counts),
    summary: `${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`,
    issues,
    issueCounts: counts,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** One skill: the error that failed it plus the high-cardinality noise beside it. */
function mixedFixture(): ValidationResult[] {
  return [
    skillResult('csv-summarizer', [
      issue('error', 'SKILL_MISSING_DESCRIPTION', { fix: 'add a description' }),
      issue('warning', 'LINK_DROPPED_BY_DEPTH'),
      issue('warning', 'LINK_DROPPED_BY_DEPTH'),
      issue('warning', 'LINK_DROPPED_BY_DEPTH'),
      issue('info', 'NON_PORTABLE_ASSET_REFERENCE'),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vat audit — formatAuditFindingsLines', () => {
  it('renders the error in full at DEFAULT verbosity and collapses the warning/info bodies', () => {
    const lines = formatAuditFindingsLines(mixedFixture(), ROOT, false);
    const text = lines.join('\n');

    // The error is the only thing that failed the file; collapsing it into a
    // count would force a re-run with a flag to learn what broke.
    expect(renderedLabels(lines)).toEqual(['ERROR']);
    expect(text).toContain('SKILL_MISSING_DESCRIPTION');
    expect(text).toContain('add a description');

    // The three near-identical warning blocks are exactly what this collapse exists
    // to not print. Their bodies are gone...
    expect(text).not.toContain('LINK_DROPPED_BY_DEPTH fired');
    expect(text).not.toContain('NON_PORTABLE_ASSET_REFERENCE fired');

    // ...but the heading still says they exist, or the collapse is silence.
    expect(lines[0]).toContain('skills/csv-summarizer/SKILL.md');
    expect(lines[0]).toContain('1 error, 3 warnings, 1 info');
  });

  it('names the collapsed count and points at both the flag and the unfiltered YAML', () => {
    const text = formatAuditFindingsLines(mixedFixture(), ROOT, false).join('\n');
    expect(text).toContain('4 warning/info');
    expect(text).toContain('--verbose');
    expect(text).toContain('YAML');
  });

  it("scopes the collapsed-findings pointer to THIS report, not to 'the YAML report' in general", () => {
    // The pointer used to promise that "the YAML report on stdout … always
    // lists every finding". True of `vat audit` and `vat skills validate`; FALSE
    // of the whole `vat build` family, whose stdout YAML publishes issueCounts
    // only (an adopter run reported 67 warnings with zero `issues:` arrays and
    // zero `code:` fields, in default AND --verbose mode). Scope the claim to
    // the report the operator is actually holding so it cannot be read as a
    // property of VAT's YAML output generally.
    const text = formatAuditFindingsLines(mixedFixture(), ROOT, false).join('\n');
    expect(text).toContain("this audit's YAML report on stdout");
    expect(text).not.toContain('the YAML report on stdout, which always lists every finding');
  });

  it('never heads a block with an EMPTY subject, even when the finding IS the scan root', () => {
    // Auditing a plugin directory produces a result whose `path` equals the scan
    // root, so the relative location is the empty string and the heading rendered
    // as a bare " — 2 warnings:". Every heading must name something.
    const lines = formatAuditFindingsLines(
      [rootResult({ name: 'my-plugin' }, [issue('warning', 'A'), issue('warning', 'B')])],
      ROOT,
      false,
    );
    expect(headingSubjects(lines)).toEqual(['my-plugin']);
    expect(lines.filter((l) => l.startsWith('\n — '))).toEqual([]);
  });

  it('falls back to a non-empty subject for a root-level result with no name metadata', () => {
    const lines = formatAuditFindingsLines([rootResult(undefined, [issue('warning', 'A')])], ROOT, false);
    for (const subject of headingSubjects(lines)) {
      expect(subject).not.toBe('');
    }
    expect(headingSubjects(lines)).toHaveLength(1);
  });

  it('renders EVERY emitted severity under --verbose, not just the errors', () => {
    const lines = formatAuditFindingsLines(mixedFixture(), ROOT, true);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']);
    // Nothing was collapsed, so there is nothing to advertise.
    expect(lines.join('\n')).not.toContain('--verbose');
  });

  it('still heads a warning-only file at default verbosity, with nothing rendered beneath it', () => {
    const lines = formatAuditFindingsLines(
      [skillResult('csvsum', [issue('warning', 'LINK_DROPPED_BY_DEPTH'), issue('info', 'CODE_B')])],
      ROOT,
      false,
    );
    expect(renderedLabels(lines)).toEqual([]);
    expect(lines[0]).toContain('skills/csvsum/SKILL.md');
    expect(lines[0]).toContain('1 warning, 1 info');
  });

  it('ends a heading in ":" only when findings render beneath it', () => {
    // The build half of this change already made the colon conditional
    // (`formatPostBuildIssueReport`): a colon introduces the blocks below, so a
    // heading with nothing beneath it must not print one. Audit kept appending
    // it unconditionally, which produced `SKILL.md — 1 warning:` followed by a
    // blank space and then the run-level collapse hint.
    //
    // Both directions are asserted from ONE fixture, differing only in
    // verbosity, so neither "never print the colon" nor "always print it" can
    // satisfy this test.
    const collapsing = [skillResult('csvsum', [issue('warning', 'LINK_DROPPED_BY_DEPTH')])];
    const rendering = [skillResult('csvsum', [issue('error', 'SKILL_MISSING_DESCRIPTION')])];

    expect(formatAuditFindingsLines(collapsing, ROOT, false)[0]).toBe(
      '\nskills/csvsum/SKILL.md — 1 warning',
    );
    expect(formatAuditFindingsLines(collapsing, ROOT, true)[0]).toBe(
      '\nskills/csvsum/SKILL.md — 1 warning:',
    );
    expect(formatAuditFindingsLines(rendering, ROOT, false)[0]).toBe(
      '\nskills/csvsum/SKILL.md — 1 error:',
    );
  });

  it('never renders an allow-listed finding, at any verbosity', () => {
    for (const verbose of [false, true]) {
      const lines = formatAuditFindingsLines(
        [skillResult('example-skill', [issue('ignore', 'LINK_BROKEN')])],
        ROOT,
        verbose,
      );
      expect(renderedLabels(lines)).toEqual([]);
      expect(lines.join('\n')).not.toContain('LINK_BROKEN fired');
    }
  });

  it('leaves the issue arrays the YAML document is serialized from untouched', () => {
    // The human collapse is a PROJECTION. `runAuditAtPath` builds the YAML
    // document and this report from the same `results` array, so a renderer that
    // filtered in place would silently strip findings out of the machine-readable
    // document that CI parses.
    const results = mixedFixture();
    formatAuditFindingsLines(results, ROOT, false);
    formatAuditFindingsLines(results, ROOT, true);

    expect(results[0]?.issues).toHaveLength(5);
    expect(results[0]?.issues.map((i) => i.code)).toEqual([
      'SKILL_MISSING_DESCRIPTION',
      'LINK_DROPPED_BY_DEPTH',
      'LINK_DROPPED_BY_DEPTH',
      'LINK_DROPPED_BY_DEPTH',
      'NON_PORTABLE_ASSET_REFERENCE',
    ]);
    expect(results[0]?.issueCounts).toEqual({ errors: 1, warnings: 3, info: 1 });
  });

  it('renders one block per result, so a multi-file report stays attributable', () => {
    const lines = formatAuditFindingsLines(
      [
        skillResult('csv-summarizer', [issue('error', 'E1')]),
        skillResult('csvsum', [issue('error', 'E2')]),
      ],
      ROOT,
      false,
    );
    expect(lines.filter((l) => l.includes('SKILL.md'))).toHaveLength(2);
    expect(renderedLabels(lines)).toEqual(['ERROR', 'ERROR']);
  });
});
