/**
 * Integration coverage for {@link spawnHardened} against REAL child processes.
 *
 * The load-bearing case is Windows: `npm` resolves to `npm.cmd`, and since the
 * CVE-2024-27980 fix a bare `child_process.spawn` of a `.cmd` throws `EINVAL`
 * synchronously. This is the exact failure an adopter hit running `vat skill test`
 * on Windows (claude → `claude.cmd`). The `npm --version` case below exercises the
 * shell branch on Windows CI and would fail (throw / non-zero) against the old bare
 * spawn — so it is a genuine regression guard, not a smoke test.
 */
import { describe, expect, it } from 'vitest';
import which from 'which';

import { spawnHardened } from '../../src/spawn-hardened.js';
import { shouldUseShell } from '../../src/windows-shell.js';

const onWindows = process.platform === 'win32';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn via the hardened wrapper and collect its output to completion. */
async function run(command: string, args: string[]): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawnHardened(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => { resolve({ code, stdout, stderr }); });
  });
}

describe('spawnHardened (real processes)', () => {
  it('runs a real .exe via an explicit path (non-shell branch)', async () => {
    // process.execPath is an absolute path → used verbatim, spawned shell:false.
    const result = await run(process.execPath, ['-e', 'process.stdout.write("HARDENED_OK")']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HARDENED_OK');
  });

  it('resolves a bare command on PATH and runs it', async () => {
    // `node` on PATH: resolves to node(.exe on Windows) → non-shell branch everywhere.
    const result = await run('node', ['-e', 'process.stdout.write("PATH_OK")']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PATH_OK');
  });

  it('runs an npm-shim command — the Windows .cmd regression guard', async () => {
    // On Windows `npm` is `npm.cmd`; a bare spawn would throw EINVAL here. spawnHardened
    // routes it through cmd.exe. On POSIX this simply exercises PATH resolution + run.
    const result = await run('npm', ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(!onWindows)('confirms npm really is a .cmd shim on this Windows runner', () => {
    // Documents WHY the case above is a regression guard: without shell handling the
    // preceding test would have thrown EINVAL on exactly this resolved path.
    expect(shouldUseShell(which.sync('npm'))).toBe(true);
  });
});
