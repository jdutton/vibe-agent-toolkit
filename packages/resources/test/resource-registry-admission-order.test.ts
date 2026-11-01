/**
 * The ONE order the registry admits files in, whoever enumerated them.
 *
 * First-added-wins on a duplicate id is decided by admission order, so an order
 * owned by one enumerator makes the lanes disagree about which file survives:
 * the walk listed `dup/` before `dup-hyphen/` while the projection listed them
 * the other way round, and two commands over one tree kept different files.
 * The order is the registry's, so it is pinned here, against every route in.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

/** Two spellings of one id: `-` (0x2d) sorts before `/` (0x2f), so this one is first. */
const HYPHEN_DIR = 'dup-hyphen/note.md';
const SLASH_DIR = 'dup/hyphen-note.md';

/** The collisions a registry recorded, root-relative. */
function collisionsOf(registry: ResourceRegistry, root: string): string[][] {
  return registry.getDuplicateIdCollisions().map((collision) => [
    collision.id,
    safePath.relative(root, collision.existingPath),
    safePath.relative(root, collision.conflictingPath),
  ]);
}

describe('ResourceRegistry admission order', () => {
  const suite = setupAsyncTempDirSuite('registry-admission-order');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    root = suite.getTempDir();
    for (const relative of [HYPHEN_DIR, SLASH_DIR, 'z.md']) {
      const absolute = safePath.join(root, relative);
      await mkdir(safePath.join(absolute, '..'), { recursive: true });
      await writeFile(absolute, '# Note\n', 'utf-8');
    }
  });

  it('keeps the code-unit-first path on a duplicate id, whatever order the list arrived in', async () => {
    const forward = new ResourceRegistry({ baseDir: root });
    const reversed = new ResourceRegistry({ baseDir: root });
    const paths = [SLASH_DIR, 'z.md', HYPHEN_DIR].map((relative) => safePath.join(root, relative));

    const admittedForward = await forward.addResources(paths);
    const admittedReversed = await reversed.addResources(paths.toReversed());

    const expected = [['dup-hyphen-note-md', HYPHEN_DIR, SLASH_DIR]];
    expect(collisionsOf(forward, root)).toEqual(expected);
    expect(collisionsOf(reversed, root)).toEqual(expected);
    expect(admittedForward.map((resource) => safePath.relative(root, resource.filePath))).toEqual([HYPHEN_DIR, 'z.md']);
    expect(admittedReversed).toEqual(admittedForward);
  });

  it('admits the walk and a population source in one order, so both keep the same file', async () => {
    const offered = [SLASH_DIR, 'z.md', HYPHEN_DIR];
    const source: ResourcePopulationSource = {
      root,
      enumerate: (enumeratedRoot: string) => Promise.resolve({
        paths: offered.map((relative) => safePath.join(enumeratedRoot, relative)),
        conditions: [],
        outcome: { population: 'derived', stored: 'no-store' },
        extentSource: 'filesystem',
      }),
    };
    const walked = new ResourceRegistry({ baseDir: root });
    const sourced = new ResourceRegistry({ baseDir: root });

    const walk = await walked.crawl({ baseDir: root, outputs: [], unreadable: 'refuse' });
    const projection = await sourced.crawl({ baseDir: root, outputs: [], unreadable: 'refuse', populationSource: source });

    expect(projection.resources.map((resource) => resource.filePath)).toEqual(walk.resources.map((resource) => resource.filePath));
    expect(collisionsOf(sourced, root)).toEqual(collisionsOf(walked, root));
    expect(collisionsOf(walked, root)).toEqual([['dup-hyphen-note-md', HYPHEN_DIR, SLASH_DIR]]);
  });
});
