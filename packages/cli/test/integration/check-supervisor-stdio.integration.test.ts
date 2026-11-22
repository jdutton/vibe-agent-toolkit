/**
 * What `superviseRun` hands the spawned child as its stdio: today's array for `'inherit'`, and the
 * sink's fd for an overlapped run, whose parent write fd is closed once the spawn returned.
 * Integration tier: the sink is a real file opened with a real fd.
 */
import { fstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ProgressLog, superviseRun } from '../../src/commands/resources/check-supervisor.js';

const { spawnMock, binPathMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), binPathMock: vi.fn(() => 'vat-bin.js') }));
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }));
vi.mock('../../src/utils/vat-bin-path.js', () => ({ resolveVatBinPath: binPathMock }));

const log = { path: 'progress.log', guard: { watch: vi.fn() } } as unknown as ProgressLog;
const base = { verb: 'resources check', args: [], log, budgetMs: 500, format: 'json' } as const;
/** No case abandons its run. */
const NEVER_ABANDONED = new Promise<void>(() => undefined);

describe('superviseRun stdio', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-supervisor-stdio-'));
    // A spawn that throws ends the run at once on `spawn-failed`, with no child to wait for.
    spawnMock.mockImplementation(() => {
      throw new Error('spawn refused');
    });
  });
  afterEach(() => {
    spawnMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns today's stdio array for inherit", async () => {
    await superviseRun({ ...base, stderr: 'inherit' });
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'inherit'] });
  });

  it('passes the sink fd as stderr and closes the parent write fd after spawn', async () => {
    const path = safePath.join(dir, 'stderr.log');
    const fd = openSync(path, 'w');
    await superviseRun({ ...base, stderr: { sink: { fd, path }, graceFrom: Promise.resolve(), abandoned: NEVER_ABANDONED } });
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', fd] });
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('closes the sink fd when resolving the binary throws before the spawn', async () => {
    const path = safePath.join(dir, 'stderr.log');
    const fd = openSync(path, 'w');
    const refusal = new Error('no vat binary');
    binPathMock.mockImplementationOnce(() => {
      throw refusal;
    });

    await expect(superviseRun({ ...base, stderr: { sink: { fd, path }, graceFrom: Promise.resolve(), abandoned: NEVER_ABANDONED } })).rejects.toBe(refusal);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('hands a spawned child to the guard before closing the write fd, so a close that throws orphans nothing', async () => {
    const path = safePath.join(dir, 'stderr.log');
    // The parent's close of its write fd will throw: a number far past any open-file limit is never
    // open, so no fd another open reuses can be closed in its place.
    const fd = 0x3f_ff_ff_ff;
    const child = { pid: 4242 };
    spawnMock.mockImplementationOnce(() => child);
    const watch = vi.mocked(log.guard.watch);
    watch.mockClear();

    await expect(superviseRun({ ...base, stderr: { sink: { fd, path }, graceFrom: Promise.resolve(), abandoned: NEVER_ABANDONED } }))
      .rejects.toMatchObject({ code: 'EBADF' });

    expect(watch).toHaveBeenCalledWith(child);
  });
});
