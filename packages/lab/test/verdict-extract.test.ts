/**
 * Reading a verdict — exit code plus the multiset of findings — out of a
 * finished run's stdout, for both envelope shapes.
 *
 * The legacy cases are the hard ones: `vat audit` nests a file's issues under
 * `files[]` and gives most of them no `location` of their own (they inherit the
 * enclosing file's `path`), while ALSO printing a run-level `issues[]` that has
 * no enclosing file at all. `agent-skills`' `ignoredErrors` looks close enough to
 * a finding (it has a `code`) to be worth a dedicated case proving it is never
 * one — it carries no `severity`.
 */

import { readFileSync } from 'node:fs';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  extractVerdict,
  locationDigest,
  phaseSeverityCounts,
  publishedTallies,
  refusalCodes,
  UNCODED_REFUSAL,
} from '../src/facets/verdict/extract.js';
import type { VerdictRow } from '../src/facets/verdict/types.js';
import type { RunOutcome } from '../src/harness/outcome.js';

const FIXTURES = resolveFromImportMeta(import.meta.url, 'fixtures/verdict');

function fixture(name: string): string {
  return readFileSync(safePath.join(FIXTURES, name), 'utf-8');
}

/** An `exited` outcome whose stdout is one inline legacy document. */
function legacyStdout(document: Record<string, unknown>): Extract<RunOutcome, { kind: 'exited' }> {
  return { kind: 'exited', exitCode: 1, stdout: JSON.stringify(document), stderr: '' };
}

/** An `exited` outcome wrapping one fixture's stdout. */
function exited(name: string, exitCode = 1): Extract<RunOutcome, { kind: 'exited' }> {
  return { kind: 'exited', exitCode, stdout: fixture(name), stderr: '' };
}

describe('extractVerdict', () => {
  it('extracts report findings with location and scope', () => {
    const verdict = extractVerdict(exited('report-with-gate.json'));
    expect(verdict.shape).toBe('report');
    expect(verdict.findings).toContainEqual({
      code: 'RESOURCES_CHECK_FAILED',
      severity: 'error',
      location: 'packages/lab/docs/facets.md',
      scope: JSON.stringify({ root: 'packages/lab' }),
    });
    expect(verdict.findings).toContainEqual({
      code: 'LINK_INTEGRITY_BROKEN',
      severity: 'warning',
      location: 'docs/README.md',
      scope: null,
    });
  });

  it('extracts legacy audit findings with location inherited from the file row', () => {
    const verdict = extractVerdict(exited('legacy-audit.yaml'));
    expect(verdict.shape).toBe('legacy');
    // files[0].issues[0] (MARKETPLACE_MISSING_MANIFEST) has no location of its
    // own; it must inherit its row's `path: plugins/p`.
    expect(verdict.findings).toContainEqual({
      code: 'MARKETPLACE_MISSING_MANIFEST',
      severity: 'error',
      location: 'plugins/p',
      scope: null,
    });
    // files[1].issues[0] names its own location, which must win over the row's path.
    expect(verdict.findings).toContainEqual({
      code: 'SKILL_TOO_LONG',
      severity: 'warning',
      location: 'plugins/q/SKILL.md',
      scope: null,
    });
  });

  it('extracts the run-level issues list of legacy audit', () => {
    const verdict = extractVerdict(exited('legacy-audit.yaml'));
    expect(verdict.findings).toContainEqual({
      code: 'RESOURCE_CHECK_BROKEN',
      severity: 'error',
      location: null,
      scope: null,
    });
  });

  it('drops ignore-severity entries from legacy skills validate', () => {
    const verdict = extractVerdict(exited('legacy-skills-validate-verbose.yaml'));
    expect(verdict.findings.some((f) => f.code === 'SKILL_TOO_MANY_FILES')).toBe(false);
    expect(verdict.findings).toContainEqual({
      code: 'SKILL_DESCRIPTION_TOO_LONG',
      severity: 'error',
      location: 'plugins/my-plugin/skills/my-skill/SKILL.md',
      scope: null,
    });
  });

  it('keeps duplicate findings as a multiset', () => {
    const verdict = extractVerdict(legacyStdout({
      issues: [
        { code: 'LINK_INTEGRITY_BROKEN', severity: 'error', message: 'Broken link to ./missing.md' },
        { code: 'LINK_INTEGRITY_BROKEN', severity: 'error', message: 'Broken link to ./missing.md' },
      ],
    }));
    const duplicates = verdict.findings.filter(
      (f) => f.code === 'LINK_INTEGRITY_BROKEN' && f.severity === 'error' && f.location === null,
    );
    expect(duplicates).toHaveLength(2);
  });

  // A report finding the lab cannot read is not a quiet `info` with no code: the
  // document is unreadable, so the row measured nothing — as strict as the legacy
  // reader, which never takes an object without a code and a known severity for a finding.
  it.each([
    ['no code', { severity: 'error', message: 'x' }],
    ['a code that is not a string', { code: 7, severity: 'error' }],
    ['a severity outside error|warning|info', { code: 'LINK_BROKEN_FILE', severity: 'notice' }],
    ['no severity', { code: 'LINK_BROKEN_FILE' }],
    ['an element that is not an object', 'LINK_BROKEN_FILE'],
  ])('reads a report whose findings[] holds %s as unparsed, never as a coerced finding', (_label, malformed) => {
    const report = (findings: unknown[]): Extract<RunOutcome, { kind: 'exited' }> => ({
      kind: 'exited',
      exitCode: 1,
      stdout: JSON.stringify({ status: 'findings', examined: 1, findings, summary: { errors: 1, warnings: 0, info: 0 }, data: {} }),
      stderr: '',
    });
    const wellFormed = { code: 'LINK_BROKEN_FILE', severity: 'error', location: 'docs/a.md' };

    // Positive control: the same document with only well-formed findings is a report.
    expect(extractVerdict(report([wellFormed]))).toMatchObject({ shape: 'report', findings: [{ code: 'LINK_BROKEN_FILE' }] });
    expect(extractVerdict(report([wellFormed, malformed]))).toEqual({ exitCode: 1, shape: 'unparsed', findings: [] });
  });

  it('returns an empty list, not a guess, for an unparsed document', () => {
    const verdict = extractVerdict({ kind: 'exited', exitCode: 2, stdout: 'a: [1, 2\n', stderr: 'boom' });
    expect(verdict.shape).toBe('unparsed');
    expect(verdict.findings).toEqual([]);
    expect(verdict.exitCode).toBe(2);
  });
});

