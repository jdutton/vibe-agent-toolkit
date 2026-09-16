/**
 * `claude_rule_patterns` — the table's own contract, independent of its producer.
 *
 * Every assertion below is one of the four things a table has to do to be real —
 * registration, partitioning, ordering, hydration — asked of rows this file
 * contributes BY HAND. It was written while the table had no producer at all;
 * `ClaudeRulesScopeContributor` has since become one, and these stay exactly as
 * they were, because what they pin is the contract a producer has to produce
 * against rather than the producing. `projection-claude-rules-scope.test.ts`
 * covers that half, and the integration suite covers the two lanes.
 */

import { describe, expect, it } from 'vitest';

import { DERIVED_TABLES } from '../src/projection/derived-table-registry.js';
import { exportProjection } from '../src/projection/export.js';
import { ProjectionBuilder, type Projection } from '../src/projection/projection.js';
import { assembleProjection, emptyBlobRows, selectRequestedRows } from '../src/projection/store-hydration.js';
import { splitProjectionByScope } from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import type { ClaudeRulePatternRow } from '../src/schemas/projection-claude-rules.js';

/** A corpus root. Nothing here touches disk; the builder only needs a string. */
const ROOT = '/vat-corpus/claude-rule-patterns';

const RULE_A = 'res-rule-a';
const RULE_B = 'res-rule-b';

/** The table under test, spelled once. */
const SPEC = PROJECTION_TABLES.claudeRulePatterns;

/**
 * One well-formed row, with every column overridable.
 *
 * @param overrides - Columns to replace
 * @returns A row the table's own schema accepts
 */
function patternRow(overrides: Partial<ClaudeRulePatternRow> = {}): ClaudeRulePatternRow {
  return {
    resourceId: RULE_A,
    ordinal: 0,
    pattern: 'packages/**/src/**/*.ts',
    literalPrefix: 'packages',
    witnessPath: 'packages/utils/src/index.ts',
    status: 'matched',
    ...overrides,
  };
}

/**
 * A projection holding exactly the given pattern rows.
 *
 * @param rows - The rows to contribute, in order
 * @returns The built projection
 */
function projectionWith(rows: readonly ClaudeRulePatternRow[]): Projection {
  const builder = new ProjectionBuilder({ root: ROOT });
  for (const row of rows) builder.addClaudeRulePattern(row);
  return builder.build();
}

describe('claude_rule_patterns registration', () => {
  it('is a materialized table, not a derived relation', () => {
    // The boundary `derived-table-registry.ts` draws: a (rule, pattern, tree)
    // fact is populated FROM a tree, so it is legitimately materialized. A
    // derived relation is the output of evaluating a lens and has no scope at
    // all — registering this one there would make it unstorable.
    expect(Object.keys(PROJECTION_TABLES)).toContain('claudeRulePatterns');
    expect(Object.keys(DERIVED_TABLES)).not.toContain('claudeRulePatterns');
  });

  it('declares the SQL name, scope, key and column order the shape states', () => {
    expect(SPEC.name).toBe('claude_rule_patterns');
    expect(SPEC.scope).toBe('extent');
    expect([...SPEC.primaryKey]).toStrictEqual(['resourceId', 'ordinal']);
    expect([...SPEC.columns]).toStrictEqual([
      'resourceId',
      'ordinal',
      'pattern',
      'literalPrefix',
      'witnessPath',
      'status',
    ]);
  });

  it('declares no context column — a pattern is a fact about an IDENTITY', () => {
    // `resources` and `resource_tags` are the precedent: a row keyed on an
    // identity is merged by primary key, not partitioned per extent. Declaring a
    // context column here would make a write REPLACE per context, and the key
    // `(resourceId, ordinal)` names no context to replace under.
    expect(SPEC.contextColumn).toBeUndefined();
  });
});

describe('claude_rule_patterns row shape', () => {
  it('round-trips a row through its own schema', () => {
    expect(SPEC.schema.parse(patternRow())).toStrictEqual(patternRow());
  });

  it('accepts all three statuses, and a null witness beside each', () => {
    // The three-state column, asserted as three states. `unevaluated` beside a
    // null witness is the case a two-state column cannot express: the pattern
    // was never run, so its null witness is a REFUSAL, not inertness.
    for (const status of ['matched', 'inert', 'unevaluated']) {
      expect(SPEC.schema.parse(patternRow({ status, witnessPath: null }))).toMatchObject({ status });
    }
  });

  it('refuses a column the table does not declare', () => {
    // The positive control on the assertion above: `.strict()` is what makes a
    // successful parse evidence about the column SET and not only its values.
    expect(() => SPEC.schema.parse({ ...patternRow(), matchCount: 3 })).toThrow();
  });
});

