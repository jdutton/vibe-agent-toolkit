/**
 * The ONE order the registry admits files in, whoever enumerated them.
 *
 * First-added-wins on a duplicate id is decided by admission order, so an order
 * owned by one enumerator makes the lanes disagree about which file survives:
 * the walk listed `dup/` before `dup-hyphen/` while the projection listed them
 * the other way round, and two commands over one tree kept different files.
 * The order is the registry's, so it is pinned here, against every route in.
 *
 * Its scope is ONE admission batch — one `addResources` call, so one crawl. A
 * file an earlier call admitted keeps its id against a later one; the order
 * never evicts what is already registered.
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResourcePopulationSource } from '../src/projection/resource-population.js';
import { admissionOrder, ResourceRegistry } from '../src/resource-registry.js';

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

describe('admissionOrder', () => {
  // By code unit `B` (0x42) < `Z` (0x5a) < `a` (0x61) < `é` (0xe9); a locale
  // collation interleaves the cases (`a`, `B`, `é`, `Z`).
  it.each([
    ['a.md', 'B.md', 'é.md', 'Z.md'],
    ['Z.md', 'é.md', 'B.md', 'a.md'],
    ['é.md', 'a.md', 'Z.md', 'B.md'],
  ])('is code-unit order, never the locale’s: %j', (...names) => {
    const root = safePath.resolve('/corpus');
    const paths = names.map((name) => safePath.join(root, name));
    expect(admissionOrder(paths).map((path) => safePath.relative(root, path))).toEqual(['B.md', 'Z.md', 'a.md', 'é.md']);
  });
});

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

  it('decides within ONE batch: a file an earlier call admitted keeps its id', async () => {
    const registry = new ResourceRegistry({ baseDir: root });

    await registry.addResources([safePath.join(root, SLASH_DIR)]);
    await registry.addResources([safePath.join(root, HYPHEN_DIR)]);

    // The code-unit-SECOND path holds the id, because it was registered first.
    expect(collisionsOf(registry, root)).toEqual([['dup-hyphen-note-md', SLASH_DIR, HYPHEN_DIR]]);
  });

  it('orders a relative spelling exactly as its absolute form', () => {
    // From a cwd inside the root, SLASH_DIR is reached through `../`, and `.`
    // (0x2e) sorts before `/` (0x2f): compared as written, it would come first.
    // Compared resolved, HYPHEN_DIR does. The cwd is stubbed onto the root's own
    // drive: on Windows the real cwd and the temp dir can sit on different drives,
    // where `relative()` returns an absolute path and the premise is gone.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(safePath.join(root, 'deep'));
    try {
      const relativeSlash = safePath.relative(process.cwd(), safePath.join(root, SLASH_DIR));
      const absoluteHyphen = safePath.join(root, HYPHEN_DIR);
      expect(relativeSlash.startsWith('.')).toBe(true);

      expect(admissionOrder([relativeSlash, absoluteHyphen])).toEqual([absoluteHyphen, relativeSlash]);
    } finally {
      cwd.mockRestore();
    }
  });

  // A backslash is a separator only on Windows; elsewhere it is a filename byte,
  // so the two spellings below would name different files.
  it.runIf(process.platform === 'win32')('orders a backslash spelling exactly as its forward-slash form', () => {
    // Compared as written, the first separator decides: `\` (0x5c) sorts after
    // `/` (0x2f), so the backslash-spelled code-unit-first path would come last.
    const backslashHyphen = toForwardSlash(safePath.join(root, HYPHEN_DIR)).replaceAll('/', '\\');
    const forwardSlash = safePath.join(root, SLASH_DIR);

    expect(admissionOrder([forwardSlash, backslashHyphen])).toEqual([backslashHyphen, forwardSlash]);
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
