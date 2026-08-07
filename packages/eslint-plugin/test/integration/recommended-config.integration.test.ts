/* eslint-disable security/detect-non-literal-fs-filename -- Test code writing into its own temp project */
/**
 * `configs.recommended`, exercised through the PUBLISHED artifact.
 *
 * This repo's `eslint.config.js` does NOT consume `configs.recommended` — it keeps
 * its own explicit severity map under the `local` namespace. So the flat config an
 * adopter actually installs is the one surface in this package that nothing else
 * touches: a misnamed rule key, a `files`-field omission that leaves `rules/` out
 * of the tarball, or a namespace typo would all ship green through lint, unit
 * tests and CI.
 *
 * The test therefore refuses to import `../../index.cjs`. It runs:
 *   npm pack  →  install the tarball into a throwaway project OUTSIDE the
 *   workspace  →  write the `eslint.config.js` from README.md verbatim  →  lint.
 *
 * Everything resolves from the throwaway project's own `node_modules`, so a file
 * present in the source tree but missing from `files` fails here and only here.
 *
 * Tier: integration. It spawns two `npm` processes, which the testing guide
 * normally routes to the system tier — but both run offline against a local
 * tarball with zero remote dependencies, and the whole suite (pack + install +
 * three lint passes) measures well under the integration tier's 5s budget.
 *
 * ESLint itself is the repo's ESLint 9 (asserted below) driven through its Node
 * API rather than a third npm install: installing eslint from the registry would
 * make this test network-dependent for no added signal — the API and the CLI load
 * the same flat config through the same resolver.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, resolveFromImportMeta } from '@vibe-agent-toolkit/utils/fs';
import { safePath } from '@vibe-agent-toolkit/utils/path';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';
import { ESLint, type Linter } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_DIR = resolveFromImportMeta(import.meta.url, '..', '..');

/** ESLint's numeric severities, named. */
const SEVERITY = { warn: 1, error: 2 } as const;

/**
 * `eslint.config.js` — copied verbatim from README.md ("Usage").
 *
 * If the README snippet and this string diverge, the test stops proving anything
 * about what an adopter is told to write.
 */
const README_USAGE_CONFIG = `// eslint.config.js
import vat from '@vibe-agent-toolkit/eslint-plugin';

export default [
  vat.configs.recommended,
];
`;

/**
 * `recommended` plus the documented `exemptFiles` option on one rule.
 *
 * `src/paths.js` is the declared implementation file; `tools/hooks/paths.js` is
 * the decoy that shares its basename. The decoy must still fire — a substring
 * exemption check is exactly how a private `tools/hooks/path-utils.ts` full of
 * raw `tmpdir()` calls linted clean for months.
 */
const EXEMPT_CONFIG = `import vat from '@vibe-agent-toolkit/eslint-plugin';

export default [
  vat.configs.recommended,
  {
    rules: {
      '@vibe-agent-toolkit/no-os-tmpdir': ['error', { exemptFiles: ['src/paths.js'] }],
    },
  },
];
`;

/** Trips several rules at both severities `recommended` declares. */
const VIOLATIONS_FIXTURE = `import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function build(name, target) {
  const dir = path.join(tmpdir(), name);
  execSync('node --version');
  return {
    dir,
    href: \`file://\${dir}\`,
    secure: /^https:/.test(target),
  };
}
`;

/** Calls the banned primitive `no-os-tmpdir` exempts by path. */
const TMPDIR_FIXTURE = `import { tmpdir } from 'node:os';

export function base() {
  return tmpdir();
}
`;

/** Project-relative fixture paths. `EXEMPT_CONFIG` declares `IMPL_FILE` by this exact string. */
const NO_OS_TMPDIR = '@vibe-agent-toolkit/no-os-tmpdir';

const VIOLATIONS_FILE = 'src/violations.js';
const IMPL_FILE = 'src/paths.js';
const DECOY_FILE = 'tools/hooks/paths.js';

interface PackedProject {
  dir: string;
  configPath: string;
  exemptConfigPath: string;
}

/** `npm pack` the package under test and return the tarball's absolute path. */
function packPlugin(destination: string): string {
  const stdout = safeExecSync('npm', ['pack', '--pack-destination', destination, '--silent'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    stdio: 'pipe',
  }).toString();
  const tarball = stdout.trim().split('\n').at(-1)?.trim();
  if (!tarball) {
    throw new Error(`npm pack produced no tarball name (stdout: ${JSON.stringify(stdout)})`);
  }
  return safePath.join(destination, tarball);
}

