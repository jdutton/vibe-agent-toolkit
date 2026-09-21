import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { RULE_SCOPE_TAG } from '../src/projection/agentic-tags.js';
import {
  corpusFiles,
  declaredPatterns,
  evaluateRulePatterns,
  expandedPatternCount,
  selectRules,
  type DeclaredPattern,
} from '../src/projection/claude-context-rules.js';
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

/** A realized `.ts` file under {@link PACKAGES_CLI_SRC} — the usual ∃ witness. */
const SUBJECT_TS = 'packages/cli/src/index.ts';

/** A realized `.md` file beside it, for the extension-narrowing ∀ case. */
const SUBJECT_MD = 'packages/cli/src/notes.md';

/** A realized file directly in {@link PACKAGES_CLI}, sorting AFTER `src`. */
const SUBJECT_CONFIG = 'packages/cli/tsconfig.json';

/** The path-scoped rule several fixtures reuse. */
const TS_RULE = '.claude/rules/ts.md';

/** The rule whose `paths:` list blows the vendor's expansion budget. */
const HUGE_RULE = '.claude/rules/huge.md';

/** ∃ — spelled once, so a rename cannot leave a stale spelling passing. */
const MAY_FIRE = 'glob-rule-may-fire';

/** ∀ — same reason. */
const COVERS_DIR = 'glob-rule-covers-dir';

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
    const path = TS_RULE;
    const input = {
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [TS_GLOB])], queryDir: PACKAGES_CLI_SRC,
    };

    expect(selectRules({ ...input, queryFile: 'packages/cli/src/index.ts' }).rules[0]?.admission)
      .toEqual({ kind: 'glob-rule', pattern: TS_GLOB });
    expect(selectRules({ ...input, queryFile: 'packages/cli/src/index.md' }).rules).toEqual([]);
  });

  it('answers a DIRECTORY query about a path-scoped rule as ∃, naming the file that witnessed it', () => {
    const path = TS_RULE;
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [TS_GLOB])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission)
      .toEqual({ kind: MAY_FIRE, pattern: TS_GLOB, examplePath: SUBJECT_TS });
  });

  it('DROPS a path-scoped rule from a DIRECTORY query no file under it can match', () => {
    // ⛔ The whole reason the split exists. This returned `may fire` for every
    // path-scoped rule without inspecting one glob, so three unrelated
    // directories of a 116-rule adopter each reported an identical 73,958-token
    // on-demand total — the rule corpus, not the directory's cost. A rule scoped
    // to another package provably cannot fire here and is now absent, not
    // charged.
    const path = '.claude/rules/elsewhere.md';
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, ['packages/other-pkg/src/thing*.ts'])],
      queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules).toEqual([]);
  });

  it('admits a WHOLLY-LITERAL paths entry on a DIRECTORY query, naming that file as the ∃ witness', () => {
    // 🪤 The under-report, and the case no other fixture in this suite reached:
    // every other `paths:` entry here contains a `*`, so `literalPrefix` always
    // returned a real DIRECTORY. A wholly-literal entry returns the FILE itself,
    // and `candidateRange` then binary-searched for CHILDREN of that file, which
    // cannot exist — so the range was empty, ∃ found no witness, and the rule
    // vanished from the directory answer while the FILE query for the very same
    // path admitted it. Both halves are asserted, because a widening that broke
    // the file query would trade one under-report for another.
    const path = '.claude/rules/one-file.md';
    const input = {
      realizations: [queryRealization(path), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [SUBJECT_TS])],
      queryDir: PACKAGES_CLI_SRC,
    };

    expect(selectRules({ ...input, queryFile: null }).rules[0]?.admission)
      .toEqual({ kind: MAY_FIRE, pattern: SUBJECT_TS, examplePath: SUBJECT_TS });
    expect(selectRules({ ...input, queryFile: SUBJECT_TS }).rules[0]?.admission)
      .toEqual({ kind: 'glob-rule', pattern: SUBJECT_TS });
  });

  it('reaches a prefix directory past a sibling file sorting between the prefix and its children', () => {
    // ⚠️ The case a CARELESS widening of `candidateRange` breaks. `.` (0x2E)
    // sorts before `/` (0x2F), so `docs/foo.bak` lands between the bound
    // `docs/foo` and the run `docs/foo/…`. A scan that starts at `docs/foo` and
    // stops at the first entry not under `docs/foo/` stops on the sibling and
    // loses the whole directory — an under-report of exactly the shape the test
    // above pins, reintroduced by the fix for it.
    const path = '.claude/rules/foo.md';
    const pattern = 'docs/foo/*.md';
    const witness = 'docs/foo/x.md';
    const result = selectRules({
      realizations: [
        queryRealization(path), queryRealization('docs/foo.bak'), queryRealization(witness),
      ],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [pattern])], queryDir: 'docs', queryFile: null,
    });

    expect(result.rules[0]?.admission).toEqual({ kind: MAY_FIRE, pattern, examplePath: witness });
  });

  it('classifies a rule whose glob covers the whole query directory as ∀, without enumerating a file', () => {
    // ⚠️ The realization list holds ONLY the rule — no file under the query
    // directory exists at all. ∀ is pure pattern containment, and a fixture that
    // supplied a matching file could not tell it from ∃: both would pass. The
    // empty tree is the discriminator.
    const path = '.claude/rules/everything.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [`${PACKAGES_CLI}/**`])],
      queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission)
      .toEqual({ kind: COVERS_DIR, pattern: `${PACKAGES_CLI}/**` });
  });

  it('declines ∀ for a covering glob that narrows by extension, falling back to ∃', () => {
    // `packages/cli/**/*.md` reaches every directory below the query but not
    // every FILE in it, so calling it ∀ would assert a burden on the `.ts` files
    // it never matches. The conservative direction: declined here, still admitted
    // by ∃ with a witness.
    const path = '.claude/rules/markdown.md';
    const pattern = `${PACKAGES_CLI}/**/*.md`;
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_MD), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [pattern])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission)
      .toEqual({ kind: MAY_FIRE, pattern, examplePath: SUBJECT_MD });
  });

  it('prefers ∀ over ∃ when the same rule earns both', () => {
    // Order matters and is asserted, because `directoryAdmission` tests every
    // pattern for ∀ before any pattern for ∃. Reversed, a rule that covers the
    // directory would report as "some file here matches" — technically true and
    // strictly less informative than the burden it actually imposes.
    const path = '.claude/rules/both.md';
    const covering = `${PACKAGES_CLI}/**`;
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      // ∃-only pattern FIRST, so a naive first-match loop would return it.
      blobs: [blob(path, [TS_GLOB, covering])],
      queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission).toEqual({ kind: COVERS_DIR, pattern: covering });
  });

  it('treats the corpus ROOT as a directory every rule can be tested against', () => {
    // 🪤 `isAtOrBelow` answered false for an empty `under`, because its only
    // caller before the split was the nested-rule branch, which never produces
    // one. Under a root query that made the candidate file list EMPTY and every
    // path-scoped rule vanished — a confident zero, the exact answer shape this
    // lane refuses elsewhere. Both halves are pinned: ∃ finds its witness, and ∀
    // holds for the whole-tree pattern.
    const existential = '.claude/rules/ts.md';
    const universal = '.claude/rules/all.md';
    const result = selectRules({
      realizations: [
        queryRealization(existential), queryRealization(universal), queryRealization(SUBJECT_TS),
      ],
      tags: [scopeTag(existential, PATH_SCOPED), scopeTag(universal, PATH_SCOPED)],
      blobs: [blob(existential, [TS_GLOB]), blob(universal, ['**'])],
      queryDir: '', queryFile: null,
    });

    const byPath = new Map(result.rules.map((rule) => [rule.path, rule.admission]));
    expect(byPath.get(existential))
      .toEqual({ kind: MAY_FIRE, pattern: TS_GLOB, examplePath: SUBJECT_TS });
    expect(byPath.get(universal)).toEqual({ kind: COVERS_DIR, pattern: '**' });
  });

  it('reports an over-budget rule on a DIRECTORY query too, where the check never used to run', () => {
    // The retired `directory-budget-unchecked` limit, asserted as behaviour. The
    // budget check moved ahead of the file/directory fork, so a directory query
    // now drops the rule and reports it instead of answering "may fire" for a
    // pattern list the harness would refuse to expand.
    const path = HUGE_RULE;
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [OVER_BUDGET_PATTERN])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules).toEqual([]);
    expect(result.overBudget).toEqual([path]);
  });

  it('never offers a DIRECTORY as the witness for an ∃ admission', () => {
    // A `paths:` glob names files, and `packages/cli/*` matches the directory row
    // `packages/cli/src` as readily as the file beside it. The fixture is ordered
    // so a broken filter FAILS rather than coincidentally passing: `src` sorts
    // before `tsconfig.json`, so an implementation that forgot `isDirectory`
    // would return the directory as the witness — a path a reader cannot open to
    // check the claim.
    const path = '.claude/rules/any.md';
    const pattern = `${PACKAGES_CLI}/*`;
    const directoryRow = { ...queryRealization(PACKAGES_CLI_SRC), isDirectory: true };
    const result = selectRules({
      realizations: [queryRealization(path), directoryRow, queryRealization(SUBJECT_CONFIG)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [pattern])], queryDir: PACKAGES_CLI, queryFile: null,
    });

    expect(result.rules[0]?.admission)
      .toEqual({ kind: MAY_FIRE, pattern, examplePath: SUBJECT_CONFIG });
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
    const path = HUGE_RULE;
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [OVER_BUDGET_PATTERN])], queryDir: 'src/a/a/a', queryFile: 'src/a/a/a/x.ts',
    });

    // picomatch would expand and match. The harness would not.
    expect(result.rules).toEqual([]);
    expect(result.overBudget).toEqual([path]);
  });

  it('reports an over-budget rule realized in THREE extents ONCE', () => {
    const path = HUGE_RULE;
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

/** A `.ts` file in a package the `packages/cli` fixtures never reach. */
const OTHER_PKG_TS = 'packages/other-pkg/src/thing1.ts';

/** The glob that names {@link OTHER_PKG_TS} and nothing under `packages/cli`. */
const OTHER_PKG_GLOB = 'packages/other-pkg/src/thing*.ts';

/** A markdown glob under the shared package — live against {@link SUBJECT_MD}. */
const CLI_MD_GLOB = `${PACKAGES_CLI}/**/*.md`;

/** The tree-wide file list, built the way a caller builds it once per query. */
function corpusOf(...paths: readonly string[]): readonly string[] {
  return corpusFiles(paths.map((path) => queryRealization(path)));
}

/** The ignore oracle of a tree with nothing gitignored — a non-git tree, say. */
const NOTHING_IGNORED = (): boolean => false;

/**
 * An ignore oracle shaped like git's answer to a `.gitignore` line `<dir>/`
 * when `<dir>` does NOT exist on disk: the bare directory path is NOT ignored
 * (git cannot know it would be a directory), and every path beneath it IS.
 *
 * @param dir - Root-relative directory the ignore line names
 * @returns The predicate, recording every path it was asked about
 */
function ignoresBeneath(dir: string): { isIgnored: (path: string) => boolean; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isIgnored: (path) => {
      asked.push(path);
      return toForwardSlash(path).startsWith(`${dir}/`);
    },
  };
}

/** A predicate the evaluator must never consult. */
function neverAsked(path: string): boolean {
  throw new Error(`isIgnored must not be consulted, was asked about ${path}`);
}

/** A rules file in the PROJECT'S own rules directory — never re-based. */
const ROOT_RULE = '.claude/rules/scoped.md';

/** A rules file under a second `.claude/` further down the tree. */
const NESTED_RULE = 'fixtures/sample/.claude/rules/scoped.md';

/**
 * A `paths:` list as the producer hands it over: each glob at its own index.
 *
 * @param patterns - The globs, in declaration order, with nothing dropped
 * @returns One declared entry per glob
 */
function declared(...patterns: readonly string[]): readonly DeclaredPattern[] {
  return patterns.map((pattern, ordinal) => ({ ordinal, pattern }));
}

/**
 * The statuses of one evaluation, in declaration order.
 *
 * Returned rather than asserted, so the call site owns the positive control —
 * an absence assertion in here would be invisible to its reader.
 *
 * @param patterns - The rule's `paths:` entries
 * @param files - The tree-wide, path-sorted realized file list
 * @returns One status per declared pattern
 */
function statusesOf(
  patterns: readonly string[],
  files: readonly string[],
): readonly string[] {
  return evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(...patterns), files }).map((entry) => entry.status);
}

