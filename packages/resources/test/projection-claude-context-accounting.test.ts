/**
 * The accounting layer: the 4 MiB cliff, the subtree prune behind it, the
 * totals, and the published list of stated limits.
 *
 * ## Why the answers are hand-built rather than fixtured
 *
 * `account` is a pure function of a {@link LoadedContextAnswer}, so a projection
 * fixture would add a whole population run to reach the one input it actually
 * reads. `claude-context-fixture.ts` stays where it belongs — on the suites that
 * test the QUERY. What is built here is the query's OUTPUT.
 *
 * ## The two deep cases are not interchangeable
 *
 * They look alike and are not. A descendant of an oversize closure ROOT is caught
 * in one pass whatever the depth, because every import admission names its root:
 * a per-row check spots it without iterating, so a chain hung off an oversize
 * root passes under a two-hop implementation too. The case that separates a
 * fixpoint from a single pass is an oversize file in the MIDDLE of a closure —
 * its grandchild names neither the oversize file (that is its grandparent, not
 * its `viaPath`) nor a broken root. Both shapes are pinned, and only the second
 * one fails if `brokenRoutes` stops iterating.
 */

import { describe, expect, it } from 'vitest';

import {
  OVERSIZE_BYTES,
  account,
  type AccountedContext,
  type ChargeState,
} from '../src/projection/claude-context-accounting.js';
import {
  CLAUDE_CONTEXT_BOUNDS_STATEMENT,
  CLAUDE_CONTEXT_LIMITS,
  CLAUDE_CONTEXT_MODELLED_BEHAVIOURS,
} from '../src/projection/claude-context-limits.js';
import type {
  Admission,
  LoadedContextAnswer,
  LoadedRow,
} from '../src/projection/claude-context-query.js';

/** The closure root every fixture here is rooted at. */
const ROOT_CLAUDE_MD = 'CLAUDE.md';

/**
 * The one signed direction this file names three times — as a member of the
 * `direction` vocabulary, as one entry's value, and as a word a statement must
 * SAY. Hoisted for `sonarjs/no-duplicate-string`, which counts all three.
 */
const UNDER_REPORT = 'under-report';

/** The oversize file that sits in the MIDDLE of an otherwise intact closure. */
const MIDDLE_CLAUDE_MD = 'docs/CLAUDE.md';

/** The oversize middle's direct import. */
const MIDDLE_CHILD = 'docs/deep.md';

/** A plain import of the root, used by the depth-1 prune cases. */
const HANDBOOK = 'handbook.md';

/** The descendant that keeps an intact route of its own, below the oversize middle. */
const RESCUED = 'docs/rescued.md';

const PRUNED = 'pruned-by-oversize';

function row(overrides: Partial<LoadedRow> & Pick<LoadedRow, 'path'>): LoadedRow {
  return {
    resourceId: `id:${overrides.path}`, tokens: 100, bytes: 400, loadClass: 'always',
    admissions: [{ kind: 'ancestry', dir: '' }], ...overrides,
  };
}

function answer(rows: readonly LoadedRow[]): LoadedContextAnswer {
  return {
    kind: 'answer', input: '', directory: '', file: null, rows,
    conditions: [], overBudgetRules: [], unattributedImports: [],
  };
}

/** An import admission into the one closure these fixtures use. */
function imported(viaPath: string | null, depth: number | null): Admission {
  return { kind: 'import', rootPath: ROOT_CLAUDE_MD, viaPath, depth };
}

/** The `claude-md`-tagged identities, spelled the way {@link row} spells ids. */
function claudeMdIds(...paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.map((path) => `id:${path}`));
}

/** One row past the cliff — big enough to skip, and tagged so the cliff sees it. */
function oversizeRow(path: string, admissions?: readonly Admission[]): LoadedRow {
  const base = { path, bytes: OVERSIZE_BYTES + 1, tokens: 2_000_000 };
  return row(admissions === undefined ? base : { ...base, admissions });
}

