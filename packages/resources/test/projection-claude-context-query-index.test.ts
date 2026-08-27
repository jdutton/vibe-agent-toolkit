/**
 * The per-projection index behind `whatLoadsAt`: the MECHANISM witness, and the
 * differential oracle that keeps the memo honest.
 *
 * ## An answers-match test cannot see this change at all
 *
 * Hoisting projection-wide work out of the per-query path is required to change
 * NO answer, so every answer-shaped assertion in
 * `projection-claude-context-query.test.ts` passes identically before and after
 * it. A suite made only of those would report the hoist as covered while being
 * structurally incapable of noticing its removal — the shape
 * [[fixtures-that-cannot-distinguish]] names.
 *
 * So the first case here is not about answers at all. It wraps the projection's
 * row arrays in counting `Proxy`s and asserts that issuing FORTY queries starts
 * no more whole-array scans of `resource_extents`, `zone_provenance` and
 * `blob_references` than issuing ONE. That count is the thing the hoist moves,
 * and it goes red the moment the index is deleted.
 *
 * ⚠️ `resource_realizations` is deliberately held to a NARROWER claim — see
 * {@link DERIVED_INDEX_SCANS}. `claudeAncestry` and `selectRules` both walk that
 * array per query, and they must: the ancestry chain and the rule selection are
 * the two genuinely path-dependent halves of the answer. Only the DERIVED
 * indexes this module used to rebuild per call (`.find`, `.map`, `.filter`) are
 * claimed flat.
 *
 * ## The memo is keyed on projection IDENTITY, so a fixture must not share one
 *
 * Every sub-case builds its own proxied projection object. A case that reused
 * one would be served the previous case's index and would pass whatever the
 * implementation did — the most likely way to write a witness that lies.
 */

import { describe, expect, it } from 'vitest';

import {
  whatLoadsAt,
  type LoadedContext,
} from '../src/projection/claude-context-query.js';
import type { Projection } from '../src/projection/projection.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

/** How many distinct paths the witness queries — see the module docstring. */
const QUERY_COUNT = 40;

/**
 * Array members whose access STARTS a whole-array scan.
 *
 * Counted rather than element reads, because an element read is O(n) by
 * construction and would drown the signal: what this witness measures is how
 * many times a scan was BEGUN, which is exactly the quantity that used to be
 * proportional to the number of queries.
 */
const SCAN_STARTERS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'entries',
  'every',
  'filter',
  'find',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'keys',
  'map',
  'reduce',
  'some',
  'values',
  Symbol.iterator,
]);

/**
 * The scan starters that build a DERIVED INDEX rather than walk the array once.
 *
 * `resource_realizations` is iterated per query by `claudeAncestry` and
 * `selectRules` (`Symbol.iterator`), and that is the answer's path-dependent
 * half — hoisting it would be wrong, not slow. What this module used to rebuild
 * per query is the `.find` for the queried path plus the `pathOf`/`idOf`/
 * `realizationOf`/`keyOf` maps, and those are the three members named here.
 */
const DERIVED_INDEX_SCANS: readonly string[] = ['find', 'map', 'filter'];

/** The projection tables this witness watches. */
const WATCHED_TABLES = [
  'resourceRealizations',
  'resourceExtents',
  'zoneProvenance',
  'blobReferences',
] as const;

/** One watched table's name. */
type WatchedTable = (typeof WATCHED_TABLES)[number];

/** Scan starts, keyed `<table>.<member>`. */
type ScanCounts = Map<string, number>;

/**
 * A projection whose watched tables count every scan they are asked to start.
 *
 * A NEW object every call, and new `Proxy` wrappers inside it, so the identity
 * the index is memoized against is this call's alone.
 *
 * @param projection - The fixture projection
 * @param counts - The tally to accumulate into
 * @returns A structurally identical projection that reports its own reads
 */
