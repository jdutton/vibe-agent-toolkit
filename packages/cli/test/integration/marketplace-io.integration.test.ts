/**
 * The marketplace build's copies, classified by the tree each step touches: a source
 * the OS will not read is the build's INPUT (a `source` fault, `INPUT_UNREADABLE`), a
 * write it refuses — a full disk — is the run stopping (`RUN_INCOMPLETE`). Neither is
 * `INTERNAL_ERROR`. Refusals are injected (`installFaultFs` for the read proof's
 * non-blocking open, `refuseSyncFs` / `refuseAsyncFs` for the writes), so every
 * platform and root reaches both sides.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { installFaultFs, refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { copyFileIntoMarketplace, copyTreeIntoMarketplace } from '../../src/utils/marketplace-io.js';

/** Fail the read proof's open of exactly `path` with `EACCES`; the returned restore lifts it. */
function refuseOpen(root: string, path: string): () => void {
  const session = installFaultFs({ within: root, faults: [{ family: 'read', op: 'open', path: (p) => p === path, errno: 'EACCES' }] });
  return () => session.restore();
}

/** The refusal `work` ends with, as the command would publish it. */
async function refusalOf(work: () => Promise<void>): Promise<{ code: string; message: string; side: unknown }> {
  try {
    await work();
  } catch (error) {
    return { code: refusalCodeOf(error), message: (error as Error).message, side: (error as { side?: unknown }).side };
  }
  throw new Error('expected the copy to be refused');
}

