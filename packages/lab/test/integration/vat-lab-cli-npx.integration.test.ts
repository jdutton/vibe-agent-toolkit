/**
 * The CLI's own install-site wiring for an `npx:` build: a verb installs the pin
 * under the arms root IT computes from `--arms-dir`, never anywhere else. The
 * installer is a stand-in — the module's `npmInstall` replaced, everything else
 * real — that records where it was asked to install, then stops the run.
 *
 * Integration-tier: drives a whole verb through Commander.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as NpxInstallModule from '../../src/harness/npx-install.js';
import type * as RunModule from '../../src/harness/run.js';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-cli-npx-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.doUnmock('../../src/harness/npx-install.js');
  vi.doUnmock('../../src/harness/run.js');
  vi.resetModules();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** What the stand-in installer throws once it knows where it was asked to install. */
const STOPPED = 'the stand-in installer stops here';

describe('vat-lab perf run --instrument npx:', () => {
  it('installs the pin under the arms root the CLI computes from --arms-dir', async () => {
    const prefixes: string[] = [];
    vi.resetModules();
    vi.doMock('../../src/harness/npx-install.js', async (importOriginal) => ({
      ...(await importOriginal<typeof NpxInstallModule>()),
      npmInstall: (_spec: string, prefix: string) => {
        prefixes.push(prefix);
        throw new Error(STOPPED);
      },
    }));
    const { createProgram } = await import('../../src/bin/vat-lab.js');
    const subject = mkdtempSync(safePath.join(tempDir, 'subject-'));
    const armsDir = safePath.join(tempDir, 'arms');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const ran = createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'run', subject,
      '--instrument', 'npx:vibe-agent-toolkit@0.1.43',
      '--out', safePath.join(tempDir, 'out'), '--arms-dir', armsDir,
    ]);

    await expect(ran).rejects.toThrow(STOPPED);
    expect(prefixes).toHaveLength(1);
    // A named --arms-dir is kept, so it can be asked for its real path: the install's prefix is real.
    const realArmsDir = toForwardSlash(normalizePath(armsDir, { within: armsDir }));
    expect(toForwardSlash(prefixes[0] ?? '').startsWith(`${realArmsDir}/`)).toBe(true);
  });

  it('prints a failed npm install as one REFUSED: line and exits with the refusal code, not a stack trace', async () => {
    // The real installer; only npm's own run is a stand-in, and it fails.
    vi.resetModules();
    vi.doMock('../../src/harness/run.js', async (importOriginal) => {
      const original = await importOriginal<typeof RunModule>();
      return {
        ...original,
        runCommand: (...call: Parameters<typeof RunModule.runCommand>) =>
          toForwardSlash(call[0].leadingArgs[0] ?? '').endsWith('/npm/bin/npm-cli.js')
            ? { exitCode: 1, stdout: '', stderr: 'npm ERR! 404 Not Found\n', wallMs: 0, started: true, spawnError: null }
            : original.runCommand(...call),
      };
    });
    const { createProgram } = await import('../../src/bin/vat-lab.js');
    const subject = mkdtempSync(safePath.join(tempDir, 'subject-'));
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'run', subject,
      '--instrument', 'npx:vibe-agent-toolkit@0.1.43',
      '--out', safePath.join(tempDir, 'out-refused'), '--arms-dir', safePath.join(tempDir, 'arms-refused'),
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(written.join('')).toMatch(/^REFUSED: npm install vibe-agent-toolkit@0\.1\.43 failed \(1\): npm ERR! 404 Not Found$/mu);
  });
});
