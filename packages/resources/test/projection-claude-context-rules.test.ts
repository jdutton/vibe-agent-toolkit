import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { RULE_SCOPE_TAG } from '../src/projection/agentic-tags.js';
import {
  corpusFiles,
  declaredPatterns,
  declaresPaths,
  evaluateRulePatterns,
  harnessExpansion,
  selectRules,
  type DeclaredPattern,
} from '../src/projection/claude-context-rules.js';
import type {
  ResourceRealizationRow,
  ResourceTagRow,
} from '../src/schemas/projection-resources.js';

import {
  pathScopedAdmissions as admissionsFor,
  queryPathsBlob as blob,
  queryRealization,
  queryTag,
} from './helpers/context-query-rows.js';

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
      // `**/*`, not `**`: a rule whose patterns are ALL `**` is always-loaded in
      // the harness (`declaresPaths`), so it would never reach this lane scoped.
      blobs: [blob(existential, [TS_GLOB]), blob(universal, ['**/*'])],
      queryDir: '', queryFile: null,
    });

    const byPath = new Map(result.rules.map((rule) => [rule.path, rule.admission]));
    expect(byPath.get(existential))
      .toEqual({ kind: MAY_FIRE, pattern: TS_GLOB, examplePath: SUBJECT_TS });
    expect(byPath.get(universal)).toEqual({ kind: COVERS_DIR, pattern: '**/*' });
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

  it('matches dotfile paths, which gitignore treats as ordinary names', () => {
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
 * A glob that is still ANCHORED after the harness strips its trailing `/**`.
 *
 * ⛔ The only kind that can prove a nested rule's re-base. A single-segment glob
 * (`src/**` → `src`) has no slash left and gitignore matches it at any depth, so
 * it reaches {@link NESTED_ANCHORED_FILE} from the repository root and the
 * re-base explains nothing.
 */
const NESTED_ANCHORED_GLOB = 'src/lib/**';

/** The file {@link NESTED_ANCHORED_GLOB} reaches only under the nested base. */
const NESTED_ANCHORED_FILE = 'fixtures/sample/src/lib/index.ts';

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

  it('classifies a BUDGET-REFUSED pattern as unevaluated, and its LIVE SIBLING as matched', () => {
    // ⛔ The three-state requirement, and the per-pattern half of it. A
    // two-state result reports a REFUSAL as a defect: the harness expanded
    // nothing for this entry, so a null witness here says nothing about its
    // reach. ⭐ And the budget is spent PER PATTERN as `N()` proceeds — the
    // sibling after the refusal is brace-free, costs nothing, and is live
    // there. Refusing it with its neighbour was VAT's own invention.
    const statuses = statusesOf([OVER_BUDGET_PATTERN, TS_GLOB], corpusOf(SUBJECT_TS));

    expect(statuses).toEqual(['unevaluated', 'matched']);
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
    // The fixture is in budget because it expands to two globs, not because it
    // looks smaller than its sibling.
    expect(harnessExpansion([inBudget])[0]?.globs).toEqual(['src/a/x.ts', 'src/b/x.ts']);
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

  it('⭐ reports a ./-prefixed glob as INERT, because the harness matches nothing with it', () => {
    // ⛔ This used to assert the opposite, on the strength of picomatch — which
    // accepts `./docs/**` against `docs/guide.md`. The harness's matcher is
    // `node-ignore`, `./` is not gitignore syntax, and the binary's own copy
    // answers false. So the glob is genuinely dead in Claude Code and saying so
    // is the whole point of CLAUDE_RULE_GLOB_INERT; calling it live hid a real
    // defect behind a dialect VAT invented. The bare twin beside it is the
    // positive control — same tree, same file, one `./` apart.
    const dotted = `./${TS_GLOB}`;
    const result = evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(dotted, TS_GLOB), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert', 'matched']);
    expect(result[1]?.witnessPath).toBe(SUBJECT_TS);
    // The `literalPrefix` COLUMN still names the directory the author aimed at,
    // because that is the question git is asked about the glob's territory.
    expect(result[0]?.literalPrefix).toBe(result[1]?.literalPrefix);
    // The reported pattern stays verbatim — the author's spelling, not ours.
    expect(result[0]?.pattern).toBe(dotted);
  });

  it('⭐ numbers the PATTERNS densely, and never claims to number the author\'s YAML slots', () => {
    // ⛔ `ordinal` carried two contracts and they stopped agreeing. It cannot be
    // `paths[N]`: the comma split makes `['a/**, b/**', 'c/**']` three patterns
    // from two YAML items, and a SCALAR `paths:` has no list to index at all. So
    // there is one contract — the dense index among the rule's PATTERNS, which
    // is what keys `claude_rule_patterns` — and a finding names the pattern
    // VERBATIM for the author to grep. Both shapes are asserted, because the
    // scalar is the one no author-slot reading could ever have served.
    expect(declaredPatterns({ paths: [TS_GLOB, null, 42, OTHER_PKG_GLOB] })).toEqual([
      { ordinal: 0, pattern: TS_GLOB },
      { ordinal: 1, pattern: OTHER_PKG_GLOB },
    ]);
    expect(declaredPatterns({ paths: ['a/**, b/**', 'c/**'] }).map((entry) => entry.ordinal))
      .toEqual([0, 1, 2]);
    expect(declaredPatterns({ paths: `${TS_GLOB}, ${OTHER_PKG_GLOB}` })).toEqual([
      { ordinal: 0, pattern: TS_GLOB },
      { ordinal: 1, pattern: OTHER_PKG_GLOB },
    ]);
    const patterns = declaredPatterns({ paths: [TS_GLOB, null, 42, OTHER_PKG_GLOB] });
    expect(evaluateRulePatterns({ isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns, files: corpusOf(SUBJECT_TS) })
      .map((entry) => [entry.ordinal, entry.status])).toEqual([[0, 'matched'], [1, 'inert']]);
  });

  it("finds a NESTED rule's glob relative to its own project directory", () => {
    // ⛔ The vendor does not say which base a nested rules file's globs resolve
    // against. Swept only against the repo root, a fixture project's glob was
    // reported dead beside its own source file — a false CLAUDE_RULE_GLOB_INERT
    // whose remedy deletes a working glob. Dead now means dead under BOTH
    // candidate bases.
    //
    // ⚠️ `src/lib/**`, not `src/**`, and the difference is FIX 1: `src/**`
    // strips to `src`, which gitignore matches at ANY depth, so it would reach
    // the fixture from the root and prove nothing about re-basing. A glob that
    // still holds a slash after the strip is the only kind that can.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED,
      rulePath: NESTED_RULE, patterns: declared(NESTED_ANCHORED_GLOB),
      files: corpusOf(NESTED_ANCHORED_FILE),
    });

    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', NESTED_ANCHORED_FILE]]);
    // The author's spelling survives the re-basing.
    expect(result[0]?.pattern).toBe(NESTED_ANCHORED_GLOB);
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
    // The positive control: the same glob and the same file, with a ROOT rules
    // file, is dead — so the test above passes because of the nesting and
    // nothing else.
    expect(statusesOf([NESTED_ANCHORED_GLOB], corpusOf(NESTED_ANCHORED_FILE))).toEqual(['inert']);
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

  it('calls a prefix that climbs out of the tree inert without asking the oracle', () => {
    // A `..` segment is dead by syntax — no path the harness asks has one — so
    // the territory question is never reached.
    const result = evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared('../sibling/**'), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['inert']);
  });

  it('never consults the oracle for a matched or an unevaluated glob', () => {
    // The cost claim: only a glob that would otherwise be inert asks git, so a
    // healthy tree (every glob matched) pays nothing, and a REFUSED one is not
    // judged at all. ⚠️ The refused entry is alone in its list: the budget is
    // per pattern now, so a `dist/**` beside it is evaluated on its own merits
    // and WOULD ask the oracle — which is the next test.
    expect(evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared(TS_GLOB), files: corpusOf(SUBJECT_TS),
    }).map((entry) => entry.status)).toEqual(['matched']);
    expect(evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE, patterns: declared(OVER_BUDGET_PATTERN),
      files: corpusOf(SUBJECT_TS),
    }).map((entry) => entry.status)).toEqual(['unevaluated']);
  });

  it('⭐ still judges the glob BESIDE a refused one, because the budget is per pattern', () => {
    // The positive control on the pair above, and the behaviour change itself:
    // a list is no longer all-or-nothing, so `dist/**` keeps its own
    // `gitignored` verdict next to a neighbour the harness refused to expand.
    const oracle = ignoresBeneath('dist');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE,
      patterns: declared(OVER_BUDGET_PATTERN, 'dist/**'), files: corpusOf(SUBJECT_TS),
    });

    expect(result.map((entry) => entry.status)).toEqual(['unevaluated', 'gitignored']);
    expect(oracle.asked).toEqual(['dist/vat-territory-probe']);
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

