import { readFileSync, readdirSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  createIntegrationTestConfig,
  createSystemTestConfig,
  createUnitTestConfig,
} from '../../../vitest.shared.js';
import { PROJECT_ROOT } from '../src/common.js';

/**
 * Mechanical guard for the vitest 4 pool surface.
 *
 * 🚨 **Vitest 4 deleted `poolOptions` and does NOT error on the old shape — it
 * prints one DEPRECATED line and ignores it.** Re-introducing a v3 spelling
 * therefore silently uncaps every pool and removes the per-worker heap ceiling,
 * which is exactly the unbounded-worker OOM that commit 9f7ad9c9 exists to
 * prevent. The failure is an exit-0 one, so nothing in CI notices.
 *
 * ⚠️ Until this file existed, the ONLY defence was a 🚨 banner in
 * vitest.shared.ts addressed to a human. Every mechanical route is blind here:
 *
 *   - **ESLint**: `vitest.config.ts`, `vitest.*.config.ts` and `vitest.shared.ts`
 *     are all in eslint.config.js's `ignores` list — linting them reports
 *     "File ignored because of a matching ignore pattern".
 *   - **TypeScript**: the root tsconfig is `"files": []` (project references
 *     only) and every package tsconfig is `"include": ["src/**"]`, so no config
 *     file is in a program at all. And even if one were, `defineConfig`'s
 *     excess-property check would NOT fire on the shape this repo uses:
 *     excess-property checking applies to object LITERALS, and every package
 *     config passes `test: createIntegrationTestConfig()` — a call expression.
 *     Verified against tsc: the literal form errors TS2353, the factory form
 *     compiles clean. So typechecking could only ever cover the root config,
 *     never the factories that supply all 41 package configs.
 *
 * Hence a test, in two halves that fail for different reasons: the EVALUATED
 * factory outputs (immune to comments and to how the object is spelled) and a
 * SOURCE scan of the config files the factories do not reach.
 */

/** v3 knobs that vitest 4 accepts, ignores, and does not fail on. */
const REMOVED_POOL_KEYS = ['poolOptions', 'maxForks', 'maxThreads', 'singleFork', 'singleThread'] as const;

/** A line that is entirely a comment — the banner explaining these keys is one. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Every vitest source file in the repo: the four at the root (including
 * `vitest.shared.ts` itself, whose non-factory exports the root config inlines)
 * plus one config per package. Matched by NAME rather than listed, so a config
 * added to a new package is covered without anyone remembering to add it.
 */
function findVitestConfigFiles(): string[] {
  const isConfig = (name: string): boolean => name.startsWith('vitest.') && name.endsWith('.ts');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived, not user input
  const rootFiles = readdirSync(PROJECT_ROOT).filter((name) => isConfig(name)).map((name) => safePath.join(PROJECT_ROOT, name));
  const packagesDir = safePath.join(PROJECT_ROOT, 'packages');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived, not user input
  const packageFiles = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = safePath.join(packagesDir, entry.name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived, not user input
      return readdirSync(dir).filter((name) => isConfig(name)).map((name) => safePath.join(dir, name));
    });
  return [...rootFiles, ...packageFiles];
}

describe('vitest pool surface (v3 knobs are silently ignored, not rejected)', () => {
  describe('the shared factories every package config spreads', () => {
    it.each([
      ['createUnitTestConfig', createUnitTestConfig()],
      ['createIntegrationTestConfig', createIntegrationTestConfig()],
      ['createSystemTestConfig', createSystemTestConfig()],
    ])('%s emits no removed v3 pool key', (_name, config) => {
      expect(Object.keys(config).filter((key) => (REMOVED_POOL_KEYS as readonly string[]).includes(key))).toEqual([]);
    });

    it.each([
      ['createUnitTestConfig', createUnitTestConfig()],
      ['createIntegrationTestConfig', createIntegrationTestConfig()],
      ['createSystemTestConfig', createSystemTestConfig()],
    ])('%s still carries the vitest 4 cap that replaced them', (_name, config) => {
      // 🪤 Absence of the old key is only half the property. Deleting the v3
      // block WITHOUT adding `maxWorkers` uncaps the pool just as thoroughly,
      // and the first assertion above would be perfectly happy about it.
      expect(config.maxWorkers).toBeGreaterThan(0);
      expect(Array.isArray(config.execArgv)).toBe(true);
    });
  });

  describe('every vitest source file in the repo', () => {
    const configFiles = findVitestConfigFiles();

    it('finds the root files and one config per package (a scan of nothing would pass vacuously)', () => {
      expect(configFiles.length).toBeGreaterThan(20);
      expect(configFiles.map((file) => safePath.relative(PROJECT_ROOT, file))).toContain('vitest.shared.ts');
    });

    it.each(REMOVED_POOL_KEYS)('declares no `%s` outside comments', (key) => {
      const offenders = configFiles.filter((file) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- from findVitestConfigFiles, PROJECT_ROOT-derived
        const source = readFileSync(file, 'utf-8');
        return source.split('\n').some((line) => !isCommentLine(line) && line.includes(key));
      });

      // Comment lines are excluded on purpose: vitest.shared.ts's banner NAMES
      // all five of these keys while explaining why they are gone, and a scan
      // that reds on the warning about a mistake is a scan nobody keeps.
      expect(offenders.map((file) => safePath.relative(PROJECT_ROOT, file))).toEqual([]);
    });
  });
});
