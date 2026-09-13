import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';

/**
 * Regression guard for the cross-package OOM fix.
 *
 * Each package's vitest caps its own workers (`maxWorkers`) in
 * vitest.shared.ts, but `turbo run test:<suite>` runs MANY packages' suites
 * concurrently (turbo's default concurrency is 10). The per-package cap does
 * NOT compose across turbo's parallel packages, so ~10 packages × 2 forks
 * spawn at once — and the integration/system forks of the three packages that
 * load a native model (onnxruntime/transformers in `rag`, LanceDB Arrow in
 * `rag-lancedb`, the TS language service in `resource-compiler`) each hold
 * 1-3GB of NATIVE memory that `--max-old-space-size` cannot bound. That
 * over-subscription OOM-killed a worker and surfaced as a flaky "exit 1, 0
 * test failures" (ERR_IPC_CHANNEL_CLOSED), notably on the memory-constrained
 * Windows CI runner.
 *
 * The fix is two-part: the three native-memory packages are CHAINED in
 * `turbo.json` (`rag` → `rag-lancedb` → `resource-compiler`) so no two of them
 * run their integration suites at once, and the two heavy tiers bound turbo's
 * cross-package concurrency so the other packages' per-package cap stays the
 * real peak-memory bound. Unit tests are light (no native models) and stay
 * parallel. If you change these, you are re-opening that OOM — do it
 * deliberately, with a memory budget in hand.
 */

/** turbo.json is JSONC; its comments are whole `//` lines, so dropping those lines is enough. */
function readTurboJson(): { tasks: Record<string, { dependsOn?: string[] }> } {
  const raw = readFileSync(safePath.join(PROJECT_ROOT, 'turbo.json'), 'utf-8');
  const withoutComments = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return JSON.parse(withoutComments) as { tasks: Record<string, { dependsOn?: string[] }> };
}

/** turbo's own cross-package concurrency ceiling for the two heavy tiers. */
const MAX_HEAVY_TIER_CONCURRENCY = 4;

describe('turbo test-suite concurrency (cross-package native-memory guard)', () => {
  const rootPkg = JSON.parse(readFileSync(safePath.join(PROJECT_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const turbo = readTurboJson();

  it.each(['test:integration', 'test:system'])('%s bounds turbo cross-package concurrency', (scriptName) => {
    const script = rootPkg.scripts[scriptName];
    expect(script, `root package.json is missing the "${scriptName}" script`).toBeDefined();
    expect(script).toContain(`turbo run ${scriptName}`);
    const match = /--concurrency=(\d+)/.exec(script ?? '');
    expect(
      match,
      `"${scriptName}" must pin --concurrency=<n> so per-package maxWorkers bounds peak memory across turbo's parallel packages`,
    ).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(MAX_HEAVY_TIER_CONCURRENCY);
  });

  it('chains the three native-memory packages so no two run their integration suites at once', () => {
    expect(turbo.tasks['@vibe-agent-toolkit/rag-lancedb#test:integration']?.dependsOn).toContain(
      '@vibe-agent-toolkit/rag#test:integration',
    );
    expect(turbo.tasks['@vibe-agent-toolkit/resource-compiler#test:integration']?.dependsOn).toContain(
      '@vibe-agent-toolkit/rag-lancedb#test:integration',
    );
  });

  it('leaves test:unit parallel (light, no native models — no cap needed)', () => {
    expect(rootPkg.scripts['test:unit']).toContain('turbo run test:unit');
    expect(rootPkg.scripts['test:unit']).not.toContain('--concurrency=');
  });
});
