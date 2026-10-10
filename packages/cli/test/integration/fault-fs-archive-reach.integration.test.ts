/**
 * The fs fault injector must reach the two third-party extractors the install
 * verbs rely on. node-tar (`import fs from 'fs'`) and adm-zip (`require('fs')`)
 * look methods up on the module object at call time; this pins that they see
 * the harness's replacements, instead of assuming it.
 */
import * as nodeFs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, tempDirTracker, type FaultFsSession } from '@vibe-agent-toolkit/utils/testing';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const scratch = tempDirTracker('fault-fs-archive-reach-');
let session: FaultFsSession | undefined;
afterEach(() => {
  session?.restore();
  session = undefined;
  scratch.cleanupAll();
});

/** A root holding an empty `out/` and a one-entry archive built by `makeArchive`. */
async function archiveFixture(name: string, makeArchive: (archive: string, src: string) => Promise<void> | void): Promise<{ archive: string; out: string }> {
  const root = scratch.create();
  const src = safePath.join(root, 'src');
  const out = safePath.join(root, 'out');
  mkdirSyncReal(src);
  mkdirSyncReal(out);
  nodeFs.writeFileSync(safePath.join(src, 'SKILL.md'), '# s\n');
  const archive = safePath.join(root, name);
  await makeArchive(archive, src);
  return { archive, out };
}

const failWritesUnder = (out: string): FaultFsSession =>
  (session = installFaultFs({
    within: out,
    faults: [{ family: 'write', path: (p) => safePath.relative(out, p) === 'SKILL.md', errno: 'ENOSPC' }],
  }));

describe('installFaultFs reaches the archive extractors', () => {
  it('node-tar extraction (non-strict keeps it an entry failure)', async () => {
    const { archive, out } = await archiveFixture('a.tgz', (file, cwd) => tar.create({ gzip: true, file, cwd }, ['SKILL.md']));
    failWritesUnder(out);
    const warnings: unknown[] = [];
    await tar.extract({ file: archive, cwd: out, onwarn: (_code, _message, data) => warnings.push(data) });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'ENOSPC' }));
    expect(session?.fired.length).toBeGreaterThanOrEqual(1);
    expect(nodeFs.existsSync(safePath.join(out, 'SKILL.md'))).toBe(false);
  });

  it('adm-zip extractAllTo', async () => {
    const { archive, out } = await archiveFixture('a.zip', (file, src) => {
      const zip = new AdmZip();
      zip.addLocalFile(safePath.join(src, 'SKILL.md'));
      zip.writeZip(file);
    });
    failWritesUnder(out);
    expect(() => new AdmZip(archive).extractAllTo(out, true)).toThrow();
    expect(session?.fired.length).toBeGreaterThanOrEqual(1);
    expect(nodeFs.existsSync(safePath.join(out, 'SKILL.md'))).toBe(false);
  });
});