function countingProjection(projection: Projection, counts: ScanCounts): Projection {
  const wrapped: Record<string, unknown> = { ...projection };
  for (const table of WATCHED_TABLES) {
    wrapped[table] = new Proxy(projection[table] as unknown as object, {
      get(target, member, receiver): unknown {
        if (SCAN_STARTERS.has(member)) {
          const key = `${table}.${String(member)}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return Reflect.get(target, member, receiver);
      },
    });
  }
  return wrapped as unknown as Projection;
}

/**
 * Every scan start recorded against one table.
 *
 * @param counts - The tally
 * @param table - The table to total
 * @param members - Restrict to these members, or every member when omitted
 * @returns The total
 */
function scansOf(counts: ScanCounts, table: WatchedTable, members?: readonly string[]): number {
  let total = 0;
  for (const [key, count] of counts) {
    const [keyTable, keyMember] = key.split('.');
    if (keyTable !== table) continue;
    if (members !== undefined && !members.includes(keyMember ?? '')) continue;
    total += count;
  }
  return total;
}

/**
 * The four numbers the witness compares, gathered into ONE object.
 *
 * One assertion rather than four, so a failure prints every count side by side:
 * which table regressed and by how much is the whole diagnostic content of this
 * case, and four separate `expect`s would report only the first.
 *
 * @param counts - The tally
 * @returns Scan starts per watched table, with `resource_realizations` narrowed
 *   to its derived-index members — see {@link DERIVED_INDEX_SCANS}
 */
function scanSummary(counts: ScanCounts): Record<string, number> {
  return {
    resourceExtents: scansOf(counts, 'resourceExtents'),
    zoneProvenance: scansOf(counts, 'zoneProvenance'),
    blobReferences: scansOf(counts, 'blobReferences'),
    resourceRealizationsDerivedIndexes: scansOf(
      counts,
      'resourceRealizations',
      DERIVED_INDEX_SCANS,
    ),
  };
}

/** The path-scoped rules file both trees hang their glob case off. */
const SCOPED_RULE = '.claude/rules/scoped.md';

/** {@link SCOPED_RULE}'s `paths:` entry, spelled once so no assertion can drift from it. */
const SCOPED_RULE_PATTERN = 'src/**/*.ts';

/** The one-hop import target shared by the root chain and the scoped rule. */
const DEEP_NOTE = 'docs/deep.md';

/** {@link DEEP_NOTE}'s body — identical across the three trees, so it is spelled once. */
const DEEP_NOTE_BODY = 'The deep note.\n';

/** The 40 file paths the witness queries, one per module directory. */
const MODULE_FILES: readonly string[] = Array.from(
  { length: QUERY_COUNT },
  (_, index) => `src/mod${index}/a.ts`,
);

/**
 * A tree of `moduleCount` module directories, each carrying its OWN `CLAUDE.md`
 * and therefore its own `@`-import closure, over a root chain and a path-scoped
 * rule.
 *
 * ⛔ ONE builder, not two literals differing in a `.slice()`. The two trees below
 * exist to be compared, and a copied builder is one somebody can change on one
 * side — at which point the comparison still runs, still passes, and no longer
 * holds the closure COUNT as the only difference between them.
 *
 * @param moduleCount - How many module directories, and so how many closures
 * @returns Root-relative path → markdown source
 */
function modularTree(moduleCount: number): Record<string, string> {
  return {
    'CLAUDE.md': '@docs/handbook.md\n',
    'docs/handbook.md': '@deep.md\n',
    [DEEP_NOTE]: DEEP_NOTE_BODY,
    [SCOPED_RULE]: `---\npaths: ['${SCOPED_RULE_PATTERN}']\n---\n\n@../../${DEEP_NOTE}\n`,
    ...Object.fromEntries(
      MODULE_FILES.slice(0, moduleCount).flatMap((file, index) => [
        [`src/mod${index}/CLAUDE.md`, '@notes.md\n'],
        [`src/mod${index}/notes.md`, `Notes for module ${index}.\n`],
        [file, `export const a${index} = ${index};\n`],
      ]),
    ),
  };
}

/**
 * Forty module directories, so forty import closures.
 *
 * Forty rather than one, deliberately: a witness over a single-closure tree
 * could not tell "walks each closure once" from "walks the one closure every
 * time", because those are the same count.
 */
const WIDE_TREE: Record<string, string> = modularTree(QUERY_COUNT);

/** How many module directories {@link NARROW_TREE} carries — see its docstring. */
const NARROW_MODULE_COUNT = 4;

/**
 * {@link WIDE_TREE}'s shape with a TENTH of the import closures.
 *
 * The control for the second witness: a query's scan count must be a function of
 * the query, not of how many closures the projection holds. Hoisting the
 * closure walk to index-build time is only a win if the build itself is one pass
 * over the projection rather than one pass PER closure — which is the same
 * quadratic, moved rather than removed.
 */
const NARROW_TREE: Record<string, string> = modularTree(NARROW_MODULE_COUNT);

/**
 * A rich tree for the oracle: a chain, a diamond, a nested rules file with its
 * own import, and a path-scoped rule whose glob a file query matches exactly.
 *
 * Every shape the query grades differently is present, so "every realized path
 * answers identically" is a claim over the whole grading surface rather than
 * over one admission kind repeated.
 */
const ORACLE_TREE: Record<string, string> = {
  'CLAUDE.md': '@docs/handbook.md\n@a.md\n@b.md\n',
  'a.md': '@shared.md\n',
  'b.md': '@shared.md\n',
  'shared.md': 'The diamond join point.\n',
  'docs/handbook.md': '@deep.md\n@missing.md\n',
  [DEEP_NOTE]: DEEP_NOTE_BODY,
  'docs/CLAUDE.md': 'Docs instructions.\n',
  [SCOPED_RULE]: `---\npaths: ['${SCOPED_RULE_PATTERN}']\n---\n\n@../../${DEEP_NOTE}\n`,
  '.claude/rules/always.md': 'An unscoped root rule.\n',
  'src/CLAUDE.md': 'Source instructions.\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/nested/.claude/rules/local.md': '@helper.md\n',
  'src/nested/.claude/rules/helper.md': 'The nested rule helper.\n',
  'src/nested/b.ts': 'export const b = 2;\n',
};

/**
 * Order two paths by UTF-16 code point.
 *
 * ⚠️ Deliberately NOT `String.localeCompare`, which `sonarjs/no-alphabetical-sort`
 * suggests: it is ICU- and locale-dependent, and this list decides the ORDER the
 * oracle walks the tree in. The production comparators this suite is measuring
 * (`comparePaths`, `byCodePoint`) refuse it on the same ground.
 *
 * @param left - One root-relative path
 * @param right - The other
 * @returns Negative, zero or positive, per the `Array#sort` contract
 */
function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Every path the projection realizes, plus the corpus root itself. */
function realizedPathsOf(projection: Projection): string[] {
  return ['', ...new Set(projection.resourceRealizations.map((row) => row.path))].sort(byCodePoint);
}

describe('the per-projection context-query index', () => {
  it('starts no more projection-wide scans for forty queries than for one', async () => {
    const projection = await claudeContextFixture(WIDE_TREE);
    const first = MODULE_FILES[0];
    if (first === undefined) throw new Error('fixture produced no module files');

    const oneCounts: ScanCounts = new Map();
    whatLoadsAt(countingProjection(projection, oneCounts), first);

    // A FRESH proxied projection: the index is memoized on object identity, so
    // reusing the one above would hand this case the previous case's index and
    // it would pass whatever the implementation did.
    const manyCounts: ScanCounts = new Map();
    const many = countingProjection(projection, manyCounts);
    for (const path of MODULE_FILES) whatLoadsAt(many, path);

    expect(scanSummary(manyCounts), `${QUERY_COUNT} queries rescanned the projection`)
      .toEqual(scanSummary(oneCounts));
  });

  it('starts no more scans for a tree of forty closures than for one of four', async () => {
    const wideCounts: ScanCounts = new Map();
    const narrowCounts: ScanCounts = new Map();
    const first = MODULE_FILES[0];
    if (first === undefined) throw new Error('fixture produced no module files');

    whatLoadsAt(countingProjection(await claudeContextFixture(WIDE_TREE), wideCounts), first);
    whatLoadsAt(countingProjection(await claudeContextFixture(NARROW_TREE), narrowCounts), first);

    // ⛔ EVERY scan starter here, `Symbol.iterator` included — this is the case
    // that would catch the quadratic being MOVED into the index build rather
    // than removed. Both queries admit the same three closure roots; only the
    // number of closures the projection holds differs.
    expect({
      resourceExtents: scansOf(wideCounts, 'resourceExtents'),
      zoneProvenance: scansOf(wideCounts, 'zoneProvenance'),
      blobReferences: scansOf(wideCounts, 'blobReferences'),
      resourceRealizations: scansOf(wideCounts, 'resourceRealizations'),
    }).toEqual({
      resourceExtents: scansOf(narrowCounts, 'resourceExtents'),
      zoneProvenance: scansOf(narrowCounts, 'zoneProvenance'),
      blobReferences: scansOf(narrowCounts, 'blobReferences'),
      resourceRealizations: scansOf(narrowCounts, 'resourceRealizations'),
    });
  });

  it('really does issue forty distinct answers, so the counts above are not measuring nothing', async () => {
    const projection = await claudeContextFixture(WIDE_TREE);
    const directories = new Set<string>();
    for (const path of MODULE_FILES) {
      const answer = whatLoadsAt(projection, path);
      expect(answer.kind).toBe('answer');
      if (answer.kind === 'answer') directories.add(answer.directory);
    }

    // The control for the witness. A flat scan count is also what a query that
    // refused every path would produce, and `unknown` costs nothing to answer.
    expect(directories.size).toBe(QUERY_COUNT);
  });

  describe('the differential oracle', () => {
    it('answers every realized path identically to an un-memoized computation', async () => {
      const projection = await claudeContextFixture(ORACLE_TREE);

      for (const path of realizedPathsOf(projection)) {
        // ⛔ A FRESH projection object per query, so the comparison genuinely
        // bypasses the memo. Compared against the SAME `projection` reused
        // across every query, which is the object the memo is keyed on — so a
        // leak between queries (a closure set carried over, an admission list
        // mutated in place) shows up as a disagreement here.
        const memoized = whatLoadsAt(projection, path);
        const fresh = whatLoadsAt({ ...projection }, path);
        expect(memoized, `disagreement at ${JSON.stringify(path)}`).toEqual(fresh);
      }
    });

    it('answers identically whichever ORDER the paths are queried in', async () => {
      const projection = await claudeContextFixture(ORACLE_TREE);
      const paths = realizedPathsOf(projection);

      const forward = new Map<string, LoadedContext>(
        paths.map((path) => [path, whatLoadsAt(projection, path)]),
      );
      // A second projection object, queried back to front. An index seeded by
      // the first query it happened to serve would answer differently here.
      const backward = { ...projection };
      for (const path of [...paths].reverse()) {
        expect(whatLoadsAt(backward, path), `order-dependent at ${JSON.stringify(path)}`)
          .toEqual(forward.get(path));
      }
    });

    it('keeps the diamond, the chain and the scoped rule exactly as the query graded them', async () => {
      const projection = await claudeContextFixture(ORACLE_TREE);
      const answer = whatLoadsAt(projection, 'src/a.ts');
      if (answer.kind !== 'answer') throw new Error('expected an answer');
      const rowAt = (path: string) => answer.rows.find((row) => row.path === path);

      // Concrete values, not a self-comparison: the oracle above proves the memo
      // does not leak, and this proves the answer it serves is still the right
      // one. Every field here is one the hoist moved through a precomputed map.
      expect(rowAt('shared.md')?.admissions).toHaveLength(1);
      // TWO import admissions, in the order the closures were charged: the root
      // `CLAUDE.md`'s chain at depth 2, and the path-scoped rule's own closure
      // at depth 1 — the rule's glob matches this query's file exactly.
      expect(rowAt(DEEP_NOTE)?.admissions).toEqual([
        { kind: 'import', rootPath: SCOPED_RULE, viaPath: SCOPED_RULE, depth: 1 },
        { kind: 'import', rootPath: 'CLAUDE.md', viaPath: 'docs/handbook.md', depth: 2 },
      ]);
      expect(rowAt('.claude/rules/always.md')?.loadClass).toBe('always');
      expect(rowAt(SCOPED_RULE)?.loadClass).toBe('on-demand');
      expect(rowAt(SCOPED_RULE)?.admissions).toEqual([
        { kind: 'glob-rule', pattern: SCOPED_RULE_PATTERN },
      ]);
      expect(
        answer.conditions.filter((row) => row.sourceRef === '@missing.md').map((row) => row.severity),
      ).toEqual(['warn']);
    });
  });
});