describe('the matcher is gitignore, not picomatch', () => {
  // ⛔ Every row is the SHIPPED harness's own answer, taken by running the
  // `node-ignore` copy extracted from the Claude Code 2.1.280 binary over the
  // same glob and path. That copy and the `ignore` package this module compiles
  // agree on all 5,723,140 (glob, path) pairs of the 13-repo public corpus plus
  // a synthetic battery, which is why matching with the library is bug-
  // compatibility and not an approximation of it.
  //
  // The picomatch column is what VAT used to answer. The four rows where it
  // says `false` against a harness `true` are live false CLAUDE_RULE_GLOB_INERT
  // findings — three of them measured on real public repositories — whose
  // remedy is "delete this glob".
  it.each([
    // [what, declared glob, file, does the harness load the rule?]
    ['a single-segment glob is UNANCHORED after the strip', 'src/**', 'packages/cli/src/index.ts', true],
    ['…and still matches at the root', 'src/**', 'src/index.ts', true],
    ['a bare filename matches at any depth', 'README.md', 'docs/atlas/README.md', true],
    ['a mid-`**` glob spans zero segments', 'packages/**/ports*', 'packages/ports/index.ts', true],
    ['…and many', 'packages/**/ports*', 'packages/core/src/ports.ts', true],
    ['a matched directory drags its whole subtree', 'docs/*', 'docs/a/b/c.md', true],
    ['a slash in the middle ANCHORS to the root', 'packages/src/**', 'x/packages/src/a.ts', false],
    ['a leading slash anchors', '/src/**', 'packages/cli/src/a.ts', false],
    ['…and matches at the root', '/src/**', 'src/a.ts', true],
    ['a trailing slash matches a DIRECTORY only', 'notes.md/', 'notes.md', false],
    ['a character class is supported', 'src/[ab].ts', 'src/a.ts', true],
    ['an extglob is LITERAL — gitignore has none', 'src/+(a|b).ts', 'src/a.ts', false],
    ['`./` is not gitignore syntax', './docs/**', 'docs/a.md', false],
    ['a dotfile needs no option', '.claude/**', '.claude/rules/a.md', true],
    // The braces are the HARNESS's, expanded before the matcher ever sees them
    // — `ignore` would have treated them as literal characters.
    ['a brace group is expanded by the harness, not the matcher', 'src/{a,b}/x.ts', 'src/b/x.ts', true],
  ])('%s', (_what, glob, file, loads) => {
    expect(statusesOf([glob], corpusOf(file))).toEqual([loads ? 'matched' : 'inert']);
  });

  it('⭐ answers the three false CLAUDE_RULE_GLOB_INERT findings measured on public repos', () => {
    // These three are not hypotheses: they are the only liveness divergences in
    // 314 declared patterns across 13 public repositories with real
    // `.claude/rules`, and all three were VAT reporting a live glob as dead.
    // Asserted together so the corpus measurement has one place in the suite.
    expect(statusesOf(['vitest.config.ts'], corpusOf('apps/web/vitest.config.ts')))
      .toEqual(['matched']);
    expect(statusesOf(['playwright.bdd.config.ts'], corpusOf('e2e/playwright.bdd.config.ts')))
      .toEqual(['matched']);
    expect(statusesOf(['packages/**/ports*'], corpusOf('packages/ports/index.ts')))
      .toEqual(['matched']);
  });

  it('⛔ treats a glob `node-ignore` cannot COMPILE as matching nothing, and does not throw', () => {
    // 🪤 `src/a[/` is an unterminated character class. `ignore().add()` builds
    // no regex, so the `SyntaxError` surfaces from a getter at MATCH time,
    // three frames below any call site — one mistyped glob in one adopter's
    // rules file would take the whole projection down. The harness drops such a
    // pattern up front and treats it as matching nothing; so does this. The
    // second assertion is the positive control: the same class, terminated,
    // still matches.
    expect(statusesOf(['src/a[/'], corpusOf('src/a.ts'))).toEqual(['inert']);
    expect(statusesOf(['src/a[bc].ts'], corpusOf('src/ab.ts'))).toEqual(['matched']);
  });

  it('answers a FILE query with the whole rule\'s list, so a `!` can take a file back out', () => {
    // ⛔ The one question a per-pattern matcher cannot answer. A negation means
    // nothing alone — `ignore()` over `!src/gen/**` matches no path at all — so
    // the admission is decided by ONE matcher over every glob the rule
    // declares, in declaration order, exactly as the harness builds it. The
    // pair is the point: same rule, same two globs, two files either side of
    // the exclusion.
    const path = '.claude/rules/negated.md';
    const included = 'src/**/*.ts';
    const input = {
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, [included, '!src/gen/*.ts'])], queryDir: 'src',
    };

    expect(selectRules({ ...input, queryFile: 'src/a.ts' }).rules[0]?.admission)
      .toEqual({ kind: 'glob-rule', pattern: included });
    expect(selectRules({ ...input, queryFile: 'src/gen/a.ts' }).rules).toEqual([]);
    // The positive control on the exclusion: without it, the same file loads.
    expect(selectRules({
      ...input, blobs: [blob(path, [included])], queryFile: 'src/gen/a.ts',
    }).rules[0]?.admission).toEqual({ kind: 'glob-rule', pattern: included });
  });

  it('cannot re-include under an EXCLUDED DIRECTORY, which is gitignore\'s own rule', () => {
    // ⚠️ The trap beside the test above, and the reason the negation fixture
    // there narrows by extension. `src/**` strips to `src`, which matches the
    // DIRECTORY, and gitignore refuses to re-include anything beneath an
    // excluded directory — `node-ignore`'s `_t` returns the ancestor's verdict
    // before the path's own rules are consulted. So `!src/gen/**` beside
    // `src/**` takes nothing back out, and a fixture written that way would
    // have asserted the negation worked while measuring that it did not.
    const path = '.claude/rules/futile-negation.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, ['src/**', '!src/gen/**'])],
      queryDir: 'src', queryFile: 'src/gen/a.ts',
    });

    expect(result.rules[0]?.admission).toEqual({ kind: 'glob-rule', pattern: 'src/**' });
  });

  it('⭐ decides ∀ by asking the matcher about the DIRECTORY, so an unanchored glob covers it', () => {
    // ⛔ The old ∀ was a shape match — a glob-free literal prefix plus `/**` —
    // and it declined every other spelling of the same claim. Gitignore carries
    // a matched directory's whole subtree, so `docs` (no slash, unanchored)
    // covers `packages/cli/src` the moment `src` is one of its segments. Here
    // the covering glob is `cli`: unanchored, matching the `cli` directory, and
    // therefore everything under it. No file is realized, so only ∀ can answer.
    const path = '.claude/rules/covering.md';
    const result = selectRules({
      realizations: [queryRealization(path)], tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, ['cli/**'])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission).toEqual({ kind: COVERS_DIR, pattern: 'cli/**' });
  });

  it('still declines ∀ for a glob that covers no whole directory', () => {
    // The positive control on the test above. `*.md` matches markdown at any
    // depth and no directory anywhere, so it is ∃ with a witness, never ∀.
    const path = '.claude/rules/markdown-only.md';
    const result = selectRules({
      realizations: [queryRealization(path), queryRealization(SUBJECT_MD), queryRealization(SUBJECT_TS)],
      tags: [scopeTag(path, PATH_SCOPED)],
      blobs: [blob(path, ['*.md'])], queryDir: PACKAGES_CLI_SRC, queryFile: null,
    });

    expect(result.rules[0]?.admission)
      .toEqual({ kind: MAY_FIRE, pattern: '*.md', examplePath: SUBJECT_MD });
  });
});

/**
 * The globs one `paths:` list expands to, per entry.
 *
 * @param patterns - The rule's `paths:` entries
 * @returns One glob list per entry, in declaration order
 */
function globsOf(patterns: readonly string[]): readonly (readonly string[])[] {
  return harnessExpansion(patterns).map((entry) => entry.globs);
}

/**
 * Which entries the vendor's budget refused, by index.
 *
 * @param patterns - The rule's `paths:` entries
 * @returns The refused indices, in order
 */
function refusedIndices(patterns: readonly string[]): readonly number[] {
  return harnessExpansion(patterns).flatMap((entry, index) => (entry.refused ? [index] : []));
}

describe('harnessExpansion — `N()`, transcribed', () => {
  it('multiplies brace groups, and strips the trailing `/**` from each result', () => {
    expect(globsOf(['a/{x,y}/{p,q}/**'])).toEqual([['a/x/p', 'a/x/q', 'a/y/p', 'a/y/q']]);
  });

  it('leaves a brace-free pattern alone', () => {
    expect(globsOf(['a/**/*.ts'])).toEqual([['a/**/*.ts']]);
  });

  // ⛔ Every expectation below is the SHIPPED harness's own output, taken by
  // running the transcribed `pet()`/`C()`/`N()` on the same input — not what a
  // brace-expansion library would produce, and not what looks tidy. Three of
  // them are ugly (`{1..5000}` loses its braces and expands to one literal
  // segment; a nested group leaves a stray `}` behind) and that ugliness IS the
  // answer: `l.split(",")` is the whole grammar.
  it.each([
    // ⛔ THE invention this replaced. There is no range expansion, so this is
    // ONE glob there. VAT scored it 5,000, blew a 1,000 allowance on a one-glob
    // pattern, and reported the rule `unevaluated` — declined work reported as
    // the adopter's typo.
    ['a numeric range', 'logs/{1..5000}/*.txt', ['logs/1..5000/*.txt']],
    ['a stepped range', 'v{1..10..2}.md', ['v1..10..2.md']],
    ['a character range', 'dir-{a..e}/x.md', ['dir-a..e/x.md']],
    // A comma-free group is still a group: `split(",")` yields one part, and
    // the braces come off with it.
    ['a single-item brace', 'a{b}c.md', ['abc.md']],
    // `[^}]+` cannot cross a `}`, so the inner group's own closer is consumed
    // as the OUTER group's, and the leftover `}` rides along on the first and
    // last alternative. Transcribed, not corrected.
    ['a nested group', '{x,y}{a,{b,c}}', ['xa}', 'xb', 'xc}', 'ya}', 'yb', 'yc}']],
  ])('expands %s to %j', (_what, pattern, expected) => {
    expect(globsOf([pattern])).toEqual([expected]);
  });

  it('⭐ spends NOTHING on brace-free patterns, so 1,001 of them are all live', () => {
    // ⛔ `if(!e.includes("{"))return[e]` precedes every decrement. VAT summed
    // the list to 1,001 against a 1,000 allowance and reported every one of
    // them `unevaluated`.
    const many = Array.from({ length: 1001 }, (_unused, index) => `p${index}/**`);

    expect(refusedIndices(many)).toEqual([]);
    expect(globsOf(many).flat()).toHaveLength(1001);
  });

  it('⭐ refuses only the pattern that exhausts the budget, and lets the rest continue', () => {
    // ⛔ The per-pattern half. The oversized entry is used unexpanded — its
    // braces are literal gitignore characters there — and the brace-free
    // neighbours on either side of it cost nothing and stay live.
    expect(refusedIndices([TS_GLOB, OVER_BUDGET_PATTERN, OTHER_PKG_GLOB])).toEqual([1]);
    expect(globsOf([OVER_BUDGET_PATTERN])).toEqual([[OVER_BUDGET_PATTERN]]);
  });

  it('gives a range-shaped pattern a STATUS, where VAT used to refuse to look', () => {
    // The consequence, end to end: one literal glob, evaluated, matching no
    // file — a defect the adopter can act on rather than a refusal they cannot.
    expect(statusesOf(['logs/{1..5000}/*.txt'], corpusOf(SUBJECT_TS))).toEqual(['inert']);
  });
});

describe('declaredPatterns — what the harness reads out of one `paths:` value', () => {
  // ⭐ Ground truth is the SHIPPED harness, not the doc. Claude Code 2.1.280
  // normalises `paths:` through one function: a list is flat-mapped through it,
  // a STRING is split on commas at brace depth 0 and each part trimmed, and
  // anything else contributes nothing. The doc shows only a YAML sequence,
  // which does not make the string form unreadable — it makes it undocumented,
  // and a rules file carrying one is path-scoped in the harness while VAT saw
  // no globs at all and charged the rule as always-loaded.
  it('reads a SCALAR string, comma-split, exactly as the harness does', () => {
    expect(declaredPatterns({ paths: 'packages/**/*.ts, apps/**/*.tsx' })).toEqual([
      { ordinal: 0, pattern: 'packages/**/*.ts' },
      { ordinal: 1, pattern: 'apps/**/*.tsx' },
    ]);
  });

  it('reads a single-pattern string as one pattern', () => {
    expect(declaredPatterns({ paths: TS_GLOB })).toEqual([{ ordinal: 0, pattern: TS_GLOB }]);
  });

  it('does not split a comma INSIDE a brace group', () => {
    // The harness tracks brace depth while splitting, because `{ts,tsx}` is one
    // pattern and splitting it yields two that match nothing.
    expect(declaredPatterns({ paths: 'src/**/*.{ts,tsx}, docs/**' })).toEqual([
      { ordinal: 0, pattern: 'src/**/*.{ts,tsx}' },
      { ordinal: 1, pattern: 'docs/**' },
    ]);
  });

  it('comma-splits a LIST entry too, because the harness flat-maps the list', () => {
    expect(declaredPatterns({ paths: ['a/**, b/**', 'c/**'] })).toEqual([
      { ordinal: 0, pattern: 'a/**' },
      { ordinal: 1, pattern: 'b/**' },
      { ordinal: 2, pattern: 'c/**' },
    ]);
  });

  it('drops an empty part rather than declaring a pattern that matches nothing', () => {
    expect(declaredPatterns({ paths: 'a/**, ,' })).toEqual([{ ordinal: 0, pattern: 'a/**' }]);
  });

  it('reads no pattern from a paths: that is neither a string nor a list', () => {
    expect(declaredPatterns({ paths: 42 })).toEqual([]);
    expect(declaredPatterns({ paths: { glob: 'a/**' } })).toEqual([]);
    expect(declaredPatterns(null)).toEqual([]);
  });

  it('⭐ RECURSES into a nested list, because the harness flat-maps through ITSELF', () => {
    // ⛔ `e.flatMap((a)=>C(a,n))` — `C`, not a string reader. So a nested list
    // is flattened, not discarded as a non-string. Read array-then-string, a
    // rule carrying `paths: [["src/**"]]` declared no glob, was classified as
    // carrying no `paths:` at all, and was charged to every query as
    // always-loaded. The `{ glob: … }` map above is the positive control: a
    // genuine non-string still contributes nothing.
    expect(declaredPatterns({ paths: [['src/**']] })).toEqual([{ ordinal: 0, pattern: 'src/**' }]);
    expect(declaresPaths({ paths: [['src/**']] })).toBe(true);
    expect(declaredPatterns({ paths: [[TS_GLOB, [OTHER_PKG_GLOB]]] }).map((entry) => entry.pattern))
      .toEqual([TS_GLOB, OTHER_PKG_GLOB]);
  });

  it('⭐ lets the brace depth go NEGATIVE on a stray `}`, as the harness does', () => {
    // ⛔ `else if(l==="}")o--`, unclamped. A stray closing brace drives the
    // depth to -1 and every later comma stops separating, so `"a}/b,c"` is ONE
    // pattern there. VAT clamped at zero — which reads as defensive and is the
    // thing being modelled getting it wrong differently — and declared two
    // patterns, one of which the harness never holds.
    expect(declaredPatterns({ paths: 'a}/b,c' })).toEqual([{ ordinal: 0, pattern: 'a}/b,c' }]);
    // The positive control: with the brace balanced, the comma splits again.
    expect(declaredPatterns({ paths: 'a{x}/b,c' }).map((entry) => entry.pattern))
      .toEqual(['a{x}/b', 'c']);
  });

  // ⭐ The harness drops a trailing `/**`, then treats "nothing left" and "all
  // `**`" as NO paths: at all — the rule loads every turn. A pattern reported
  // for such a rule would name a glob that decides nothing.
  it('declares NOTHING for a rule the harness loads unconditionally', () => {
    expect(declaredPatterns({ paths: ['**'] })).toEqual([]);
    expect(declaredPatterns({ paths: '**, **' })).toEqual([]);
    expect(declaredPatterns({ paths: ['/**'] })).toEqual([]);
    expect(declaredPatterns({ paths: [42] })).toEqual([]);
  });

  it('still declares the patterns of a rule ONE of whose globs is `**`', () => {
    expect(declaredPatterns({ paths: ['**', 'src/**'] })).toEqual([
      { ordinal: 0, pattern: '**' },
      { ordinal: 1, pattern: 'src/**' },
    ]);
  });
});

describe('declaresPaths — the load class the harness would give a rule', () => {
  it('is path-scoped when a pattern survives normalisation', () => {
    expect(declaresPaths({ paths: 'src/**' })).toBe(true);
    expect(declaresPaths({ paths: ['docs/**/*.md'] })).toBe(true);
    // one `**` beside a real glob still scopes the rule
    expect(declaresPaths({ paths: ['**', 'src/**'] })).toBe(true);
  });

  // ⛔ The under-report direction: charged as path-scoped, a rule that actually
  // loads every turn is missing from every budget answer.
  it('⭐ is ALWAYS-LOADED when every surviving pattern is `**`', () => {
    expect(declaresPaths({ paths: '**' })).toBe(false);
    expect(declaresPaths({ paths: ['**', '**'] })).toBe(false);
  });

  it('⭐ is ALWAYS-LOADED when nothing survives — including a trailing-`/**`-only glob', () => {
    expect(declaresPaths({ paths: '/**' })).toBe(false);
    expect(declaresPaths({ paths: [42] })).toBe(false);
    expect(declaresPaths({ paths: [] })).toBe(false);
    expect(declaresPaths({ paths: '  ' })).toBe(false);
    expect(declaresPaths(null)).toBe(false);
  });

  it('⭐ EXPANDS before it strips, so a brace group that yields only `**` is always-loaded', () => {
    // ⛔ The order is the whole answer. `{**,**}` ends in `}`, so a reader that
    // strips first keeps it intact, finds one survivor that is not `**`, and
    // calls the rule path-scoped — charging an adopter nothing for a rule that
    // loads every turn, and reporting a "glob" nobody wrote. The harness
    // expands first: two `**`s, every survivor `**`, no `paths:` at all.
    expect(declaresPaths({ paths: ['{**,**}'] })).toBe(false);
    expect(declaredPatterns({ paths: ['{**,**}'] })).toEqual([]);
    // `{/**,/**}` expands to two `/**`, each of which the strip empties.
    expect(declaresPaths({ paths: ['{/**,/**}'] })).toBe(false);
    // The positive control: the same shape holding one real glob still scopes.
    expect(declaresPaths({ paths: ['{**,src/**}'] })).toBe(true);
  });

  it('strips the trailing `/**` for the load class ONLY — `src/**` still scopes', () => {
    expect(declaresPaths({ paths: 'src/**' })).toBe(true);
    expect(declaredPatterns({ paths: 'src/**' })).toEqual([{ ordinal: 0, pattern: 'src/**' }]);
  });
});

/** A rules file one project below the root, for the re-base cases. */
const PKG_RULE = 'pkg/.claude/rules/r.md';

/** A glob with a negation after it — the exclusion cases share it. */
const EXCLUDING = ['src/*.ts', '!src/gen.ts'];

describe('the FILE lane builds its matcher from the globs the harness builds its matcher from', () => {
  it('⭐ loads a brace-group glob, which the harness expands before matching', () => {
    // ⛔ The file lane used to compile the DECLARED string, braces and all, so
    // `{ts,tsx}` was literal text there while the directory lane and the
    // per-pattern lane expanded it — three lanes, two answers.
    const glob = 'src/**/*.{ts,tsx}';
    expect(admissionsFor(TS_RULE, [glob], [], 'src', 'src/a.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: glob }]);
    expect(admissionsFor(TS_RULE, [glob], [], 'src', 'src/a.md')).toEqual([]);
  });

  it('⭐ loads a deep file for `src/**`, which the harness strips to the unanchored `src`', () => {
    expect(admissionsFor(TS_RULE, ['src/**'], [], PACKAGES_CLI_SRC, SUBJECT_TS))
      .toEqual([{ kind: 'glob-rule', pattern: 'src/**' }]);
    // The directory lane already said so; the two lanes now agree.
    expect(admissionsFor(TS_RULE, ['src/**'], [SUBJECT_TS], PACKAGES_CLI_SRC, null))
      .toEqual([{ kind: COVERS_DIR, pattern: 'src/**' }]);
  });
});

describe('a negation pattern is judged by what it EXCLUDES', () => {
  it('⭐ calls a negation matched when it takes a file the rule would otherwise load back out', () => {
    // ⛔ Evaluated alone, `!src/gen.ts` matches nothing, so it was reported
    // inert — and CLAUDE_RULE_GLOB_INERT told the author to delete a working
    // exclusion.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(...EXCLUDING),
      files: corpusOf('src/a.ts', 'src/gen.ts'),
    });

    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', 'src/a.ts'], ['matched', 'src/gen.ts']]);
  });

  it('calls a negation inert when it excludes nothing VAT can see', () => {
    expect(statusesOf(EXCLUDING, corpusOf('src/a.ts'))).toEqual(['matched', 'inert']);
  });

  it('calls a negation inert when nothing BEFORE it would have loaded the file', () => {
    // The file exists, but the only positive pattern never reached it, so the
    // negation takes nothing out.
    expect(statusesOf(['lib/*.ts', '!src/gen.ts'], corpusOf('src/gen.ts', 'lib/a.ts')))
      .toEqual(['matched', 'inert']);
  });

  it('calls a negation over gitignored territory gitignored, not inert', () => {
    const oracle = ignoresBeneath('gen');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE, patterns: declared('src/**', '!gen/**'),
      files: corpusOf('src/a.ts'),
    });

    expect(result.map((entry) => entry.status)).toEqual(['matched', 'gitignored']);
  });

  it('calls a budget-refused negation unevaluated', () => {
    expect(statusesOf(['src/**', `!${OVER_BUDGET_PATTERN}`], corpusOf('src/a.ts')))
      .toEqual(['matched', 'unevaluated']);
  });
});

