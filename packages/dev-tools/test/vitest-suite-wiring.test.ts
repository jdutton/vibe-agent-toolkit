import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';

/**
 * Regression guard for silently-dead test suites.
 *
 * A package's `test:integration` / `test:system` script must point vitest at
 * the matching config with `--config`. A bare `vitest run` loads the DEFAULT
 * vitest.config.ts — the UNIT config — whose `exclude` drops
 * `**\/*.integration.test.ts` and `**\/*.system.test.ts`. The suite therefore
 * runs NOWHERE while the script still exits 0, so CI stays green and nobody
 * notices. That is exactly what happened to agent-config, agent-skills,
 * dev-tools, gateway-mcp and rag: five packages shipped a
 * vitest.integration.config.ts whose tests had never executed.
 *
 * The guard is driven off TWO independent signals, either of which is enough
 * to pull a package into scope: a suite config file on disk, OR matching
 * `*.integration.test.ts` / `*.system.test.ts` files anywhere under `test/`.
 * The config-only signal (the original guard) cannot catch the MIRROR case: a
 * package with test files but no config and no script at all — those tests
 * run nowhere, and because there is no config to notice, nothing before this
 * ever looked for them. Neither signal alone is a hardcoded list, so a newly
 * added config or a newly added test file is covered the moment it lands.
 */

const PACKAGES_DIR = safePath.join(PROJECT_ROOT, 'packages');

/** Suite kinds this guard covers: their config file, npm script, and the test-file suffix that signals "this suite exists". */
const SUITE_CONFIGS = [
  {
    configFile: 'vitest.integration.config.ts',
    scriptName: 'test:integration',
    testFileSuffix: '.integration.test.ts',
  },
  { configFile: 'vitest.system.config.ts', scriptName: 'test:system', testFileSuffix: '.system.test.ts' },
] as const;

interface SuiteWiring {
  pkg: string;
  configFile: string;
  scriptName: string;
  testFileSuffix: string;
  /** Does `<pkg>/<configFile>` exist on disk? */
  hasConfig: boolean;
  script: string | undefined;
}

function readScripts(packageJsonPath: string): Record<string, string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

/**
 * Recursively collect every filename under `dir` (basenames only — the caller
 * only needs to check a suffix). Returns `[]` for a directory that doesn't
 * exist (a package with no `test/` dir at all has no test files, not an
 * error).
 */
function walkFilenames(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  if (!existsSync(dir)) {
    return [];
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const entries = readdirSync(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const full = safePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...walkFilenames(full));
    } else if (entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names;
}

/** Does `<pkgDir>/test/**` contain any file ending in `testFileSuffix`? */
function hasMatchingTestFiles(pkgDir: string, testFileSuffix: string): boolean {
  const testDir = safePath.join(pkgDir, 'test');
  return walkFilenames(testDir).some((name) => name.endsWith(testFileSuffix));
}

/**
 * Scan `packagesDir` and collect one {@link SuiteWiring} per (package, suite
 * kind) pair that qualifies as "this suite exists" — EITHER the config file is
 * present OR a matching test file is present under `test/`. A package that has
 * neither signal for a suite kind is genuinely out of scope for that kind (e.g.
 * `schema` ships no integration tests at all) and is not included.
 *
 * Exported (and parameterized on `packagesDir`) so the detection logic itself
 * — not just the final assertions — is unit-testable against a synthetic
 * fixture, independent of this monorepo's real `packages/` contents.
 */
export function collectSuiteWirings(packagesDir: string): SuiteWiring[] {
  const wirings: SuiteWiring[] = [];

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const pkg of packageDirs) {
    const pkgDir = safePath.join(packagesDir, pkg);
    const packageJsonPath = safePath.join(pkgDir, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const scripts = readScripts(packageJsonPath);

    for (const { configFile, scriptName, testFileSuffix } of SUITE_CONFIGS) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
      const hasConfig = existsSync(safePath.join(pkgDir, configFile));
      const hasTestFiles = hasMatchingTestFiles(pkgDir, testFileSuffix);
      if (!hasConfig && !hasTestFiles) {
        continue;
      }
      wirings.push({ pkg, configFile, scriptName, testFileSuffix, hasConfig, script: scripts[scriptName] });
    }
  }

  return wirings;
}

describe('vitest suite wiring (dead-suite guard)', () => {
  const wirings = collectSuiteWirings(PACKAGES_DIR);

  it('finds packages with a qualifying suite (config or matching test files)', () => {
    // Sanity check: if this ever hits 0 the it.each below becomes vacuous and
    // the guard silently stops guarding.
    expect(wirings.length).toBeGreaterThan(0);
  });

  it.each(wirings)(
    '$pkg: "$scriptName" is wired to $configFile',
    ({ pkg, configFile, scriptName, testFileSuffix, hasConfig, script }) => {
      expect(
        hasConfig,
        `packages/${pkg} has test files matching "*${testFileSuffix}" under test/ but no ${configFile} — ` +
          `those tests run nowhere (no config to point vitest at them), and CI stays green`,
      ).toBe(true);

      expect(
        script,
        `packages/${pkg} ships ${configFile} but package.json has no "${scriptName}" script — the suite would never run`,
      ).toBeDefined();

      expect(
        script,
        `packages/${pkg} "${scriptName}" must pass --config ${configFile}; a bare "vitest run" loads the unit config, which excludes this suite's files, so the tests run nowhere and the script still exits 0`,
      ).toContain(`--config ${configFile}`);
    },
  );
});
