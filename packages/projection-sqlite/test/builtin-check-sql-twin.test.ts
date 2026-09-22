/**
 * Each built-in check's documented SQL twin selects exactly the violations its
 * TypeScript predicate reports, over the same rows.
 *
 * The twin is what `--help` and `validation-codes.md` tell an adopter to copy
 * into `resources.checks`. It shipped as a `LEFT JOIN resource_realizations`,
 * which returns one row per REALIZATION — and a rules file is realized once per
 * extent that reaches it — while the predicate reports one finding per pattern.
 * A copied twin reported every dead glob several times.
 *
 * Here rather than in `resources`, because only this package has an engine to
 * run the SQL on.
 */

import {
  BUILTIN_CHECKS,
  CLAUDE_RULE_FRONTMATTER_INVALID_CHECK,
  CLAUDE_RULE_GLOB_INERT_CHECK,
  type ExtentKey,
  type ExtentScopedRows,
} from '@vibe-agent-toolkit/resources';
import { afterEach, describe, expect, it } from 'vitest';

import { openEphemeralProjectionStore, type SqlQueryableStore } from '../src/store.js';

import { contentKey, realizationRow, sampleBlobRows, sampleExtentRows } from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

const RULES_ID = 'res-rules';
const RULES_PATH = '.claude/rules/demo.md';
/** A rules identity with no realization row — the twin's LEFT JOIN arm. */
const UNREALIZED_ID = 'res-unrealized';

/**
 * One tree whose rules file is realized under TWO extents, carrying every
 * status, plus an inert pattern whose file has no realization at all.
 *
 * @returns The extent rows
 */
function fannedOutRows(): ExtentScopedRows {
  const base = sampleExtentRows(KEY.rootId);
  const pattern = (
    resourceId: string,
    ordinal: number,
    status: ExtentScopedRows['claudeRulePatterns'][number]['status'],
  ): ExtentScopedRows['claudeRulePatterns'][number] => ({
    resourceId,
    ordinal,
    pattern: `glob-${String(ordinal)}/**`,
    literalPrefix: `glob-${String(ordinal)}`,
    witnessPath: status === 'matched' ? 'docs/a.md' : null,
    status,
  });
  return {
    ...base,
    resourceRealizations: [
      ...base.resourceRealizations,
      realizationRow({ resourceId: RULES_ID, extentId: 'ext-1', path: RULES_PATH }),
      realizationRow({ resourceId: RULES_ID, extentId: 'ext-2', path: RULES_PATH }),
    ],
    claudeRulePatterns: [
      pattern(RULES_ID, 0, 'inert'),
      pattern(RULES_ID, 1, 'matched'),
      pattern(RULES_ID, 2, 'unevaluated'),
      pattern(RULES_ID, 3, 'inert'),
      pattern(RULES_ID, 4, 'gitignored'),
      pattern(UNREALIZED_ID, 0, 'inert'),
    ],
  };
}

let store: SqlQueryableStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
});

describe('built-in SQL twins', () => {
  it('covers every built-in', () => {
    // A new built-in must bring its own differential below.
    expect(BUILTIN_CHECKS.map((check) => check.name))
      .toEqual([CLAUDE_RULE_GLOB_INERT_CHECK.name, CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.name]);
  });

  it('claude-rule-glob-inert: one row per finding, anchored where the finding is', async () => {
    const rows = fannedOutRows();
    store = openEphemeralProjectionStore();
    await store.writeExtent(KEY, rows);

    const fromSql = store.query(CLAUDE_RULE_GLOB_INERT_CHECK.sqlTwin)
      .map((row) => `${typeof row['path'] === 'string' ? row['path'] : ''} paths[${Number(row['ordinal'])}]`)
      .sort((a, b) => a.localeCompare(b));
    const fromPredicate = CLAUDE_RULE_GLOB_INERT_CHECK.run({ ...rows, blobs: [] })
      .map((issue) => `${issue.location ?? ''} ${issue.field ?? ''}`)
      .sort((a, b) => a.localeCompare(b));

    // Non-vacuous: two realized findings (fanned out twice each by the old twin)
    // and the unanchored one.
    expect(fromPredicate).toEqual([' paths[0]', `${RULES_PATH} paths[0]`, `${RULES_PATH} paths[3]`]);
    expect(fromSql).toEqual(fromPredicate);
  });

  it('claude-rule-frontmatter-invalid: one row per broken rules FILE, never per realization', async () => {
    const broken = contentKey('c');
    const healthy = contentKey('d');
    const HEALTHY_RULES = '.claude/rules/fine.md';
    const base = sampleExtentRows(KEY.rootId);
    const rows: ExtentScopedRows = {
      ...base,
      resourceRealizations: [
        ...base.resourceRealizations,
        // Realized under two extents: the fan-out a join would repeat.
        { ...realizationRow({ resourceId: RULES_ID, extentId: 'ext-1', path: RULES_PATH }), contentKey: broken },
        { ...realizationRow({ resourceId: RULES_ID, extentId: 'ext-2', path: RULES_PATH }), contentKey: broken },
        { ...realizationRow({ resourceId: 'res-fine', extentId: 'ext-1', path: HEALTHY_RULES }), contentKey: healthy },
        // Same broken bytes, NOT a rules file: validate's business, not this check's.
        { ...realizationRow({ resourceId: 'res-doc', extentId: 'ext-1', path: 'docs/copy.md' }), contentKey: broken },
      ],
      resourceTags: [
        ...base.resourceTags,
        { resourceId: RULES_ID, tag: 'rules-file', value: null, source: 'agentic-convention' },
        { resourceId: 'res-fine', tag: 'rules-file', value: null, source: 'agentic-convention' },
      ],
    };
    const brokenBlob = { ...sampleBlobRows(broken).blobs[0], contentKey: broken, frontmatter: null, frontmatterError: 'bad yaml' };
    const healthyBlob = { ...sampleBlobRows(healthy).blobs[0], contentKey: healthy };
    store = openEphemeralProjectionStore();
    await store.writeBlobFacts({ blobs: [brokenBlob, healthyBlob], blobReferences: [], blobSections: [], blobConditions: [] });
    await store.writeExtent(KEY, rows);

    const fromSql = store.query(CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.sqlTwin)
      .map((row) => String(row['path']))
      .sort((a, b) => a.localeCompare(b));
    const fromPredicate = CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.run({ ...rows, blobs: [brokenBlob, healthyBlob] })
      .map((issue) => issue.location ?? '')
      .sort((a, b) => a.localeCompare(b));

    // Non-vacuous: exactly the one broken rules file.
    expect(fromPredicate).toEqual([RULES_PATH]);
    expect(fromSql).toEqual(fromPredicate);
  });
});
