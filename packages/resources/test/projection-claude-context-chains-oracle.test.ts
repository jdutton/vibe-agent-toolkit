/**
 * The per-chain collapse behind `claude_context_loads`, and the differential
 * oracle that proves it is not lying.
 *
 * ## Why this suite is fixtured
 *
 * Its whole content is a claim about how `whatLoadsAt` behaves across a TREE —
 * that a directory with no `CLAUDE.md` of its own loads, at launch, exactly what
 * its nearest instructed ancestor loads. Hand-built rows cannot express that
 * claim, because they have already decided the answer the collapse derives.
 *
 * ## The oracle is the point of the file
 *
 * `claudeContextRelations` answers once per CHAIN and maps every working
 * location onto that answer. If that collapse drifts from `whatLoadsAt`, every
 * launch-cost sum over the relation goes silently wrong. So every location the
 * chain relation names is recomputed the long way (`whatLoadsAt` → `account`,
 * one query per location, no collapse) and the charged rows must agree — and
 * the charged SUM must equal `account`'s own `alwaysTokens`, which is the number
 * `vat claude context` prints. That second equality is the contract the
 * `launchCharge` column documents.
 *
 * ⛔ The oracle lives in ONE function ({@link expectOracleAgreement}) every
 * fixture runs through, never copied per fixture.
 *
 * ## Three things that look like they should break the collapse, and do not
 *
 * - **An unscoped root rule.** `baseLoadClass` classes it `always`, so it is
 *   charged — and it is selected for every query directory alike, so it is a
 *   CONSTANT across the tree, as is its import closure. A constant cannot
 *   separate two groups. {@link ROOT_RULE_TREE} is the only place this is
 *   exercised: all of VAT's own rules files carry `paths:`.
 * - **The root's second project location.** `claudeAncestry` admits
 *   `.claude/CLAUDE.md` for every directory — constant again.
 * - **An ignored `CLAUDE.md`.** The context population declines the ignored
 *   half outright, so none arrives; the region filter is the backstop.
 *
 * ⚠️ The collapse is exact for the ALWAYS half only. Path-scoped rules vary per
 * directory, so the oracle compares charged rows, never `not-always` ones — the
 * `chain-on-demand-is-representative` stated limit says the same to a reader.
 */

import { describe, expect, it } from 'vitest';

import { account } from '../src/projection/claude-context-accounting.js';
import { launchCharge } from '../src/projection/claude-context-launch-charge.js';
import { whatLoadsAt } from '../src/projection/claude-context-query.js';
import { claudeContextRelations, contextChainId } from '../src/projection/claude-context-relations.js';
import type { Projection } from '../src/projection/projection.js';
import type { ClaudeContextLoadRow } from '../src/schemas/projection-claude-context.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

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

/** `UTILS`'s only file — ignoring both is what removes the directory from the relation. */
const UTILS_README = `${UTILS}/README.md`;

/**
 * A tree with two instructed directories, one `@` import, and a sibling that
 * merely shares a name prefix with an instructed directory.
 *
 * The import matters: `docs/handbook.md` is admitted only through the root
 * `CLAUDE.md`'s closure, so it is charged to every location in the root group
 * and to `CLI`'s group as well. A fixture without one would leave the collapse's
 * import half untested.
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

/** Every working location `TREE` produces, in the order the chain relation must report them. */
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
 * files carry `paths:`, so every one is `glob-rule` and none is `root-rule`. No
 * fixture derived from this corpus can reach it.
 *
 * The rule also `@`-imports, because a rules file is itself an import root and
 * both its own bytes and its import's must be charged.
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
 * A tree whose root `CLAUDE.md` imports a file that imports another — the
 * second-hop row a since-deleted threshold used to decline, and the harness
 * loads.
 */
