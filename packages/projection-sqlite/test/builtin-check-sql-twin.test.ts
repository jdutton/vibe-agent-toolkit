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
  CLAUDE_RULE_LINK_UNCHECKED_CHECK,
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

/**
 * The four case variants the shipped twin selected and the built-in never did.
 *
 * SQLite's `LIKE` is ASCII-case-insensitive by default, `GLOB` is not, and the
 * predicate compares segments byte for byte — so these are the rows on which the
 * twin and the check disagreed, and they are why this fixture is not four tidy
 * lowercase paths.
 */
const CASE_VARIANT_PATHS = [
  '.CLAUDE/rules/a.md',
  '.Claude/Rules/a.md',
  '.claude/RULES/a.md',
  'X/.CLAUDE',
] as const;

/**
 * The declined links recorded under the OUT-OF-ROOT code.
 *
 * ⭐ The twin selects on `code`, so a twin naming only some of the three declined-link
 * codes would drop exactly these — the arm whose rule Claude Code does not load
 * at all — while the predicate, which reads the set, still reported them. They
 * are listed apart from {@link LINK_PATHS} only so each side can be read; the
 * check treats the three codes identically.
 */
const OUTSIDE_ROOT_PATHS = [
  '.claude/rules/vendored.md',
  'sub/.claude/rules/shared-out',
] as const;

/**
 * The declined links recorded under the RESOLVES-NOWHERE code — the third
 * member of the set, for the same reason as {@link OUTSIDE_ROOT_PATHS}.
 */
const UNRESOLVED_PATHS = [
  '.claude/rules/dangling.md',
] as const;

/** Every declined link this differential is about, and one that is not a rules link. */
const LINK_PATHS = [
  // The two `=` arms: the root's own `.claude` and its own rules directory.
  '.claude',
  '.claude/rules',
  // The two ancestor arms: a nested `.claude` and a nested rules directory.
  'sub/.claude',
  'sub/.claude/rules',
  // Under a rules directory, root and nested, file and directory.
  '.claude/rules/x.md',
  '.claude/rules/nested/deep.md',
  'sub/.claude/rules/shared',
  // The negative: the commonest link in any corpus, and no business of this check.
  'CLAUDE.md',
  ...CASE_VARIANT_PATHS,
] as const;

/**
 * One condition row per declined link, plus `.claude/rules/x.md` twice.
 *
 * The duplicate is the point of the `DISTINCT`: one link met by the filesystem
 * walk and by git is two rows under two extent ids carrying one path, and a twin
 * without it would report the file twice while the predicate — which
 * de-duplicates by path — reported it once.
 *
 * @returns The extent rows, with the sample's own non-link condition kept as a
 *   second negative (same table, a different code)
 * @throws When the sample stops carrying a condition row to build these from —
 *   a silently empty fixture would make the differential agree on nothing
 */