/** Write `content` to `<dir>/<relativePath>`, creating parent directories. */
function writeProjectFile(dir: string, relativePath: string, content: string): string {
  const absolute = safePath.join(dir, relativePath);
  mkdirSyncReal(safePath.join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return absolute;
}

/**
 * Build the throwaway project: pack, install, then write config + fixtures.
 *
 * `--offline` is a guarantee, not a cache requirement: the tarball is a local
 * file and the package has zero runtime dependencies, so nothing is ever looked
 * up remotely. `--legacy-peer-deps` keeps npm from auto-installing the `eslint`
 * peer (the only thing that would need the registry).
 */
function createPackedProject(): PackedProject {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-eslint-plugin-pack-'));
  writeProjectFile(dir, 'package.json', '{ "name": "adopter", "version": "1.0.0", "type": "module", "private": true }\n');

  const tarball = packPlugin(dir);
  safeExecSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', '--legacy-peer-deps', '--offline', tarball],
    { cwd: dir, stdio: 'pipe' },
  );

  const configPath = writeProjectFile(dir, 'eslint.config.js', README_USAGE_CONFIG);
  const exemptConfigPath = writeProjectFile(dir, 'eslint.exempt.config.js', EXEMPT_CONFIG);
  writeProjectFile(dir, VIOLATIONS_FILE, VIOLATIONS_FIXTURE);
  writeProjectFile(dir, IMPL_FILE, TMPDIR_FIXTURE);
  writeProjectFile(dir, DECOY_FILE, TMPDIR_FIXTURE);

  return { dir, configPath, exemptConfigPath };
}

/** Lint one project-relative file and return every message it produced. */
async function lintProjectFile(
  project: PackedProject,
  relativePath: string,
  overrideConfigFile: string,
): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: project.dir, overrideConfigFile });
  const results = await eslint.lintFiles([safePath.join(project.dir, relativePath)]);
  return results.flatMap((result) => result.messages);
}

/** Collapse messages into `ruleId -> severity`, failing loudly on a fatal parse error. */
function severityByRule(messages: Linter.LintMessage[]): Map<string, number> {
  const byRule = new Map<string, number>();
  for (const message of messages) {
    if (message.fatal || !message.ruleId) {
      throw new Error(`Non-rule ESLint message: ${message.message}`);
    }
    byRule.set(message.ruleId, message.severity);
  }
  return byRule;
}

let project: PackedProject;

beforeAll(() => {
  project = createPackedProject();
});

afterAll(() => {
  if (project?.dir) {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

describe('configs.recommended (published artifact)', () => {
  it('is driven by ESLint 9', () => {
    expect(ESLint.version.startsWith('9.')).toBe(true);
  });

  it('reports findings from the README usage snippet alone', async () => {
    const messages = await lintProjectFile(project, VIOLATIONS_FILE, project.configPath);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.ruleId).toMatch(/^@vibe-agent-toolkit\//);
    }
  });

  it('applies the severity split recommended declares', async () => {
    const messages = await lintProjectFile(project, VIOLATIONS_FILE, project.configPath);
    const byRule = severityByRule(messages);

    // warn — the high-churn auto-fixable path rules, plus the one rule that flags
    // style rather than a defect (see RECOMMENDED_WARN's rationale in index.cjs).
    expect(byRule.get('@vibe-agent-toolkit/no-path-join')).toBe(SEVERITY.warn);
    expect(byRule.get('@vibe-agent-toolkit/prefer-startswith-over-regex')).toBe(SEVERITY.warn);

    // error — everything else in the safety core.
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
    expect(byRule.get('@vibe-agent-toolkit/no-child-process-execSync')).toBe(SEVERITY.error);
    expect(byRule.get('@vibe-agent-toolkit/no-file-url-string-concat')).toBe(SEVERITY.error);

    // The split is real, not an artifact of one severity being unused.
    const severities = new Set(byRule.values());
    expect([...severities].sort((a, b) => a - b)).toEqual([SEVERITY.warn, SEVERITY.error]);
  });

  it('omits the two test-style rules that are opt-in', async () => {
    const eslint = new ESLint({ cwd: project.dir, overrideConfigFile: project.configPath });
    const config = (await eslint.calculateConfigForFile(
      safePath.join(project.dir, VIOLATIONS_FILE),
    )) as { rules: Record<string, unknown> };

    expect(config.rules['@vibe-agent-toolkit/no-path-join']).toBeDefined();
    expect(config.rules['@vibe-agent-toolkit/no-test-scoped-functions']).toBeUndefined();
    expect(config.rules['@vibe-agent-toolkit/require-justified-skip']).toBeUndefined();
  });
});

describe('exemptFiles through the published artifact', () => {
  it('fires on the implementation file when nothing is exempted', async () => {
    const messages = await lintProjectFile(project, IMPL_FILE, project.configPath);
    const byRule = severityByRule(messages);
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
  });

  it('silences the declared exempt file', async () => {
    const messages = await lintProjectFile(project, IMPL_FILE, project.exemptConfigPath);
    expect(messages).toEqual([]);
  });

  it('still fires on a decoy with the same basename in another directory', async () => {
    const messages = await lintProjectFile(project, DECOY_FILE, project.exemptConfigPath);
    const byRule = severityByRule(messages);
    expect(byRule.get(NO_OS_TMPDIR)).toBe(SEVERITY.error);
  });
});
