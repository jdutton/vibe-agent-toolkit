/**
 * **`resource_tags` has a producer.** The driver, a real tree, and the rows that
 * come out of it.
 *
 * ## The control comes FIRST, and it is not a formality
 *
 * Every assertion below would pass vacuously against a contributor that
 * returned nothing: "no row says `x`" is trivially true of an empty table, and
 * a suite that only ever asserts absence proves the classifier is *unreachable*
 * just as happily as it proves it is *correct*. That is the state this stage
 * exists to leave — the classifier shipped with 34 green tests measuring a
 * function nothing imported. So the first test pins non-empty, and every later
 * one is read against it.
 *
 * ## The fixture is authored, because the repository cannot supply it
 *
 * VAT has 0 `.claude/agents`, 0 `.claude/commands`, and 7-of-7 rules files as
 * direct children. A census over its own tree therefore agrees with a
 * classifier that is direct-only and plugin-blind — which is exactly how
 * `subagent` and `command` came to fire zero times across 2,168 files while
 * looking correct. Every member below is here because some plausible-wrong
 * classifier disagrees with it.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import {
  compareCodeUnits,
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  resetProjectRootCaches,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyPath, pluginRootsFrom } from '../../src/projection/agentic-tags.js';
import { ContributorRegistry } from '../../src/projection/contributor.js';
import { AgenticConventionContributor } from '../../src/projection/contributors/agentic-convention.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { CONTENT_PARSING_SKIP, DISCARD_BLOB_POPULATION, populate } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import { ProjectionBuilder } from '../../src/projection/projection.js';
import { collectRealization } from '../../src/projection/realizations.js';
import { writeFileIn as plant } from '../test-helpers.js';

/** The contributor id, which is also its `resource_tags.source` and its kind. */
const SOURCE = 'agentic-convention';

/** A nested subagent inside a plugin root — the shape that fired zero times. */
const PLUGIN_SUBAGENT = 'plugins/reviewer/agents/team/security.md';
/** The loading value asserted from several rows below. */
const SELECTED = 'loading=selected';
/** A command under a `src/commands/` directory that no plugin root owns. */
const CLI_COMMAND_DOC = 'packages/cli/src/commands/build.md';
/** A rules file two directories deep — dropped by a direct-containment matcher. */
const NESTED_RULE = '.claude/rules/frontend/style.md';
/** A subagent under a non-root `.claude/` — the monorepo shape with no coverage. */
const NESTED_SUBAGENT = 'apps/web/.claude/agents/reviewer.md';
/**
 * 🪤 A DIRECTORY whose basename classifies.
 *
 * `.claude/rules/**\/*.md` is a path test, and a directory named `notes.md`
 * satisfies it exactly as a file would. Without a member of this shape the
 * `isDirectory` guard in the contributor changes no row, and the test that
 * names it cannot fail — see 'never tags a directory' below.
 */
const RULES_DIR_NAMED_MD = '.claude/rules/notes.md';
/** A real, always-loaded file that a second name also reaches. */
const ALIAS_TARGET = 'docs/CLAUDE.md';
/**
 * A symlink to {@link ALIAS_TARGET}, sited where it classifies `subagent`.
 *
 * One identity, two realizations, two different loading classes — the only
 * shape in which "strongest wins across an identity's realizations" is
 * observable at all.
 */
const ALIAS_SUBAGENT = '.claude/agents/alias.md';

/** Probed once (the helper memoizes); gates both the fixture and the suite. */
const SYMLINK_CAP = symlinkCapability();

let projection: Projection;
let root: string;

/**
 * Every tag row for one root-relative path.
 *
 * @param path - Root-relative path
 * @returns `tag=value` strings, sorted, for the identity that path realizes
 */
function tagsFor(path: string): string[] {
  const realization = projection.resourceRealizations.find((row) => row.path === path);
  if (realization === undefined) throw new Error(`fixture path never realized: ${path}`);
  return projection.resourceTags
    .filter((row) => row.resourceId === realization.resourceId)
    .map((row) => (row.value === null ? row.tag : `${row.tag}=${row.value}`))
    .sort(compareCodeUnits);
}

