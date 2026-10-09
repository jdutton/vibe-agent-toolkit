/**
 * Which read failures the registry records as a RESOURCE_UNREADABLE finding and
 * which it lets surface as a defect — decided by fault CLASS (`fsFaultOf`), not by
 * a list of errnos kept here.
 *
 * The read itself is replaced so each case can hand the registry one exact
 * failure: an errno the classifier calls `absent`, `refused` or `wrong-type` is
 * the file being unreadable. An `exhausted` fault is the machine's, not the
 * file's (the table owes `RUN_INCOMPLETE`), and a `device` fault, a coded error,
 * or no errno at all is not something a finding can describe: all are thrown.
 */
import { classifyFsFault, FS_FAULT_CODE, safePath, VatError } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ContentKey from '../src/content-key.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { setupTempDirTestSuite } from './test-helpers.js';

const failure = vi.hoisted(() => ({ next: undefined as unknown }));

vi.mock('../src/content-key.js', async (importOriginal) => {
  const original = await importOriginal<typeof ContentKey>();
  return {
    ...original,
    readContentWithKey: async (...args: Parameters<typeof original.readContentWithKey>) => {
      if (failure.next !== undefined) throw failure.next;
      return original.readContentWithKey(...args);
    },
  };
});

/** An error shaped like the one `node:fs` raises for `code`. */
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: refused, open`), { code });
}

/** Add one file whose read throws `thrown`; what the registry recorded, or what it threw. */
async function addFailing(tempDir: string, thrown: unknown): Promise<{ unreadable: string[]; threw: unknown }> {
  const filePath = safePath.join(tempDir, 'doc.md');
  const registry = new ResourceRegistry({ baseDir: tempDir });
  failure.next = thrown;
  try {
    await registry.addResources([filePath]);
    return { unreadable: registry.getUnreadableResources().map((u) => u.code ?? 'no code'), threw: undefined };
  } catch (error) {
    return { unreadable: [], threw: error };
  }
}

describe('ResourceRegistry read failures, by fault class', () => {
  const suite = setupTempDirTestSuite('resource-registry-read-classes-');
  beforeEach(async () => {
    failure.next = undefined;
    await suite.beforeEach();
  });
  afterEach(suite.afterEach);

  it.each(['ENOENT', 'EACCES', 'EFTYPE', 'ENAMETOOLONG'])('records %s as an unreadable file', async (code) => {
    expect(await addFailing(suite.tempDir, errno(code))).toEqual({ unreadable: [code], threw: undefined });
  });

  it('records a classified fault (FsFaultError) by its errno', async () => {
    const classified = classifyFsFault(errno('EACCES'), { side: 'source', origin: 'content', action: 'read doc.md' });
    expect((await addFailing(suite.tempDir, classified)).unreadable).toEqual(['EACCES']);
  });

  it.each([['an exhausted fault (the machine ran out)', 'EMFILE', 'exhausted'], ['a device fault', 'ETIMEDOUT', 'device']])(
    'throws %s classified, so it refuses by the table rather than as a finding or a raw errno',
    async (_name, code, faultClass) => {
      const raw = errno(code);
      expect((await addFailing(suite.tempDir, raw)).threw).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass, cause: raw });
    },
  );

  it('throws a plain wrapper whose cause carries an errno, classified, rather than filing a finding', async () => {
    const wrapper = new Error('could not read', { cause: errno('EACCES') });
    expect(await addFailing(suite.tempDir, wrapper)).toMatchObject({ unreadable: [], threw: { code: FS_FAULT_CODE, cause: wrapper } });
  });

  it.each([
    ['a coded VatError whose cause carries an errno', new VatError('SOME_CODE', 'coded', { cause: errno('EACCES') })],
    ['a TypeError', new TypeError('defect')],
  ])('throws %s as it was, rather than filing a finding', async (_name, thrown) => {
    expect((await addFailing(suite.tempDir, thrown)).threw).toBe(thrown);
  });
});