describe('the DIRECTORY lane answers for the whole rule, negations included', () => {
  it('⭐ never calls a rule that excludes the directory it includes covers-dir', () => {
    expect(admissionsFor(TS_RULE, ['docs/**', '!docs/**'], ['docs/a.md'], 'docs', null)).toEqual([]);
    // The positive control: without the negation it covers the directory.
    expect(admissionsFor(TS_RULE, ['docs/**'], ['docs/a.md'], 'docs', null))
      .toEqual([{ kind: COVERS_DIR, pattern: 'docs/**' }]);
  });

  it('⭐ never names an EXCLUDED file as the ∃ witness', () => {
    expect(admissionsFor(TS_RULE, EXCLUDING, ['src/gen.ts', 'src/z.ts'], 'src', null))
      .toEqual([{ kind: MAY_FIRE, pattern: 'src/*.ts', examplePath: 'src/z.ts' }]);
    expect(admissionsFor(TS_RULE, EXCLUDING, ['src/gen.ts'], 'src', null)).toEqual([]);
  });

  it('declines ∀ at the ROOT when a later negation carves something out', () => {
    // ∃, never ∀. The witness is whichever loaded file sorts first — here the
    // rules file itself — and never one under the excluded `docs`.
    const [admission] = admissionsFor(TS_RULE, ['**/*', '!docs/**'], ['docs/a.md', 'src/a.ts'], '', null);
    expect(admission).toMatchObject({ kind: MAY_FIRE, pattern: '**/*' });
    expect((admission as { examplePath: string }).examplePath).not.toMatch(/^docs\//);
    expect(admissionsFor(TS_RULE, ['**/*'], ['docs/a.md'], '', null))
      .toEqual([{ kind: COVERS_DIR, pattern: '**/*' }]);
  });
});

describe('a NESTED rule re-bases a pattern without changing what its prefix means', () => {
  it('⭐ anchors a leading `/` to the nested project, not to a doubled slash', () => {
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: PKG_RULE, patterns: declared('/src/lib/**'),
      files: corpusOf('pkg/src/lib/a.ts'),
    });
    expect(result.map((entry) => entry.status)).toEqual(['matched']);
    expect(admissionsFor(PKG_RULE, ['/src/lib/**'], [], 'pkg/src/lib', 'pkg/src/lib/a.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: '/src/lib/**' }]);
  });

  it('⭐ keeps a leading `./` dead under the nested base, as it is at the root', () => {
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: PKG_RULE, patterns: declared('./docs/**'),
      files: corpusOf('pkg/docs/a.md'),
    });
    expect(result.map((entry) => entry.status)).toEqual(['inert']);
    expect(admissionsFor(PKG_RULE, ['./docs/**'], [], 'pkg/docs', 'pkg/docs/a.md')).toEqual([]);
  });

  it('⭐ keeps a leading `!` at the FRONT, so a nested exclusion still excludes', () => {
    const paths = ['lib/x/*.ts', '!lib/x/gen.ts'];
    expect(admissionsFor(PKG_RULE, paths, [], 'pkg/lib/x', 'pkg/lib/x/gen.ts')).toEqual([]);
    expect(admissionsFor(PKG_RULE, paths, [], 'pkg/lib/x', 'pkg/lib/x/a.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: 'lib/x/*.ts' }]);
  });

  it('⭐ does not let a root-base negation exclude what the nested base loads', () => {
    // Under the nested base the list is `pkg/lib/a.ts`, `!pkg/pkg/lib/a.ts`,
    // which loads `pkg/lib/a.ts`. The root base's `!pkg/lib/a.ts` belongs to a
    // different reading of the rule and must not subtract from this one.
    const paths = ['lib/a.ts', '!pkg/lib/a.ts'];
    expect(admissionsFor(PKG_RULE, paths, [], 'pkg/lib', 'pkg/lib/a.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: 'lib/a.ts' }]);
    expect(admissionsFor(PKG_RULE, paths, ['pkg/lib/a.ts'], 'pkg/lib', null))
      .toEqual([{ kind: MAY_FIRE, pattern: 'lib/a.ts', examplePath: 'pkg/lib/a.ts' }]);
  });
});

/** A list whose last pattern RE-INCLUDES what its negation took out. */
const REINCLUDED = ['*.ts', '!gen.ts', '*.ts'];

describe('the whole-list matcher keeps gitignore\'s last-match-wins order', () => {
  it('⭐ loads a file a REPEATED positive pattern re-includes after a negation — file lane', () => {
    // ⛔ De-duplicating the glob list collapsed the third `*.ts` into the first,
    // so the negation became the last word and `src/gen.ts` read as excluded
    // while the harness — which adds the list as declared — loads it.
    expect(admissionsFor(TS_RULE, REINCLUDED, [], 'src', 'src/gen.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: '*.ts' }]);
  });

  it('⭐ names the re-included file as the ∃ witness — directory lane', () => {
    expect(admissionsFor(TS_RULE, REINCLUDED, ['src/gen.ts'], 'src', null))
      .toEqual([{ kind: MAY_FIRE, pattern: '*.ts', examplePath: 'src/gen.ts' }]);
  });

  it('⭐ calls the overridden negation inert and both positives matched — witness lane', () => {
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared(...REINCLUDED),
      files: corpusOf('src/gen.ts'),
    });
    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', 'src/gen.ts'], ['inert', null], ['matched', 'src/gen.ts']]);
  });
});

describe('a pattern\'s status accounts for the patterns AFTER it', () => {
  it('⭐ never calls a positive pattern matched on a file a LATER negation takes back out', () => {
    // The rule loads nothing: the positive's only file is excluded. The
    // negation is what makes that so, so IT is the live one.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared('src/gen.ts', '!src/gen.ts'),
      files: corpusOf('src/gen.ts'),
    });
    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['inert', null], ['matched', 'src/gen.ts']]);
  });

  it('⭐ calls a negation inert when a LATER pattern re-includes everything it excluded', () => {
    expect(statusesOf(['src/*.ts', '!src/gen.ts', 'src/gen.ts'], corpusOf('src/a.ts', 'src/gen.ts')))
      .toEqual(['matched', 'inert', 'matched']);
  });

  it('keeps the positive control: a negation nothing later overrides is still matched', () => {
    expect(statusesOf(['src/*.ts', '!src/gen.ts', 'lib/*.ts'], corpusOf('src/a.ts', 'src/gen.ts', 'lib/b.ts')))
      .toEqual(['matched', 'matched', 'matched']);
  });
});

describe('a root-anchored glob locates its territory without the anchor', () => {
  it('⭐ calls `/dist/**` over a gitignored `dist/` gitignored, as it does `dist/**`', () => {
    // ⛔ The oracle was asked about `/dist/…` — an ABSOLUTE path, which no
    // repository ignores — so the anchored spelling of the same glob read as a
    // dead one and CLAUDE_RULE_GLOB_INERT told the author to delete it.
    const oracle = ignoresBeneath('dist');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE, patterns: declared('/dist/**', 'dist/**'),
      files: corpusOf(SUBJECT_TS),
    });
    expect(result.map((entry) => [entry.status, entry.literalPrefix]))
      .toEqual([['gitignored', 'dist'], ['gitignored', 'dist']]);
    expect(oracle.asked.every((path) => !path.startsWith('/'))).toBe(true);
  });

  it('asks a wholly-literal root-anchored pattern about the FILE it names', () => {
    const asked: string[] = [];
    evaluateRulePatterns({
      isIgnored: (path) => {
        asked.push(path);
        return false;
      },
      rulePath: ROOT_RULE, patterns: declared('/generated/api.ts'), files: corpusOf(SUBJECT_TS),
    });
    expect(asked).toEqual(['generated/api.ts']);
  });
});

