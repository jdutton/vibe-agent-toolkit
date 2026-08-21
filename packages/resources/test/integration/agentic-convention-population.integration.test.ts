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

import { compareCodeUnits, normalizedTmpdir, resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../../src/projection/contributor.js';
import { AgenticConventionContributor } from '../../src/projection/contributors/agentic-convention.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { CONTENT_PARSING_SKIP, DISCARD_BLOB_POPULATION, populate } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
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

  it('never tags a directory', () => {
    const directories = new Set(
      projection.resourceRealizations.filter((row) => row.isDirectory).map((row) => row.resourceId),
    );
    expect(directories.size).toBeGreaterThan(0);
    const tagged = projection.resourceTags.filter((row) => directories.has(row.resourceId));
    expect(tagged).toEqual([]);
  });
});
