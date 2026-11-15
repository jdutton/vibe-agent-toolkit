/**
 * A RAG database path that is itself a link to `\\host\share` is never handed to the kernel (a
 * Windows kernel resolving it offers the operator's NTLM credentials to the host): the link is
 * read as a link — its chain walked from the directory that HOLDS it — and refused, on the
 * destination side, so the removal it would feed stops.
 *
 * The host flavor the guard binds is set to `win32` (the shared `utils` build's `link-chain`
 * module, mocked), so this runs Windows semantics on every host over a real link whose text is a
 * UNC path — on POSIX a legal file name no kernel would send anywhere, which a kernel realpath
 * answers "dangling" for.
 */

import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { linkedDatabasePath } from '../src/database-directory.js';

vi.mock('../../utils/dist/tree-change/link-chain.js', async (importOriginal) => ({ ...(await importOriginal<object>()), HOST_PATH_FLAVOR: 'win32' }));

const CAPABILITY = symlinkCapability();
const UNC = String.raw`\\attacker\share\db`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

describe.skipIf(CAPABILITY === null)('linkedDatabasePath of a link to a network path (win32 semantics)', () => {
  it('refuses the link on the destination side instead of asking the kernel where it leads', () => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    const root = createTempDir('vat-rag-db-link-');
    dirs.push(root);
    const dbPath = safePath.join(root, 'db');
    createSymlink(CAPABILITY, UNC, dbPath, 'dir');

    expect(() => linkedDatabasePath(dbPath)).toThrow(expect.objectContaining({ side: 'destination', errno: 'LINK_CHAIN_REFUSED' }));
  });
});