const DEEP_IMPORT_TREE: Record<string, string> = {
  'CLAUDE.md': '@docs/one.md\n\nRoot instructions.\n',
  'docs/one.md': '@two.md\n\nOne hop from the root.\n',
  'docs/two.md': 'Two hops from the root, and still loaded at launch.\n',
  'packages/app/notes.md': 'An ordinary file, so packages/app is a location.\n',
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

/** One side of the oracle: what a location pays at launch. */
interface LaunchCost {
  readonly charged: readonly string[];
  readonly unknown: readonly string[];
  readonly tokens: number;
}

/**
 * The paths among some rows that carry one launch charge, sorted.
 *
 * @param rows - Rows with a path and a charge
 * @param charge - The charge to select
 * @returns The matching paths
 */
function pathsCharged(
  rows: ReadonlyArray<{ readonly path: string; readonly charge: string }>,
  charge: string,
): string[] {
  return rows
    .filter((row) => row.charge === charge)
    .map((row) => row.path)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * The INDEPENDENT launch cost of one location — one query, no collapse.
 *
 * @param projection - The populated projection
 * @param directory - The working location
 * @returns Its charged and unsized paths, and `account`'s own `alwaysTokens`
 */
function costTheLongWay(projection: Projection, directory: string): LaunchCost {
  const answer = whatLoadsAt(projection, directory);
  expect(answer.kind, `oracle refused ${JSON.stringify(directory)}`).toBe('answer');
  if (answer.kind !== 'answer') throw new Error('unreachable — asserted above');
  const accounted = account(answer);
  const rows = accounted.rows.map((row) => ({ path: row.path, charge: launchCharge(row) }));
  return {
    charged: pathsCharged(rows, 'charged'),
    unknown: pathsCharged(rows, 'unknown-size'),
    tokens: accounted.totals.alwaysTokens,
  };
}

/**
 * The same cost read off the relation, the way a statement would.
 *
 * @param loads - Every `claude_context_loads` row
 * @param chainId - The chain the location maps to
 * @returns Its charged and unsized paths, and the charged token sum
 */
function costFromRelation(loads: readonly ClaudeContextLoadRow[], chainId: string): LaunchCost {
  const rows = loads.filter((row) => row.chainId === chainId);
  const charges = rows.map((row) => ({ path: row.path, charge: row.launchCharge }));
  return {
    charged: pathsCharged(charges, 'charged'),
    unknown: pathsCharged(charges, 'unknown-size'),
    tokens: rows
      .filter((row) => row.launchCharge === 'charged')
      .reduce((sum, row) => sum + (row.tokens ?? 0), 0),
  };
}

/**
 * The oracle itself: every location the chain relation names, recomputed the
 * long way, and the two demanded to agree. ⛔ Never loosen it.
 *
 * @param projection - The populated projection
 * @returns The locations it checked, so a caller can assert on the coverage
 */
function expectOracleAgreement(projection: Projection): readonly string[] {
  const { claudeContextChains, claudeContextLoads } = claudeContextRelations(projection);
  expect(claudeContextChains.length).toBeGreaterThan(0);
  for (const { directory, chainId } of claudeContextChains) {
    expect({ directory, ...costFromRelation(claudeContextLoads, chainId) })
      .toEqual({ directory, ...costTheLongWay(projection, directory) });
  }
  // A collapse that degraded to one chain per location would still agree. This
  // is the assertion that would fail.
  const chains = new Set(claudeContextChains.map((row) => row.chainId));
  expect(chains.size).toBeLessThan(claudeContextChains.length);
  return claudeContextChains.map((row) => row.directory);
}

/**
 * The charged tokens of one path in one location's chain.
 *
 * @param projection - The populated projection
 * @param directory - The working location
 * @param path - The loaded file
 * @returns Its tokens, or undefined when it is not charged there
 */
function chargedTokensAt(projection: Projection, directory: string, path: string): number | null | undefined {
  const { claudeContextChains, claudeContextLoads } = claudeContextRelations(projection);
  const chainId = claudeContextChains.find((row) => row.directory === directory)?.chainId;
  return claudeContextLoads.find(
    (row) => row.chainId === chainId && row.path === path && row.launchCharge === 'charged',
  )?.tokens;
}

/**
 * Every location the chain relation maps, in the order it reports them.
 *
 * @param projection - The populated projection
 * @returns The directories
 */
function locationsOf(projection: Projection): string[] {
  return claudeContextRelations(projection).claudeContextChains.map((row) => row.directory);
}

/**
 * The representative the chain relation maps one location to.
 *
 * @param projection - The populated projection
 * @param directory - The working location
 * @returns Its representative, or undefined when it is not mapped
 */
function representativeOf(projection: Projection, directory: string): string | undefined {
  return claudeContextRelations(projection).claudeContextChains
    .find((row) => row.directory === directory)?.representative;
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

describe('claudeContextRelations — the per-chain collapse', () => {
  describe('the differential oracle', () => {
    it('agrees with a per-location query on every location, and still collapses', async () => {
      const locations = expectOracleAgreement(await claudeContextFixture(TREE));
      // Chain-major order, so compared as a set: every location, exactly once.
      expect(locations).toHaveLength(TREE_LOCATIONS.length);
      expect(new Set(locations)).toEqual(new Set(TREE_LOCATIONS));
    });

    it('agrees when an unscoped ROOT RULE and its import are part of every chain', async () => {
      const projection = await claudeContextFixture(ROOT_RULE_TREE);
      // Load-bearing only if the rule really is charged: a rule dropped on both
      // sides would leave the oracle agreeing about a number that is wrong.
      expect(chargedTokensAt(projection, ROOT, ROOT_RULE)).toBeGreaterThan(0);
      expect(chargedTokensAt(projection, ROOT, RULE_IMPORT)).toBeGreaterThan(0);
      expectOracleAgreement(projection);
    });

    it('charges an unscoped root rule identically to every group, so it cannot separate one', async () => {
      const projection = await claudeContextFixture(ROOT_RULE_TREE);
      const rootTokens = chargedTokensAt(projection, ROOT, ROOT_RULE);
      expect(rootTokens).toBeGreaterThan(0);
      expect(chargedTokensAt(projection, CLI, ROOT_RULE)).toBe(rootTokens);
      expect(chargedTokensAt(projection, CLI_SRC, ROOT_RULE)).toBe(rootTokens);
    });

    it('charges an import two hops down, and still equals the context total', async () => {
      const projection = await claudeContextFixture(DEEP_IMPORT_TREE);
      expect(chargedTokensAt(projection, ROOT, 'docs/two.md')).toBeGreaterThan(0);
      expectOracleAgreement(projection);
    });

    it('agrees when part of a chain has no measurable size', async () => {
      const projection = await claudeContextFixture(TREE, { deferred: ['packages/cli/CLAUDE.md'] });
      const { unknown } = costFromRelation(
        claudeContextRelations(projection).claudeContextLoads,
        contextChainId(CLI),
      );
      expect(unknown).toContain('packages/cli/CLAUDE.md');
      expectOracleAgreement(projection);
    });
  });

  describe('nearest-ancestor selection', () => {
    it('inherits the nearest instructed ancestor for a directory without one', async () => {
      const projection = await claudeContextFixture(TREE);
      expect(representativeOf(projection, CLI)).toBe(CLI);
      expect(representativeOf(projection, CLI_SRC)).toBe(CLI);
      expect(representativeOf(projection, 'docs')).toBe(ROOT);
    });

    it('falls back to the corpus root when no ancestor carries a CLAUDE.md', async () => {
      const projection = await claudeContextFixture(ROOTLESS_TREE);
      expect(representativeOf(projection, 'docs')).toBe(ROOT);
      expect(representativeOf(projection, CLI)).toBe(CLI);
    });

    it('never lets a name-prefix sibling inherit from packages/cli', async () => {
      const projection = await claudeContextFixture(TREE);
      expect(representativeOf(projection, CLI_X)).toBe(ROOT);
      expect(chargedTokensAt(projection, CLI_X, 'packages/cli/CLAUDE.md')).toBeUndefined();
      expect(chargedTokensAt(projection, CLI, 'packages/cli/CLAUDE.md')).toBeGreaterThan(0);
    });
  });

  describe('ignored working locations', () => {
    it('excludes a directory whose realizations are all ignored', async () => {
      const projection = withGitignored(await claudeContextFixture(TREE), [UTILS, UTILS_README]);
      expect(locationsOf(projection)).not.toContain(UTILS);
      expect(locationsOf(projection)).toHaveLength(TREE_LOCATIONS.length - 1);
    });

    it('still lets an ignored CLAUDE.md set the representative — the harness reads it', async () => {
      const projection = withGitignored(await claudeContextFixture(TREE), ['packages/cli/CLAUDE.md']);
      expect(representativeOf(projection, CLI_SRC)).toBe(CLI);
      const { claudeContextLoads } = claudeContextRelations(projection);
      expect(costFromRelation(claudeContextLoads, contextChainId(CLI)).tokens)
        .toBe(costTheLongWay(projection, CLI_SRC).tokens);
    });
  });

  describe('an unknown representative', () => {
    it('omits every location it represents, reporting no zero', async () => {
      const projection = withoutDirectoryRow(await claudeContextFixture(TREE), CLI);
      expect(whatLoadsAt(projection, CLI).kind).toBe('unknown');
      const locations = locationsOf(projection);
      expect(locations).not.toContain(CLI);
      expect(locations).not.toContain(CLI_SRC);
      expect(locations).toHaveLength(TREE_LOCATIONS.length - 2);
    });
  });

  describe('ordering', () => {
    it('orders `Docs` before `apps`, which localeCompare would not', async () => {
      expect(locationsOf(await claudeContextFixture(CASED_TREE))).toEqual([ROOT, 'Docs', 'apps']);
      expect('Docs'.localeCompare('apps')).toBeGreaterThan(0);
    });
  });
});
