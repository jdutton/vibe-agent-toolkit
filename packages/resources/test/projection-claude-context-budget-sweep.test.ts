/**
 * The whole-tree budget sweep: the representative collapse, and the differential
 * oracle that proves the collapse is not lying.
 *
 * ## Why this suite is fixtured when its two neighbours are not
 *
 * `projection-claude-context-accounting.test.ts` and
 * `projection-claude-context-budget.test.ts` both hand-build their inputs, and
 * both say why: the functions under test are pure predicates over a row list, so
 * a projection fixture would add a population run to reach the handful of fields
 * they read. The sweep is the opposite shape. Its entire content is a claim about
 * how `whatLoadsAt` behaves across a TREE — that a directory with no `CLAUDE.md`
 * of its own pays exactly what its nearest instructed ancestor pays. Hand-built
 * rows cannot express that claim at all, because they have already decided the
 * answer the sweep is supposed to derive.
 *
 * ## The oracle is the point of the file
 *
 * `sweepAlwaysLoadedBudgets` is a SECOND model of "which directories matter",
 * living beside `whatLoadsAt`'s. If the two drift, every budget goes silently
 * stale — a wrong number, which is worse than no number. So the central case
 * recomputes every location the long way (`whatLoadsAt` → `account` →
 * `alwaysLoadedBudget`, one query per location, no collapse) and demands the two
 * agree location by location. It also demands the collapse actually collapsed:
 * a sweep that quietly degraded to querying everything would still be correct,
 * and correct-but-pointless must not read as a pass.
 *
 * ⛔ The oracle lives in ONE function ({@link expectOracleAgreement}) that every
 * fixture is run through, never copied per fixture: a copied oracle is one
 * somebody can weaken in one place while the other keeps reading as covered.
 *
 * ## The root-rule fixture, and why this corpus cannot produce it
 *
 * {@link ROOT_RULE_TREE} carries an UNSCOPED rule in the root `.claude/rules/`,
 * which `baseLoadClass` classes `always` and `alwaysLoadedBudget` therefore
 * charges. VAT's own tree has no such file — all eight of its rules files carry
 * `paths:` — so this is the only place the sweep's soundness argument about a
 * launch-time rule is exercised at all. That argument used to rest on the budget
 * EXCLUDING every rule admission; it never needed to, and the sweep module's
 * docstring now states it from the premise that survives: a root rule is
 * selected for every query directory alike, so it is a constant, and a constant
 * cannot separate two groups.
 */

import { describe, expect, it } from 'vitest';

import { account } from '../src/projection/claude-context-accounting.js';
import {
  sweepAlwaysLoadedBudgets,
  type BudgetSweep,
  type LocationBudget,
} from '../src/projection/claude-context-budget-sweep.js';
import { alwaysLoadedBudget } from '../src/projection/claude-context-budget.js';
import { whatLoadsAt } from '../src/projection/claude-context-query.js';
import type { Projection } from '../src/projection/projection.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';
import { claudeMdIdsOf } from './helpers/claude-md-ids.js';

/** A threshold well above every fixture total, so nothing is over budget by accident. */
const ROOMY = 1_000_000;

/** The corpus root, as both a location and a representative. */
const ROOT = '';

/** The one directory below the root that carries a `CLAUDE.md` of its own. */
const CLI = 'packages/cli';

/** `CLI`'s child, which inherits from it. */
const CLI_SRC = 'packages/cli/src';

/**
 * The sibling whose NAME starts with `CLI`'s and which must inherit nothing from
 * it — the single most likely defect in the ancestor walk.
 */
const CLI_X = 'packages/cli-x';

/** The uninstructed package the `gitignored` cases mark and unmark. */
const UTILS = 'packages/utils';

/** `UTILS`'s only file — ignoring both is what removes the directory from the sweep. */
const UTILS_README = `${UTILS}/README.md`;

/**
 * A tree with two instructed directories, one `@` import, and a sibling that
 * merely shares a name prefix with an instructed directory.
 *
 * The import matters: `docs/handbook.md` is admitted only through the root
 * `CLAUDE.md`'s closure, so it is charged to every location in the root group
 * and to `CLI`'s group as well. A fixture without one would leave the sweep's
 * whole reason for querying rather than summing untested.
 */