function linkConditionRows(): ExtentScopedRows {
  const base = sampleExtentRows(KEY.rootId);
  const template = base.realizationConditions[0];
  if (template === undefined) throw new Error('sampleExtentRows carries no realizationConditions row');
  const condition = (
    path: string,
    extentId: string,
    code = 'EXTENT_SYMLINK_NOT_REALIZED',
  ): ExtentScopedRows['realizationConditions'][number] => ({
    ...template,
    extentId,
    path,
    code,
    severity: 'info',
    message: `'${path}' is a symbolic link`,
  });
  return {
    ...base,
    realizationConditions: [
      ...base.realizationConditions,
      ...LINK_PATHS.map((path) => condition(path, 'ext-1')),
      ...OUTSIDE_ROOT_PATHS.map((path) => condition(path, 'ext-1', 'EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT')),
      ...UNRESOLVED_PATHS.map((path) => condition(path, 'ext-1', 'EXTENT_SYMLINK_TARGET_UNRESOLVED')),
      condition('.claude/rules/x.md', 'ext-2'),
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
    expect(BUILTIN_CHECKS.map((check) => check.name)).toEqual([
      CLAUDE_RULE_GLOB_INERT_CHECK.name,
      CLAUDE_RULE_FRONTMATTER_INVALID_CHECK.name,
      CLAUDE_RULE_LINK_UNCHECKED_CHECK.name,
    ]);
  });

  it('claude-rule-glob-inert: one row per finding, anchored where the finding is', async () => {
    const rows = fannedOutRows();
    store = openEphemeralProjectionStore();
    await store.writeExtent(KEY, rows);

    const fromSql = store.query(CLAUDE_RULE_GLOB_INERT_CHECK.sqlTwin)
      .map((row) => `${typeof row['path'] === 'string' ? row['path'] : ''} ${String(row['pattern'])}`)
      .sort((a, b) => a.localeCompare(b));
    // ⛔ Keyed on the GLOB, not on `field`: `field` is the constant `paths` for
    // every finding now that a `paths:` scalar has no author slot to name, so a
    // key built on it cannot tell two dead globs of one file apart and the
    // differential would agree on a predicate that dropped one. The message
    // carries the pattern verbatim, which is the only per-finding identity both
    // sides hold.
    const fromPredicate = CLAUDE_RULE_GLOB_INERT_CHECK.run({ ...rows, blobs: [] })
      .map((issue) => `${issue.location ?? ''} ${/"([^"]+)"/.exec(issue.message)?.[1] ?? '<unquoted>'}`)
      .sort((a, b) => a.localeCompare(b));

    // Non-vacuous: two realized findings (fanned out twice each by the old twin)
    // and the unanchored one.
    expect(fromPredicate).toEqual([' glob-0/**', `${RULES_PATH} glob-0/**`, `${RULES_PATH} glob-3/**`]);
    expect(fromSql).toEqual(fromPredicate);
    // The one thing the key above can no longer see: every finding names the
    // frontmatter key itself, never an author slot.
    expect([...new Set(CLAUDE_RULE_GLOB_INERT_CHECK.run({ ...rows, blobs: [] }).map((i) => i.field))])
      .toEqual(['paths']);
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

  it('claude-rule-link-unchecked: the same rules links, and no case variant of one', async () => {
    const rows = linkConditionRows();
    store = openEphemeralProjectionStore();
    await store.writeExtent(KEY, rows);

    const fromSql = store.query(CLAUDE_RULE_LINK_UNCHECKED_CHECK.sqlTwin)
      .map((row) => String(row['path']))
      .sort((a, b) => a.localeCompare(b));
    const fromPredicate = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run({ ...rows, blobs: [] })
      .map((issue) => issue.location ?? '')
      .sort((a, b) => a.localeCompare(b));

    // Non-vacuous, and every arm of the twin is exercised: both `=` arms, both
    // ancestor arms, both under-a-rules-directory arms, and the de-duplication
    // of one path recorded by two extents.
    expect(fromPredicate).toEqual([
      '.claude',
      '.claude/rules',
      '.claude/rules/dangling.md',
      '.claude/rules/nested/deep.md',
      '.claude/rules/vendored.md',
      '.claude/rules/x.md',
      'sub/.claude',
      'sub/.claude/rules',
      'sub/.claude/rules/shared',
      'sub/.claude/rules/shared-out',
    ]);
    expect(fromSql).toEqual(fromPredicate);
    // ⭐ Every declined-link code is in the fixture and in both lists: the twin
    // is proven over the set, not over one of its members. Narrow either side to
    // fewer codes and the two lists stop agreeing.
    for (const path of [...OUTSIDE_ROOT_PATHS, ...UNRESOLVED_PATHS]) {
      expect(fromSql, `SQL missed the non-in-root ${path}`).toContain(path);
      expect(fromPredicate, `the predicate missed the non-in-root ${path}`).toContain(path);
    }

    // 🔑 The case variants and `CLAUDE.md` are in the fixture and in NEITHER
    // list. Written with `LIKE`, the shipped twin selected all four variants
    // and this comparison went red on the SQL side alone — which is the whole
    // point of a differential over a case-variant corpus.
    for (const path of [...CASE_VARIANT_PATHS, 'CLAUDE.md']) {
      expect(fromSql, `SQL selected ${path}`).not.toContain(path);
      expect(fromPredicate, `the predicate reported ${path}`).not.toContain(path);
    }
  });
});
