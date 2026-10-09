/**
 * A RAG database removal the OS stops partway — one file deep in the database it will not unlink —
 * is told truthfully: the database was moved off its path whole before anything was removed, so the
 * clear is done and no half-database is left at the path the user named; the failure is returned as
 * the `leftover` (a `destination` fault, RUN_INCOMPLETE) naming where what is left of it now is.
 *
 * ⚠️ Its own file, and the file's only test: Node's recursive `fs.promises.rm` captures the `fs`
 * functions it walks with the first time it runs in a process, so a file's per-entry `unlink` is
 * reachable by the fault injector only when no `rm` ran before the injector was installed. The
 * `fired` assertion below is what proves the injection reached the walk. The target AND
 * TMPDIR/TEMP/TMP are the test's own scratch tree (a destructive path is never aimed at a real one).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

import { FS_FAULT_CODE, mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, registerScratchTmpdir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeRagDatabase } from '../../src/database-directory.js';

describe('removeRagDatabase — a removal the OS stops partway', () => {
  const scratch = registerScratchTmpdir('vat-rag-partial-', { beforeEach, afterEach });

  it('leaves nothing at the database path and names where the rest is', async () => {
    const dir = scratch();
    const db = safePath.join(dir, 'db');
    for (const table of ['rag_chunks', 'rag_documents']) {
      mkdirSyncReal(safePath.join(db, `${table}.lance`, 'data'), { recursive: true });
      writeFileSync(safePath.join(db, `${table}.lance`, 'data', `${table}.lance`), 'x');
    }

    const refused = (path: string): boolean => path.endsWith('/rag_documents.lance/data/rag_documents.lance');
    const session = installFaultFs({ within: dir, faults: [{ family: 'remove', op: 'unlink', path: refused, errno: 'EBUSY' }] });
    let error: unknown;
    try {
      ({ leftover: error } = await removeRagDatabase(db));
      await session.settled();
    } finally {
      session.restore();
    }

    expect(session.fired, session.calls.map((call) => `${call.op} ${call.path}`).join('\n')).toHaveLength(1);
    expect(error).toMatchObject({ code: FS_FAULT_CODE, side: 'destination' });
    expect(existsSync(db)).toBe(false);
    const parked = readdirSync(dir).find((name) => name.endsWith('.previous'));
    expect(parked, readdirSync(dir).join(', ')).toBeDefined();
    expect(String(error)).toContain(parked);
    // The file the OS refused is still there — under the parked name, never at `db`.
    expect(existsSync(safePath.join(dir, parked ?? '', 'rag_documents.lance', 'data', 'rag_documents.lance'))).toBe(true);
  });
});
