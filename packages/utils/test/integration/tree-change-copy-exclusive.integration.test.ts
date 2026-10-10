/**
 * `copyTree` never adopts, and never writes through, an entry already standing at a name it is
 * about to create (ruling R3). A copy that did wrote a file THROUGH a link it had just preserved —
 * two source names that are one name where the copy goes (letter case, Unicode form) — so an
 * installed skill overwrote files outside its destination, exit 0.
 *
 * A real alias needs a case-sensitive source and a case-folding destination, which no single
 * temp directory offers. So the two-names case is driven through the copy's own visitor with the
 * two entries named by hand: for real where the temp directory folds case, and — on every host —
 * with the collision's `EEXIST` injected at the second create.
 */

import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FS_FAULT_CODE } from '../../src/errors/fs-fault.js';
import { safePath } from '../../src/path-core.js';
import { createSymlinkAsync, symlinkCapability } from '../../src/test-helpers.js';
import { installFaultFs, type FaultFsSession } from '../../src/testing/fault-fs.js';
import { tmpdirFoldsCase } from '../../src/testing/platform-gates.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';
import { copyTree, copyVisitor } from '../../src/tree-change/copy-tree.js';

const scratch = tempDirTracker('tree-change-copy-exclusive-');
let session: FaultFsSession | undefined;
let root = '';

beforeEach(() => {
  root = scratch.create();
  // The merge mode removes entries: this suite's temp directory is its own scratch, never the real one.
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, root);
});
afterEach(() => {
  session?.restore();
  session = undefined;
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

const FRESH = { links: 'preserve', side: 'source', onto: 'fresh' } as const;
const MERGE = { links: 'preserve', side: 'source', onto: 'merge' } as const;
const SKIP_NO_LINKS = 'host cannot create symlinks';
const VICTIM_BYTES = 'the user\'s own file';

const at = (...segments: string[]): string => safePath.join(root, ...segments);
const rejectionOf = (work: () => Promise<unknown>): Promise<unknown> => work().then(() => undefined, (error: unknown) => error);

/** `src/` holding `<name>` (the copy's bytes), and a victim file outside both trees. */
async function sourceWith(name: string): Promise<{ src: string; dest: string; victim: string }> {
  await fs.mkdir(at('src'));
  await fs.writeFile(at('src', name), 'the copy\'s bytes');
  await fs.writeFile(at('victim.txt'), VICTIM_BYTES);
  return { src: at('src'), dest: at('dest'), victim: at('victim.txt') };
}

describe.each([FRESH, MERGE])('copyTree onto: $onto — never through a link already at a name it creates', (options) => {
  it('does not write a file through a link standing where the file goes', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    const { src, dest, victim } = await sourceWith('notes');
    await fs.mkdir(dest);
    await createSymlinkAsync(cap, victim, safePath.join(dest, 'notes'));

    const failure = await rejectionOf(() => copyTree(src, dest, options));

    expect(await fs.readFile(victim, 'utf-8')).toBe(VICTIM_BYTES);
    // A fresh tree refuses what is there; a merge replaces the LINK with the file, never its target.
    if (options.onto === 'fresh') expect(failure).toMatchObject({ code: 'EEXIST' });
    else expect((await fs.lstat(safePath.join(dest, 'notes'))).isFile()).toBe(true);
  });

  it('does not fill a directory through a link standing where the directory goes', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip(SKIP_NO_LINKS);
    await fs.mkdir(at('src', 'data'), { recursive: true });
    await fs.writeFile(at('src', 'data', 'planted.txt'), 'planted');
    await fs.mkdir(at('victimdir'));
    await fs.mkdir(at('dest'));
    await createSymlinkAsync(cap, at('victimdir'), at('dest', 'data'));

    const failure = await rejectionOf(() => copyTree(at('src'), at('dest'), options));

    expect(failure).toMatchObject({ code: 'EEXIST' });
    expect(await fs.readdir(at('victimdir'))).toEqual([]);
  });
});

