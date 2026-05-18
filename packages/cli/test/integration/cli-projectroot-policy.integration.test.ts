/**
 * Integration tests for the per-command projectRoot policy matrix.
 *
 * Covers spec §13.4: each command's CLI-boundary policy (required / loud-cwd
 * / tolerate null) is observable from the outside.
 */

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from '../system/test-common.js';

const binPath = getBinPath(import.meta.url);
const LOUD_CWD_PATTERN = /no vibe-agent-toolkit\.config\.yaml or \.git\/ ancestor found; using .* as projectRoot/;

/**
 * Helper: assert `vat resources validate <tempDir>` succeeds without emitting
 * the loud-cwd warning. Used for the two "projectRoot marker present" cases
 * (config file vs .git/ directory) which only differ in setup.
 */
async function expectNoLoudCwdWarning(tempDir: string, setupMarker: () => void): Promise<void> {
  setupMarker();
  writeTestFile(safePath.join(tempDir, 'README.md'), '# Test\n');

  const result = await executeCli(binPath, ['resources', 'validate', tempDir]);

  expect(result.status).toBe(0);
  expect(result.stderr).not.toMatch(LOUD_CWD_PATTERN);
}

describe('CLI-boundary projectRoot policy (integration, spec §13.4)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-projectroot-policy-test-');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  describe('vat resources validate (loud-cwd policy)', () => {
    it('uses the config dir as projectRoot when vibe-agent-toolkit.config.yaml is present (no warning)', async () => {
      await expectNoLoudCwdWarning(tempDir, () => {
        writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
      });
    });

    it('uses the git root as projectRoot when only .git/ is present (no warning)', async () => {
      await expectNoLoudCwdWarning(tempDir, () => {
        mkdirSyncReal(safePath.join(tempDir, '.git'), { recursive: true });
      });
    });

    it('emits a loud-cwd warning when neither config nor .git/ ancestor exists', async () => {
      writeTestFile(safePath.join(tempDir, 'README.md'), '# Test\n');

      const result = await executeCli(binPath, ['resources', 'validate', tempDir]);

      // Successful run, but the warning must have been emitted to stderr.
      expect(result.stderr).toMatch(LOUD_CWD_PATTERN);
    });

    it('reports absolute_no_root broken_file when leading-/ link cannot resolve to projectRoot', async () => {
      // No config and no .git/ → loud-cwd kicks in → projectRoot = cwd (tempDir).
      // A leading-/ link pointing outside tempDir resolves above the project root.
      writeTestFile(safePath.join(tempDir, 'doc.md'), '[escape](/../../etc/passwd)');

      const { result, parsed } = await executeCliAndParseYaml(binPath, [
        'resources',
        'validate',
        tempDir,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(LOUD_CWD_PATTERN);
      // The error surfaces as broken_file with the documented message.
      const errors = parsed['errors'] as Array<{ errors: Array<{ type: string; message: string }> }> | undefined;
      expect(errors).toBeDefined();
      const flat = (errors ?? []).flatMap(e => e.errors);
      const hasAbsoluteEscape = flat.some(
        e => e.type === 'broken_file' && /escapes the project root/.test(e.message),
      );
      expect(hasAbsoluteEscape).toBe(true);
    });
  });

  describe('vat skills build (required policy)', () => {
    it('exits non-zero with a clear error when no config or .git/ ancestor exists', async () => {
      // Run from inside an isolated tmpdir with no config and no .git ancestor.
      const result = await executeCli(binPath, ['skills', 'build'], {
        cwd: tempDir,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /vat skills build (?:failed: )?requires a vibe-agent-toolkit\.config\.yaml or \.git\/ ancestor/,
      );
    });
  });
});