describe('a NESTED rule is read against paths RELATIVE to its project, never by rewriting its globs', () => {
  it('⭐ never lets `**` reach the project directory itself — file lane', () => {
    // ⛔ Re-based, `**/` became `pkg/**/**/`, whose `**/` matches zero segments
    // and so matched `pkg/` — a path the harness never asks, because it asks
    // about `.claude/rules/r.md` relative to `pkg`. `!**` could not take `pkg/`
    // back out, and every file under it read as loaded. Found by the
    // differential test (seed 4643).
    expect(admissionsFor(PKG_RULE, ['**/', '!**'], ['pkg/a.ts'], 'pkg', 'pkg/a.ts')).toEqual([]);
  });

  it('⭐ lets a bare `!` (from `!/**`) exclude everything under the nested base', () => {
    // `!/**` strips to `!`, which node-ignore reads as negating every path.
    // Re-based it became the directory-only `!pkg/**/` and excluded no file.
    expect(admissionsFor(PKG_RULE, ['{a,b}', '!/**'], ['pkg/a'], 'pkg', 'pkg/a')).toEqual([]);
  });
});

describe('a bare `!` (the stripped `!/**`) is a live negation', () => {
  it('⭐ calls it matched on the file it takes back out — witness lane', () => {
    // ⛔ The cheap prefilter compiled the negation's positive half — the empty
    // string — which matches nothing, so the one negation that excludes EVERY
    // file read inert and CLAUDE_RULE_GLOB_INERT told the author to delete it.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: ROOT_RULE, patterns: declared('/a', '!/**'), files: corpusOf('a'),
    });
    expect(result.map((entry) => [entry.status, entry.witnessPath])).toEqual([['inert', null], ['matched', 'a']]);
  });
});