describe('copyTree onto: fresh / merge — what is already there', () => {
  it('fresh refuses a file and a directory already at a name, leaving both as they were', async () => {
    const { src, dest } = await sourceWith('notes');
    await fs.mkdir(dest);
    await fs.writeFile(safePath.join(dest, 'notes'), 'already there');

    expect(await rejectionOf(() => copyTree(src, dest, FRESH))).toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(safePath.join(dest, 'notes'), 'utf-8')).toBe('already there');
  });

  it('merge replaces a file already there and adopts a real directory (a build output written again)', async () => {
    const { src, dest } = await sourceWith('notes');
    await fs.mkdir(at('src', 'sub'));
    await fs.writeFile(at('src', 'sub', 'a.md'), 'new');
    await fs.mkdir(safePath.join(dest, 'sub'), { recursive: true });
    await fs.writeFile(safePath.join(dest, 'notes'), 'old');
    await fs.writeFile(safePath.join(dest, 'sub', 'kept.md'), 'kept');

    await copyTree(src, dest, MERGE);

    expect(await fs.readFile(safePath.join(dest, 'notes'), 'utf-8')).toBe('the copy\'s bytes');
    expect(await fs.readFile(safePath.join(dest, 'sub', 'a.md'), 'utf-8')).toBe('new');
    expect(await fs.readFile(safePath.join(dest, 'sub', 'kept.md'), 'utf-8')).toBe('kept');
  });
});

// N3: only where case is NOT folded can a tree hold both names — and there a rebuild met the first
// build's `readme.md` at the second create and refused the pair as one name, on every build but the first.
describe('copyTree onto: merge — two names that differ only in case, on a tree that keeps them apart', () => {
  it.skipIf(tmpdirFoldsCase())('copies both, and copies both again over its own output (a rebuild)', async () => {
    await fs.mkdir(at('src'));
    await fs.writeFile(at('src', 'README.md'), 'upper');
    await fs.writeFile(at('src', 'readme.md'), 'lower');

    await copyTree(at('src'), at('dest'), MERGE);
    await fs.writeFile(at('src', 'readme.md'), 'lower, edited');
    await copyTree(at('src'), at('dest'), MERGE);

    expect(await fs.readFile(at('dest', 'README.md'), 'utf-8')).toBe('upper');
    expect(await fs.readFile(at('dest', 'readme.md'), 'utf-8')).toBe('lower, edited');
  });
});

/** Hand the copy's visitor a preserved link `NOTES` and then a regular file `notes`: two source entries, one name where the copy folds case. */
async function copyTwoNames(onto: 'fresh' | 'merge'): Promise<{ failure: unknown; victim: string; link: string; file: string }> {
  const cap = symlinkCapability();
  if (cap === null) throw new Error(SKIP_NO_LINKS);
  await fs.mkdir(at('src'));
  await fs.writeFile(at('victim.txt'), VICTIM_BYTES);
  await fs.mkdir(at('dest'));
  // Stored under names of their own, so the source exists on a case-folding host too.
  const link = at('src', 'link-entry');
  const file = at('src', 'file-entry');
  await createSymlinkAsync(cap, at('victim.txt'), link);
  await fs.writeFile(file, 'the copy\'s bytes');
  const visitor = copyVisitor(at('dest'), 'source', onto);
  const handle = await fs.open(file, 'r');
  try {
    const failure = await rejectionOf(async () => {
      await visitor.link({ path: link, relative: 'NOTES' });
      await visitor.file({ path: file, relative: 'notes' }, handle, await handle.stat());
    });
    return { failure, victim: at('victim.txt'), link, file };
  } finally {
    await handle.close();
  }
}

describe.each(['fresh', 'merge'] as const)('copyTree onto: %s — two source names that are one name where the copy goes', (onto) => {
  const expectAliasRefusal = async ({ failure, victim, link, file }: Awaited<ReturnType<typeof copyTwoNames>>): Promise<void> => {
    expect(failure, String(failure)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied', path: file });
    // BOTH source names, so the author can find the pair.
    expect(String(failure)).toContain(link);
    expect(String(failure)).toContain(file);
    expect(await fs.readFile(victim, 'utf-8')).toBe(VICTIM_BYTES);
  };

  // Only a case-folding temp directory makes `NOTES` and `notes` one entry for real; the next test
  // injects that collision's EEXIST, so the same refusal is pinned on a case-sensitive host.
  it.skipIf(!tmpdirFoldsCase())('refuses the pair as the source\'s layout, by the entry\'s identity, on a filesystem that folds case', async ({ skip }) => {
    if (symlinkCapability() === null) skip(SKIP_NO_LINKS);
    await expectAliasRefusal(await copyTwoNames(onto));
  });

  it('refuses the pair as the source\'s layout when the second create answers EEXIST (the alias, simulated on every host)', async ({ skip }) => {
    if (symlinkCapability() === null) skip(SKIP_NO_LINKS);
    const collided = at('dest', 'notes');
    session = installFaultFs({ within: root, faults: [{ op: 'open', family: 'write', path: (p) => p === collided, errno: 'EEXIST' }] });

    const outcome = await copyTwoNames(onto);

    expect(session.fired.map((call) => call.path)).toEqual([collided]);
    session.restore();
    await expectAliasRefusal(outcome);
  });
});