function chargeAt(result: AccountedContext, path: string): ChargeState | undefined {
  return result.rows.find((candidate) => candidate.path === path)?.charge;
}

/**
 * `CLAUDE.md` (charged) → `docs/CLAUDE.md` (past the cliff) → `docs/deep.md`.
 *
 * Written once because the two fixpoint tests differ only in what hangs BELOW
 * it, and a second hand-copied chain is exactly where the two could drift into
 * testing different things while reading the same.
 */
function oversizeMiddleChain(): LoadedRow[] {
  return [
    row({ path: ROOT_CLAUDE_MD, tokens: 5 }),
    oversizeRow(MIDDLE_CLAUDE_MD, [imported(ROOT_CLAUDE_MD, 1)]),
    row({ path: MIDDLE_CHILD, tokens: 30, admissions: [imported(MIDDLE_CLAUDE_MD, 2)] }),
  ];
}

describe('account', () => {
  it('charges an ordinary member', () => {
    const result = account(answer([row({ path: ROOT_CLAUDE_MD })]), claudeMdIds(ROOT_CLAUDE_MD));

    expect(result.rows[0]?.charge).toBe('charged');
    expect(result.totals.alwaysTokens).toBe(100);
  });

  it('charges a >4 MiB CLAUDE.md ZERO — a cliff, not a truncation', () => {
    const result = account(answer([oversizeRow(ROOT_CLAUDE_MD)]), claudeMdIds(ROOT_CLAUDE_MD));

    expect(result.rows[0]?.charge).toBe('oversize-skipped');
    expect(result.totals.alwaysTokens).toBe(0);
    expect(result.totals.skippedOversizeRows).toBe(1);
  });

  it('charges a CLAUDE.md of EXACTLY 4 MiB in full — the cliff is strictly above', () => {
    const exact = row({ path: ROOT_CLAUDE_MD, bytes: OVERSIZE_BYTES, tokens: 1_000_000 });
    const result = account(answer([exact]), claudeMdIds(ROOT_CLAUDE_MD));

    expect(result.rows[0]?.charge).toBe('charged');
    expect(result.totals.alwaysTokens).toBe(1_000_000);
    expect(result.totals.skippedOversizeRows).toBe(0);
  });

  it('prunes the import subtree of a skipped CLAUDE.md', () => {
    const child = row({ path: HANDBOOK, tokens: 50_000, admissions: [imported(ROOT_CLAUDE_MD, 1)] });
    const result = account(
      answer([oversizeRow(ROOT_CLAUDE_MD), child]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(chargeAt(result, HANDBOOK)).toBe(PRUNED);
    expect(result.totals.alwaysTokens).toBe(0);
    expect(result.totals.prunedRows).toBe(1);
  });

  it('does NOT prune a member that is also reachable by an intact route', () => {
    const shared = row({
      path: 'shared.md', tokens: 40,
      admissions: [imported(ROOT_CLAUDE_MD, 1), { kind: 'root-rule' }],
    });
    const result = account(
      answer([oversizeRow(ROOT_CLAUDE_MD), shared]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(chargeAt(result, 'shared.md')).toBe('charged');
    expect(result.totals.alwaysTokens).toBe(40);
  });

  it('does NOT prune an import whose route is unattributed and whose root is intact', () => {
    // `viaPath: null` is the query's "I could not attribute a parent" row. It is
    // NOT evidence of a broken route, and treating it as one would under-report.
    const orphan = row({ path: 'orphan.md', tokens: 12, admissions: [imported(null, null)] });
    const result = account(
      answer([row({ path: ROOT_CLAUDE_MD, tokens: 5 }), orphan]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(chargeAt(result, 'orphan.md')).toBe('charged');
    expect(result.totals.alwaysTokens).toBe(17);
  });

  it('does NOT apply the cliff to a >4 MiB rules file — documented for CLAUDE.md only', () => {
    const bigRule = oversizeRow('.claude/rules/huge.md', [{ kind: 'root-rule' }]);
    const result = account(answer([bigRule]), claudeMdIds());

    expect(result.rows[0]?.charge).toBe('charged');
    expect(result.totals.alwaysTokens).toBe(2_000_000);
  });

  it('counts a member with no blob as unknown, contributing nothing to either total', () => {
    const result = account(
      answer([row({ path: ROOT_CLAUDE_MD, tokens: null, bytes: null })]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(result.rows[0]?.charge).toBe('unknown-size');
    expect(result.totals.alwaysTokens).toBe(0);
    expect(result.totals.unknownTokenRows).toBe(1);
  });

  it('separates the on-demand total from the always total', () => {
    const result = account(
      answer([
        row({ path: ROOT_CLAUDE_MD, tokens: 10 }),
        row({ path: 'packages/cli/.claude/rules/x.md', tokens: 7, loadClass: 'on-demand',
              admissions: [{ kind: 'nested-rule', under: 'packages/cli' }] }),
      ]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(result.totals).toMatchObject({ alwaysTokens: 10, onDemandTokens: 7 });
  });

  it('charges a row carrying NO admission at all — an empty route list is not a broken one', () => {
    // `[].every(…)` is `true`, so without the emptiness guard in `everyRouteBroken`
    // an admission-less row would be pruned as though every route into it were
    // broken. Nothing loaded such a row, but nothing broke it either.
    const result = account(
      answer([row({ path: ROOT_CLAUDE_MD, tokens: 9, admissions: [] })]),
      claudeMdIds(),
    );

    expect(result.rows[0]?.charge).toBe('charged');
    expect(result.totals.prunedRows).toBe(0);
    expect(result.totals.alwaysTokens).toBe(9);
  });

  it('prunes a THREE-hop descendant of a skipped CLAUDE.md', () => {
    const mid = row({ path: 'a.md', tokens: 10, admissions: [imported(ROOT_CLAUDE_MD, 1)] });
    const deep = row({ path: 'b.md', tokens: 20, admissions: [imported('a.md', 2)] });
    const result = account(
      answer([oversizeRow(ROOT_CLAUDE_MD), mid, deep]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(chargeAt(result, 'b.md')).toBe(PRUNED);
    expect(result.totals.alwaysTokens).toBe(0);
    expect(result.totals.prunedRows).toBe(2);
  });

  it('prunes the GRANDCHILD of an oversize file in the MIDDLE of an intact closure', () => {
    // ⛔ THE fixpoint test. Every case above hangs off an oversize closure ROOT,
    // and every import admission names its root — so a single per-row pass
    // catches those without iterating, and a two-hop implementation passes them
    // all. Here the root is intact and the cliff fires on an INTERMEDIATE:
    // `docs/deeper.md` names `docs/deep.md` as its `viaPath` and `CLAUDE.md` as
    // its root, neither of which is broken until `docs/deep.md` has itself been
    // marked. Only propagation to a fixpoint reaches it.
    const grandchild = row({
      path: 'docs/deeper.md', tokens: 40, admissions: [imported(MIDDLE_CHILD, 3)],
    });
    const result = account(
      answer([...oversizeMiddleChain(), grandchild]),
      claudeMdIds(ROOT_CLAUDE_MD, MIDDLE_CLAUDE_MD),
    );

    expect(chargeAt(result, MIDDLE_CHILD)).toBe(PRUNED);
    expect(chargeAt(result, 'docs/deeper.md')).toBe(PRUNED);
    expect(result.totals).toMatchObject({
      alwaysTokens: 5,
      prunedRows: 2,
      skippedOversizeRows: 1,
    });
  });

  it('stops propagating at a descendant that keeps an intact route of its own', () => {
    // The fixpoint must not run away: `docs/rescued.md` hangs off the pruned
    // `docs/deep.md` but is ALSO a root rule, so it loads regardless — and
    // nothing below it may be pruned on its account either.
    const rescued = row({
      path: RESCUED, tokens: 6,
      admissions: [imported(MIDDLE_CHILD, 3), { kind: 'root-rule' }],
    });
    const below = row({
      path: 'docs/below.md', tokens: 7, admissions: [imported(RESCUED, 4)],
    });
    const result = account(
      answer([...oversizeMiddleChain(), rescued, below]),
      claudeMdIds(ROOT_CLAUDE_MD, MIDDLE_CLAUDE_MD),
    );

    expect(chargeAt(result, RESCUED)).toBe('charged');
    expect(chargeAt(result, 'docs/below.md')).toBe('charged');
    expect(result.totals).toMatchObject({ alwaysTokens: 18, prunedRows: 1 });
  });

  it('reports an unknown-size row that is ALSO pruned as unknown, never as charged', () => {
    // Both states mean "contributes nothing", and only the counters tell them
    // apart — so a row landing in the wrong counter silently changes what the
    // totals claim to have measured.
    const blobless = row({
      path: 'gone.md', tokens: null, bytes: null, admissions: [imported(ROOT_CLAUDE_MD, 1)],
    });
    const result = account(
      answer([oversizeRow(ROOT_CLAUDE_MD), blobless]),
      claudeMdIds(ROOT_CLAUDE_MD),
    );

    expect(chargeAt(result, 'gone.md')).toBe('unknown-size');
    expect(result.totals).toMatchObject({ unknownTokenRows: 1, prunedRows: 0, alwaysTokens: 0 });
  });

  it('leaves the query answer untouched — every row is returned, none dropped', () => {
    const child = row({ path: HANDBOOK, tokens: 50_000, admissions: [imported(ROOT_CLAUDE_MD, 1)] });
    const input = answer([oversizeRow(ROOT_CLAUDE_MD), child]);
    const result = account(input, claudeMdIds(ROOT_CLAUDE_MD));

    expect(result.rows.map((candidate) => candidate.path)).toEqual([ROOT_CLAUDE_MD, HANDBOOK]);
    expect(input.rows[0]).not.toHaveProperty('charge');
  });
});

describe('the stated limits', () => {
  it('frames the list with a statement that is neither a floor nor a ceiling', () => {
    // ⛔ The sentence spec §11 says must never be omitted. It lives beside the
    // list rather than in the command that prints it, so that ANY consumer
    // rendering the limits reaches it too — a consumer that showed every signed
    // caveat while dropping this sentence would present them as a list of edge
    // cases, which is the one reading §11 exists to prevent.
    expect(CLAUDE_CONTEXT_BOUNDS_STATEMENT).toContain('neither a floor nor a ceiling');
    // Both directions named, not just "there are caveats".
    expect(CLAUDE_CONTEXT_BOUNDS_STATEMENT).toContain('uncertainty in both directions');
    // ⛔ And the half a zeroed counter must not be read as retiring.
    expect(CLAUDE_CONTEXT_BOUNDS_STATEMENT)
      .toContain('applies whether or not the unknown-size, skipped and pruned counters are zero');
  });

  it('states 23 limits covering all four directions', () => {
    // Spec §11's fifteen, plus the nested-rule trigger D-B6 introduced, plus the
    // unresolved-conditions collapse a reviewer confirmed after that, plus the
    // four the final review found missing — the token estimator, the unfollowed
    // variable import, the overall context-window scope, and the budget check a
    // directory query skips — plus the gitignored half this lane stopped
    // realizing.
    //
    // ⛔ A change detector, and only a change detector: it fails when this list
    // grows or shrinks, which is what caught a draft that reused a published
    // slot. It cannot see an assumption made elsewhere in the lane and never
    // written down — see the by-name assertions below for what it is paired with.
    expect(CLAUDE_CONTEXT_LIMITS).toHaveLength(23);
    const directions = new Set(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.direction));
    expect(directions.has('over-report')).toBe(true);
    expect(directions.has(UNDER_REPORT)).toBe(true);
    expect(directions.has('scope')).toBe(true);
    expect(directions.has('assumption')).toBe(true);
  });

  it('gives every limit a unique id and a non-empty statement', () => {
    // A duplicated id would let one limit shadow another in any output keyed by
    // id, and the count above would still read 16.
    const ids = CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const limit of CLAUDE_CONTEXT_LIMITS) {
      expect(limit.statement.length).toBeGreaterThan(0);
    }
  });

  it('publishes the nested-rule trigger assumption D-B6 introduced', () => {
    // The sixteenth. An earlier draft reused limit 15's slot for it and silently
    // dropped a published limit, which the count alone would not have caught.
    const ids = new Set(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id));
    expect(ids.has('nested-rule-trigger')).toBe(true);
    expect(ids.has('cliff-scope')).toBe(true);
  });

  it('publishes the unresolved-conditions collapse a reviewer confirmed', () => {
    // The seventeenth. A `toHaveLength` count alone cannot catch a duplicated or
    // dropped id — this pins the new limit by name, the same defense used above
    // for the sixteenth.
    const ids = new Set(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id));
    expect(ids.has('unresolved-conditions-collapse')).toBe(true);
  });

  it('publishes the two largest error sources in the headline number', () => {
    // The estimator and the unfollowed variable import: the two the final review
    // called the biggest and most certain, and the two the list omitted while
    // auditing a managed-policy JSON key. Named individually because a count
    // assertion is blind to one being dropped as another is added.
    const ids = new Set(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id));
    expect(ids.has('token-estimate')).toBe(true);
    expect(ids.has('variable-imports-unfollowed')).toBe(true);
  });

  it('states what the answer is not addressed to at all', () => {
    // The overall context window: not an error in the number, a question the
    // number is not an answer to.
    const byId = new Map(CLAUDE_CONTEXT_LIMITS.map((limit) => [limit.id, limit]));
    expect(byId.get('context-window-scope')?.direction).toBe('scope');
  });

  it('retired the directory budget limit when the check started running on both query shapes', () => {
    // ⛔ Asserted as an ABSENCE, and the absence is the whole point. The ∃/∀ split
    // moved the vendor's 1,000-pattern / 4 MiB check ahead of the file/directory
    // fork in `admissionFor`, so a directory query now reaches it and its
    // `overBudget` list is no longer always empty. Leaving the limit published
    // would tell a reader to ask about a FILE to get a check that already ran —
    // and a stale limit is worse than a missing one, because it is read as
    // current.
    const ids = new Set(CLAUDE_CONTEXT_LIMITS.map((limit) => limit.id));
    expect(ids.has('directory-budget-unchecked')).toBe(false);
  });

  it('publishes the one-hop bound the discoverability lens is answered under', () => {
    // Filed `scope`, not a report direction, and that is the classification the
    // entry exists to make: the discoverable set is not an error in the loaded
    // number, it is a DIFFERENT question. Nothing loads a markdown link, so its
    // tokens are neither an over- nor an under-report of what enters context.
    const limit = CLAUDE_CONTEXT_LIMITS.find((entry) => entry.id === 'discovery-one-hop');

    expect(limit?.direction).toBe('scope');
    expect(limit?.statement).toContain('ONE hop');
  });

  it('signs the existential classification as an under-report, because a rule can outlive its files', () => {
    // The bound the ∃/∀ split CREATED, and the one direction it runs in. Before
    // the split every path-scoped rule was admitted for every directory, so no
    // rule could go missing; now a rule whose patterns match nothing in the tree
    // today is absent and fires the day a matching file appears. Filed
    // `under-report` rather than `scope`: it makes the number too SMALL, which is
    // a direction a reader can hedge against.
    const limit = CLAUDE_CONTEXT_LIMITS.find((entry) => entry.id === 'existential-needs-a-file');

    expect(limit?.direction).toBe(UNDER_REPORT);
    expect(limit?.statement).toContain('∀ half is immune');
  });

  it('signs the gitignored half this lane stopped realizing as an under-report', () => {
    // ⛔ The one entry that MUST exist for the population change that created it
    // to be honest. `buildClaudeContextPopulation` now passes `DECLINE_IGNORED`,
    // so a generated `CLAUDE.md` the harness really does read is absent from the
    // answer. A docstring is not enough: an omission nobody declared is
    // indistinguishable from a file that is not there, and this list is the only
    // place a consumer can learn which way to hedge.
    const limit = CLAUDE_CONTEXT_LIMITS.find((entry) => entry.id === 'gitignored-not-realized');

    expect(limit?.direction).toBe(UNDER_REPORT);
    // The mechanism, so a reader can tell WHICH files are missing...
    expect(limit?.statement).toContain('gitignored');
    // ...and the one condition under which the bound is empty, so nobody hedges
    // against it in a tree where nothing is ignored at all.
    expect(limit?.statement).toContain('Outside a git working tree');
  });

  it('signs the estimator as an assumption running in both directions', () => {
    // ⛔ The direction is the load-bearing half. Filed as `over-report` or
    // `under-report` it would tell a reader which way to hedge, and `chars / 4`
    // gives no such licence — it is a rule VAT applies that the vendor never
    // stated, and its error is unsigned.
    const estimate = CLAUDE_CONTEXT_LIMITS.find((limit) => limit.id === 'token-estimate');

    expect(estimate?.direction).toBe('assumption');
    expect(estimate?.statement).toContain('BOTH directions');
  });

  it('states the symlink version gate without claiming dedup rests on a realpath collapse', () => {
    // ⛔ The claim this replaces was FALSE in shipped output: *"Dedup relies on
    // `realpathSync.native` collapsing symlink aliases"*. It does not.
    // `canonicalPathFor` asks `GitTracker.indexPathFor` FIRST and returns from
    // it, so the `realPathOrSelf` fallback is unreachable for any path
    // `git ls-files --cached --others` lists — a link and its target mint TWO ids
    // on the default lane (`identity.ts`, *"🪤 A symlink and its target do NOT
    // reliably share one identity"*; pinned as `distinctResourceIds() === 3`).
    // Nothing in this answer ever depended on that collapse: the Claude-context
    // lane registers the filesystem extent alone, and a symlink path is not a
    // member of it, which is also what makes the vendor gate an UNDER-report
    // rather than a double charge.
    const limit = CLAUDE_CONTEXT_LIMITS.find((entry) => entry.id === 'version-gated');

    // Still a `scope` entry: its subject is that no version FLOOR is pinned.
    expect(limit?.direction).toBe('scope');
    expect(limit?.statement).toContain('pins no floor');
    // The vendor fact survives — it is the citation the modelled list carries.
    expect(limit?.statement).toContain('v2.1.198');
    expect(limit?.statement).toContain('path-scoped rule');
    // ...and the direction the gate actually runs in is stated, not left to the reader.
    expect(limit?.statement).toContain(UNDER_REPORT);
    // Both halves of the false mechanism claim are gone.
    expect(limit?.statement).not.toContain('realpathSync');
    expect(limit?.statement).not.toContain('Dedup');
  });

  it('names no single assumed Claude Code version, only dated per-behaviour citations', () => {
    // The property the name claims, asserted directly: more than one distinct
    // vendor version is modelled, so no single "assumed version" constant could
    // stand for the set — which is the thing `ModelledBehaviour`'s docstring
    // refuses to introduce. A per-entry format check alone passes just as
    // happily on a list whose four entries all name one version.
    const versions = new Set(CLAUDE_CONTEXT_MODELLED_BEHAVIOURS.map((entry) => entry.introducedIn));
    expect(versions.size).toBeGreaterThan(1);

    for (const entry of CLAUDE_CONTEXT_MODELLED_BEHAVIOURS) {
      expect(entry.introducedIn).toMatch(/^v\d+\.\d+\.\d+$/);
      // A fetch DATE is required; the specific date deliberately is not. Pinning
      // it made a legitimate doc refresh — the maintenance this list exists to
      // invite — fail a test about version constants.
      expect(entry.citedFrom).toMatch(/\(fetched \d{4}-\d{2}-\d{2}\)$/);
    }
  });
});
