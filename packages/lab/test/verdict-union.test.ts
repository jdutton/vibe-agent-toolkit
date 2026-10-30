/**
 * The verdict facet's union mode: a "row" may be a SEQUENCE of rows, whose
 * findings are the union of its steps' documents, keyed by
 * `(code, location, line, severity)`. Coverage asks whether every key of one
 * union is in the other — bar 3's `union(B) ⊆ findings(C)`.
 */

import { describe, expect, it } from 'vitest';

import type { VerdictBody, VerdictRow } from '../src/facets/verdict/types.js';
import { unionCoverage, unionFindings } from '../src/facets/verdict/union.js';

/** A `Report<T>` row whose document carries these findings. */
function reportRow(name: string, findings: readonly Record<string, unknown>[], exitCode = 1): VerdictRow {
  return {
    name,
    argv: [name],
    outcome: 'exited',
    exitCode,
    spawnError: null,
    document: JSON.stringify({ status: 'findings', examined: 1, findings, summary: {}, data: {} }),
  };
}

const BROKEN = { code: 'LINK_BROKEN', severity: 'error', location: 'docs/a.md', line: 3, message: 'm' };
const SAME_FILE_OTHER_LINE = { ...BROKEN, line: 9 };
const SCHEMA = { code: 'FRONTMATTER_SCHEMA', severity: 'warning', location: 'docs/b.md', message: 'm' };

/** A body holding these rows. */
function body(rows: readonly VerdictRow[]): VerdictBody {
  return { arm: { set: {}, unset: [] }, rows, excluded: [] };
}

describe('unionFindings', () => {
  it('unions the named rows’ findings, keyed by code, location, line and severity', () => {
    const union = unionFindings(body([reportRow('resources-validate-ci', [BROKEN, SAME_FILE_OTHER_LINE]), reportRow('resources-check-ci', [SCHEMA, BROKEN])]), [
      'resources-validate-ci',
      'resources-check-ci',
    ]);

    // The same finding from two steps is one key; the same code on another
    // line of the same file is another.
    expect(union).toEqual({
      ok: true,
      keys: [
        { code: 'FRONTMATTER_SCHEMA', location: 'docs/b.md', line: null, severity: 'warning' },
        { code: 'LINK_BROKEN', location: 'docs/a.md', line: 3, severity: 'error' },
        { code: 'LINK_BROKEN', location: 'docs/a.md', line: 9, severity: 'error' },
      ],
    });
  });

  it('refuses a name the body has no row for, rather than unioning fewer steps', () => {
    expect(unionFindings(body([reportRow('a', [])]), ['a', 'b'])).toEqual({
      ok: false,
      refusal: expect.stringContaining("'b'") as unknown,
    });
  });

  it('refuses a step that never ran, or whose document the lab cannot read — absent is never empty', () => {
    const notRun: VerdictRow = { ...reportRow('a', []), outcome: 'not-run', exitCode: null, spawnError: 'ENOENT' };
    const unreadable: VerdictRow = { ...reportRow('b', []), document: 'not a document' };

    expect(unionFindings(body([notRun]), ['a']).ok).toBe(false);
    expect(unionFindings(body([unreadable]), ['b']).ok).toBe(false);
  });

  it('refuses a step that exited 2, a run that did not complete', () => {
    expect(unionFindings(body([reportRow('a', [], 2)]), ['a']).ok).toBe(false);
  });
});

describe('unionCoverage', () => {
  it('names every key of the left union the right union lacks', () => {
    const left = body([reportRow('resources-validate-ci', [BROKEN, SAME_FILE_OTHER_LINE]), reportRow('skills-validate-ci', [SCHEMA])]);
    const right = body([reportRow('validate', [SCHEMA, BROKEN])]);

    const coverage = unionCoverage(left, ['resources-validate-ci', 'skills-validate-ci'], right, ['validate']);

    expect(coverage).toEqual({
      ok: true,
      covered: false,
      missing: [{ code: 'LINK_BROKEN', location: 'docs/a.md', line: 9, severity: 'error' }],
    });
  });

  it('is covered when every left key is on the right — extra right keys are allowed', () => {
    const left = body([reportRow('a', [BROKEN])]);
    const right = body([reportRow('validate', [BROKEN, SCHEMA])]);

    expect(unionCoverage(left, ['a'], right, ['validate'])).toEqual({ ok: true, covered: true, missing: [] });
  });
});
