import { describe, expect, it } from 'vitest';

import { expandedPatternCount, selectRules } from '../src/projection/claude-context-rules.js';
import { RULE_SCOPE_TAG } from '../src/projection/contributors/claude-rules-scope.js';
import type { BlobRow } from '../src/schemas/projection-blobs.js';
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../src/schemas/projection-resources.js';

import { queryRealization, queryTag } from './helpers/context-query-rows.js';

/** The `rule-scope` tag `selectRules` reads a rule's scope class from. */
function scopeTag(path: string, value: string): ResourceTagRow {
  return queryTag(path, RULE_SCOPE_TAG, value);
}

/** The `rule-scope` value shared by every glob-matcher fixture below. */
const PATH_SCOPED = 'path-scoped';

/** A package directory: a query directory here, a nested rule's parent there. */
const PACKAGES_CLI = 'packages/cli';

/** The query directory several glob-matcher fixtures share. */
const PACKAGES_CLI_SRC = 'packages/cli/src';

/** The `paths:` glob several glob-matcher fixtures share. */
const TS_GLOB = 'packages/**/*.ts';

/** 11^4 = 14,641 expansions — over the documented 1,000-pattern budget. */
const OVER_BUDGET_PATTERN
  = 'src/{a,b,c,d,e,f,g,h,i,j,k}/{a,b,c,d,e,f,g,h,i,j,k}/{a,b,c,d,e,f,g,h,i,j,k}/{a,b,c,d,e,f,g,h,i,j,k}/x.ts';

/**
 * One identity's realizations across three extents.
 *
 * A rules file is itself an `@`-import root, so it is re-realized under its own
 * closure extent and under every closure that reaches it, and
 * `resource_realizations` is keyed `(extentId, path)` — three rows for one
 * identity is ordinary rather than pathological. Both of `selectRules`' outputs
 * derive from `scope` and `row.path`, which are identical across all three.
 *
 * @param path - The rule's root-relative path
 * @returns Three realization rows differing only in `extentId`
 */
function realizedInThreeExtents(path: string): ResourceRealizationRow[] {
  return ['extent:fs', 'extent:own-closure', 'extent:parent-closure'].map(
    (extentId) => ({ ...queryRealization(path), extentId }),
  );
}

function blob(path: string, paths: readonly string[] | undefined): BlobRow {
  return {
    contentKey: `key:${path}`, bytes: 100, encoding: 'utf-8', encodingSource: 'assumed',
    replacementCharacters: 0, tokenEstimate: 25,
    frontmatter: paths === undefined ? null : { paths: [...paths] },
    frontmatterError: null, wordCount: 10, proseCodeUnits: 100, codeBlockCodeUnits: 0,
    linkCount: 0, headingCount: 1, sectionCount: 1,
  };
}