const TREE: Record<string, string> = {
  'CLAUDE.md': '@docs/handbook.md\n\nRoot instructions for the whole corpus.\n',
  'docs/handbook.md': 'The handbook body, imported at one hop from the root.\n',
  'docs/guide.md': 'A guide nothing imports.\n',
  'packages/cli/CLAUDE.md': 'CLI instructions. '.repeat(40),
  'packages/cli/src/main.md': 'Source notes.\n',
  'packages/cli-x/README.md': 'A sibling package that shares a name prefix.\n',
  [UTILS_README]: 'Utils notes.\n',
};

/** Every working location `TREE` produces, in the order the sweep must report them. */
const TREE_LOCATIONS = [ROOT, 'docs', 'packages', CLI, CLI_X, CLI_SRC, UTILS];

/** The unscoped root rule `ROOT_RULE_TREE` hangs its whole case off. */
const ROOT_RULE = '.claude/rules/style.md';

/** The file that rule imports at one hop — charged only if the rule itself is. */
const RULE_IMPORT = 'docs/style-guide.md';

/**
 * A tree whose ROOT `.claude/rules/` holds an UNSCOPED rule — no `paths:`
 * frontmatter — so `ClaudeRulesScopeContributor` scopes it `root` and
 * `baseLoadClass` classes it `always`.
 *
 * ⛔ This shape cannot occur in VAT's own tree: all eight of this repo's rules
 * files carry `paths:`, so every one is `glob-rule` and none is `root-rule`. It
 * is the adopter shape that made `vat claude budget` disagree with `vat claude
 * context` about the same directory, and no fixture derived from this corpus can
 * reach it.
 *
 * The rule also `@`-imports, because that is the self-consistency half: a rules
 * file is itself an import root, so its one-hop import was charged in full while
 * the rule's own bytes were free.
 *
 * ⚠️ The reference is written `../../` because `resolveReference` resolves an
 * `@` import against the IMPORTING FILE's directory, not against the corpus
 * root. A rule two levels down spelling it `@docs/style-guide.md` asks for
 * `.claude/rules/docs/style-guide.md`, which nothing realizes — the fixture's
 * first draft did exactly that, and the closure reported
 * `CLOSURE_REFERENCE_UNRESOLVED` instead of admitting a member.
 */
const ROOT_RULE_TREE: Record<string, string> = {
  'CLAUDE.md': 'Root instructions for the whole corpus.\n',
  [ROOT_RULE]: `@../../${RULE_IMPORT}\n\nAn unscoped root rule. No \`paths:\` frontmatter, so it loads at launch.\n`,
  [RULE_IMPORT]: 'The style guide, imported by the root rule at one hop.\n',
  'packages/cli/CLAUDE.md': 'CLI instructions. '.repeat(40),
  'packages/cli/src/main.md': 'Source notes.\n',
};

/**
 * A tree with NO root `CLAUDE.md`, so a directory under no instructed ancestor
 * has to fall back to the corpus root rather than to nothing.
 */
const ROOTLESS_TREE: Record<string, string> = {
  'packages/cli/CLAUDE.md': 'Only the CLI is instructed here.\n',
  'docs/guide.md': 'A guide under no instructed ancestor at all.\n',
};

/**
 * Two sibling directories that a locale collation and a code-point collation
 * order DIFFERENTLY — `'Docs'.localeCompare('apps')` is positive, `'Docs' <
 * 'apps'` is true. A fixture whose siblings agree under both cannot tell the two
 * orderings apart, and this output gets diffed across machines.
 */
const CASED_TREE: Record<string, string> = {
  'CLAUDE.md': 'Root.\n',
  'Docs/a.md': 'a\n',
  'apps/b.md': 'b\n',
};

/**
 * The INDEPENDENT budget for one location — one query per location, no collapse,
 * no memoization, no representative.
 *
 * This is the oracle's whole apparatus: the naive ~9.6-second sweep the shipped
 * one exists to avoid, written out so the shipped one can be checked against it.
 *
 * @param projection - The populated projection
 * @param directory - The working location
 * @param threshold - The always-loaded budget, in tokens
 * @returns `tokens` and `overBudget`, or null when the query answers `unknown`
 */
