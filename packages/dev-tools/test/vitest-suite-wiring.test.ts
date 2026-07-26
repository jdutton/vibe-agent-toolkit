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
 * The guard is driven off the config files on disk (not a hardcoded list), so
 * a newly added suite config is covered the moment it lands.
 */

const PACKAGES_DIR = safePath.join(PROJECT_ROOT, 'packages');

/** Suite configs that need an explicit `--config` in their npm script. */
const SUITE_CONFIGS = [
  { configFile: 'vitest.integration.config.ts', scriptName: 'test:integration' },
  { configFile: 'vitest.system.config.ts', scriptName: 'test:system' },
] as const;

interface SuiteWiring {
  pkg: string;
  configFile: string;
  scriptName: string;
  script: string | undefined;
}

function readScripts(packageJsonPath: string): Record<string, string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

function collectSuiteWirings(): SuiteWiring[] {
  const wirings: SuiteWiring[] = [];

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
  const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const pkg of packageDirs) {
    const packageJsonPath = safePath.join(PACKAGES_DIR, pkg, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const scripts = readScripts(packageJsonPath);

    for (const { configFile, scriptName } of SUITE_CONFIGS) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
      if (existsSync(safePath.join(PACKAGES_DIR, pkg, configFile))) {
        wirings.push({ pkg, configFile, scriptName, script: scripts[scriptName] });
      }
    }
  }

  return wirings;
}

describe('vitest suite wiring (dead-suite guard)', () => {
  const wirings = collectSuiteWirings();

  it('finds packages that ship a dedicated suite config', () => {
    // Sanity check: if this ever hits 0 the it.each below becomes vacuous and
    // the guard silently stops guarding.
    expect(wirings.length).toBeGreaterThan(0);
  });

  it.each(wirings)(
    '$pkg: "$scriptName" runs vitest against $configFile',
    ({ pkg, configFile, scriptName, script }) => {
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