beforeAll(async () => {
  resetProjectRootCaches();
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-agentic-convention-'));

  plant(root, 'CLAUDE.md', '# root instructions\n');
  plant(root, 'AGENTS.md', '# for other agents\n');
  plant(root, 'README.md', '# readme\n');
  plant(root, '.mcp.json', '{}\n');
  plant(root, NESTED_RULE, '---\npaths:\n  - "src/**"\n---\n# style\n');
  plant(root, NESTED_SUBAGENT, '---\nname: reviewer\n---\n# reviewer\n');
  plant(root, 'plugins/reviewer/.claude-plugin/plugin.json', '{"name":"reviewer"}\n');
  plant(root, PLUGIN_SUBAGENT, '---\nname: security\n---\n# security\n');
  plant(root, 'plugins/reviewer/commands/audit.md', '# audit\n');
  // 🪤 The false positive. 60+ real files sit under this shape in this monorepo.
  plant(root, CLI_COMMAND_DOC, '# build command notes\n');
  plant(root, 'src/index.ts', 'export const x = 1;\n');
  // 🪤 Makes `.claude/rules/notes.md` a DIRECTORY that classifies — see the
  // constant. Planting a child is how the directory comes to exist.
  plant(root, `${RULES_DIR_NAMED_MD}/detail.md`, '# detail\n');
  plant(root, ALIAS_TARGET, '# nested instructions\n');
  if (SYMLINK_CAP !== null) {
    mkdirSyncReal(safePath.join(root, '.claude/agents'), { recursive: true });
    createSymlink(SYMLINK_CAP, safePath.join(root, ALIAS_TARGET), safePath.join(root, ALIAS_SUBAGENT));
  }

  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor(undefined, 'deferred'));
  registry.register(new AgenticConventionContributor());

  projection = await populate({
    root,
    registry,
    contentParsing: CONTENT_PARSING_SKIP,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetProjectRootCaches();
});

describe('the control — rows exist at all', () => {
  it('populates resource_tags, which every later assertion is read against', () => {
    expect(projection.resourceTags.length).toBeGreaterThan(0);
    expect(projection.resourceRealizations.length).toBeGreaterThan(0);
  });

  it('records that the contributor ran', () => {
    // A contributor returning `contexts: []` has its digest computed and thrown
    // away — nothing in zone_provenance says it ran, and the reuse rule cannot
    // see it. This is that hole, pinned shut.
    const provenance = projection.zoneProvenance.filter((row) => row.contributorId === SOURCE);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.extentDigest).toBeTruthy();
  });

  it('declares an extent whose members are exactly the classified resources', () => {
    const extentId = projection.zoneProvenance.find((row) => row.contributorId === SOURCE)?.contextId;
    expect(extentId).toBeDefined();

    const members = new Set(
      projection.resourceExtents.filter((row) => row.extentId === extentId).map((row) => row.resourceId),
    );
    const tagged = new Set(projection.resourceTags.map((row) => row.resourceId));
    expect(members.size).toBeGreaterThan(0);
    expect([...members].sort(compareCodeUnits)).toEqual([...tagged].sort(compareCodeUnits));
  });

  it('contributes no identities and no realizations of its own', () => {
    const extentId = projection.zoneProvenance.find((row) => row.contributorId === SOURCE)?.contextId;
    expect(projection.resourceRealizations.filter((row) => row.extentId === extentId)).toEqual([]);
  });
});

describe('the tags a path carries', () => {
  it.for([
    ['CLAUDE.md', ['claude-md', 'loading=always']],
    // ⛔ No loading row: the import graph decides, not the basename.
    ['AGENTS.md', ['agents-md']],
    // ⛔ No loading row: `paths:` frontmatter decides, and this lane skips parsing.
    [NESTED_RULE, ['rules-file']],
    [NESTED_SUBAGENT, [SELECTED, 'subagent']],
    [PLUGIN_SUBAGENT, [SELECTED, 'subagent']],
    ['plugins/reviewer/commands/audit.md', ['command', SELECTED]],
    ['README.md', ['readme']],
    // ⛔ Located, never charged — the client parses these, so their bytes never
    // reach a context window and no `loading` row can honestly be written.
    ['.mcp.json', ['mcp-config']],
    ['plugins/reviewer/.claude-plugin/plugin.json', ['plugin-manifest']],
  ])('tags %s exactly as %j', ([path, expected]) => {
    expect(tagsFor(path as string)).toEqual(expected);
  });

  it.for([[CLI_COMMAND_DOC], ['src/index.ts']])(
    'leaves %s carrying no convention at all',
    ([path]) => {
      expect(tagsFor(path as string)).toEqual([]);
    },
  );
});

describe('the shape of the table', () => {
  it('attributes every tag to this contributor, and to no extent contributor', () => {
    // `git-extent.ts` states the rule the other five `tags: []` sites follow:
    // "Tags are for classification contributors." If an enumerator ever starts
    // emitting these, the same file classifies differently depending on which
    // enumerator found it.
    const sources = new Set(projection.resourceTags.map((row) => row.source));
    expect([...sources]).toEqual([SOURCE]);
  });

  it('gives each identity at most one loading row', () => {
    // resourceId canonicalises through realpath, so two paths can collapse onto
    // one identity. Two contradictory `loading` rows under one key would make a
    // budget check double-count; the classes are reduced before a row is written.
    const perResource = new Map<string, number>();
    for (const row of projection.resourceTags) {
      if (row.tag !== 'loading') continue;
      perResource.set(row.resourceId, (perResource.get(row.resourceId) ?? 0) + 1);
    }
    expect(perResource.size).toBeGreaterThan(0);
    expect([...perResource.values()].filter((count) => count !== 1)).toEqual([]);
  });

  it('never tags a directory, and the fixture holds one that WOULD classify', () => {
    const directories = projection.resourceRealizations.filter((row) => row.isDirectory);

    // ⛔ The control that makes the guard observable. "Directories exist" is not
    // it: every directory in the predecessor's fixture was named `docs`, `src`
    // or `apps`, so `classifyPath` answered `[]` for all of them and deleting
    // the `isDirectory` guard changed not one row — the assertion below was
    // true either way, which is a test that cannot fail. A directory named
    // `notes.md` under `.claude/rules/` satisfies the `rules-file` path test
    // exactly as a file would, so the guard is the only thing keeping it out.
    const pluginRoots = pluginRootsFrom(projection.resourceRealizations.map((row) => row.path));
    const wouldClassify = directories
      .filter((row) => classifyPath(row.path, row.basenameLower, pluginRoots).length > 0)
      .map((row) => row.path);
    expect(wouldClassify).toContain(RULES_DIR_NAMED_MD);

    const directoryIds = new Set(directories.map((row) => row.resourceId));
    expect(projection.resourceTags.filter((row) => directoryIds.has(row.resourceId))).toEqual([]);
  });
});

