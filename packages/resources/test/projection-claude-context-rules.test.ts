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
