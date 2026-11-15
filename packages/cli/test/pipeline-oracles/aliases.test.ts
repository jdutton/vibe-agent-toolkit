/**
 * `targetInsideRoot` has three answers besides "inside" and "outside": `null` for a path that
 * resolves to nothing, and `{ fault }` for one whose resolution the OS declined or failed — that
 * one row's fact, never the end of the snapshot. The golden only ever observes the first two, so
 * the fault branch is held here, on the real resolution with an injected realpath fault.
 */
import { writeFileSync } from 'node:fs';

import type { ResourceRealizationRow } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { createTempDir, installFaultFs, removeTempDir, type FaultFsSession, type InjectedErrno } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { toEnumerationRow } from '../../src/pipeline-oracles/aliases.js';

/** The realization fields `toEnumerationRow` projects; the rest never reach the enumeration row. */
function realizationOf(path: string): ResourceRealizationRow {
  return { path, contentKey: null, exists: true, isDirectory: false, gitignored: false, isSymlink: false, symlinkResolves: null } as unknown as ResourceRealizationRow;
}

const scratch: string[] = [];

/** A real-spelled corpus root holding `a.md`, removed after each test. */
function corpus(): { root: string; file: string } {
  const parent = createTempDir('vat-oracle-aliases-');
  scratch.push(parent);
  const root = mkdirSyncReal(safePath.join(parent, 'corpus'), { recursive: true });
  const file = safePath.join(root, 'a.md');
  writeFileSync(file, '# a\n');
  return { root, file };
}

describe('toEnumerationRow: targetInsideRoot', () => {
  let session: FaultFsSession | undefined;

  afterEach(() => {
    session?.restore();
    session = undefined;
    for (const dir of scratch.splice(0)) removeTempDir(dir);
  });

  it('is true for a file that resolves inside the root (positive control)', () => {
    const { root, file } = corpus();
    expect(toEnumerationRow(realizationOf('a.md'), file, root).targetInsideRoot).toBe(true);
  });

  it('is null for a path that resolves to nothing', () => {
    const { root } = corpus();
    expect(toEnumerationRow(realizationOf('gone.md'), safePath.join(root, 'gone.md'), root).targetInsideRoot).toBeNull();
  });

  it.each<InjectedErrno>(['EACCES', 'EPERM', 'EIO', 'UNKNOWN', 'EINVAL', 'ENETUNREACH', 'EWHATEVER'])('carries the errno when the OS fails the resolution with %s: that row\'s fact, never null', (errno) => {
    const { root, file } = corpus();
    session = installFaultFs({ within: root, faults: [{ op: 'realpath', path: (path) => path === file, errno, everyTry: true }] });

    expect(toEnumerationRow(realizationOf('a.md'), file, root).targetInsideRoot).toEqual({ fault: errno });
    expect(session.fired.length).toBeGreaterThan(0);
  });
});