function budgetTheLongWay(
  projection: Projection,
  directory: string,
  threshold: number,
): { tokens: number; overBudget: boolean } | null {
  const answer = whatLoadsAt(projection, directory);
  if (answer.kind === 'unknown') return null;
  const accounted = account(answer, claudeMdIdsOf(projection));
  const budget = alwaysLoadedBudget(directory, accounted.rows, threshold);
  return { tokens: budget.tokens, overBudget: budget.overBudget };
}

/**
 * The oracle itself: every location the sweep reported, recomputed the naive
 * way, and the two demanded to agree.
 *
 * ⛔ Extracted so a second fixture can be run through the SAME oracle rather
 * than through a copy of it — a copied oracle is one somebody can weaken in one
 * place and leave apparently-covered in the other. It must never be loosened;
 * see the sweep module's docstring, which names it as the reason the collapse is
 * allowed to exist at all.
 *
 * @param projection - The populated projection the sweep ran over
 * @param sweep - The sweep's answer
 * @param threshold - The threshold both sides are measured at
 */
function expectOracleAgreement(
  projection: Projection,
  sweep: BudgetSweep,
  threshold: number,
): void {
  for (const location of sweep.locations) {
    const oracle = budgetTheLongWay(projection, location.directory, threshold);
    expect(oracle, `oracle refused ${JSON.stringify(location.directory)}`).not.toBeNull();
    expect({
      directory: location.directory,
      tokens: location.budget.tokens,
      overBudget: location.budget.overBudget,
    }).toEqual({ directory: location.directory, ...oracle });
  }
}

/** The sweep entry for one directory, asserted to exist before it is read. */
function entryAt(sweep: BudgetSweep, directory: string): LocationBudget {
  const entry = sweep.locations.find((location) => location.directory === directory);
  expect(entry, `no sweep entry for ${JSON.stringify(directory)}`).toBeDefined();
  if (entry === undefined) throw new Error('unreachable — asserted above');
  return entry;
}

/** Every location the sweep reported, in the order it reported them. */
function directoriesOf(sweep: BudgetSweep): string[] {
  return sweep.locations.map((location) => location.directory);
}

/** Each location mapped to the representative the sweep chose for it. */
function representativeOf(sweep: BudgetSweep, directory: string): string {
  return entryAt(sweep, directory).representative;
}

/**
 * Rewrite `gitignored` on the named realization paths.
 *
 * A projection is a plain bag of readonly row arrays, so a variant is a `map`
 * away. Deliberately NOT a second fixture builder: the tree, its tags and its
 * closures all stay exactly what `claudeContextFixture` built, and only the one
 * column under test moves.
 *
 * @param projection - The fixture projection
 * @param paths - Root-relative paths to mark ignored
 * @returns A projection identical but for those rows
 */
function withGitignored(projection: Projection, paths: readonly string[]): Projection {
  const ignored = new Set(paths);
  return {
    ...projection,
    resourceRealizations: projection.resourceRealizations.map((row) =>
      ignored.has(row.path) ? { ...row, gitignored: true } : row),
  };
}

/**
 * Drop one directory's own realization row, leaving the files inside it.
 *
 * That is what makes a representative answer `unknown`: `whatLoadsAt` refuses a
 * path the projection never realized, while the directory is still a working
 * location because its files name it as their `dir`.
 *
 * @param projection - The fixture projection
 * @param directory - The directory realization to remove
 * @returns A projection identical but for that row
 */
function withoutDirectoryRow(projection: Projection, directory: string): Projection {
  return {
    ...projection,
    resourceRealizations: projection.resourceRealizations.filter(
      (row) => !(row.isDirectory && row.path === directory),
    ),
  };
}

