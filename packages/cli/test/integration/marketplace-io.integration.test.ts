/**
 * The marketplace build's copies, classified by the tree each step touches: a source
 * the OS will not read is the build's INPUT (a `source` fault, `INPUT_UNREADABLE`), a
 * write it refuses — a full disk — is the run stopping (`RUN_INCOMPLETE`). Neither is
 * `INTERNAL_ERROR`. Refusals are injected (`installFaultFs` for the read proof's
 * non-blocking open, `refuseSyncFs` / `refuseAsyncFs` for the writes), so every
 * platform and root reaches both sides.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
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

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, target, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source', message: expect.stringContaining('Could not read LICENSE (EACCES)') as unknown });
    expect(existsSync(target)).toBe(false);
  });

  it('codes a write the OS refuses (a full disk) as the run stopping', async () => {
    const source = safePath.join(root, 'LICENSE');
    writeFileSync(source, 'MIT\n');
    const target = safePath.join(root, 'out', 'LICENSE');
    const session = installFaultFs({ within: root, faults: [{ family: 'write', path: (p) => p === target, errno: 'ENOSPC' }] });
    restore = () => session.restore();

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, target, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination', message: expect.stringContaining('dist/LICENSE') as unknown });
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
    const target = safePath.join(root, 'out', 'LICENSE');
    restore = refuseAsyncFs('mkdir', safePath.join(root, 'out'), 'EACCES');

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, target, 'LICENSE', 'dist/LICENSE'));

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