describe('marketplace copies', () => {
  let root: string;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-mp-io-'));
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('codes an unreadable source file as the build\'s input, naming it, and writes nothing', async () => {
    const source = safePath.join(root, 'LICENSE');
    writeFileSync(source, 'MIT\n');
    const target = safePath.join(root, 'out', 'LICENSE');
    restore = refuseOpen(root, source);

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, { root, relative: 'out/LICENSE' }, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source', message: expect.stringContaining('Could not read LICENSE (EACCES)') as unknown });
    expect(existsSync(target)).toBe(false);
  });

  it('codes a write the OS refuses (a full disk) as the run stopping', async () => {
    const source = safePath.join(root, 'LICENSE');
    writeFileSync(source, 'MIT\n');
    const target = safePath.join(root, 'out', 'LICENSE');
    const session = installFaultFs({ within: root, faults: [{ family: 'write', path: (p) => p === target, errno: 'ENOSPC' }] });
    restore = () => session.restore();

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, { root, relative: 'out/LICENSE' }, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination', message: expect.stringContaining('dist/LICENSE') as unknown });
  });

  // The marketplace tree holds what earlier phases copied in, links kept. A file copied into it is
  // never written through one: the build's input put the link there, so it is the input's layout.
  it.for([
    { relative: 'plugin/linked.md', link: 'plugin/linked.md', type: 'file' },
    { relative: 'plugin/linkdir/deep/x.md', link: 'plugin/linkdir', type: 'dir' },
  ] as const)('never copies a file through a link the tree holds ($relative): refused as the input\'s, naming it, nothing written where it points', async ({ relative, link, type }, { skip }) => {
    const cap = symlinkCapability() ?? skip();
    const source = safePath.join(root, 'payload.md');
    writeFileSync(source, 'payload');
    mkdirSyncReal(safePath.join(root, 'outside'));
    writeFileSync(safePath.join(root, 'outside', 'victim.md'), 'precious');
    mkdirSyncReal(safePath.join(root, 'out', 'plugin'), { recursive: true });
    const pointedAt = type === 'file' ? safePath.join(root, 'outside', 'victim.md') : safePath.join(root, 'outside');
    createSymlink(cap, pointedAt, safePath.join(root, 'out', link), type);

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, { root: safePath.join(root, 'out'), relative }, 'payload.md', `plugin files[].dest ${relative}`));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source' });
    expect(refusal.message).toContain(`plugin files[].dest ${relative}`);
    expect(refusal.message).toContain(safePath.join(root, 'out', link));
    expect(readFileSync(safePath.join(root, 'outside', 'victim.md'), 'utf8')).toBe('precious');
    expect(readdirSync(safePath.join(root, 'outside'))).toEqual(['victim.md']);
  });

  it('a later copy replaces an earlier one\'s regular file, and never a directory', async () => {
    const source = safePath.join(root, 'payload.md');
    writeFileSync(source, 'later');
    mkdirSyncReal(safePath.join(root, 'out', 'a-directory'), { recursive: true });
    writeFileSync(safePath.join(root, 'out', 'README.md'), 'earlier');

    await copyFileIntoMarketplace(source, { root: safePath.join(root, 'out'), relative: 'README.md' }, 'payload.md', 'README.md');
    expect(readFileSync(safePath.join(root, 'out', 'README.md'), 'utf8')).toBe('later');

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, { root: safePath.join(root, 'out'), relative: 'a-directory' }, 'payload.md', 'a-directory'));
    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source' });
    expect(readdirSync(safePath.join(root, 'out', 'a-directory'))).toEqual([]);
  });

  it('never copies a tree onto a link standing where its root goes: refused as the run stopping, the directory it points at untouched', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const tree = safePath.join(root, 'dist', 'skills', 'pool-a');
    mkdirSyncReal(tree, { recursive: true });
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# a\n');
    mkdirSyncReal(safePath.join(root, 'outside'));
    mkdirSyncReal(safePath.join(root, 'out', 'skills', 'group'), { recursive: true });
    const nested = safePath.join(root, 'out', 'skills', 'group', 'pool-a');
    createSymlink(cap, safePath.join(root, 'outside'), nested, 'dir');

    const refusal = await refusalOf(() => copyTreeIntoMarketplace({ path: tree, side: 'source' }, nested, 'dist/skills/pool-a', 'skills/group/pool-a'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination', message: expect.stringContaining('skills/group/pool-a') as unknown });
    expect(readdirSync(safePath.join(root, 'outside'))).toEqual([]);
  });

  it('codes an unreadable file inside a tree as the build\'s input, naming the file under the label', async () => {
    const tree = safePath.join(root, 'dist', 'skills', 'pool-a');
    mkdirSyncReal(safePath.join(tree, 'resources'), { recursive: true });
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# a\n');
    writeFileSync(safePath.join(tree, 'resources', 'r.md'), '# r\n');
    restore = refuseOpen(root, safePath.join(tree, 'resources', 'r.md'));

    const refusal = await refusalOf(() => copyTreeIntoMarketplace({ path: tree, side: 'source' }, safePath.join(root, 'out'), 'dist/skills/pool-a', 'out'));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source', message: expect.stringContaining(safePath.join(tree, 'resources', 'r.md')) as unknown });
  });

  it('classifies a write the OS refuses by the path it names: the marketplace tree, the run stopping', async () => {
    const source = safePath.join(root, 'LICENSE');
    writeFileSync(source, 'MIT\n');
    restore = refuseAsyncFs('mkdir', safePath.join(root, 'out'), 'EACCES');

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, { root, relative: 'out/LICENSE' }, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination' });
  });

  it('codes a tree copy the OS refuses to write as the run stopping', async () => {
    const tree = safePath.join(root, 'tree');
    mkdirSyncReal(tree);
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# a\n');
    restore = refuseAsyncFs('mkdir', safePath.join(root, 'out'), 'ENOSPC');

    const refusal = await refusalOf(() => copyTreeIntoMarketplace({ path: tree, side: 'source' }, safePath.join(root, 'out'), 'tree', 'out'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination' });
  });

  // Under `vat build` the run's own skills phase wrote dist/skills: a file there the OS will not
  // read is the run's output, not an input — the side the caller declares, never assumed `source`.
  it('codes an unreadable file in a tree the run itself wrote on the side the caller declares', async () => {
    const tree = safePath.join(root, 'dist', 'skills', 'pool-b');
    mkdirSyncReal(tree, { recursive: true });
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# b\n');
    restore = refuseOpen(root, safePath.join(tree, 'SKILL.md'));

    const refusal = await refusalOf(() => copyTreeIntoMarketplace({ path: tree, side: 'destination' }, safePath.join(root, 'out'), 'dist/skills/pool-b', 'out'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination' });
  });
});
