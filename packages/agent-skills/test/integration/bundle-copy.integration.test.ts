/**
 * `copyIntoBundle` touches two trees, so it classifies them apart: the author's file is read
 * first (`source`), then the bundle is written (`destination`, `shapeFromSource`). A write whose
 * LAYOUT the skill's `files:` config made impossible is the skill's; a full disk is not.
 */

import fs from 'node:fs/promises';

import { createSymlink, FS_FAULT_CODE, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { installFaultFs, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { copyIntoBundle } from '../../src/bundle-copy.js';
import { isSkillPackagingInputError } from '../../src/packaging-errors.js';

describe('copyIntoBundle', () => {
  const suite = setupAsyncTempDirSuite('bundle-copy');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  const copied = (subject: string, source: string, target: string): Promise<unknown> =>
    copyIntoBundle(subject, source, tempDir, target).then(() => undefined, (error: unknown) => error);

  /** Refuse the open-for-write of exactly `target` with `errno`; the returned restore lifts it. */
  const refuseWrite = (target: string, errno: 'ENOENT' | 'ENOSPC'): (() => void) => {
    const session = installFaultFs({ within: tempDir, faults: [{ family: 'write', path: (path) => path === target, errno }] });
    return () => session.restore();
  };

  it('codes a bundle layout that cannot exist (a file in the way of a dest directory) as the skill\'s source', async () => {
    const source = safePath.join(tempDir, 'a.md');
    await fs.writeFile(source, '# a');
    await fs.mkdir(safePath.join(tempDir, 'out'));
    await fs.writeFile(safePath.join(tempDir, 'out', 'docs'), 'a file where a directory must go');

    const thrown = await copied("files: entry 'a.md'", source, safePath.join(tempDir, 'out', 'docs', 'a.md'));

    expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content' });
    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("files: entry 'a.md'");
  });

  // Two levels under a dest's FILE: the file is met on the way, where a directory must be — the
  // layout is still impossible, so it is still the skill's, at any depth, and the fault names the file.
  it('codes a dest nested two levels under another dest\'s file as the skill\'s source', async () => {
    const source = safePath.join(tempDir, 'n.md');
    await fs.writeFile(source, '# n');
    await fs.mkdir(safePath.join(tempDir, 'outn'));
    await fs.writeFile(safePath.join(tempDir, 'outn', 'docs'), 'a file where a directory must go');

    const thrown = await copied("files: entry 'n.md'", source, safePath.join(tempDir, 'outn', 'docs', 'sub', 'n.md'));

    expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied', path: safePath.join(tempDir, 'outn', 'docs') });
    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("files: entry 'n.md'");
  });

  // The bundle is made the one way a file is made in a tree VAT builds: never through a link.
  it.for([
    { dest: 'outl/linked.md', link: 'outl/linked.md', type: 'file' },
    { dest: 'outl/linkdir/x.md', link: 'outl/linkdir', type: 'dir' },
  ] as const)('never copies through a link in the bundle ($dest): the skill\'s, naming it, nothing written where it points', async ({ dest, link, type }, { skip }) => {
    const cap = symlinkCapability() ?? skip();
    const source = safePath.join(tempDir, 'l.md');
    await fs.writeFile(source, '# l');
    await fs.mkdir(safePath.join(tempDir, 'outside'));
    await fs.writeFile(safePath.join(tempDir, 'outside', 'victim.md'), 'precious');
    await fs.mkdir(safePath.join(tempDir, 'outl'));
    const pointedAt = type === 'file' ? safePath.join(tempDir, 'outside', 'victim.md') : safePath.join(tempDir, 'outside');
    createSymlink(cap, pointedAt, safePath.join(tempDir, link), type);

    const thrown = await copied("files: entry 'l.md'", source, safePath.join(tempDir, dest));

    expect(thrown, String(thrown)).toMatchObject({ code: FS_FAULT_CODE, side: 'source', origin: 'content', faultClass: 'occupied', path: safePath.join(tempDir, link) });
    expect(await fs.readFile(safePath.join(tempDir, 'outside', 'victim.md'), 'utf-8')).toBe('precious');
    expect(await fs.readdir(safePath.join(tempDir, 'outside'))).toEqual(['victim.md']);
  });

  it('a later copy replaces an earlier one at the same dest', async () => {
    const source = safePath.join(tempDir, 'r.md');
    await fs.writeFile(source, 'later');
    await fs.mkdir(safePath.join(tempDir, 'outr'));
    await fs.writeFile(safePath.join(tempDir, 'outr', 'r.md'), 'earlier');

    await copyIntoBundle("files: entry 'r.md'", source, tempDir, safePath.join(tempDir, 'outr', 'r.md'));

    expect(await fs.readFile(safePath.join(tempDir, 'outr', 'r.md'), 'utf-8')).toBe('later');
  });

  // A vanished output (ENOENT) is not a layout the skill decided: it stays the destination's.
  it('codes an output that vanishes under the write (ENOENT) as the destination\'s', async () => {
    const source = safePath.join(tempDir, 'v.md');
    await fs.writeFile(source, '# v');
    const target = safePath.join(tempDir, 'outv', 'v.md');
    const restore = refuseWrite(target, 'ENOENT');
    try {
      const thrown = await copied("files: entry 'v.md'", source, target);
      expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'absent' });
    } finally {
      restore();
    }
  });

  it('codes a full disk while copying into the bundle as the destination\'s, never the skill\'s', async () => {
    const source = safePath.join(tempDir, 'b.md');
    await fs.writeFile(source, '# b');
    const target = safePath.join(tempDir, 'out2', 'b.md');
    const restore = refuseWrite(target, 'ENOSPC');
    try {
      const thrown = await copied("files: entry 'b.md'", source, target);

      expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'exhausted' });
      expect(isSkillPackagingInputError(thrown)).toBe(false);
    } finally {
      restore();
    }
  });

  it('codes an absent source as the skill\'s, before anything is written', async () => {
    const target = safePath.join(tempDir, 'out3', 'gone.md');

    const thrown = await copied("files: entry 'gone.md'", safePath.join(tempDir, 'gone.md'), target);

    expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'absent' });
    await expect(fs.stat(safePath.join(tempDir, 'out3'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies the file, making the directory it lands in', async () => {
    const source = safePath.join(tempDir, 'c.md');
    await fs.writeFile(source, '# c');

    await copyIntoBundle("files: entry 'c.md'", source, tempDir, safePath.join(tempDir, 'out4', 'deep', 'c.md'));

    expect(await fs.readFile(safePath.join(tempDir, 'out4', 'deep', 'c.md'), 'utf-8')).toBe('# c');
  });
});
