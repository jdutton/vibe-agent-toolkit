/* eslint-disable security/detect-non-literal-fs-filename */
// Test file: dynamic fs paths point only at our own temp fixtures.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizedTmpdir } from '../../src/path-utils.js';
import { spawnHeadlessClaude, type SpawnResult } from '../../src/skill-test/spawn-claude.js';

/**
 * Integration coverage for the wall-timeout + stall watchdog in
 * spawnHeadlessClaude. The gated VAT_SKILL_TEST_E2E block drives a real `claude`;
 * here we point the internal `binPath` seam at a TINY silent fake child so the
 * timer-driven kill paths run deterministically without an install.
 *
 * POSIX-only: the fake relies on a `#!/usr/bin/env node` shebang (Windows cannot
 * exec it), and the kill path under test is the POSIX process-group SIGKILL. The
 * timer logic itself is platform-independent.
 */

/**
 * A long-lived, completely silent child: it writes nothing to stdout/stderr and
 * stays alive far past any test watchdog window, so the wall-timeout and stall
 * watchdogs are the only things that can terminate it.
 */
const FAKE_CLAUDE = '#!/usr/bin/env node\nsetTimeout(() => { process.exit(0); }, 60000);\n';

const SHORT_WINDOW_MS = 200;
const LONG_WINDOW_MS = 5000;
/** Upper bound proving the watchdog killed the child promptly (no hang). */
const QUICK_MS = 3000;

describe.skipIf(process.platform === 'win32')('spawnHeadlessClaude watchdog', () => {
  let tempDir: string;
  let binPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-spawn-watchdog-'));
    binPath = safePath.join(tempDir, 'fake-claude.mjs');
    writeFileSync(binPath, FAKE_CLAUDE, 'utf8');
    chmodSync(binPath, 0o755);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Spawn the fake child with the given watchdog windows, timing the call. */
  async function runFake(
    over: { timeoutMs: number; stallMs?: number },
  ): Promise<{ result: SpawnResult; elapsed: number }> {
    const started = Date.now();
    const result = await spawnHeadlessClaude({
      binPath,
      prompt: 'hello\n',
      pluginDirs: [],
      sandboxDir: tempDir,
      cwd: tempDir,
      env: process.env,
      timeoutMs: over.timeoutMs,
      ...(over.stallMs === undefined ? {} : { stallMs: over.stallMs }),
    });
    return { result, elapsed: Date.now() - started };
  }

  it('flags stalled=true when the child is silent past the stall window', async () => {
    // Generous wall timeout so the stall watchdog (not the wall timer) fires first.
    const { result, elapsed } = await runFake({ timeoutMs: LONG_WINDOW_MS, stallMs: SHORT_WINDOW_MS });
    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(QUICK_MS);
  });

  it('flags timedOut=true when the child runs past the wall timeout', async () => {
    // No stallMs: only the wall timer can end the silent child.
    const { result, elapsed } = await runFake({ timeoutMs: SHORT_WINDOW_MS });
    expect(result.timedOut).toBe(true);
    expect(result.stalled).toBe(false);
    expect(elapsed).toBeLessThan(QUICK_MS);
  });
});