describe('selectRules', () => {
  it('admits a root-scoped paths-less rule for any query', () => {
    const path = '.claude/rules/style.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, 'root')],
      blobs: [blob(path, undefined)], queryDir: PACKAGES_CLI, queryFile: null,
    });

    expect(result.rules).toEqual([{ resourceId: `id:${path}`, path, admission: { kind: 'root-rule' } }]);
  });

  it('admits a nested rule only for a query at or below its parent directory', () => {
    const path = 'packages/cli/.claude/rules/local.md';
    const input = {
      realizations: [queryRealization(path)], tags: [scopeTag(path, 'nested')],
      blobs: [blob(path, undefined)], queryFile: null,
    };

    expect(selectRules({ ...input, queryDir: PACKAGES_CLI_SRC }).rules[0]?.admission)
      .toEqual({ kind: 'nested-rule', under: PACKAGES_CLI });
    expect(selectRules({ ...input, queryDir: 'packages/rag' }).rules).toEqual([]);
  });

  it('admits a path-scoped rule for a FILE query only when a glob matches', () => {
    const path = '.claude/rules/ts.md';
    const input = {
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [TS_GLOB])], queryDir: PACKAGES_CLI_SRC,
    };

    expect(selectRules({ ...input, queryFile: 'packages/cli/src/index.ts' }).rules[0]?.admission)
      .toEqual({ kind: 'glob-rule', pattern: TS_GLOB });
    expect(selectRules({ ...input, queryFile: 'packages/cli/src/index.md' }).rules).toEqual([]);
  });

  it('answers a DIRECTORY query about a path-scoped rule as "may fire", never as a match', () => {
    const path = '.claude/rules/ts.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [TS_GLOB])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission).toEqual({ kind: 'glob-rule-may-fire' });
  });

  it('matches dotfile paths, which is an ASSUMPTION the limits record', () => {
    const path = '.claude/rules/dot.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, ['**/*.md'])], queryDir: '.claude', queryFile: '.claude/notes.md',
    });

    expect(result.rules).toHaveLength(1);
  });

  it('treats an over-budget brace pattern as a literal, matching nothing, and reports it', () => {
    const path = '.claude/rules/huge.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [OVER_BUDGET_PATTERN])], queryDir: 'src/a/a/a', queryFile: 'src/a/a/a/x.ts',
    });

    // picomatch would expand and match. The harness would not.
    expect(result.rules).toEqual([]);
    expect(result.overBudget).toEqual([path]);
  });

  it('reports an over-budget rule realized in THREE extents ONCE', () => {
    const path = '.claude/rules/huge.md';
    const result = selectRules({
      realizations: realizedInThreeExtents(path), tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [OVER_BUDGET_PATTERN])], queryDir: 'src/a/a/a', queryFile: 'src/a/a/a/x.ts',
    });

    // `overBudget` leaves through the same row loop the admissions do, so a
    // dedup applied only to the admissions would leave this one listing a
    // silently-broken rule three times.
    expect(result.overBudget).toEqual([path]);
  });

  it('admits a rule realized in THREE extents under ONE admission, not three', () => {
    const path = 'packages/cli/.claude/rules/local.md';
    const result = selectRules({
      realizations: realizedInThreeExtents(path), tags: [scopeTag(path, 'nested')],
      blobs: [blob(path, undefined)], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    // Three identical entries would say three predicates admitted the file when
    // one did.
    expect(result.rules).toEqual([
      { resourceId: `id:${path}`, path, admission: { kind: 'nested-rule', under: PACKAGES_CLI } },
    ]);
  });

  it('ignores a rule whose frontmatter did not parse to a paths array', () => {
    const path = '.claude/rules/broken.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [{ ...blob(path, undefined), frontmatter: { paths: 'not-an-array' } }],
      queryDir: 'src', queryFile: 'src/x.ts',
    });

    expect(result.rules).toEqual([]);
  });

  it('ignores a rule-scope value outside the closed vocabulary rather than treating it as path-scoped', () => {
    const path = '.claude/rules/foreign.md';
    const result = selectRules({
      realizations: [queryRealization(path)],
      // A config-declared tag, not the shipped producer's vocabulary.
      tags: [scopeTag(path, 'something-else')],
      blobs: [blob(path, ['**/*.ts'])],
      queryDir: 'src', queryFile: 'src/x.ts',
    });

    expect(result.rules).toEqual([]);
  });

  it('keeps only the string entries of a mixed-type paths array', () => {
    const path = '.claude/rules/mixed.md';
    const result = selectRules({
      realizations: [queryRealization(path)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [{ ...blob(path, undefined), frontmatter: { paths: ['src/**/*.ts', 123, null] } }],
      queryDir: 'src', queryFile: 'src/x.ts',
    });

    expect(result.rules[0]?.admission).toEqual({ kind: 'glob-rule', pattern: 'src/**/*.ts' });
  });
});

describe('expandedPatternCount', () => {
  it('multiplies brace groups', () => {
    expect(expandedPatternCount(['a/{x,y}/{p,q,r}.ts'])).toBe(6);
  });

  it('counts a brace-free pattern once', () => {
    expect(expandedPatternCount(['a/**/*.ts'])).toBe(1);
  });

  it('sums across the list, because the budget is shared', () => {
    expect(expandedPatternCount(['{a,b}.ts', '{c,d,e}.ts'])).toBe(5);
  });
});
