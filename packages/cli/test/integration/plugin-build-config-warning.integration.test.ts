/**
 * `vat claude plugin build` reads the project config ONCE, so a config carrying
 * an unknown key warns once — not once per loader the build happens to route
 * through.
 */
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runClaudePluginBuildPhase } from '../../src/commands/claude/plugin/build.js';
import { cleanupTestTempDir, createTestTempDir, writeTestFile } from '../system/test-common.js';

const UNKNOWN_KEY = 'notAVatKeyAtAll';

describe('claude plugin build config warning', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('plugin-build-config-warning-');
    writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), `${UNKNOWN_KEY}: 1\nclaude:\n  marketplaces: {}\n`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTestTempDir(tempDir);
  });

  it('prints the unknown-key warning exactly once', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });

    const { report } = await runClaudePluginBuildPhase({});

    expect(report.status).toBe('ok');
    const warnings = stderr.join('').split(`unrecognized key "${UNKNOWN_KEY}"`).length - 1;
    expect(warnings).toBe(1);
  });
});