/**
 * Where a legacy finding with no `location` of its own is anchored: ONE
 * structural rule across every legacy shape. The finding's own `location`,
 * then its own `path`, then its own `file`; otherwise the nearest enclosing
 * object carrying a `path` or a `file` — `path` winning when one object carries
 * both — else `null`.
 *
 * `file` is here because rc.11's `vat resources validate --verbose` keys each
 * row's file as `file` (`issues[].file` over `issues[].issues[]`). Read as
 * `path`-only, every one of its findings compared as `location: null` against
 * a report build's `location: docs/a.md` — a delta the instrument invented.
 */
describe('legacy finding location', () => {
  it('takes the enclosing row\'s `file` when only `file` is present — rc.11 resources validate --verbose', () => {
    const verdict = extractVerdict(exited('legacy-resources-validate.json'));
    expect(verdict.findings.map((f) => f.location)).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('takes the enclosing `path` over `file` when one object carries both', () => {
    const verdict = extractVerdict(legacyStdout({
      files: [{ path: 'plugins/p/SKILL.md', file: 'SKILL.md', issues: [{ code: 'X', severity: 'error' }] }],
    }));
    expect(verdict.findings.map((f) => f.location)).toEqual(['plugins/p/SKILL.md']);
  });

  it('is null when neither the finding nor any enclosing object names a `path` or a `file`', () => {
    const verdict = extractVerdict(legacyStdout({ rows: [{ issues: [{ code: 'X', severity: 'warning' }] }] }));
    expect(verdict.findings.map((f) => f.location)).toEqual([null]);
  });

  it('takes a finding\'s OWN `path` over an enclosing `file` that means something else — rc.11 claude context', () => {
    // An rc.11 `claude context` answer carries `file` (the file the QUESTION was
    // about) above `conditions[]`, each of which names its own `path`. The
    // condition's own path is where it is; the answer's `file` is not.
    const verdict = extractVerdict(legacyStdout({
      kind: 'answer',
      answers: [{ file: 'CLAUDE.md', conditions: [{ code: 'RULE_GLOB_INERT', severity: 'warning', path: '.claude/rules/x.md' }] }],
    }));
    expect(verdict.findings.map((f) => f.location)).toEqual(['.claude/rules/x.md']);
  });
});

/**
 * @param document - A legacy document
 * @returns A row that exited 1 printing it
 */
function row(document: Record<string, unknown>): VerdictRow {
  return { name: 'verify', argv: ['verify'], outcome: 'exited', exitCode: 1, spawnError: null, document: JSON.stringify(document) };
}

describe('publishedTallies', () => {
  it('sums every owner\'s tally per code and per severity, and never counts an itemized finding', () => {
    const tallies = publishedTallies(row({
      results: [
        { skillName: 'one', info: 2, codes: { LINK_DROPPED_BY_DEPTH: 2, SKILL_TOO_LONG: 0 } },
        { skillName: 'two', info: 1, warnings: 1, codes: { LINK_DROPPED_BY_DEPTH: 1, SKILL_TOO_LONG: 1 } },
      ],
      runIssues: [{ code: 'ALLOW_UNUSED', severity: 'warning' }],
    }));

    expect(tallies).toEqual({
      byCode: new Map([['LINK_DROPPED_BY_DEPTH', 3], ['SKILL_TOO_LONG', 1]]),
      bySeverity: { error: 0, warning: 1, info: 3 },
      total: 4,
      phases: [],
    });
  });

  it('never reads a `codes` object that is not a tally — a lowercase key, a non-integer, a negative count', () => {
    for (const codes of [{ lowercase: 1 }, { CODE: 1.5 }, { CODE: -1 }, { CODE: '1' }, {}]) {
      expect(publishedTallies(row({ info: 1, codes }))?.total).toBe(0);
    }
  });

  // Half a tally would let a compare vouch for a severity nobody published.
  it('never reads an owner whose severity counts do not sum to its code counts', () => {
    expect(publishedTallies(row({ info: 2, codes: { CODE: 2 } }))?.total).toBe(2); // positive control
    for (const owner of [{ codes: { CODE: 2 } }, { info: 1, codes: { CODE: 2 } }, { info: 'two', codes: { CODE: 2 } }]) {
      expect(publishedTallies(row(owner))?.total).toBe(0);
    }
  });

  it('has no tallies for a row that produced no exit code or an unreadable document', () => {
    expect(publishedTallies({ ...row({}), outcome: 'not-run', exitCode: null })).toBeNull();
    expect(publishedTallies({ ...row({}), document: 'not: [yaml' })).toBeNull();
  });
});

describe('publishedTallies — the phases that tallied', () => {
  it('names each phase holding a tally, and no phase that only itemizes', () => {
    const tallies = publishedTallies(row({
      phases: [
        { name: 'skills', report: { results: [{ skillName: 'one', info: 1, codes: { CODE: 1 } }] } },
        { name: 'consistency', issues: [{ code: 'OTHER', severity: 'info' }] },
      ],
    }));

    expect(tallies?.phases).toEqual(['skills']);
  });
});

describe('phaseSeverityCounts', () => {
  it('reads a legacy phase from issueCounts or report.issueCounts, and a report phase from summary', () => {
    const counts = { errors: 1, warnings: 2, info: 3 };
    const expected = { error: 1, warning: 2, info: 3 };

    expect(phaseSeverityCounts(row({ phases: [{ name: 'a', issueCounts: counts }, { name: 'b', report: { issueCounts: counts } }] }))).toEqual(
      new Map([['a', expected], ['b', expected]]),
    );
    expect(phaseSeverityCounts(row({ status: 'findings', examined: 1, findings: [], summary: counts, data: { phases: [{ name: 'a', summary: counts }] } }))).toEqual(
      new Map([['a', expected]]),
    );
  });

  it('has no entry for a phase that publishes no counts, and none at all for a document without phases', () => {
    expect(phaseSeverityCounts(row({ phases: [{ name: 'a' }] }))).toEqual(new Map());
    expect(phaseSeverityCounts(row({ results: [] }))).toEqual(new Map());
  });
});

describe('refusalCodes', () => {
  it('reads the run\'s refusal code, then each named phase\'s as name:code, in document order', () => {
    const document = {
      status: 'error',
      examined: 1,
      findings: [],
      summary: { errors: 0, warnings: 0, info: 0 },
      error: { code: 'RUN_INCOMPLETE', message: 'm' },
      data: { phases: [{ name: 'skills', status: 'ok' }, { name: 'claude', status: 'error', error: { code: 'INTERNAL_ERROR', message: 'm' } }] },
    };

    expect(refusalCodes({ ...row(document), exitCode: 2 })).toEqual(['RUN_INCOMPLETE', 'claude:INTERNAL_ERROR']);
  });

  // An older build's refusal is a sentence. It IS a refusal — unlike empty
  // stdout — so it is named, with no code to name it by.
  it('reads a refusal that is a sentence as (uncoded), at the root and on a named phase', () => {
    const legacy = { status: 'system-error', error: 'Phase claude exited with code 2', phases: [{ name: 'claude', error: 'exited 2' }] };

    expect(refusalCodes(row(legacy))).toEqual([UNCODED_REFUSAL, `claude:${UNCODED_REFUSAL}`]);
    // The committed deltas file spells this value, so it is pinned here: no real
    // refusal code — uppercase letters and underscores — can ever equal it.
    expect(UNCODED_REFUSAL).toBe('(uncoded)');
  });

  it('publishes none for a document that refuses nothing, a row that did not run, or unreadable or empty stdout', () => {
    expect(refusalCodes(row({ status: 'success', error: '' }))).toEqual([]);
    expect(refusalCodes({ ...row({}), document: '' })).toEqual([]);
    expect(refusalCodes({ ...row({}), outcome: 'not-run', exitCode: null })).toEqual([]);
    expect(refusalCodes({ ...row({}), document: 'not: [yaml' })).toEqual([]);
  });
});

describe('locationDigest', () => {
  it('is the SHA-256 of the location, as lowercase hex', () => {
    expect(locationDigest('docs/a.md')).toMatch(/^[0-9a-f]{64}$/u);
    expect(locationDigest('docs/a.md')).toBe(locationDigest('docs/a.md'));
    expect(locationDigest('docs/a.md')).not.toBe(locationDigest('docs/b.md'));
    expect(locationDigest('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