describe('evaluateRulePatterns', () => {
  it('reports one result per declared pattern, in declaration order, naming the dead one', () => {
    // ⛔ The reason this function exists. `directoryAdmission` returns on the
    // FIRST pattern that matches, so on a real adopter 246 rule rows produced
    // exactly 246 admissions and one pattern each — "which of this rule's globs
    // matches nothing" was not a question the answer could be asked.
    const patterns = [TS_GLOB, CLI_MD_GLOB, OTHER_PKG_GLOB];
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(...patterns), files: corpusOf(SUBJECT_TS, SUBJECT_MD),
    });

    expect(result.map((entry) => entry.pattern)).toEqual(patterns);
    expect(result.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(result.map((entry) => entry.status)).toEqual(['matched', 'matched', 'inert']);
    expect(result[2]).toEqual({
      ordinal: 2, pattern: OTHER_PKG_GLOB, literalPrefix: 'packages/other-pkg/src',
      witnessPath: null, status: 'inert',
    });
    expect(result[0]?.witnessPath).toBe(SUBJECT_TS);
  });

  it('reports a wholly-literal pattern naming a file that does not exist as inert', () => {
    // 🪤 `literalPrefix` returns the WHOLE pattern here — `.` is not a glob
    // metacharacter — so the prefix is a FILE. Pinned, because it is also the
    // string bound `candidateRange` searches on, and the last time that was
    // misread every wholly-literal entry silently vanished from the answer.
    const pattern = 'packages/cli/src/missing.ts';
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(pattern), files: corpusOf(SUBJECT_TS) });

    expect(result).toEqual([{
      ordinal: 0, pattern, literalPrefix: pattern, witnessPath: null, status: 'inert',
    }]);
  });

  it('names a wholly-literal pattern ITSELF as the witness when that file exists', () => {
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(SUBJECT_TS), files: corpusOf(SUBJECT_TS),
    });

    expect(result).toEqual([{
      ordinal: 0, pattern: SUBJECT_TS, literalPrefix: SUBJECT_TS,
      witnessPath: SUBJECT_TS, status: 'matched',
    }]);
  });

  it('finds a witness ANYWHERE in the tree, not only under one query directory', () => {
    // The tree-wide half: `selectRules` drops this rule from a `packages/cli/src`
    // query because it provably cannot fire there, and that absence is correct.
    // A per-pattern report that inherited the query directory would then call the
    // pattern inert — it matches a file, just not one here.
    const rule = '.claude/rules/elsewhere.md';
    const scoped = selectRules({
      realizations: [queryRealization(rule), queryRealization(OTHER_PKG_TS)],
      tags: [scopeTag(rule, PATH_SCOPED)], blobs: [blob(rule, [OTHER_PKG_GLOB])],
      queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(scoped.rules).toEqual([]);
    expect(evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(OTHER_PKG_GLOB), files: corpusOf(SUBJECT_TS, OTHER_PKG_TS),
    })).toEqual([{
      ordinal: 0, pattern: OTHER_PKG_GLOB, literalPrefix: 'packages/other-pkg/src',
      witnessPath: OTHER_PKG_TS, status: 'matched',
    }]);
  });

  it('classifies a BUDGET-REFUSED pattern as unevaluated, never as inert', () => {
    // ⛔ The three-state requirement. A two-state result reports a REFUSAL as a
    // defect: the harness never expanded this list, so no pattern in it was ever
    // matched, and a null witness here says nothing about the pattern's reach.
    // The budget is shared across the whole `paths:` list, so the live sibling is
    // refused with it.
    const statuses = statusesOf([OVER_BUDGET_PATTERN, TS_GLOB], corpusOf(SUBJECT_TS));

    expect(statuses).toEqual(['unevaluated', 'unevaluated']);
    expect(statuses).not.toContain('inert');
  });

  it('classifies a pattern INSIDE the budget that matches nothing as inert', () => {
    // The positive control for the test above: the same brace shape, small enough
    // for the harness to expand, matching no file. Without this pair, a function
    // that answered `unevaluated` for everything would pass.
    const inBudget = 'src/{a,b}/x.ts';
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(inBudget, TS_GLOB), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert', 'matched']);
    // The fixture is in budget because it expands to two patterns, not because
    // it looks smaller than its sibling.
    expect(expandedPatternCount([inBudget])).toBe(2);
  });

  it('leaves directoryAdmission answering with ONE first-match admission', () => {
    // The mutation check on the hot path. Per-pattern evaluation is a SECOND
    // walk, not a replacement: a directory query still short-circuits on the
    // first pattern that produces a witness, and still names only that one.
    const rule = TS_RULE;
    const patterns = [TS_GLOB, CLI_MD_GLOB, OTHER_PKG_GLOB];
    const scoped = selectRules({
      realizations: [queryRealization(rule), queryRealization(SUBJECT_TS), queryRealization(SUBJECT_MD)],
      tags: [scopeTag(rule, PATH_SCOPED)], blobs: [blob(rule, patterns)],
      queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(scoped.rules).toEqual([{
      resourceId: `id:${rule}`, path: rule,
      admission: { kind: MAY_FIRE, pattern: TS_GLOB, examplePath: SUBJECT_TS },
    }]);
    expect(evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(...patterns), files: corpusOf(SUBJECT_TS, SUBJECT_MD) }))
      .toHaveLength(patterns.length);
  });

  it('returns nothing for an empty paths list', () => {
    expect(evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: [], files: corpusOf(SUBJECT_TS) })).toEqual([]);
  });

  it('matches a ./-prefixed glob exactly as its bare twin, with the bare literal prefix', () => {
    // ⛔ `.` is not a glob metacharacter, so the prefix used to come back as
    // `./packages/cli` — a string no root-relative path ever starts with. The
    // prune then emptied the candidate range and called the glob inert on EVERY
    // tree, while the compiled matcher (which accepts `./`) said it matched.
    const dotted = `./${TS_GLOB}`;
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(dotted, TS_GLOB), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['matched', 'matched']);
    expect(result[0]?.witnessPath).toBe(SUBJECT_TS);
    expect(result[0]?.literalPrefix).toBe(result[1]?.literalPrefix);
    // The reported pattern stays verbatim — the author's spelling, not ours.
    expect(result[0]?.pattern).toBe(dotted);
  });

  it('carries the AUTHOR\'S index past an entry declaredPatterns dropped', () => {
    // ⛔ The finding names `paths[ordinal]`. Numbered after the drop, a blank
    // YAML item before a dead glob pointed the author at the HEALTHY glob — and
    // the fix text says to delete what it names.
    const patterns = declaredPatterns({ paths: [TS_GLOB, null, 42, OTHER_PKG_GLOB] });

    expect(patterns).toEqual([
      { ordinal: 0, pattern: TS_GLOB },
      { ordinal: 3, pattern: OTHER_PKG_GLOB },
    ]);
    expect(evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns, files: corpusOf(SUBJECT_TS) })
      .map((entry) => [entry.ordinal, entry.status])).toEqual([[0, 'matched'], [3, 'inert']]);
  });

  it("finds a NESTED rule's glob relative to its own project directory", () => {
    // ⛔ The vendor does not say which base a nested rules file's globs resolve
    // against. Swept only against the repo root, a fixture project's
    // `src/**` was reported dead beside its own `src/index.ts` — a false
    // CLAUDE_RULE_GLOB_INERT whose remedy deletes a working glob. Dead now means
    // dead under BOTH candidate bases.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED,
      rulePath: NESTED_RULE, patterns: declared('src/**'),
      files: corpusOf('fixtures/sample/src/index.ts'),
    });

    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', 'fixtures/sample/src/index.ts']]);
    // The author's spelling survives the re-basing.
    expect(result[0]?.pattern).toBe('src/**');
  });

  it("still calls a nested rule's glob inert when it matches under NEITHER base", () => {
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED,
      rulePath: NESTED_RULE, patterns: declared('lib/**'),
      files: corpusOf('fixtures/sample/src/index.ts', SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('never re-bases a rule in the project\'s OWN rules directory', () => {
    // The positive control: the same glob and files, with a root rules file, is
    // dead — so the test above passes because of the nesting and nothing else.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED,
      rulePath: ROOT_RULE, patterns: declared('src/**'),
      files: corpusOf('fixtures/sample/src/index.ts'),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('admits a nested path-scoped rule on a directory query under its own project', () => {
    // The query lane owes the same answer as the per-pattern lane, or the check
    // calls the glob live while `claude context` leaves the rule out.
    const scoped = selectRules({
      realizations: [queryRealization(NESTED_RULE), queryRealization('fixtures/sample/src/index.ts')],
      tags: [scopeTag(NESTED_RULE, PATH_SCOPED)], blobs: [blob(NESTED_RULE, ['src/**'])],
      queryDir: 'fixtures/sample/src', queryFile: null,
    });

    expect(scoped.rules.map((rule) => rule.path)).toEqual([NESTED_RULE]);
  });

  it('never names a realization that does not exist as a witness', () => {
    // A closure-realized link target that is gone is a row with exists: false.
    // As a witness it would call a dead glob matched on the strength of a file
    // nobody can open.
    const gone = { ...queryRealization(OTHER_PKG_TS), exists: false };
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(OTHER_PKG_GLOB), files: corpusFiles([queryRealization(SUBJECT_TS), gone]),
    });

    expect(result.map((entry) => [entry.status, entry.witnessPath])).toEqual([['inert', null]]);
  });
});

describe('evaluateRulePatterns — gitignored territory', () => {
  it('⭐ classifies a glob over gitignored territory as gitignored, never as inert', () => {
    // ⛔ The false CLAUDE_RULE_GLOB_INERT. VAT's file list never holds an
    // ignored file, and Claude Code reads the filesystem — so a rule scoped to
    // build output matched nothing HERE and may fire THERE. Its remedy (delete
    // the glob) would break a working rule. `dist` itself answers NOT ignored:
    // the `.gitignore` line is `dist/`, and a directory that does not exist is
    // not known to be one.
    const oracle = ignoresBeneath('dist');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE, patterns: declared('dist/**'),
      files: corpusOf(SUBJECT_TS),
    });

    expect(result).toEqual([{
      ordinal: 0, pattern: 'dist/**', literalPrefix: 'dist', witnessPath: null, status: 'gitignored',
    }]);
    // The question was about a path BENEATH the prefix, not the bare prefix.
    expect(oracle.asked.every((path) => toForwardSlash(path).startsWith('dist/'))).toBe(true);
  });

  it('keeps the positive control: the same glob over NON-ignored territory is inert', () => {
    const result = evaluateRulePatterns({
      isIgnored: ignoresBeneath('build').isIgnored, rulePath: ROOT_RULE, patterns: declared('dist/**'),
      files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('asks a wholly-literal pattern about the FILE it names', () => {
    const asked: string[] = [];
    const result = evaluateRulePatterns({
      isIgnored: (path) => {
        asked.push(path);
        return path === 'generated/api.ts';
      },
      rulePath: ROOT_RULE, patterns: declared('generated/api.ts'), files: corpusOf(SUBJECT_TS),
    });

    expect(asked).toEqual(['generated/api.ts']);
    expect(result.map((entry) => entry.status)).toEqual(['gitignored']);
  });

  it('keeps a glob with an EMPTY literal prefix inert — its territory is the whole tree', () => {
    // `**/*.gen.ts` has no prefix to ask about, and "is the root ignored" is
    // not the question. Stays a (possibly false) inert, and the docs say so.
    const result = evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared('**/*.gen.ts'), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('leaves a prefix that climbs out of the tree to the oracle, which owns the root', () => {
    const oracle = ignoresBeneath('dist');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE, patterns: declared('../sibling/**'), files: corpusOf(SUBJECT_TS),
    });

    expect(oracle.asked).toHaveLength(1);
    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('never consults the oracle for a matched or an unevaluated glob', () => {
    // The cost claim: only a glob that would otherwise be inert asks git, so a
    // healthy tree (every glob matched) pays nothing.
    expect(evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared(TS_GLOB), files: corpusOf(SUBJECT_TS),
    }).map((entry) => entry.status)).toEqual(['matched']);
    expect(evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared(OVER_BUDGET_PATTERN, 'dist/**'),
      files: corpusOf(SUBJECT_TS),
    }).map((entry) => entry.status)).toEqual(['unevaluated', 'unevaluated']);
  });

  it("judges a NESTED rule's glob under its own project directory too", () => {
    // Same two bases as the witness search: the glob may resolve against the
    // nested project, whose `dist/` is the ignored one.
    const result = evaluateRulePatterns({
      isIgnored: ignoresBeneath('fixtures/sample/dist').isIgnored, rulePath: NESTED_RULE,
      patterns: declared('dist/**'), files: corpusOf('fixtures/sample/src/index.ts'),
    });

    expect(result.map((entry) => entry.status)).toEqual(['gitignored']);
  });
});

describe('corpusFiles', () => {
  it('deduplicates across extents, drops directories, and sorts by code point', () => {
    const directoryRow = { ...queryRealization(PACKAGES_CLI_SRC), isDirectory: true };
    const files = corpusFiles([
      ...realizedInThreeExtents(SUBJECT_TS), directoryRow, queryRealization(SUBJECT_CONFIG),
      queryRealization(SUBJECT_MD),
    ]);

    // Spelled out rather than re-sorted here: an expectation that reran the
    // production comparator would agree with any comparator at all.
    expect(files).toEqual([SUBJECT_TS, SUBJECT_MD, SUBJECT_CONFIG]);
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

  it.each([
    // ⛔ A range has no comma, so counting commas scored it 1 — a list the
    // harness refuses to expand read as tiny, and was matched instead of
    // reported `unevaluated`.
    ['a numeric range', 'logs/{1..5000}/*.txt', 5000],
    ['a stepped range', 'v{1..10..2}.md', 5],
    ['a descending range', 'v{5..1}.md', 5],
    ['a character range', 'dir-{a..e}/x.md', 5],
    // A nested group: the innermost-only scan undercounted this as 4.
    ['a nested group', '{x,y}{a,{b,c}}', 6],
    ['a group holding a range', '{a,{1..3}}.md', 4],
    // One item and no comma is not a group — braces is literal about it.
    ['a single-item brace', 'a{b}c.md', 1],
  ])('counts %s', (_what, pattern, expected) => {
    expect(expandedPatternCount([pattern])).toBe(expected);
  });

  it('refuses a paths list whose ONLY expansion is a range', () => {
    // The consequence the count exists for, end to end.
    expect(statusesOf(['logs/{1..5000}/*.txt'], corpusOf(SUBJECT_TS))).toEqual(['unevaluated']);
  });
});