describe('a NESTED rule reads an UNANCHORED glob at any depth under its project', () => {
  it('⭐ lets an unanchored nested negation exclude a file below a subdirectory — file lane', () => {
    // ⛔ The re-base anchored `!gen.ts` to `!pkg/gen.ts`, but the harness reading
    // this rule against its own base matches `gen.ts` at any depth under `pkg`,
    // so `pkg/sub/gen.ts` is loaded under NEITHER base.
    const paths = ['sub/*.ts', '!gen.ts'];
    expect(admissionsFor(PKG_RULE, paths, [], 'pkg/sub', 'pkg/sub/gen.ts')).toEqual([]);
    expect(admissionsFor(PKG_RULE, paths, [], 'pkg/sub', 'pkg/sub/a.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: 'sub/*.ts' }]);
  });

  it('⭐ calls that unanchored nested negation matched, never inert — witness lane', () => {
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: PKG_RULE, patterns: declared('sub/*.ts', '!gen.ts'),
      files: corpusOf('pkg/sub/a.ts', 'pkg/sub/gen.ts'),
    });
    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', 'pkg/sub/a.ts'], ['matched', 'pkg/sub/gen.ts']]);
  });

  it('⭐ judges a negation PER BASE, so one that excludes under the nested base is live', () => {
    // The root base's `*.ts` still loads `pkg/sub/gen.ts` (`!sub/gen.ts` is
    // anchored at the root and misses it), but under the nested base the
    // negation takes it out. Judged against the union of bases it read inert.
    const result = evaluateRulePatterns({
      isIgnored: NOTHING_IGNORED, rulePath: PKG_RULE, patterns: declared('*.ts', '!sub/gen.ts'),
      files: corpusOf('pkg/a.ts', 'pkg/sub/gen.ts'),
    });
    expect(result.map((entry) => [entry.status, entry.witnessPath]))
      .toEqual([['matched', 'pkg/a.ts'], ['matched', 'pkg/sub/gen.ts']]);
    expect(admissionsFor(PKG_RULE, ['*.ts', '!sub/gen.ts'], [], 'pkg/sub', 'pkg/sub/gen.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: '*.ts' }]);
  });

  it('keeps the positive control: an unanchored nested positive still reaches a deep file', () => {
    expect(admissionsFor(PKG_RULE, ['gen.ts'], [], 'pkg/a/b', 'pkg/a/b/gen.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: 'gen.ts' }]);
  });
});

describe('a glob dead by SYNTAX is inert before its territory is asked about', () => {
  it('⭐ calls a leading-`./` glob over gitignored territory inert, never gitignored', () => {
    // ⛔ The harness matches nothing with `./dist/**` or `/./dist/**`, so
    // `gitignored` sent the author to their .gitignore for a glob that cannot
    // fire anywhere. The oracle is never asked: the syntax already answered.
    const result = evaluateRulePatterns({
      isIgnored: neverAsked, rulePath: ROOT_RULE,
      patterns: declared('./dist/**', '/./dist/**', '//dist/**', '!./dist/**'),
      files: corpusOf(SUBJECT_TS),
    });
    expect(result.map((entry) => entry.status)).toEqual(['inert', 'inert', 'inert', 'inert']);
  });

  it('keeps the positive control: the live spelling over the same territory is gitignored', () => {
    const oracle = ignoresBeneath('dist');
    const result = evaluateRulePatterns({
      isIgnored: oracle.isIgnored, rulePath: ROOT_RULE, patterns: declared('dist/**'),
      files: corpusOf(SUBJECT_TS),
    });
    expect(result.map((entry) => entry.status)).toEqual(['gitignored']);
  });
});

/** A positive the negation after it cancels, then a later positive that wins. */
const CANCELLED_THEN_LOADED = ['src/gen.ts', '!src/gen.ts', '*.ts'];

describe('the pattern NAMED is the one that loads the file under last-match-wins', () => {
  it('⭐ names the LAST matching positive — file lane', () => {
    expect(admissionsFor(TS_RULE, CANCELLED_THEN_LOADED, [], 'src', 'src/gen.ts'))
      .toEqual([{ kind: 'glob-rule', pattern: '*.ts' }]);
  });

  it('⭐ names the LAST matching positive — directory lane', () => {
    expect(admissionsFor(TS_RULE, CANCELLED_THEN_LOADED, ['src/gen.ts'], 'src', null))
      .toEqual([{ kind: MAY_FIRE, pattern: '*.ts', examplePath: 'src/gen.ts' }]);
  });

  it('⭐ covers the ROOT when the LAST covering pattern follows the negation', () => {
    expect(admissionsFor(TS_RULE, ['**', '!x', '**'], ['a.ts'], '', null))
      .toEqual([{ kind: COVERS_DIR, pattern: '**' }]);
    // The control: with nothing re-covering after it, the negation declines ∀.
    expect(admissionsFor(TS_RULE, ['**', '!x'], ['a.ts'], '', null)[0])
      .toMatchObject({ kind: MAY_FIRE });
  });
});