describe('sweepAlwaysLoadedBudgets', () => {
  describe('the differential oracle', () => {
    it('agrees with a per-location query on every location, and still collapses', async () => {
      const projection = await claudeContextFixture(TREE);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);

      expect(sweep.locations).toHaveLength(TREE_LOCATIONS.length);
      expectOracleAgreement(projection, sweep, ROOMY);

      // A sweep that degraded to querying every location would still pass every
      // assertion above. This is the one that would fail.
      expect(sweep.queriedDirectories).toBeLessThan(sweep.evaluatedDirectories);
    });

    it('agrees when an unscoped ROOT RULE and its import are part of every chain', async () => {
      const projection = await claudeContextFixture(ROOT_RULE_TREE);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);

      // The fixture is load-bearing only if the rule really is charged. Asserted
      // FIRST: a root rule the budget silently dropped would leave the oracle
      // agreeing about a number that is wrong on both sides.
      const charged = entryAt(sweep, ROOT).budget.contributors.map((row) => row.path);
      expect(charged).toContain(ROOT_RULE);
      expect(charged).toContain(RULE_IMPORT);

      expectOracleAgreement(projection, sweep, ROOMY);
      expect(sweep.queriedDirectories).toBeLessThan(sweep.evaluatedDirectories);
    });

    it('charges an unscoped root rule identically to every group, so it cannot separate one', async () => {
      // The sweep module's soundness argument: a `root-rule` is selected for
      // every query directory alike, so it is a CONSTANT across the tree — and a
      // constant cannot make two groups differ. That is now a claim about a
      // charged row rather than about an excluded one, so it is pinned here.
      const projection = await claudeContextFixture(ROOT_RULE_TREE);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);
      const ruleTokens = (directory: string): number | undefined =>
        entryAt(sweep, directory).budget.contributors.find((row) => row.path === ROOT_RULE)?.tokens;

      expect(ruleTokens(ROOT)).toBeGreaterThan(0);
      expect(ruleTokens(CLI)).toBe(ruleTokens(ROOT));
      expect(ruleTokens(CLI_SRC)).toBe(ruleTokens(ROOT));
    });

    it('agrees at a threshold that puts some locations over budget and others under', async () => {
      const projection = await claudeContextFixture(TREE);
      // Derived, never hardcoded: the root group's own total is the only
      // threshold guaranteed to split this tree, since the CLI group pays
      // everything the root group pays plus its own `CLAUDE.md`.
      const rootTokens = entryAt(sweepAlwaysLoadedBudgets(projection, ROOMY), ROOT).budget.tokens;
      const sweep = sweepAlwaysLoadedBudgets(projection, rootTokens);

      expect(entryAt(sweep, ROOT).budget.overBudget).toBe(false);
      expect(entryAt(sweep, CLI).budget.overBudget).toBe(true);
      for (const location of sweep.locations) {
        expect({
          directory: location.directory,
          overBudget: location.budget.overBudget,
        }).toEqual({
          directory: location.directory,
          overBudget: budgetTheLongWay(projection, location.directory, rootTokens)?.overBudget,
        });
      }
    });
  });

  describe('nearest-ancestor selection', () => {
    it('makes a directory with its own CLAUDE.md its own representative', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(TREE), ROOMY);
      expect(representativeOf(sweep, ROOT)).toBe(ROOT);
      expect(representativeOf(sweep, CLI)).toBe(CLI);
    });

    it('inherits the nearest instructed ancestor for a directory without one', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(TREE), ROOMY);
      expect(representativeOf(sweep, CLI_SRC)).toBe(CLI);
      expect(representativeOf(sweep, 'docs')).toBe(ROOT);
      expect(representativeOf(sweep, 'packages')).toBe(ROOT);
    });

    it('falls back to the corpus root when no ancestor carries a CLAUDE.md', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(ROOTLESS_TREE), ROOMY);
      expect(representativeOf(sweep, 'docs')).toBe(ROOT);
      expect(representativeOf(sweep, 'packages')).toBe(ROOT);
      expect(representativeOf(sweep, CLI)).toBe(CLI);
    });

    it('never lets a name-prefix sibling inherit from packages/cli', async () => {
      const projection = await claudeContextFixture(TREE);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);
      expect(representativeOf(sweep, CLI_X)).toBe(ROOT);
      // And the numbers really differ, so the assertion above is not cosmetic.
      expect(entryAt(sweep, CLI_X).budget.tokens).toBe(entryAt(sweep, ROOT).budget.tokens);
      expect(entryAt(sweep, CLI_X).budget.tokens).not.toBe(entryAt(sweep, CLI).budget.tokens);
    });

    it('reports the location on the entry and the representative beside it', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(TREE), ROOMY);
      const entry = entryAt(sweep, CLI_SRC);
      expect(entry.directory).toBe(CLI_SRC);
      expect(entry.representative).toBe(CLI);
      // 🔑 The nested budget echoes the REPRESENTATIVE, because that is the
      // directory it was computed for. A reader comparing the two fields sees
      // that this location's numbers were borrowed, not measured.
      expect(entry.budget.directory).toBe(CLI);
    });
  });

  describe('gitignored working locations', () => {
    // ⛔ The `includeIgnored` opt-out this pair used to bracket is GONE. Once
    // `buildClaudeContextPopulation` started declining the gitignored half, no
    // real population could produce a `gitignored: true` row, so the option was a
    // switch that could not change any answer — and a switch you can set that
    // proves nothing is worse than no switch. The filter itself stays, as the
    // backstop against the decline predicate and this column drifting apart, and
    // the synthetic fixture below is the only thing that can still exercise it.
    it('excludes a directory whose realizations are all ignored', async () => {
      const projection = withGitignored(await claudeContextFixture(TREE), [UTILS, UTILS_README]);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);
      expect(directoriesOf(sweep)).not.toContain(UTILS);
      expect(sweep.evaluatedDirectories).toBe(TREE_LOCATIONS.length - 1);
    });

    it('still lets an ignored CLAUDE.md set the representative — the harness reads it', async () => {
      const projection = withGitignored(await claudeContextFixture(TREE), [
        'packages/cli/CLAUDE.md',
      ]);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);
      expect(representativeOf(sweep, CLI_SRC)).toBe(CLI);
      expect(entryAt(sweep, CLI_SRC).budget.tokens).toBe(
        budgetTheLongWay(projection, CLI_SRC, ROOMY)?.tokens,
      );
    });
  });

  describe('the counters', () => {
    it('reports two representatives across seven locations for the fixture tree', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(TREE), ROOMY);
      expect(sweep.evaluatedDirectories).toBe(7);
      expect(sweep.queriedDirectories).toBe(2);
      expect(sweep.skippedUnknownLocations).toBe(0);
    });

    it('counts one representative when nothing in the tree is instructed', async () => {
      const sweep = sweepAlwaysLoadedBudgets(
        await claudeContextFixture({ 'docs/guide.md': 'x\n' }),
        ROOMY,
      );
      expect(sweep.queriedDirectories).toBe(1);
      expect(directoriesOf(sweep)).toEqual([ROOT, 'docs']);
    });
  });

  describe('an unknown representative', () => {
    it('omits every location it represents and counts them, reporting no zero', async () => {
      const projection = withoutDirectoryRow(await claudeContextFixture(TREE), CLI);
      const sweep = sweepAlwaysLoadedBudgets(projection, ROOMY);

      expect(whatLoadsAt(projection, CLI).kind).toBe('unknown');
      expect(directoriesOf(sweep)).not.toContain(CLI);
      expect(directoriesOf(sweep)).not.toContain(CLI_SRC);
      expect(sweep.skippedUnknownLocations).toBe(2);
      expect(sweep.evaluatedDirectories).toBe(TREE_LOCATIONS.length);
      expect(sweep.locations).toHaveLength(TREE_LOCATIONS.length - 2);
      // Queried once, not once per location it represents.
      expect(sweep.queriedDirectories).toBe(2);
    });
  });

  describe('ordering', () => {
    it('sorts locations by code point, matching the fixture tree exactly', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(TREE), ROOMY);
      expect(directoriesOf(sweep)).toEqual(TREE_LOCATIONS);
    });

    it('orders `Docs` before `apps`, which localeCompare would not', async () => {
      const sweep = sweepAlwaysLoadedBudgets(await claudeContextFixture(CASED_TREE), ROOMY);
      expect(directoriesOf(sweep)).toEqual([ROOT, 'Docs', 'apps']);
      // The premise, pinned: this pair really does separate the two collations.
      expect('Docs'.localeCompare('apps')).toBeGreaterThan(0);
    });
  });

  it('propagates the threshold validation rather than defaulting it', async () => {
    const projection = await claudeContextFixture(TREE);
    expect(() => sweepAlwaysLoadedBudgets(projection, 0)).toThrow(TypeError);
  });
});
