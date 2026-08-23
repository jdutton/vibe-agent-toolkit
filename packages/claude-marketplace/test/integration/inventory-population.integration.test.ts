/**
 * The projection lane, driven through the REAL extractor — `populate()`'s first
 * production caller, held against the walk it stands in for.
 *
 * `inventory-extent-corpus.integration.test.ts` already proves the DECLARATION
 * selects the same files as `walkLinkGraph`, exhaustively, on real corpora with a
 * negative control. This file proves the other half, which that one cannot reach:
 * the plumbing between a populated projection and `files.linked` — building one
 * population for N skills, indexing extent to membership, converting the
 * projection's root-relative coordinates back to the absolute paths the extractor
 * publishes, dropping the skill's own path (a member of its own extent, never a
 * member of `linked`), and falling back rather than answering when the population
 * cannot serve the question.
 *
 * Both arms run through `extractClaudePluginInventory`, so what is compared is the
 * output an adopter sees, not an intermediate.
 *
 * ## Why the fixture carries refusals it "does not need"
 *
 * A fixture of two plain markdown links would agree under almost any bug —
 * including an index that returned every file under the root, or one that matched
 * the wrong extent. Each skill therefore links to one file that must be admitted
 * (transitively, so depth is exercised) and four that must be refused for four
 * different reasons. An arm that dropped the cascade, or crossed two skills'
 * extents, produces a different set.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  NO_GIT_TRACKER,
  buildInventoryPopulation,
  extractClaudePluginInventory,
  type InventoryPopulation,
} from '@vibe-agent-toolkit/claude-marketplace';
import { DISCARD_BLOB_POPULATION } from '@vibe-agent-toolkit/resources';
import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;

/**
 * Write a file under the fixture root.
 *
 * One disable comment for the whole file instead of one per call site: every path
 * this test writes is composed under its own `mkdtemp` root, so the rule's
 * concern does not apply, and eleven copies of the same justification would be
 * eleven places for it to stop being true.
 *
 * @param path - Absolute path under the fixture root
 * @param contents - What to write
 */
function write(path: string, contents: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under this test's own mkdtemp root
  writeFileSync(path, contents, 'utf8');
}

/** Order by UTF-16 code unit — locale-independent, so a sort cannot vary by machine. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Absolute path of a skill's SKILL.md within the fixture. */
function skillMd(name: string): string {
  return safePath.join(root, 'skills', name, 'SKILL.md');
}

/**
 * Write one skill whose link graph exercises the cascade.
 *
 * `notes.md` is admitted and links on to `deep.md`, so membership is transitive
 * rather than one hop. The other four links are each refused for a different
 * reason: a navigation basename, an agent-instruction basename, a directory
 * target, and a link into another skill's tree that resolves to a nav file there.
 *
 * @param name - The skill's directory name
 */
