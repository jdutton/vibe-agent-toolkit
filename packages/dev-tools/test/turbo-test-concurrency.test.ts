import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';

/**
 * Regression guard for the cross-package OOM fix.
 *
 * Each package's vitest caps its own workers (`maxForks`/`maxThreads`) in
 * vitest.shared.ts, but `turbo run test:<suite>` runs MANY packages' suites
 * concurrently (turbo's default concurrency is 10). The per-package cap does
 * NOT compose across turbo's parallel packages, so ~10 packages × 2 forks
 * spawn at once — and integration/system forks each hold 1-3GB of NATIVE
 * memory (LanceDB Arrow, onnxruntime models) that `--max-old-space-size`
 * cannot bound. That over-subscription OOM-killed a worker and surfaced as a
 * flaky "exit 1, 0 test failures" (ERR_IPC_CHANNEL_CLOSED), notably on the
 * memory-constrained Windows CI runner.
 *
 * The fix pins `--concurrency=1` on the two heavy suites so the per-package
 * cap becomes the real peak-memory bound (reproducing the isolated-run
 * condition that reliably passes). Unit tests are light (no native models)
 * and stay parallel. If you change these, you are re-opening that OOM — do it
 * deliberately, with a memory budget in hand.
 */
describe('turbo test-suite concurrency (cross-package OOM guard)', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const rootPkg = JSON.parse(readFileSync(safePath.join(PROJECT_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };

  it.each(['test:integration', 'test:system'])(
    '%s pins turbo cross-package concurrency to 1 (native-memory OOM guard)',
    (scriptName) => {
      const script = rootPkg.scripts[scriptName];
      expect(script, `root package.json is missing the "${scriptName}" script`).toBeDefined();
      expect(script).toContain(`turbo run ${scriptName}`);
      expect(
        script,
        `"${scriptName}" must pin --concurrency=1 so per-package maxForks bounds peak memory across turbo's parallel packages`,
      ).toContain('--concurrency=1');
    },
  );

  it('leaves test:unit parallel (light, no native models — no cap needed)', () => {
    expect(rootPkg.scripts['test:unit']).toContain('turbo run test:unit');
    expect(rootPkg.scripts['test:unit']).not.toContain('--concurrency=1');
  });
});
