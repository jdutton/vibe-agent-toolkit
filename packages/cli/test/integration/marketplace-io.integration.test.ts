/**
 * The marketplace build's copies, coded by the tree each step touches: a source
 * the OS will not read is the build's INPUT (`INPUT_UNREADABLE`), a write it
 * refuses — a full disk — is the run stopping (`RUN_INCOMPLETE`). Neither is
 * `INTERNAL_ERROR`. Refusals are injected (`refuseSyncFs` / `refuseAsyncFs`), so
 * every platform and root reaches both sides.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs, refuseSyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { copyFileIntoMarketplace, copyTreeIntoMarketplace } from '../../src/utils/marketplace-io.js';

/** The refusal `work` ends with, as the command would publish it. */
async function refusalOf(work: () => Promise<void>): Promise<{ code: string; message: string }> {
  try {
    await work();
  } catch (error) {
    return { code: refusalCodeOf(error), message: (error as Error).message };
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
    restore = refuseSyncFs('openSync', source, 'EACCES');

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, target, 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', message: expect.stringContaining('Could not read LICENSE') as unknown });
    expect(existsSync(target)).toBe(false);
  });

  it('codes a write the OS refuses (a full disk) as the run stopping', async () => {
    const source = safePath.join(root, 'LICENSE');
    writeFileSync(source, 'MIT\n');
    restore = refuseAsyncFs('copyFile', source, 'ENOSPC');

    const refusal = await refusalOf(() => copyFileIntoMarketplace(source, safePath.join(root, 'out', 'LICENSE'), 'LICENSE', 'dist/LICENSE'));

    expect(refusal).toMatchObject({ code: 'RUN_INCOMPLETE', message: expect.stringContaining('dist/LICENSE') as unknown });
  });

  it('codes an unreadable file inside a tree as the build\'s input, naming the file under the label', async () => {
    const tree = safePath.join(root, 'dist', 'skills', 'pool-a');
    mkdirSyncReal(safePath.join(tree, 'resources'), { recursive: true });
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# a\n');
    writeFileSync(safePath.join(tree, 'resources', 'r.md'), '# r\n');
    restore = refuseSyncFs('openSync', safePath.join(tree, 'resources', 'r.md'), 'EACCES');

    const refusal = await refusalOf(() => copyTreeIntoMarketplace(tree, safePath.join(root, 'out'), 'dist/skills/pool-a', 'out', 'Rebuild it.'));

    expect(refusal).toMatchObject({ code: 'INPUT_UNREADABLE', message: expect.stringContaining('Could not read dist/skills/pool-a/resources/r.md:') as unknown });
  });

  it('codes a tree copy the OS refuses to write as the run stopping', async () => {
    const tree = safePath.join(root, 'tree');
    mkdirSyncReal(tree);
    writeFileSync(safePath.join(tree, 'SKILL.md'), '# a\n');
    restore = refuseSyncFs('cpSync', tree, 'ENOSPC');

    const refusal = await refusalOf(() => copyTreeIntoMarketplace(tree, safePath.join(root, 'out'), 'tree', 'out', 'Rebuild it.'));

    expect(refusal.code).toBe('RUN_INCOMPLETE');
  });
});
