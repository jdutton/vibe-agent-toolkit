/**
 * "Is the source readable?" must be answered by OPENING it for reading, never by
 * `access(R_OK)`. Node documents that on Windows `access()` ignores ACLs, so an
 * ACL-denied source passed the check and failed later inside the copy: under the
 * packager's OUTPUT guard (an unfinished run with a write remedy).
 *
 * Windows ACLs cannot be set from macOS or Linux, so this models one: `open`
 * refuses a marked path while `access` — left real — says the file is readable,
 * exactly the disagreement a Windows ACL produces.
 */

import type * as FsPromises from 'node:fs/promises';
import fs from 'node:fs/promises';

import { FS_FAULT_CODE, safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyIntoBundle } from '../src/bundle-copy.js';
import { isSkillPackagingInputError } from '../src/packaging-errors.js';

const { ACL_DENIED } = vi.hoisted(() => ({ ACL_DENIED: 'acl-denied' }));

/** Whether this open of `path` is refused, as a Windows ACL would refuse it. */
function refusesOpen(path: string): boolean {
  return path.includes(ACL_DENIED);
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const open = ((path: Parameters<typeof real.open>[0], ...rest: unknown[]) =>
    refusesOpen(String(path))
      ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, open '${String(path)}'`), {
        code: 'EPERM', syscall: 'open', path: String(path),
      }))
      : (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(path, ...rest)) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

describe('a source the OS lets access() pass but refuses to open', () => {
  const suite = setupAsyncTempDirSuite('acl-probe');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('is refused by copyIntoBundle as the skill\'s unreadable source, not as an unwritable output', async () => {
    const source = safePath.join(tempDir, `${ACL_DENIED}.md`);
    await fs.writeFile(source, '# denied');

    const thrown = await copyIntoBundle('linked file acl-denied.md', source, tempDir, safePath.join(tempDir, 'out', 'x.md'))
      .then(() => undefined, (error: unknown) => error);

    expect(isSkillPackagingInputError(thrown), String(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused', origin: 'content' });
    expect((thrown as Error).message).toContain('linked file acl-denied.md');
  });
});