function writeSkill(name: string): void {
  const dir = safePath.join(root, 'skills', name);
  mkdirSyncReal(safePath.join(dir, 'sub'), { recursive: true });
  write(safePath.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture skill ${name} for the population lane.\n---\n\n`
      + `- [notes](./notes.md)\n- [readme](./README.md)\n- [agents](./CLAUDE.md)\n`
      + `- [a directory](./sub)\n`,
  );
  write(safePath.join(dir, 'notes.md'), `# Notes\n\n[deeper](./deep.md)\n`);
  write(safePath.join(dir, 'deep.md'), `# Deep\n`);
  write(safePath.join(dir, 'README.md'), `# Nav\n`);
  write(safePath.join(dir, 'CLAUDE.md'), `# Agent instructions\n`);
  write(safePath.join(dir, 'sub', 'inside.md'), `# Inside a directory\n`);
}

beforeAll(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inventory-population-'));

  // ⚠️ LOAD-BEARING, and its absence made this file's headline assertion vacuous.
  // The extractor derives each skill's root as
  // `findProjectRoot(dirname(skillMd)) ?? dirname(skillMd)`. With no project
  // marker anywhere above the fixture, `findProjectRoot` returns null and that
  // fallback is the SKILL'S OWN DIRECTORY — which never equals the population's
  // root, so the exact-root guard rejected the population and both "arms" were
  // the incumbent walk comparing itself. The parity test passed, and passed just
  // as happily with the projection lane broken. One config file is what makes
  // `findProjectRoot` answer `root`, and the two arms actually differ in which
  // code runs.
  write(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');

  mkdirSyncReal(safePath.join(root, '.claude-plugin'), { recursive: true });
  write(safePath.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '0.0.0' }),
  );
  writeSkill('alpha');
  writeSkill('beta');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run the plugin extractor on the fixture, optionally through the projection.
 *
 * `NO_GIT_TRACKER` on both arms, deliberately. The fixture is not a git
 * repository, so a tracker would be unavailable anyway — but saying so out loud
 * keeps the two arms in the SAME tracker state, which is the state the corpus test
 * shows they agree in on a corpus with no gitignored targets. A run that let one
 * arm find a tracker and the other not would be comparing two questions.
 *
 * @param population - The population lane, or undefined for the incumbent walk
 * @returns Each skill's linked files, root-relative and sorted, by skill name
 */
async function linkedBySkill(
  population: InventoryPopulation | undefined,
): Promise<Record<string, string[]>> {
  const inventory = await extractClaudePluginInventory(root, {
    gitTrackerSource: NO_GIT_TRACKER,
    ...(population !== undefined && { sharedPopulation: async () => population }),
  });

  const out: Record<string, string[]> = {};
  for (const skill of inventory.discovered.skills) {
    out[skill.manifest.name] = skill.files.linked
      .map((path) => toForwardSlash(safePath.relative(root, path)))
      .sort(byCodeUnit);
  }
  return out;
}

/** The population every projection-arm case reads from. */
async function populationForFixture(): Promise<InventoryPopulation> {
  return buildInventoryPopulation({
    root,
    skillMdPaths: [skillMd('alpha'), skillMd('beta')],
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });
}

describe('vat inventory: the projection lane answers what the walk answers', () => {
  it('produces byte-identical membership for every skill', async () => {
    const walker = await linkedBySkill(undefined);
    const projected = await linkedBySkill(await populationForFixture());

    // Asserted against the walker rather than against a literal: the walk is the
    // incumbent and the definition of correct here, so a fixture change that moves
    // both arms together must not need this test edited to keep passing.
    expect(projected).toEqual(walker);
  });

  it('admits the transitive link and refuses all four others', async () => {
    // Pins that the shared expectation above is not two identical WRONG answers.
    // Without this, an index returning nothing for every skill would satisfy the
    // equality and report a green parity.
    const walker = await linkedBySkill(undefined);

    expect(walker['alpha']).toEqual(['skills/alpha/deep.md', 'skills/alpha/notes.md']);
    expect(walker['beta']).toEqual(['skills/beta/deep.md', 'skills/beta/notes.md']);
  });

  it('never lists the skill itself, which IS a member of its own extent', async () => {
    // `closureFrom` is a member of the extent it roots; `collectLinkedFiles` never
    // lists the file it walked from. The index drops it, and this is the assertion
    // that fails if that ever stops happening.
    const population = await populationForFixture();

    expect(population.membersOf(skillMd('alpha'))).not.toContain(skillMd('alpha'));
    expect(population.membersOf(skillMd('alpha'))?.length).toBeGreaterThan(0);
  });
});

describe('vat inventory: a population that cannot serve the question defers to the walk', () => {
  it('falls back when the population is rooted somewhere else', async () => {
    // Exact-root equality, not ancestry. A population rooted elsewhere holds
    // extents keyed to different relative paths, so honouring it would answer a
    // different question with complete confidence.
    //
    // ⚠️ Its `membersOf` must return a WRONG answer, not a delegated right one.
    // Delegating to a correctly-rooted population makes this test pass whether or
    // not the guard exists — the fixture could not distinguish the two, which is
    // the same defect that made this file's parity assertion vacuous. Answering
    // `[]` is what makes dropping the guard observable.
    const misrooted: InventoryPopulation = {
      root: safePath.join(root, 'skills'),
      membersOf: () => [],
    };

    expect(await linkedBySkill(misrooted)).toEqual(await linkedBySkill(undefined));
  });

  it('falls back for a skill the population has no extent for', async () => {
    // The stale-list case: a skill added since the population was built. An empty
    // membership would be a confident wrong answer, so `membersOf` returns
    // undefined and the walk runs — for that skill only.
    const partial = await buildInventoryPopulation({
      root,
      skillMdPaths: [skillMd('alpha')],
      onBlobPopulation: DISCARD_BLOB_POPULATION,
    });

    expect(partial.membersOf(skillMd('beta'))).toBeUndefined();
    expect(await linkedBySkill(partial)).toEqual(await linkedBySkill(undefined));
  });

  it('distinguishes "no extent" from "an extent with nothing in it"', async () => {
    // The two must never collapse to the same value: one means fall back, the
    // other means the skill genuinely links to nothing. A fixture skill with no
    // links proves the empty ARRAY is reachable, so `undefined` above is carrying
    // real information rather than being the only value the index ever produces.
    const bare = safePath.join(root, 'skills', 'bare');
    mkdirSyncReal(bare, { recursive: true });
    write(safePath.join(bare, 'SKILL.md'),
      `---\nname: bare\ndescription: A fixture skill that links to nothing at all.\n---\n\nNo links.\n`,
    );

    const population = await buildInventoryPopulation({
      root,
      skillMdPaths: [safePath.join(bare, 'SKILL.md')],
      onBlobPopulation: DISCARD_BLOB_POPULATION,
    });

    expect(population.membersOf(safePath.join(bare, 'SKILL.md'))).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});
