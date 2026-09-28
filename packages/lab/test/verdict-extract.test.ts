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

import { extractVerdict } from '../src/facets/verdict/extract.js';
import type { RunOutcome } from '../src/harness/outcome.js';

const FIXTURES = resolveFromImportMeta(import.meta.url, 'fixtures/verdict');

function fixture(name: string): string {
  return readFileSync(safePath.join(FIXTURES, name), 'utf-8');
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
    const verdict = extractVerdict(exited('legacy-resources-validate.json'));
    const duplicates = verdict.findings.filter(
      (f) => f.code === 'LINK_INTEGRITY_BROKEN' && f.severity === 'error' && f.location === null,
    );
    expect(duplicates).toHaveLength(2);
  });

  it('returns an empty list, not a guess, for an unparsed document', () => {
    const verdict = extractVerdict({ kind: 'exited', exitCode: 2, stdout: 'a: [1, 2\n', stderr: 'boom' });
    expect(verdict.shape).toBe('unparsed');
    expect(verdict.findings).toEqual([]);
    expect(verdict.exitCode).toBe(2);
  });
});