/**
 * The invariant the contributor's header devotes a whole section to, and which
 * nothing pinned: **strongest wins across an identity's realizations.**
 *
 * 'gives each identity at most one loading row' above asserts CARDINALITY, and
 * is structurally blind to the VALUE — replacing `strongestLoading(...)` with
 * `loadings[0]` still writes exactly one row per identity, so that test stays
 * green while a budget check under-reports an always-loaded file as `selected`.
 * Distinguishing the two needs ONE identity realized at TWO differently
 * classifying paths.
 *
 * ## ⚠️ Why this drives `contribute` at its seam instead of through `populate`
 *
 * The identity collapse is real **in this fixture** and is measured below with
 * the shipped `ResourceIdentityMap`: `new ProjectionBuilder({ root })` is handed no
 * `GitTracker`, so `canonicalPathFor` never takes its git branch, falls through
 * to `realPathOrSelf`, and a symlink and its target really do mint one id. That
 * is the NON-GIT branch, not the general rule — see *"🪤 A symlink and its target
 * do NOT reliably share one identity"* in `src/projection/identity.ts`. What is
 * NOT real today, in either tracker state, is any shipped enumerator handing that
 * pair to a contributor — measured, both ways:
 *
 * - the **filesystem** extent never realizes a symlink's own path. Its walk
 *   runs `followSymlinks: false`, and its git-snapshot route drops mode
 *   `120000` explicitly (`crawl-source.ts`, "A SYMLINK IS NOT A MEMBER HERE").
 * - the **git** extent does realize one — but only inside a repository, where
 *   `canonicalPathFor` takes git's index path instead of resolving, so the link
 *   and its target mint two ids and never collapse. That is the state
 *   `projection-git-extent-symlink.test.ts` pins as `distinctResourceIds() === 3`.
 *
 * So the reduction guards a shape the current base contributors cannot produce.
 * It is still the contract — `resource_tags` is keyed `(resourceId, tag, value,
 * source)` and cannot hold two contradictory `loading` rows — and the next
 * contributor to realize an aliased path gets it right by construction. Pinning
 * it at the seam is the honest way to say that: the collapse is measured, the
 * enumeration is stipulated.
 *
 * ⚠️ Skipped where the process cannot create symlinks — Windows without
 * Developer Mode — so this does not execute on Windows CI.
 */
describe.skipIf(SYMLINK_CAP === null)('identity collapse — one identity, two loading classes', () => {
  it('reduces the classes with strongest-wins, not with the first realization seen', async () => {
    const builder = new ProjectionBuilder({ root });
    const base = builder.base();
    const absolute = (relativePath: string): string => safePath.join(root, relativePath);

    // The collapse, MEASURED rather than assumed — and the control for
    // everything below. Two ids here and the fixture degenerates into two
    // unrelated identities carrying one class each, where first-wins and
    // strongest-wins agree and the mutation is unobservable.
    const targetId = base.identities.idFor(absolute(ALIAS_TARGET));
    const aliasId = base.identities.idFor(absolute(ALIAS_SUBAGENT));
    expect(aliasId).toBe(targetId);

    // The WEAKER realization first, on purpose: `loadings[0]` must differ from
    // the reduced answer, or the test cannot discriminate. Ordered explicitly
    // rather than inherited from a crawl, so it cannot silently stop doing so.
    const extentId = 'extent-identity-collapse-fixture';
    const realizations = [
      await collectRealization(absolute(ALIAS_SUBAGENT), aliasId, { root, extentId }),
      await collectRealization(absolute(ALIAS_TARGET), targetId, { root, extentId }),
    ];
    expect(realizations.map((row) => row.path)).toEqual([ALIAS_SUBAGENT, ALIAS_TARGET]);

    const contribution = await new AgenticConventionContributor().contribute(
      { ...base, resourceRealizations: realizations },
      null,
    );

    // `subagent`/selected at the link, `claude-md`/always at the target — one
    // row for the union of the tags, one `loading` row, and it says `always`.
    expect(
      contribution.tags
        .map((row) => (row.value === null ? row.tag : `${row.tag}=${row.value}`))
        .sort(compareCodeUnits),
    ).toEqual(['claude-md', 'loading=always', 'subagent']);
  });
});
