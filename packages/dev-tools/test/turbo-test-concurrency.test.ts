import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { cliIntegrationTestWorkers, forkRssBudgetMb, maxTestWorkers } from '../../../vitest.shared.js';
import { PROJECT_ROOT } from '../src/common.js';

/**
 * Regression guard for the cross-package OOM fix.
 *
 * Each package's vitest caps its own workers (`maxWorkers`) in
 * vitest.shared.ts, but `turbo run test:<suite>` runs MANY packages' suites
 * concurrently (turbo's default concurrency is 10). The per-package cap does
 * NOT compose across turbo's parallel packages, so ~10 packages × 2 forks
 * spawn at once — and the integration forks of the three packages that
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

interface PackageTestBlock {
  maxWorkers: number;
  fileParallelism?: boolean;
  setupFiles: string[];
  provide: { forkRssBudgetMb?: number };
}

async function loadPackageTestConfig(configPath: string): Promise<{ test: PackageTestBlock }> {
  const loaded = (await import(pathToFileURL(configPath).href)) as { default: { test: PackageTestBlock } };
  return loaded.default;
}

const INTEGRATION_TASK = /^@vibe-agent-toolkit\/(.+)#test:integration$/;

/**
 * The native-memory packages, read from the turbo.json chain itself: every package whose
 * integration task waits on another package's, and every package waited on. One source.
 */
function nativeMemoryChain(turbo: ReturnType<typeof readTurboJson>): Set<string> {
  const chain = new Set<string>();
  for (const [task, { dependsOn = [] }] of Object.entries(turbo.tasks)) {
    const own = INTEGRATION_TASK.exec(task)?.[1];
    if (own === undefined) continue;
    for (const dep of dependsOn) {
      const waitedOn = INTEGRATION_TASK.exec(dep)?.[1];
      if (waitedOn === undefined) continue;
      chain.add(own);
      chain.add(waitedOn);
    }
  }
  return chain;
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

  // The per-package worker cap is what bounds a native-memory package's peak. A package may raise
  // its own only outside that chain, and only with the per-fork RSS budget installed
  // (`cliIntegrationTestWorkers`, `forkRssBudgetMb` in vitest.shared.ts).
  it('lets only cli raise its integration worker cap, never a native-memory package, and only under the RSS budget', async () => {
    const nativeMemory = nativeMemoryChain(turbo);
    expect([...nativeMemory].toSorted((a, b) => a.localeCompare(b))).toEqual(['rag', 'rag-lancedb', 'resource-compiler']);
    const raised: string[] = [];
    for (const dir of readdirSync(safePath.join(PROJECT_ROOT, 'packages'))) {
      const configPath = safePath.join(PROJECT_ROOT, 'packages', dir, 'vitest.integration.config.ts');
      if (!existsSync(configPath)) continue;
      const { test } = await loadPackageTestConfig(configPath);
      if (nativeMemory.has(dir)) expect(test.maxWorkers, `${dir} holds native memory`).toBe(maxTestWorkers);
      if (test.maxWorkers <= maxTestWorkers) continue;
      raised.push(dir);
      expect(test.setupFiles.some((file) => file.endsWith('vitest.fork-rss-budget.setup.js')), `${dir} raised its cap without the RSS budget`).toBe(true);
      expect(test.provide.forkRssBudgetMb).toBe(forkRssBudgetMb);
    }
    // Both ways: the scan saw the one package that raises its cap, at the one value, so it is not blind.
    expect(raised).toEqual(['cli']);
    const cli = await loadPackageTestConfig(safePath.join(PROJECT_ROOT, 'packages', 'cli', 'vitest.integration.config.ts'));
    expect(cli.test.maxWorkers).toBe(cliIntegrationTestWorkers);
  });

  // The system tier runs at the shared cap in every package and on every platform: Windows ran it
  // serially long after the RPC deadline that justified that was gone. Its memory was measured
  // for that cap (`vitest.shared.ts`, `createSystemTestConfig`), and every fork carries the RSS
  // detector; much of the tier's memory sits in spawned `vat` children that detector cannot see.
  // Equality, not "at most": the value is read on whichever OS runs the unit tier, so a
  // platform branch reds there — lowering a package for everyone is a deliberate edit here.
  // `maxWorkers` is not the only way to serialise, so the other two are pinned as well.
  it('runs every package\'s system tier at the shared worker cap, on this platform too', async () => {
    const scanned: string[] = [];
    for (const dir of readdirSync(safePath.join(PROJECT_ROOT, 'packages'))) {
      const configPath = safePath.join(PROJECT_ROOT, 'packages', dir, 'vitest.system.config.ts');
      if (!existsSync(configPath)) continue;
      const { test } = await loadPackageTestConfig(configPath);
      expect(test.maxWorkers, `${dir} system tier`).toBe(maxTestWorkers);
      expect(test.fileParallelism, `${dir} system tier`).not.toBe(false);
      expect(test.setupFiles.some((file) => file.endsWith('vitest.fork-rss-budget.setup.js')), `${dir} system tier without the RSS budget`).toBe(true);
      expect(test.provide.forkRssBudgetMb).toBe(forkRssBudgetMb);
      const pkg = JSON.parse(readFileSync(safePath.join(PROJECT_ROOT, 'packages', dir, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['test:system'], `${dir} test:system script`).toBe('vitest run --config vitest.system.config.ts');
      scanned.push(dir);
    }
    // Not blind: the scan reached cli, the tier's long pole.
    expect(scanned).toContain('cli');
  });

  it('leaves test:unit parallel (light, no native models — no cap needed)', () => {
    expect(rootPkg.scripts['test:unit']).toContain('turbo run test:unit');
    expect(rootPkg.scripts['test:unit']).not.toContain('--concurrency=');
  });
});