describe('claude_rule_patterns in the builder', () => {
  it('records a row and hands it back', () => {
    expect(projectionWith([patternRow()]).claudeRulePatterns).toStrictEqual([patternRow()]);
  });

  it('de-duplicates on (resourceId, ordinal) and keeps the first row', () => {
    const first = patternRow({ pattern: 'docs/**' });
    const second = patternRow({ pattern: 'src/**', witnessPath: null, status: 'inert' });

    const rows = projectionWith([first, second]).claudeRulePatterns;

    expect(rows).toStrictEqual([first]);
  });

  it('keeps two rows that differ only in ordinal', () => {
    // The positive control on the collapse above: same identity, different slot
    // in the same `paths:` list, both survive.
    const rows = projectionWith([patternRow(), patternRow({ ordinal: 1 })]).claudeRulePatterns;

    expect(rows.map((row) => row.ordinal)).toStrictEqual([0, 1]);
  });
});

describe('claude_rule_patterns partitioning', () => {
  it('lands in the extent bundle and not in the blob bundle', () => {
    // Scope decides which half of a store a table is written to. Filed as a blob
    // it would be served to any corpus holding the same bytes — but a witness
    // path is a fact about a TREE, so the row would name a file the reading
    // corpus does not have.
    const split = splitProjectionByScope(projectionWith([patternRow()]));

    expect((split.extent as unknown as Record<string, unknown[]>)['claudeRulePatterns'])
      .toStrictEqual([patternRow()]);
    expect(Object.keys(split.blobs)).not.toContain('claudeRulePatterns');
  });
});

describe('claude_rule_patterns in the exported document', () => {
  it('sorts by the declared primary key — identity first, then ordinal', () => {
    // Three rows across TWO identities with the ordinals crossed. Keyed
    // identity-first they come back a/2, a/10, b/1; keyed ordinal-first they
    // would come back b/1, a/2, a/10. A fixture on one identity cannot tell
    // those apart, and a string sort would put 10 before 2.
    const rows = exportProjection(projectionWith([
      patternRow({ resourceId: RULE_B, ordinal: 1 }),
      patternRow({ resourceId: RULE_A, ordinal: 10 }),
      patternRow({ resourceId: RULE_A, ordinal: 2 }),
    ])).tables.claudeRulePatterns;

    expect(rows.map((row) => [row.resourceId, row.ordinal])).toStrictEqual([
      [RULE_A, 2],
      [RULE_A, 10],
      [RULE_B, 1],
    ]);
  });

  it('is emitted at the registry position its declaration order gives it', () => {
    const tables = exportProjection(new ProjectionBuilder({ root: ROOT }).build()).tables;

    expect(Object.keys(tables).indexOf('claudeRulePatterns'))
      .toBe(Object.keys(PROJECTION_TABLES).indexOf('claudeRulePatterns'));
  });
});

describe('claude_rule_patterns hydration', () => {
  it('survives a hydration that holds none of its rows, as an empty table', () => {
    // A table a stored extent holds nothing for must hydrate as `[]`, never as
    // `undefined`: every consumer iterates `projection.claudeRulePatterns`
    // directly, and an absent field is a TypeError at the first reader rather
    // than a cache miss anyone can diagnose.
    const stored = selectRequestedRows(
      splitProjectionByScope(new ProjectionBuilder({ root: ROOT }).build()).extent,
      { contexts: [], rootId: 'root-none' },
    );

    const hydrated = assembleProjection(stored, emptyBlobRows());

    expect(hydrated.claudeRulePatterns).toStrictEqual([]);
  });

  it('keeps a row whose identity a kept realization names, and drops one it does not', () => {
    // The reachability rule the three context-less tables are recovered by. The
    // pair is the point: a filter that kept everything and one that kept nothing
    // both satisfy either half alone.
    const builder = new ProjectionBuilder({ root: ROOT });
    builder.addExtentMembership({ resourceId: RULE_A, extentId: 'ctx-kept' });
    builder.addContext({
      contextId: 'ctx-kept',
      species: 'extent',
      kind: 'filesystem',
      rootId: 'root-none',
      extentContextId: null,
      role: null,
    });
    builder.addClaudeRulePattern(patternRow({ resourceId: RULE_A }));
    builder.addClaudeRulePattern(patternRow({ resourceId: RULE_B }));

    const kept = selectRequestedRows(
      splitProjectionByScope(builder.build()).extent,
      { contexts: ['ctx-kept'], rootId: 'root-none' },
    );

    expect(kept.claudeRulePatterns.map((row) => row.resourceId)).toStrictEqual([RULE_A]);
  });
});
